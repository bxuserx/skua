// Generic, detection-based "dataflow" architecture-diagram graph builder.
//
// Renders the repo as a left→right chain across four layers:
//
//   fe-route ──fetch──▶ endpoint ◀──hosts── container
//                          │
//                   reads / writes
//                          ▼
//                        store
//
// A page (or SPA route) calls an endpoint; that endpoint runs inside a deploy
// container; the endpoint (or its container) reads/writes a datastore.
//
// FRAMEWORK-AGNOSTIC. This builder does NOT assume a single-package Next.js app
// at the repo root. It discovers deploy units (Docker containers, compose
// services, Cloud Run / Fly services), locates each one's source root, detects
// its language + framework, and runs the matching detectors:
//
//   • Containers : docker-compose services (with `build.context` roots), every
//                  Dockerfile in the tree, Makefile/cloudbuild/fly.toml service
//                  names. Each gets a source ROOT and a detected language.
//   • Frontends  : Next.js App Router (app/ or src/app, in ANY subdir),
//                  Next.js Pages Router (pages/), Vite / CRA + React-Router
//                  (`<Route path>` / route-object `path:`). Routes are detected
//                  per frontend, wherever the frontend lives.
//   • Endpoints  : Python — FastAPI (`@app/@router.<method>` with
//                  include_router / APIRouter prefixes resolved), Flask
//                  (`@app/@bp.route`). JavaScript/TS — Next.js server actions
//                  ("use server"), Next route handlers (app/api/**/route.ts),
//                  Express (`app/router.<method>`), NestJS (`@Controller` +
//                  `@Get/@Post`). Each endpoint is attributed to its container.
//   • Stores     : a broad engine catalog detected by import/usage signature —
//                  BigQuery, Postgres/MySQL/SQLite (→ sql), Firestore, MongoDB,
//                  DynamoDB (AWS), S3 (AWS), Cosmos DB (Azure), Redis. Concrete
//                  table / collection names are mined from SQL string literals
//                  and `.collection('x')` chains (works on .py and .ts alike);
//                  engines without minable names get a single labelled node.
//   • Edges      : frontend route → proxy endpoint → backend endpoint (the
//                  cross-language bridge is parsed out of `${BACKEND_URL}/path`
//                  proxy templates), endpoint/container → store, container hosts
//                  endpoint/route.
//
// Output is a FLAT Cytoscape graph — { nodes, edges, meta } — with NO compound
// `parent` fields (the dashboard's dagre layout throws on them). Nothing is ever
// silently dropped; an absent layer yields a warning rather than a crash.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { REPO_ROOT } from "../../skua.config.ts";

// ── Public types ─────────────────────────────────────────────────────────────

export type NodeKind = "fe-route" | "container" | "endpoint" | "store";
export type EdgeKind = "fetch" | "hosts" | "reads" | "writes";

export interface DFNode {
  data: {
    id: string;
    label: string;
    kind: NodeKind;
    // fe-route
    cached?: boolean;
    file?: string; // repo-relative source file
    // container
    platform?: string;
    lang?: string; // node | python | go | …
    framework?: string;
    // endpoint
    access?: "server-action" | "api-route";
    method?: string;
    container?: string; // container node id
    // store
    db?: "firestore" | "sql" | "bigquery" | string;
    engine?: string; // precise engine when db is a colour-bucket (e.g. "postgres")
  };
}

export interface DFEdge {
  data: {
    id: string;
    source: string;
    target: string;
    kind: EdgeKind;
    cached?: boolean; // fetch edges only
  };
}

export interface DFGraph {
  nodes: DFNode[];
  edges: DFEdge[];
  meta: {
    built: string;
    counts: {
      routes: number;
      containers: number;
      endpoints: number;
      stores: number;
      edges: number;
    };
    warnings: { kind: string; detail: string }[];
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", ".skua",
  ".venv", "venv", "__pycache__", ".turbo", "coverage", ".cache", "vendor",
  "target", ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".svelte-kit",
  "_reference", "research", "plans", "docs",
]);

const MAX_REACHABLE_DEPTH = 3; // import-chase depth from a page
const SRC_EXT = /\.(tsx?|jsx?|mjs|cjs|py|go|rb)$/;

// ── Generic filesystem walk ──────────────────────────────────────────────────

