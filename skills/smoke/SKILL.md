---
name: smoke
description: "Deterministic headless-browser smoke check for web targets. Boots the project's app on a free port, drives a headless Chromium over the configured routes, and fails on the runtime problems unit tests can't see — uncaught exceptions (pageerror), console.error, failed network requests, never-resolving spinners, and blank-body white-screens — capturing the actual console errors + screenshots into ticket evidence. Repo-scoped: Playwright and its Chromium live under .skua (driver) / .skua/cache/browsers (binaries, gitignored), never machine-global. Opt-in and graceful: with no `smoke` block in skua.config.json, no provisioned browser, or a non-web target, it no-ops (skipped, never a failure). Invoked automatically by the test-ticket gate and runnable by hand."
when_to_use: "Automatically inside `test-ticket` for web targets. By hand when you want to check a running web app for console/runtime errors: 'smoke test the app', 'check for console errors', '/smoke TKT-NNN'. NOT for CLI/library repos — it simply skips."
connects_to:
  - handoff:ticket-manager
kind: utility
---

# Smoke

The test/validate gates verify code statically. **Smoke** is the runtime complement: it actually boots the app in a headless browser and fails on what a passing unit test still ships — a white-screen, an uncaught exception, a console error, a spinner that never resolves. The captured console errors land in the ticket so the agent (and a human) can finally *see* the browser failure.

It is **deterministic** — no LLM judgement in the capture. Callers invoke it and transcribe its JSON.

## Enabling it (one-time, per web target)

1. Add a `smoke` block to `skua.config.json`:
   ```jsonc
   "smoke": {
     "start": "bun run dev --port {PORT}",   // REQUIRED. {PORT} is substituted per run; PORT is also set in env.
     "cwd": ".",                              // optional — subdir of a monorepo where `start` runs
     "url": "http://127.0.0.1:{PORT}",        // optional (default shown)
     "routes": ["/", "/dashboard"],           // optional (default ["/"])
     "readySelector": "[data-app-ready]",     // optional but PREFERRED — a positive ready signal
     "spinnerSelectors": [".spinner", "[aria-busy=\"true\"]"], // optional — asserted GONE after settle
     "consoleErrorAllowlist": ["Download the React DevTools"], // optional — substrings/regex to ignore
     "requestFailedAllowlist": ["/analytics"],                 // optional — URLs allowed to fail
     "bootTimeoutMs": 60000, "navTimeoutMs": 15000, "settleMs": 1500, "retriesPerRoute": 1
   }
   ```
2. Provision a **repo-local** Chromium (downloads into `.skua/cache/browsers/`, gitignored — never `~/.cache`):
   ```
   cd .skua && bun run install:browsers
   ```
   This is the ONLY place skua installs the browser. It is **setup-time and human-invoked** — never run it during a chaos run (the repo-scoping guard blocks installs). `setup.sh` offers it when a `smoke` block exists.

> Prefer `readySelector` over `spinnerSelectors`: `networkidle` can never settle on apps with websockets/polling/SSE, so a positive "the app is ready" signal is the reliable gate.

## Running it

From the repo (or chaos worktree) root:
```
bun .skua/scripts/smoke.ts --ticket TKT-NNN
```
or, from `.skua/`, `bun run smoke --ticket TKT-NNN`. It prints a `SmokeResult` JSON to **stdout** and a human summary to stderr; screenshots + `result.json` go to `.skua/cache/smoke/TKT-NNN/`. Exit code: **0 = pass OR skip**, non-zero = a real failure.

`SmokeResult.status` is one of:
- **`pass`** — every route clean.
- **`fail`** — at least one route had a console error / page error / failed request / stuck spinner / blank body (see `routes[]`), or the app never bound its port.
- **`skipped`** — no `smoke` block, browsers not provisioned, the driver isn't installed, or `SKUA_SMOKE_DISABLE=1`. **A skip is not a pass** and never fails a ticket.
- **`error`** — the harness itself errored (e.g. no free port).

## How test-ticket uses it

For web targets, `test-ticket` runs the harness, appends a `### Smoke Check` subsection to `### Test Results` (per-route table + verbatim console errors + screenshot paths), and routes a `fail`/`error` to `2-stuck/` like any test failure. `skipped`/`pass` proceed to `5-validating/`. The chaos worker is granted permission to run it via the supervisor's `--settings` injection, so it works headlessly without a prompt.

## Repo-scoped, by construction

- Browser binaries: `.skua/cache/browsers/` (gitignored), via `PLAYWRIGHT_BROWSERS_PATH` — never machine-global.
- In a chaos worktree the harness boots the **worktree's** edited code, but resolves browsers + writes artifacts under the **root** repo's `.skua/cache/` (shared across worktrees, surviving worktree cleanup).
- Per run it allocates a free port (5800–5899, randomized) so parallel chaos workers don't collide.

## Kill switch

`SKUA_SMOKE_DISABLE=1` forces a skip everywhere — the pressure-relief valve if a flaky app starts sending good tickets to `2-stuck`.
