// chaos mode — shared state, config, usage-throttle, and run-record helpers.
//
// Chaos is skua's third ticket-execution mode (alongside user-driven and
// agentic): a background supervisor drains the backlog fully autonomously,
// one fresh `claude -p` per ticket in its own `chaos/TKT-NNN` worktree, and
// lands the work in `5-validating/` for human review. This module is the
// single source of truth the supervisor, the eligibility picker, the merge
// reconciler, the dashboard server, and the hooks all import — so none of
// them re-derive paths, thresholds, or the run-record shape.
//
// Local-first, no services: state is plain JSON under `.skua/cache/chaos/`
// (machine state) and a rendered report under `.tickets/chaos-runs/` (the
// human's review entry point). The live-usage snapshot is GLOBAL — rate
// limits are per-account, so any interactive session warms one file that any
// repo's supervisor reads.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { REPO_ROOT, TICKETS_ROOT } from "../skua.config.ts";

// ── paths ────────────────────────────────────────────────────────────────────

const SKUA_DIR = join(import.meta.dir, ".."); // .skua/lib → .skua
export const CHAOS_CACHE =
  process.env.SKUA_CHAOS_CACHE || join(SKUA_DIR, "cache", "chaos");
export const CHAOS_RUNS_DIR = join(TICKETS_ROOT, "chaos-runs");
export const CHAOS_CONFIG_PATH = join(CHAOS_CACHE, "config.json");
export const STOP_FILE = join(TICKETS_ROOT, "STOP"); // shared kill switch (agentic + chaos)

/** Where Claude Code keeps per-account config; the statusline reads flags here.
 *  Mirrors ponytail-config.js:getClaudeDir so the badge + snapshot agree. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** The `[CHAOS]` statusline flag (mirror of `.ponytail-active`). */
export function chaosFlagPath(): string {
  return join(claudeDir(), ".chaos-active");
}

/** GLOBAL live-usage snapshot — written by the statusline tee, read by the
 *  supervisor. Global (not per-repo) because rate limits are per-account. */
export function usageSnapshotPath(): string {
  return join(claudeDir(), ".skua-usage-snapshot.json");
}

function ensureCache(): void {
  mkdirSync(CHAOS_CACHE, { recursive: true });
}

// ── config ───────────────────────────────────────────────────────────────────

export type ChaosConfig = {
  // run caps — the ONLY brakes on a self-sustaining loop
  max_tickets: number; // total tickets BUILT this run (incl. self-generated)
  max_wall_clock_min: number;
  max_adrs: number;
  max_parallel: number; // ceiling for adaptive concurrency
  per_ticket_deliberation_cap: number; // multi-agent decisions per ticket
  // usage throttle (reserve headroom for the human's interactive usage)
  pause_five_hour_pct: number;
  pause_seven_day_pct: number;
  snapshot_stale_min: number; // older → treat usage as unknown → serial
  // per-child cost guard via `claude -p --max-budget-usd`
  max_budget_usd_per_ticket: number;
  // eligibility
  complexity_cap: number; // build tickets at/below this directly
  decompose_xl: boolean; // above the cap → decompose contract-first (vs. punt to a human)
  // model / effort pinned per child
  model: string;
  effort: string;
  // creative layer — generative/audit scouts rotated through when the backlog
  // drains (corrective bug-scan, generative feature-scout, optimization audits).
  generate_when_dry: boolean;
  scouts: string[]; // round-robin order; only finalize when a FULL rotation finds nothing
  max_generated_features: number; // per-run cap on auto-generated tickets (all scouts)
  min_feature_score: number; // saturation floor (0–100)
  // merge loop
  auto_merge_on_complete: boolean;
  resolve_conflicts_with_claude: boolean;
  land_during_run: boolean; // supervisor lands clean work to main each loop (deps flow → dependents unblock); conflicts deferred to /chaos-land
  linear_history: boolean; // land via fast-forward (no merge commits) → a single linear history on main; falls back to a merge only if a branch diverged
  max_unstick_retries: number; // auto-requeue a stuck ticket this many times before leaving it for a human
  merge_target: string; // branch approved work merges into ("" → detect default)
  delete_branch_after_merge: boolean;
  // git
  push_to_remote: boolean;
};

