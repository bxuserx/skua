import {
  readdir,
  readFile,
  writeFile,
  rename,
  mkdir,
  stat,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  parse,
  serialize,
  type Frontmatter,
  type ParsedFile,
} from "./frontmatter.ts";

import { TICKETS_ROOT } from "../skua.config.ts";
export { TICKETS_ROOT };

export const BUCKETS = [
  "scratch",
  "0-backlog",
  "1-staging",
  "2-stuck",
  "3-building",
  "4-testing",
  "5-validating",
  "6-complete",
  "7-archive",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export const STATUS_FOR_BUCKET: Record<Bucket, string> = {
  "scratch": "Idea",
  "0-backlog": "Todo",
  "1-staging": "Todo",
  "2-stuck": "Stuck",
  "3-building": "In Progress",
  "4-testing": "Testing",
  "5-validating": "Validating",
  "6-complete": "Complete",
  "7-archive": "Archived",
};

// ── optional Firestore mirror (see lib/firestore.ts) ─────────────────────────
// Fire-and-forget: a LAZY dynamic import so read-only consumers of this module
// never pull in firestore.ts, and the whole thing no-ops when no `firestore`
// block is configured. Deliberately un-awaited — a ticket op must never wait on,
// or fail because of, an external sync.
function syncFire(id: string, kind: "upsert" | "delete" = "upsert"): void {
  import("./firestore.ts")
    .then((m) => (kind === "delete" ? m.deleteTicketDocSafe(id) : m.syncTicketSafe(id)))
    .catch(() => {
      /* the mirror is best-effort — never disturb the ticket op */
    });
}

export type TicketSummary = {
  id: string;
  title: string;
  priority: string;
  domain: string;
  // Complexity 1–5. See ticket-manager SKILL.md.
  complexity?: number;
  tags: string[];
  filename: string;
  bucket: Bucket;
  created?: string;
  completed?: string;
  depends_on: string[];
  blocks: string[];
  related: string[];
  files_touched: string[];
  // Optional pointer to the ADR this ticket implements (introduced by the
  // ADR system per ADR-001 D6). Singular — a ticket implements at most
  // one ADR. Surfaced in TicketSummary so .skua/lib/graphs/adrs.ts can
  // emit implements_adr edges without re-reading every full ticket.
  implements_adr?: string;
  // Single-sentence hint for what needs to happen for this ticket to progress
  // to the next lifecycle stage. Prefers the per-ticket override in the
  // `next_step_hint` frontmatter field (written by ticket-manager skill ops
  // at each lifecycle transition); falls back to the canonical per-bucket
  // sentence from nextStepHintFor when the override is absent or empty.
  next_step_hint: string;
  malformed?: string;
};

/** Returns the single-sentence next-step hint for a ticket in `bucket`, given
 *  body-derived signals (presence of the `### Pass-2 review` block, presence
 *  of the `### Stuck Reason` block). Pure, total — every bucket has a
 *  canonical sentence; no fallthrough. */
export function nextStepHintFor(
  bucket: Bucket,
  signals: { hasPass2: boolean; hasStuckReason: boolean },
): string {
  switch (bucket) {
    case "scratch":
      return "Refine this idea into a real ticket: gather context, fill Objective / Context / AC, then promote to backlog.";
    case "0-backlog":
      return "Refine this ticket: scaffold Objective / Context / AC and stage it for approval.";
    case "1-staging":
      return signals.hasPass2
        ? "Approve the staged plan and start the build."
        : "Run a cold-reader pass-2 review before this can be built.";
    case "2-stuck":
      return signals.hasStuckReason
        ? "Resolve the question in the Stuck Reason block, then unstick the ticket."
        : "Add a Stuck Reason block explaining the blocker, then unstick once it's resolved.";
    case "3-building":
      return "Finish the implementation and move the ticket to testing.";
    case "4-testing":
      return "Run AC verification with a fresh subagent and post the test verdict.";
    case "5-validating":
      return "Run a full validation review with a fresh subagent, then commit and push.";
    case "6-complete":
      return "Done — auto-archives 7 days after the completed date.";
    case "7-archive":
      return "Archived. No further action.";
  }
}

const PASS2_RE = /^###\s+Pass-2 review\b/m;
const STUCK_RE = /^###\s+Stuck Reason\b/m;

/** Resolve the next-step hint: prefer the frontmatter override when present
 *  and non-empty; otherwise fall back to the canonical per-bucket sentence.
 *  The override is written by ticket-manager skill ops at each lifecycle
 *  transition (see SKILL.md). */
export function resolveNextStepHint(
  fm: Frontmatter,
  bucket: Bucket,
  body: string,
): string {
  const override = typeof fm.next_step_hint === "string" ? fm.next_step_hint.trim() : "";
  if (override) return override;
  return nextStepHintFor(bucket, {
    hasPass2: PASS2_RE.test(body),
    hasStuckReason: STUCK_RE.test(body),
  });
}

export type TicketFull = TicketSummary & {
  frontmatter: Frontmatter;
  body: string;
};

const TKT_RE = /^TKT-(\d+)-.*\.md$/;

export async function listBucket(bucket: Bucket): Promise<TicketSummary[]> {
  const dir = join(TICKETS_ROOT, bucket);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: TicketSummary[] = [];
  for (const filename of entries) {
    if (!TKT_RE.test(filename)) continue;
    const raw = await readFile(join(dir, filename), "utf8");
    const parsed = parse(raw);
    out.push(summary(parsed, filename, bucket));
  }
  out.sort((a, b) => idNum(a.id) - idNum(b.id));
  return out;
}

export async function listAll(): Promise<TicketSummary[]> {
  const buckets = await Promise.all(BUCKETS.map(listBucket));
  return buckets.flat();
}

export async function findTicket(
  id: string,
): Promise<{ path: string; bucket: Bucket; raw: string } | null> {
  for (const bucket of BUCKETS) {
    const dir = join(TICKETS_ROOT, bucket);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of entries) {
      if (filename.startsWith(id + "-") || filename === id + ".md") {
        const path = join(dir, filename);
        const raw = await readFile(path, "utf8");
        return { path, bucket, raw };
      }
    }
  }
  return null;
}

