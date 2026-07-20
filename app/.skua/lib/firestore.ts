// Optional Firestore mirror of the ticket board — the deterministic core.
//
// Reflects each ticket's current status + metadata into a Firestore collection so
// the board can be watched from OUTSIDE the repo (a phone, a shared dashboard, a
// cron report). Zero-dependency by design: mints an access token from your local
// Google Application Default Credentials and talks to the Firestore REST API with
// `fetch` — no firebase-admin, no @google-cloud/firestore. This mirrors skua's
// "zero-dep until opted in" rule (the same way smoke only adds Playwright on
// opt-in).
//
// Opt-in and graceful: with no `firestore` block in skua.config.json (or
// SKUA_FIRESTORE_DISABLE=1) every entry point is a silent no-op, and every
// network path is wrapped so a sync hiccup can NEVER throw into a ticket op.
//
// Two shapes, one source of truth (the same buildDoc → identical hashes, so the
// layers never thrash):
//   syncTicketSafe(id)  — upsert one doc (real-time; fired from the tickets.ts
//                         mutators, so dashboard + chaos + auto-archive + ADR
//                         moves all mirror live, since they all funnel through
//                         moveTicket/writeTicket).
//   syncBoardSafe()     — scan every bucket and batch-upsert only the docs whose
//                         content changed (convergent reconcile; fired from the
//                         dashboard poll, the chaos loop, and the Stop hook —
//                         closes the interactive raw-`mv` gap and self-heals any
//                         missed event).
//
// A local hash cache (.skua/cache/firestore/sync-state.json) means a reconcile
// only writes the docs that actually changed. Credentials are NEVER stored in
// config or git — they come from ADC at runtime.

