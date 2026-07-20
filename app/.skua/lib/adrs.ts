import { readdir, readFile, writeFile, rename, unlink, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseFm, type Frontmatter } from "./frontmatter.ts";
import {
  createTicket,
  findTicket,
  readTicket,
  writeTicket,
  moveTicket,
  TICKETS_ROOT,
} from "./tickets.ts";

import { ADRS_ROOT } from "../skua.config.ts";
export { ADRS_ROOT };

export const ADR_STATES = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "deprecated",
] as const;
export type AdrState = (typeof ADR_STATES)[number];

export const LEGAL_TRANSITIONS: Record<AdrState, AdrState[]> = {
  proposed:   ["accepted", "rejected"],
  accepted:   ["superseded", "deprecated"],
  rejected:   [],
  superseded: [],
  deprecated: [],
};

export type DraftTicket = {
  draft_id: string;
  title: string;
  depends_on: string[];
};

export type MaterializedTicket = {
  draft_id: string;
  ticket_id: string;
};

export type AdrFrontmatter = Frontmatter & {
  status?: AdrState;
  decided?: string | null;
  deciders?: string[];
  supersedes?: string[];
  superseded_by?: string | null;
  related_tickets?: string[];
  proposed_tickets?: DraftTicket[];
  materialized_tickets?: MaterializedTicket[];
  // Optional ambition rating, 1–5, mirroring ticket complexity rubric.
  // Backwards-compatible: ADRs predating this field parse fine without it.
  // Added via TKT-219; recorded in ADR-001's Revision Log.
  complexity?: number;
  // Folder-layout version counter. Bumps on material body changes
  // (enrichment pass, transition, Decision/Consequences edit). Snapshots of
  // the prior version live in <folder>/versions/v{N}.md.
  version?: number;
};

export type AdrSummary = {
  id: string;
  title: string;
  status: AdrState;
  created: string;
  decided: string | null;
  deciders: string[];
  related_tickets: string[];
  proposed_count: number;
  materialized_count: number;
  filename: string;
  domain?: string;
  tags: string[];
};

export type ParsedAdr = {
  frontmatter: AdrFrontmatter;
  body: string;
};

const ADR_FILENAME_RE = /^ADR-(\d+)-.*\.md$/;

// ---------------------------------------------------------------------------
// Parsing — extends frontmatter.ts to handle block-list-of-objects (which the
// ticket parser doesn't need: tickets only have scalar lists).
// ---------------------------------------------------------------------------

function stripScalar(s: string): string {
  s = s.trim();
  // Quoted scalar: read to the matching closing quote so a '#' inside the
  // value stays literal (it is NOT a comment), and any trailing " # comment"
  // after the close is dropped. Double-quoted values honor backslash escapes.
  const q = s[0];
  if (q === '"' || q === "'") {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (q === '"' && c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
      if (c === q) return out;
      out += c;
    }
    // Unterminated quote — fall through to bare handling.
  }
  // Unquoted scalar: a whitespace-prefixed '#' starts a trailing comment.
  return s.replace(/\s+#.*$/, "").trim();
}

function parseScalarOrInlineList(v: string): string | string[] | null {
  const t = v.trim();
  if (t === "null") return null;
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((s) => stripScalar(s.trim()));
  }
  return stripScalar(t);
}

function parseObjectListFromRaw(raw: string, key: string): Array<Record<string, unknown>> {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return [];
  let fmEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      fmEnd = i;
      break;
    }
  }
  if (fmEnd < 0) return [];
  const fm = lines.slice(1, fmEnd);

  let keyIdx = -1;
  const keyRe = new RegExp(`^${key}:\\s*$`);
  for (let i = 0; i < fm.length; i++) {
    if (keyRe.test(fm[i])) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx < 0) return [];

  const items: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  let i = keyIdx + 1;

  while (i < fm.length) {
    const line = fm[i];
    if (/^[A-Za-z_]/.test(line)) break;
    if (!line.trim()) {
      i++;
      continue;
    }
    const itemStart = line.match(/^\s+-\s+([A-Za-z_]\w*):\s*(.*)$/);
    if (itemStart) {
      if (current) items.push(current);
      current = {};
      current[itemStart[1]] = parseScalarOrInlineList(itemStart[2]);
      i++;
      continue;
    }
    const sub = line.match(/^\s+([A-Za-z_]\w*):\s*(.*)$/);
    if (sub && current) {
      const [, k, v] = sub;
      if (v === "") {
        const subItems: string[] = [];
        i++;
        while (i < fm.length && /^\s+-\s+/.test(fm[i]) && !/^\s+-\s+[A-Za-z_]\w*:/.test(fm[i])) {
          subItems.push(stripScalar(fm[i].replace(/^\s+-\s+/, "")));
          i++;
        }
        current[k] = subItems;
        continue;
      }
      current[k] = parseScalarOrInlineList(v);
      i++;
      continue;
    }
    i++;
  }
  if (current) items.push(current);
  return items;
}

