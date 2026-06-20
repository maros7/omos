import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"

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
  removeFile(p: string): void
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
    removeFile: (p) => {
      unlinkSync(p)
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
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
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

// binaryName is the executable file name for the host platform.
function binaryName(platform: string): string {
  return platform === "win32" ? "gogate.exe" : "gogate"
}

function cacheDir(deps: ResolveDeps): string {
  // `||` (not `??`): an EMPTY XDG_CACHE_HOME must fall back to the default, otherwise
  // the cache root becomes "" and the cached binary lands at a relative "gogate/bin/..."
  // in the CWD. Only a real (non-empty) value is honored.
  const root = deps.env.XDG_CACHE_HOME || join(deps.homedir(), ".cache")
  return join(root, "gogate")
}

// sanitizeVersion makes a tag string safe to use as a path component (any char outside
// [A-Za-z0-9._-] becomes '-'), so a pinned GOGATE_VERSION can key the cache directory.
function sanitizeVersion(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, "-")
}

// cachedBinPath is the on-disk path of the cached binary.
//   - default (latest): <cache>/bin/gogate(.exe) — a stable, version-agnostic path so
//     the common case keeps its no-network cache hit across runs.
//   - pinned (GOGATE_VERSION set): <cache>/bin/<sanitizedVersion>/gogate(.exe) — keyed by
//     the tag in its own subdir, so changing/setting the pin yields a DISTINCT path that
//     forces a download of the requested tag (and never clobbers the "latest" binary,
//     since the archive always extracts a file literally named gogate(.exe)).
function cachedBinPath(deps: ResolveDeps): string {
  const exe = binaryName(deps.platform)
  const binDir = join(cacheDir(deps), "bin")
  const pinned = deps.env.GOGATE_VERSION
  if (pinned) return join(binDir, sanitizeVersion(pinned), exe)
  return join(binDir, exe)
}

// markerPath is the success marker written next to a cached binary. Its presence (in
// addition to the binary itself) is what makes a cache entry trustworthy: a partial or
// crashed install leaves the binary without its marker and is treated as not cached.
function markerPath(cachedBin: string): string {
  return `${cachedBin}.ok`
}

// resolveBinary returns the argv prefix used to invoke the binary, installing it from
// the GitHub Release on first use if necessary. Resolution order (first hit wins):
//   1. $GOGATE_BIN              explicit override
//   2. <dir>/bin/gogate         local dev build
//   3. version-aware cache hit  binary AND its `.ok` marker both present (no network)
//   4. download + verify + extract + chmod + write marker, then install the result
export async function resolveBinary(
  dir: string,
  deps: ResolveDeps = defaultDeps(),
): Promise<string[]> {
  // 1. Explicit override.
  const override = deps.env.GOGATE_BIN
  if (override) return [override]

  const exe = binaryName(deps.platform)

  // 2. Local dev build.
  const local = join(dir, "bin", exe)
  if (deps.exists(local)) return [local]

  // 3. Cached install — require BOTH the binary AND its success marker. A binary with no
  // marker is a partial/corrupt install and must be re-installed rather than trusted.
  const cachedBin = cachedBinPath(deps)
  const marker = markerPath(cachedBin)
  if (deps.exists(cachedBin) && deps.exists(marker)) return [cachedBin]

  // 4. Cold install from the GitHub Release.
  await installRelease(deps, cachedBin, marker)
  return [cachedBin]
}

// installRelease downloads, checksum-verifies, and extracts the matching binary into the
// directory containing destBin, then chmods it and writes the success marker LAST. It
// throws a clear Error on any failure; because the marker is only written after every
// step succeeds, a crashed install never leaves a marked (and thus trusted) binary.
async function installRelease(deps: ResolveDeps, destBin: string, marker: string): Promise<void> {
  const release = await fetchRelease(deps)

  const goos = deps.platform === "win32" ? "windows" : deps.platform
  const goarch = deps.arch === "x64" ? "amd64" : deps.arch
  const ext = deps.platform === "win32" ? ".zip" : ".tar.gz"
  const assetName = `gogate_${goos}_${goarch}${ext}`

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

  // Write the archive next to where the binary will live, then extract it there. The
  // archive always contains a file literally named gogate(.exe), so extracting into
  // dirname(destBin) lands the binary exactly at destBin.
  const destDir = dirname(destBin)
  deps.mkdirp(destDir)
  const archivePath = join(destDir, assetName)
  deps.writeFile(archivePath, archiveBytes)
  await deps.extract(archivePath, destDir, ext === ".zip")
  deps.chmod(destBin, 0o755)

  // Archive cleanup: the extracted binary is now installed and verified, so the
  // downloaded archive is no longer needed — remove it so the cache doesn't accumulate
  // .tar.gz/.zip files across installs and pinned versions. Best-effort: a failed unlink
  // must not invalidate an otherwise-successful install (the archive would just be
  // overwritten on the next cold install anyway). Deliberately on the SUCCESS path only —
  // a failed install throws before reaching here, leaving the archive behind for debugging.
  try {
    deps.removeFile(archivePath)
  } catch {
    // ignore — best-effort cleanup
  }

  // Marker LAST: only now — checksum verified, extracted, chmod'd — is this a valid cache
  // entry. The content is the resolved tag, for debuggability.
  deps.writeFile(marker, new TextEncoder().encode(release.tag))
}

interface Release {
  tag: string
  assets: ReleaseAsset[]
}

// fetchRelease resolves the release to install: a pinned tag via GOGATE_VERSION,
// otherwise "latest".
async function fetchRelease(deps: ResolveDeps): Promise<Release> {
  const pinned = deps.env.GOGATE_VERSION
  const url = pinned
    ? `https://api.github.com/repos/${REPO}/releases/tags/${pinned}`
    : `https://api.github.com/repos/${REPO}/releases/latest`

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gogate",
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
