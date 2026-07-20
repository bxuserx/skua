import { join, resolve, sep } from "node:path";
import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PORT, REPO_ROOT } from "./skua.config.ts";
import {
  BUCKETS,
  listAll,
  listBucket,
  readTicket,
  writeTicket,
  moveTicket,
  createTicket,
  deleteTicket,
  findTicket,
  archiveStaleComplete,
  type Bucket,
} from "./lib/tickets.ts";
import type { Frontmatter } from "./lib/frontmatter.ts";
import { buildTicketGraph } from "./lib/graphs/tickets.ts";
import { buildDataflowGraph } from "./lib/graphs/dataflow.ts";
import { buildSchemasGraph } from "./lib/graphs/schemas.ts";
import { buildAiGraph, aiSourceMtimes } from "./lib/graphs/ai.ts";
import {
  ADR_STATES,
  ADRS_ROOT,
  listAll as listAllAdrs,
  readAdr,
  writeAdr,
  deleteAdr,
  transitionAdr,
  promoteDraftTickets,
  mirrorSupersedes,
  validateAdr,
  nextAdrId,
  listVersions,
  readVersionSnapshot,
  readComments,
  appendComment,
  listReferences,
  readReference,
  writeReference,
  type AdrState,
  type ParsedAdr,
} from "./lib/adrs.ts";
import { listSessions, createSession, killSession, readLive, readLastCommand, renameSession, reorderSessions, killAllSessions } from "./lib/terminals.ts";
import { runSearch, SEARCH_ROOT } from "./lib/search.ts";
import { activeRuns } from "./lib/chaos.ts";
import { syncBoardSafe } from "./lib/firestore.ts";

type GraphKind = "tickets" | "dataflow" | "schemas" | "adrs" | "ai";

const ROOT = import.meta.dir;
const PUBLIC = join(ROOT, "public");
const CACHE = join(ROOT, "cache");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// Security headers — defense-in-depth on top of the per-sink HTML escaping.
// The app is localhost-only and single-user but renders user-authored
// ticket/ADR content. 'unsafe-inline' stays in script-src because every page
// inlines a tiny theme-bootstrap <script> in its <head> to avoid a FOUC; the
// primary XSS defense is escaping + the markdown link-scheme allowlist, not
// this CSP. The CSP still blocks external script/connect origins, plugins,
// framing, and <base> injection.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");
const NOSNIFF = { "x-content-type-options": "nosniff" };
const HTML_HEADERS = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  ...NOSNIFF,
};

// terminal.html frames the terminal surface in an <iframe>. That surface is now
// skua's own xterm.js client (terminal-xterm.html), served same-origin, so this
// variant just needs `frame-src 'self'`. The localhost ports stay allowed too
// (harmless; keeps direct-ttyd framing working as a fallback). Scoped to
// terminal.html only (see serveStatic).
const TERMINAL_HTML_HEADERS = {
  "content-security-policy":
    CSP + "; frame-src 'self' http://127.0.0.1:* http://localhost:*",
  "referrer-policy": "no-referrer",
  ...NOSNIFF,
};

// The framed client (terminal-xterm.html) opens a WebSocket straight to the
// session's ttyd port — a different localhost origin — and is itself framed by
// terminal.html. The default `default-src 'self'` would block both, so this
// variant widens connect-src to any localhost ws:// and allows same-origin
// framing. Built fresh (not appended to CSP) because a second `frame-ancestors`
// directive is ignored — the base CSP already pins it to 'none'.
const TERMINAL_XTERM_HTML_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
    "frame-ancestors 'self'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  ...NOSNIFF,
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...NOSNIFF },
  });

const err = (msg: string, status = 400) => json({ error: msg }, status);

const NAV_ITEMS: ReadonlyArray<{ key: string; href: string; label: string }> = [
  { key: "terminal", href: "/terminal", label: ">_" },
  { key: "board", href: "/", label: "board" },
  { key: "graphs", href: "/graphs/dataflow", label: "graphs" },
  { key: "adrs", href: "/adrs", label: "adrs" },
];

function renderNavLinks(active: string): string {
  return NAV_ITEMS.map(({ key, href, label }) => {
    const cls = key === active ? ' class="active"' : "";
    return `<a href="${href}"${cls}>${label}</a>`;
  }).join("\n                ");
}