export async function readTicket(id: string): Promise<TicketFull | null> {
  const found = await findTicket(id);
  if (!found) return null;
  const parsed = parse(found.raw);
  const filename = found.path.split("/").pop()!;
  const s = summary(parsed, filename, found.bucket);
  return { ...s, frontmatter: parsed.frontmatter, body: parsed.body };
}

export async function writeTicket(
  id: string,
  frontmatter: Frontmatter,
  body: string,
): Promise<void> {
  const found = await findTicket(id);
  if (!found) throw new Error(`ticket ${id} not found`);
  const serialized = serialize(frontmatter, body);
  // atomic write: write to .tmp sibling, then rename
  const tmp = found.path + ".tmp";
  await writeFile(tmp, serialized, "utf8");
  await rename(tmp, found.path);
  syncFire(id);
}

export async function moveTicket(
  id: string,
  toBucket: Bucket,
): Promise<{ from: Bucket; to: Bucket; path: string }> {
  const found = await findTicket(id);
  if (!found) throw new Error(`ticket ${id} not found`);
  if (found.bucket === toBucket)
    return { from: found.bucket, to: toBucket, path: found.path };

  const parsed = parse(found.raw);
  parsed.frontmatter.status = STATUS_FOR_BUCKET[toBucket];
  if (toBucket === "6-complete" && !parsed.frontmatter.completed) {
    parsed.frontmatter.completed = today();
  }

  const destDir = join(TICKETS_ROOT, toBucket);
  await mkdir(destDir, { recursive: true });
  const filename = found.path.split("/").pop()!;
  const destPath = join(destDir, filename);

  // write new content to dest path (atomically), then unlink old
  const serialized = serialize(parsed.frontmatter, parsed.body);
  const tmp = destPath + ".tmp";
  await writeFile(tmp, serialized, "utf8");
  await rename(tmp, destPath);
  // remove the old file (use rename to same dir? no — different dirs are fine via unlink-like)
  await (await import("node:fs/promises")).unlink(found.path);

  syncFire(id);
  return { from: found.bucket, to: toBucket, path: destPath };
}

/** Auto-archive tickets in `6-complete/` whose `completed` date is older than
 *  ARCHIVE_THRESHOLD_DAYS. Returns the IDs that were archived. Designed to be
 *  called by the server on every `/api/buckets` GET — the 5s frontend poll
 *  drives this, replacing the ticket-manager skill's old wrap-up step. */
const ARCHIVE_THRESHOLD_DAYS = 7;

export async function archiveStaleComplete(): Promise<string[]> {
  const completed = await listBucket("6-complete");
  const archived: string[] = [];
  const nowMs = Date.now();
  const cutoffMs = ARCHIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  for (const t of completed) {
    if (!t.completed) continue;
    const ts = Date.parse(t.completed);
    if (Number.isNaN(ts)) continue;
    if (ts > nowMs) continue; // clock-skew / manual edit: skip
    if (nowMs - ts <= cutoffMs) continue;
    try {
      await moveTicket(t.id, "7-archive");
      archived.push(t.id);
    } catch {
      // skip on any move failure; next poll will retry
    }
  }
  return archived;
}

