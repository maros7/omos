import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveBinary, defaultDeps, type ResolveDeps } from "./resolve"

// A fake HTTP response for the injected fetch.
function makeResponse(opts: {
  ok?: boolean
  status?: number
  json?: unknown
  text?: string
  bytes?: Uint8Array
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => opts.json,
    text: async () => opts.text ?? "",
    arrayBuffer: async () => (opts.bytes ?? new Uint8Array()).buffer,
  } as unknown as Response
}

const ARCHIVE_URL = "https://dl.example/archive"
const CHECKSUMS_URL = "https://dl.example/checksums"

// makeDeps builds a fully-faked ResolveDeps; pass overrides per test.
function makeDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps & {
  writes: Array<{ p: string; data: Uint8Array }>
  chmods: Array<{ p: string; mode: number }>
  extracts: Array<{ archivePath: string; destDir: string; isZip: boolean }>
} {
  const writes: Array<{ p: string; data: Uint8Array }> = []
  const chmods: Array<{ p: string; mode: number }> = []
  const extracts: Array<{ archivePath: string; destDir: string; isZip: boolean }> = []
  const base: ResolveDeps = {
    env: {},
    platform: "linux",
    arch: "x64",
    homedir: () => "/home/u",
    exists: () => false,
    mkdirp: () => {},
    writeFile: (p, data) => writes.push({ p, data }),
    chmod: (p, mode) => chmods.push({ p, mode }),
    fetch: (async () => makeResponse({ json: {} })) as unknown as typeof fetch,
    sha256: () => "deadbeef",
    extract: async (archivePath, destDir, isZip) => {
      extracts.push({ archivePath, destDir, isZip })
    },
    ...overrides,
  }
  return Object.assign(base, { writes, chmods, extracts })
}