// Single source of truth for the dashboard's top navbar. Emits the entire
// `<header class="top">` block — nav links + search + theme toggle + help
// button — so every view renders an identical bar. `withStatus` adds the
// ticket-only save-status slot (#status, read by ticket-edit.js).
function renderNavbar(active: string, withStatus: boolean): string {
  const statusSlot = withStatus
    ? `<span id="status" class="status"></span>\n                `
    : "";
  return `<header class="top">
            <nav>
                ${renderNavLinks(active)}
            </nav>
            <div class="top-actions">
                ${statusSlot}<div class="navbar-search-wrap">
                    <input
                        type="search"
                        id="navbar-search"
                        placeholder="search tickets — id or title"
                        autocomplete="off"
                        spellcheck="false"
                    />
                </div>
                <button
                    id="theme-toggle"
                    class="how-to-btn theme-toggle-btn"
                    type="button"
                    aria-label="Toggle theme"
                    title="Toggle theme"
                >
                    ☾
                </button>
                <button
                    id="howto-btn"
                    class="how-to-btn"
                    type="button"
                    title="How to use this dashboard"
                >
                    ?
                </button>
            </div>
        </header>
        <div id="chaos-banner" class="chaos-banner" hidden></div>
        <script type="module" src="/chaos-banner.js"></script>`;
}

// Full-navbar marker. Optional `status` token adds the ticket save-status slot.
const NAVBAR_MARKER_RE =
  /<!--\s*skua:navbar(?:\s+active="([\w-]*)")?(?:\s+(status))?\s*-->/g;
// How-to modal marker — replaced with the shared howto-modal.html partial.
const HOWTO_MARKER_RE = /<!--\s*skua:howto-modal\s*-->/g;
const HOWTO_PARTIAL = join(PUBLIC, "howto-modal.html");

async function renderHowtoModal(): Promise<string> {
  try {
    return (await readFile(HOWTO_PARTIAL)).toString("utf8");
  } catch {
    return "";
  }
}

async function serveStatic(path: string): Promise<Response> {
  const full = join(PUBLIC, path);
  if (!full.startsWith(PUBLIC))
    return new Response("forbidden", { status: 403 });
  try {
    const buf = await readFile(full);
    const ext = "." + (path.split(".").pop() ?? "");
    if (ext === ".html") {
      let html = buf.toString("utf8");
      html = html.replace(NAVBAR_MARKER_RE, (_m, active, status) =>
        renderNavbar(active ?? "", status === "status"),
      );
      const modal = await renderHowtoModal();
      html = html.replace(HOWTO_MARKER_RE, () => modal);
      const htmlHeaders =
        path === "terminal.html"
          ? TERMINAL_HTML_HEADERS
          : path === "terminal-xterm.html"
            ? TERMINAL_XTERM_HTML_HEADERS
            : HTML_HEADERS;
      return new Response(html, {
        headers: {
          "content-type": MIME[ext],
          "cache-control": "no-store",
          ...htmlHeaders,
        },
      });
    }
    return new Response(buf, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
        ...NOSNIFF,
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

const PROJECT_ROOT = REPO_ROOT;

const IGNORE_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".next",
  ".git",
  ".venv",
  "venv",
  "dist",
  "build",
]);

// Build a safe editor command that opens a repo file (from a search result) at a
// line — used by the terminal "Search" tab's click-to-open. The path is validated
// to live inside the repo AND to exist, then made absolute + single-quoted, so the
// string can be typed into a shell with no traversal and no injection. vim matches
// the terminal's vim-centric workflow and its `+N` jumps to the line; swap the
// binary here to use a different editor (e.g. `code -g <file>:<line>`).
async function buildOpenCommand(relPath: unknown, line: number | null): Promise<string> {
  const clean = String(relPath ?? "").replace(/^\/+/, "");
  if (!clean) throw new Error("path required");
  const rootResolved = resolve(PROJECT_ROOT);
  const resolved = resolve(PROJECT_ROOT, clean);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error("path outside repo");
  }
  const st = await stat(resolved).catch(() => null);
  if (!st || !st.isFile()) throw new Error("file not found");
  const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const at = line && line > 0 ? `+${Math.floor(line)} ` : "";
  // Editor preference: neovim is skua's DEFAULT (the skua-vim-setup skill ships
  // its nvim config — neo-tree file browser, gitsigns, nord + the theme switcher).
  // Fall back to MacVim's GUI (mvim), then plain vim, so click-to-open still works
  // where nvim isn't installed. nvim/mvim/vim all accept `+N -- <file>`. (Bun.which
  // sees the SERVER's PATH — possibly narrower than the login shell's — so also
  // probe the usual Homebrew/local paths; a false negative only means a fallback.)
  const has = (bin: string, extra: string[]) =>
    Bun.which(bin) !== null || extra.some((p) => existsSync(p));
  const editor =
    has("nvim", ["/opt/homebrew/bin/nvim", "/usr/local/bin/nvim"]) ? "nvim"
    : has("mvim", ["/opt/homebrew/bin/mvim", "/usr/local/bin/mvim"]) ? "mvim"
    : "vim";
  return `${editor} ${at}-- ${shq(resolved)}`;
}

// Coerce a JSON `line` field to a positive int, else null.
function parseLine(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

async function newestMtime(
  rootRel: string,
  predicate: (path: string) => boolean,
): Promise<number> {
  const root = join(PROJECT_ROOT, rootRel);
  let newest = 0;
  const walk = async (dir: string) => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile() && predicate(full)) {
        try {
          const s = await stat(full);
          if (s.mtimeMs > newest) newest = s.mtimeMs;
        } catch {
          // skip
        }
      }
    }
  };
  await walk(root);
  return newest;
}

