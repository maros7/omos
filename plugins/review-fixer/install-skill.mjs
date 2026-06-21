// install-skill.mjs — best-effort postinstall hook. Copies the bundled SKILL.md
// into the user's opencode skills dir so the model picks up review-fixer usage
// without manual setup. Any failure is swallowed: postinstall must never block
// install.
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const src = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md")
if (!existsSync(src)) {
  // Nothing to install (e.g. dev checkout without the skill file).
  process.exit(0)
}

const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const dest = join(base, "opencode", "skills", "review-fixer", "SKILL.md")

try {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
} catch (e) {
  // Best-effort: never fail the install over a skill-file copy.
  console.warn(`review-fixer: could not install skill: ${e instanceof Error ? e.message : String(e)}`)
} finally {
  process.exit(0)
}
