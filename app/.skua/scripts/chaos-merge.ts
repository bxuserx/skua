// chaos mode — merge reconciler CLI.
//
//   bun scripts/chaos-merge.ts pending     # list approved-but-unmerged chaos tickets
//   bun scripts/chaos-merge.ts reconcile   # merge them all into the target (abort+flag conflicts)
//   bun scripts/chaos-merge.ts resolve     # autonomous land: merge + STOP at each conflict for the agent to fix
//   bun scripts/chaos-merge.ts finalize    # push + advance the target once `resolve` reports "ready"
//
// `reconcile` is the silent, deterministic path (ticket-manager move-to-complete
// post-step): clean merges land, conflicts are flagged `merge_conflict: true`
// for a human. Exit 3 signals unresolved conflicts.
//
// `resolve`/`finalize` are the autonomous `/chaos-land` path: `resolve` merges
// what's clean and pauses at the first conflict (exit 20) with the worktree left
// half-merged so the agent can edit the files and call `resolve` again; once it
// reports "ready", `finalize` pushes + advances the target. Gated by
// `resolve_conflicts_with_claude` (default on) — off ⇒ `resolve` falls back to
// `reconcile`.

import { finalizeResolve, pendingMerges, reconcile, resolveDriver, type ReconcileReport } from "../lib/chaos-merge.ts";
import { loadConfig } from "../lib/chaos.ts";

function printReconcile(r: ReconcileReport): void {
  process.stdout.write(`target:    ${r.target}\n`);
  process.stdout.write(`merged:    ${r.merged.map((m) => `${m.id}(${m.commit})`).join(", ") || "none"}\n`);
  process.stdout.write(`conflicts: ${r.conflicts.map((m) => m.id).join(", ") || "none"}\n`);
  process.stdout.write(`skipped:   ${r.skipped.map((m) => `${m.id} (${m.detail})`).join(", ") || "none"}\n`);
  if (r.note) process.stdout.write(`note:      ${r.note}\n`);
}

const cmd = process.argv[2] ?? "reconcile";

if (cmd === "pending") {
  const p = await pendingMerges();
  if (p.length === 0) process.stdout.write("(no pending merges)\n");
  else for (const m of p) process.stdout.write(`${m.id}\t${m.branch}\n`);
} else if (cmd === "reconcile") {
  const r = await reconcile();
  printReconcile(r);
  if (r.conflicts.length > 0) process.exit(3);
} else if (cmd === "resolve") {
  if (!loadConfig().resolve_conflicts_with_claude) {
    process.stdout.write("resolve_conflicts_with_claude is OFF — falling back to flag-and-stop reconcile.\n");
    const r = await reconcile();
    printReconcile(r);
    if (r.conflicts.length > 0) process.exit(3);
  } else {
    const r = await resolveDriver();
    process.stdout.write(`state:     ${r.state}\n`);
    process.stdout.write(`target:    ${r.target}\n`);
    process.stdout.write(`worktree:  ${r.worktree}\n`);
    process.stdout.write(`merged:    ${r.merged.map((m) => `${m.id}(${m.commit})`).join(", ") || "none"}\n`);
    if (r.skipped.length) process.stdout.write(`skipped:   ${r.skipped.map((m) => `${m.id} (${m.detail})`).join(", ")}\n`);
    if (r.note) process.stdout.write(`note:      ${r.note}\n`);
    if (r.state === "paused" && r.paused) {
      process.stdout.write(`\n⚠ CONFLICT landing ${r.paused.id} (${r.paused.branch}). Resolve these files IN THE WORKTREE, then run \`resolve\` again:\n`);
      for (const f of r.paused.files) process.stdout.write(`  ${r.worktree}/${f}\n`);
      process.exit(20);
    }
    if (r.state === "ready") {
      process.stdout.write(`\n✓ All approved branches merged in the worktree. Verify it builds, then run: bun .skua/scripts/chaos-merge.ts finalize\n`);
    }
  }
} else if (cmd === "finalize") {
  const r = await finalizeResolve();
  process.stdout.write(`target:    ${r.target}\n`);
  process.stdout.write(`merged:    ${r.merged.map((m) => m.id).join(", ") || "none"}\n`);
  if (r.note) process.stdout.write(`note:      ${r.note}\n`);
} else {
  process.stderr.write("usage: bun scripts/chaos-merge.ts [reconcile|resolve|finalize|pending]\n");
  process.exit(2);
}
