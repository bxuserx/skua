#!/usr/bin/env bun
// Provision Playwright + a repo-local Chromium for the smoke harness. Idempotent;
// safe to re-run (e.g. after a setup.sh upgrade re-rsyncs .skua/package.json and
// drops the opt-in dep). Browsers land in SMOKE_BROWSERS_PATH
// (.skua/cache/browsers, gitignored) — NEVER ~/.cache/ms-playwright.
//
// This is the ONLY place skua installs the browser engine — invoked by setup.sh
// when the user opts in, or by hand: `bun run install:browsers`. It must never
// run during a chaos run (the repo-scoping guard would, correctly, treat a
// machine-global install as a violation).

import { join } from "node:path";

import { SMOKE_BROWSERS_PATH } from "../skua.config.ts";

const SKUA_DIR = join(import.meta.dir, ".."); // scripts → .skua
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: SMOKE_BROWSERS_PATH };

// 1. ensure the driver is present (driver only — no global browser download)
let havePlaywright = false;
try {
  // @ts-ignore — optional, opt-in dependency; resolved at runtime if present.
  await import("playwright");
  havePlaywright = true;
} catch {
  /* not installed yet */
}
if (!havePlaywright) {
  process.stderr.write("→ adding playwright (driver only; browser download skipped)…\n");
  const add = Bun.spawnSync(["bun", "add", "playwright"], {
    cwd: SKUA_DIR,
    env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (add.exitCode !== 0) {
    process.stderr.write("✗ `bun add playwright` failed\n");
    process.exit(1);
  }
}

// 2. install Chromium into the repo-local cache
process.stderr.write(`→ installing Chromium into ${SMOKE_BROWSERS_PATH} …\n`);
const inst = Bun.spawnSync(["bunx", "playwright", "install", "chromium"], {
  cwd: SKUA_DIR,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
if (inst.exitCode === 0) {
  process.stderr.write("✓ smoke browser provisioned (repo-local)\n");
}
process.exit(inst.exitCode ?? 1);
