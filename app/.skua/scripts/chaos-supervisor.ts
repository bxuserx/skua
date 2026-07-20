// chaos mode — the supervisor loop (the driver).
//
// A long-running Bun process that drains the backlog fully autonomously. For
// each eligible ticket it forks a FRESH `claude -p` in its own `chaos/TKT-NNN`
// git worktree (clean context every time; the ticket file is the handoff),
// pins Opus 4.8 / xhigh / a per-ticket budget, and on success commits + pushes
// the branch and lands the ticket in `5-validating/` for human review. It
// NEVER merges to main; approval (a human move to `6-complete/`) merges via the
// reconciler.
//
// Board vs code: the worker's CWD is the worktree (code isolation → the branch
// diff is pure code) but its `SKUA_TICKETS_ROOT` points at the ROOT repo's
// board, so lifecycle moves are shared (correct picking + live dashboard). The
// worker does NOT commit/push — the supervisor does, after a clean outcome.
//
// Brakes (the ONLY things that stop a self-sustaining run): `.tickets/STOP`,
// the run caps, and the usage throttle (pause at 90% of the 5h window, plus
// reactive backoff on a real rate-limit). Resume is in-process (the supervisor
// is already persistent) — no external scheduler needed.
//
//   bun scripts/chaos-supervisor.ts            # new run
//   bun scripts/chaos-supervisor.ts --run <id> # resume an existing run record
//   bun scripts/chaos-supervisor.ts --dry-run  # simulate (no claude, no git)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { REPO_ROOT, TICKETS_ROOT } from "../skua.config.ts";
import { listBucket, moveTicket, readTicket, writeTicket } from "../lib/tickets.ts";
import { mergeTarget, reconcile } from "../lib/chaos-merge.ts";
import { syncBoardSafe } from "../lib/firestore.ts";
import {
  type ChaosConfig,
  type ChaosRun,
  type ProcessedTicket,
  chaosBranch,
  claudeDir,
  clearChaosFlag,
  desiredConcurrency,
  loadConfig,
  newRun,
  nowISO,
  readRun,
  readSnapshot,
  stopRequested,
  usagePause,
  worktreePath,
  writeChaosFlag,
  writeRun,
} from "../lib/chaos.ts";
import { pickBatch, type Eligible } from "./chaos-eligible.ts";

const DRY_RUN = process.argv.includes("--dry-run");

// Tools the worker may never use — the ALWAYS-ON enforcement layer (a git
// worktree may not carry `.claude/`, so the chaos-guard hook can be absent;
// these `--disallowedTools` rules are passed on every invocation). The supervisor
// owns commit/push/branch ops; installs stay repo-local; the user's global
// ~/.claude is off-limits. Bash prefix rules are leaky on flag/abbrev variants
// (`npm i -g`, `--global`), so the chaos-guard regex hook — injected below via
// `--settings` — is the robust backstop for those.
const CLAUDE_DIR = claudeDir();
// Absolute-path globs use the `//<path>` form (double-slash = absolute).
const CLAUDE_DIR_GLOB = "//" + CLAUDE_DIR.replace(/^\/+/, "") + "/**";
const WORKER_DENY = [
  // supervisor owns git history; destructive shell off-limits
  "Bash(rm:*)",
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git rm:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git worktree:*)",
  "Bash(git merge:*)",
  "Bash(git rebase:*)",
  "Bash(npm publish:*)",
  // keep installs repo-local — no machine/account-global mutations
  "Bash(npm install -g:*)",
  "Bash(npm i -g:*)",
  "Bash(npm install --global:*)",
  "Bash(pnpm add -g:*)",
  "Bash(pnpm add --global:*)",
  "Bash(yarn global:*)",
  "Bash(bun add -g:*)",
  "Bash(bun add --global:*)",
  "Bash(npm link:*)",
  "Bash(brew:*)",
  "Bash(pipx:*)",
  "Bash(gem install:*)",
  "Bash(cargo install:*)",
  // never mutate the user's global Claude account/config (plugins/skills/MCP/settings)
  "Bash(claude plugin:*)",
  "Bash(claude mcp:*)",
  "Bash(claude config:*)",
  `Edit(${CLAUDE_DIR_GLOB})`,
  `Write(${CLAUDE_DIR_GLOB})`,
  `NotebookEdit(${CLAUDE_DIR_GLOB})`,
];

