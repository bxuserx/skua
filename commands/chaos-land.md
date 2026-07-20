---
allowed-tools: Bash(bun .skua/scripts/chaos-merge.ts:*), Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(mv:*), Read, Edit, Glob, Grep, LS
description: Approve & land chaos work — move validating tickets to complete, then merge their chaos/* branches to main, autonomously resolving any conflicts
---

Land approved chaos work, fully autonomously — **no human input on conflicts**. Running this command IS the approval; resolve every conflict with your best attempt and land everything. Branches are preserved after merge, so the human can pull any landing back later if they disagree.

## 1. Bulk-approve: move tickets from `5-validating/` to `6-complete/`

- If `$ARGUMENTS` names specific tickets, move only those.
- Otherwise move **all** of `.tickets/5-validating/` → `.tickets/6-complete/` (approving the whole review queue). Use the `move-ticket` op (it sets `status: "Complete"` + `completed:` today). The `chaos_branch` link is already on each ticket (or the reconciler derives `chaos/<id>` when the ref exists) — you do **not** hand-stamp it.

## 2. Land + auto-resolve (the loop)

Run the reconciler in **resolve** mode and drive it like a `git rebase`:

```bash
bun .skua/scripts/chaos-merge.ts resolve
```

It merges every clean branch into the target (default `main`) inside a dedicated worktree, then **stops at the first conflict** — leaving the half-merged state in the worktree (it does NOT abort) and printing the conflicted file paths. Then loop:

- **Exit 20 / `state: paused`** — there's a conflict to resolve. The output lists absolute paths under `worktree:`. For each conflicted file:
  1. `Read` it. Resolve every `<<<<<<<` / `=======` / `>>>>>>>` marker by hand, then `Edit` the file so **no markers remain**.
  2. Resolve for a coherent, compiling result: **integrate both sides' intent** when they're compatible; when two changes are mutually exclusive, keep the one that matches the landing ticket's stated goal; never just delete a feature to make the conflict go away. This is a best-effort merge — always produce *some* valid resolution rather than stopping to ask.

  When all listed files are clean, run `bun .skua/scripts/chaos-merge.ts resolve` **again** — it stages + commits your resolution, stamps the ticket `merged:`, and continues to the next branch (stopping again if it hits another conflict). Repeat until it no longer pauses.
- **`state: ready`** — every approved branch is merged in the worktree, but the real target hasn't moved yet. Finalize:

  ```bash
  bun .skua/scripts/chaos-merge.ts finalize
  ```

  This pushes the merged result to `origin/<target>` and advances the local target, then removes the worktree.
- **`state: empty`** — nothing to merge (or already finalized). Done.

The loop is idempotent and crash-safe: re-running `resolve` always picks up exactly where it left off (state lives in git's own merge/ahead status), so it's safe to re-run after any interruption.

## 3. Report

State plainly: which tickets merged, **which conflicts you auto-resolved and in which files** (and the call you made on any non-trivial one), the final target commit, and which branches stayed put. Note that conflicted branches are NOT deleted (`delete_branch_after_merge` is off) — they remain for the human to inspect or pull back.

Only `chaos/*` branches are ever touched. If a merge legitimately can't proceed (a branch ref is gone, the worktree can't be created), report it as skipped rather than fabricating a landing.
