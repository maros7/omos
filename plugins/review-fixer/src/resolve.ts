import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"

const REPO = "maros7/omos"

// ResolveDeps is the full injection seam: every side effect resolveBinary performs
// (env, platform probing, filesystem, network, hashing, archive extraction) goes
// through here so tests can drive 100% of the branches with zero real I/O.
export interface ResolveDeps {
  env: Record<string, string | undefined>
  platform: string
  arch: string
  homedir(): string
  exists(p: string): boolean
  mkdirp(p: string): void
  writeFile(p: string, data: Uint8Array): void
  chmod(p: string, mode: number): void
  fetch: typeof fetch
  sha256(data: Uint8Array): string
  extract(archivePath: string, destDir: string, isZip: boolean): Promise<void>
}

// defaultDeps wires the real implementations used in production.
export function defaultDeps(): ResolveDeps {
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    homedir,
    exists: (p) => existsSync(p),
    mkdirp: (p) => {
      mkdirSync(p, { recursive: true })
    },
    writeFile: (p, data) => {
      writeFileSync(p, data)
    },
    chmod: (p, mode) => {
      chmodSync(p, mode)
    },
    fetch: globalThis.fetch,
    sha256: (data) => createHash("sha256").update(data).digest("hex"),
    extract: async (archivePath, destDir, isZip) => {
      // bsdtar (the `tar` shipped on macOS/Linux and Windows 10+) extracts both
      // tarballs and zips. On unix we decompress gzip (-xzf); the zip path is
      // already compressed so plain -xf lets bsdtar autodetect it.
      const args = isZip
        ? ["tar", "-xf", archivePath, "-C", destDir]
        : ["tar", "-xzf", archivePath, "-C", destDir]
      const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" })
      const stderr = await new Response(proc.stderr).text()
      const code = await proc.exited
      if (code !== 0) throw new Error(`extract failed (exit ${code}): ${stderr.trim()}`)
    },
  }
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

// exeName / platform identifiers, derived from the injected platform+arch.
function binaryName(platform: string): string {
  return platform === "win32" ? "review-fixer.exe" : "review-fixer"
}

function cacheDir(deps: ResolveDeps): string {
  const root = deps.env.XDG_CACHE_HOME ?? join(deps.homedir(), ".cache")
  return join(root, "review-fixer")
}

// resolveBinary returns the argv prefix used to invoke the binary, installing it from
// the GitHub Release on first use if necessary. Resolution order (first hit wins):
//   1. $REVIEW_FIXER_BIN          explicit override
//   2. <dir>/bin/review-fixer     local dev build
//   3. <cache>/bin/review-fixer   previously installed (no network)
//   4. download + verify + cache the latest (or $REVIEW_FIXER_VERSION) release
export async function resolveBinary(
  dir: string,
  deps: ResolveDeps = defaultDeps(),
): Promise<string[]> {
  // 1. Explicit override.
  const override = deps.env.REVIEW_FIXER_BIN
  if (override) return [override]

  const exe = binaryName(deps.platform)

  // 2. Local dev build.
  const local = join(dir, "bin", exe)
  if (deps.exists(local)) return [local]

  // 3. Cached install.
  const cachedBin = join(cacheDir(deps), "bin", exe)
  if (deps.exists(cachedBin)) return [cachedBin]

  // 4. Cold install from the GitHub Release.
  await installRelease(deps, cachedBin)
  return [cachedBin]
}

// installRelease downloads, checksum-verifies, and extracts the matching binary into
// <cache>/bin. It throws a clear Error on any failure and never leaves a partial binary
// at the final path silently (extraction failures surface).
async function installRelease(deps: ResolveDeps, destBin: string): Promise<void> {
  const release = await fetchRelease(deps)

  const goos = deps.platform === "win32" ? "windows" : deps.platform
  const goarch = deps.arch === "x64" ? "amd64" : deps.arch
  const ext = deps.platform === "win32" ? ".zip" : ".tar.gz"
  const assetName = `review-fixer_${goos}_${goarch}${ext}`

  const asset = release.assets.find((a) => a.name === assetName)
  if (!asset) {
    throw new Error(
      `no release asset "${assetName}" in ${release.tag} (unsupported platform ${goos}/${goarch})`,
    )
  }
  const checksums = release.assets.find((a) => a.name === "checksums.txt")
  if (!checksums) throw new Error(`release ${release.tag} has no checksums.txt asset`)

  const archiveBytes = await fetchBytes(deps, asset.browser_download_url, assetName)
  const checksumsText = await fetchText(deps, checksums.browser_download_url, "checksums.txt")

  // Verify before installing.
  const actual = deps.sha256(archiveBytes).toLowerCase()
  const expected = checksumLineFor(checksumsText, assetName)
  if (!expected) throw new Error(`checksums.txt has no entry for ${assetName}`)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`)
  }

  // Write the archive to the cache bin dir, then extract the single binary next to it.
  const destDir = join(cacheDir(deps), "bin")
  deps.mkdirp(destDir)
  const archivePath = join(destDir, assetName)
  deps.writeFile(archivePath, archiveBytes)
  await deps.extract(archivePath, destDir, ext === ".zip")
  deps.chmod(destBin, 0o755)
}

interface Release {
  tag: string
  assets: ReleaseAsset[]
}

// fetchRelease resolves the release to install: a pinned tag via REVIEW_FIXER_VERSION,
// otherwise "latest".
async function fetchRelease(deps: ResolveDeps): Promise<Release> {
  const pinned = deps.env.REVIEW_FIXER_VERSION
  const url = pinned
    ? `https://api.github.com/repos/${REPO}/releases/tags/${pinned}`
    : `https://api.github.com/repos/${REPO}/releases/latest`

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "review-fixer",
    "X-GitHub-Api-Version": "2022-11-28",
  }
  const token = deps.env.GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await deps.fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`GitHub release lookup failed (${res.status}) for ${url}`)
  }
  const json = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] }
  return { tag: json.tag_name ?? pinned ?? "latest", assets: json.assets ?? [] }
}

async function fetchBytes(deps: ResolveDeps, url: string, what: string): Promise<Uint8Array> {
  const res = await deps.fetch(url)
  if (!res.ok) throw new Error(`download of ${what} failed (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchText(deps: ResolveDeps, url: string, what: string): Promise<string> {
  const res = await deps.fetch(url)
  if (!res.ok) throw new Error(`download of ${what} failed (${res.status})`)
  return await res.text()
}

// checksumLineFor returns the hex digest for assetName from a `<sha>  <name>` file, or
// null if absent.
function checksumLineFor(text: string, assetName: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2 && parts[parts.length - 1] === assetName) return parts[0]
  }
  return null
}
