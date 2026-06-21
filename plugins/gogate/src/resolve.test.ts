import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { resolveBinary, defaultDeps, type ResolveDeps, type FetchLike } from "./resolve"

// A fake HTTP response for the injected fetch. Real Response objects (no `as`
// casts) — Response.ok is derived from `status`, so a non-2xx status produces
// `ok === false` automatically, matching what real fetch returns.
function makeResponse(opts: {
  ok?: boolean
  status?: number
  json?: unknown
  text?: string
  bytes?: Uint8Array
}): Response {
  // Map the legacy `ok: false` flag to a 5xx so .ok derives correctly; if both
  // are supplied, status wins.
  const status = opts.status ?? (opts.ok === false ? 503 : 200)
  if (opts.bytes) return new Response(opts.bytes, { status })
  if (opts.text !== undefined) return new Response(opts.text, { status })
  if (opts.json !== undefined) {
    return new Response(JSON.stringify(opts.json), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
  return new Response(null, { status })
}

const ARCHIVE_URL = "https://dl.example/archive"
const CHECKSUMS_URL = "https://dl.example/checksums"

/** Resolve `await expect(p).rejects.toThrow(re)` without an `await` on bun's
 *  non-Promise `.rejects` matcher (which trips `await-thenable`). */
async function expectReject(p: Promise<unknown>, re: RegExp): Promise<void> {
  let err: Error | undefined
  try {
    await p
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e))
  }
  if (!err) throw new Error(`expected promise to reject matching ${re.toString()}, but it resolved`)
  expect(err.message).toMatch(re)
}

// makeDeps builds a fully-faked ResolveDeps; pass overrides per test. `calls` is a
// unified, ordered log of side effects so tests can assert e.g. the marker is written
// last (after extract + chmod).
function makeDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps & {
  writes: Array<{ p: string; data: Uint8Array }>
  chmods: Array<{ p: string; mode: number }>
  extracts: Array<{ archivePath: string; destDir: string; isZip: boolean }>
  removes: string[]
  calls: string[]
} {
  const writes: Array<{ p: string; data: Uint8Array }> = []
  const chmods: Array<{ p: string; mode: number }> = []
  const extracts: Array<{ archivePath: string; destDir: string; isZip: boolean }> = []
  const removes: string[] = []
  const calls: string[] = []
  const base: ResolveDeps = {
    env: {},
    platform: "linux",
    arch: "x64",
    homedir: () => "/home/u",
    exists: () => false,
    mkdirp: () => {},
    writeFile: (p, data) => {
      calls.push(`write:${p}`)
      writes.push({ p, data })
    },
    chmod: (p, mode) => {
      calls.push(`chmod:${p}`)
      chmods.push({ p, mode })
    },
    removeFile: (p) => {
      calls.push(`removeFile:${p}`)
      removes.push(p)
    },
    fetch: (() => Promise.resolve(makeResponse({ json: {} }))) satisfies FetchLike,
    sha256: () => "deadbeef",
    extract: (archivePath, destDir, isZip) => {
      calls.push(`extract:${destDir}`)
      extracts.push({ archivePath, destDir, isZip })
      return Promise.resolve()
    },
    ...overrides,
  }
  return Object.assign(base, { writes, chmods, extracts, removes, calls })
}

// inputToURL flattens fetch's `string | URL | Request` first arg to a URL string
// without an `as` cast (each branch already returns a string-typed value).
function inputToURL(input: string | URL | Request): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

