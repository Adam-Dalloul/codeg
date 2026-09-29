#!/usr/bin/env node
//
// Prepare Tauri sidecars before `tauri build` / `tauri dev` consume them.
//
// What it does:
//   1. Resolves the target triple — `--target <triple>` arg, or
//      `TAURI_TARGET_TRIPLE` env, or the host's `rustc -vV` host triple.
//   2. Runs `cargo build --release --no-default-features` for each sidecar
//      bin (`codeg-mcp`, `codeg-computer-helper`) for that triple from
//      `src-tauri/`.
//   3. Copies each produced binary to
//      `src-tauri/binaries/<bin>-<triple>{.exe}` so Tauri's externalBin
//      bundler picks it up under its bare name at install time.
//
// `codeg-computer-helper` takes its trust anchors from the environment at
// compile time (`CODEG_COMPUTER_PEER_REQUIREMENT`): the release workflow sets
// it for the macOS builds, and a local build without it is a development
// helper that says so. Nothing here sets or defaults it.
//
// Why a separate script (not inline in beforeBuildCommand / GitHub Actions):
//   - Cross-compile in release.yml passes `--target <triple>` so we honour
//     the matrix triple rather than rebuilding for the host.
//   - Local `pnpm tauri dev` / `pnpm tauri build` invoke it without args and
//     get a host-triple build, so the externalBin lookup still finds a file.
//   - Skippable: set `CODEG_SKIP_SIDECAR=1` when iterating on the frontend
//     and you don't care about delegation or computer use: a development
//     codeg refuses a computer helper built from other sources than its own,
//     so after a change under `src-tauri/src/computer/` run this script once
//     (it is what rebuilds the helper) and restart `pnpm tauri dev`.
//
// Intentionally Node-only (no shell): runs identically on macOS, Linux,
// Windows GitHub runners.

import { execFileSync } from "node:child_process"
import { existsSync, copyFileSync, mkdirSync, chmodSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_TAURI = resolve(SCRIPT_DIR, "..")
const BINARIES_DIR = join(SRC_TAURI, "binaries")
// Every sidecar in `bundle.externalBin`, in the order they are built.
const BIN_NAMES = ["codeg-mcp", "codeg-computer-helper"]

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`)
}

function die(msg) {
  console.error(`[prepare-sidecars][ERROR] ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      args.target = argv[++i]
    } else if (a.startsWith("--target=")) {
      args.target = a.slice("--target=".length)
    }
  }
  return args
}

function resolveHostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"))
    if (!line) throw new Error("rustc -vV missing host: line")
    return line.replace(/^host:\s*/, "").trim()
  } catch (e) {
    die(`cannot determine host triple via rustc -vV: ${e.message}`)
  }
}

function main() {
  if (process.env.CODEG_SKIP_SIDECAR === "1") {
    log("CODEG_SKIP_SIDECAR=1 — skipping sidecar preparation")
    log(
      "computer use refuses a helper older than src-tauri/src/computer/; " +
        "run `pnpm tauri:prepare-sidecars` after changing it"
    )
    return
  }

  const { target: cliTarget } = parseArgs(process.argv.slice(2))
  const target =
    cliTarget || process.env.TAURI_TARGET_TRIPLE || resolveHostTriple()
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""

  log(`target triple: ${target}`)
  log(`building ${BIN_NAMES.join(", ")} (--release --no-default-features)`)

  // cargo build needs to run from src-tauri so it resolves the local manifest
  // and shares the swatinem/rust-cache key with other cargo invocations.
  // `--no-default-features` keeps the sidecars free of the Tauri runtime deps
  // — their required-features are empty, so this just enables cross-compile
  // without dragging in macOS-private-api / Linux WebKit / Windows WebView2.
  // One cargo invocation for both, so they share one dependency build.
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      ...BIN_NAMES.flatMap((name) => ["--bin", name]),
      "--no-default-features",
      "--target",
      target,
    ],
    { stdio: "inherit", cwd: SRC_TAURI }
  )

  mkdirSync(BINARIES_DIR, { recursive: true })
  for (const name of BIN_NAMES) {
    const built = join(SRC_TAURI, "target", target, "release", `${name}${ext}`)
    if (!existsSync(built)) {
      die(`expected ${built} after cargo build, but it does not exist`)
    }
    const dest = join(BINARIES_DIR, `${name}-${target}${ext}`)
    copyFileSync(built, dest)
    if (!isWindows) {
      // copyFileSync preserves modes on POSIX, but be explicit for tarball
      // sources that may strip the +x bit.
      chmodSync(dest, 0o755)
    }
    log(`sidecar staged at ${dest}`)
  }
}

main()