async function newestSourceMtime(kind: GraphKind): Promise<number> {
  if (kind === "tickets") {
    return newestMtime(".tickets", (p) => /TKT-\d+.*\.md$/.test(p));
  }
  if (kind === "dataflow" || kind === "schemas") {
    // Both builders introspect the project source tree (routes, server
    // actions, DB collection/table usage). Invalidate the cache whenever any
    // source file changes; rarer deploy/config edits (Dockerfile, schema.prisma)
    // are picked up via the `rebuild` button.
    return newestMtime(".", (p) => /\.(ts|tsx|js|jsx)$/.test(p));
  }
  if (kind === "ai") {
    return aiSourceMtimes();
  }
  if (kind === "adrs") {
    // ADR cache invalidates on ADR file edits OR ticket edits (implements_adr
    // edges depend on ticket frontmatter).
    const [adrMtime, ticketMtime] = await Promise.all([
      newestMtime(".tickets/ADRs", (p) => /ADR-\d+.*\.md$/.test(p)),
      newestMtime(".tickets", (p) => /TKT-\d+.*\.md$/.test(p)),
    ]);
    return Math.max(adrMtime, ticketMtime);
  }
  return 0;
}

async function readCachedOrBuild(
  kind: GraphKind,
  rebuild: boolean,
  live = false,
): Promise<unknown> {
  // Live mode (schemas ?live=1) always builds fresh against the real database
  // and is never served from — or written to — the static cache, so the fast
  // offline default stays intact.
  if (kind === "schemas" && live) {
    return await buildSchemasGraph({ live: true });
  }
  const file = join(CACHE, `${kind}-graph.json`);
  if (!rebuild) {
    try {
      const cacheStat = await stat(file);
      const sourceMtime = await newestSourceMtime(kind);
      if (sourceMtime <= cacheStat.mtimeMs) {
        const raw = await readFile(file, "utf8");
        return JSON.parse(raw);
      }
    } catch {
      // fall through to build
    }
  }
  const graph =
    kind === "tickets"
      ? await buildTicketGraph()
      : kind === "dataflow"
        ? await buildDataflowGraph()
        : kind === "schemas"
          ? await buildSchemasGraph()
          : kind === "ai"
            ? await buildAiGraph()
            : await (await import("./lib/graphs/adrs.ts")).buildAdrGraph();
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(graph, null, 2), "utf8");
  return graph;
}