export const DEFAULT_CONFIG: ChaosConfig = {
  max_tickets: 10,
  max_wall_clock_min: 240,
  max_adrs: 3,
  max_parallel: 1, // SERIAL by default: each ticket builds on a main that already has every prior landed ticket → clean fast-forward landings, single linear history. Raise to parallelise (conflicts then possible).
  per_ticket_deliberation_cap: 4,
  pause_five_hour_pct: 90,
  pause_seven_day_pct: 90,
  snapshot_stale_min: 10,
  max_budget_usd_per_ticket: 5,
  complexity_cap: 3,
  decompose_xl: true,
  model: "claude-opus-4-8",
  effort: "xhigh",
  generate_when_dry: false, // bare mode: drain the backlog to main and finish, rather than inventing more work when dry. Set true to re-enable the self-sustaining scout rotation.
  scouts: ["feature-scout", "ux-audit", "a11y-audit"],
  max_generated_features: 5,
  min_feature_score: 60,
  auto_merge_on_complete: true,
  resolve_conflicts_with_claude: true,
  land_during_run: true,
  linear_history: true,
  max_unstick_retries: 3,
  merge_target: "",
  delete_branch_after_merge: false,
  push_to_remote: true,
};

/** Defaults overlaid with `.skua/cache/chaos/config.json` (if present). */
export function loadConfig(): ChaosConfig {
  try {
    const raw = JSON.parse(readFileSync(CHAOS_CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── usage snapshot + throttle ─────────────────────────────────────────────────

export type UsageSnapshot = {
  five_hour_pct: number;
  seven_day_pct: number;
  context_pct: number;
  ts: string; // ISO
};

export function readSnapshot(): UsageSnapshot | null {
  try {
    const s = JSON.parse(readFileSync(usageSnapshotPath(), "utf8"));
    if (typeof s.five_hour_pct !== "number") return null;
    return s as UsageSnapshot;
  } catch {
    return null;
  }
}

export function writeSnapshot(s: UsageSnapshot): void {
  const p = usageSnapshotPath();
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(s), "utf8");
  renameSync(tmp, p);
}

export function isStale(s: UsageSnapshot | null, cfg: ChaosConfig): boolean {
  if (!s) return true;
  const age = Date.now() - Date.parse(s.ts);
  return !Number.isFinite(age) || age > cfg.snapshot_stale_min * 60_000;
}

/** Adaptive concurrency from the live usage signal. Degrades to serial (1)
 *  whenever the snapshot is stale/missing — the safe fallback. Returns 0 when
 *  a window is past its pause threshold (the supervisor then pauses + schedules
 *  a resume). Tiers reserve human headroom below the 90% ceiling. */
export function desiredConcurrency(
  s: UsageSnapshot | null,
  cfg: ChaosConfig,
): number {
  if (isStale(s, cfg)) return 1;
  const snap = s as UsageSnapshot;
  if (snap.five_hour_pct >= cfg.pause_five_hour_pct) return 0;
  if (snap.seven_day_pct >= cfg.pause_seven_day_pct) return 0;
  let n: number;
  if (snap.five_hour_pct < 50) n = cfg.max_parallel;
  else if (snap.five_hour_pct < 75) n = 2;
  else n = 1; // 75–90%
  return Math.max(0, Math.min(n, cfg.max_parallel));
}

export type PauseDecision = { paused: boolean; reason: string };

/** Proactive throttle gate checked before spawning each ticket. */
export function usagePause(
  s: UsageSnapshot | null,
  cfg: ChaosConfig,
): PauseDecision {
  if (isStale(s, cfg)) return { paused: false, reason: "" }; // serial, not paused
  const snap = s as UsageSnapshot;
  if (snap.five_hour_pct >= cfg.pause_five_hour_pct)
    return { paused: true, reason: `5h usage ${Math.round(snap.five_hour_pct)}% ≥ ${cfg.pause_five_hour_pct}%` };
  if (snap.seven_day_pct >= cfg.pause_seven_day_pct)
    return { paused: true, reason: `7d usage ${Math.round(snap.seven_day_pct)}% ≥ ${cfg.pause_seven_day_pct}%` };
  return { paused: false, reason: "" };
}

// ── git / worktree naming ──────────────────────────────────────────────────────

export function chaosBranch(ticketId: string): string {
  return `chaos/${ticketId}`;
}

/** Per-ticket worktree dir: a sibling of the repo so it stays out of graph
 *  scans (same convention as wt.sh). */
export function worktreePath(ticketId: string): string {
  return `${REPO_ROOT}-worktrees/chaos-${ticketId}`;
}

/** Dedicated worktree the merge reconciler uses so merges never disturb the
 *  dashboard's working tree. */
export function mergeWorktreePath(): string {
  return `${REPO_ROOT}-worktrees/chaos-merge`;
}

/** Worktree the AUTONOMOUS conflict-resolution flow (`/chaos-land`) merges in.
 *  Kept under the OS temp dir — NOT the repo-sibling `*-worktrees/` dir — so the
 *  interactive lander agent can Edit conflicted files even while a chaos run is
 *  armed: the chaos-guard hook allows writes under tmp but denies the repo
 *  sibling. Distinct from `mergeWorktreePath()` so a live silent reconcile can't
 *  yank a paused resolution session out from under the agent. */
export function resolveWorktreePath(): string {
  // djb2 of the full repo path keeps the tmp name unique per project (two repos
  // whose dirs share a basename — e.g. both `app/` — won't collide), while the
  // readable basename suffix keeps it greppable.
  let h = 5381;
  for (let i = 0; i < REPO_ROOT.length; i++) h = ((h << 5) + h + REPO_ROOT.charCodeAt(i)) >>> 0;
  return join(tmpdir(), `skua-chaos-merge-resolve-${basename(REPO_ROOT)}-${h.toString(36)}`);
}

// ── flag (statusline + hook arming) ────────────────────────────────────────────

export function writeChaosFlag(runId: string): void {
  const p = chaosFlagPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, runId + "\n", "utf8");
}

export function clearChaosFlag(): void {
  try {
    rmSync(chaosFlagPath());
  } catch {
    /* best-effort */
  }
}

export function chaosActive(): boolean {
  return existsSync(chaosFlagPath());
}

// ── run records ────────────────────────────────────────────────────────────────

export type TicketOutcome =
  | "validating" // built, tested, validated → review queue
  | "stuck" // genuine blocker → skipped
  | "error"; // child died / failed

export type DecisionRef = {
  kind: "block" | "adr";
  summary: string;
  adr_id?: string;
};

export type ProcessedTicket = {
  id: string;
  title: string;
  outcome: TicketOutcome;
  branch?: string;
  compare_url?: string;
  ai_proposed?: boolean;
  decisions: DecisionRef[];
  skip_reason?: string;
  ended: string; // ISO
};

export type RunStatus = "running" | "paused_usage" | "complete" | "halted";

export type ChaosRun = {
  id: string;
  mode: "chaos";
  status: RunStatus;
  started: string; // ISO
  ended?: string; // ISO
  stop_reason?: string;
  config: ChaosConfig;
  in_flight: string[]; // ticket ids currently being worked
  processed: ProcessedTicket[];
  generated_features: number;
  scout_cursor: number; // position in the scout rotation (round-robin when dry)
  adrs_created: number;
  usage_start: UsageSnapshot | null;
  usage_end: UsageSnapshot | null;
};

export function runRecordPath(id: string): string {
  return join(CHAOS_CACHE, `run-${id}.json`);
}

export function newRunId(): string {
  // sortable timestamp id, e.g. 20260620-143005-ab12
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.floor((Date.now() % 1_000_000)).toString(36).slice(-4);
  return `${stamp}-${rand}`;
}

export function newRun(config: ChaosConfig): ChaosRun {
  return {
    id: newRunId(),
    mode: "chaos",
    status: "running",
    started: new Date().toISOString(),
    config,
    in_flight: [],
    processed: [],
    generated_features: 0,
    scout_cursor: 0,
    adrs_created: 0,
    usage_start: readSnapshot(),
    usage_end: null,
  };
}

export function writeRun(run: ChaosRun): void {
  ensureCache();
  const p = runRecordPath(run.id);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(run, null, 2), "utf8");
  renameSync(tmp, p);
  writeRunReport(run); // keep the human-readable report in lockstep
}

export function readRun(id: string): ChaosRun | null {
  try {
    return JSON.parse(readFileSync(runRecordPath(id), "utf8")) as ChaosRun;
  } catch {
    return null;
  }
}

/** Run records the dashboard banner / `/api/chaos/active` should surface. */
export function activeRuns(): ChaosRun[] {
  let files: string[];
  try {
    files = readdirSync(CHAOS_CACHE);
  } catch {
    return [];
  }
  const out: ChaosRun[] = [];
  for (const f of files) {
    if (!/^run-.*\.json$/.test(f)) continue;
    try {
      const r = JSON.parse(readFileSync(join(CHAOS_CACHE, f), "utf8")) as ChaosRun;
      if (r.status === "running" || r.status === "paused_usage") out.push(r);
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => Date.parse(b.started) - Date.parse(a.started));
  return out;
}

// ── run report (a render of the run record — JSON is the source of truth) ───────

const OUTCOME_LABEL: Record<TicketOutcome, string> = {
  validating: "✓ validating",
  stuck: "⊘ skipped (stuck)",
  error: "✗ error",
};

export function runReportPath(id: string): string {
  return join(CHAOS_RUNS_DIR, `run-${id}.md`);
}

export function renderRunReport(run: ChaosRun): string {
  const lines: string[] = [];
  lines.push(`# Chaos run ${run.id}`);
  lines.push("");
  lines.push(`- **Status:** ${run.status}${run.stop_reason ? ` — ${run.stop_reason}` : ""}`);
  lines.push(`- **Started:** ${run.started}`);
  if (run.ended) lines.push(`- **Ended:** ${run.ended}`);
  lines.push(
    `- **Caps:** max_tickets ${run.config.max_tickets} · max_parallel ${run.config.max_parallel} · ` +
      `pause@ ${run.config.pause_five_hour_pct}%/5h · max_adrs ${run.config.max_adrs}`,
  );
  const usg = (u: UsageSnapshot | null) =>
    u ? `5h ${Math.round(u.five_hour_pct)}% · 7d ${Math.round(u.seven_day_pct)}%` : "unknown";
  lines.push(`- **Usage:** start ${usg(run.usage_start)} → end ${usg(run.usage_end)}`);
  lines.push(
    `- **Built:** ${run.processed.filter((p) => p.outcome === "validating").length} · ` +
      `**Skipped:** ${run.processed.filter((p) => p.outcome === "stuck").length} · ` +
      `**Generated features:** ${run.generated_features} · **ADRs:** ${run.adrs_created}`,
  );
  lines.push("");
  lines.push("> Review queue: each built ticket sits in `5-validating/` on its `chaos/TKT-NNN` branch.");
  lines.push("> Approve by moving it to `6-complete/` (or run `/chaos-land`) — approved branches merge to main.");
  lines.push("");
  lines.push("| Ticket | Title | Outcome | Branch | Decisions | Note |");
  lines.push("|---|---|---|---|---|---|");
  for (const p of run.processed) {
    const decisions =
      p.decisions.length === 0
        ? "—"
        : p.decisions
            .map((d) => (d.kind === "adr" ? `ADR ${d.adr_id ?? ""}`.trim() : d.summary))
            .join("; ");
    const branch = p.branch ? `\`${p.branch}\`` : "—";
    const tag = p.ai_proposed ? " 🤖" : "";
    lines.push(
      `| ${p.id}${tag} | ${escapeCell(p.title)} | ${OUTCOME_LABEL[p.outcome]} | ${branch} | ` +
        `${escapeCell(decisions)} | ${escapeCell(p.skip_reason ?? "")} |`,
    );
  }
  lines.push("");
  lines.push("🤖 = AI-proposed feature (filed by feature-scout, built autonomously).");
  lines.push("");
  return lines.join("\n");
}

export function writeRunReport(run: ChaosRun): void {
  mkdirSync(CHAOS_RUNS_DIR, { recursive: true });
  const p = runReportPath(run.id);
  const tmp = p + ".tmp";
  writeFileSync(tmp, renderRunReport(run), "utf8");
  renameSync(tmp, p);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

// ── misc ────────────────────────────────────────────────────────────────────

export function stopRequested(): boolean {
  return existsSync(STOP_FILE);
}

export function nowISO(): string {
  return new Date().toISOString();
}
