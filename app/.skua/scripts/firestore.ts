#!/usr/bin/env bun
// CLI for the optional Firestore ticket mirror (see the `firestore` skill and
// lib/firestore.ts). Verbs:
//
//   init [--project ID] [--board NAME] [--collection NAME] [--database ID]
//        Write/patch the `firestore` block in skua.config.json (projectId from
//        --project | existing config | `gcloud config` | ADC quota project), then
//        verify credentials + database (a probe write/delete) and do a first full
//        backfill of the board.
//   sync [--quiet]     Forced full-board reconcile. Used by the Stop hook; a
//                      graceful no-op (exit 0) when the mirror is off.
//   status             Resolved config + token check + cached-doc count.
//   test               Probe write/delete — proves creds + database + IAM work.
//   off [--write-config]  How to disable; --write-config removes the block.
//
// Human output → stderr; machine JSON (where useful) → stdout. Exit 0 on success
// or graceful skip; non-zero only on a real, actionable failure.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { REPO_ROOT } from "../skua.config.ts";
import {
  firestoreConfigured,
  firestoreStatus,
  firestoreProbe,
  syncBoardSafe,
} from "../lib/firestore.ts";

const CONFIG_PATH = process.env.SKUA_CONFIG ?? join(REPO_ROOT, "skua.config.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function out(s: string): void {
  process.stderr.write(s + "\n");
}

// Read skua.config.json for a read-modify-write. A MISSING file is fine (we're
// about to create it), but a PRESENT-but-unparseable file must abort — otherwise
// writeConfig would replace it with just our `firestore` block and silently drop
// the user's smoke/port/repoRoot settings.
function readConfig(): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return {}; // absent → safe to create fresh
  }
  if (!raw.trim()) return {}; // empty file → treat as absent
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${CONFIG_PATH} is not valid JSON (${(e as Error).message}) — fix it first; refusing to overwrite and lose other settings`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} is not a JSON object — fix it first; refusing to overwrite`);
  }
  return parsed as Record<string, unknown>;
}
function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

async function gcloudProject(): Promise<string | null> {
  try {
    if (typeof Bun === "undefined") return null;
    const proc = Bun.spawn(["gcloud", "config", "get-value", "project"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // Bound it and drain both pipes — gcloud can hang or be chatty on stderr.
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 15_000);
    const [o] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    const p = o.trim();
    return p && p !== "(unset)" ? p : null;
  } catch {
    return null;
  }
}
function adcQuotaProject(): string | null {
  try {
    const path =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(homedir(), ".config", "gcloud", "application_default_credentials.json");
    const c = JSON.parse(readFileSync(path, "utf8")) as { quota_project_id?: string };
    return c.quota_project_id ?? null;
  } catch {
    return null;
  }
}

function remediation(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("403") || m.includes("permission")) {
    return (
      "  ↳ grant your identity the Datastore role, e.g.:\n" +
      "     gcloud projects add-iam-policy-binding <project> --member='user:<you>' --role=roles/datastore.user"
    );
  }
  if (m.includes("404") || m.includes("not found") || m.includes("database")) {
    return (
      "  ↳ create a Firestore database (Native mode) in this project:\n" +
      "     https://console.cloud.google.com/firestore   (or: gcloud firestore databases create --location=<region>)"
    );
  }
  if (m.includes("token") || m.includes("credential")) {
    return "  ↳ set up local credentials:  gcloud auth application-default login";
  }
  return "  ↳ see the Firestore sync log: .skua/cache/firestore/sync.log";
}

async function cmdInit(): Promise<number> {
  const isChild = process.env.SKUA_FS_INIT_CHILD === "1";
  if (!isChild) {
    const cfg = readConfig();
    const existing = (cfg.firestore ?? {}) as Record<string, unknown>;
    const projectId =
      arg("--project") ||
      (typeof existing.projectId === "string" ? existing.projectId : "") ||
      (await gcloudProject()) ||
      adcQuotaProject() ||
      "";
    if (!projectId) {
      out("✗ no GCP project — pass --project <id>, or run: gcloud config set project <id>");
      return 1;
    }
    const block: Record<string, unknown> = { ...existing, projectId };
    if (arg("--database")) block.database = arg("--database");
    if (arg("--collection")) block.collection = arg("--collection");
    if (arg("--board")) block.board = arg("--board");

    if (JSON.stringify(existing) !== JSON.stringify(block)) {
      cfg.firestore = block;
      writeConfig(cfg);
      out(
        `→ wrote firestore block to skua.config.json ` +
          `(projectId: ${projectId}, collection: ${block.collection ?? "skua_tickets"})`,
      );
    } else {
      out(`→ firestore already configured (projectId: ${projectId})`);
    }
    // FIRESTORE is resolved at import from the config as it was ON DISK when this
    // process started — re-exec once so a fresh process picks up the just-written
    // block for verification + backfill. SKUA_FS_INIT_CHILD guards recursion.
    if (typeof Bun === "undefined") {
      out("✗ this CLI requires Bun");
      return 1;
    }
    const child = Bun.spawn(["bun", import.meta.path, "init"], {
      env: { ...process.env, SKUA_FS_INIT_CHILD: "1" },
      stdout: "inherit",
      stderr: "inherit",
    });
    await child.exited;
    return child.exitCode ?? 0;
  }

  // ── child: the freshly-written config is now live in FIRESTORE ──
  if (!firestoreConfigured()) {
    out("✗ firestore not configured (skua.config.json missing a firestore.projectId?)");
    return 1;
  }
  out("→ verifying credentials + database (probe write/delete)…");
  try {
    await firestoreProbe();
    out("  ✓ credentials + database OK");
  } catch (e) {
    out(`  ✗ ${(e as Error).message}`);
    out(remediation((e as Error).message));
    return 1;
  }
  out("→ backfilling the board…");
  const r = await syncBoardSafe({ force: true });
  if (r) out(`  ✓ mirrored ${r.written}/${r.total} ticket(s) to Firestore`);
  out("✓ firestore mirror enabled — ticket status now syncs live.");
  return 0;
}

