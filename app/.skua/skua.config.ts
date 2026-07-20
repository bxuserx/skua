// Central path + port resolver for the skua dashboard.
//
// Resolution order (highest precedence first):
//   1. SKUA_* environment variables
//   2. skua.config.json at the repo root (or the path in $SKUA_CONFIG)
//   3. Relative defaults — the vendored layout, where `.skua/` sits at the
//      repo root beside `.tickets/` and `.claude/`.
//
// A vendored install needs none of this: the defaults resolve correctly because
// `.skua/` is a direct child of the repo root. The overrides exist so the app
// can also run against a ticket store / repo located elsewhere (sidecar, CI,
// tests).

import { join, isAbsolute, basename } from "node:path";
import { readFileSync } from "node:fs";

const HERE = import.meta.dir; // <repo>/.skua
const DEFAULT_REPO_ROOT = join(HERE, ".."); // <repo>

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : join(base, p);
}

// Raw `smoke` block as it appears in skua.config.json (all optional). Absent
// or missing `start` ⇒ the smoke feature is off for this repo.
type SmokeConfigFile = {
  start?: string; // REQUIRED to enable. {PORT} token is substituted per run.
  cwd?: string;
  url?: string;
  routes?: string[];
  readySelector?: string;
  spinnerSelectors?: string[];
  consoleErrorAllowlist?: string[];
  requestFailedAllowlist?: string[];
  bootTimeoutMs?: number;
  navTimeoutMs?: number;
  settleMs?: number;
  retriesPerRoute?: number;
  env?: Record<string, string>;
  viewport?: { width: number; height: number };
};

// Raw `firestore` block as it appears in skua.config.json (all optional). Absent
// or missing `projectId` ⇒ the Firestore mirror is off for this repo. Credentials
// are NEVER here — they come from local Application Default Credentials at runtime.
type FirestoreConfigFile = {
  projectId?: string; // REQUIRED to enable — your GCP project id.
  database?: string; // Firestore database id (default "(default)")
  collection?: string; // top-level collection for ticket docs (default "skua_tickets")
  board?: string; // namespace so one database can serve many repos (default: repo dir name)
  prune?: boolean; // delete remote docs whose ticket file is gone (default false)
};

type ConfigFile = {
  repoRoot?: string;
  ticketsRoot?: string;
  adrsRoot?: string;
  port?: number;
  smoke?: SmokeConfigFile;
  firestore?: FirestoreConfigFile;
};