const serveOptions = {
  hostname: "127.0.0.1",
  async fetch(req: Request) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Routes
    if (pathname === "/") return serveStatic("index.html");
    if (pathname === "/graphs")
      return Response.redirect("/graphs/dataflow", 302);
    if (/^\/graphs\/(tickets|dataflow|schemas|ai)\/?$/.test(pathname))
      return serveStatic("graphs.html");
    if (pathname.startsWith("/ticket/")) return serveStatic("ticket.html");
    if (pathname === "/adrs" || pathname === "/adrs/")
      return serveStatic("adrs.html");
    if (pathname === "/palette" || pathname === "/palette/")
      return serveStatic("palette.html");
    if (pathname === "/terminal" || pathname === "/terminal/")
      return serveStatic("terminal.html");
    if (pathname === "/terminal-xterm.html")
      return serveStatic("terminal-xterm.html");
    if (pathname === "/search.html") return serveStatic("search.html");
    if (/^\/adrs\/ADR-\d+\/?$/.test(pathname)) return serveStatic("adr.html");

    // API
    if (pathname === "/api/buckets" && req.method === "GET") {
      await archiveStaleComplete();
      // Mirror the current board to Firestore if enabled — fire-and-forget and
      // self-throttled (≤ once / 10s) so the poll never blocks on the network, and
      // interactive raw-`mv` moves converge even with no chaos loop running.
      void syncBoardSafe({ minIntervalMs: 10_000 });
      const visible = BUCKETS.filter((b) => b !== "7-archive");
      const out: Record<string, unknown> = {};
      for (const b of visible) out[b] = await listBucket(b);
      return json(out);
    }

    if (pathname === "/api/buckets/7-archive" && req.method === "GET") {
      return json(await listBucket("7-archive"));
    }

    if (pathname === "/api/domains" && req.method === "GET") {
      const all = await listAll();
      const set = new Set<string>(["app", "infra", "docs", "meta"]);
      for (const t of all) if (t.domain) set.add(t.domain);
      return json([...set].sort());
    }

    if (pathname === "/api/tickets" && req.method === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        return err("invalid JSON body");
      }
      const title =
        typeof payload.title === "string" ? payload.title.trim() : "";
      if (!title) return err("title is required");
      const priority =
        typeof payload.priority === "string" ? payload.priority : "Medium";
      const domain =
        typeof payload.domain === "string" ? payload.domain : undefined;
      const body = typeof payload.body === "string" ? payload.body : undefined;
      const csv = (v: unknown): string[] | undefined =>
        Array.isArray(v)
          ? v
              .map(String)
              .map((s) => s.trim())
              .filter(Boolean)
          : typeof v === "string"
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;
      const bucket =
        typeof payload.bucket === "string"
          ? (payload.bucket as Bucket)
          : "scratch";
      if (!BUCKETS.includes(bucket)) return err(`invalid bucket: ${bucket}`);
      // complexity: optional int 1–5. Absent / "" / "auto" → don't set.
      // Anything else that doesn't coerce to 1–5 is a hard 400.
      let complexity: number | undefined;
      const rawC = payload.complexity;
      if (
        rawC !== undefined &&
        rawC !== null &&
        rawC !== "" &&
        rawC !== "auto"
      ) {
        const n = typeof rawC === "number" ? rawC : parseInt(String(rawC), 10);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return err(`invalid complexity: ${rawC} (expected 1–5 or "auto")`);
        }
        complexity = n;
      }
      try {
        const t = await createTicket({
          title,
          priority,
          domain,
          body,
          tags: csv(payload.tags),
          depends_on: csv(payload.depends_on),
          blocks: csv(payload.blocks),
          related: csv(payload.related),
          bucket,
          complexity,
        });
        return json(t, 201);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    const idMatch = pathname.match(/^\/api\/tickets\/(TKT-\d+)$/);
    if (idMatch) {
      const id = idMatch[1];
      try {
        if (req.method === "GET") {
          const t = await readTicket(id);
          return t ? json(t) : err("not found", 404);
        }
        if (req.method === "PUT") {
          const { frontmatter, body } = (await req.json()) as {
            frontmatter?: Frontmatter;
            body?: string;
          };
          if (!frontmatter || typeof body !== "string")
            return err("expected {frontmatter, body}");
          await writeTicket(id, frontmatter, body);
          return json({ ok: true });
        }
        if (req.method === "DELETE") {
          await deleteTicket(id);
          return json({ ok: true });
        }
        return err("method not allowed", 405);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    const moveMatch = pathname.match(/^\/api\/tickets\/(TKT-\d+)\/move$/);
    if (moveMatch && req.method === "POST") {
      const id = moveMatch[1];
      const { to } = (await req.json()) as { to?: unknown };
      if (typeof to !== "string" || !BUCKETS.includes(to as Bucket))
        return err(`invalid bucket: ${String(to)}`);
      const result = await moveTicket(id, to as Bucket);
      return json(result);
    }

    const graphMatch = pathname.match(
      /^\/api\/graphs\/(tickets|dataflow|schemas|adrs|ai)$/,
    );
    if (graphMatch && req.method === "GET") {
      const kind = graphMatch[1] as GraphKind;
      const rebuild = url.searchParams.get("rebuild") === "1";
      const live = url.searchParams.get("live") === "1";
      return json(await readCachedOrBuild(kind, rebuild, live));
    }

    // -----------------------------------------------------------------------
    // ADR API — list/read/create/update + FSM-validated transitions.
    // Spec source: .tickets/ADRs/ADR-001-meta-adr-system.md §D8.
    // Backed by .skua/lib/adrs.ts (TKT-205).
    // -----------------------------------------------------------------------

    if (pathname === "/api/adrs" && req.method === "GET") {
      return json(await listAllAdrs());
    }

    if (pathname === "/api/adrs" && req.method === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        return err("invalid JSON body");
      }
      const title =
        typeof payload.title === "string" ? payload.title.trim() : "";
      if (!title) return err("title is required");
      const csv = (v: unknown): string[] =>
        Array.isArray(v)
          ? (v as unknown[])
              .map(String)
              .map((s) => s.trim())
              .filter(Boolean)
          : typeof v === "string"
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
      const deciders = csv(payload.deciders);
      const tags = csv(payload.tags);
      const relatedTickets = csv(payload.related_tickets);
      const supersedes = csv(payload.supersedes);
      const domain =
        typeof payload.domain === "string" ? payload.domain : "meta";
      const bodyOverride =
        typeof payload.body === "string" && payload.body.trim()
          ? payload.body
          : null;
      // complexity: optional int 1–5. Absent / "" / "auto" → undefined.
      let complexity: number | undefined;
      const rawC = payload.complexity;
      if (
        rawC !== undefined &&
        rawC !== null &&
        rawC !== "" &&
        rawC !== "auto"
      ) {
        const n = typeof rawC === "number" ? rawC : parseInt(String(rawC), 10);
        if (!Number.isInteger(n) || n < 1 || n > 5) {
          return err(`invalid complexity: ${rawC} (expected 1–5 or "auto")`);
        }
        complexity = n;
      }
      try {
        const newId = await nextAdrId();
        const today = new Date().toISOString().slice(0, 10);
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60);
        const baseName = `${newId}-${domain}-${slug || "untitled"}`;
        const filename = `${baseName}.md`;
        const { writeFile, mkdir, rm } = await import("node:fs/promises");
        // Folder-per-ADR layout: ADRS_ROOT/<baseName>/<baseName>.md +
        // versions/ + references/ + comments.jsonl.
        const folder = join(ADRS_ROOT, baseName);
        await mkdir(folder, { recursive: true });
        await mkdir(join(folder, "versions"), { recursive: true });
        await mkdir(join(folder, "references"), { recursive: true });
        const body =
          bodyOverride ??
          [
            "### TL;DR",
            "",
            "<2-4 sentences capturing the decision and why it matters.>",
            "",
            "### Decision",
            "",
            "<The chosen path, stated explicitly.>",
            "",
            "### Consequences",
            "",
            "<What follows from the decision: tickets implied, conventions established, risks accepted.>",
            "",
            "### Alternatives considered",
            "",
            "<What was rejected and why.>",
            "",
          ].join("\n");
        const parsed: ParsedAdr = {
          frontmatter: {
            id: newId,
            title,
            status: "proposed",
            version: 1,
            created: today,
            decided: null,
            deciders,
            supersedes,
            superseded_by: null,
            related_tickets: relatedTickets,
            proposed_tickets: [],
            materialized_tickets: [],
            tags,
            domain,
            ...(complexity !== undefined ? { complexity } : {}),
          },
          body,
        };
        const { serializeAdr } = await import("./lib/adrs.ts");
        const canonical = join(folder, filename);
        await writeFile(canonical, serializeAdr(parsed), "utf8");
        // Touch the comments.jsonl so the file exists (empty).
        await writeFile(join(folder, "comments.jsonl"), "", "utf8");
        // Mirror supersedes: for each ADR in supersedes[], flip its status to
        // "superseded" and set its superseded_by to the new ADR. Atomic per-file.
        // On failure, roll back the new ADR folder so the system stays consistent.
        if (supersedes.length > 0) {
          try {
            await mirrorSupersedes(newId, supersedes);
          } catch (mirrorErr) {
            await rm(folder, { recursive: true, force: true }).catch(() => {});
            return err(
              `supersedes mirror failed: ${mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr)} — new ADR ${newId} rolled back`,
              500,
            );
          }
        }
        return json({ id: newId, filename, folder: baseName, ...parsed }, 201);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    const adrIdMatch = pathname.match(/^\/api\/adrs\/(ADR-\d+)$/);
    if (adrIdMatch) {
      const id = adrIdMatch[1];
      try {
        if (req.method === "GET") {
          const a = await readAdr(id);
          return a ? json(a) : err("not found", 404);
        }
        if (req.method === "PUT") {
          const body = await req.json();
          if (!body || typeof body !== "object")
            return err("expected {frontmatter, body}");
          const fm = (body as { frontmatter?: unknown }).frontmatter;
          const bodyStr = (body as { body?: unknown }).body;
          if (!fm || typeof bodyStr !== "string")
            return err("expected {frontmatter, body}");
          const fmRec = fm as Record<string, unknown>;
          // Refuse id changes.
          if (fmRec.id !== undefined && fmRec.id !== id) {
            return json(
              { error: `cannot change id from ${id} to ${fmRec.id}` },
              409,
            );
          }
          // Refuse edits from terminal status.
          const existing = await readAdr(id);
          if (!existing) return err("not found", 404);
          const currentStatus = existing.frontmatter.status ?? "proposed";
          const terminal = new Set(["rejected", "superseded", "deprecated"]);
          if (terminal.has(currentStatus) && fmRec.status !== currentStatus) {
            return json(
              {
                error: `cannot edit from terminal status "${currentStatus}" — use transition or create a superseding ADR`,
              },
              409,
            );
          }
          await writeAdr(id, { frontmatter: fmRec, body: bodyStr });
          return json({ ok: true });
        }
        if (req.method === "DELETE") {
          const result = await deleteAdr(id);
          return json({ ok: true, ...result });
        }
        return err("method not allowed", 405);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // ── Versions / comments / references — folder-layout endpoints (TKT) ──

    const adrVersionsMatch = pathname.match(
      /^\/api\/adrs\/(ADR-\d+)\/versions$/,
    );
    if (adrVersionsMatch && req.method === "GET") {
      return json({ versions: await listVersions(adrVersionsMatch[1]) });
    }

    const adrVersionMatch = pathname.match(
      /^\/api\/adrs\/(ADR-\d+)\/versions\/(\d+)$/,
    );
    if (adrVersionMatch && req.method === "GET") {
      const snap = await readVersionSnapshot(
        adrVersionMatch[1],
        parseInt(adrVersionMatch[2], 10),
      );
      if (!snap) return err("not found", 404);
      return json(snap);
    }

    const adrCommentsMatch = pathname.match(
      /^\/api\/adrs\/(ADR-\d+)\/comments$/,
    );
    if (adrCommentsMatch) {
      const id = adrCommentsMatch[1];
      try {
        if (req.method === "GET") {
          return json({ comments: await readComments(id) });
        }
        if (req.method === "POST") {
          const payload = (await req.json()) as Record<string, unknown>;
          const author =
            typeof payload.author === "string" ? payload.author.trim() : "";
          const text =
            typeof payload.text === "string" ? payload.text.trim() : "";
          if (!author) return err("author required");
          if (!text) return err("text required");
          const entry = await appendComment(id, author, text);
          return json(entry, 201);
        }
        return err("method not allowed", 405);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    const adrRefsMatch = pathname.match(/^\/api\/adrs\/(ADR-\d+)\/references$/);
    if (adrRefsMatch) {
      const id = adrRefsMatch[1];
      try {
        if (req.method === "GET") {
          return json({ references: await listReferences(id) });
        }
        if (req.method === "POST") {
          const payload = (await req.json()) as Record<string, unknown>;
          const filename =
            typeof payload.filename === "string" ? payload.filename.trim() : "";
          const content =
            typeof payload.content === "string" ? payload.content : "";
          if (!filename) return err("filename required");
          await writeReference(id, filename, content);
          return json({ ok: true, filename }, 201);
        }
        return err("method not allowed", 405);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    const adrRefMatch = pathname.match(
      /^\/api\/adrs\/(ADR-\d+)\/references\/([^/]+)$/,
    );
    if (adrRefMatch && req.method === "GET") {
      const content = await readReference(
        adrRefMatch[1],
        decodeURIComponent(adrRefMatch[2]),
      );
      if (content === null) return err("not found", 404);
      return new Response(content, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const adrTransitionMatch = pathname.match(
      /^\/api\/adrs\/(ADR-\d+)\/transition$/,
    );
    if (adrTransitionMatch && req.method === "POST") {
      const id = adrTransitionMatch[1];
      try {
        const payload = await req.json();
        const to = (payload as { to?: unknown }).to;
        const deciders = (payload as { deciders?: unknown }).deciders;
        if (typeof to !== "string" || !ADR_STATES.includes(to as AdrState)) {
          return err(`invalid target state: ${to}`);
        }
        if (!Array.isArray(deciders)) return err("deciders[] required");
        await transitionAdr(
          id,
          to as AdrState,
          (deciders as unknown[]).map(String),
        );
        // On proposed→accepted, auto-fire promote-draft-tickets (TKT-223). Mints
        // a backlog ticket per proposed_tickets[] entry, resolves DRAFT-N deps,
        // and rewrites the ADR's frontmatter to record materialized_tickets[].
        let promote:
          | Awaited<ReturnType<typeof promoteDraftTickets>>
          | undefined;
        if (to === "accepted") {
          promote = await promoteDraftTickets(id);
        }
        return json({ ok: true, promote });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("illegal transition:"))
          return json({ error: msg }, 409);
        return err(msg, 500);
      }
    }

    // Active agentic stacks — flow-chip-bar data for the dashboard.
    // Scans .skua/cache/stacks/ for records with status in (planned, running)
    // and returns:
    //   - active: the most-recently-started record (or null) — preserved for
    //     backward compatibility with any older consumer that read a single
    //     record.
    //   - active_list: every active record, sorted most-recently-started first
    //     — consumed by the chip-bar (TKT-196).
    if (pathname === "/api/stacks/active" && req.method === "GET") {
      const stacksDir = join(CACHE, "stacks");
      try {
        const files = await readdir(stacksDir);
        const records: Array<{
          file: string;
          data: Record<string, unknown>;
          mtime: number;
        }> = [];
        for (const f of files) {
          if (!f.endsWith(".json") || f === "config.json") continue;
          try {
            const raw = await readFile(join(stacksDir, f), "utf8");
            const data = JSON.parse(raw) as Record<string, unknown>;
            const s = await stat(join(stacksDir, f));
            records.push({ file: f, data, mtime: s.mtimeMs });
          } catch {
            /* skip malformed */
          }
        }
        const statusActive = records.filter(
          (r) => r.data.status === "running" || r.data.status === "planned",
        );
        // Deterministic cross-check: for agentic stacks, the ticket itself
        // must still be in an in-flight lifecycle bucket. If a stack's status
        // JSON was never updated after the ticket landed in 5-validating /
        // 6-complete (or got moved back to 0-backlog / 1-staging), drop it from
        // the bar so stale chips don't pile up. Validating is NOT "running":
        // the build work is done and the ticket is awaiting review, so it
        // should not light the chip-bar. Members in the stack are AND-ed: any
        // member still in-flight keeps the stack visible.
        const ACTIVE_BUCKETS = new Set<Bucket>([
          "2-stuck",
          "3-building",
          "4-testing",
        ]);
        const active: typeof statusActive = [];
        for (const r of statusActive) {
          const members = Array.isArray(r.data.members)
            ? (r.data.members as string[])
            : [];
          if (r.data.agentic_mode !== true || members.length === 0) {
            active.push(r);
            continue;
          }
          let anyActive = false;
          for (const m of members) {
            const found = await findTicket(m);
            if (found && ACTIVE_BUCKETS.has(found.bucket)) {
              anyActive = true;
              break;
            }
          }
          if (anyActive) active.push(r);
        }
        if (active.length === 0) return json({ active: null, active_list: [] });
        // Most-recently-started wins. Fall back to mtime.
        active.sort((a, b) => {
          const aStart =
            typeof a.data.started_at === "string"
              ? Date.parse(a.data.started_at)
              : a.mtime;
          const bStart =
            typeof b.data.started_at === "string"
              ? Date.parse(b.data.started_at)
              : b.mtime;
          return bStart - aStart;
        });
        return json({
          active: active[0].data,
          active_list: active.map((r) => r.data),
        });
      } catch {
        return json({ active: null, active_list: [] });
      }
    }

    // Active chaos run — drives the red dashboard banner. Reads the run records
    // the supervisor writes to .skua/cache/chaos/ (status running | paused_usage).
    if (pathname === "/api/chaos/active" && req.method === "GET") {
      const runs = activeRuns();
      const r = runs[0];
      if (!r) return json({ active: null });
      return json({
        active: {
          id: r.id,
          status: r.status,
          built: r.processed.filter((p) => p.outcome === "validating").length,
          skipped: r.processed.filter((p) => p.outcome === "stuck").length,
          in_flight: r.in_flight,
          generated_features: r.generated_features,
        },
      });
    }

    // Terminal sessions — ttyd-backed local terminals (lib/terminals.ts). Each
    // session is a ttyd process on its own localhost port; the browser embeds it
    // via <iframe>. Persistence across reconnects/restarts comes from the
    // detached zellij session that owns the shell's pty.
    if (pathname === "/api/terminals" && req.method === "GET") {
      // Enrich each session with its live status + summary + pending notification.
      // The source of truth is the skua_terminal_live.ts hook (written per session to
      // cache/terminals/live/<id>.json) — it knows what Claude is doing without
      // scraping or any API. Terminals with no hook data (a plain shell, or a
      // claude started before the hook env was set) read idle; no summary, so the
      // tab shows its cwd.
      const sessions = await listSessions();
      const enriched = await Promise.all(
        sessions.map(async (s) => {
          // Tab label precedence: user rename → last command run → dir basename.
          const lastCommand = await readLastCommand(s.id);
          const baseTitle = s.title;
          const customTitle = s.customTitle ?? null;
          const base = {
            ...s,
            title: customTitle || lastCommand || baseTitle,
            baseTitle,
            customTitle,
            lastCommand,
          };
          const live = await readLive(s.id);
          if (live?.state) {
            return {
              ...base,
              status: live.state,
              summary: live.summary ?? null,
              notification: live.notification ?? null,
              sessionId: live.sessionId ?? null,
            };
          }
          // No hook data (a plain shell, or a `claude` started before the hook
          // env was set): with tmux gone there's no capture-pane fallback, so
          // report idle. The hook covers every real Claude session.
          return { ...base, status: "idle", summary: null, notification: null, sessionId: null };
        }),
      );
      return json(enriched);
    }
    if (pathname === "/api/terminals" && req.method === "POST") {
      let payload: Record<string, unknown> = {};
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        /* empty body is ok */
      }
      const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
      const title =
        typeof payload.title === "string" ? payload.title : undefined;
      // Optional fork intent: resume an existing Claude session into the new
      // terminal as a divergent copy. The command is built here (not accepted as
      // a raw string) so this endpoint can't be used to run arbitrary shell.
      let command: string | undefined;
      const fork = payload.fork as { sessionId?: unknown; prompt?: unknown } | undefined;
      if (fork && typeof fork.sessionId === "string" && fork.sessionId.trim()) {
        const sid = fork.sessionId.trim();
        // sid is interpolated UNQUOTED into the command, so constrain it to the
        // shape of a session id (UUID-like) — this rejects any shell metacharacters.
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sid)) {
          return err("invalid fork.sessionId", 400);
        }
        const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // single-quote for the shell
        const prompt = typeof fork.prompt === "string" ? fork.prompt.trim() : "";
        command = `claude --resume ${sid} --fork-session` + (prompt ? ` ${shq(prompt)}` : "");
      }
      // Optional open intent: launch an editor on a repo file in the new terminal
      // (the search tab's click-to-open). Like fork, the command is built here so
      // this endpoint can't be used to run arbitrary shell.
      let openTitle: string | undefined;
      let openCwd: string | undefined;
      const open = payload.open as { path?: unknown; line?: unknown } | undefined;
      if (!command && open && typeof open.path === "string") {
        try {
          command = await buildOpenCommand(open.path, parseLine(open.line));
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e), 400);
        }
        openTitle = open.path.split("/").pop() || undefined;
        openCwd = PROJECT_ROOT; // root the file-viewer terminal at the repo
      }
      try {
        return json(await createSession({ cwd: cwd ?? openCwd, title: title ?? openTitle, command }), 201);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 400);
      }
    }
    // Persist the tab list's vertical order after a drag-reorder. Body: {ids:[…]}
    // in the new top-to-bottom order. Checked before the /:id routes below (the
    // id regex requires a `term-` prefix, so "reorder" can't collide either way).
    if (pathname === "/api/terminals/reorder" && req.method === "POST") {
      let payload: Record<string, unknown> = {};
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        /* fall through to the empty-ids guard */
      }
      const ids = Array.isArray(payload.ids)
        ? (payload.ids.filter((x) => typeof x === "string") as string[])
        : null;
      if (!ids || !ids.length) return err("ids array required");
      await reorderSessions(ids);
      return json({ ok: true });
    }
    const termIdMatch = pathname.match(/^\/api\/terminals\/(term-[a-z0-9]+)$/);
    if (termIdMatch && req.method === "DELETE") {
      return json(await killSession(termIdMatch[1]));
    }
    if (termIdMatch && (req.method === "PATCH" || req.method === "PUT")) {
      let payload: Record<string, unknown> = {};
      try {
        payload = (await req.json()) as Record<string, unknown>;
      } catch {
        /* empty body → clears the custom name */
      }
      const title = typeof payload.title === "string" ? payload.title : "";
      const r = await renameSession(termIdMatch[1], title);
      if (!r) return err("terminal not found", 404);
      return json({ ok: true, customTitle: r.customTitle ?? null });
    }
    // The kill switch (repurposed redraw button): reap every skua terminal
    // (each ttyd + its zellij session) and clear all records for a clean slate.
    // Destructive and irreversible — the client confirms before calling. Touches
    // only skua's own sessions. Server-wide, so no terminal id in the path.
    if (pathname === "/api/terminals/kill-server" && req.method === "POST") {
      return json(await killAllSessions());
    }

    // The absolute root every search runs against — shown in the search tab UI.
    if (pathname === "/api/search/root" && req.method === "GET") {
      return json({ root: SEARCH_ROOT });
    }
    // Project-wide text search backing the terminal "Search" tab (Zed ⌘⇧F).
    // Uses ripgrep when a spawnable `rg` binary exists, else falls back to
    // `git grep`. Rooted at the repo; see lib/search.ts.
    if (pathname === "/api/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const regex = url.searchParams.get("regex") === "1";
      const caseSensitive = url.searchParams.get("case") === "1";
      try {
        return json(await runSearch({ query: q, regex, caseSensitive }));
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // Static
    if (
      pathname.startsWith("/vendor/") ||
      /\.(js|css|ico|png|svg)$/.test(pathname)
    ) {
      return serveStatic(pathname.replace(/^\//, ""));
    }

    return new Response("not found", { status: 404 });
  },
};

// Bind the dashboard, stepping forward from PORT until we find a free one.
// Bun.serve throws (EADDRINUSE) when the port is taken — commonly a skua
// server from another repo, or an orphaned `--hot` process from a previous
// run. Rather than die and make whoever launched us go probe the port, walk to
// the next port and announce the URL we actually landed on.
function isPortInUse(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return (
    code === "EADDRINUSE" ||
    /EADDRINUSE|address already in use|is in use/i.test(msg)
  );
}

const PORT_TRIES = 20;
let server: ReturnType<typeof Bun.serve> | undefined;
for (let port = PORT; port < PORT + PORT_TRIES; port++) {
  try {
    server = Bun.serve({ ...serveOptions, port });
    break;
  } catch (e) {
    if (isPortInUse(e) && port < PORT + PORT_TRIES - 1) {
      console.warn(`skua: port ${port} in use → trying ${port + 1}`);
      continue;
    }
    throw e;
  }
}
if (!server) {
  throw new Error(
    `skua: no free port in ${PORT}–${PORT + PORT_TRIES - 1}`,
  );
}

// Publish the ACTUAL bound port (the loop may have walked past a busy base PORT)
// so terminals we spawn seed it as SKUA_PORT — letting an in-session `claude` /
// the `/fork` script reach THIS dashboard, not a same-config skua from another
// repo on the base port.
process.env.SKUA_PORT = String(server.port);

if (server.port !== PORT) {
  console.warn(
    `skua: requested port ${PORT} was busy — bound ${server.port} instead`,
  );
}
console.log(`skua dashboard → http://${server.hostname}:${server.port}`);
