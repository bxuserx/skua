// chaos mode — merge reconciler (the validating → complete → main loop).
//
// Chaos leaves each ticket in `5-validating/` on a pushed `chaos/TKT-NNN`
// branch. APPROVAL = a human moving the ticket to `6-complete/`. Landing
// approved branches on main is a DETERMINISTIC, IDEMPOTENT reconciler — not a
// Claude "hook": Claude hooks fire on Claude's tool calls, so they can't see a
// dashboard drag. So this lives in shared code invoked from every place a move
// can happen — the `/chaos-land` command, the `ticket-manager` move-ticket
// post-step, and the dashboard server's move-to-complete handler.
//
// Work set = tickets in `6-complete/`/`7-archive/` with `chaos_branch` set and
// no `merged` stamp. Being state-based, it inherently "only merges what moved".
//
// Safety: only `chaos/*` branches are ever merged; merges run in a DEDICATED
// worktree on the target branch so they never disturb the dashboard's working
// tree; conflicts are aborted + flagged (`merge_conflict: true`), never guessed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../skua.config.ts";
import { listBucket, readTicket, today, writeTicket, type Bucket } from "./tickets.ts";
import { loadConfig, mergeWorktreePath, resolveWorktreePath, type ChaosConfig } from "./chaos.ts";

type Sh = { code: number; stdout: string; stderr: string };

function git(args: string[], cwd = REPO_ROOT): Sh {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function hasRemote(): boolean {
  return git(["remote", "get-url", "origin"]).code === 0;
}

/** The branch approved work merges into: config override, else the remote's
 *  default branch, else main/master. Exported so the supervisor can fork each
 *  worktree FROM the target — keeping branches linear descendants of it. */
export function mergeTarget(cfg: ChaosConfig): string {
  if (cfg.merge_target) return cfg.merge_target;
  const sym = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", b]).code === 0) return b;
  }
  return "main";
}

export type PendingMerge = { id: string; branch: string; depends_on: string[] };

const MERGE_BUCKETS: Bucket[] = ["6-complete", "7-archive"];

/** Approved (complete/archived) chaos tickets not yet merged. */
export async function pendingMerges(): Promise<PendingMerge[]> {
  const out: PendingMerge[] = [];
  for (const bucket of MERGE_BUCKETS) {
    for (const t of await listBucket(bucket)) {
      const full = await readTicket(t.id);
      if (!full) continue;
      if (full.frontmatter.merged) continue;
      let branch = typeof full.frontmatter.chaos_branch === "string" ? full.frontmatter.chaos_branch : "";
      // Fallback: the supervisor names every chaos branch `chaos/<id>`. If the
      // ticket carries no `chaos_branch` stamp (older tickets, or the link was
      // lost), derive it WHEN THE REF ACTUALLY EXISTS — so approved chaos work
      // always lands without a human hand-stamping it. A non-chaos ticket has no
      // such branch, so this never sweeps up ordinary work.
      if (!branch || !branch.startsWith("chaos/")) {
        const derived = `chaos/${t.id}`;
        branch = git(["rev-parse", "--verify", "--quiet", derived]).code === 0 ? derived : "";
      }
      if (!branch || !branch.startsWith("chaos/")) continue; // only ever chaos/* branches
      out.push({ id: t.id, branch, depends_on: t.depends_on });
    }
  }
  return out;
}

/** Merge prerequisites before dependents (deps usually merged already; this
 *  just keeps a same-batch dependent from landing first). */
function topoOrder(pend: PendingMerge[]): PendingMerge[] {
  const ids = new Set(pend.map((p) => p.id));
  const done = new Set<string>();
  const remaining = [...pend];
  const out: PendingMerge[] = [];
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; ) {
      const p = remaining[i];
      const blocked = p.depends_on.some((d) => ids.has(d) && !done.has(d));
      if (!blocked) {
        out.push(p);
        done.add(p.id);
        remaining.splice(i, 1);
        progress = true;
      } else i++;
    }
  }
  return out.concat(remaining); // any cycle: append in place
}

export type MergeStatus = "merged" | "conflict" | "skipped" | "error";
export type MergeResult = { id: string; branch: string; status: MergeStatus; detail?: string; commit?: string };

async function stamp(id: string, fields: Record<string, string>, drop: string[] = []): Promise<void> {
  const full = await readTicket(id);
  if (!full) return;
  for (const [k, v] of Object.entries(fields)) full.frontmatter[k] = v;
  for (const k of drop) delete full.frontmatter[k];
  await writeTicket(id, full.frontmatter, full.body);
}

