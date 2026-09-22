import { describe, expect, test } from "bun:test"
import { readTextFiles, withFiles } from "./files"

describe("withFiles", () => {
  test("puts each file under its name, after the draft when there is one", () => {
    expect(withFiles("", [{ name: "note.txt", text: "hello" }])).toBe("<file path=\"note.txt\">\nhello\n</file>")
    expect(withFiles("darken it", [{ name: "a.css", text: "body{}" }, { name: "b.txt", text: "x" }])).toBe(
      "darken it\n\n<file path=\"a.css\">\nbody{}\n</file>\n\n<file path=\"b.txt\">\nx\n</file>"
    )
    expect(withFiles("", [{ name: 'say"hi.txt', text: "x" }])).toBe("<file path=\"sayhi.txt\">\nx\n</file>")
  })
})

describe("readTextFiles", () => {
  test("reads text files and drops empty, huge, or binary ones", async () => {
    const files = await readTextFiles([
      new File(["ok"], "keep.txt", { type: "text/plain" }),
      new File([""], "empty.txt", { type: "text/plain" }),
      new File(["x".repeat(200_001)], "huge.txt", { type: "text/plain" }),
      new File(["a\0b"], "bin.dat", { type: "application/octet-stream" })
    ])
    expect(files).toEqual([{ name: "keep.txt", text: "ok" }])
  })
})