function parseAdr(raw: string): ParsedAdr {
  const base = parseFm(raw);
  const fm = base.frontmatter as AdrFrontmatter;

  const proposed = parseObjectListFromRaw(raw, "proposed_tickets") as DraftTicket[];
  const materialized = parseObjectListFromRaw(raw, "materialized_tickets") as MaterializedTicket[];
  if (proposed.length > 0) fm.proposed_tickets = proposed;
  if (materialized.length > 0) fm.materialized_tickets = materialized;

  // Normalize null literal — frontmatter.ts returns it as the string "null".
  if (fm.decided === "null" || fm.decided === undefined) fm.decided = null;
  if (fm.superseded_by === "null" || fm.superseded_by === undefined) fm.superseded_by = null;

  return { frontmatter: fm, body: base.body };
}

// ---------------------------------------------------------------------------
// Serialization — ADR-specific key order. Mirrors frontmatter.ts:serialize
// pattern but for the ADR namespace.
// ---------------------------------------------------------------------------

const ADR_KEY_ORDER = [
  "id",
  "title",
  "status",
  "version",
  "created",
  "decided",
  "deciders",
  "supersedes",
  "superseded_by",
  "related_tickets",
  "proposed_tickets",
  "materialized_tickets",
  "tags",
  "domain",
  "complexity",
];

// `title` is always quoted (may contain colons / specials). `domain` is bare
// in the canonical ADR format (matches the existing ADR-001 source), so the
// parse → serialize round-trip is byte-identical for ADRs whose `domain` is
// a simple slug. If we ever need quoted domains, lift this to a per-field
// quoting decision driven by value-shape inspection rather than key name.
const ADR_QUOTED_KEYS = new Set(["title"]);
const ADR_BLOCK_SCALAR_LIST_KEYS = new Set([
  "deciders",
  "supersedes",
  "related_tickets",
  "tags",
]);

function emitObjectList(out: string[], key: string, v: unknown): void {
  if (!Array.isArray(v) || v.length === 0) {
    out.push(`${key}: []`);
    return;
  }
  out.push(`${key}:`);
  if (key === "proposed_tickets") {
    for (const item of v as DraftTicket[]) {
      out.push(`  - draft_id: ${item.draft_id}`);
      out.push(`    title: "${item.title.replace(/"/g, '\\"')}"`);
      if (!item.depends_on || item.depends_on.length === 0) {
        out.push(`    depends_on: []`);
      } else {
        out.push(`    depends_on:`);
        for (const d of item.depends_on) out.push(`      - ${d}`);
      }
    }
    return;
  }
  if (key === "materialized_tickets") {
    for (const item of v as MaterializedTicket[]) {
      out.push(`  - draft_id: ${item.draft_id}`);
      out.push(`    ticket_id: ${item.ticket_id}`);
    }
    return;
  }
  // Generic fallback — should not be reached for current ADR schema.
  for (const item of v) out.push(`  - ${JSON.stringify(item)}`);
}

export function serializeAdr(parsed: ParsedAdr): string {
  const fm = parsed.frontmatter;
  const out: string[] = ["---"];
  const seen = new Set<string>();

  const emit = (k: string): void => {
    if (!(k in fm)) return;
    const v = (fm as Record<string, unknown>)[k];
    if (v === undefined) return;
    seen.add(k);
    if (v === null) {
      out.push(`${k}: null`);
      return;
    }
    if (k === "proposed_tickets" || k === "materialized_tickets") {
      emitObjectList(out, k, v);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push(`${k}: []`);
      } else if (ADR_BLOCK_SCALAR_LIST_KEYS.has(k)) {
        out.push(`${k}:`);
        for (const item of v) out.push(`  - ${item}`);
      } else {
        // Inline flow for any other scalar list.
        out.push(`${k}: [${(v as unknown[]).map(String).join(", ")}]`);
      }
      return;
    }
    if (ADR_QUOTED_KEYS.has(k)) {
      out.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
    } else {
      out.push(`${k}: ${v}`);
    }
  };

  for (const k of ADR_KEY_ORDER) emit(k);
  for (const k of Object.keys(fm)) if (!seen.has(k)) emit(k);

  out.push("---");
  const bodyTrimmed = parsed.body.replace(/^\s+/, "");
  return out.join("\n") + "\n\n" + bodyTrimmed;
}