import { readdir, readFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import {
  FIRESTORE,
  FIRESTORE_CACHE_DIR,
  FIRESTORE_LOG,
  FIRESTORE_TOKEN_CACHE,
  FIRESTORE_SYNC_STATE,
  TICKETS_ROOT,
  type FirestoreConfig,
} from "../skua.config.ts";
import { parse, type Frontmatter } from "./frontmatter.ts";
import {
  BUCKETS,
  STATUS_FOR_BUCKET,
  resolveNextStepHint,
  findTicket,
  type Bucket,
} from "./tickets.ts";

// Non-null accessor — every helper below is only reached after a firestoreConfigured() guard.
const C = (): FirestoreConfig => FIRESTORE as FirestoreConfig;

/** The mirror is active iff a `firestore` block declared a projectId AND it isn't
 *  disabled. Every public entry point no-ops when this is false. */
export function firestoreConfigured(): boolean {
  return FIRESTORE !== null && process.env.SKUA_FIRESTORE_DISABLE !== "1";
}

// ── logging (best-effort; never throws) ──────────────────────────────────────
function logLine(msg: string): void {
  try {
    mkdirSync(FIRESTORE_CACHE_DIR, { recursive: true });
    appendFileSync(FIRESTORE_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never throw into a ticket op */
  }
}

// ── access token from local Application Default Credentials ───────────────────
// Two zero-dep paths, tried in order:
//   1. the ADC file's refresh_token exchanged at the OAuth endpoint (pure fetch,
//      non-blocking) — covers `gcloud auth application-default login` (user creds).
//   2. `gcloud auth application-default print-access-token` (async subprocess) —
//      covers service-account / impersonated / GCE-metadata ADC the file path
//      can't sign locally.
// Tokens live ~1h; cache in-memory + on disk and refresh at ~50 min.
type TokenCache = { token: string; expiresAt: number };
let memToken: TokenCache | null = null;

async function mintToken(): Promise<string | null> {
  const now = Date.now();
  if (memToken && memToken.expiresAt - 60_000 > now) return memToken.token;
  try {
    if (existsSync(FIRESTORE_TOKEN_CACHE)) {
      const c = JSON.parse(readFileSync(FIRESTORE_TOKEN_CACHE, "utf8")) as TokenCache;
      if (c && c.token && c.expiresAt - 60_000 > now) {
        memToken = c;
        return c.token;
      }
    }
  } catch {
    /* corrupt cache — re-mint */
  }
  // Try, in order: ADC user creds (pure-fetch refresh, then via gcloud), then the
  // ACTIVE gcloud account (service account or user). The last covers a machine
  // whose ADC is stale but that has an activated service account (common on
  // servers/backends) — so the mirror "just works" with whatever local Google
  // credential can actually mint a token.
  const minted =
    (await tokenFromAdcFile()) ??
    (await gcloudToken(["auth", "application-default", "print-access-token"])) ??
    (await gcloudToken(["auth", "print-access-token"]));
  if (!minted) {
    logLine("token: could not mint an access token — run `gcloud auth application-default login` (or activate a service account)");
    return null;
  }
  memToken = minted;
  try {
    mkdirSync(FIRESTORE_CACHE_DIR, { recursive: true });
    writeFileSync(FIRESTORE_TOKEN_CACHE, JSON.stringify(minted), { mode: 0o600 });
  } catch {
    /* cache best-effort */
  }
  return minted.token;
}

async function tokenFromAdcFile(): Promise<TokenCache | null> {
  try {
    const path =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(homedir(), ".config", "gcloud", "application_default_credentials.json");
    if (!existsSync(path)) return null;
    const cred = JSON.parse(readFileSync(path, "utf8")) as {
      type?: string;
      client_id?: string;
      client_secret?: string;
      refresh_token?: string;
    };
    // Only user ADC can be refreshed with pure fetch; service-account keys need
    // local JWT signing → fall through to gcloud.
    if (
      cred.type !== "authorized_user" ||
      !cred.refresh_token ||
      !cred.client_id ||
      !cred.client_secret
    ) {
      return null;
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cred.client_id,
        client_secret: cred.client_secret,
        refresh_token: cred.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logLine(`token(adc): ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    const ttlMs = (j.expires_in ?? 3600) * 1000;
    return { token: j.access_token, expiresAt: Date.now() + Math.min(ttlMs, 50 * 60_000) };
  } catch (e) {
    logLine(`token(adc) error: ${(e as Error).message}`);
    return null;
  }
}

// Mint a token via the gcloud CLI. `args` selects the identity:
//   ["auth","application-default","print-access-token"] → ADC
//   ["auth","print-access-token"]                        → the ACTIVE account
async function gcloudToken(args: string[]): Promise<TokenCache | null> {
  try {
    if (typeof Bun === "undefined") return null;
    const proc = Bun.spawn(["gcloud", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    // gcloud can wedge (a re-auth prompt, a hung metadata server). Every fetch in
    // this file is timeout-guarded; bound the subprocess the same way, and drain
    // BOTH pipes so a chatty stderr can't fill its buffer and block us.
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 15_000);
    const [out] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (proc.exitCode !== 0) return null;
    const token = out.trim();
    if (!token) return null;
    return { token, expiresAt: Date.now() + 50 * 60_000 };
  } catch {
    return null;
  }
}

// ── Firestore REST plumbing ──────────────────────────────────────────────────
function baseUrl(): string {
  const c = C();
  return `https://firestore.googleapis.com/v1/projects/${c.projectId}/databases/${c.database}/documents`;
}
function docName(docId: string): string {
  const c = C();
  return `projects/${c.projectId}/databases/${c.database}/documents/${c.collection}/${docId}`;
}
function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    // Attribute quota to the project — user ADC needs this or Firestore returns a
    // "user project" error; harmless for service-account creds.
    "x-goog-user-project": C().projectId,
  };
}
function docIdFor(ticketId: string): string {
  return `${C().board}__${ticketId}`.replace(/\//g, "_");
}

// JS value → Firestore typed Value. Numbers split int/double; arrays recurse;
// null/undefined → nullValue so a full-snapshot write always clears absent fields.
function encodeValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { stringValue: String(v) };
}

// ── ticket → document ────────────────────────────────────────────────────────
type TicketDoc = {
  docId: string;
  board: string;
  ticketId: string;
  title: string;
  status: string;
  bucket: string;
  priority: string;
  domain: string;
  complexity: number | null;
  tags: string[];
  depends_on: string[];
  blocks: string[];
  related: string[];
  files_touched: string[];
  implements_adr: string | null;
  next_step_hint: string;
  created: string | null;
  completed: string | null;
  chaos_branch: string | null;
  merged: string | null;
  merge_conflict: string | null;
};

const TKT_RE = /^TKT-(\d+)-.*\.md$/;

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Build the SAME document from frontmatter regardless of trigger (single or
// board), so a ticket's content hash is stable across every sync path.
function buildDoc(fm: Frontmatter, bucket: Bucket, filename: string, body: string): TicketDoc {
  const m = filename.match(TKT_RE);
  const idStr = str(fm.id);
  const ticketId = idStr ?? (m ? `TKT-${m[1]}` : filename.replace(/\.md$/, ""));
  // Shared with the dashboard's own view (tickets.ts) so the mirrored hint — and
  // therefore the content hash — can never drift from what the board shows.
  const nextStep = resolveNextStepHint(fm, bucket, body);
  return {
    docId: docIdFor(ticketId),
    board: C().board,
    ticketId,
    title: str(fm.title) ?? "(untitled)",
    status: str(fm.status) ?? STATUS_FOR_BUCKET[bucket],
    bucket,
    priority: str(fm.priority) ?? "Medium",
    domain: str(fm.domain) ?? "meta",
    complexity: num(fm.complexity),
    tags: asStrArray(fm.tags),
    depends_on: asStrArray(fm.depends_on),
    blocks: asStrArray(fm.blocks),
    related: asStrArray(fm.related),
    files_touched: asStrArray(fm.files_touched),
    implements_adr: str(fm.implements_adr),
    next_step_hint: nextStep,
    created: str(fm.created),
    completed: str(fm.completed),
    chaos_branch: str(fm.chaos_branch),
    merged: str(fm.merged),
    merge_conflict: str(fm.merge_conflict),
  };
}

// Full-snapshot fields (every field always present so merge-vs-replace doesn't
// matter). `syncedAt` is a wall-clock freshness stamp — deliberately NOT part of
// the content hash, so an unchanged ticket is never re-written.
function docFields(d: TicketDoc): Record<string, unknown> {
  return {
    board: encodeValue(d.board),
    ticketId: encodeValue(d.ticketId),
    title: encodeValue(d.title),
    status: encodeValue(d.status),
    bucket: encodeValue(d.bucket),
    priority: encodeValue(d.priority),
    domain: encodeValue(d.domain),
    complexity: encodeValue(d.complexity),
    tags: encodeValue(d.tags),
    depends_on: encodeValue(d.depends_on),
    blocks: encodeValue(d.blocks),
    related: encodeValue(d.related),
    files_touched: encodeValue(d.files_touched),
    implements_adr: encodeValue(d.implements_adr),
    next_step_hint: encodeValue(d.next_step_hint),
    created: encodeValue(d.created),
    completed: encodeValue(d.completed),
    chaos_branch: encodeValue(d.chaos_branch),
    merged: encodeValue(d.merged),
    merge_conflict: encodeValue(d.merge_conflict),
    syncedAt: { timestampValue: new Date().toISOString() },
  };
}

function hashDoc(d: TicketDoc): string {
  return createHash("sha256").update(JSON.stringify(d)).digest("hex").slice(0, 16);
}

// ── local hash cache (skip unchanged writes) ─────────────────────────────────
let syncState: Record<string, string> | null = null;
function state(): Record<string, string> {
  if (syncState) return syncState;
  try {
    syncState = JSON.parse(readFileSync(FIRESTORE_SYNC_STATE, "utf8")) as Record<string, string>;
  } catch {
    syncState = {};
  }
  return syncState;
}
function persistState(): void {
  try {
    mkdirSync(FIRESTORE_CACHE_DIR, { recursive: true });
    writeFileSync(FIRESTORE_SYNC_STATE, JSON.stringify(state()));
  } catch {
    /* best-effort */
  }
}

// ── writes ───────────────────────────────────────────────────────────────────
async function upsertDoc(token: string, d: TicketDoc): Promise<boolean> {
  const h = hashDoc(d);
  if (state()[d.docId] === h) return false; // unchanged — skip the write
  const url = `${baseUrl()}/${C().collection}/${encodeURIComponent(d.docId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ fields: docFields(d) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PATCH ${d.docId} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  state()[d.docId] = h;
  persistState();
  return true;
}

async function deleteDoc(token: string, docId: string): Promise<void> {
  const url = `${baseUrl()}/${C().collection}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${docId} → ${res.status}`);
  delete state()[docId];
  persistState();
}

async function batchWrite(token: string, docs: TicketDoc[], deleteIds: string[]): Promise<void> {
  const writes: unknown[] = [];
  for (const d of docs) writes.push({ update: { name: docName(d.docId), fields: docFields(d) } });
  for (const id of deleteIds) writes.push({ delete: docName(id) });
  // batchWrite caps at 500 non-transactional writes per call — chunk at 400.
  for (let i = 0; i < writes.length; i += 400) {
    const chunk = writes.slice(i, i + 400);
    const res = await fetch(`${baseUrl()}:batchWrite`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ writes: chunk }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`batchWrite → ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

async function scanBoard(): Promise<TicketDoc[]> {
  const docs: TicketDoc[] = [];
  for (const bucket of BUCKETS) {
    const dir = join(TICKETS_ROOT, bucket);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const filename of entries) {
      if (!TKT_RE.test(filename)) continue;
      try {
        const raw = await readFile(join(dir, filename), "utf8");
        const parsed = parse(raw);
        docs.push(buildDoc(parsed.frontmatter, bucket, filename, parsed.body));
      } catch {
        /* skip unreadable/corrupt ticket — the next reconcile retries */
      }
    }
  }
  return docs;
}

// ── awaited cores ────────────────────────────────────────────────────────────
async function syncTicket(id: string): Promise<void> {
  const token = await mintToken();
  if (!token) return;
  const found = await findTicket(id);
  if (!found) {
    // ticket no longer on disk → mirror the deletion
    await deleteDoc(token, docIdFor(id));
    return;
  }
  const parsed = parse(found.raw);
  const filename = found.path.split("/").pop() ?? `${id}.md`;
  const doc = buildDoc(parsed.frontmatter, found.bucket, filename, parsed.body);
  await upsertDoc(token, doc);
}

export type SyncBoardResult = { total: number; written: number; deleted: number };

async function syncBoardCore(): Promise<SyncBoardResult> {
  const token = await mintToken();
  if (!token) return { total: 0, written: 0, deleted: 0 };
  const docs = await scanBoard();
  const s = state();
  const seen = new Set<string>();
  const changed: TicketDoc[] = [];
  const hashes = new Map<string, string>(); // computed once, reused on write-back
  for (const d of docs) {
    seen.add(d.docId);
    const h = hashDoc(d);
    hashes.set(d.docId, h);
    if (s[d.docId] !== h) changed.push(d);
  }
  const toDelete = C().prune ? Object.keys(s).filter((id) => !seen.has(id)) : [];
  if (changed.length || toDelete.length) {
    await batchWrite(token, changed, toDelete);
    for (const d of changed) s[d.docId] = hashes.get(d.docId)!;
    for (const id of toDelete) delete s[id];
    persistState();
  }
  return { total: docs.length, written: changed.length, deleted: toDelete.length };
}

// ── public, failure-isolated wrappers ────────────────────────────────────────
/** Fire-and-forget single-ticket upsert. Never throws — safe to call un-awaited
 *  from the tickets.ts mutators. No-op when the mirror is off. */
export async function syncTicketSafe(id: string): Promise<void> {
  if (!firestoreConfigured()) return;
  try {
    await syncTicket(id);
  } catch (e) {
    logLine(`syncTicket ${id}: ${(e as Error).message}`);
  }
}

/** Fire-and-forget delete of a ticket's mirror doc. Never throws. */
export async function deleteTicketDocSafe(id: string): Promise<void> {
  if (!firestoreConfigured()) return;
  try {
    const token = await mintToken();
    if (!token) return;
    await deleteDoc(token, docIdFor(id));
  } catch (e) {
    logLine(`deleteTicketDoc ${id}: ${(e as Error).message}`);
  }
}

let lastBoardSync = 0;
/** Convergent full-board reconcile. Never throws. `minIntervalMs` throttles the
 *  hot path (the dashboard's 5s poll); `force` bypasses it (CLI / hook / chaos). */
export async function syncBoardSafe(
  opts: { force?: boolean; minIntervalMs?: number } = {},
): Promise<SyncBoardResult | null> {
  if (!firestoreConfigured()) return null;
  const min = opts.minIntervalMs ?? 0;
  const nowMs = Date.now();
  if (!opts.force && min > 0 && nowMs - lastBoardSync < min) return null;
  lastBoardSync = nowMs;
  try {
    return await syncBoardCore();
  } catch (e) {
    logLine(`syncBoard: ${(e as Error).message}`);
    return null;
  }
}

// ── CLI support (status / test) ──────────────────────────────────────────────
/** For `firestore status`: resolved config + whether a token can be minted +
 *  cached-doc count. Does not touch the board. */
export async function firestoreStatus(): Promise<{
  configured: boolean;
  config: FirestoreConfig | null;
  tokenOk: boolean;
  cachedDocs: number;
  disabled: boolean;
}> {
  const disabled = process.env.SKUA_FIRESTORE_DISABLE === "1";
  if (FIRESTORE === null) {
    return { configured: false, config: null, tokenOk: false, cachedDocs: 0, disabled };
  }
  let tokenOk = false;
  try {
    tokenOk = (await mintToken()) !== null;
  } catch {
    tokenOk = false;
  }
  return {
    configured: firestoreConfigured(),
    config: FIRESTORE,
    tokenOk,
    cachedDocs: Object.keys(state()).length,
    disabled,
  };
}

/** For `firestore test`: write a probe doc, then delete it — proves the
 *  credentials + project + database + IAM role all work end to end. Throws with a
 *  useful message on failure (the CLI turns that into remediation). */
export async function firestoreProbe(): Promise<void> {
  const token = await mintToken();
  if (!token) {
    throw new Error(
      "no access token from local Google credentials — run `gcloud auth application-default login`, or activate a service account (gcloud auth activate-service-account)",
    );
  }
  const docId = "_skua_probe";
  const url = `${baseUrl()}/${C().collection}/${encodeURIComponent(docId)}`;
  const put = await fetch(url, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({
      fields: { probe: { booleanValue: true }, at: { timestampValue: new Date().toISOString() } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!put.ok) throw new Error(`write probe → ${put.status} ${(await put.text()).slice(0, 300)}`);
  const del = await fetch(url, {
    method: "DELETE",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(10_000),
  });
  if (!del.ok && del.status !== 404) throw new Error(`delete probe → ${del.status}`);
}