// Inject the chaos-guard PreToolUse hook into the worker via `--settings` so the
// robust regex checks run even though the worktree has no `.claude/`. Resolved
// against the rendered install (`.claude/hooks`) first, then the skua source
// tree (`hooks/`). Returns null (and we skip --settings) if neither exists, so a
// missing file never injects a broken hook.
function guardHookPath(): string | null {
  const candidates = [
    join(REPO_ROOT, ".claude", "hooks", "chaos-guard.js"), // vendored install
    join(import.meta.dir, "..", "..", "..", "hooks", "chaos-guard.js"), // skua source repo
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function workerSettingsArgs(): string[] {
  // The chaos-guard PreToolUse hook rides the worker's `--settings` because the
  // worktree carries no `.claude/`. This is the REAL enforcement layer under
  // `bypassPermissions`: the docs confirm PreToolUse hooks still fire and a
  // `deny` decision blocks the tool even in bypass mode. (The `permissions.allow`
  // entry is a no-op under bypass — allow rules have no effect there — but is
  // kept so the smoke harness still works if anyone switches back to acceptEdits.)
  const settings: Record<string, unknown> = {
    permissions: { allow: ["Bash(bun run smoke:*)", "Bash(bun .skua/scripts/smoke.ts:*)"] },
  };
  const guard = guardHookPath();
  if (guard) {
    settings.hooks = {
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: `node ${JSON.stringify(guard)}`, timeout: 5 }],
        },
      ],
    };
  }
  return ["--settings", JSON.stringify(settings)];
}

type Sh = { code: number; stdout: string; stderr: string };

// Chaos must run on the user's logged-in Claude subscription. Bun auto-loads the
// repo's .env into this supervisor's process, so any provider credential present
// there (or in the shell) gets inherited by a spawned `claude -p` and, per Claude
// Code's auth precedence, OVERRIDES the subscription. Strip every such override
// before handing the environment to a worker/scout so a run can ONLY resolve to
// the logged-in subscription session.
const AUTH_OVERRIDE_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];
function subscriptionEnv(extra?: Record<string, string>): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), ...(extra ?? {}) };
  for (const k of AUTH_OVERRIDE_VARS) delete e[k];
  return e;
}