/** Land a branch into the worktree. With `linear`, first try a fast-forward (no
 *  merge commit → a single linear history on the target); only if the branch has
 *  diverged from the target — main moved underneath it — fall back to a `--no-ff`
 *  merge so the work still lands. Returns the git result of the attempt that ran
 *  (code 0 = landed; non-0 = conflict, from the merge fallback). */
function landMerge(pm: PendingMerge, wt: string, linear: boolean): Sh {
  if (linear) {
    const ff = git(["merge", "--ff-only", pm.branch], wt);
    if (ff.code === 0) return ff;
  }
  return git(["merge", "--no-ff", "-m", `chaos: land ${pm.id} (${pm.branch})`, pm.branch], wt);
}

function mergeOne(pm: PendingMerge, wt: string, linear: boolean): MergeResult {
  if (git(["rev-parse", "--verify", "--quiet", pm.branch]).code !== 0) {
    return { id: pm.id, branch: pm.branch, status: "skipped", detail: "branch not found" };
  }
  const m = landMerge(pm, wt, linear);
  if (m.code !== 0) {
    git(["merge", "--abort"], wt);
    return { id: pm.id, branch: pm.branch, status: "conflict", detail: "merge conflict — needs manual resolution" };
  }
  const sha = git(["rev-parse", "HEAD"], wt).stdout.trim().slice(0, 12);
  return { id: pm.id, branch: pm.branch, status: "merged", commit: sha };
}

export type ReconcileReport = {
  target: string;
  merged: MergeResult[];
  conflicts: MergeResult[];
  skipped: MergeResult[];
  errors: MergeResult[];
  note?: string;
};

/** Land the merge worktree's HEAD onto the real target: push to origin (if a
 *  remote + `push_to_remote`), then advance the LOCAL target ref — fast-forward
 *  its checkout when the repo is sitting on it, else a plain ref move. Returns a
 *  human-readable note when something only-partly succeeded (e.g. push denied).
 *  Shared by the silent reconciler and the autonomous resolve flow. */
function advanceTarget(wt: string, target: string, cfg: ChaosConfig, mergedBranches: string[]): string | undefined {
  let note: string | undefined;
  const newHead = git(["rev-parse", "HEAD"], wt).stdout.trim();
  if (hasRemote() && cfg.push_to_remote) {
    const p = git(["push", "origin", `HEAD:${target}`], wt);
    if (p.code !== 0) note = `merged but push to origin/${target} failed: ${p.stderr.trim()}`;
  }
  const rootBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (rootBranch === target) {
    // root is sitting on the target — fast-forward its checkout to the merge
    const ff = git(["merge", "--ff-only", newHead]);
    if (ff.code !== 0) note = (note ? note + "; " : "") + `local ${target} not fast-forwarded (working tree busy) — \`git pull\` to update`;
  } else {
    git(["branch", "-f", target, newHead]); // target not checked out → safe ref advance
  }
  if (cfg.delete_branch_after_merge) {
    for (const b of mergedBranches) git(["branch", "-D", b]);
  }
  return note;
}

/** Merge every approved-but-unmerged chaos branch into the target, in a
 *  dedicated worktree. Idempotent: a second call with nothing pending is a
 *  no-op. Conflicts are flagged on the ticket and left for a human. */
export async function reconcile(): Promise<ReconcileReport> {
  const cfg = loadConfig();
  const target = mergeTarget(cfg);
  const base: ReconcileReport = { target, merged: [], conflicts: [], skipped: [], errors: [] };

  const pend = topoOrder(await pendingMerges());
  if (pend.length === 0) return { ...base, note: "nothing to merge" };

  // DETACHED worktree at the target commit — works even when `target` is
  // checked out at the repo root (the common "land while sitting on main"
  // case). We merge here, then advance the real branch separately.
  const wt = mergeWorktreePath();
  if (existsSync(wt)) git(["worktree", "remove", "--force", wt]);
  const add = git(["worktree", "add", "--detach", wt, target]);
  if (add.code !== 0) return { ...base, note: `could not create merge worktree at ${target}: ${add.stderr.trim()}` };

  const results: MergeResult[] = [];
  for (const pm of pend) {
    const r = mergeOne(pm, wt, cfg.linear_history);
    results.push(r);
    if (r.status === "merged") await stamp(r.id, { merged: today(), merge_commit: r.commit ?? "" }, ["merge_conflict"]);
    else if (r.status === "conflict") await stamp(r.id, { merge_conflict: "true" });
  }

  let note: string | undefined;
  if (results.some((r) => r.status === "merged")) {
    note = advanceTarget(wt, target, cfg, results.filter((r) => r.status === "merged").map((r) => r.branch));
  }
  git(["worktree", "remove", "--force", wt]);

  return {
    target,
    merged: results.filter((r) => r.status === "merged"),
    conflicts: results.filter((r) => r.status === "conflict"),
    skipped: results.filter((r) => r.status === "skipped"),
    errors: results.filter((r) => r.status === "error"),
    note,
  };
}

