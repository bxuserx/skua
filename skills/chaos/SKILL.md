---
name: chaos
description: "Chaos mode — skua's third, fully-autonomous ticket-execution mode (alongside user-driven and agentic). Arms a background supervisor that drains the backlog with ZERO human input: one fresh `claude -p` per ticket in its own `chaos/TKT-NNN` git worktree, self-deliberating on technical decisions via competing viewpoint subagents. By default it MERGES cleanly-mergeable work into `main` as it runs and PUSHES to origin (`land_during_run: true`, `push_to_remote: true`); conflicts are deferred to `/chaos-land`, and every landed branch is preserved so a landing is revertible. Set `land_during_run: false` for the review-gated behavior, where work waits in `5-validating/` instead. Requires a Claude Max subscription (each ticket runs Opus 4.8 / xhigh under a usage throttle). Operations: arm (`/chaos`), `/chaos stop`, `/chaos resume`, `/chaos status`."
when_to_use: "User types `/chaos`, `/chaos stop`, `/chaos resume`, `/chaos status`, or says 'run chaos mode', 'drain the backlog autonomously', 'arm chaos'. NEVER entered implicitly — only via the explicit arming ceremony here. The ticket-manager flow-gate must redirect any 'chaos' request to this skill."
connects_to:
  - handoff:ticket-manager
  - handoff:adr-manager
  - handoff:feature-scout
  - handoff:ux-audit
  - handoff:a11y-audit
kind: workflow
---

# Chaos mode

> ⚠ **EXPERIMENTAL — fully autonomous, no human in the loop, and it lands to `main`.** Chaos amplifies every risk in the `ticket-manager` EXPERIMENTAL warning (autonomous coding agents have wiped production databases). At the user's direction it now **merges validated work into `main` automatically as it runs** (pushing to origin) and decides every implementation *and* product call itself — so its safety rests on these guarantees you must never weaken: work happens only on `chaos/TKT-NNN` branches; **only cleanly-mergeable work lands automatically** — a conflict is flagged and deferred to `/chaos-land`, never blind-resolved by the loop; **every landed branch is preserved** (never auto-deleted) so any landing is revertible; the `chaos-guard` hook still blocks history rewrites, force-pushes, branch/Db/infra destruction; and **nothing arms without the explicit ceremony below**. (Set `land_during_run: false` in config for the old review-gated behavior — work then waits in `5-validating/` and lands only via `/chaos-land`.)

## The three execution modes

|  | user-driven | agentic | **chaos** |
|---|---|---|---|
| Human gates | every step | once (commit) | **zero** |
| Entry | flow-gate | flow-gate | **`/chaos` arming ceremony only** |
| When stuck | — | wait in `2-stuck/` | **decide & proceed (auto-requeue if truly stuck)** |
| Driver | interactive | foreground `run-stack` | **background supervisor + fresh `claude -p` per ticket** |
| Isolation | current tree | current tree | **`chaos/TKT-NNN` worktree per ticket** |
| Terminal state | user moves | `5-validating/` | **merged to `main` (clean) / deferred to `/chaos-land` (conflict); branch always kept** |

Chaos is a **sibling** of the flow-gate modes, not reachable through it. The `ticket-manager` flow-gate redirects any "chaos" request here.

## Requirements (check at arm time, warn if missing)

- **Claude Max subscription.** The proactive throttle reads the 5h/7d rate-limit windows only a Max plan exposes. Each ticket's `claude -p` runs **Opus 4.8 at `xhigh`** under a per-ticket `--max-budget-usd` cap.
- **Usage snapshot bridge** wired (`chaos-statusline-snapshot.ts` tee → `~/.claude/.skua-usage-snapshot.json`). Missing/stale ⇒ chaos runs serial + reactive-only.
- **Git remote + push perms** if `push_to_remote` (default on). Absent ⇒ branches stay local.

## Operation: arm (`/chaos`)

The ONLY way to start chaos. **Default-deny** on anything short of the exact token.

1. **Preview.** Run `bun .skua/scripts/chaos-eligible.ts` and show eligible tickets (id · priority · complexity). Show caps from `.skua/cache/chaos/config.json` (defaults: `max_tickets` 10, **`max_parallel` 1 — serial**, pause@90%/5h, `max_adrs` 3, **`generate_when_dry` off** — finishes when the backlog drains, **`linear_history` on** — fast-forward landings, no merge commits).
2. **Pre-flight** (report each result):
   - **Usage signal** — read `~/.claude/.skua-usage-snapshot.json`. Missing/stale → warn the proactive throttle is blind (reactive backoff only); offer to wire the tee: point `statusLine.command` at `chaos-statusline-snapshot.ts` wrapping the user's existing statusline (reversible on stop).
   - **Git** — `git remote get-url origin` and push perms present? If not and `push_to_remote`, warn branches stay local **and nothing lands** (auto-landing needs to push `main`). Confirm the current `main` is in a state the user is willing to have committed onto.
