// chaos mode — eligibility picker.
//
// Decides which backlog tickets the chaos supervisor may pick up next, fully
// autonomously and safely:
//   • build-ready buckets only — `0-backlog` / `1-staging` (the worker drives
//     refine → pass-2 → build → test → validate; scratch is too thin, and
//     2-stuck..7-archive are not pickable).
//   • complexity ≤ cap — large/xl (4–5) tickets are left for humans (a
//     `plan-stack` decomposition is their job, not chaos's).
//   • dependency-safe — every `depends_on` must already be LANDED ON MAIN
//     (6-complete / 7-archive), not merely validating, and not in-flight. A
//     worker's worktree forks from `main`, so a dep that's only on an unmerged
//     `chaos/*` branch is INVISIBLE to it — requiring deps in a merged bucket is
//     what keeps dependents from being stranded. (The supervisor lands clean
//     work to main every loop, so a prereq becomes visible the iteration after
//     it validates.)
//   • not in-flight — never hand the same ticket to two workers.
//
// Pure functions + a CLI for debugging/tests. The supervisor imports
// `pickBatch` directly.
//
//   bun scripts/chaos-eligible.ts                 # ranked eligible ids
//   bun scripts/chaos-eligible.ts --json          # full JSON
//   bun scripts/chaos-eligible.ts --in-flight TKT-101,TKT-102 --limit 3

import { listAll, type Bucket, type TicketSummary } from "../lib/tickets.ts";
import { loadConfig } from "../lib/chaos.ts";

const PICKABLE: ReadonlySet<Bucket> = new Set(["0-backlog", "1-staging"]);
// A dep counts as DONE only once it's MERGED to main (6-complete / 7-archive) —
// NOT while it's merely validating on an unmerged branch a fresh worktree can't
// see. Continuous landing (supervisor `landAndHeal`) keeps this flowing.
const DONE: ReadonlySet<Bucket> = new Set(["6-complete", "7-archive"]);

const PRIORITY_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 1;
}

function idNum(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** A ticket's deps are satisfied iff every dep is in a DONE bucket and none is
 *  currently in-flight. Unknown deps (missing tickets) are treated as
 *  unsatisfied — better to skip than to build against a phantom prerequisite. */
function depsSatisfied(
  t: TicketSummary,
  bucketById: Map<string, Bucket>,
  inFlight: Set<string>,
): boolean {
  for (const dep of t.depends_on) {
    if (inFlight.has(dep)) return false;
    const b = bucketById.get(dep);
    if (!b || !DONE.has(b)) return false;
  }
  return true;
}

export type Eligible = {
  id: string;
  title: string;
  bucket: Bucket;
  priority: string;
  complexity?: number;
  depends_on: string[];
  tags: string[];
};

/** All currently-eligible tickets, ranked: priority, then complexity (quick
 *  wins first; unknown complexity sorts at the cap), then id. */
export async function eligibleTickets(inFlight: Set<string> = new Set()): Promise<Eligible[]> {
  const cfg = loadConfig();
  const all = await listAll();
  const bucketById = new Map<string, Bucket>(all.map((t) => [t.id, t.bucket]));

  const eligible = all.filter((t) => {
    if (!PICKABLE.has(t.bucket)) return false;
    if (inFlight.has(t.id)) return false;
    if (typeof t.complexity === "number" && t.complexity > cfg.complexity_cap) return false;
    if (t.malformed) return false;
    return depsSatisfied(t, bucketById, inFlight);
  });

  eligible.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const ca = a.complexity ?? cfg.complexity_cap;
    const cb = b.complexity ?? cfg.complexity_cap;
    if (ca !== cb) return ca - cb;
    return idNum(a.id) - idNum(b.id);
  });

  return eligible.map((t) => ({
    id: t.id,
    title: t.title,
    bucket: t.bucket,
    priority: t.priority,
    complexity: t.complexity,
    depends_on: t.depends_on,
    tags: t.tags,
  }));
}

/** Pick up to `limit` eligible tickets to run concurrently, ensuring no picked
 *  ticket depends on another in the same batch (so a parallel round never runs
 *  a dependent before its prerequisite). Serial callers pass limit = 1. */
export async function pickBatch(
  inFlight: Set<string>,
  limit: number,
): Promise<Eligible[]> {
  if (limit <= 0) return [];
  const ranked = await eligibleTickets(inFlight);
  const picked: Eligible[] = [];
  const pickedIds = new Set<string>();
  for (const t of ranked) {
    if (picked.length >= limit) break;
    if (t.depends_on.some((d) => pickedIds.has(d))) continue; // intra-batch order
    picked.push(t);
    pickedIds.add(t.id);
  }
  return picked;
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inFlight = new Set(
    (flag("--in-flight") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const limitStr = flag("--limit");
  const wantJson = argv.includes("--json");

  const list = limitStr
    ? await pickBatch(inFlight, Number(limitStr))
    : await eligibleTickets(inFlight);

  if (wantJson) {
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
  } else if (list.length === 0) {
    process.stderr.write("(no eligible tickets)\n");
  } else {
    for (const t of list) {
      process.stdout.write(
        `${t.id}\t${t.priority}\tcx=${t.complexity ?? "?"}\t${t.bucket}\t${t.title}\n`,
      );
    }
  }
}