// A fetch router for the cold-install happy path: release JSON, then the archive
// bytes, then the checksums text.
function installFetch(opts: {
  assetName: string
  digest: string
  tagName?: string
  assets?: Array<{ name: string; browser_download_url: string }>
}): FetchLike {
  const assets = opts.assets ?? [
    { name: opts.assetName, browser_download_url: ARCHIVE_URL },
    { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
  ]
  return (input) => {
    const url = inputToURL(input)
    if (url.includes("api.github.com")) {
      return Promise.resolve(makeResponse({ json: { tag_name: opts.tagName ?? "v1.2.3", assets } }))
    }
    if (url === ARCHIVE_URL) return Promise.resolve(makeResponse({ bytes: new Uint8Array([1, 2, 3]) }))
    if (url === CHECKSUMS_URL) {
      return Promise.resolve(makeResponse({ text: `\n${opts.digest}  ${opts.assetName}\n` }))
    }
    return Promise.reject(new Error(`unexpected url ${url}`))
  }
}

describe("resolveBinary — resolution order", () => {
  test("1. explicit GOGATE_BIN override wins", async () => {
    const deps = makeDeps({ env: { GOGATE_BIN: "/opt/gogate" } })
    expect(await resolveBinary("/proj", deps)).toEqual(["/opt/gogate"])
  })

  test("2. local dev build is used when present (unix)", async () => {
    const deps = makeDeps({ exists: (p) => p === join("/proj", "bin", "gogate") })
    expect(await resolveBinary("/proj", deps)).toEqual([join("/proj", "bin", "gogate")])
  })

  test("2. local dev build uses .exe on win32", async () => {
    const deps = makeDeps({
      platform: "win32",
      exists: (p) => p === join("/proj", "bin", "gogate.exe"),
    })
    expect(await resolveBinary("/proj", deps)).toEqual([join("/proj", "bin", "gogate.exe")])
  })

  test("3. cache hit (binary AND .ok marker present) returns cached binary, no network", async () => {
    const cached = join("/xdg", "gogate", "bin", "gogate")
    const marker = `${cached}.ok`
    let fetched = false
    const deps = makeDeps({
      env: { XDG_CACHE_HOME: "/xdg" },
      exists: (p) => p === cached || p === marker,
      fetch: () => {
        fetched = true
        return Promise.resolve(makeResponse({ json: {} }))
      },
    })
    expect(await resolveBinary("/proj", deps)).toEqual([cached])
    expect(fetched).toBe(false)
  })

  test("3b. BUG A: binary present but .ok marker ABSENT triggers a fresh install", async () => {
    const cachedBin = join("/home/u", ".cache", "gogate", "bin", "gogate")
    const marker = `${cachedBin}.ok`
    const assetName = "gogate_linux_amd64.tar.gz"
    let fetched = false
    const router = installFetch({ assetName, digest: "deadbeef" })
    const deps = makeDeps({
      // Binary exists, marker does NOT — a partial/corrupt cache, not a valid hit.
      exists: (p) => p === cachedBin,
      fetch: (input) => {
        fetched = true
        return router(input)
      },
    })
    expect(await resolveBinary("/proj", deps)).toEqual([cachedBin])
    // The install path ran (network hit) and the marker is now written.
    expect(fetched).toBe(true)
    expect(deps.writes.some((w) => w.p === marker)).toBe(true)
  })

  test("3c. BUG C: empty XDG_CACHE_HOME is treated as unset (falls back to default)", async () => {
    // `deps.env` isolates this from process.env, so no save/restore is required: this
    // exercises the cacheDir() lookup directly. The default absolute cached bin lives
    // under the injected homedir, NOT under "" (which would be a relative "gogate/bin/...").
    const defaultCached = join("/home/u", ".cache", "gogate", "bin", "gogate")
    const defaultMarker = `${defaultCached}.ok`
    let fetched = false
    const deps = makeDeps({
      env: { XDG_CACHE_HOME: "" },
      // Only the DEFAULT-path binary+marker satisfy a cache hit. If "" were used as the
      // root, the cached bin would be the relative "gogate/bin/gogate" and this would
      // miss → fall through to a network install (and throw).
      exists: (p) => p === defaultCached || p === defaultMarker,
      fetch: () => {
        fetched = true
        return Promise.resolve(makeResponse({ json: {} }))
      },
    })
    expect(await resolveBinary("/proj", deps)).toEqual([defaultCached])
    expect(fetched).toBe(false)
  })
})

describe("resolveBinary — cold install", () => {
  test("happy path: latest release, verify, extract, chmod, return cached path", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      env: {},
      sha256: () => "ABCDEF", // upper-case to exercise case-insensitive compare
      fetch: installFetch({ assetName, digest: "abcdef" }),
    })
    const cachedBin = join("/home/u", ".cache", "gogate", "bin", "gogate")
    const archivePath = join("/home/u", ".cache", "gogate", "bin", assetName)
    const marker = `${cachedBin}.ok`
    expect(await resolveBinary("/proj", deps)).toEqual([cachedBin])

    // wrote the archive AND the .ok marker; extracted (not zip); chmod'd the binary 0755.
    expect(deps.writes.map((w) => w.p)).toEqual([archivePath, marker])
    expect(deps.extracts).toEqual([
      {
        archivePath,
        destDir: join("/home/u", ".cache", "gogate", "bin"),
        isZip: false,
      },
    ])
    expect(deps.chmods).toEqual([{ p: cachedBin, mode: 0o755 }])

    // The marker is the LAST side effect — written only after extract + chmod succeed.
    const markerIdx = deps.calls.indexOf(`write:${marker}`)
    expect(markerIdx).toBeGreaterThan(deps.calls.indexOf(`extract:${dirname(cachedBin)}`))
    expect(markerIdx).toBeGreaterThan(deps.calls.indexOf(`chmod:${cachedBin}`))
    expect(markerIdx).toBe(deps.calls.length - 1)
  })

  test("happy path removes the downloaded archive after a successful install", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      env: {},
      fetch: installFetch({ assetName, digest: "deadbeef" }),
    })
    const cachedBin = join("/home/u", ".cache", "gogate", "bin", "gogate")
    const archivePath = join("/home/u", ".cache", "gogate", "bin", assetName)
    const marker = `${cachedBin}.ok`
    expect(await resolveBinary("/proj", deps)).toEqual([cachedBin])

    // The archive was written during install ...
    expect(deps.writes.some((w) => w.p === archivePath)).toBe(true)
    // ... and then removed once the binary was extracted + chmod'd, so no .tar.gz is
    // left accumulating in the cache across installs and pinned versions.
    expect(deps.removes).toContain(archivePath)
    // The removal happened BEFORE the .ok marker write (marker stays the last side effect).
    const removeIdx = deps.calls.indexOf(`removeFile:${archivePath}`)
    expect(removeIdx).toBeGreaterThan(-1)
    expect(deps.calls.indexOf(`write:${marker}`)).toBeGreaterThan(removeIdx)
  })

  test("win32 maps to windows/.zip and arm64 mapping is honored", async () => {
    const assetName = "gogate_windows_arm64.zip"
    const deps = makeDeps({
      platform: "win32",
      arch: "arm64",
      fetch: installFetch({ assetName, digest: "deadbeef" }),
    })
    const cachedBin = join("/home/u", ".cache", "gogate", "bin", "gogate.exe")
    expect(await resolveBinary("/proj", deps)).toEqual([cachedBin])
    expect(deps.extracts[0].isZip).toBe(true)
  })

  test("GOGATE_VERSION pins the tags endpoint and sends the auth header", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    let calledUrl = ""
    let authHeader: string | undefined
    const router = installFetch({ assetName, digest: "deadbeef", tagName: "v9.9.9" })
    const deps = makeDeps({
      env: { GOGATE_VERSION: "v9.9.9", GITHUB_TOKEN: "tok" },
      fetch: (input, init) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          calledUrl = url
          const h = init?.headers
          authHeader = readAuthHeader(h)
        }
        return router(input)
      },
    })
    await resolveBinary("/proj", deps)
    expect(calledUrl).toBe("https://api.github.com/repos/maros7/omos/releases/tags/v9.9.9")
    expect(authHeader).toBe("Bearer tok")
  })

  test("falls back to pinned tag when the API omits tag_name", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      env: { GOGATE_VERSION: "v7.0.0" },
      fetch: (input) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            makeResponse({
              json: {
                assets: [
                  { name: assetName, browser_download_url: ARCHIVE_URL },
                  { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
                ],
              },
            }),
          )
        }
        if (url === ARCHIVE_URL) return Promise.resolve(makeResponse({ bytes: new Uint8Array([1]) }))
        return Promise.resolve(makeResponse({ text: `deadbeef  ${assetName}\n` }))
      },
    })
    await resolveBinary("/proj", deps)
    expect(deps.chmods.length).toBe(1)
  })
})