// ---------------------------------------------------------------------------
// File operations.
//
// Folder-per-ADR layout (post-TKT migration):
//   .tickets/ADRs/ADR-NNN-<domain>-<slug>/
//   ├── ADR-NNN-<domain>-<slug>.md   # canonical (status + body + frontmatter.version)
//   ├── versions/v{N}.md             # immutable snapshots taken on each version bump
//   ├── comments.jsonl               # append-only {id, version, author, date, text}
//   └── references/                  # external citations + attachments
//
// The legacy flat layout (ADR-NNN-...md directly under ADRS_ROOT) is still
// readable for any not-yet-migrated ADRs — findAdrPaths falls back to it,
// but every write goes through the folder layout.
// ---------------------------------------------------------------------------

const ADR_FOLDER_RE = /^ADR-(\d+)(-[a-z0-9].*)?$/i;

export interface AdrPaths {
  folder: string;
  canonical: string;
  canonicalFilename: string;
  versionsDir: string;
  commentsFile: string;
  referencesDir: string;
  /** true if this ADR is still in the legacy flat layout */
  legacy: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function findAdrPaths(id: string): Promise<AdrPaths | null> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(ADRS_ROOT, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return null;
  }
  // Pass 1: folder layout — prefer this.
  for (const e of entries) {
    if (!e.isDir) continue;
    const m = e.name.match(ADR_FOLDER_RE);
    if (!m) continue;
    const fid = "ADR-" + String(parseInt(m[1], 10)).padStart(3, "0");
    if (fid !== id) continue;
    const folder = join(ADRS_ROOT, e.name);
    const folderEntries = await readdir(folder).catch(() => [] as string[]);
    let canonicalName: string | null = null;
    for (const f of folderEntries) {
      if (f.endsWith(".md") && f.startsWith(id + "-")) { canonicalName = f; break; }
    }
    if (!canonicalName) canonicalName = `${e.name}.md`;
    return {
      folder,
      canonical: join(folder, canonicalName),
      canonicalFilename: canonicalName,
      versionsDir: join(folder, "versions"),
      commentsFile: join(folder, "comments.jsonl"),
      referencesDir: join(folder, "references"),
      legacy: false,
    };
  }
  // Pass 2: legacy flat layout — a .md file directly under ADRS_ROOT.
  for (const e of entries) {
    if (e.isDir) continue;
    if (e.name.startsWith(id + "-") || e.name === id + ".md") {
      const flat = join(ADRS_ROOT, e.name);
      return {
        folder: ADRS_ROOT,
        canonical: flat,
        canonicalFilename: e.name,
        versionsDir: "",
        commentsFile: "",
        referencesDir: "",
        legacy: true,
      };
    }
  }
  return null;
}

/** Exported for migration scripts + the dashboard server. */
export { findAdrPaths };

function summary(parsed: ParsedAdr, filename: string): AdrSummary {
  const fm = parsed.frontmatter;
  return {
    id: fm.id ?? "",
    title: fm.title ?? "",
    status: (fm.status ?? "proposed") as AdrState,
    created: fm.created ?? "",
    decided: fm.decided ?? null,
    deciders: fm.deciders ?? [],
    related_tickets: fm.related_tickets ?? [],
    proposed_count: fm.proposed_tickets?.length ?? 0,
    materialized_count: fm.materialized_tickets?.length ?? 0,
    filename,
    domain: fm.domain,
    tags: fm.tags ?? [],
  };
}