3. **Spell it out, verbatim:** "Chaos will run autonomously with **no further prompts** and **will push commits to `main`**. It builds tickets **one at a time** (up to `<max_tickets>`), each on a `chaos/TKT-NNN` branch forked from `main`, and the instant one validates it **fast-forwards it into `main` and pushes to origin** — so `main` grows as a single linear history (one commit per ticket, no merge bubbles) and each ticket builds on a `main` that already has all the prior work. It decides every implementation and product call itself. Every branch is preserved, so you can `git revert`/reset any landing. A branch that conflicts (rare in serial mode) is flagged for you to land later with `/chaos-land`. When the backlog drains it stops (set `generate_when_dry: true` to keep inventing work instead). Stop anytime: `/chaos stop` or `touch .tickets/STOP`."
4. **Require the token.** Ask the user to type exactly **`arm chaos`**. Anything else → do not start. Re-ask once on an ambiguous reply, then abort. Never infer intent.
5. **Launch detached** (the supervisor writes the `.chaos-active` flag + run record itself):
   ```bash
   nohup bun .skua/scripts/chaos-supervisor.ts > .skua/cache/chaos/supervisor.log 2>&1 &
   ```
   Then report the run id (from `.skua/cache/chaos/supervisor.log`) and that the dashboard banner + `[CHAOS]` badge are live.

## Operation: `/chaos stop`

`touch .tickets/STOP` and remove `~/.claude/.chaos-active`. The supervisor halts at the top of its next loop iteration. Tell the user to delete `.tickets/STOP` before any future run. If the statusline tee was wired at arm time, offer to restore the original `statusLine.command`.

## Operation: `/chaos resume`

For resuming after a `/chaos stop` or a crash (the supervisor self-resumes from a usage pause via in-process backoff). Find the newest `.skua/cache/chaos/run-*.json` with status `paused_usage` or `running`, ensure `.tickets/STOP` is gone, then `nohup bun .skua/scripts/chaos-supervisor.ts --run <id> > .skua/cache/chaos/supervisor.log 2>&1 &`.

## Operation: `/chaos status`

Read the active run record (`.skua/cache/chaos/run-*.json`): report status, tickets built/skipped, in-flight, usage at last check, and the run-report path `.tickets/chaos-runs/run-<id>.md`.

## The autonomy doctrine (what each worker does)

Every ticket is driven by a fresh `claude -p` following `.skua/templates/chaos-work.md`:
- Drive the `ticket-manager` pipeline refine → pass-2 → build → test → validate, headless.
- On a blocking decision apply the discriminator: **"Could a competent senior engineer pick a defensible answer from the codebase + best practices alone, with no business input?"** YES → spawn 2–3 viewpoint subagents, judge on merit, document, continue. NO → `mark-stuck`, and the supervisor skips to the next ticket.
- Document: routine calls → `### Autonomous Decision` block on the ticket; architectural calls → an ADR (reuse `adr-researcher`/`adr-manager`, link `implements_adr`).
- Complexity 4–5 → bounce back to `0-backlog/` for a human `plan-stack` (chaos builds ≤3 only).

## The scout rotation (self-sustaining work)

When the backlog drains, chaos doesn't stop — it rotates through its **scouts** (config `scouts`, round-robin from a per-run cursor), only finalizing when a *full* rotation turns up nothing:
- **`feature-scout`** — invents new features (generative).
- **`ux-audit`** — reviews the existing app's routing / flow / visual hierarchy / feedback & loading states / animation polish against Nielsen's heuristics and files improvement tickets (optimization). Pure code-read → runs autonomously.
- **`a11y-audit`** — WCAG 2.2 AA gaps; runs the real axe-core/pa11y engine on-demand (with a dev server) or a high-confidence static read inside the loop.

All scouts run **ponytail OFF** (propose boldly) and file `ai-proposed`-tagged backlog tickets that chaos then builds — closing the loop from *find* → *fix*. `bug-scan` can be added to the rotation too. This three-seam mix (corrective / generative / optimization) is what keeps a run from just piling on features; the caps remain the only brakes.

## Architectural coherence (full-stack)

Each worker has fresh context, so architecture is kept coherent by **externalizing** it, not by memory:
- Workers read the architecture surface (ADRs + the `/graphs/schemas` & `/graphs/dataflow` maps + `CLAUDE.md`) and **extend existing contracts** rather than invent parallel ones; new cross-cutting contracts are written back as **ADRs** — the shared spine every future fresh-context worker inherits.
- A full-stack slice's **tightly-coupled layers build together in one ticket** (coherent by construction). A large feature (complexity 4–5) is **decomposed contract-first**: a foundation ticket (shared contract + ADR, tagged `architecture`) that the others `depends_on`, plus loosely-coupled ≤3 pieces — only the irreducibly-coupled-and-large case is punted to a human.
- **Architecture tickets run strictly alone** (the supervisor never co-schedules two contract-establishers), and the validate gate fails on architectural drift.

## Reviewing a run (human, later)

By default (`land_during_run: true`) chaos **lands as it runs**: the supervisor's `landAndHeal` step auto-approves each validated ticket (`5-validating → 6-complete`) and merges its clean branch into `main`, so review is **post-hoc**. Open `.tickets/chaos-runs/run-<id>.md` for the per-ticket decision blocks/ADRs, then review the merges on `main` (each lands as a `chaos: land TKT-NNN` merge commit). To undo a landing, the `chaos/TKT-NNN` branch is always preserved — `git revert -m 1 <merge_commit>` or reset. Because landing happens in **small, continuous batches** (each new worktree forks from a `main` that already has the prior work), overlapping conflicts are rare; any branch that *does* conflict is left in `6-complete/` flagged `merge_conflict: true` and **deferred to `/chaos-land`**, which resolves the pile autonomously with its best attempt (no human input) and pushes. The supervisor also **auto-requeues stuck tickets** (up to `max_unstick_retries`) to rebuild on the richer main, so a `2-stuck/` pile heals itself.

For a **review-gated** run instead, set `land_during_run: false`: work then accumulates in `5-validating/`, nothing touches `main` automatically, and you land approved tickets yourself with `/chaos-land` (still autonomous on conflicts) or by moving them to `6-complete/` one at a time.
