/** One text file the reader picked, ready to put on the prompt. */
export interface PickedFile {
  readonly name: string
  readonly text: string
}

const MAX_BYTES = 200_000

/** The draft plus each file under its name. */
export const withFiles = (draft: string, files: ReadonlyArray<PickedFile>): string => {
  const block = files.map((f) => `<file path="${f.name.replace(/"/g, "")}">\n${f.text}\n</file>`).join("\n\n")
  const trimmed = draft.trimEnd()
  return trimmed === "" ? block : `${trimmed}\n\n${block}`
}

/** Read picked files as text. Empty, huge, and NUL-binary files are dropped. */
export const readTextFiles = async (list: ArrayLike<File>): Promise<ReadonlyArray<PickedFile>> => {
  const out: PickedFile[] = []
  for (const file of Array.from(list)) {
    if (file.size === 0 || file.size > MAX_BYTES) continue
    const text = await file.text()
    if (text.includes("\0")) continue
    out.push({ name: file.name, text })
  }
  return out
}
