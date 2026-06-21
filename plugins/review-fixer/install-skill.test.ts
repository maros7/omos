// install-skill.test.ts — exercise the postinstall script against a temp
// XDG_CONFIG_HOME. Verifies file copy + best-effort failure (skipped on
// platforms where chmod can't reliably deny writes).
import { test, expect, describe } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, chmodSync, rmSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("./install-skill.mjs", import.meta.url))
const ROOT = fileURLToPath(new URL(".", import.meta.url))

describe("install-skill.mjs", () => {
  test("happy: copies SKILL.md into XDG_CONFIG_HOME/opencode/skills/review-fixer/", () => {
    const xdg = mkdtempSync(join(tmpdir(), "rf-xdg-"))
    try {
      const r = spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
        encoding: "utf8",
      })
      expect(r.status).toBe(0)
      const dest = join(xdg, "opencode", "skills", "review-fixer", "SKILL.md")
      expect(existsSync(dest)).toBe(true)
      const src = readFileSync(join(ROOT, "SKILL.md"), "utf8")
      expect(readFileSync(dest, "utf8")).toBe(src)
    } finally {
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  test("dest dir unwritable still exits 0 (skipped where chmod can't deny)", () => {
    // On some filesystems / as root, chmod 0o500 still permits
    // writes — skip silently when we detect that.
    if (process.platform === "win32") {
      console.warn("skipping unwritable test on win32 (chmod semantics differ)")
      return
    }
    if (process.getuid && process.getuid() === 0) {
      console.warn("skipping unwritable test when running as root")
      return
    }
    const xdg = mkdtempSync(join(tmpdir(), "rf-xdg-ro-"))
    const targetParent = join(xdg, "opencode", "skills")
    mkdirSync(targetParent, { recursive: true })
    // Make the parent read+exec but not write, so the inner mkdir fails.
    chmodSync(targetParent, 0o500)
    try {
      // Detect whether chmod actually denies us; if not, skip.
      const probe = join(targetParent, "probe")
      try {
        writeFileSync(probe, "x")
        rmSync(probe, { force: true })
        // Write succeeded — chmod didn't deny. Skip the test meaningfully.
        console.warn("skipping unwritable test: chmod did not deny writes on this FS")
        return
      } catch {
        // good — writes are denied; run the real assertion below.
      }
      const r = spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
        encoding: "utf8",
      })
      expect(r.status).toBe(0)
      const stderr = typeof r.stderr === "string" ? r.stderr : ""
      expect(stderr).toMatch(/could not install skill/)
    } finally {
      chmodSync(targetParent, 0o700)
      rmSync(xdg, { recursive: true, force: true })
    }
  })
})