// ── autonomous conflict resolution (the `/chaos-land` flow) ───────────────────
//
// Where the silent reconciler ABORTS a conflicting merge and flags it for a
// human, this drives a `git rebase`-style stop / resolve / continue loop the
// lander agent finishes with NO human input:
//
//   1. `resolveDriver()` merges every clean branch, then STOPS at the first
//      conflict — leaving the half-merged state in the worktree (it does NOT
//      abort) and reporting the conflicted files.            → state "paused"
//   2. The agent edits those files in the worktree to resolve them, then calls
//      `resolveDriver()` again: it stages + commits the resolution, stamps the
//      ticket `merged`, and resumes — stopping at the next conflict or dry.
//   3. With nothing left to merge, the worktree holds every landed branch but
//      the real target hasn't moved yet.                     → state "ready"
//      `finalizeResolve()` then advances + pushes the target and removes it.
//
// All loop state lives in git itself — MERGE_HEAD marks a paused merge, and the
// worktree being AHEAD of target marks merges awaiting finalize — so every CLI
// call is idempotent and crash-safe: re-running `resolve` always resumes exactly
// where it left off. Branches are NEVER deleted by default (delete_branch_after_
// merge stays off), so a human can pull any landing back after the fact.

export type ResolveState = "paused" | "ready" | "empty";
export type ResolveReport = {
  target: string;
  worktree: string;
  state: ResolveState;
  merged: MergeResult[]; // branches that landed during THIS invocation
  skipped: MergeResult[];
  paused?: { id: string; branch: string; files: string[] };
  note?: string;
};

