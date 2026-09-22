/**
 * The Effect v4 style gate: `bun run lint:effect`.
 *
 * ast-grep runs the rules in rules/effect (see sgconfig.yml). Every match is an error. The
 * code written before the rules existed is listed in effect-lint.baseline.json, and that
 * list only shrinks: a match not in it fails the run, a baseline entry with no match left
 * fails the run too, until `bun run lint:effect --shrink` removes it. Nothing adds to the
 * baseline. New code follows the rules or does not land.
 *
 * A baseline entry is the rule, the file and the matched text with its whitespace folded,
 * so a line moving does not count as a new match, and the same text twice in one file is
 * counted twice.
 */
import { readFileSync, writeFileSync } from "node:fs"

const BASELINE = "effect-lint.baseline.json"
const ROOTS = ["src"]

interface Match {
  readonly ruleId: string
  readonly file: string
  readonly text: string
  readonly message: string
  readonly range: { readonly start: { readonly line: number; readonly column: number } }
}

type Counts = Record<string, number>

const keyOf = (match: Match): string => `${match.ruleId} ${match.file} ${match.text.replace(/\s+/g, " ").trim().slice(0, 200)}`

const scan = async (): Promise<ReadonlyArray<Match>> => {
  const run = Bun.spawn(["ast-grep", "scan", "--json=compact", ...ROOTS], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  // ast-grep exits 1 when it found errors; anything else is the tool itself failing.
  if (code !== 0 && code !== 1) {
    console.error(err)
    process.exit(2)
  }
  if (err.includes("Cannot parse rule")) {
    console.error(err)
    process.exit(2)
  }
  return JSON.parse(out === "" ? "[]" : out) as ReadonlyArray<Match>
}

const readBaseline = (): Counts => {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8")) as Counts
  } catch {
    return {}
  }
}

const countOf = (matches: ReadonlyArray<Match>): Counts => {
  const counts: Counts = {}
  for (const match of matches) counts[keyOf(match)] = (counts[keyOf(match)] ?? 0) + 1
  return counts
}

const main = async (): Promise<void> => {
  const shrink = process.argv.includes("--shrink")
  const matches = await scan()
  const current = countOf(matches)
  const baseline = readBaseline()

  if (shrink) {
    const next: Counts = {}
    for (const [key, allowed] of Object.entries(baseline)) {
      const left = Math.min(allowed, current[key] ?? 0)
      if (left > 0) next[key] = left
    }
    writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(next).sort()), null, 2)}\n`)
    const removed = Object.values(baseline).reduce((a, b) => a + b, 0) - Object.values(next).reduce((a, b) => a + b, 0)
    console.log(`baseline: ${Object.values(next).reduce((a, b) => a + b, 0)} match(es) left, ${removed} removed`)
  }

  const allowed = shrink ? readBaseline() : baseline
  const seen: Counts = {}
  const fresh: Array<Match> = []
  for (const match of matches) {
    const key = keyOf(match)
    seen[key] = (seen[key] ?? 0) + 1
    if (seen[key] > (allowed[key] ?? 0)) fresh.push(match)
  }
  const stale = Object.entries(allowed).filter(([key, count]) => (current[key] ?? 0) < count)

  for (const match of fresh) {
    const { line, column } = match.range.start
    console.error(`${match.file}:${line + 1}:${column + 1} ${match.ruleId}\n  ${match.message}\n  ${match.text.replace(/\s+/g, " ").trim().slice(0, 160)}\n`)
  }
  if (stale.length > 0) {
    console.error(`${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} no longer match; run \`bun run lint:effect --shrink\` to drop them:`)
    for (const [key] of stale) console.error(`  ${key}`)
  }
  const total = matches.length
  const grandfathered = total - fresh.length
  console.log(`lint:effect: ${fresh.length} new violation(s), ${grandfathered} in the baseline, ${stale.length} stale`)
  process.exit(fresh.length > 0 || stale.length > 0 ? 1 : 0)
}

void main()