function loadConfigFile(repoRoot: string): ConfigFile {
  const path = process.env.SKUA_CONFIG ?? join(repoRoot, "skua.config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

const envRepoRoot = process.env.SKUA_REPO_ROOT;
const probeRoot = envRepoRoot ? abs(process.cwd(), envRepoRoot) : DEFAULT_REPO_ROOT;
const cfg = loadConfigFile(probeRoot);

export const REPO_ROOT: string = envRepoRoot
  ? abs(process.cwd(), envRepoRoot)
  : cfg.repoRoot
    ? abs(DEFAULT_REPO_ROOT, cfg.repoRoot)
    : DEFAULT_REPO_ROOT;

export const TICKETS_ROOT: string = process.env.SKUA_TICKETS_ROOT
  ? abs(process.cwd(), process.env.SKUA_TICKETS_ROOT)
  : cfg.ticketsRoot
    ? abs(REPO_ROOT, cfg.ticketsRoot)
    : join(REPO_ROOT, ".tickets");

export const ADRS_ROOT: string = process.env.SKUA_ADRS_ROOT
  ? abs(process.cwd(), process.env.SKUA_ADRS_ROOT)
  : cfg.adrsRoot
    ? abs(REPO_ROOT, cfg.adrsRoot)
    : join(TICKETS_ROOT, "ADRs");

export const SKILLS_ROOT: string = join(REPO_ROOT, ".claude", "skills");

export const PORT: number = process.env.PORT
  ? Number(process.env.PORT)
  : typeof cfg.port === "number"
    ? cfg.port
    : 5174;

// ── smoke verification ───────────────────────────────────────────────────────
// Optional headless-browser smoke check (see lib/smoke.ts). Resolved here so the
// harness and CLI share one source of truth.

export type SmokeConfig = {
  start: string;
  cwd: string; // absolute — where `start` runs
  url: string; // may contain a {PORT} token, substituted per run
  routes: string[];
  readySelector: string | null;
  spinnerSelectors: string[];
  consoleErrorAllowlist: string[];
  requestFailedAllowlist: string[];
  bootTimeoutMs: number;
  navTimeoutMs: number;
  settleMs: number;
  retriesPerRoute: number;
  env: Record<string, string>;
  viewport: { width: number; height: number };
};

// Resolved smoke config, or null when the target declares none (feature off, the
// no-op path for CLI/library targets). A `smoke` block without `start` is treated
// as absent — without a boot command there's nothing to smoke.
export const SMOKE: SmokeConfig | null = (() => {
  const s = cfg.smoke;
  if (!s || typeof s.start !== "string" || !s.start.trim()) return null;
  return {
    // RELATIVE offset (default "."), resolved in lib/smoke.ts against the working
    // copy that's actually running — the chaos worktree in chaos mode, the repo
    // otherwise — so smoke boots the edited code, not a fixed REPO_ROOT.
    start: s.start,
    cwd: s.cwd ?? ".",
    url: s.url ?? "http://127.0.0.1:{PORT}",
    routes: s.routes && s.routes.length ? s.routes : ["/"],
    readySelector: s.readySelector ?? null,
    spinnerSelectors: s.spinnerSelectors ?? [],
    consoleErrorAllowlist: s.consoleErrorAllowlist ?? [],
    requestFailedAllowlist: s.requestFailedAllowlist ?? [],
    bootTimeoutMs: s.bootTimeoutMs ?? 60_000,
    navTimeoutMs: s.navTimeoutMs ?? 15_000,
    settleMs: s.settleMs ?? 1_500,
    retriesPerRoute: s.retriesPerRoute ?? 1,
    env: s.env ?? {},
    viewport: s.viewport ?? { width: 1280, height: 800 },
  };
})();

// Repo-local Playwright browser cache — NEVER ~/.cache/ms-playwright. The harness
// exports PLAYWRIGHT_BROWSERS_PATH=this both when provisioning and when launching,
// so browsers stay inside the repo (gitignored) and never go machine-global.
// Anchored at REPO_ROOT (not HERE) so chaos worktrees — whose own .skua/cache is
// absent (gitignored, not committed) — share the ROOT repo's provisioned browsers.
export const SMOKE_BROWSERS_PATH: string =
  process.env.PLAYWRIGHT_BROWSERS_PATH || join(REPO_ROOT, ".skua", "cache", "browsers");

// Per-run smoke artifacts (result.json + screenshots). Also REPO_ROOT-anchored so
// they survive the supervisor removing the worktree after a chaos run.
export const SMOKE_ARTIFACTS_DIR: string = join(REPO_ROOT, ".skua", "cache", "smoke");

// Dedicated free-port range for smoke app-boots — non-overlapping with the
// terminal allocator's 7700–7799 so the two never contend.
export const SMOKE_PORT_RANGE = { start: 5800, end: 5899 } as const;

// ── Firestore mirror ─────────────────────────────────────────────────────────
// Optional: mirror the ticket board into a Firestore collection so status can be
// watched from outside the repo (see lib/firestore.ts). Resolved here — like
// SMOKE — so the sync core, the CLI, and the reconcile triggers share one source
// of truth. Null (feature off, the no-op path) unless a `firestore` block declares
// a projectId. Credentials come from local ADC at runtime — never from config/git.

export type FirestoreConfig = {
  projectId: string;
  database: string;
  collection: string;
  board: string;
  prune: boolean;
};

export const FIRESTORE: FirestoreConfig | null = (() => {
  const f = cfg.firestore;
  if (!f || typeof f.projectId !== "string" || !f.projectId.trim()) return null;
  return {
    projectId: f.projectId.trim(),
    database: (f.database && f.database.trim()) || "(default)",
    collection: (f.collection && f.collection.trim()) || "skua_tickets",
    board: (f.board && f.board.trim()) || basename(REPO_ROOT),
    prune: f.prune === true,
  };
})();

// Machine-local sync state (token cache, per-doc content hashes, log) under
// .skua/cache/ (gitignored), REPO_ROOT-anchored so chaos worktrees share the
// root repo's token + hash cache rather than re-minting per worktree.
export const FIRESTORE_CACHE_DIR: string = join(REPO_ROOT, ".skua", "cache", "firestore");
export const FIRESTORE_LOG: string = join(FIRESTORE_CACHE_DIR, "sync.log");
export const FIRESTORE_TOKEN_CACHE: string = join(FIRESTORE_CACHE_DIR, "token.json");
export const FIRESTORE_SYNC_STATE: string = join(FIRESTORE_CACHE_DIR, "sync-state.json");