describe("resolveBinary — BUG B: GOGATE_VERSION genuinely pins the cache", () => {
  test("(a) set version ignores the pre-existing UNVERSIONED cache and downloads the tag", async () => {
    const version = "v2.0.0"
    const assetName = "gogate_linux_amd64.tar.gz"
    const unversioned = join("/home/u", ".cache", "gogate", "bin", "gogate")
    const versionedBin = join("/home/u", ".cache", "gogate", "bin", version, "gogate")
    const versionedMarker = `${versionedBin}.ok`
    let fetched = false
    const router = installFetch({ assetName, digest: "deadbeef", tagName: version })
    const deps = makeDeps({
      env: { GOGATE_VERSION: version },
      // The UNVERSIONED binary + marker exist, but a pinned version must not use them.
      exists: (p) => p === unversioned || p === `${unversioned}.ok`,
      fetch: (input) => {
        fetched = true
        return router(input)
      },
    })
    expect(await resolveBinary("/proj", deps)).toEqual([versionedBin])
    expect(fetched).toBe(true)
    expect(deps.writes.some((w) => w.p === versionedMarker)).toBe(true)
  })

  test("(b) set version WITH a matching versioned cache (+marker) is a no-network cache hit", async () => {
    const version = "v2.0.0"
    const versionedBin = join("/home/u", ".cache", "gogate", "bin", version, "gogate")
    const versionedMarker = `${versionedBin}.ok`
    let fetched = false
    const deps = makeDeps({
      env: { GOGATE_VERSION: version },
      exists: (p) => p === versionedBin || p === versionedMarker,
      fetch: () => {
        fetched = true
        return Promise.resolve(makeResponse({ json: {} }))
      },
    })
    expect(await resolveBinary("/proj", deps)).toEqual([versionedBin])
    expect(fetched).toBe(false)
  })

  test("(c) version strings with unsafe chars are sanitized into the cache path", async () => {
    const version = "feature/foo bar"
    const sanitized = "feature-foo-bar"
    const assetName = "gogate_linux_amd64.tar.gz"
    const versionedBin = join("/home/u", ".cache", "gogate", "bin", sanitized, "gogate")
    const deps = makeDeps({
      env: { GOGATE_VERSION: version },
      fetch: installFetch({ assetName, digest: "deadbeef", tagName: version }),
    })
    // Cold install lands at the SANITIZED path, not one containing "/" or " ".
    expect(await resolveBinary("/proj", deps)).toEqual([versionedBin])
    expect(deps.writes.some((w) => w.p === `${versionedBin}.ok`)).toBe(true)
  })
})