function mergeInProgress(wt: string): string | null {
  const r = git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], wt);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function unmergedFiles(wt: string): string[] {
  return git(["diff", "--name-only", "--diff-filter=U"], wt)
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Of `files`, the ones whose worktree contents STILL carry conflict markers —
 *  i.e. the agent hasn't finished resolving them. Keyed off the angle markers
 *  only (`<<<<<<< ` / `>>>>>>> `): a bare `=======` line is too common in real
 *  source to treat as unresolved. */
function filesWithMarkers(wt: string, files: string[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    let txt = "";
    try {
      txt = readFileSync(join(wt, f), "utf8");
    } catch {
      continue; // binary / deleted — let `git add` decide; no text markers to check
    }
    if (/^<{7} /m.test(txt) || /^>{7} /m.test(txt)) bad.push(f);
  }
  return bad;
}

function aheadOfTarget(wt: string, target: string): boolean {
  const r = git(["rev-list", "--count", `${target}..HEAD`], wt);
  return r.code === 0 && r.stdout.trim() !== "" && r.stdout.trim() !== "0";
}

/** One step of the autonomous merge loop (see the section header). Idempotent:
 *  resumes a paused merge if one is in progress, else merges clean branches
 *  until the next conflict. */
export async function resolveDriver(): Promise<ResolveReport> {
  const cfg = loadConfig();
  const target = mergeTarget(cfg);
  const wt = resolveWorktreePath();
  const merged: MergeResult[] = [];
  const skipped: MergeResult[] = [];
  const report = (state: ResolveState, extra: Partial<ResolveReport> = {}): ResolveReport => ({
    target,
    worktree: wt,
    state,
    merged,
    skipped,
    ...extra,
  });

  const wtReady = existsSync(join(wt, ".git"));
  const inProgress = wtReady ? mergeInProgress(wt) : null;
  const ahead = wtReady ? aheadOfTarget(wt, target) : false;
  const pend0 = await pendingMerges();

  // Nothing half-done and nothing pending: either every approved branch is
  // already merged-and-awaiting-finalize (keep the worktree), or there's truly
  // nothing to do (drop a stray worktree).
  if (!inProgress && pend0.length === 0) {
    if (wtReady && ahead) return report("ready");
    if (wtReady) {
      git(["worktree", "remove", "--force", wt]);
      git(["worktree", "prune"]);
    }
    return report("empty", { note: "nothing to merge" });
  }

  // Reuse the worktree if it carries a paused merge or prior landings; else
  // build a fresh detached one at the current target tip.
  if (!(wtReady && (inProgress || ahead))) {
    if (wtReady) git(["worktree", "remove", "--force", wt]);
    git(["worktree", "prune"]);
    const add = git(["worktree", "add", "--detach", wt, target]);
    if (add.code !== 0) return report("empty", { note: `could not create resolve worktree at ${target}: ${add.stderr.trim()}` });
  }

  // Resume a paused merge — the agent has (hopefully) resolved the files.
  if (inProgress) {
    const pm = pend0.find((p) => git(["rev-parse", p.branch]).stdout.trim() === inProgress);
    const id = pm?.id ?? "(unknown)";
    const branch = pm?.branch ?? "(in-progress merge)";
    const unresolved = filesWithMarkers(wt, unmergedFiles(wt));
    if (unresolved.length > 0) {
      return report("paused", { paused: { id, branch, files: unresolved }, note: "conflict markers still present — finish resolving" });
    }
    git(["add", "-A"], wt);
    const ci = git(["commit", "--no-edit"], wt);
    if (ci.code !== 0) {
      return report("paused", { paused: { id, branch, files: unmergedFiles(wt) }, note: `could not commit resolution: ${ci.stderr.trim()}` });
    }
    const sha = git(["rev-parse", "HEAD"], wt).stdout.trim().slice(0, 12);
    merged.push({ id, branch, status: "merged", commit: sha });
    if (pm) await stamp(pm.id, { merged: today(), merge_commit: sha }, ["merge_conflict"]);
  }

  // Merge the remaining branches (recomputed — the just-finished one is now
  // stamped and drops out), stopping at the first FRESH conflict.
  for (const pm of topoOrder(await pendingMerges())) {
    if (git(["rev-parse", "--verify", "--quiet", pm.branch]).code !== 0) {
      skipped.push({ id: pm.id, branch: pm.branch, status: "skipped", detail: "branch not found" });
      continue;
    }
    const m = landMerge(pm, wt, cfg.linear_history);
    if (m.code === 0) {
      const sha = git(["rev-parse", "HEAD"], wt).stdout.trim().slice(0, 12);
      merged.push({ id: pm.id, branch: pm.branch, status: "merged", commit: sha });
      await stamp(pm.id, { merged: today(), merge_commit: sha }, ["merge_conflict"]);
      continue;
    }
    // Conflict — DON'T abort. Leave the half-merged state for the agent to fix.
    await stamp(pm.id, { merge_conflict: "true" });
    return report("paused", { paused: { id: pm.id, branch: pm.branch, files: unmergedFiles(wt) } });
  }

  if (aheadOfTarget(wt, target)) return report("ready");
  if (existsSync(join(wt, ".git"))) {
    git(["worktree", "remove", "--force", wt]);
    git(["worktree", "prune"]);
  }
  return report("empty", { note: "nothing merged" });
}

/** Land a fully-resolved resolve worktree: push + advance the target, then tear
 *  the worktree down. Refuses while a merge is still in progress. Idempotent —
 *  a no-op when nothing is staged to land. */
export async function finalizeResolve(): Promise<ReconcileReport> {
  const cfg = loadConfig();
  const target = mergeTarget(cfg);
  const wt = resolveWorktreePath();
  const base: ReconcileReport = { target, merged: [], conflicts: [], skipped: [], errors: [] };

  if (!existsSync(join(wt, ".git"))) return { ...base, note: "no resolve worktree — nothing to finalize (run `resolve` first)" };
  if (mergeInProgress(wt)) return { ...base, note: "a merge is still in progress — resolve it and run `resolve` before `finalize`" };
  if (!aheadOfTarget(wt, target)) {
    git(["worktree", "remove", "--force", wt]);
    git(["worktree", "prune"]);
    return { ...base, note: "worktree has no new merges — nothing to finalize" };
  }

  // What's on main after this = every chaos ticket already stamped `merged`.
  const landed: MergeResult[] = [];
  for (const bucket of MERGE_BUCKETS) {
    for (const t of await listBucket(bucket)) {
      const full = await readTicket(t.id);
      const fm = full?.frontmatter;
      if (!full || !fm?.merged || typeof fm.merge_commit !== "string") continue;
      const branch = typeof fm.chaos_branch === "string" && fm.chaos_branch ? fm.chaos_branch : `chaos/${t.id}`;
      landed.push({ id: t.id, branch, status: "merged", commit: String(fm.merge_commit) });
    }
  }

  const note = advanceTarget(wt, target, cfg, landed.map((r) => r.branch));
  git(["worktree", "remove", "--force", wt]);
  git(["worktree", "prune"]);
  return { ...base, merged: landed, note: note ?? "finalized" };
}