export async function deleteTicket(id: string): Promise<{ path: string }> {
  const found = await findTicket(id);
  if (!found) throw new Error(`ticket ${id} not found`);
  await (await import("node:fs/promises")).unlink(found.path);
  syncFire(id, "delete");
  return { path: found.path };
}

/** Scan every bucket for `TKT-NNN-*.md` files and return the next free ID. */
export async function nextTicketId(): Promise<string> {
  let max = 100; // first ID will be TKT-101 if nothing exists
  for (const bucket of BUCKETS) {
    const dir = join(TICKETS_ROOT, bucket);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of entries) {
      const m = filename.match(TKT_RE);
      if (!m) continue;
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `TKT-${max + 1}`;
}

export type CreateInput = {
  title: string;
  priority?: string;
  domain?: string;
  body?: string;
  tags?: string[];
  depends_on?: string[];
  blocks?: string[];
  related?: string[];
  bucket?: Bucket;
  // Optional 1–5 complexity rating. Omitted when the creator hasn't picked one
  // (the AI sets it during refinement); see ticket-manager SKILL.md.
  complexity?: number;
};

/** Create a new ticket stub. Title and bucket (defaulted to `scratch`) are the
 *  only required fields; everything else falls back to sensible defaults so
 *  the dashboard's quick-create modal can submit with just title + priority. */
export async function createTicket(input: CreateInput): Promise<TicketFull> {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");

  const bucket: Bucket = input.bucket ?? "scratch";
  if (!BUCKETS.includes(bucket)) throw new Error(`invalid bucket: ${bucket}`);

  const id = await nextTicketId();
  const domain = (input.domain ?? "meta").trim() || "meta";
  const slug = slugify(title);
  const filename = `${id}-${domain}-${slug}.md`;
  const destDir = join(TICKETS_ROOT, bucket);
  const destPath = join(destDir, filename);

  const fm: Frontmatter = {
    id,
    title,
    status: STATUS_FOR_BUCKET[bucket],
    priority: input.priority ?? "Medium",
    assignee: "Claude-Agent",
    created: today(),
    domain,
    tags: input.tags ?? [],
    depends_on: input.depends_on ?? [],
    blocks: input.blocks ?? [],
    related: input.related ?? [],
    files_touched: [],
  };
  if (typeof input.complexity === "number") fm.complexity = input.complexity;

  // Scratch stubs may carry a short body the user typed in the create modal;
  // the AI expands this into Objective / Context / Acceptance Criteria when
  // promoting from scratch → backlog via the ticket-manager skill.
  const body = input.body ?? "";

  await mkdir(destDir, { recursive: true });
  const serialized = serialize(fm, body);
  const tmp = destPath + ".tmp";
  await writeFile(tmp, serialized, "utf8");
  await rename(tmp, destPath);

  syncFire(id);
  const parsed = parse(serialized);
  const s = summary(parsed, filename, bucket);
  return { ...s, frontmatter: parsed.frontmatter, body: parsed.body };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

export function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function summary(
  parsed: ParsedFile,
  filename: string,
  bucket: Bucket,
): TicketSummary {
  const fm = parsed.frontmatter;
  const m = filename.match(TKT_RE);
  const id = (fm.id as string | undefined) ?? (m ? `TKT-${m[1]}` : filename);
  return {
    id,
    title: (fm.title as string | undefined) ?? "(untitled)",
    priority: (fm.priority as string | undefined) ?? "Medium",
    domain: (fm.domain as string | undefined) ?? "meta",
    complexity: toNum(fm.complexity),
    tags: (fm.tags as string[] | undefined) ?? [],
    filename,
    bucket,
    created: fm.created as string | undefined,
    completed: fm.completed as string | undefined,
    depends_on: (fm.depends_on as string[] | undefined) ?? [],
    blocks: (fm.blocks as string[] | undefined) ?? [],
    related: (fm.related as string[] | undefined) ?? [],
    files_touched: (fm.files_touched as string[] | undefined) ?? [],
    implements_adr: typeof fm.implements_adr === "string" ? fm.implements_adr : undefined,
    next_step_hint: resolveNextStepHint(fm, bucket, parsed.body),
    malformed: parsed.malformed,
  };
}

function idNum(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Coerce a frontmatter scalar to a number. The minimal YAML parser returns
 *  every scalar as a string, so `complexity: 3` round-trips from disk as the
 *  string "3" — without this, complexity reads back as undefined and the
 *  complexity-based routing (plan-stack, chaos's complexity cap) silently
 *  never fires. */
function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}
