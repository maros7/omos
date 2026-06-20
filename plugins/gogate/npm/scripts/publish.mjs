#!/usr/bin/env node
// Build + publish the gogate npm distribution from GoReleaser's output.
//
// This implements the standard "esbuild-style" platform-package layout:
//   - one thin root package `gogate` (the launcher in bin/gogate.cjs), whose
//     optionalDependencies list every `@gogate/<os>-<arch>` platform package;
//   - one `@gogate/<os>-<arch>` package per OS/arch, each carrying ONLY the
//     matching prebuilt binary plus `os`/`cpu` constraints so npm/bun installs
//     just the one that fits the host.
//
// The launcher (npm/bin/gogate.cjs) resolves `@gogate/<os>-<arch>/bin/gogate`
// where `<os>` is darwin|linux|windows and `<arch>` is the Go arch amd64|arm64.
// IMPORTANT: the package *name* uses the Go arch (amd64/arm64) to match the
// launcher, while the npm `cpu` field inside the package uses npm's convention
// (x64/arm64). Likewise npm's `os` field uses win32 (not "windows").
//
// Version comes from the pushed git tag via $GITHUB_REF_NAME (leading "v"
// stripped) — never the hardcoded 0.1.0 in package.json, which is only a
// placeholder. We rewrite every version (root + optionalDependencies pins +
// each platform package) to the tag version before publishing.
//
// Binaries are read out of GoReleaser's archives, whose names are fully
// predictable from .goreleaser.yaml:
//   gogate_<os>_<arch>.tar.gz   (darwin, linux)
//   gogate_<os>_<arch>.zip      (windows)
//
// This script cannot be exercised locally end-to-end (it needs the release
// artifacts and an npm token); it is invoked by .github/workflows/release.yml.
//
// Env:
//   GITHUB_REF_NAME  required, the pushed tag (e.g. "v1.2.3").
//   DIST_DIR         optional, GoReleaser output dir (default "<repo>/dist").
//   NODE_AUTH_TOKEN  npm auth (wired by actions/setup-node from NPM_TOKEN).
//   DRY_RUN          optional, "1" to skip the actual `npm publish`.
"use strict"

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const npmRoot = resolve(__dirname, "..") // <repo>/npm
const repoRoot = resolve(npmRoot, "..") // <repo>
const distDir = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : join(repoRoot, "dist")
const dryRun = process.env.DRY_RUN === "1"

// Platform matrix — must match the goos/goarch combos in .goreleaser.yaml.
// pkgArch: Go arch, used in the package NAME (what the launcher resolves).
// npmOs / npmCpu: npm's own identifiers, used in the package's os/cpu fields.
const platforms = [
  { goos: "darwin", goarch: "amd64", npmOs: "darwin", npmCpu: "x64", ext: "tar.gz" },
  { goos: "darwin", goarch: "arm64", npmOs: "darwin", npmCpu: "arm64", ext: "tar.gz" },
  { goos: "linux", goarch: "amd64", npmOs: "linux", npmCpu: "x64", ext: "tar.gz" },
  { goos: "linux", goarch: "arm64", npmOs: "linux", npmCpu: "arm64", ext: "tar.gz" },
  { goos: "windows", goarch: "amd64", npmOs: "win32", npmCpu: "x64", ext: "zip" },
  { goos: "windows", goarch: "arm64", npmOs: "win32", npmCpu: "arm64", ext: "zip" },
]

function fail(msg) {
  process.stderr.write(`publish: ${msg}\n`)
  process.exit(1)
}

const tag = process.env.GITHUB_REF_NAME
if (!tag) fail("GITHUB_REF_NAME is not set (expected the pushed git tag, e.g. v1.2.3)")
const version = tag.replace(/^v/, "")
if (!/^\d+\.\d+\.\d+/.test(version)) fail(`tag "${tag}" does not look like a semver version`)

if (!existsSync(distDir)) fail(`dist dir not found: ${distDir} (run GoReleaser first)`)

// Extract a GoReleaser archive into a fresh temp dir and return the binary path.
function extractBinary({ goos, goarch, ext }) {
  const archive = join(distDir, `gogate_${goos}_${goarch}.${ext}`)
  if (!existsSync(archive)) fail(`archive not found: ${archive}`)
  const work = mkdtempSync(join(tmpdir(), "gogate-pkg-"))
  if (ext === "zip") {
    execFileSync("unzip", ["-q", "-o", archive, "-d", work], { stdio: "inherit" })
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", work], { stdio: "inherit" })
  }
  const binName = goos === "windows" ? "gogate.exe" : "gogate"
  const binPath = join(work, binName)
  if (!existsSync(binPath)) fail(`binary ${binName} not found inside ${archive}`)
  return { binPath, binName, work }
}

// Assemble and publish one @gogate/<os>-<arch> platform package.
function publishPlatform(p) {
  const pkgName = `@gogate/${p.goos}-${p.goarch}`
  const { binPath, binName, work } = extractBinary(p)

  const pkgDir = join(work, "package")
  mkdirSync(join(pkgDir, "bin"), { recursive: true })

  const destBin = join(pkgDir, "bin", binName)
  copyFileSync(binPath, destBin)
  chmodSync(destBin, 0o755)

  const manifest = {
    name: pkgName,
    version,
    description: `gogate prebuilt binary for ${p.npmOs}/${p.npmCpu}.`,
    repository: { type: "git", url: "git+https://github.com/maros7/omos.git" },
    license: "MIT",
    // os/cpu let npm/bun skip packages that don't match the host.
    os: [p.npmOs],
    cpu: [p.npmCpu],
    files: [`bin/${binName}`],
  }
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")

  console.log(`publishing ${pkgName}@${version}`)
  npmPublish(pkgDir, pkgName)
  rmSync(work, { recursive: true, force: true })
}

// Detect npm's "this exact name@version is already published" error so a
// partially-completed bootstrap can be re-run idempotently. npm surfaces this
// as E409 / EPUBLISHCONFLICT with text like "cannot publish over previously
// published version". ANY OTHER failure must stay fatal.
function isAlreadyPublishedError(text) {
  return /E409|EPUBLISHCONFLICT|cannot publish over|previously published version/i.test(text)
}

function npmPublish(cwd, name) {
  const args = ["publish", "--access", "public"]
  if (dryRun) args.push("--dry-run")
  try {
    // Capture (not inherit) so we can inspect npm's error text on failure,
    // then forward the captured output for visibility.
    const out = execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    if (out) process.stdout.write(out)
  } catch (err) {
    const combined = `${err.stderr || ""}${err.stdout || ""}${err.message || ""}`
    if (isAlreadyPublishedError(combined)) {
      console.log(`⏭  ${name}@${version} already published, skipping`)
      return
    }
    // Preserve original fatal behavior: forward npm's output and exit non-zero.
    if (err.stdout) process.stdout.write(err.stdout)
    if (err.stderr) process.stderr.write(err.stderr)
    fail(`npm publish failed for ${name}@${version}`)
  }
}

// 1. Rewrite the root package.json version + optionalDependency pins to the tag.
const rootPkgPath = join(npmRoot, "package.json")
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"))
rootPkg.version = version
rootPkg.optionalDependencies = Object.fromEntries(
  platforms.map((p) => [`@gogate/${p.goos}-${p.goarch}`, version]),
)
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n")

// 2. Publish every platform package first (so the root's optionalDependencies resolve).
for (const p of platforms) publishPlatform(p)

// 3. Publish the root launcher package last.
console.log(`publishing gogate@${version}`)
npmPublish(npmRoot, "gogate")

console.log("done")
