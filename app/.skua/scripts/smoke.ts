#!/usr/bin/env bun
// CLI for the smoke harness: `bun run smoke [--ticket TKT-NNN] [--cwd <dir>]`.
//
// Prints the SmokeResult JSON to STDOUT (so a test-ticket subagent can capture it
// verbatim as evidence) and a human summary to STDERR. Also writes result.json
// beside the screenshots under .skua/cache/smoke/<ticket>/.
//
// Exit code: 0 = pass OR skip (the feature being unused/unprovisioned must never
// fail a ticket); non-zero = a real smoke failure, so callers/CI can gate on it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runSmoke, type SmokeResult } from "../lib/smoke.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function summarize(r: SmokeResult): string {
  if (r.status === "skipped") return `smoke: SKIPPED — ${r.reason}`;
  if (r.status === "error") return `smoke: ERROR — ${r.reason}`;
  if (r.status === "fail" && r.routes.length === 0) return `smoke: FAIL — ${r.reason}`;
  const head = `smoke: ${r.status.toUpperCase()} (port ${r.port})`;
  const rows = r.routes.map((rt) => `  ${rt.pass ? "✓" : "✗"} ${rt.route}${rt.pass ? "" : ` — ${rt.note}`}`);
  return [head, ...rows].join("\n");
}

const result: SmokeResult = await runSmoke({ ticketId: arg("--ticket"), cwd: arg("--cwd") });

if (result.artifactsDir) {
  try {
    writeFileSync(join(result.artifactsDir, "result.json"), JSON.stringify(result, null, 2));
  } catch {
    /* best-effort — stdout still carries the result */
  }
}

process.stderr.write(summarize(result) + "\n");
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(result.status === "pass" || result.status === "skipped" ? 0 : 1);