async function cmdSync(): Promise<number> {
  if (!firestoreConfigured()) {
    if (!has("--quiet")) {
      out("firestore: not configured — no-op. Enable with: bun .skua/scripts/firestore.ts init --project <id>");
    }
    return 0; // graceful skip — never fail the caller (e.g. the Stop hook)
  }
  const r = await syncBoardSafe({ force: true });
  if (r === null) {
    if (!has("--quiet")) out("firestore: sync skipped/failed — see .skua/cache/firestore/sync.log");
    return 0;
  }
  if (!has("--quiet")) {
    out(`firestore: synced ${r.written} changed / ${r.total} total${r.deleted ? `, ${r.deleted} deleted` : ""}`);
  }
  process.stdout.write(JSON.stringify(r) + "\n");
  return 0;
}

async function cmdStatus(): Promise<number> {
  const s = await firestoreStatus();
  if (!s.config) {
    out("firestore: OFF — no `firestore` block with a projectId in skua.config.json.");
    out("  enable:  bun .skua/scripts/firestore.ts init --project <gcp-project-id>");
    return 0;
  }
  out("firestore mirror:");
  out(`  projectId:  ${s.config.projectId}`);
  out(`  database:   ${s.config.database}`);
  out(`  collection: ${s.config.collection}`);
  out(`  board:      ${s.config.board}`);
  out(`  prune:      ${s.config.prune}`);
  out(`  disabled:   ${s.disabled ? "yes (SKUA_FIRESTORE_DISABLE=1)" : "no"}`);
  out(`  token:      ${s.tokenOk ? "OK (Application Default Credentials)" : "UNAVAILABLE — run: gcloud auth application-default login"}`);
  out(`  cached:     ${s.cachedDocs} local doc hash(es)`);
  process.stdout.write(JSON.stringify(s) + "\n");
  return s.tokenOk ? 0 : 1;
}

async function cmdTest(): Promise<number> {
  if (!firestoreConfigured()) {
    out("firestore: not configured — nothing to test.");
    return 1;
  }
  out("→ probe write + delete…");
  try {
    await firestoreProbe();
    out("✓ Firestore reachable and writable (credentials + database + IAM all OK).");
    return 0;
  } catch (e) {
    out(`✗ ${(e as Error).message}`);
    out(remediation((e as Error).message));
    return 1;
  }
}

function cmdOff(): number {
  out("To turn the Firestore mirror OFF:");
  out("  • temporary (this shell):  export SKUA_FIRESTORE_DISABLE=1");
  out("  • permanent:               remove the `firestore` block from skua.config.json");
  if (has("--write-config")) {
    const cfg = readConfig();
    if (cfg.firestore) {
      delete cfg.firestore;
      writeConfig(cfg);
      out("→ removed the `firestore` block from skua.config.json");
    } else {
      out("→ no `firestore` block to remove");
    }
  }
  return 0;
}

const verb = process.argv[2] ?? "status";
let code = 0;
try {
  switch (verb) {
    case "init":
      code = await cmdInit();
      break;
    case "sync":
      code = await cmdSync();
      break;
    case "status":
      code = await cmdStatus();
      break;
    case "test":
      code = await cmdTest();
      break;
    case "off":
      code = cmdOff();
      break;
    default:
      out(`unknown verb: ${verb}`);
      out("usage: bun .skua/scripts/firestore.ts <init|sync|status|test|off> [flags]");
      code = 2;
  }
} catch (e) {
  // e.g. readConfig() refusing to overwrite a corrupt skua.config.json.
  out(`✗ ${(e as Error).message}`);
  code = 1;
}
process.exit(code);