// A fetch router for the cold-install happy path: release JSON, then the archive
// bytes, then the checksums text.
function installFetch(opts: {
  assetName: string
  digest: string
  tagName?: string
  assets?: Array<{ name: string; browser_download_url: string }>
}): typeof fetch {
  const assets = opts.assets ?? [
    { name: opts.assetName, browser_download_url: ARCHIVE_URL },
    { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
  ]
  return (async (url: string) => {
    if (url.includes("api.github.com")) {
      return makeResponse({ json: { tag_name: opts.tagName ?? "v1.2.3", assets } })
    }
    if (url === ARCHIVE_URL) return makeResponse({ bytes: new Uint8Array([1, 2, 3]) })
    if (url === CHECKSUMS_URL) {
      return makeResponse({ text: `\n${opts.digest}  ${opts.assetName}\n` })
    }
    throw new Error(`unexpected url ${url}`)
  }) as unknown as typeof fetch
}

describe("resolveBinary — resolution order", () => {
  test("1. explicit REVIEW_FIXER_BIN override wins", async () => {
    const deps = makeDeps({ env: { REVIEW_FIXER_BIN: "/opt/review-fixer" } })
    expect(await resolveBinary("/proj", deps)).toEqual(["/opt/review-fixer"])
  })

  test("2. local dev build is used when present (unix)", async () => {
    const deps = makeDeps({ exists: (p) => p === join("/proj", "bin", "review-fixer") })
    expect(await resolveBinary("/proj", deps)).toEqual([join("/proj", "bin", "review-fixer")])
  })

  test("2. local dev build uses .exe on win32 (x64→amd64 unused here)", async () => {
    const deps = makeDeps({
      platform: "win32",
      exists: (p) => p === join("/proj", "bin", "review-fixer.exe"),
    })
    expect(await resolveBinary("/proj", deps)).toEqual([join("/proj", "bin", "review-fixer.exe")])
  })

  test("3. cache hit returns cached binary without network (XDG_CACHE_HOME)", async () => {
    const cached = join("/xdg", "review-fixer", "bin", "review-fixer")
    let fetched = false
    const deps = makeDeps({
      env: { XDG_CACHE_HOME: "/xdg" },
      exists: (p) => p === cached,
      fetch: (async () => {
        fetched = true
        return makeResponse({ json: {} })
      }) as unknown as typeof fetch,
    })
    expect(await resolveBinary("/proj", deps)).toEqual([cached])
    expect(fetched).toBe(false)
  })
})

describe("resolveBinary — cold install", () => {
  test("happy path: latest release, verify, extract, chmod, return cached path", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      env: {},
      sha256: () => "ABCDEF", // upper-case to exercise case-insensitive compare
      fetch: installFetch({ assetName, digest: "abcdef" }),
    })
    const cachedBin = join("/home/u", ".cache", "review-fixer", "bin", "review-fixer")
    expect(await resolveBinary("/proj", deps)).toEqual([cachedBin])

    // wrote the archive, extracted it (not zip), chmod'd the binary 0755.
    expect(deps.writes.map((w) => w.p)).toEqual([
      join("/home/u", ".cache", "review-fixer", "bin", assetName),
    ])
    expect(deps.extracts).toEqual([
      {
        archivePath: join("/home/u", ".cache", "review-fixer", "bin", assetName),
        destDir: join("/home/u", ".cache", "review-fixer", "bin"),
        isZip: false,
      },
    ])
    expect(deps.chmods).toEqual([{ p: cachedBin, mode: 0o755 }])
  })

  test("win32 maps to windows/.zip and arm64 mapping is honored", async () => {
    const assetName = "review-fixer_windows_arm64.zip"
    const deps = makeDeps({
      platform: "win32",
      arch: "arm64",
      fetch: installFetch({ assetName, digest: "deadbeef" }),
    })
    const cachedBin = join("/home/u", ".cache", "review-fixer", "bin", "review-fixer.exe")
    expect(await resolveBinary("/proj", deps)).toEqual([cachedBin])
    expect(deps.extracts[0].isZip).toBe(true)
  })

  test("REVIEW_FIXER_VERSION pins the tags endpoint and sends the auth header", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    let calledUrl = ""
    let authHeader: string | undefined
    const router = installFetch({ assetName, digest: "deadbeef", tagName: "v9.9.9" })
    const deps = makeDeps({
      env: { REVIEW_FIXER_VERSION: "v9.9.9", GITHUB_TOKEN: "tok" },
      fetch: (async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.includes("api.github.com")) {
          calledUrl = url
          authHeader = init?.headers?.Authorization
        }
        return router(url as unknown as URL)
      }) as unknown as typeof fetch,
    })
    await resolveBinary("/proj", deps)
    expect(calledUrl).toBe("https://api.github.com/repos/maros7/omos/releases/tags/v9.9.9")
    expect(authHeader).toBe("Bearer tok")
  })

  test("falls back to pinned tag when the API omits tag_name", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      env: { REVIEW_FIXER_VERSION: "v7.0.0" },
      fetch: (async (url: string) => {
        if (url.includes("api.github.com")) {
          return makeResponse({
            json: {
              assets: [
                { name: assetName, browser_download_url: ARCHIVE_URL },
                { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
              ],
            },
          })
        }
        if (url === ARCHIVE_URL) return makeResponse({ bytes: new Uint8Array([1]) })
        return makeResponse({ text: `deadbeef  ${assetName}\n` })
      }) as unknown as typeof fetch,
    })
    await resolveBinary("/proj", deps)
    expect(deps.chmods.length).toBe(1)
  })
})