describe("resolveBinary — install failures throw", () => {
  test("release API non-2xx throws", async () => {
    const deps = makeDeps({
      fetch: () => Promise.resolve(makeResponse({ ok: false, status: 503 })),
    })
    await expectReject(resolveBinary("/proj", deps), /release lookup failed \(503\)/)
  })

  test("unsupported platform (asset missing) throws", async () => {
    const deps = makeDeps({
      fetch: (input) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            makeResponse({
              json: {
                tag_name: "v1",
                assets: [{ name: "checksums.txt", browser_download_url: CHECKSUMS_URL }],
              },
            }),
          )
        }
        return Promise.resolve(makeResponse({}))
      },
    })
    await expectReject(resolveBinary("/proj", deps), /unsupported platform/)
  })

  test("missing checksums.txt asset throws", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (input) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            makeResponse({
              json: {
                tag_name: "v1",
                assets: [{ name: assetName, browser_download_url: ARCHIVE_URL }],
              },
            }),
          )
        }
        return Promise.resolve(makeResponse({}))
      },
    })
    await expectReject(resolveBinary("/proj", deps), /no checksums\.txt asset/)
  })

  test("archive download non-2xx throws", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (input) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            makeResponse({
              json: {
                tag_name: "v1",
                assets: [
                  { name: assetName, browser_download_url: ARCHIVE_URL },
                  { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
                ],
              },
            }),
          )
        }
        if (url === ARCHIVE_URL) return Promise.resolve(makeResponse({ ok: false, status: 404 }))
        return Promise.resolve(makeResponse({ text: "" }))
      },
    })
    await expectReject(resolveBinary("/proj", deps), /download of .* failed \(404\)/)
  })

  test("checksums download non-2xx throws", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (input) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            makeResponse({
              json: {
                tag_name: "v1",
                assets: [
                  { name: assetName, browser_download_url: ARCHIVE_URL },
                  { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
                ],
              },
            }),
          )
        }
        if (url === ARCHIVE_URL) return Promise.resolve(makeResponse({ bytes: new Uint8Array([1]) }))
        return Promise.resolve(makeResponse({ ok: false, status: 500 }))
      },
    })
    await expectReject(resolveBinary("/proj", deps), /checksums\.txt failed \(500\)/)
  })

  test("checksums.txt without an entry for the asset throws", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      fetch: (input) => {
        const url = inputToURL(input)
        if (url.includes("api.github.com")) {
          return Promise.resolve(
            makeResponse({
              json: {
                tag_name: "v1",
                assets: [
                  { name: assetName, browser_download_url: ARCHIVE_URL },
                  { name: "checksums.txt", browser_download_url: CHECKSUMS_URL },
                ],
              },
            }),
          )
        }
        if (url === ARCHIVE_URL) return Promise.resolve(makeResponse({ bytes: new Uint8Array([1]) }))
        return Promise.resolve(makeResponse({ text: "\n0000  some-other-file\n" }))
      },
    })
    await expectReject(resolveBinary("/proj", deps), /no entry for/)
  })

  test("checksum mismatch throws and does not install", async () => {
    const assetName = "gogate_linux_amd64.tar.gz"
    const deps = makeDeps({
      sha256: () => "aaaa",
      fetch: installFetch({ assetName, digest: "bbbb" }),
    })
    await expectReject(resolveBinary("/proj", deps), /checksum mismatch/)
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

    const dir = mkdtempSync(join(tmpdir(), "gogate-defaultdeps-"))
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
      await expectReject(
        deps.extract(join(dir, "nope.tar.gz"), outDir, false),
        /extract failed/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// readAuthHeader pulls the Authorization value out of fetch's many header shapes
// (Headers / record / array) without an `as` cast. The header param is typed as
// `unknown` because bun-types' `HeadersInit` resolves to an error/any type which
// would otherwise trip `no-unsafe-*` rules; we narrow each branch explicitly.
function readAuthHeader(h: unknown): string | undefined {
  if (!h) return undefined
  if (h instanceof Headers) return h.get("Authorization") ?? undefined
  if (Array.isArray(h)) {
    for (const pair of h) {
      if (Array.isArray(pair) && pair[0] === "Authorization" && typeof pair[1] === "string") {
        return pair[1]
      }
    }
    return undefined
  }
  if (typeof h === "object") {
    // Use Object.entries to read keys off the unknown object without an `as`
    // cast (the `typeof === "object"` narrow yields `object`, which has no
    // index signature).
    for (const [k, v] of Object.entries(h)) {
      if (k === "Authorization" && typeof v === "string") return v
    }
    return undefined
  }
  return undefined
}
