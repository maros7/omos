#!/usr/bin/env node
// Launcher for the gogate Go binary, runnable via `bunx gogate …` / `npx gogate …`.
// It resolves the binary in this order, then execs it with the given args:
//   1. $GOGATE_BIN                       (explicit override)
//   2. @gogate/<os>-<arch> package       (prebuilt, installed as an optional dependency)
//   3. <repo>/bin/gogate                 (local dev build: `go build -o bin/gogate ./cmd/gogate`)
"use strict"

const { spawnSync } = require("node:child_process")
const { existsSync } = require("node:fs")
const { join } = require("node:path")
const { platform, arch } = require("node:process")

const exe = platform === "win32" ? "gogate.exe" : "gogate"

function platformPackageBinary() {
  const os = platform === "win32" ? "windows" : platform // darwin | linux | windows
  const cpu = arch === "x64" ? "amd64" : arch // amd64 | arm64
  try {
    return require.resolve(`@gogate/${os}-${cpu}/bin/${exe}`)
  } catch {
    return null
  }
}

function resolveBinary() {
  if (process.env.GOGATE_BIN) return process.env.GOGATE_BIN

  const pkg = platformPackageBinary()
  if (pkg) return pkg

  // Local dev: this file lives at <repo>/npm/bin/gogate.cjs.
  const local = join(__dirname, "..", "..", "bin", exe)
  if (existsSync(local)) return local

  return null
}

const bin = resolveBinary()
if (!bin) {
  process.stderr.write(
    "gogate: binary not found.\n" +
      "  • published install resolves @gogate/<os>-<arch> automatically, or\n" +
      "  • set GOGATE_BIN, or\n" +
      "  • build it locally: go build -o bin/gogate ./cmd/gogate\n",
  )
  process.exit(127)
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" })
if (result.error) {
  process.stderr.write(`gogate: failed to run ${bin}: ${result.error.message}\n`)
  process.exit(127)
}
process.exit(result.status ?? 1)
