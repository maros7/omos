import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect } from "bun:test"

/**
 * isUpdate: true when tests run with -u/--update OR GOLDEN_UPDATE=1, in which
 * case golden files are REWRITTEN from actual output.
 *
 * :ponytail: bun's `test` runner strips `-u`/`--update` from process.argv (it's
 * bun's own snapshot-update flag), so we additionally honour a GOLDEN_UPDATE
 * env var. The working invocation is therefore `GOLDEN_UPDATE=1 bun test`.
 *
 * Exposed as a function (not a `const`) so tests can drive the UPDATE branch
 * without re-importing the module under a different env.
 */
export function isUpdate(): boolean {
  return (
    process.argv.includes("-u") ||
    process.argv.includes("--update") ||
    process.env.GOLDEN_UPDATE === "1"
  )
}

const DIR = import.meta.dir

/** writeGolden writes `actual` to the given absolute path, creating dirs. */
export function writeGolden(path: string, actual: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, actual)
}

/**
 * compareOrWrite: path-based golden compare/write. Under isUpdate() it writes
 * `actual` to `path`; otherwise it expects `path` to exist and match `actual`.
 * Exposed so tests can drive both branches against a temp path.
 */
export function compareOrWrite(path: string, actual: string): void {
  if (isUpdate()) {
    writeGolden(path, actual)
    return
  }
  if (!existsSync(path)) {
    throw new Error(`golden file missing: ${path} (run \`bun test -u\` to generate)`)
  }
  expect(actual).toBe(readFileSync(path, "utf8"))
}

/** expectGolden compares actual to testdata/<name>.golden; under -u/--update it writes actual there. */
export function expectGolden(name: string, actual: string): void {
  compareOrWrite(join(DIR, `${name}.golden`), actual)
}