async function walk(
  dir: string,
  predicate: (full: string, name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    if (name.startsWith(".") && name !== "." && name !== "..") continue;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...(await walk(full, predicate)));
    else if (predicate(full, name)) out.push(full);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

function rel(p: string): string {
  return relative(REPO_ROOT, p) || ".";
}

// Cache file reads across the whole build (a container's source is scanned by
// several detectors).
const FILE_CACHE = new Map<string, string | null>();
async function readCached(p: string): Promise<string | null> {
  if (FILE_CACHE.has(p)) return FILE_CACHE.get(p)!;
  const v = await readSafe(p);
  FILE_CACHE.set(p, v);
  return v;
}

// ── Matched-brace scanner (shared by several detectors) ──────────────────────

function matchCloser(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Route-path normalization ─────────────────────────────────────────────────

// Convert a Next app-router page dir (relative to app/) into a route path.
function routePathFromRelDir(relDir: string): string {
  const parts = relDir
    .split("/")
    .filter((p) => p && p !== ".")
    .filter((p) => !/^\(.+\)$/.test(p)) // route groups
    .filter((p) => !p.startsWith("@")); // parallel-route slots
  return "/" + parts.join("/");
}

// Normalize ANY URL path for cross-framework matching: collapse param syntaxes
// ({id}, [id], :id) to a single wildcard, drop trailing slash + query/hash.
function normPath(p: string): string {
  let s = p.split(/[?#]/)[0];
  s = s.replace(/\{[^}/]+\}|\[\.{3}[^\]]+\]|\[[^\]/]+\]|:[A-Za-z_][\w]*/g, "*");
  s = s.replace(/\/+/g, "/").replace(/\/+$/, "");
  return s || "/";
}

// ── Language / framework detection for a source root ─────────────────────────

interface RootInfo {
  lang: "node" | "python" | "go" | "ruby" | "other";
  framework?: string; // next | vite | react | express | nestjs | fastapi | flask | django | …
  pkg?: Record<string, unknown>;
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  const raw = await readCached(p);
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}

async function detectRoot(root: string): Promise<RootInfo> {
  // Node?
  const pkg = await readJson(join(root, "package.json"));
  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    const has = (n: string) => Object.prototype.hasOwnProperty.call(deps, n);
    let framework: string | undefined;
    if (has("next")) framework = "next";
    else if (has("@remix-run/react") || has("@remix-run/node")) framework = "remix";
    else if (has("@nestjs/core")) framework = "nestjs";
    else if (has("express")) framework = "express";
    else if (has("fastify")) framework = "fastify";
    else if (has("hono")) framework = "hono";
    else if (has("vite")) framework = "vite";
    else if (has("@sveltejs/kit")) framework = "sveltekit";
    else if (has("vue")) framework = "vue";
    else if (has("react")) framework = "react";
    return { lang: "node", framework, pkg };
  }
  // Python?
  const pyManifest =
    (await exists(join(root, "requirements.txt"))) ||
    (await exists(join(root, "pyproject.toml"))) ||
    (await exists(join(root, "setup.py"))) ||
    (await exists(join(root, "Pipfile")));
  const pyFiles = pyManifest ? [] : await walk(root, (_f, n) => n.endsWith(".py"));
  if (pyManifest || pyFiles.length) {
    // Sniff the web framework from manifest + a sample of source.
    let blob = "";
    for (const f of ["requirements.txt", "pyproject.toml", "Pipfile", "main.py", "app.py", "server.py", "asgi.py", "wsgi.py"]) {
      blob += (await readCached(join(root, f))) ?? "";
    }
    if (blob.length < 200) {
      for (const f of (pyFiles.length ? pyFiles : await walk(root, (_x, n) => n.endsWith(".py"))).slice(0, 12)) {
        blob += (await readCached(f)) ?? "";
      }
    }
    let framework: string | undefined;
    if (/\bfastapi\b|from\s+fastapi|FastAPI\(/i.test(blob)) framework = "fastapi";
    else if (/\bflask\b|from\s+flask|Flask\(/i.test(blob)) framework = "flask";
    else if (/\bdjango\b/i.test(blob)) framework = "django";
    return { lang: "python", framework };
  }
  if (await exists(join(root, "go.mod"))) return { lang: "go", framework: "go" };
  if ((await exists(join(root, "Gemfile"))) || (await exists(join(root, "config.ru")))) {
    return { lang: "ruby", framework: "rails" };
  }
  return { lang: "other" };
}

// ── Layer: Containers (deploy units with source roots) ───────────────────────

interface Container {
  id: string;
  name: string;
  platform?: string;
  file?: string;
  root: string; // absolute source root
  info?: RootInfo;
}

function resolveContextDir(composeDir: string, ctx: string): string {
  const c = ctx.trim().replace(/^["']|["']$/g, "");
  if (c.startsWith("/")) return c;
  return join(composeDir, c);
}

async function detectContainers(
  warnings: { kind: string; detail: string }[],
): Promise<Container[]> {
  const byName = new Map<string, Container>();
  const byRoot = new Map<string, Container>();
  const add = (name: string, platform: string | undefined, file: string, root: string) => {
    if (!name) return;
    const existing = byRoot.get(root);
    if (existing) {
      // Prefer a real service name + platform over a generic Dockerfile guess.
      if (platform && !existing.platform) existing.platform = platform;
      return;
    }
    if (byName.has(name)) name = `${name}@${basename(dirname(root)) || basename(root)}`;
    const c: Container = { id: `container:${name}`, name, platform, file, root };
    byName.set(name, c);
    byRoot.set(root, c);
  };

  // 1) docker-compose services (with build contexts → per-service source root).
  for (const dcName of ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"]) {
    const dcPath = join(REPO_ROOT, dcName);
    const dc = await readCached(dcPath);
    if (!dc) continue;
    const dcDir = dirname(dcPath);
    const lines = dc.split("\n");
    let inServices = false;
    let curSvc: string | null = null;
    let curSvcIndent = -1;
    let curContext: string | null = null;
    let pendingInlineBuild: string | null = null;
    const flush = () => {
      if (!curSvc) return;
      const ctx = curContext ?? pendingInlineBuild;
      const root = ctx ? resolveContextDir(dcDir, ctx) : REPO_ROOT;
      add(curSvc, "Docker Compose", rel(dcPath), root);
    };
    for (const raw of lines) {
      const line = raw.replace(/\t/g, "  ");
      if (/^services\s*:/.test(line)) { inServices = true; continue; }
      if (!inServices) continue;
      if (/^\S/.test(line) && !/^\s*#/.test(line)) { flush(); inServices = false; continue; }
      const svc = line.match(/^(\s{2,})([A-Za-z0-9_.-]+)\s*:\s*$/);
      if (svc && (curSvcIndent < 0 || svc[1].length <= curSvcIndent)) {
        flush();
        curSvc = svc[2];
        curSvcIndent = svc[1].length;
        curContext = null;
        pendingInlineBuild = null;
        continue;
      }
      if (!curSvc) continue;
      const inlineBuild = line.match(/^\s+build\s*:\s*(\S.*)$/);
      if (inlineBuild && !/^\s*$/.test(inlineBuild[1])) pendingInlineBuild = inlineBuild[1];
      const ctx = line.match(/^\s+context\s*:\s*(\S.*)$/);
      if (ctx) curContext = ctx[1];
    }
    flush();
  }

  // 2) Every Dockerfile in the tree → a container rooted at its directory.
  for (const df of await walk(REPO_ROOT, (_f, n) => n === "Dockerfile" || /^Dockerfile\./.test(n))) {
    const root = dirname(df);
    if (byRoot.has(root)) continue;
    const name = basename(root) === basename(REPO_ROOT) ? (basename(root) || "app") : basename(root);
    add(name, "Docker", rel(df), root);
  }

  // 3) Service-name declarations that don't carry a distinct source root
  //    (Makefile / cloudbuild / fly) — only add if we found nothing yet.
  if (byRoot.size === 0) {
    const mk = await readCached(join(REPO_ROOT, "Makefile"));
    if (mk) {
      const isCloudRun = /gcloud\s+run\s+deploy/.test(mk);
      const svc = mk.match(/^\s*SERVICE_NAME\s*[:?]?=\s*([A-Za-z0-9_.-]+)/m);
      if (svc && !svc[1].startsWith("$")) add(svc[1], isCloudRun ? "Cloud Run" : undefined, rel(join(REPO_ROOT, "Makefile")), REPO_ROOT);
      const dep = mk.match(/gcloud\s+run\s+deploy\s+([A-Za-z0-9_.-]+)/);
      if (dep && !dep[1].startsWith("$")) add(dep[1], "Cloud Run", rel(join(REPO_ROOT, "Makefile")), REPO_ROOT);
    }
    for (const cbName of ["cloudbuild.yaml", "cloudbuild.yml"]) {
      const cb = await readCached(join(REPO_ROOT, cbName));
      if (!cb) continue;
      const sub = cb.match(/_SERVICE_NAME\s*:\s*['"]?([A-Za-z0-9_.-]+)['"]?/);
      if (sub && !sub[1].startsWith("$")) add(sub[1], "Cloud Run", cbName, REPO_ROOT);
    }
    const fly = await readCached(join(REPO_ROOT, "fly.toml"));
    if (fly) {
      const app = fly.match(/^\s*app\s*=\s*["']([A-Za-z0-9_.-]+)["']/m);
      if (app) add(app[1], "Fly.io", "fly.toml", REPO_ROOT);
    }
  }

  // 4) Truly nothing: a single container named after the repo dir + warn.
  if (byRoot.size === 0) {
    const dirName = basename(REPO_ROOT) || "app";
    warnings.push({
      kind: "no-container-detected",
      detail: `No compose/Dockerfile/Makefile/cloudbuild/fly.toml found — using repo dir name "${dirName}"`,
    });
    add(dirName, undefined, ".", REPO_ROOT);
  }

  const containers = [...byRoot.values()];
  for (const c of containers) c.info = await detectRoot(c.root);
  return containers;
}

// Pick the container that owns a file: the one whose root is the deepest
// ancestor of the file. Falls back to null (→ attributed at graph level).
function ownerContainer(file: string, containers: Container[]): Container | null {
  let best: Container | null = null;
  for (const c of containers) {
    if (file === c.root || file.startsWith(c.root + "/")) {
      if (!best || c.root.length > best.root.length) best = c;
    }
  }
  return best;
}

// ══════════════════════════════════════════════════════════════════════════
//  FRONTEND ROUTE DETECTION
// ══════════════════════════════════════════════════════════════════════════

interface Route {
  id: string;
  path: string;
  file: string;
  containerId?: string;
  cached: boolean;
  reachable: string[]; // abs files reachable from the page (for fetch matching)
}

async function findFirstDir(root: string, candidates: string[][]): Promise<string | null> {
  for (const parts of candidates) {
    const d = join(root, ...parts);
    if (await isDir(d)) return d;
  }
  return null;
}

// Next.js App Router pages under app/ (or src/app).
async function nextAppRoutes(root: string, containerId: string): Promise<Route[]> {
  const appDir = await findFirstDir(root, [["app"], ["src", "app"]]);
  if (!appDir) return [];
  const pages = await walk(appDir, (_f, n) => /^page\.(tsx|jsx|ts|js)$/.test(n));
  const routes: Route[] = [];
  for (const pageFile of pages) {
    const relDir = relative(appDir, dirname(pageFile));
    const path = routePathFromRelDir(relDir);
    routes.push({ id: `route:${containerId}:${path}`, path, file: rel(pageFile), containerId, cached: false, reachable: [] });
  }
  return routes;
}

// Next.js Pages Router under pages/ (or src/pages) — excludes _app/_document, api/.
async function nextPagesRoutes(root: string, containerId: string): Promise<Route[]> {
  const pagesDir = await findFirstDir(root, [["pages"], ["src", "pages"]]);
  if (!pagesDir) return [];
  const files = await walk(pagesDir, (_f, n) => /\.(tsx|jsx|ts|js)$/.test(n));
  const routes: Route[] = [];
  for (const f of files) {
    const relPath = relative(pagesDir, f);
    if (relPath.startsWith("api/") || relPath.startsWith("api\\")) continue; // api routes = endpoints
    const segs = relPath.replace(/\.(tsx|jsx|ts|js)$/, "").split("/");
    const last = segs[segs.length - 1];
    if (/^_/.test(last)) continue; // _app, _document, _error
    if (last === "index") segs.pop();
    const path = "/" + segs.filter((s) => s && !/^\(.+\)$/.test(s)).join("/");
    routes.push({ id: `route:${containerId}:${path || "/"}`, path: path || "/", file: rel(f), containerId, cached: false, reachable: [] });
  }
  return routes;
}

// Vite / CRA / generic React-Router: mine `<Route path="...">` and route-object
// `path: "..."` literals from the source tree.
async function reactRouterRoutes(root: string, containerId: string): Promise<Route[]> {
  const srcDir = (await isDir(join(root, "src"))) ? join(root, "src") : root;
  const files = await walk(srcDir, (_f, n) => /\.(tsx|jsx|ts|js)$/.test(n));
  const paths = new Map<string, string>(); // path → file
  const jsxRe = /<Route\b[^>]*\bpath\s*=\s*["'{]([^"'}]+)["'}]/g;
  const objRe = /\bpath\s*:\s*["']([^"']+)["']/g;
  for (const f of files) {
    const src = await readCached(f);
    if (!src) continue;
    const looksRouter = /react-router|createBrowserRouter|<Route\b|RouterProvider/.test(src);
    if (!looksRouter) continue;
    let m: RegExpExecArray | null;
    jsxRe.lastIndex = 0;
    while ((m = jsxRe.exec(src))) {
      const p = m[1].startsWith("/") ? m[1] : "/" + m[1];
      if (!paths.has(p)) paths.set(p, rel(f));
    }
    objRe.lastIndex = 0;
    while ((m = objRe.exec(src))) {
      const raw = m[1];
      if (!raw || raw.includes(" ")) continue; // skip non-path strings
      const p = raw.startsWith("/") ? raw : "/" + raw;
      if (!paths.has(p)) paths.set(p, rel(f));
    }
  }
  const routes: Route[] = [];
  for (const [path, file] of paths) {
    routes.push({ id: `route:${containerId}:${path}`, path, file, containerId, cached: false, reachable: [] });
  }
  return routes;
}

async function detectFrontendRoutes(c: Container, warnings: { kind: string; detail: string }[]): Promise<Route[]> {
  const fw = c.info?.framework;
  if (c.info?.lang !== "node") return [];
  let routes: Route[] = [];
  if (fw === "next" || fw === "remix") {
    routes = await nextAppRoutes(c.root, c.id);
    if (routes.length === 0) routes = await nextPagesRoutes(c.root, c.id);
  } else if (fw === "vite" || fw === "react" || fw === "vue" || fw === "sveltekit") {
    routes = await reactRouterRoutes(c.root, c.id);
    if (routes.length === 0) {
      // A bundled SPA with no detectable route table still has an entry point.
      const hasEntry =
        (await exists(join(c.root, "index.html"))) ||
        (await exists(join(c.root, "src", "main.tsx"))) ||
        (await exists(join(c.root, "src", "main.jsx"))) ||
        (await exists(join(c.root, "src", "App.tsx")));
      if (hasEntry) {
        routes = [{ id: `route:${c.id}:/`, path: "/", file: rel(c.root), containerId: c.id, cached: false, reachable: [] }];
        warnings.push({ kind: "spa-no-routes", detail: `${c.name}: ${fw} app with no detectable route table — showing a single root route` });
      }
    }
  }
  return routes;
}

// ══════════════════════════════════════════════════════════════════════════
//  ENDPOINT DETECTION
// ══════════════════════════════════════════════════════════════════════════

interface Endpoint {
  id: string;
  label: string;
  access: "server-action" | "api-route";
  method?: string;
  path?: string; // routable path (for fetch matching)
  file: string; // repo-relative
  absFile: string;
  containerId: string;
  proxyTo: string[]; // backend paths this endpoint forwards to (proxy routes)
  reads: Set<string>;
  writes: Set<string>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

// ── Python: FastAPI ──────────────────────────────────────────────────────────

// Resolve mount prefixes from `include_router(<expr>, prefix="...")` calls across
// the container. Keyed by "<moduleHint>.<varName>" and bare "<varName>".
function fastapiMountIndex(blob: string): Map<string, string> {
  const idx = new Map<string, string>();
  const re = /include_router\s*\(\s*([A-Za-z_][\w.]*)\s*(?:,\s*prefix\s*=\s*["']([^"']*)["'])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob))) {
    const expr = m[1];
    const prefix = m[2] ?? "";
    const parts = expr.split(".");
    const varName = parts[parts.length - 1];
    const moduleHint = parts.length >= 2 ? parts[parts.length - 2] : "";
    idx.set(`${moduleHint}.${varName}`, prefix);
    if (!idx.has(varName)) idx.set(varName, prefix);
  }
  return idx;
}

async function fastapiEndpoints(c: Container): Promise<Endpoint[]> {
  const files = await walk(c.root, (_f, n) => n.endsWith(".py"));
  // First pass: global mount index from every file.
  let blob = "";
  for (const f of files) blob += (await readCached(f)) ?? "";
  const mounts = fastapiMountIndex(blob);

  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const src = await readCached(f);
    if (!src) continue;
    if (!/@\w+\.(get|post|put|patch|delete|head|options)\s*\(/.test(src)) continue;
    const moduleHint = basename(dirname(f)) === basename(c.root) ? basename(f).replace(/\.py$/, "") : basename(dirname(f));
    const fileHint = basename(f).replace(/\.py$/, "");

    // Local APIRouter prefixes declared in this file: `var = APIRouter(prefix="..")`.
    const localPrefix = new Map<string, string>();
    const apr = /([A-Za-z_]\w*)\s*=\s*APIRouter\s*\(([^)]*)\)/g;
    let a: RegExpExecArray | null;
    while ((a = apr.exec(src))) {
      const pm = a[2].match(/prefix\s*=\s*["']([^"']*)["']/);
      localPrefix.set(a[1], pm ? pm[1] : "");
    }

    const decoRe = /@([A-Za-z_]\w*)\.(get|post|put|patch|delete|head|options)\s*\(\s*([fr]?["'])([^"']*)\3/g;
    let m: RegExpExecArray | null;
    while ((m = decoRe.exec(src))) {
      const varName = m[1];
      const method = m[2].toUpperCase();
      const decoPath = m[4];
      const mount =
        mounts.get(`${moduleHint}.${varName}`) ??
        mounts.get(`${fileHint}.${varName}`) ??
        mounts.get(varName) ??
        "";
      const local = localPrefix.get(varName) ?? "";
      let full = `${mount}${local}${decoPath}`;
      if (!full.startsWith("/")) full = "/" + full;
      full = full.replace(/\/{2,}/g, "/");
      const key = `${method} ${full}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({
        id: `endpoint:${c.name}:${method}:${full}`,
        label: `${method} ${full}`,
        access: "api-route",
        method,
        path: full,
        file: rel(f),
        absFile: f,
        containerId: c.id,
        proxyTo: [],
        reads: new Set(),
        writes: new Set(),
      });
    }
  }
  return endpoints;
}

// ── Python: Flask ─────────────────────────────────────────────────────────────

async function flaskEndpoints(c: Container): Promise<Endpoint[]> {
  const files = await walk(c.root, (_f, n) => n.endsWith(".py"));
  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const src = await readCached(f);
    if (!src) continue;
    // Blueprint url_prefix per var: `bp = Blueprint("x", __name__, url_prefix="/p")`.
    const bpPrefix = new Map<string, string>();
    const bpRe = /([A-Za-z_]\w*)\s*=\s*Blueprint\s*\(([^)]*)\)/g;
    let b: RegExpExecArray | null;
    while ((b = bpRe.exec(src))) {
      const pm = b[2].match(/url_prefix\s*=\s*["']([^"']*)["']/);
      if (pm) bpPrefix.set(b[1], pm[1]);
    }
    const routeRe = /@([A-Za-z_]\w*)\.route\s*\(\s*["']([^"']*)["']([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = routeRe.exec(src))) {
      const varName = m[1];
      const path = (bpPrefix.get(varName) ?? "") + m[2];
      const methodsM = m[3].match(/methods\s*=\s*\[([^\]]*)\]/);
      const methods = methodsM
        ? methodsM[1].split(",").map((s) => s.replace(/["'\s]/g, "").toUpperCase()).filter(Boolean)
        : ["GET"];
      for (const method of methods) {
        let full = path.startsWith("/") ? path : "/" + path;
        full = full.replace(/\/{2,}/g, "/");
        const key = `${method} ${full}`;
        if (seen.has(key)) continue;
        seen.add(key);
        endpoints.push({
          id: `endpoint:${c.name}:${method}:${full}`,
          label: `${method} ${full}`,
          access: "api-route", method, path: full,
          file: rel(f), absFile: f, containerId: c.id, proxyTo: [],
          reads: new Set(), writes: new Set(),
        });
      }
    }
  }
  return endpoints;
}

// ── JS/TS: Express / Fastify / Hono ───────────────────────────────────────────

async function expressEndpoints(c: Container): Promise<Endpoint[]> {
  const files = await walk(c.root, (_f, n) => /\.(tsx?|jsx?|mjs|cjs)$/.test(n));
  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();
  const methodAlt = HTTP_METHODS.join("|");
  for (const f of files) {
    const src = await readCached(f);
    if (!src) continue;
    const re = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${methodAlt})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const recv = m[1];
      if (!/^(app|router|api|server|r|route|fastify)$/i.test(recv)) continue;
      const method = m[2].toUpperCase();
      let full = m[3].startsWith("/") ? m[3] : "/" + m[3];
      full = full.replace(/\/{2,}/g, "/");
      const key = `${method} ${full}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({
        id: `endpoint:${c.name}:${method}:${full}`,
        label: `${method} ${full}`,
        access: "api-route", method, path: full,
        file: rel(f), absFile: f, containerId: c.id, proxyTo: [],
        reads: new Set(), writes: new Set(),
      });
    }
  }
  return endpoints;
}

// ── JS/TS: NestJS ─────────────────────────────────────────────────────────────

async function nestEndpoints(c: Container): Promise<Endpoint[]> {
  const files = await walk(c.root, (_f, n) => /\.ts$/.test(n));
  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const src = await readCached(f);
    if (!src || !/@Controller\s*\(/.test(src)) continue;
    const ctrl = src.match(/@Controller\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/);
    const prefix = ctrl && ctrl[1] ? (ctrl[1].startsWith("/") ? ctrl[1] : "/" + ctrl[1]) : "";
    const re = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const method = m[1].toUpperCase();
      const sub = m[2] ? (m[2].startsWith("/") ? m[2] : "/" + m[2]) : "";
      let full = (prefix + sub).replace(/\/{2,}/g, "/") || "/";
      const key = `${method} ${full}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({
        id: `endpoint:${c.name}:${method}:${full}`,
        label: `${method} ${full}`,
        access: "api-route", method, path: full,
        file: rel(f), absFile: f, containerId: c.id, proxyTo: [],
        reads: new Set(), writes: new Set(),
      });
    }
  }
  return endpoints;
}

// ── Next.js: server actions ("use server") + route handlers (app/api) ─────────

function declaresUseServer(src: string): boolean {
  const head = src.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).slice(0, 3);
  return head.some((l) => /^["']use server["'];?$/.test(l));
}

function extractExportedAsyncFns(src: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const fnDecl = /export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnDecl.exec(src))) names.add(m[1]);
  const constArrow = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*async\b/g;
  while ((m = constArrow.exec(src))) names.add(m[1]);
  return [...names];
}

// Extract the backend path(s) a Next proxy route forwards to, from
// `${BACKEND_URL}/path` / `${API_URL}/path` template literals or fetch() calls.
function extractProxyTargets(src: string): string[] {
  const out = new Set<string>();
  // `${...URL...}/some/path`  (template-literal proxy — the dominant pattern)
  const tplRe = /`\$\{[^}]*\}(\/[A-Za-z0-9_./{}\[\]:-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tplRe.exec(src))) {
    const p = m[1].split("?")[0].replace(/\/$/, "");
    if (p.length > 1) out.add(p);
  }
  return [...out];
}

async function nextActionAndRouteEndpoints(c: Container): Promise<Endpoint[]> {
  const endpoints: Endpoint[] = [];
  const appDir = await findFirstDir(c.root, [["app"], ["src", "app"]]);
  const srcRoot = (await isDir(join(c.root, "src"))) ? join(c.root, "src") : c.root;

  // Server actions: src/actions/** + any "use server" file (excluding api routes).
  const actionFiles = new Set<string>();
  for (const ad of [join(c.root, "src", "actions"), join(c.root, "actions")]) {
    if (await isDir(ad)) for (const f of await walk(ad, (_x, n) => /\.tsx?$/.test(n))) actionFiles.add(f);
  }
  const apiPrefix = appDir ? join(appDir, "api") : null;
  for (const f of await walk(srcRoot, (_x, n) => /\.tsx?$/.test(n))) {
    if (actionFiles.has(f)) continue;
    if (apiPrefix && f.startsWith(apiPrefix + "/")) continue;
    if (/^route\.(ts|tsx)$/.test(basename(f))) continue;
    const src = await readCached(f);
    if (src && declaresUseServer(src)) actionFiles.add(f);
  }
  const actionSeen = new Set<string>();
  for (const f of actionFiles) {
    const src = await readCached(f);
    if (!src) continue;
    for (const fn of extractExportedAsyncFns(src)) {
      let id = `endpoint:${c.name}:action:${fn}`;
      let label = fn;
      if (actionSeen.has(fn)) { const tag = basename(f).replace(/\.tsx?$/, ""); id = `endpoint:${c.name}:action:${tag}.${fn}`; label = `${tag}.${fn}`; }
      actionSeen.add(fn);
      endpoints.push({
        id, label, access: "server-action", file: rel(f), absFile: f,
        containerId: c.id, proxyTo: [], reads: new Set(), writes: new Set(),
      });
    }
  }

  // Route handlers: app/api/**/route.ts → api-route endpoints (often proxies).
  if (apiPrefix && (await isDir(apiPrefix))) {
    const routeFiles = await walk(apiPrefix, (_f, n) => /^route\.(ts|tsx|js)$/.test(n));
    for (const f of routeFiles) {
      const relDir = relative(appDir!, dirname(f));
      const apiPath = "/" + relDir.split("/").filter((p) => p && !/^\(.+\)$/.test(p)).join("/");
      const src = (await readCached(f)) ?? "";
      const methods = (src.match(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g) || [])
        .map((s) => s.match(/(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/)![1]);
      const method = methods.length ? methods.join("/") : undefined;
      endpoints.push({
        id: `endpoint:${c.name}:${apiPath}`,
        label: apiPath,
        access: "api-route", method, path: apiPath,
        file: rel(f), absFile: f, containerId: c.id,
        proxyTo: extractProxyTargets(src),
        reads: new Set(), writes: new Set(),
      });
    }
  }
  return endpoints;
}

async function detectEndpoints(c: Container): Promise<Endpoint[]> {
  const fw = c.info?.framework;
  const lang = c.info?.lang;
  const out: Endpoint[] = [];
  if (lang === "python") {
    if (fw === "flask") out.push(...(await flaskEndpoints(c)));
    else out.push(...(await fastapiEndpoints(c))); // default python HTTP detector
  } else if (lang === "node") {
    if (fw === "next" || fw === "remix") out.push(...(await nextActionAndRouteEndpoints(c)));
    else if (fw === "nestjs") out.push(...(await nestEndpoints(c)));
    else out.push(...(await expressEndpoints(c))); // express/fastify/hono/generic
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
//  STORE (DATASTORE) DETECTION  — broad engine catalog
// ══════════════════════════════════════════════════════════════════════════

// db is the colour bucket ("bigquery"|"sql"|"firestore" get dedicated colours;
// anything else renders as a generic store). engine is the precise label.
interface StoreEngine {
  engine: string;
  db: string;
  signature: RegExp;
  minable: boolean; // can we mine concrete table/collection names?
}

const ENGINES: StoreEngine[] = [
  { engine: "bigquery", db: "bigquery", signature: /google\.cloud\.bigquery|@google-cloud\/bigquery|\bbigquery\.Client|from\s+google\.cloud\s+import\s+bigquery/i, minable: true },
  { engine: "firestore", db: "firestore", signature: /firebase[_-]admin|google\.cloud\.firestore|firebase\/firestore|getFirestore|firestore\(\)/i, minable: true },
  { engine: "postgres", db: "sql", signature: /psycopg2?|asyncpg|sqlalchemy|create_engine|\bpg\b|node-postgres|"pg"|'pg'|postgres(?:ql)?:\/\//i, minable: true },
  { engine: "mysql", db: "sql", signature: /pymysql|aiomysql|mysql2|mysql:\/\//i, minable: true },
  { engine: "sqlite", db: "sql", signature: /sqlite3|better-sqlite3|aiosqlite/i, minable: true },
  { engine: "mongodb", db: "mongodb", signature: /pymongo|mongoose|mongodb(?:\+srv)?:\/\/|from\s+motor/i, minable: false },
  { engine: "dynamodb", db: "dynamodb", signature: /@aws-sdk\/client-dynamodb|DynamoDBClient|boto3[\s\S]{0,40}dynamodb|\.resource\(\s*["']dynamodb["']\)|\.client\(\s*["']dynamodb["']\)/i, minable: false },
  { engine: "s3", db: "s3", signature: /@aws-sdk\/client-s3|S3Client|boto3[\s\S]{0,40}["']s3["']|\.client\(\s*["']s3["']\)/i, minable: false },
  { engine: "cosmos", db: "cosmos", signature: /@azure\/cosmos|azure\.cosmos|CosmosClient/i, minable: false },
  { engine: "redis", db: "redis", signature: /\bioredis\b|from\s+redis|import\s+redis|redis\.createClient|new\s+Redis\(/i, minable: false },
];

// ── SQL / BigQuery table mining from string literals ──────────────────────────
//
// Precision strategy. SQL written against BigQuery ALWAYS fully-qualifies tables
// (`project.dataset.table`, interpolation allowed: `{proj}.{ds}.trade_signals`),
// whereas CTEs and aliases are BARE single tokens (`FROM deduped`, `JOIN t`).
// So for BigQuery we accept ONLY dotted references and take the last segment —
// that one rule drops the entire CTE / alias / keyword noise class. Bare table
// names are mined only for a genuinely bare-table SQL engine (Postgres/MySQL/
// SQLite) and only when BigQuery is NOT in play, with CTE + keyword + alias
// filtering on top.

const SQL_STATEMENT = /\b(SELECT|INSERT\s+INTO|UPDATE)\b[\s\S]*\b(FROM|INTO|SET|JOIN)\b|\bDELETE\s+FROM\b|\bMERGE\s+INTO\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\b/i;

// A dotted reference segment: a bare identifier OR a `{…}` / `${…}` interpolation.
const SEG = String.raw`(?:\$?\{[^}]+\}|\`?[A-Za-z_][\w-]*\`?)`;
// Table clauses, capturing a DOTTED reference (≥2 segments) → BigQuery table.
const FQN_CLAUSES: Array<{ re: RegExp; write: boolean }> = [
  { re: new RegExp(String.raw`\bFROM\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: false },
  { re: new RegExp(String.raw`\bJOIN\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: false },
  { re: new RegExp(String.raw`\bINSERT\s+INTO\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: true },
  { re: new RegExp(String.raw`\bMERGE\s+(?:INTO\s+)?\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: true },
  { re: new RegExp(String.raw`\bUPDATE\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: true },
  { re: new RegExp(String.raw`\bDELETE\s+FROM\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: true },
  { re: new RegExp(String.raw`\b(?:CREATE|REPLACE|TRUNCATE)\s+(?:OR\s+REPLACE\s+)?TABLE\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"), write: true },
];
// Bare table clauses (single identifier) — only used for non-BQ SQL engines.
const BARE_CLAUSES: Array<{ re: RegExp; write: boolean }> = [
  { re: /\bFROM\s+([A-Za-z_]\w*)/gi, write: false },
  { re: /\bJOIN\s+([A-Za-z_]\w*)/gi, write: false },
  { re: /\bINSERT\s+INTO\s+([A-Za-z_]\w*)/gi, write: true },
  { re: /\bUPDATE\s+([A-Za-z_]\w*)\s+SET\b/gi, write: true },
  { re: /\bDELETE\s+FROM\s+([A-Za-z_]\w*)/gi, write: true },
];
const SQL_KEYWORDS = new Set([
  "select", "from", "where", "join", "on", "as", "and", "or", "group", "order", "by",
  "limit", "offset", "having", "qualify", "partition", "cluster", "over", "with",
  "union", "all", "distinct", "case", "when", "then", "else", "end", "unnest",
  "values", "set", "into", "using", "cross", "inner", "left", "right", "outer",
  "full", "if", "ifnull", "coalesce", "date", "datetime", "timestamp", "json",
  "null", "true", "false", "exists", "in", "not", "is", "asc", "desc", "lateral",
  "the", "this", "these", "those", "table", "row", "rows", "between", "like",
]);

// Identifiers that are dotted like a table ref but never name a user table.
const NON_TABLE = new Set([
  "dataframe", "columns", "tables", "partitions", "logger", "log", "dataset",
  "dataset_id", "table_id", "project", "project_id", "client", "self", "py",
  "md", "info", "debug", "warning", "error", "live", "staging", "stg", "snap",
  "tbl", "col", "tmp", "temp", "prod", "dev",
]);

// Last dotted segment of an FQN reference, cleaned of backticks/interpolation.
// Returns null for aliases / non-table identifiers (short, keyword, code-ish).
function lastSegment(ref: string): string | null {
  if (/information_schema/i.test(ref)) return null; // metadata views, not tables
  const seg = (ref.split(".").pop() ?? "").trim();
  if (/^\$?\{.*\}$/.test(seg)) return null; // pure interpolation → dynamic name, unresolvable
  const cleaned = seg.replace(/[`${}]/g, "").trim();
  if (!/^[A-Za-z]\w*$/.test(cleaned)) return null; // must start with a letter (no _private)
  const lc = cleaned.toLowerCase();
  if (cleaned.length < 3) return null; // 1–2 char tokens are table aliases
  if (SQL_KEYWORDS.has(lc) || NON_TABLE.has(lc)) return null;
  return cleaned;
}

// A real fully-qualified table reference carries interpolation (built from a
// dataset var) or has ≥3 segments — distinguishing `{ds}.timeseries` /
// `proj.ds.table` from a 2-part Python attribute string like `pd.DataFrame`.
function looksLikeFqn(ref: string): boolean {
  return /[{}]/.test(ref) || (ref.match(/\./g) || []).length >= 2;
}

// CTE names declared in a query (`WITH x AS (`, `, y AS (`) — excluded from tables.
function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:\bWITH\s+|,\s*)([A-Za-z_]\w*)\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.add(m[1].toLowerCase());
  return out;
}

function stringLiterals(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      let buf = "";
      while (j < body.length) {
        const d = body[j];
        if (d === "\\") { buf += body[j + 1] ?? ""; j += 2; continue; }
        if (d === quote) break;
        buf += d;
        j++;
      }
      out.push(buf);
      i = j + 1;
      continue;
    }
    if (c === "#") { const nl = body.indexOf("\n", i); i = nl < 0 ? body.length : nl; continue; }
    if (c === "/" && body[i + 1] === "/") { const nl = body.indexOf("\n", i); i = nl < 0 ? body.length : nl; continue; }
    if (c === "/" && body[i + 1] === "*") { const end = body.indexOf("*/", i); i = end < 0 ? body.length : end + 2; continue; }
    i++;
  }
  return out;
}

interface SqlStores {
  bq: Set<string>; bqWrites: Set<string>;
  bare: Set<string>; bareWrites: Set<string>;
}
function extractSqlBqStores(body: string, opts: { bqPresent: boolean; bareSql: boolean }): SqlStores {
  const bq = new Set<string>(), bqWrites = new Set<string>();
  const bare = new Set<string>(), bareWrites = new Set<string>();
  for (const raw of stringLiterals(body)) {
    // Whole literal is itself a table reference (an id handed to a BQ client)?
    const trimmed = raw.trim();
    const wholeIsFqn =
      new RegExp(String.raw`^${SEG}(?:\.${SEG}){1,2}$`).test(trimmed) &&
      /[A-Za-z]/.test(trimmed) && looksLikeFqn(trimmed);
    const isSql = SQL_STATEMENT.test(raw);
    if (!isSql && !wholeIsFqn) continue;

    // Dotted (BigQuery) references — the reliable, low-noise signal.
    if (opts.bqPresent) {
      if (wholeIsFqn) {
        const t = lastSegment(trimmed);
        if (t) bq.add(t);
      }
      let m: RegExpExecArray | null;
      for (const { re, write } of FQN_CLAUSES) {
        re.lastIndex = 0;
        while ((m = re.exec(raw))) {
          if (!looksLikeFqn(m[1])) continue;
          const t = lastSegment(m[1]);
          if (!t) continue;
          bq.add(t);
          if (write) bqWrites.add(t);
        }
      }
    }

    // Bare table names — only for a real bare-table SQL engine, and only when
    // BigQuery isn't the dialect in play (else every CTE looks like a table).
    if (isSql && opts.bareSql && !opts.bqPresent) {
      const ctes = cteNames(raw);
      let m: RegExpExecArray | null;
      for (const { re, write } of BARE_CLAUSES) {
        re.lastIndex = 0;
        while ((m = re.exec(raw))) {
          const t = m[1];
          const lt = t.toLowerCase();
          if (t.length < 3 || SQL_KEYWORDS.has(lt) || ctes.has(lt)) continue;
          bare.add(t);
          if (write) bareWrites.add(t);
        }
      }
    }
  }
  return { bq, bqWrites, bare, bareWrites };
}

// ── Firestore collection mining (`.collection('x')`) ──────────────────────────

const FS_WRITE_OPS = ["set", "add", "update", "create", "delete"];
function extractFirestoreCollections(body: string): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  // Resolve simple module-scope constants: NAME = 'collection'.
  const consts = new Map<string, string>();
  const cre = /(?:const|let|var)?\s*([A-Z][A-Z0-9_]*)\s*=\s*["'`]([A-Za-z0-9_./-]+)["'`]/g;
  let cm: RegExpExecArray | null;
  while ((cm = cre.exec(body))) consts.set(cm[1], cm[2]);

  // Admin-SDK / namespaced form: `db.collection('x')` / `.collectionGroup('x')`.
  // Modular Firebase v9 form: `collection(db, 'x')` / `collectionGroup(db, 'x')`.
  const collRe = /\.collection(?:Group)?\s*\(\s*([^),]*?)\s*[),]|(?<![.\w])collection(?:Group)?\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*([^),]*?)\s*[),]/g;
  let m: RegExpExecArray | null;
  while ((m = collRe.exec(body))) {
    const arg = (m[1] ?? m[2] ?? "").trim();
    const lit = arg.match(/^["'`]([A-Za-z0-9_./-]+)["'`]$/);
    const name = lit ? lit[1] : consts.get(arg) ?? null;
    if (!name) continue;
    if (/^(firestore|collection|doc|db|database)$/i.test(name)) continue; // not a real collection name
    // Look just past the collection chain for a terminal op to guess read/write.
    const tail = body.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const isWrite = FS_WRITE_OPS.some((op) => new RegExp(`\\.${op}\\s*\\(`).test(tail))
      || /\b(setDoc|addDoc|updateDoc|deleteDoc)\s*\(/.test(tail);
    (isWrite ? writes : reads).add(name);
  }
  return { reads, writes };
}

interface StoreHit { engine: string; db: string; name: string; write: boolean }

// Scan a set of source files; return the concrete stores they touch.
async function minesStores(files: string[]): Promise<StoreHit[]> {
  const hits = new Map<string, StoreHit>();
  const put = (engine: string, db: string, name: string, write: boolean) => {
    const k = `${db}:${name}`;
    const ex = hits.get(k);
    if (ex) { if (write) ex.write = true; }
    else hits.set(k, { engine, db, name, write });
  };

  // Which engines are present at all (by signature) across these files.
  const presentEngines = new Set<string>();
  let combined = "";
  for (const f of files) combined += (await readCached(f)) ?? "";
  for (const e of ENGINES) if (e.signature.test(combined)) presentEngines.add(e.engine);

  const bqPresent = presentEngines.has("bigquery");
  const bareSqlEngine = ["postgres", "mysql", "sqlite"].find((e) => presentEngines.has(e));
  for (const f of files) {
    const src = await readCached(f);
    if (!src) continue;
    // SQL / BigQuery tables.
    if (bqPresent || bareSqlEngine) {
      const { bq, bqWrites, bare, bareWrites } = extractSqlBqStores(src, { bqPresent, bareSql: !!bareSqlEngine });
      for (const t of bq) put("bigquery", "bigquery", t, bqWrites.has(t));
      for (const t of bare) put(bareSqlEngine ?? "postgres", "sql", t, bareWrites.has(t));
    }
    // Firestore collections.
    if (presentEngines.has("firestore")) {
      const { reads, writes } = extractFirestoreCollections(src);
      for (const n of reads) put("firestore", "firestore", n, false);
      for (const n of writes) put("firestore", "firestore", n, true);
    }
  }

  // Engines that are present but whose concrete names we can't resolve → one
  // generic node. We emit this for non-minable engines (Mongo/Dynamo/S3/Cosmos/
  // Redis) always, and for a bare-SQL engine whose table mining was suppressed
  // by a BigQuery dialect in the same container. We do NOT emit a generic node
  // for BigQuery/Firestore (their concrete names are mined elsewhere).
  const GENERIC_LABEL: Record<string, string> = {
    s3: "S3", redis: "Redis", dynamodb: "DynamoDB", cosmos: "Cosmos DB",
    mongodb: "MongoDB", postgres: "Postgres", mysql: "MySQL", sqlite: "SQLite",
  };
  for (const e of ENGINES) {
    if (!presentEngines.has(e.engine)) continue;
    if ([...hits.values()].some((h) => h.engine === e.engine)) continue; // already have concrete names
    const suppressedSql = e.db === "sql" && bqPresent; // its tables weren't mined (BQ dialect)
    if (e.minable && !suppressedSql) continue; // don't emit generic bigquery/firestore
    const label = GENERIC_LABEL[e.engine] ?? e.engine;
    if (!hits.has(`${e.db}:${label}`)) put(e.engine, e.db, label, false);
  }
  return [...hits.values()];
}

// ══════════════════════════════════════════════════════════════════════════
//  FRONTEND REACHABILITY (for fetch edges)
// ══════════════════════════════════════════════════════════════════════════

async function resolveLocalImport(fromFile: string, spec: string, aliasRoots: string[]): Promise<string | null> {
  let base: string;
  if (spec.startsWith("@/")) {
    // Try each alias root (frontend root, then root/src).
    for (const ar of aliasRoots) {
      const cand = join(ar, spec.slice(2));
      const r = await resolveWithExt(cand);
      if (r) return r;
    }
    return null;
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = join(dirname(fromFile), spec);
  } else {
    return null;
  }
  return resolveWithExt(base);
}

async function resolveWithExt(base: string): Promise<string | null> {
  if (/\.[tj]sx?$/.test(base) && (await exists(base))) return base;
  const candidates = [
    base + ".tsx", base + ".ts", base + ".jsx", base + ".js",
    join(base, "index.tsx"), join(base, "index.ts"), join(base, "index.jsx"), join(base, "index.js"),
  ];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

function localImportSpecs(src: string): string[] {
  const specs: string[] = [];
  const res = [
    /(?:import|export)\b[^'"`]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const s = m[1];
      if (s.startsWith("@/") || s.startsWith("./") || s.startsWith("../")) specs.push(s);
    }
  }
  return specs;
}

async function collectReachable(pageFile: string, aliasRoots: string[], cache: Map<string, string[]>): Promise<string[]> {
  const seen = new Set<string>([pageFile]);
  let frontier = [pageFile];
  for (let depth = 0; depth < MAX_REACHABLE_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      let specs = cache.get(f);
      if (!specs) {
        const src = await readCached(f);
        specs = src ? localImportSpecs(src) : [];
        cache.set(f, specs);
      }
      for (const spec of specs) {
        const resolved = await resolveLocalImport(f, spec, aliasRoots);
        if (resolved && !seen.has(resolved)) { seen.add(resolved); next.push(resolved); }
      }
    }
    frontier = next;
  }
  return [...seen];
}

// Mine the API path strings a page calls. We take URL-path string literals from
// the page's reachable files and match them against the known endpoint index.
function apiPathLiterals(src: string): string[] {
  const out: string[] = [];
  // String literals that look like a URL path: start "/", have a path-ish body.
  const re = /["'`](\/[A-Za-z0-9_][A-Za-z0-9_./${}\[\]:-]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const p = m[1].split("?")[0];
    if (p.length > 1 && !/\.(png|jpe?g|svg|css|js|ico|woff2?|webp|gif)$/i.test(p)) out.push(p);
  }
  // Template-literal fetches: `${base}/path`.
  const tpl = /`\$\{[^}]*\}(\/[A-Za-z0-9_./${}\[\]:-]+)/g;
  while ((m = tpl.exec(src))) out.push(m[1].split("?")[0]);
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
//  COMPOSE THE GRAPH
// ══════════════════════════════════════════════════════════════════════════

export async function buildDataflowGraph(): Promise<DFGraph> {
  FILE_CACHE.clear();
  const warnings: { kind: string; detail: string }[] = [];

  // 1) Containers (with source roots + lang/framework).
  const containers = await detectContainers(warnings);

  // 2) Endpoints (per container, by framework).
  const endpoints: Endpoint[] = [];
  for (const c of containers) endpoints.push(...(await detectEndpoints(c)));

  // 3) Frontend routes (per node/frontend container).
  const routes: Route[] = [];
  const frontendContainers = containers.filter((c) => {
    const fw = c.info?.framework;
    return c.info?.lang === "node" && (fw === "next" || fw === "remix" || fw === "vite" || fw === "react" || fw === "vue" || fw === "sveltekit");
  });
  for (const c of frontendContainers) routes.push(...(await detectFrontendRoutes(c, warnings)));

  // 4) Store attribution.
  //    Per-endpoint: scan the endpoint's own file + sibling source files in the
  //    same dir (captures the router.py + queries.py colocated pattern, and
  //    inline-handler frameworks). Remaining container stores → container edges.
  const storeNodes = new Map<string, DFNode>();
  const ensureStore = (engine: string, db: string, name: string) => {
    const id = `store:${db}:${name}`;
    if (!storeNodes.has(id)) {
      const data: DFNode["data"] = { id, label: name, kind: "store", db };
      if (engine && engine !== db) data.engine = engine;
      storeNodes.set(id, { data });
    }
    return id;
  };

  // Edges accumulator.
  interface RawEdge { source: string; target: string; kind: EdgeKind; cached?: boolean }
  const rawEdges: RawEdge[] = [];

  // Cache directory listings of source siblings.
  const dirFilesCache = new Map<string, string[]>();
  const siblingSources = async (absFile: string): Promise<string[]> => {
    const d = dirname(absFile);
    if (dirFilesCache.has(d)) return dirFilesCache.get(d)!;
    let files: string[] = [];
    try {
      const entries = await readdir(d);
      for (const n of entries) {
        if (SRC_EXT.test(n)) files.push(join(d, n));
      }
    } catch { /* ignore */ }
    dirFilesCache.set(d, files);
    return files;
  };

  const containerStoreFiles = new Map<string, string[]>(); // container id → all source files
  const containerAttributed = new Map<string, Set<string>>(); // container id → store ids already on an endpoint

  for (const ep of endpoints) {
    // Stores resolvable from the endpoint's file + same-dir siblings.
    const scanFiles = ep.access === "server-action"
      ? [ep.absFile]
      : await siblingSources(ep.absFile);
    const hits = await minesStores(scanFiles);
    for (const h of hits) {
      const sid = ensureStore(h.engine, h.db, h.name);
      rawEdges.push({ source: ep.id, target: sid, kind: h.write ? "writes" : "reads" });
      if (!containerAttributed.has(ep.containerId)) containerAttributed.set(ep.containerId, new Set());
      containerAttributed.get(ep.containerId)!.add(sid);
    }
  }

  // Container-level stores not already attributed to an endpoint.
  for (const c of containers) {
    let files = containerStoreFiles.get(c.id);
    if (!files) {
      files = await walk(c.root, (_f, n) => SRC_EXT.test(n));
      containerStoreFiles.set(c.id, files);
    }
    const hits = await minesStores(files);
    const attributed = containerAttributed.get(c.id) ?? new Set<string>();
    for (const h of hits) {
      const sid = `store:${h.db}:${h.name}`;
      if (attributed.has(sid)) continue; // already shown via a specific endpoint
      ensureStore(h.engine, h.db, h.name);
      rawEdges.push({ source: c.id, target: sid, kind: h.write ? "writes" : "reads" });
    }
  }

  // 5) Fetch edges: build a path index, then wire route → proxy → backend.
  const backendEndpoints = endpoints.filter((e) => e.access === "api-route" && !frontendContainers.some((fc) => fc.id === e.containerId));
  const proxyEndpoints = endpoints.filter((e) => frontendContainers.some((fc) => fc.id === e.containerId) && e.access === "api-route");

  const backendByPath = new Map<string, string[]>(); // normPath → endpoint ids
  for (const e of backendEndpoints) {
    if (!e.path) continue;
    const k = normPath(e.path);
    (backendByPath.get(k) ?? backendByPath.set(k, []).get(k)!).push(e.id);
  }
  const proxyByPath = new Map<string, string>(); // normPath(apiPath) → proxy id
  for (const e of proxyEndpoints) if (e.path) proxyByPath.set(normPath(e.path), e.id);

  // proxy → backend (parsed from `${BACKEND_URL}/path` targets).
  for (const e of proxyEndpoints) {
    for (const target of e.proxyTo) {
      const ids = backendByPath.get(normPath(target));
      if (ids) for (const id of ids) rawEdges.push({ source: e.id, target: id, kind: "fetch" });
    }
  }

  // route → (proxy | backend), matched from API path literals in reachable files.
  for (const c of frontendContainers) {
    const aliasRoots = [c.root, join(c.root, "src")];
    const importCache = new Map<string, string[]>();
    const cRoutes = routes.filter((r) => r.containerId === c.id);
    for (const r of cRoutes) {
      const pageAbs = join(REPO_ROOT, r.file);
      const reachable = await collectReachable(pageAbs, aliasRoots, importCache);
      const matched = new Set<string>();
      let cached = false;
      for (const f of reachable) {
        const src = await readCached(f);
        if (!src) continue;
        if (/\buseQuery|useSuspenseQuery|useInfiniteQuery|useMutation\b/.test(src)) cached = true;
        for (const lit of apiPathLiterals(src)) {
          const np = normPath(lit);
          // Prefer a proxy endpoint; else strip a leading /api and hit the backend.
          if (proxyByPath.has(np)) { matched.add(proxyByPath.get(np)!); continue; }
          const stripped = np.replace(/^\/api(?=\/)/, "") || "/";
          const beIds = backendByPath.get(np) ?? backendByPath.get(stripped);
          if (beIds) for (const id of beIds) matched.add(id);
        }
      }
      r.cached = cached && matched.size > 0;
      for (const epId of matched) rawEdges.push({ source: r.id, target: epId, kind: "fetch", cached: r.cached });
    }
  }

  // 6) Materialize nodes + edges (flat, deduped).
  const nodes: DFNode[] = [];
  const nodeIds = new Set<string>();
  const addNode = (n: DFNode) => { if (!nodeIds.has(n.data.id)) { nodes.push(n); nodeIds.add(n.data.id); } };

  for (const c of containers) {
    addNode({ data: {
      id: c.id, label: c.name, kind: "container",
      ...(c.platform ? { platform: c.platform } : {}),
      ...(c.info?.lang ? { lang: c.info.lang } : {}),
      ...(c.info?.framework ? { framework: c.info.framework } : {}),
      ...(c.file ? { file: c.file } : {}),
    } });
  }
  for (const ep of endpoints) {
    addNode({ data: {
      id: ep.id, label: ep.label, kind: "endpoint", access: ep.access,
      ...(ep.method ? { method: ep.method } : {}),
      file: ep.file, container: ep.containerId,
    } });
    rawEdges.push({ source: ep.containerId, target: ep.id, kind: "hosts" });
  }
  for (const s of storeNodes.values()) addNode(s);
  for (const r of routes) {
    addNode({ data: { id: r.id, label: r.cached ? `⚡ ${r.path}` : r.path, kind: "fe-route", cached: r.cached, file: r.file } });
    if (r.containerId) rawEdges.push({ source: r.containerId, target: r.id, kind: "hosts" });
  }

  // Dedupe edges; drop any that reference a missing node.
  const edges: DFEdge[] = [];
  const edgeSeen = new Set<string>();
  let edgeIdx = 0;
  for (const e of rawEdges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const key = `${e.source}->${e.target}:${e.kind}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    const data: DFEdge["data"] = { id: `e${edgeIdx++}`, source: e.source, target: e.target, kind: e.kind };
    if (e.cached !== undefined) data.cached = e.cached;
    edges.push({ data });
  }

  // 7) Warnings (never silently drop; surface gaps).
  if (containers.length === 0) warnings.push({ kind: "no-container", detail: "no deploy unit detected" });
  if (endpoints.length === 0) warnings.push({ kind: "no-endpoints", detail: "no HTTP endpoints / server actions detected across any container" });
  if (routes.length === 0) warnings.push({ kind: "no-frontend", detail: "no frontend routes detected (no Next app/pages dir, no React-Router route table)" });
  if (storeNodes.size === 0) warnings.push({ kind: "no-stores", detail: "no datastore usage detected (BigQuery/SQL/Firestore/Mongo/DynamoDB/Cosmos/Redis)" });
  const reached = new Set<string>();
  for (const e of edges) if (e.data.kind === "fetch") reached.add(e.data.target);
  const unreachedBackend = backendEndpoints.filter((e) => !reached.has(e.id)).length;
  if (backendEndpoints.length && unreachedBackend === backendEndpoints.length) {
    warnings.push({ kind: "no-fetch-edges", detail: "no frontend→backend calls could be matched by path — endpoints shown unlinked" });
  }

  const counts = {
    routes: nodes.filter((n) => n.data.kind === "fe-route").length,
    containers: nodes.filter((n) => n.data.kind === "container").length,
    endpoints: nodes.filter((n) => n.data.kind === "endpoint").length,
    stores: nodes.filter((n) => n.data.kind === "store").length,
    edges: edges.length,
  };
  return { nodes, edges, meta: { built: new Date().toISOString(), counts, warnings } };
}
