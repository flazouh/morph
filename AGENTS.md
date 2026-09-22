# Morph

Read `PRODUCT.md` for what Morph is and `DESIGN.md` for how it looks.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `flazouh/morph`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.

## Effect

This repository uses Effect v4. The Effect source is vendored at `repos/effect` as a squashed git subtree.

Before writing Effect code, read `repos/effect/LLMS.md` completely. When the guide does not cover an API, explore `repos/effect/packages` for the real implementation, tests, and usage patterns. Prefer the vendored source over web results or guesses.

The subtree is read-only reference material. Do not edit files under `repos/effect`, and do not import from it: application code imports the `effect` package as usual. Update it with `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash`.

- Decode provider JSON, protocol messages, and persisted data with `Schema`. Do not use ad hoc parser helpers or unchecked casts.
- Use `Schema.TaggedError` for expected failures, `Context.Service` for runtime services, and `Layer` for implementations.
- Use `Effect.fn` with named functions. Use `Effect.fnUntraced` when a function starts long-lived work that outlives the call.
- Use `Effect.acquireRelease` or a scoped layer for sockets, timers, and servers.
- Pass `idleTimeout` explicitly to every `Bun.serve` call.
- Keep raw upstream bodies, credentials, headers, tokens, and peer request IDs out of user-visible errors.
- Use `Predicate.isString`, `Predicate.isObject` and the rest of `Predicate` for runtime checks, never `typeof` or a cast.
- Read the clock through `Clock.currentTimeMillis` or `DateTime.now`, never `Date.now()`.
- Do not write a function that only returns `Effect.gen(...)`; that is `Effect.fn`. Do not `.pipe` an `Effect.fn`.

### The Effect style gate

`bun run lint:effect` runs the ast-grep rules in `rules/effect/` (see `sgconfig.yml`) over `src/`. Every match is an error. The pre-commit hook in `.githooks/` and `bun run test` run it. Code from before the rules is listed in `effect-lint.baseline.json`; that list only shrinks. A new match fails the run. When you fix a listed match, run `bun run lint:effect --shrink` and commit the smaller baseline. Never edit the baseline by hand, and never add to it. Files that do not import `effect` (the page kit) are outside the `Predicate`, clock and decode rules, since the kit bundle runs in every page without Effect.