function idNum(id: string): number {
  const m = id.match(/^ADR-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

export async function listAll(): Promise<AdrSummary[]> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(ADRS_ROOT, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
  const out: AdrSummary[] = [];
  const seen = new Set<string>();
  // Folder layout first.
  for (const e of entries) {
    if (!e.isDir) continue;
    const m = e.name.match(ADR_FOLDER_RE);
    if (!m) continue;
    const id = "ADR-" + String(parseInt(m[1], 10)).padStart(3, "0");
    const paths = await findAdrPaths(id);
    if (!paths) continue;
    if (seen.has(id)) continue;
    let raw: string;
    try { raw = await readFile(paths.canonical, "utf8"); } catch { continue; }
    const parsed = parseAdr(raw);
    out.push(summary(parsed, paths.canonicalFilename));
    seen.add(id);
  }
  // Legacy flat — covers ADRs that haven't been migrated yet.
  for (const e of entries) {
    if (e.isDir) continue;
    if (!ADR_FILENAME_RE.test(e.name)) continue;
    const m = e.name.match(/^ADR-(\d+)/);
    if (!m) continue;
    const id = "ADR-" + String(parseInt(m[1], 10)).padStart(3, "0");
    if (seen.has(id)) continue;
    const raw = await readFile(join(ADRS_ROOT, e.name), "utf8");
    const parsed = parseAdr(raw);
    out.push(summary(parsed, e.name));
    seen.add(id);
  }
  out.sort((a, b) => idNum(a.id) - idNum(b.id));
  return out;
}

export async function readAdr(id: string): Promise<ParsedAdr | null> {
  const paths = await findAdrPaths(id);
  if (!paths) return null;
  const raw = await readFile(paths.canonical, "utf8");
  const parsed = parseAdr(raw);
  // Normalize version to a number on every read. The frontmatter parser
  // returns strings for scalars; consumers expect a number for arithmetic.
  const rawV = parsed.frontmatter.version;
  if (rawV === undefined || rawV === null) {
    parsed.frontmatter.version = 1;
  } else if (typeof rawV !== "number") {
    const n = parseInt(String(rawV), 10);
    parsed.frontmatter.version = Number.isFinite(n) ? n : 1;
  }
  return parsed;
}

export interface WriteAdrOptions {
  /** Snapshot the current canonical into versions/v{N}.md and increment frontmatter.version. */
  bump?: boolean;
  /** Note attached to the snapshot frontmatter (e.g. "enrichment-research", "transition-accepted"). */
  bumpReason?: string;
}

export async function writeAdr(id: string, parsed: ParsedAdr, opts: WriteAdrOptions = {}): Promise<void> {
  const paths = await findAdrPaths(id);
  if (!paths) throw new Error(`ADR ${id} not found`);
  if (paths.legacy) {
    // Legacy ADRs must be migrated before any bump can be recorded.
    if (opts.bump) {
      throw new Error(`ADR ${id} is in the legacy flat layout — migrate to folder layout before bumping versions`);
    }
    const serialized = serializeAdr(parsed);
    const tmp = paths.canonical + ".tmp";
    await writeFile(tmp, serialized, "utf8");
    await rename(tmp, paths.canonical);
    return;
  }
  if (opts.bump) {
    // Snapshot the PRIOR state before we overwrite. Read fresh from disk so
    // we never miss any concurrent edit that the in-memory `parsed` would
    // shadow. Then bump version in the new parsed payload before write.
    const priorRaw = await readFile(paths.canonical, "utf8");
    const prior = parseAdr(priorRaw);
    const rawPV = prior.frontmatter.version;
    const priorVersion = typeof rawPV === "number"
      ? rawPV
      : (parseInt(String(rawPV ?? 1), 10) || 1);
    await mkdir(paths.versionsDir, { recursive: true });
    const snapshotPath = join(paths.versionsDir, `v${priorVersion}.md`);
    const snapshotFrontmatter = {
      ...prior.frontmatter,
      snapshot_of: id,
      snapshot_version: priorVersion,
      snapshot_taken_at: new Date().toISOString(),
      snapshot_status: prior.frontmatter.status ?? "proposed",
      snapshot_reason: opts.bumpReason ?? "manual-bump",
    } as Record<string, unknown>;
    const snapshotSerialized = serializeAdr({ frontmatter: snapshotFrontmatter as AdrFrontmatter, body: prior.body });
    await writeFile(snapshotPath + ".tmp", snapshotSerialized, "utf8");
    await rename(snapshotPath + ".tmp", snapshotPath);
    parsed.frontmatter.version = priorVersion + 1;
  }
  const serialized = serializeAdr(parsed);
  const tmp = paths.canonical + ".tmp";
  await writeFile(tmp, serialized, "utf8");
  await rename(tmp, paths.canonical);
}

// Hard-delete: remove the entire ADR folder (folder layout) or the flat .md
// file (legacy layout). Destructive and irreversible — the UI gates it with a
// confirm modal. Returns the path removed for the caller's audit log.
export async function deleteAdr(id: string): Promise<{ path: string }> {
  const paths = await findAdrPaths(id);
  if (!paths) throw new Error(`ADR ${id} not found`);
  if (paths.legacy) {
    await unlink(paths.canonical);
    return { path: paths.canonical };
  }
  await rm(paths.folder, { recursive: true, force: true });
  return { path: paths.folder };
}

// ---------------------------------------------------------------------------
// Versions — list + read snapshots.
// ---------------------------------------------------------------------------

export interface VersionEntry {
  version: number;
  status_at_snapshot: AdrState;
  taken_at: string;
  reason: string;
}

export async function listVersions(id: string): Promise<VersionEntry[]> {
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) return [];
  let files: string[];
  try { files = await readdir(paths.versionsDir); } catch { return []; }
  const out: VersionEntry[] = [];
  for (const f of files) {
    const m = f.match(/^v(\d+)\.md$/);
    if (!m) continue;
    try {
      const raw = await readFile(join(paths.versionsDir, f), "utf8");
      const parsed = parseAdr(raw);
      const fm = parsed.frontmatter as Record<string, unknown>;
      out.push({
        version: parseInt(m[1], 10),
        status_at_snapshot: (fm.snapshot_status ?? fm.status ?? "proposed") as AdrState,
        taken_at: String(fm.snapshot_taken_at ?? fm.created ?? ""),
        reason: String(fm.snapshot_reason ?? "unknown"),
      });
    } catch { /* skip malformed */ }
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

export async function readVersionSnapshot(id: string, version: number): Promise<ParsedAdr | null> {
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) return null;
  const p = join(paths.versionsDir, `v${version}.md`);
  try {
    const raw = await readFile(p, "utf8");
    return parseAdr(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Comments — append-only jsonl, one row per comment, version-stamped.
// ---------------------------------------------------------------------------

export interface AdrComment {
  id: string;          // monotonic per-ADR — `${unix-ms}-${rand4}`
  version: number;     // canonical version at write time
  author: string;
  date: string;        // YYYY-MM-DD
  text: string;
}

export async function readComments(id: string): Promise<AdrComment[]> {
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) return [];
  let raw: string;
  try { raw = await readFile(paths.commentsFile, "utf8"); } catch { return []; }
  const out: AdrComment[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj.text === "string") out.push(obj as AdrComment);
    } catch { /* skip malformed */ }
  }
  return out;
}

export async function appendComment(id: string, author: string, text: string): Promise<AdrComment> {
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) {
    throw new Error(`ADR ${id} not found or legacy layout — migrate first`);
  }
  const parsed = await readAdr(id);
  if (!parsed) throw new Error(`ADR ${id} not found`);
  const rawV = parsed.frontmatter.version;
  const version = typeof rawV === "number" ? rawV : parseInt(String(rawV ?? 1), 10) || 1;
  const date = new Date().toISOString().slice(0, 10);
  const cid = `${Date.now()}-${Math.floor(Math.random() * 1e4).toString().padStart(4, "0")}`;
  const entry: AdrComment = { id: cid, version, author, date, text };
  const line = JSON.stringify(entry) + "\n";
  // Atomic append: read-then-write would race; node's appendFile semantics
  // are append-on-write so we use writeFile with {flag:'a'} — single syscall.
  await writeFile(paths.commentsFile, line, { flag: "a" });
  return entry;
}

// ---------------------------------------------------------------------------
// References — files under <folder>/references/ (markdown, pdf, txt, etc.).
// listReferences returns metadata only; readReference returns content.
// ---------------------------------------------------------------------------

export interface ReferenceEntry {
  filename: string;
  size: number;
  mtime: string;
}

export async function listReferences(id: string): Promise<ReferenceEntry[]> {
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) return [];
  let entries: string[];
  try { entries = await readdir(paths.referencesDir); } catch { return []; }
  const out: ReferenceEntry[] = [];
  for (const f of entries) {
    if (f.startsWith(".")) continue;
    try {
      const s = await stat(join(paths.referencesDir, f));
      if (!s.isFile()) continue;
      out.push({ filename: f, size: s.size, mtime: new Date(s.mtimeMs).toISOString() });
    } catch { /* skip */ }
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

export async function readReference(id: string, filename: string): Promise<string | null> {
  if (filename.includes("/") || filename.includes("..")) return null;
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) return null;
  const p = join(paths.referencesDir, filename);
  try { return await readFile(p, "utf8"); } catch { return null; }
}

export async function writeReference(id: string, filename: string, content: string): Promise<void> {
  if (filename.includes("/") || filename.includes("..")) {
    throw new Error("invalid reference filename");
  }
  const paths = await findAdrPaths(id);
  if (!paths || paths.legacy) {
    throw new Error(`ADR ${id} not found or legacy layout — migrate first`);
  }
  await mkdir(paths.referencesDir, { recursive: true });
  const p = join(paths.referencesDir, filename);
  await writeFile(p + ".tmp", content, "utf8");
  await rename(p + ".tmp", p);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function transitionAdr(
  id: string,
  to: AdrState,
  deciders: string[],
): Promise<void> {
  const parsed = await readAdr(id);
  if (!parsed) throw new Error(`ADR ${id} not found`);

  // Apply the caller-supplied deciders + status BEFORE validating, otherwise
  // an ADR that started with empty deciders can never reach `accepted` even
  // when the user explicitly provides them.
  if (deciders.length > 0) parsed.frontmatter.deciders = deciders;
  const from = (parsed.frontmatter.status ?? "proposed") as AdrState;
  parsed.frontmatter.status = to;
  if (to === "accepted" || to === "rejected") {
    parsed.frontmatter.decided = today();
  }

  // Pre-check: validateAdr P0 findings block the transition. P1/P2 are advisory.
  const findings = await validateAdrParsed(parsed);
  if (findings.p0.length > 0) {
    throw new Error(`validation P0: ${findings.p0.join("; ")}`);
  }

  const legal = LEGAL_TRANSITIONS[from] ?? [];
  if (!legal.includes(to)) {
    const legalStr = legal.length === 0 ? "none (terminal state)" : legal.join(", ");
    throw new Error(
      `illegal transition: ${id} is "${from}"; legal transitions are [${legalStr}]; attempted "${to}"`,
    );
  }
  // Status transitions are version-material — bump and snapshot the prior
  // state. Legacy ADRs (still in flat layout) bypass the bump per writeAdr.
  const paths = await findAdrPaths(id);
  const canBump = paths !== null && !paths.legacy;
  await writeAdr(id, parsed, canBump ? { bump: true, bumpReason: `transition-${to}` } : {});
}

export async function nextAdrId(): Promise<string> {
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(ADRS_ROOT, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return "ADR-001";
  }
  let max = 0;
  for (const e of entries) {
    if (e.isDir) {
      const m = e.name.match(ADR_FOLDER_RE);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
      continue;
    }
    const m = e.name.match(ADR_FILENAME_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return "ADR-" + String(max + 1).padStart(3, "0");
}

// ---------------------------------------------------------------------------
// validateAdr — pure read. Returns prioritized findings; never mutates.
// P0 blocks the next transition (caller's responsibility to refuse).
// P1 is reference drift (warn but proceed). P2 is body completeness advisory.
// Mirrors the adr-manager skill's `validate-adr` op.
// ---------------------------------------------------------------------------

export type ValidationFindings = {
  p0: string[];
  p1: string[];
  p2: string[];
};

const TERMINAL_DECISION_STATES: ReadonlySet<AdrState> = new Set(["accepted", "rejected"]);

async function ticketExists(id: string): Promise<boolean> {
  const found = await findTicket(id);
  return found !== null;
}

async function adrExists(id: string): Promise<boolean> {
  const found = await findAdrPaths(id);
  return found !== null;
}

async function validateAdrParsed(parsed: ParsedAdr): Promise<ValidationFindings> {
  const findings: ValidationFindings = { p0: [], p1: [], p2: [] };
  const fm = parsed.frontmatter;

  // --- Schema (P0) ---
  if (!fm.id) findings.p0.push("missing id");
  if (!fm.title) findings.p0.push("missing title");
  if (!fm.created) findings.p0.push("missing created");
  if (!fm.status || !ADR_STATES.includes(fm.status as AdrState)) {
    findings.p0.push(`invalid status: ${fm.status}`);
  }
  if (!Array.isArray(fm.deciders) || fm.deciders.length === 0) {
    findings.p0.push("deciders must be non-empty");
  }
  const status = fm.status as AdrState;
  const hasDecided = !!fm.decided;
  if (TERMINAL_DECISION_STATES.has(status) && !hasDecided) {
    findings.p0.push(`status=${status} requires decided date`);
  }
  if (!TERMINAL_DECISION_STATES.has(status) && status !== "superseded" && status !== "deprecated" && hasDecided) {
    findings.p0.push(`status=${status} must not have decided date`);
  }

  // --- FSM (P0) ---
  if (status === "superseded" && !fm.superseded_by) {
    findings.p0.push("status=superseded requires superseded_by");
  }
  if (status !== "superseded" && fm.superseded_by) {
    findings.p0.push(`superseded_by set but status=${status}`);
  }

  // --- References (P1) ---
  for (const sup of fm.supersedes ?? []) {
    if (!(await adrExists(sup))) findings.p1.push(`supersedes references missing ADR: ${sup}`);
  }
  if (fm.superseded_by && !(await adrExists(fm.superseded_by))) {
    findings.p1.push(`superseded_by references missing ADR: ${fm.superseded_by}`);
  }
  for (const tkt of fm.related_tickets ?? []) {
    if (!(await ticketExists(tkt))) findings.p1.push(`related_tickets references missing ticket: ${tkt}`);
  }
  for (const m of fm.materialized_tickets ?? []) {
    if (!(await ticketExists(m.ticket_id))) {
      findings.p1.push(`materialized_tickets references missing ticket: ${m.ticket_id}`);
    }
  }

  // --- Body (P2) ---
  const body = parsed.body;
  if (!/^###\s+TL;DR/m.test(body)) findings.p2.push("body missing ### TL;DR section");
  if (
    !/^###\s+Context/m.test(body) &&
    !/^###\s+Decision/m.test(body) &&
    !/^###\s+Consequences/m.test(body)
  ) {
    findings.p2.push("body missing all of Context/Decision/Consequences");
  }

  // --- Draft graph integrity (P0 for duplicates / unresolved deps) ---
  const drafts = fm.proposed_tickets ?? [];
  const draftIds = new Set<string>();
  for (const d of drafts) {
    if (draftIds.has(d.draft_id)) {
      findings.p0.push(`duplicate draft_id: ${d.draft_id}`);
    }
    draftIds.add(d.draft_id);
  }
  for (const d of drafts) {
    for (const dep of d.depends_on ?? []) {
      if (dep.startsWith("DRAFT-")) {
        if (!draftIds.has(dep)) findings.p0.push(`${d.draft_id}.depends_on references unknown draft ${dep}`);
      } else if (dep.startsWith("TKT-")) {
        if (!(await ticketExists(dep))) findings.p1.push(`${d.draft_id}.depends_on references missing ticket: ${dep}`);
      } else {
        findings.p0.push(`${d.draft_id}.depends_on entry "${dep}" must be DRAFT-N or TKT-NNN`);
      }
    }
  }

  return findings;
}

export async function validateAdr(id: string): Promise<ValidationFindings> {
  const parsed = await readAdr(id);
  if (!parsed) throw new Error(`ADR ${id} not found`);
  return validateAdrParsed(parsed);
}

// ---------------------------------------------------------------------------
// promoteDraftTickets — three-pass algorithm per ADR-001 §D5 and the
// adr-manager skill's `promote-draft-tickets` op. Auto-fired from the
// server's transition endpoint on proposed→accepted. Idempotent: warns and
// no-ops if materialized_tickets is already populated and proposed_tickets
// is empty.
// ---------------------------------------------------------------------------

export type PromoteResult = {
  minted: MaterializedTicket[];
  warning?: string;
};

export async function promoteDraftTickets(id: string): Promise<PromoteResult> {
  const parsed = await readAdr(id);
  if (!parsed) throw new Error(`ADR ${id} not found`);
  const fm = parsed.frontmatter;

  const drafts = fm.proposed_tickets ?? [];
  const already = fm.materialized_tickets ?? [];

  if (drafts.length === 0) {
    if (already.length > 0) {
      return { minted: [], warning: `ADR ${id} already promoted (${already.length} materialized; 0 drafts pending)` };
    }
    return { minted: [], warning: `ADR ${id} has no proposed_tickets to promote` };
  }

  const adrTitle = String(fm.title ?? id);
  const adrDomain = String(fm.domain ?? "meta");

  // Pass 1: mint a ticket per draft. Track the mapping.
  const mapping: MaterializedTicket[] = [];
  const minted: { ticketId: string; bucket: string }[] = [];
  try {
    for (const draft of drafts) {
      const body = buildPromotedTicketBody(id, adrTitle, draft);
      const draftDomain = String((draft as Record<string, unknown>).domain ?? adrDomain);
      const t = await createTicket({
        title: draft.title,
        domain: draftDomain,
        bucket: "0-backlog",
        body,
        tags: ["adr-promoted"],
      });
      mapping.push({ draft_id: draft.draft_id, ticket_id: t.id });
      minted.push({ ticketId: t.id, bucket: "0-backlog" });

      // Stamp implements_adr on the freshly minted ticket frontmatter so the
      // link is recorded from day 1 (singular, per ADR-001 §D6).
      const fresh = await readTicket(t.id);
      if (fresh) {
        fresh.frontmatter.implements_adr = id;
        await writeTicket(t.id, fresh.frontmatter, fresh.body);
      }
    }
  } catch (e) {
    // Roll back any minted tickets to 7-archive with failed_promotion stamp.
    for (const m of minted) {
      try {
        const tkt = await readTicket(m.ticketId);
        if (tkt) {
          tkt.frontmatter.failed_promotion = id;
          await writeTicket(m.ticketId, tkt.frontmatter, tkt.body);
        }
        await moveTicket(m.ticketId, "7-archive");
      } catch {
        // best-effort rollback
      }
    }
    throw new Error(`promote-draft-tickets failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Pass 2: resolve DRAFT-N depends_on to the freshly minted TKT-NNN.
  const draftToTicket = new Map(mapping.map((m) => [m.draft_id, m.ticket_id]));
  for (const draft of drafts) {
    const deps = draft.depends_on ?? [];
    if (deps.length === 0) continue;
    const ticketId = draftToTicket.get(draft.draft_id)!;
    const resolved: string[] = [];
    for (const dep of deps) {
      if (dep.startsWith("DRAFT-")) {
        const tkt = draftToTicket.get(dep);
        if (tkt) resolved.push(tkt);
      } else {
        // TKT-NNN entries preserved unchanged.
        resolved.push(dep);
      }
    }
    if (resolved.length > 0) {
      const tkt = await readTicket(ticketId);
      if (tkt) {
        const existing = Array.isArray(tkt.frontmatter.depends_on) ? tkt.frontmatter.depends_on : [];
        const merged = Array.from(new Set([...existing, ...resolved]));
        tkt.frontmatter.depends_on = merged;
        await writeTicket(ticketId, tkt.frontmatter, tkt.body);
      }
    }
  }

  // Pass 3: replace proposed_tickets with materialized_tickets on the ADR;
  // append the new ticket IDs to related_tickets so the ADR ↔ ticket edge
  // is captured in the canonical place.
  const fresh = await readAdr(id);
  if (!fresh) throw new Error(`ADR ${id} disappeared mid-promote`);
  delete (fresh.frontmatter as Record<string, unknown>).proposed_tickets;
  fresh.frontmatter.materialized_tickets = [...already, ...mapping];
  const existingRelated = fresh.frontmatter.related_tickets ?? [];
  const mergedRelated = Array.from(new Set([...existingRelated, ...mapping.map((m) => m.ticket_id)]));
  fresh.frontmatter.related_tickets = mergedRelated;
  await writeAdr(id, fresh);

  return { minted: mapping };
}

function buildPromotedTicketBody(adrId: string, adrTitle: string, draft: DraftTicket): string {
  return `### Objective
${draft.title}

### Context
This ticket implements ${adrId} ("${adrTitle}"). See \`.tickets/ADRs/\` for the full architectural decision. This stub was auto-minted by \`promoteDraftTickets\` and needs the standard refinement pass (Objective tightening, Context citations, Acceptance Criteria) before staging.

### Acceptance Criteria

- [ ] AC pass after refinement.
`;
}

// ---------------------------------------------------------------------------
// mirrorSupersedes — when ADR-B is created with supersedes:[ADR-A], atomically
// flip ADR-A.status to "superseded" and set ADR-A.superseded_by = ADR-B.
// Refuses if ADR-A is in a terminal-rejected state. Idempotent: no-op if the
// mirror is already correct.
// ---------------------------------------------------------------------------

export async function mirrorSupersedes(newAdrId: string, supersededIds: string[]): Promise<void> {
  for (const oldId of supersededIds) {
    const parsed = await readAdr(oldId);
    if (!parsed) throw new Error(`mirrorSupersedes: ${oldId} not found`);
    const currentStatus = (parsed.frontmatter.status ?? "proposed") as AdrState;
    if (currentStatus === "rejected") {
      throw new Error(`mirrorSupersedes: cannot supersede rejected ADR ${oldId}`);
    }
    if (currentStatus === "superseded" && parsed.frontmatter.superseded_by === newAdrId) {
      continue; // idempotent no-op
    }
    parsed.frontmatter.status = "superseded";
    parsed.frontmatter.superseded_by = newAdrId;
    if (!parsed.frontmatter.decided) {
      parsed.frontmatter.decided = today();
    }
    await writeAdr(oldId, parsed);
  }
}

// Exported for the smoke-test harness; not part of the public API surface
// but needed so the test can construct a parsed-shape without re-reading.
export { validateAdrParsed, TICKETS_ROOT, unlink };