describe("resolveBinary — install failures throw", () => {
  test("release API non-2xx throws", async () => {
    const deps = makeDeps({
      fetch: (async () => makeResponse({ ok: false, status: 503 })) as unknown as typeof fetch,
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/release lookup failed \(503\)/)
  })

  test("unsupported platform (asset missing) throws", async () => {
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.github.com")) {
          return makeResponse({
            json: {
              tag_name: "v1",
              assets: [{ name: "checksums.txt", browser_download_url: CHECKSUMS_URL }],
            },
          })
        }
        return makeResponse({})
      }) as unknown as typeof fetch,
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/unsupported platform/)
  })

  test("missing checksums.txt asset throws", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.github.com")) {
          return makeResponse({
            json: {
              tag_name: "v1",
              assets: [{ name: assetName, browser_download_url: ARCHIVE_URL }],
            },
          })
        }
        return makeResponse({})
      }) as unknown as typeof fetch,
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/no checksums\.txt asset/)
  })

  test("archive download non-2xx throws", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.github.com")) {
          return makeResponse({
            json: {
              tag_name: "v1",
              assets: [
                { name: assetName, browser_download_url: ARCHIVE_URL },
                { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
              ],
            },
          })
        }
        if (url === ARCHIVE_URL) return makeResponse({ ok: false, status: 404 })
        return makeResponse({ text: "" })
      }) as unknown as typeof fetch,
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/download of .* failed \(404\)/)
  })

  test("checksums download non-2xx throws", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.github.com")) {
          return makeResponse({
            json: {
              tag_name: "v1",
              assets: [
                { name: assetName, browser_download_url: ARCHIVE_URL },
                { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
              ],
            },
          })
        }
        if (url === ARCHIVE_URL) return makeResponse({ bytes: new Uint8Array([1]) })
        return makeResponse({ ok: false, status: 500 })
      }) as unknown as typeof fetch,
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/checksums\.txt failed \(500\)/)
  })

  test("checksums.txt without an entry for the asset throws", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (async (url: string) => {
        if (url.includes("api.github.com")) {
          return makeResponse({
            json: {
              tag_name: "v1",
              assets: [
                { name: assetName, browser_download_url: ARCHIVE_URL },
                { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
              ],
            },
          })
        }
        if (url === ARCHIVE_URL) return makeResponse({ bytes: new Uint8Array([1]) })
        return makeResponse({ text: "\n0000  some-other-file\n" })
      }) as unknown as typeof fetch,
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/no entry for/)
  })

  test("checksum mismatch throws and does not install", async () => {
    const assetName = "review-fixer_linux_amd64.tar.gz"
    const deps = makeDeps({
      sha256: () => "aaaa",
      fetch: installFetch({ assetName, digest: "bbbb" }),
    })
    await expect(resolveBinary("/proj", deps)).rejects.toThrow(/checksum mismatch/)
    expect(deps.chmods.length).toBe(0)
    expect(deps.extracts.length).toBe(0)
  })
})

describe("defaultDeps — real implementations", () => {
  test("wires fs/crypto/extract against the real filesystem (no network)", async () => {
    const deps = defaultDeps()
    expect(deps.platform).toBe(process.platform)
    expect(deps.arch).toBe(process.arch)
    expect(typeof deps.homedir()).toBe("string")

    const dir = mkdtempSync(join(tmpdir(), "rf-defaultdeps-"))
    try {
      const sub = join(dir, "bin")
      deps.mkdirp(sub)
      const file = join(sub, "data.bin")
      const bytes = new Uint8Array([1, 2, 3, 4])
      deps.writeFile(file, bytes)
      expect(deps.exists(file)).toBe(true)
      expect(deps.exists(join(sub, "missing"))).toBe(false)
      deps.chmod(file, 0o755)
      // sha256 of 0x01020203... matches node:crypto.
      expect(deps.sha256(bytes)).toBe(
        "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      )

      // Build a real tar.gz, then extract it via the wired bsdtar shell-out.
      const srcDir = join(dir, "src")
      deps.mkdirp(srcDir)
      deps.writeFile(join(srcDir, "hello.txt"), new Uint8Array([104, 105]))
      const archive = join(dir, "a.tar.gz")
      const tarProc = Bun.spawn(["tar", "-czf", archive, "-C", srcDir, "hello.txt"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await tarProc.exited).toBe(0)

      const outDir = join(dir, "out")
      deps.mkdirp(outDir)
      await deps.extract(archive, outDir, false)
      expect(existsSync(join(outDir, "hello.txt"))).toBe(true)
      expect(readFileSync(join(outDir, "hello.txt"), "utf8")).toBe("hi")

      // extract surfaces tar failures.
      await expect(deps.extract(join(dir, "nope.tar.gz"), outDir, false)).rejects.toThrow(
        /extract failed/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