function sh(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): Sh {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: subscriptionEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(args: string[], cwd = REPO_ROOT): Sh {
  return sh("git", ["-C", cwd, ...args]);
}

function log(msg: string): void {
  process.stdout.write(`[chaos] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── git / worktree ─────────────────────────────────────────────────────────────

function hasRemote(): boolean {
  return git(["remote", "get-url", "origin"]).code === 0;
}

function compareUrl(branch: string): string | undefined {
  const r = git(["remote", "get-url", "origin"]);
  if (r.code !== 0) return undefined;
  const m = r.stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/tree/${branch}` : undefined;
}

function createWorktree(ticketId: string, cfg: ChaosConfig): { path: string; branch: string } | null {
  const path = worktreePath(ticketId);
  const branch = chaosBranch(ticketId);
  if (existsSync(path)) {
    git(["worktree", "remove", "--force", path]); // stale leftover
  }
  // Fork FROM the merge target (e.g. main), not the repo's current HEAD: with
  // continuous landing the target already holds every prior ticket, so the new
  // branch is a linear descendant → landing fast-forwards (single linear
  // history) and never drags an unrelated checked-out branch into main. Fall
  // back to HEAD only if the target ref isn't present locally.
  const target = mergeTarget(cfg);
  const start = git(["rev-parse", "--verify", "--quiet", target]).code === 0 ? target : "HEAD";
  // If the branch already exists (a prior interrupted attempt), reuse it.
  const branchExists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
  const add = branchExists
    ? git(["worktree", "add", path, branch])
    : git(["worktree", "add", "-b", branch, path, start]);
  if (add.code !== 0) {
    log(`worktree add failed for ${ticketId}: ${add.stderr.trim()}`);
    return null;
  }
  // Seed top-level node_modules as a symlink so the worktree runs immediately
  // (mirrors wt.sh; cheap and gitignored so it never enters the diff).
  const nm = `${REPO_ROOT}/node_modules`;
  if (existsSync(nm) && !existsSync(`${path}/node_modules`)) {
    try {
      symlinkSync(nm, `${path}/node_modules`);
    } catch {
      /* best-effort */
    }
  }
  return { path, branch };
}

function removeWorktree(path: string): void {
  git(["worktree", "remove", "--force", path]);
}

/** Delete a chaos branch IFF it carries no commits of its own (a bare HEAD
 *  pointer). createWorktree creates the branch up-front, but a failed/abandoned
 *  attempt never commits to it; without this they pile up as empty
 *  `chaos/TKT-NNN` debris. A branch with real work (rev-list count > 0) is never
 *  touched. Call only AFTER the worktree is removed — a checked-out branch can't
 *  be deleted. */
function deleteEmptyBranch(branch: string): void {
  if (DRY_RUN) return;
  const exists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
  if (!exists) return;
  const ahead = git(["rev-list", "--count", `HEAD..${branch}`]);
  if (ahead.code === 0 && ahead.stdout.trim() === "0") git(["branch", "-D", branch]);
}

// ── the worker child ───────────────────────────────────────────────────────────

type WorkerResult = { rateLimited: boolean; code: number; detail: string };

/** Fork a fresh `claude -p` to drive one ticket through the ticket-manager
 *  pipeline headlessly. Pins model/effort/budget, points the board at root,
 *  turns ponytail ON (build wants lean code). Returns whether it hit a real
 *  rate-limit so the supervisor can back off. */
function workerPrompt(ticketId: string, cfg: ChaosConfig): string {
  // Inject the worker doctrine inline (read from the vendored template, always
  // present at root) so the worker never depends on the worktree having the
  // command/skill committed.
  const tmpl = readFileSync(join(import.meta.dir, "..", "templates", "chaos-work.md"), "utf8");
  return tmpl
    .replace(/\{\{TICKET\}\}/g, ticketId)
    .replace(/\{\{DELIBERATION_CAP\}\}/g, String(cfg.per_ticket_deliberation_cap));
}

async function runWorkerAsync(ticketId: string, worktree: string, cfg: ChaosConfig, runId: string): Promise<WorkerResult> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      workerPrompt(ticketId, cfg),
      "--model",
      cfg.model,
      "--effort",
      cfg.effort,
      "--max-budget-usd",
      String(cfg.max_budget_usd_per_ticket),
      // bypassPermissions, NOT acceptEdits: headless `-p` has no human to approve
      // a prompt, so under acceptEdits any Bash outside the allow list (build,
      // test, typecheck, install — and on non-JS projects there's no way to
      // enumerate them) is auto-denied and the worker can't actually verify its
      // work → every ticket stalls at the test gate. bypass lets it run the
      // project's real toolchain; the rails that DON'T impede dev still hold:
      // `--disallowedTools` deny rules apply in every mode (git push/commit,
      // global installs, rm stay blocked) and the injected chaos-guard PreToolUse
      // hook still fires + can deny (force-push/push-main/destructive/out-of-repo).
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--disallowedTools",
      WORKER_DENY.join(" "),
      ...workerSettingsArgs(),
    ],
    {
      cwd: worktree,
      env: subscriptionEnv({
        SKUA_TICKETS_ROOT: TICKETS_ROOT,
        SKUA_REPO_ROOT: REPO_ROOT,
        PONYTAIL_DEFAULT_MODE: "full", // build child: ponytail ON
        CHAOS_RUN_ID: runId,
        CHAOS_ACTIVE: "1",
      }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const blob = (out + err).toLowerCase();
  const rateLimited =
    /rate.?limit|usage limit|429|quota (exceeded|reached)/.test(blob) ||
    /\b5-?hour\b.*\b(limit|reached)\b/.test(blob);
  // Keep a short tail of the worker's own output so a failure can be EXPLAINED in
  // the run report — otherwise all we'd record is "error" with no cause.
  const detail = (err.trim() || out.trim()).split("\n").filter(Boolean).slice(-4).join(" ").slice(-280);
  return { rateLimited, code: proc.exitCode ?? 1, detail };
}

/** When the backlog runs dry, run the next scout in the rotation at the repo
 *  root with ponytail OFF (ideation/audit diverges; minimalism is for build
 *  time) — the self-sustaining loop's generative + optimization half. Scouts:
 *  feature-scout (invent), ux-audit / a11y-audit (refine what exists). */
function runScout(skill: string, cap: number, runId: string, cfg: ChaosConfig): void {
  sh(
    "claude",
    [
      "-p",
      `/${skill} ${cap}`,
      "--model",
      cfg.model,
      "--effort",
      cfg.effort,
      "--max-budget-usd",
      String(cfg.max_budget_usd_per_ticket),
      "--permission-mode",
      "bypassPermissions", // same rationale as the worker (see runWorkerAsync)
      "--disallowedTools",
      WORKER_DENY.join(" "),
      ...workerSettingsArgs(),
    ],
    REPO_ROOT, // scouts file backlog tickets at root; no worktree needed
    {
      SKUA_TICKETS_ROOT: TICKETS_ROOT,
      SKUA_REPO_ROOT: REPO_ROOT,
      PONYTAIL_DEFAULT_MODE: "off", // ideation: ponytail OFF — diverge boldly
      CHAOS_RUN_ID: runId,
      CHAOS_ACTIVE: "1",
    },
  );
}

// ── outcome + landing ───────────────────────────────────────────────────────────

async function stuckReason(ticketId: string): Promise<string> {
  const t = await readTicket(ticketId);
  if (!t) return "";
  const m = t.body.match(/###\s+Stuck Reason[\s\S]*?\n((?:[-*].*\n?)+)/);
  return m ? m[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean)[0] ?? "" : "";
}

/** Record an error outcome and reset the ticket to the backlog for a retry. A
 *  failed reset is LOGGED, not swallowed — a silent failure here is precisely
 *  what desynchronises the board (a ticket stranded in the wrong bucket with a
 *  stale status). */
async function resetForRetry(base: ProcessedTicket, ticketId: string, reason: string): Promise<ProcessedTicket> {
  base.outcome = "error";
  base.skip_reason = reason;
  if (!DRY_RUN) {
    const cur = (await readTicket(ticketId))?.bucket;
    if (cur && cur !== "0-backlog") {
      try {
        await moveTicket(ticketId, "0-backlog");
      } catch (e) {
        log(`reset of ${ticketId} → 0-backlog FAILED (${(e as Error).message}); it may be stranded in ${cur}`);
      }
    }
  }
  return base;
}

/** Inspect the ROOT board to see where the worker left the ticket, then land
 *  the result: commit + push on a real build, reset on interruption/failure. */
async function settle(
  ticketId: string,
  title: string,
  wt: { path: string; branch: string } | null,
  cfg: ChaosConfig,
  worker?: { code: number; detail: string },
): Promise<ProcessedTicket> {
  const full = await readTicket(ticketId);
  const bucket = full?.bucket;
  const base: ProcessedTicket = {
    id: ticketId,
    title,
    outcome: "error",
    decisions: [],
    ended: nowISO(),
    ai_proposed: full?.tags.includes("ai-proposed") ?? false,
  };

  if (bucket === "5-validating") {
    // The worker parked the ticket in validating; only call it a success if it
    // actually produced code we can commit. (The worker can't commit — that's us.)
    if (wt && !DRY_RUN) {
      git(["add", "-A"], wt.path);
      // The worktree's node_modules is a SYMLINK back to the root's (seeded in
      // createWorktree). If the project's .gitignore misses it (e.g. a trailing
      // `node_modules/` that matches a dir but not the symlink), `git add -A`
      // stages the symlink and the eventual merge clobbers root node_modules
      // with a self-reference (ELOOP) — which breaks EVERY future worktree's
      // build and cascades tickets into stuck. Unstage it unconditionally.
      git(["reset", "-q", "--", "node_modules"], wt.path);
      // Empty diff = the worker moved the ticket but errored before writing any
      // code. Don't fake a success (it would leave a 0-commit branch in the
      // review queue) — reset it for a retry instead.
      if (git(["diff", "--cached", "--quiet"], wt.path).code === 0) {
        return resetForRetry(base, ticketId, "parked in validating with an empty diff (no code produced)");
      }
      const c = git(["commit", "-m", `chaos: ${ticketId} ${title}`.slice(0, 100)], wt.path);
      if (c.code !== 0) {
        return resetForRetry(base, ticketId, `commit failed: ${c.stderr.trim() || "unknown error"}`);
      }
      if (cfg.push_to_remote && hasRemote()) {
        const p = git(["push", "-u", "origin", wt.branch], wt.path);
        if (p.code !== 0) log(`push failed for ${wt.branch}: ${p.stderr.trim()}`);
      }
      // Stamp the branch onto the ticket so the merge reconciler can find it on
      // approval. The worker never writes this; without it `pendingMerges()` —
      // which keys off `chaos_branch` — sees nothing and the work never lands.
      if (full) {
        full.frontmatter.chaos_branch = wt.branch;
        await writeTicket(ticketId, full.frontmatter, full.body);
      }
    }
    base.outcome = "validating";
    base.branch = wt?.branch;
    base.compare_url = wt ? compareUrl(wt.branch) : undefined;
    return base;
  }

  if (bucket === "2-stuck") {
    base.outcome = "stuck";
    base.skip_reason = (await stuckReason(ticketId)) || "blocked (see Stuck Reason)";
    return base;
  }

  // anything else (still mid-pipeline / the worker crashed): reset for retry.
  // Fold in the worker's exit code + output tail so the run report can say WHY.
  const where = bucket ? `left in ${bucket}` : "ticket vanished";
  const reason =
    worker && worker.code !== 0
      ? `${where}; worker exited ${worker.code}${worker.detail ? ` — ${worker.detail}` : ""}`
      : where;
  return resetForRetry(base, ticketId, reason);
}

type Settled = { processed: ProcessedTicket; rateLimited: boolean };

/** Run one ticket to completion as a single awaitable unit (worktree → worker →
 *  settle → cleanup), so the loop can keep several in flight at once. In dry-run
 *  it simulates a successful build. */
async function launchWorker(next: Eligible, runId: string, cfg: ChaosConfig): Promise<Settled> {
  const err = (skip_reason: string, rateLimited = false): Settled => ({
    processed: { id: next.id, title: next.title, outcome: "error", decisions: [], skip_reason, ended: nowISO() },
    rateLimited,
  });

  if (DRY_RUN) {
    try {
      await moveTicket(next.id, "5-validating"); // simulate a successful build
    } catch {
      /* fixture may not allow the move */
    }
    return { processed: await settle(next.id, next.title, null, cfg), rateLimited: false };
  }

  const wt = createWorktree(next.id, cfg);
  if (!wt) return err("worktree creation failed");

  // A throw anywhere on the worker path (spawn, settle, a git hiccup) must NEVER
  // reject this promise: it's awaited via Promise.race in the loop, so a
  // rejection would crash the whole supervisor and need a manual resume. Catch
  // it, record a ticket error (the attempt counter retries), keep the run alive.
  try {
    const res = await runWorkerAsync(next.id, wt.path, cfg, runId);
    if (res.rateLimited) {
      removeWorktree(wt.path);
      deleteEmptyBranch(wt.branch); // bailing on a rate-limit must not leave debris
      return err("interrupted by rate-limit", true);
    }
    if (res.code !== 0) log(`worker ${next.id} exited ${res.code}${res.detail ? `: ${res.detail}` : ""}`);
    const processed = await settle(next.id, next.title, wt, cfg, res);
    removeWorktree(wt.path); // the worktree dir is always disposable
    // Only a real validating build keeps its branch; every other outcome deletes
    // the (commit-free) branch the worktree created, so failures leave no debris.
    if (processed.outcome !== "validating") deleteEmptyBranch(wt.branch);
    return { processed, rateLimited: false };
  } catch (e) {
    try { removeWorktree(wt.path); } catch { /* best-effort */ }
    return err(`worker path errored: ${(e as Error).message}`);
  }
}

// ── the loop ─────────────────────────────────────────────────────────────────

async function finalize(run: ChaosRun, status: ChaosRun["status"], reason: string): Promise<void> {
  run.status = status;
  run.stop_reason = reason;
  run.ended = nowISO();
  run.usage_end = readSnapshot();
  run.in_flight = [];
  writeRun(run);
  if (status !== "paused_usage") clearChaosFlag();
  log(`run ${run.id} → ${status}: ${reason}`);
}

/** Drop a `### <heading>` block (through the next `###` or EOF) from a body. */
function stripSection(body: string, heading: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of body.split("\n")) {
    if (new RegExp(`^###\\s+${heading}\\b`).test(line)) { skip = true; continue; }
    if (skip && /^###\s+/.test(line)) skip = false;
    if (!skip) out.push(line);
  }
  return out.join("\n");
}

/** Continuous self-healing, run once per loop iteration so the board never
 *  stalls and dependents unblock as their prereqs reach main. Three steps, all
 *  deterministic (no agent, no blind conflict resolution):
 *    1. APPROVE — a validated, committed chaos ticket (not still in-flight) is
 *       moved `5-validating → 6-complete`. Chaos workers already drive the full
 *       validate gate, so "validating" means automated review passed; the human
 *       reviews post-hoc via the preserved branches.
 *    2. LAND — `reconcile()` merges every clean approved branch into main and
 *       pushes. Conflicts are flagged `merge_conflict` and DEFERRED to
 *       `/chaos-land` (the agent-driven resolver) — never guessed here.
 *    3. UNSTICK — a `2-stuck` ticket is handed back to the backlog to rebuild on
 *       the now-richer main (attempt counter reset), capped at
 *       `max_unstick_retries` so a genuinely hopeless ticket is eventually left.
 *  Skips everything that's currently in-flight so it never races a live worker. */
async function landAndHeal(cfg: ChaosConfig, inFlight: Set<string>, attempts: Map<string, number>): Promise<void> {
  if (DRY_RUN || !cfg.land_during_run) return;

  // 1. approve validated, committed work
  for (const t of await listBucket("5-validating")) {
    if (inFlight.has(t.id)) continue; // worker may not have committed its branch yet
    if (git(["rev-parse", "--verify", "--quiet", chaosBranch(t.id)]).code !== 0) continue;
    try {
      await moveTicket(t.id, "6-complete");
    } catch (e) {
      log(`auto-approve ${t.id} failed: ${(e as Error).message}`);
    }
  }

  // 2. land clean merges to main (conflicts flagged + deferred to /chaos-land)
  try {
    const r = await reconcile();
    if (r.merged.length) log(`landed → ${r.target}: ${r.merged.map((m) => m.id).join(", ")}`);
    if (r.conflicts.length) log(`conflicts deferred to /chaos-land: ${r.conflicts.map((m) => m.id).join(", ")}`);
    if (r.note) log(`reconcile: ${r.note}`);
  } catch (e) {
    log(`reconcile failed: ${(e as Error).message}`);
  }

  // 3. capped auto-unstick → rebuild on the richer main. The whole iteration is
  //    wrapped so a single unreadable/unwritable ticket can't throw out of the
  //    heal pass (which is awaited in the loop) and crash the supervisor.
  for (const t of await listBucket("2-stuck")) {
    if (inFlight.has(t.id)) continue;
    try {
      const full = await readTicket(t.id);
      if (!full) continue;
      const n = Number(full.frontmatter.chaos_unstick_count ?? 0);
      if (n >= cfg.max_unstick_retries) continue; // genuinely hopeless — leave it for a human
      git(["branch", "-D", chaosBranch(t.id)]); // drop the abandoned branch; the rebuild makes a fresh one
      full.frontmatter.chaos_unstick_count = String(n + 1);
      for (const k of ["merge_conflict", "chaos_branch", "merged", "merge_commit", "completed", "test_failed", "validation_failed"]) {
        delete full.frontmatter[k];
      }
      await writeTicket(t.id, full.frontmatter, stripSection(full.body, "Stuck Reason"));
      await moveTicket(t.id, "0-backlog");
      attempts.delete(t.id); // fresh per-run attempt budget for the rebuild
      log(`unstuck ${t.id} → backlog (retry ${n + 1}/${cfg.max_unstick_retries})`);
    } catch (e) {
      log(`auto-unstick ${t.id} failed: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const resumeId = (() => {
    const i = process.argv.indexOf("--run");
    return i >= 0 ? process.argv[i + 1] : undefined;
  })();

  const run: ChaosRun = (resumeId && readRun(resumeId)) || newRun(cfg);
  run.status = "running";
  writeChaosFlag(run.id);
  writeRun(run);
  log(`run ${run.id} started (dry-run=${DRY_RUN}, cwd-root=${basename(REPO_ROOT)})`);

  const startMs = Date.parse(run.started);
  const attempts = new Map<string, number>();
  const MAX_ATTEMPTS = 5;
  let backoffMin = 20;

  // Adaptive worker pool: ticketId → its running launchWorker promise. The pool
  // size is `desiredConcurrency` (usage-driven); at conc=1 this IS the serial
  // loop. Terminal conditions only fire once the pool has drained, so a running
  // worker is never abandoned.
  const active = new Map<string, Promise<Settled>>();
  const archInFlight = new Set<string>(); // architecture/contract tickets run strictly alone
  let ratePaused = false; // a worker reported a real rate-limit

  const builtCount = () => run.processed.filter((p) => p.outcome === "validating").length;
  const capsHit = () =>
    builtCount() >= cfg.max_tickets || Date.now() - startMs > cfg.max_wall_clock_min * 60_000;

  while (true) {
    const stopping = stopRequested();
    // Land clean work to main + auto-unstick before deciding what to pick next,
    // so dependents see their prereqs on main and a fixable stuck pile doesn't
    // trigger a premature "backlog dry" finalize. Skipped while halting.
    if (!stopping) await landAndHeal(cfg, new Set(active.keys()), attempts);
    // Mirror the board to Firestore if enabled — fire-and-forget + throttled; a
    // convergence backstop (per-ticket moves already sync live via moveTicket).
    void syncBoardSafe({ minIntervalMs: 15_000 });

    if (active.size === 0) {
      if (stopping) return finalize(run, "halted", ".tickets/STOP present");
      if (builtCount() >= cfg.max_tickets) return finalize(run, "complete", `max_tickets (${cfg.max_tickets}) reached`);
      if (Date.now() - startMs > cfg.max_wall_clock_min * 60_000)
        return finalize(run, "complete", `max_wall_clock (${cfg.max_wall_clock_min}m) reached`);
    }

    const snap = readSnapshot();
    const pause = usagePause(snap, cfg);
    // desired concurrency, clamped to 0 whenever we should stop launching new work
    let conc = desiredConcurrency(snap, cfg);
    if (stopping || capsHit() || ratePaused || pause.paused) conc = 0;

    // Usage pause / backoff — only when idle, so in-flight workers finish first.
    // (Stop/caps are handled by the terminal checks above; reaching here with
    // conc 0 and an empty pool means a genuine usage pause.)
    if (conc === 0 && active.size === 0) {
      const reason = pause.reason || (ratePaused ? "rate-limit hit" : "usage at ceiling");
      log(`paused: ${reason} — backing off ${backoffMin}m`);
      run.status = "paused_usage";
      writeRun(run);
      await sleep(backoffMin * 60_000);
      backoffMin = Math.min(backoffMin * 2, 300); // cap near the 5h window
      ratePaused = false;
      run.status = "running";
      writeRun(run);
      continue;
    }

    // Top up the pool toward `conc` with distinct, dependency-safe tickets.
    // Architecture/contract tickets run STRICTLY ALONE so two contract-
    // establishers never drift in parallel: don't add anything while one is in
    // flight, and don't start one alongside other running work.
    while (active.size < conc && archInFlight.size === 0) {
      const [next] = await pickBatch(new Set(active.keys()), 1);
      if (!next) break;
      const n = (attempts.get(next.id) ?? 0) + 1;
      attempts.set(next.id, n);
      if (n > MAX_ATTEMPTS) {
        run.processed.push({ id: next.id, title: next.title, outcome: "error", decisions: [], skip_reason: `gave up after ${MAX_ATTEMPTS} attempts`, ended: nowISO() });
        if (!DRY_RUN) {
          try { await moveTicket(next.id, "2-stuck"); }
          catch (e) { log(`could not park ${next.id} in 2-stuck: ${(e as Error).message}`); }
        }
        writeRun(run);
        continue;
      }
      const isArch = next.tags.includes("architecture");
      if (isArch && active.size > 0) {
        attempts.set(next.id, n - 1); // deferred, not a real attempt — wait for the pool to drain
        break;
      }
      log(`▶ ${next.id}${isArch ? " [architecture — solo]" : ""} (attempt ${n}) — ${next.title}`);
      active.set(next.id, launchWorker(next, run.id, cfg));
      backoffMin = 20; // we're moving again
      if (isArch) {
        archInFlight.add(next.id);
        break; // nothing else runs alongside an architecture ticket
      }
    }
    run.in_flight = [...active.keys()];
    writeRun(run);

    // Nothing running and nothing launchable → backlog dry. Rotate through the
    // scouts (feature-scout invents; ux-audit / a11y-audit refine what exists),
    // round-robin from the run's cursor. Only finalize when a FULL rotation
    // finds nothing new — one saturated scout doesn't mean the others are.
    if (active.size === 0) {
      const scouts = cfg.scouts ?? [];
      if (cfg.generate_when_dry && scouts.length > 0 && run.generated_features < cfg.max_generated_features && !DRY_RUN && conc > 0) {
        const remaining = cfg.max_generated_features - run.generated_features;
        let added = 0;
        let used = "";
        for (let tried = 0; tried < scouts.length && added === 0; tried++) {
          const skill = scouts[run.scout_cursor % scouts.length];
          run.scout_cursor++;
          const before = (await listBucket("0-backlog")).length;
          log(`backlog dry — running /${skill} (up to ${remaining}, ponytail OFF)`);
          runScout(skill, remaining, run.id, cfg);
          added = Math.max(0, (await listBucket("0-backlog")).length - before);
          used = skill;
        }
        if (added === 0) return finalize(run, "complete", `backlog drained — scout rotation saturated (${scouts.join(", ")})`);
        run.generated_features += added;
        writeRun(run);
        log(`/${used} filed ${added} new ticket(s)`);
        continue;
      }
      const why =
        cfg.generate_when_dry && run.generated_features >= cfg.max_generated_features
          ? `backlog drained — max_generated_features (${cfg.max_generated_features}) reached`
          : "backlog drained (no eligible tickets)";
      return finalize(run, "complete", why);
    }

    // Wait for the next worker to finish, record it, and loop to top up.
    const settled = await Promise.race(active.values());
    active.delete(settled.processed.id);
    archInFlight.delete(settled.processed.id);
    if (settled.rateLimited) {
      const a = attempts.get(settled.processed.id) ?? 1;
      attempts.set(settled.processed.id, a - 1); // a rate-limit doesn't count against the ticket
      ratePaused = true;
      log(`${settled.processed.id} hit a rate-limit — draining in-flight, then backing off`);
    } else {
      run.processed.push(settled.processed);
      log(`✔ ${settled.processed.id} → ${settled.processed.outcome}${settled.processed.branch ? ` (${settled.processed.branch})` : ""}`);
    }
    run.in_flight = [...active.keys()];
    writeRun(run);
  }
}

await main();
