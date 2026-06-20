import { existsSync } from "node:fs"
import { join } from "node:path"

// resolveBinary picks how to invoke gogate: a project-local build (when developing
// gogate itself), otherwise `gogate` on PATH — the supported install
// (`go install github.com/maros7/omos/plugins/gogate/cmd/gogate@latest`). If neither
// exists it still returns "gogate" so the command fails with a clear "not found".
export function resolveBinary(dir: string): string[] {
  const exe = process.platform === "win32" ? "gogate.exe" : "gogate"
  const local = join(dir, "bin", exe)
  if (existsSync(local)) return [local]
  return ["gogate"]
}
