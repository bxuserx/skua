// Generic, detection-based multi-database schema graph for the dashboard's
// /graphs/schemas view.
//
// Generalizes a BigQuery-specific schema builder into a MULTI-DATABASE
// diagram. It auto-detects which databases a repo uses —
// Firestore/Firebase, SQL (Prisma / Drizzle / raw .sql), and BigQuery — and
// renders each database's tables/collections + columns/fields + relationships,
// merged into one Cytoscape graph and tagged per `db`.
//
//   table  (compound parent) ──contains──▶ column (child, data.parent = table)
//   column ──fk-reference──▶ column            (FK-by-convention: *Id → that table)
//   column ──joins──▶ column                   (SQL/BQ JOIN ... ON / USING)
//   table  ──subcollection──▶ table            (Firestore parent → subcollection)
//
// This is the ONE graph that uses Cytoscape compound parent nodes (every column
// declares data.parent = its table id); the viewer collapses tables by default.
//
// Each DB lives behind a SchemaProvider seam (extracted from the original
// single-database builder) so the set of databases is open: a provider
// detect()s its own usage and introspect()s
// either statically (parse source, no credentials) or live (behind opts.live).
// If NO database is detected the graph is empty plus a "no-database" warning —
// it never crashes on an arbitrary repo.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { REPO_ROOT } from "../../skua.config.ts";

// ── Public types (Cytoscape shape) ────────────────────────────────────────────

// A database grouping key (node-id prefix + colour). The first-class providers use
// "firestore" | "sql" | "bigquery"; generic-detector engines use their own key
// (e.g. "mongodb", "redshift", "pgvector"). Kept open (string) so the set extends.
export type Db = string;
type NodeKind = "table" | "column";
// "fk-reference" (not "references") deliberately avoids colliding with the AI
// graph's edge[kind="references"] style — all graph styles share one array.
type EdgeKind = "fk-reference" | "joins" | "subcollection";

// ── Database-class taxonomy (the 6 canonical categories) ──────────────────────
// Every detected engine maps to ONE class; each class implies a family of data-
// organization / query-optimization mechanisms. Single source of truth shared by
// the providers + the dashboard legend. Full contract: ./DB_CLASSES.md.
export type DbClass =
  | "relational"  // 1. SQL — Postgres / MySQL / SQL Server / SQLite
  | "document"    // 2. Document / Key-Value — Firestore / Mongo / DynamoDB / Redis
  | "analytical"  // 3. OLAP / Columnar — BigQuery / Redshift / Snowflake
  | "newsql"      // 4. Distributed Global Relational — Spanner / Cockroach / Yugabyte
  | "wide-column" // 5. Wide-Column / Time-Series — Cassandra / Bigtable / HBase
  | "vector";     // 6. Vector / ANN — Pinecone / Milvus / pgvector

// engine (lowercased product name) → class. Open table: add a row and that
// engine classifies automatically.
export const DB_CLASS_OF: Record<string, DbClass> = {
  postgres: "relational", postgresql: "relational", mysql: "relational",
  mariadb: "relational", sqlite: "relational", sqlserver: "relational",
  mssql: "relational", oracle: "relational",
  firestore: "document", mongodb: "document", dynamodb: "document",
  redis: "document", documentdb: "document", cosmos: "document", couchbase: "document",
  bigquery: "analytical", redshift: "analytical", snowflake: "analytical",
  synapse: "analytical", databricks: "analytical", clickhouse: "analytical",
  spanner: "newsql", cockroachdb: "newsql", yugabyte: "newsql",
  cassandra: "wide-column", scylla: "wide-column", bigtable: "wide-column",
  hbase: "wide-column", timestream: "wide-column", keyspaces: "wide-column",
  pinecone: "vector", milvus: "vector", qdrant: "vector",
  weaviate: "vector", pgvector: "vector",
};

// One-line "optimization family" per class — for the dashboard legend/tooltip.
export const DB_CLASS_OPTIMIZATIONS: Record<DbClass, string> = {
  relational: "B-tree/Hash/GIN/GiST indexes · covering (INCLUDE) · RANGE/LIST/HASH partitioning · FKs",
  document: "composite & single-field indexes · GSI/LSI · composite keys · TTL eviction",
  analytical: "columnar storage · partitioning · clustering / sort keys · MPP distribution · materialized views",
  newsql: "interleaved (co-located) tables · non-sequential PKs · range-split directories",
  "wide-column": "row-key engineering · column families · size-tiered / leveled compaction",
  vector: "HNSW · IVF-PQ · scalar quantization (approximate nearest-neighbor)",
};

export interface SchemaNode {
  data: {
    id: string; // table → "<db>:<name>"; column → "<db>:<table>.<col>"
    label: string;
    kind: NodeKind;
    db: Db;
    // table-only
    engine?: string; // concrete product, e.g. "PostgreSQL" / "BigQuery" / "Firestore"
    dbClass?: DbClass; // taxonomy class implied by the engine
    optimizations?: TableOptimizations;
    matview?: boolean;
    partitionField?: string;
    clusterFields?: string[];
    subOf?: string; // firestore subcollections only — parent table id
    // column-only
    parent?: string; // column → its table id (Cytoscape compound)
    fieldType?: string;
    mode?: string; // REQUIRED / NULLABLE / REPEATED
    description?: string;
    isKey?: boolean;
  };
}

export interface SchemaEdge {
  data: {
    id: string;
    source: string;
    target: string;
    kind: EdgeKind;
    label?: string; // the referencing field / join key
    confidence?: "high" | "low";
    sourceFile?: string;
  };
}

export interface SchemasGraph {
  nodes: SchemaNode[];
  edges: SchemaEdge[];
  meta: {
    built: string;
    source: "static" | "live";
    counts: Record<string, number>;
    warnings: Warning[];
    databases: { db: Db; engine: string; dbClass: DbClass; tables: number }[];
  };
}

export type Warning = { kind: string; detail: string };

// ── Provider seam ─────────────────────────────────────────────────────────────
//
// DB-agnostic intermediate representation. Each provider lowers its own world
// (Firestore code, Prisma models, BQ SchemaField calls, …) into TableDef[] +
// RelationDef[]; buildSchemasGraph() renders the union.

export interface FieldDef {
  name: string;
  type?: string; // fieldType
  mode?: string; // REQUIRED / NULLABLE / REPEATED
  description?: string;
  isKey?: boolean;
}

export interface IndexDef {
  name?: string;
  columns: string[];
  method?: string; // btree | hash | gin | gist | brin | spgist
  unique?: boolean;
  covering?: string[]; // INCLUDE columns (covering index)
  where?: string; // partial-index predicate
}

export interface PartitionDef {
  strategy: "RANGE" | "LIST" | "HASH" | "TIME";
  key: string;
  unit?: string; // DAY / HOUR / MONTH / YEAR for time partitioning
  requireFilter?: boolean; // BQ require_partition_filter
}

// Per-class, open optimization record. A provider fills only the slots its class
// uses (see DB_CLASSES.md); the card renderer summarizes whatever is present.
export interface TableOptimizations {
  primaryKey?: string[];
  indexes?: IndexDef[]; // relational / analytical search indexes
  partition?: PartitionDef; // relational / analytical
  clustering?: string[]; // analytical cluster / sort keys
  materialized?: boolean; // analytical matview
  distribution?: string; // MPP distribution style (KEY / EVEN / ALL)
  compositeIndexes?: { fields: string[]; scope?: string }[]; // document (Firestore / Mongo)
  ttl?: { field?: string; note?: string }; // document TTL eviction
  rowKey?: string; // wide-column row-key design
  columnFamilies?: string[]; // wide-column
  vectorIndex?: { method: string; metric?: string; dims?: number }; // vector
  notes?: string[]; // detected-but-unmodeled extras
}

export interface TableDef {
  db: Db;
  name: string;
  fields: FieldDef[];
  engine?: string; // concrete product (set by the provider)
  dbClass?: DbClass; // taxonomy class
  optimizations?: TableOptimizations;
  matview?: boolean;
  partitionField?: string;
  clusterFields?: string[];
  subOf?: string; // firestore: bare name of the parent collection
}

export interface RelationDef {
  db: Db;
  kind: EdgeKind;
  // Endpoints are bare names. For column endpoints set the *Col fields too;
  // a relation with only table names renders as a table↔table edge.
  fromTable: string;
  fromCol?: string;
  toTable: string;
  toCol?: string;
  label?: string;
  confidence?: "high" | "low";
  sourceFile?: string;
}

export interface ProviderResult {
  tables: TableDef[];
  relations: RelationDef[];
  warnings: Warning[];
}

export interface SchemaProvider {
  db: Db;
  engine: string; // concrete product name (may be refined during detect/introspect)
  dbClass: DbClass; // taxonomy class
  detect(): Promise<boolean>;
  introspect(opts: { live?: boolean }): Promise<ProviderResult>;
}

// ── Shared filesystem helpers ─────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build",
  "out", "__pycache__", ".venv", "venv", ".turbo", "coverage", ".cache",
  "vendor", "target", ".idea", ".vscode", ".skua", ".pytest_cache", ".mypy_cache",
]);

const MAX_FILE_BYTES = 400_000;

async function walk(root: string, keep: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const rel = relative(root, full);
        if (keep(rel)) out.push(rel);
      }
    }
  }
  return out;
}

async function readPackageJson(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function depNames(pkg: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>();
  if (!pkg) return names;
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = pkg[key];
    if (block && typeof block === "object") {
      for (const dep of Object.keys(block as Record<string, unknown>)) names.add(dep);
    }
  }
  return names;
}

const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
function isTsLike(rel: string): boolean {
  return TS_EXTS.has(extname(rel).toLowerCase());
}

// ── FirestoreProvider ─────────────────────────────────────────────────────────
//
// Static introspection from code. We never need credentials: collections come
// from `.collection('x')` / `.collectionGroup('x')` call sites (the bare string,
// a `const X_COLLECTION = 'x'` constant, or a `.doc(...).collection('child')`
// subcollection chain), and fields come from the object literals written to a
// collection (`.set/.add/.update/.create({...})`) merged with any matching
// TypeScript interface/type.

const COLL_DIRS = ["src", "app", "lib", "server", "functions", "pages", "components"];

interface FsCollection {
  name: string;
  parent?: string; // subcollection parent name
  fields: Map<string, FieldDef>;
}

export class FirestoreProvider implements SchemaProvider {
  db: Db = "firestore";
  engine = "Firestore";
  dbClass: DbClass = "document";

  async detect(): Promise<boolean> {
    const deps = depNames(await readPackageJson());
    if (deps.has("firebase-admin") || deps.has("@google-cloud/firestore") || deps.has("firebase")) {
      return true;
    }
    // Fall back to call-site evidence for repos that vendor the SDK or use a
    // monorepo root without the dep in this package.json.
    for (const rel of await this.sourceFiles()) {
      const src = await safeRead(rel);
      if (src && /\.(collection|collectionGroup|doc)\s*\(/.test(src)) return true;
    }
    return false;
  }

  private async sourceFiles(): Promise<string[]> {
    // Repo-wide, language-agnostic: Firestore is reached from a frontend in any
    // subdir (TS modular `collection(db,'x')`) AND from backend admin SDKs
    // (Python/Go `.collection('x')`). `walk` already skips node_modules/.venv/etc.
    return walk(REPO_ROOT, (rel) => isTsLike(rel) || rel.endsWith(".py") || rel.endsWith(".go"));
  }

  async introspect(opts: { live?: boolean }): Promise<ProviderResult> {
    const warnings: Warning[] = [];
    if (opts.live) {
      // ── Live seam ────────────────────────────────────────────────────────
      // A real live path would `import { getFirestore } from "firebase-admin/firestore"`,
      // call db.listCollections() for top-level collections, sample a document
      // per collection (and per subcollection via doc.ref.listCollections()) to
      // recover field names/types from real data. That needs a service-account
      // credential (GOOGLE_APPLICATION_CREDENTIALS) which we don't assume here,
      // so we fall back to the static parse and warn.
      warnings.push({
        kind: "live-unavailable",
        detail: "firestore live introspection needs credentials; using static",
      });
    }

    const files = await this.sourceFiles();
    const collections = new Map<string, FsCollection>(); // key: "parent/name" or "name"
    const subEdges = new Set<string>(); // "parent::child"
    const interfaces = new Map<string, FieldDef[]>(); // TypeName → fields

    for (const rel of files) {
      const src = await safeRead(rel);
      if (!src) continue;
      collectInterfaces(src, interfaces);
      scanFirestoreFile(src, collections, subEdges, warnings);
    }

    // Consolidate to one entry per collection NAME. A collection can get
    // registered both with a parent (subcollection chain) and parentless (a
    // ref-var chain whose `.doc()` context was elsewhere); collapse those,
    // preferring the parented entry and merging all fields, so each collection
    // is a single table. (Firestore collection names are globally unique by
    // convention even when they appear as subcollections of multiple parents.)
    const byName = new Map<string, FsCollection>();
    for (const c of collections.values()) {
      const existing = byName.get(c.name);
      if (!existing) {
        byName.set(c.name, { name: c.name, parent: c.parent, fields: new Map(c.fields) });
        continue;
      }
      if (!existing.parent && c.parent) existing.parent = c.parent;
      for (const [k, f] of c.fields) {
        const ef = existing.fields.get(k);
        if (!ef) existing.fields.set(k, { ...f });
        else if (!ef.type && f.type) ef.type = f.type;
      }
    }
    collections.clear();
    for (const [name, c] of byName) collections.set(name, c);

    // Merge TypeScript interface/type fields into collections whose singularized
    // name matches the type name (campaigns ↔ Campaign, notes ↔ Note, …). When
    // no exact name matches, fall back to a UNIQUE interface whose name ends in
    // the singular candidate (markers ↔ MapMarker) — only if unambiguous.
    const ifaceNames = [...interfaces.keys()];
    for (const coll of collections.values()) {
      const cands = typeNameCandidates(coll.name);
      const matched: FieldDef[][] = [];
      for (const cand of cands) {
        const exact = interfaces.get(cand);
        if (exact) matched.push(exact);
      }
      if (matched.length === 0) {
        for (const cand of cands) {
          const ending = ifaceNames.filter((n) => n.endsWith(cand) && n !== cand);
          if (ending.length === 1) {
            matched.push(interfaces.get(ending[0])!);
            break;
          }
        }
      }
      for (const ifFields of matched) {
        for (const f of ifFields) {
          const existing = coll.fields.get(f.name);
          if (!existing) {
            coll.fields.set(f.name, { ...f });
          } else {
            if (!existing.type && f.type) existing.type = f.type;
            if (existing.isKey === undefined && f.isKey) existing.isKey = true;
          }
        }
      }
    }

    // Key heuristics: doc-id convention fields.
    for (const coll of collections.values()) {
      for (const f of coll.fields.values()) {
        if (isKeyField(f.name)) f.isKey = true;
      }
    }

    const collByName = new Map<string, FsCollection>();
    for (const c of collections.values()) collByName.set(c.name, c);

    const tables: TableDef[] = [];
    for (const c of collections.values()) {
      tables.push({
        db: "firestore",
        name: c.name,
        subOf: c.parent,
        fields: [...c.fields.values()],
      });
    }

    const relations: RelationDef[] = [];

    // Subcollection edges.
    for (const key of subEdges) {
      const [parent, child] = key.split("::");
      relations.push({
        db: "firestore",
        kind: "subcollection",
        fromTable: parent,
        toTable: child,
      });
    }

    // FK-by-convention. A field named <x>Id / <x>Ids points at collection <x>
    // (also the common gmId/authorId/createdBy/playerIds aliases). If no such
    // collection exists the referent is an external store (e.g. Firebase Auth
    // localIds) — warn instead of drawing a dangling edge or inventing a table.
    const externalRefs = new Set<string>();
    for (const c of collections.values()) {
      for (const f of c.fields.values()) {
        const referent = referencedCollection(f.name);
        if (!referent) continue;
        const target = resolveReferent(referent, collByName);
        if (target) {
          if (target === c.name) continue; // self-id (the doc's own key)
          relations.push({
            db: "firestore",
            kind: "fk-reference",
            fromTable: c.name,
            fromCol: f.name,
            toTable: target,
            toCol: idColumnOf(collByName.get(target)!),
            label: f.name,
            confidence: "high",
          });
        } else {
          externalRefs.add(`${c.name}.${f.name}`);
        }
      }
    }
    if (externalRefs.size) {
      warnings.push({
        kind: "external-reference",
        detail:
          `${externalRefs.size} field(s) reference an external identity store ` +
          `(no matching Firestore collection — likely Firebase Auth localIds): ` +
          [...externalRefs].sort().join(", "),
      });
    }

    return { tables, relations, warnings };
  }
}

type CollRef = { name: string; parent?: string };

// Scan one source file: register every Firestore collection / subcollection it
// touches and attribute the field writes (`.set/.add/.update/.create({...})`)
// to the right collection.
//
// The hard part is resolving the *collection* a write lands on, since the chain
// can be split across `const fooRef = firestore.collection(...).doc(...)` ref
// variables and `batch.set(fooRef, {...})` two-arg writes. We do this in two
// phases: (A) resolve every ref variable to its {collection, parent} with a
// fixpoint (so `tacticalItemsRef = characterRef.collection('x')` resolves once
// `characterRef` is known), then (B) attribute writes using those bindings.
function scanFirestoreFile(
  src: string,
  collections: Map<string, FsCollection>,
  subEdges: Set<string>,
  warnings: Warning[],
): void {
  void warnings;
  const constMap = collectCollectionConstants(src);

  const getColl = (parent: string | undefined, name: string): FsCollection => {
    const key = parent ? `${parent}/${name}` : name;
    let c = collections.get(key);
    if (!c) {
      c = { name, parent, fields: new Map() };
      collections.set(key, c);
    } else if (parent && !c.parent) {
      c.parent = parent;
    }
    return c;
  };

  // Resolve a `.collection(ARG)` argument token to a collection name.
  const resolveArg = (raw: string): string | null => {
    const t = raw.trim();
    const lit = t.match(/^['"`]([^'"`]+)['"`]$/);
    if (lit) return lit[1];
    if (constMap.has(t)) return constMap.get(t)!;
    return null;
  };

  const isFirestoreRoot = (id: string): boolean =>
    /^(firestore|adminDb|db|database)$/i.test(id) ||
    /firestore$/i.test(id) ||
    // accessor functions: getDb() / getFirestore() / getAdminDb() / getDatabase()
    /^get(Admin)?(Db|Firestore|Database)$/i.test(id);

  // Walk a `.collection(...)/.doc(...)/.collectionGroup(...)` segment chain that
  // begins at `seed` (the collection context inherited from a root ref var, or
  // undefined for a firestore root). Registers each collection + subcollection
  // edge and returns the trailing collection. `register` gates side effects so
  // a speculative walk over an unresolved ref var doesn't pollute the model.
  const walkChain = (text: string, seed: CollRef | undefined, register: boolean): CollRef | null => {
    const seg = /\.(collection|collectionGroup|doc)\s*\(/g;
    let current: string | undefined = seed?.name;
    let sawDocSinceColl = false;
    let last: CollRef | null = seed ? { ...seed } : null;
    let m: RegExpExecArray | null;
    while ((m = seg.exec(text))) {
      const kind = m[1];
      const openIdx = seg.lastIndex - 1;
      const closeIdx = matchParen(text, openIdx);
      if (closeIdx < 0) break;
      if (kind === "doc") {
        if (current) sawDocSinceColl = true;
        continue;
      }
      const name = resolveArg(text.slice(openIdx + 1, closeIdx));
      if (!name) continue; // dynamic collection name — unresolved
      const isSub = kind === "collection" && sawDocSinceColl && !!current;
      const parent = isSub ? current : undefined;
      if (register) {
        getColl(parent, name);
        if (isSub && parent) subEdges.add(`${parent}::${name}`);
      }
      current = name;
      sawDocSinceColl = false;
      last = { name, parent };
    }
    return last;
  };

  // ── Phase A: resolve ref-variable bindings to a collection. ────────────────
  // Collect `const/let/var X = <expr>;` whose expr is a firestore/ref chain.
  type Binding = { varName: string; expr: string; root: string };
  const bindings: Binding[] = [];
  const bindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);/g;
  let bm: RegExpExecArray | null;
  while ((bm = bindRe.exec(src))) {
    const varName = bm[1];
    const expr = bm[2];
    if (!/\.(collection|collectionGroup|doc)\s*\(/.test(expr)) continue;
    const rootMatch = expr.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (!rootMatch) continue;
    bindings.push({ varName, expr, root: rootMatch[1] });
  }

  const refColl = new Map<string, CollRef>();
  // Fixpoint: a binding resolves once its root is firestore or an already-known
  // ref var. Iterate until no new binding resolves (handles ref-on-ref chains).
  for (let pass = 0; pass < bindings.length + 1; pass++) {
    let progressed = false;
    for (const b of bindings) {
      if (refColl.has(b.varName)) continue;
      let seed: CollRef | undefined;
      if (isFirestoreRoot(b.root)) {
        seed = undefined;
      } else if (refColl.has(b.root)) {
        seed = refColl.get(b.root)!;
      } else {
        continue; // root not yet resolvable
      }
      const tail = walkChain(b.expr, seed, true);
      if (tail) {
        refColl.set(b.varName, tail);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  // ── Phase B: register any remaining firestore-rooted chains (ones not bound
  // to a ref var) and attribute every write. ─────────────────────────────────
  registerInlineChains(src, walkChain, isFirestoreRoot);
  attributeWrites(src, refColl, walkChain, isFirestoreRoot, getColl);
}

// Walk every `firestore.collection(...)...` chain that is NOT a `const x = ...`
// binding (those were handled in phase A) so subcollection edges and collections
// from inline expressions (`await firestore.collection(C).doc(id).collection('notes').add(...)`)
// are registered too.
function registerInlineChains(
  src: string,
  walkChain: (text: string, seed: CollRef | undefined, register: boolean) => CollRef | null,
  isFirestoreRoot: (id: string) => boolean,
): void {
  const rootRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(collection|collectionGroup)\s*\(/g;
  let rm: RegExpExecArray | null;
  while ((rm = rootRe.exec(src))) {
    if (!isFirestoreRoot(rm[1])) continue;
    const start = rm.index + rm[1].length;
    const end = consumeChain(src, start);
    walkChain(src.slice(start, end), undefined, true);
  }
}

// Attribute field writes to their collection. Three write shapes are handled:
//   1. chained:   firestore.collection(C).doc(id).collection('notes').add({...})
//   2. ref-method: markerRef.set({...})            (markerRef ∈ refColl)
//   3. two-arg:   batch.set(itemRef, {...})        (itemRef ∈ refColl)
function attributeWrites(
  src: string,
  refColl: Map<string, CollRef>,
  walkChain: (text: string, seed: CollRef | undefined, register: boolean) => CollRef | null,
  isFirestoreRoot: (id: string) => boolean,
  getColl: (parent: string | undefined, name: string) => FsCollection,
): void {
  const apply = (coll: CollRef | null, body: string | null) => {
    if (!coll || !body) return;
    const target = getColl(coll.parent, coll.name);
    for (const [k, v] of parseObjectKeys(body)) addField(target, k, v);
  };

  // Shape 1: chained writes rooted at firestore.
  const chainWriteRe = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:collection|collectionGroup)\s*\(/g;
  let cm: RegExpExecArray | null;
  const consumedChains: Array<[number, number]> = [];
  while ((cm = chainWriteRe.exec(src))) {
    if (!isFirestoreRoot(cm[1])) continue;
    const start = cm.index + cm[1].length;
    const end = consumeChain(src, start);
    consumedChains.push([start, end]);
    const chainText = src.slice(start, end);
    if (!/\.(set|add|update|create)\s*\(/.test(chainText)) continue;
    const tail = walkChain(chainText, undefined, false);
    // Attribute each write call in the chain to the trailing collection.
    const writeRe = /\.(set|add|update|create)\s*\(/g;
    let wm: RegExpExecArray | null;
    while ((wm = writeRe.exec(chainText))) {
      const openIdx = writeRe.lastIndex - 1;
      const closeIdx = matchParen(chainText, openIdx);
      if (closeIdx < 0) continue;
      apply(tail, firstObjectLiteral(chainText.slice(openIdx + 1, closeIdx)));
    }
  }

  // Shapes 2 & 3: writes whose target collection comes from a ref variable.
  for (const [varName, coll] of refColl) {
    // Shape 2: `<refvar>.set/add/update/create({...})`.
    const m2 = new RegExp(`\\b${escapeRe(varName)}\\s*\\.\\s*(set|add|update|create)\\s*\\(`, "g");
    let wm: RegExpExecArray | null;
    while ((wm = m2.exec(src))) {
      const openIdx = m2.lastIndex - 1;
      const closeIdx = matchParen(src, openIdx);
      if (closeIdx < 0) continue;
      apply(coll, firstObjectLiteral(src.slice(openIdx + 1, closeIdx)));
    }
    // Shape 3: `<x>.set/update/create(<refvar>, {...})` (e.g. batch.set(ref,{})).
    const m3 = new RegExp(`\\.\\s*(set|update|create)\\s*\\(\\s*${escapeRe(varName)}\\s*,`, "g");
    while ((wm = m3.exec(src))) {
      // Re-find the '(' of this call to balance-match its full arg list.
      const callOpen = src.indexOf("(", wm.index);
      if (callOpen < 0) continue;
      const callClose = matchParen(src, callOpen);
      if (callClose < 0) continue;
      const args = src.slice(callOpen + 1, callClose);
      // First arg is the ref var; the object literal is the next top-level arg.
      const comma = skipToComma(args, 0);
      apply(coll, firstObjectLiteral(args.slice(comma + 1)));
    }
  }
}

// Consume a member-access chain starting at `.`: a run of
// `.ident` / `.ident(...)` segments (balanced parens), tolerant of newlines.
function consumeChain(src: string, i: number): number {
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== ".") break;
    i++; // consume '.'
    while (i < n && /\s/.test(src[i])) i++;
    const idStart = i;
    while (i < n && /[\w$]/.test(src[i])) i++;
    if (i === idStart) break; // not an identifier after '.'
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === "(") {
      const close = matchParen(src, i);
      if (close < 0) break;
      i = close + 1;
    }
  }
  return i;
}

function addField(coll: FsCollection, name: string, valueExpr: string | undefined): void {
  if (name === "id") {
    // The Firestore doc id is the document key, not a stored field, but the
    // ground-truth interfaces declare it — keep it and mark it a key.
  }
  const existing = coll.fields.get(name);
  const type = valueExpr ? inferType(valueExpr) : undefined;
  if (!existing) {
    coll.fields.set(name, { name, type, isKey: isKeyField(name) || undefined });
  } else if (!existing.type && type && type !== "unknown") {
    existing.type = type;
  }
}

// Pull the first top-level object literal `{...}` out of a call's argument list,
// skipping a leading spread of nested structures. Returns the inner text.
function firstObjectLiteral(argBlock: string): string | null {
  const i = argBlock.indexOf("{");
  if (i < 0) return null;
  const close = matchBrace(argBlock, i);
  if (close < 0) return null;
  return argBlock.slice(i + 1, close);
}

// Parse the *top-level* keys of an object-literal body (text between the outer
// braces). Returns [key, valueExpr] pairs; skips spreads and computed keys.
function parseObjectKeys(body: string): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    // skip whitespace, commas
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    // skip spread `...x`
    if (body.startsWith("...", i)) {
      i = skipValue(body, i);
      continue;
    }
    // comment skip
    if (body.startsWith("//", i)) {
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (body.startsWith("/*", i)) {
      const end = body.indexOf("*/", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // key: identifier | 'str' | "str" | [computed]
    let key: string | null = null;
    if (body[i] === "'" || body[i] === '"' || body[i] === "`") {
      const q = body[i];
      let j = i + 1;
      while (j < n && body[j] !== q) {
        if (body[j] === "\\") j++;
        j++;
      }
      key = body.slice(i + 1, j);
      i = j + 1;
    } else if (body[i] === "[") {
      // computed key — skip the whole entry
      const close = matchBracket(body, i);
      i = close < 0 ? n : close + 1;
      // skip to next comma at depth 0
      i = skipToComma(body, i);
      continue;
    } else if (/[A-Za-z_$]/.test(body[i])) {
      const s = i;
      while (i < n && /[\w$]/.test(body[i])) i++;
      key = body.slice(s, i);
    } else {
      i++;
      continue;
    }
    // expect ':' (object literal) — if next non-space is ',' or '}' it's
    // shorthand { foo } → value is the identifier itself.
    let k = i;
    while (k < n && /\s/.test(body[k])) k++;
    if (body[k] === ":") {
      i = k + 1;
      while (i < n && /\s/.test(body[i])) i++;
      const valStart = i;
      i = skipToComma(body, i);
      const valExpr = body.slice(valStart, i).trim();
      if (key) out.push([key, valExpr]);
    } else if (body[k] === "(") {
      // method shorthand `foo() {}` — skip it
      i = skipToComma(body, k);
    } else {
      // shorthand property
      if (key) out.push([key, key]);
      i = k;
      i = skipToComma(body, i);
    }
  }
  return out;
}

// Infer a Firestore fieldType from a value expression.
function inferType(expr: string): string {
  const e = expr.trim();
  if (e === "") return "unknown";
  if (/FieldValue\s*\.\s*delete\s*\(/.test(e)) return "delete"; // sentinel — caller skips
  if (/^['"`]/.test(e)) return "string";
  if (/^-?\d+(\.\d+)?$/.test(e)) return "number";
  if (/^(true|false)$/.test(e)) return "boolean";
  if (/^new\s+Date\b/.test(e)) return "timestamp";
  if (/FieldValue\s*\.\s*serverTimestamp\s*\(/.test(e)) return "timestamp";
  if (/\bTimestamp\b/.test(e)) return "timestamp";
  if (/^\[/.test(e) || /^Array\b/.test(e)) return "array";
  if (/^\{/.test(e)) return "map";
  if (/\.ref\b|DocumentReference|\.doc\s*\(/.test(e)) return "reference";
  if (/^parseInt\b|^parseFloat\b|^Number\b/.test(e)) return "number";
  if (/^Boolean\b/.test(e)) return "boolean";
  if (/^String\b/.test(e)) return "string";
  return "unknown";
}

// Collect `const X_COLLECTION = 'name'` (and similar) string constants.
function collectCollectionConstants(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (/COLLECTION|_COLL\b|Collection/.test(name)) map.set(name, m[2]);
  }
  return map;
}

// Parse top-level `interface Name {...}` and `type Name = {...}` field names +
// inferred TS types.
function collectInterfaces(src: string, out: Map<string, FieldDef[]>): void {
  const re = /\b(?:export\s+)?(?:interface|type)\s+([A-Z][\w$]*)\s*(?:extends\s+[\w$.,<>\s]+)?\s*=?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    const openIdx = src.indexOf("{", m.index + m[0].length - 1);
    if (openIdx < 0) continue;
    const closeIdx = matchBrace(src, openIdx);
    if (closeIdx < 0) continue;
    const body = src.slice(openIdx + 1, closeIdx);
    const fields = parseInterfaceFields(body);
    if (fields.length) {
      // Prefer the richer of duplicate declarations.
      const prev = out.get(name);
      if (!prev || fields.length > prev.length) out.set(name, fields);
    }
  }
}

function parseInterfaceFields(body: string): FieldDef[] {
  const out: FieldDef[] = [];
  // Members are `name?: Type;` at depth 0. Split on top-level `;`/newline.
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s;,]/.test(body[i])) i++;
    if (i >= n) break;
    if (body.startsWith("//", i)) {
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (body.startsWith("/*", i)) {
      const end = body.indexOf("*/", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // method/index signatures — skip
    if (body[i] === "[" || body[i] === "(") {
      i = skipMember(body, i);
      continue;
    }
    const s = i;
    while (i < n && /[\w$]/.test(body[i])) i++;
    if (i === s) {
      i++;
      continue;
    }
    let name = body.slice(s, i);
    let optional = false;
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] === "?") {
      optional = true;
      i++;
    }
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] !== ":") {
      // not a property (e.g. a method `foo(): X`) — skip the member
      i = skipMember(body, i);
      continue;
    }
    i++; // ':'
    const valStart = i;
    i = skipMember(body, i);
    const typeText = body.slice(valStart, i).replace(/[;,]\s*$/, "").trim();
    if (name && name !== "constructor") {
      out.push({
        name,
        type: tsTypeToFieldType(typeText),
        mode: optional ? "NULLABLE" : "REQUIRED",
        isKey: isKeyField(name) || undefined,
      });
    }
  }
  return out;
}

// Skip one interface member body up to the top-level `;` or newline boundary,
// honoring nested braces/brackets/parens/angle brackets and strings.
function skipMember(s: string, i: number): number {
  const n = s.length;
  let depth = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") {
      if (depth === 0) return i;
      depth--;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    } else if (depth === 0 && (ch === ";" || ch === "\n")) {
      return i;
    }
    i++;
  }
  return i;
}

function tsTypeToFieldType(t: string): string | undefined {
  const s = t.trim().replace(/\s*\|\s*(undefined|null)\b/g, "").trim();
  if (!s) return undefined;
  if (/^string(\[\])?$/.test(s) && !s.includes("[]")) return "string";
  if (/^number$/.test(s)) return "number";
  if (/^boolean$/.test(s)) return "boolean";
  if (/\[\]$/.test(s) || /^Array\s*</.test(s) || /^(string|number)\[\]$/.test(s)) return "array";
  if (/^Date\b/.test(s) || /\bTimestamp\b/.test(s)) return "timestamp";
  if (/^Record\s*</.test(s) || /^\{/.test(s) || /^Map\s*</.test(s)) return "map";
  if (/DocumentReference|Ref$/.test(s)) return "reference";
  if (/^string\[\]$/.test(s)) return "array";
  return undefined; // leave unknown so a write-inferred type can win
}

// ── Firestore naming heuristics ───────────────────────────────────────────────

function isKeyField(name: string): boolean {
  return name === "id" || /Id$/.test(name) || /Ids$/.test(name);
}

// The column that an FK should target inside the referenced collection.
function idColumnOf(coll: FsCollection): string | undefined {
  if (coll.fields.has("id")) return "id";
  return undefined; // anchor on the table node itself
}

// Map a reference-shaped field name to the bare collection it likely points at.
// `campaignId` → "campaign", `playerIds` → "player", plus common aliases.
function referencedCollection(field: string): string | null {
  const aliases: Record<string, string> = {
    gmId: "gm",
    authorId: "author",
    createdBy: "user",
    updatedBy: "user",
    sharedWithUserId: "user",
  };
  if (field in aliases) return aliases[field];
  let m = field.match(/^([a-z][\w]*?)Ids$/);
  if (m) return m[1];
  m = field.match(/^([a-z][\w]*?)Id$/);
  if (m) return m[1];
  return null;
}

// Resolve a singular referent (e.g. "campaign") to an actual collection name,
// trying the common pluralizations Firestore code uses.
function resolveReferent(referent: string, collByName: Map<string, FsCollection>): string | null {
  const lc = referent.toLowerCase();
  const candidates = [
    referent,
    lc,
    `${referent}s`,
    `${lc}s`,
    `${referent}es`,
    `${lc}es`,
    lc.endsWith("y") ? `${lc.slice(0, -1)}ies` : "",
  ].filter(Boolean);
  for (const c of candidates) {
    if (collByName.has(c)) return c;
  }
  // Case-insensitive sweep as a last resort.
  for (const name of collByName.keys()) {
    if (name.toLowerCase() === lc || name.toLowerCase() === `${lc}s`) return name;
  }
  return null;
}

// Candidate interface/type names for a collection (campaigns → Campaign).
function typeNameCandidates(coll: string): string[] {
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const out = new Set<string>();
  out.add(cap(coll));
  if (coll.endsWith("ies")) out.add(cap(coll.slice(0, -3) + "y"));
  if (coll.endsWith("es")) out.add(cap(coll.slice(0, -2)));
  if (coll.endsWith("s")) out.add(cap(coll.slice(0, -1)));
  return [...out];
}

// ── SqlProvider ───────────────────────────────────────────────────────────────
//
// Prisma models, Drizzle pgTable definitions, and raw `CREATE TABLE` from .sql.

export class SqlProvider implements SchemaProvider {
  db: Db = "sql";
  engine = "SQL";
  dbClass: DbClass = "relational";

  async detect(): Promise<boolean> {
    const deps = depNames(await readPackageJson());
    const sqlDeps = ["pg", "mysql2", "prisma", "@prisma/client", "drizzle-orm", "sequelize", "typeorm", "knex"];
    if (sqlDeps.some((d) => deps.has(d))) return true;
    const files = await this.sqlSourceFiles();
    for (const rel of files) {
      if (rel.endsWith("schema.prisma")) return true;
      if (rel.endsWith(".sql")) {
        const src = await safeRead(rel);
        if (src && /CREATE\s+TABLE/i.test(src) && !looksLikeBigQuerySql(src)) return true;
      }
      if (isTsLike(rel)) {
        const src = await safeRead(rel);
        if (src && /\bpgTable\s*\(|\bmysqlTable\s*\(|\bsqliteTable\s*\(/.test(src)) return true;
      }
    }
    return false;
  }

  private async sqlSourceFiles(): Promise<string[]> {
    return walk(REPO_ROOT, (rel) =>
      rel.endsWith(".prisma") || rel.endsWith(".sql") || isTsLike(rel),
    );
  }

  async introspect(opts: { live?: boolean }): Promise<ProviderResult> {
    const warnings: Warning[] = [];
    if (opts.live) {
      warnings.push({ kind: "live-unavailable", detail: "sql live introspection not implemented; using static" });
    }
    const tables: TableDef[] = [];
    const relations: RelationDef[] = [];
    const seen = new Set<string>();

    const sqlSrcs: string[] = [];
    let sawPgIsms = false;
    for (const rel of await this.sqlSourceFiles()) {
      const src = await safeRead(rel);
      if (!src) continue;
      if (rel.endsWith(".prisma")) {
        parsePrisma(src, tables, relations, seen);
      } else if (rel.endsWith(".sql") && looksLikeBigQuerySql(src)) {
        continue; // BigQuery-dialect DDL — owned by the BigQueryProvider, not relational
      } else if (rel.endsWith(".sql") && /CREATE\s+TABLE/i.test(src)) {
        parseCreateTable(src, rel, tables, relations, seen, warnings);
        sqlSrcs.push(src);
      } else if (rel.endsWith(".sql")) {
        sqlSrcs.push(src); // index / alter / partition-only migrations
      } else if (isTsLike(rel) && /\b(pg|mysql|sqlite)Table\s*\(/.test(src)) {
        parseDrizzle(src, tables, seen);
      }
      if (/\b(SERIAL|BIGSERIAL)\b|USING\s+(gin|gist|brin)|RETURNING\b|::\w/i.test(src)) sawPgIsms = true;
    }
    // Second pass: attach declared relational optimizations (indexes / partitioning / PK).
    const byName = new Map<string, TableDef>();
    for (const t of tables) byName.set(t.name.toLowerCase(), t);
    for (const src of sqlSrcs) parseSqlOptimizations(src, byName);
    // Refine the engine label for the legend.
    if (sawPgIsms) this.engine = "PostgreSQL";
    else {
      const deps = depNames(await readPackageJson());
      this.engine = deps.has("mysql2") ? "MySQL"
        : deps.has("pg") ? "PostgreSQL"
        : deps.has("better-sqlite3") || deps.has("sqlite3") ? "SQLite"
        : "SQL";
    }
    return { tables, relations, warnings };
  }
}

function parsePrisma(src: string, tables: TableDef[], relations: RelationDef[], seen: Set<string>): void {
  const modelRe = /model\s+([A-Za-z_]\w*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(src))) {
    const name = m[1];
    const open = src.indexOf("{", m.index);
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);

    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    const fields: FieldDef[] = [];
    // Pass 1: map a scalar FK field → { model, refCol } from @relation lines.
    // `author User @relation(fields: [authorId], references: [id])`.
    const fkMap = new Map<string, { model: string; refCol?: string }>();
    for (const line of lines) {
      const rel = line.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(?:\[\])?\??.*@relation\s*\(([^)]*)\)/);
      if (!rel) continue;
      const model = rel[2];
      const args = rel[3];
      const fld = args.match(/fields\s*:\s*\[\s*([A-Za-z_]\w*)/);
      const refs = args.match(/references\s*:\s*\[\s*([A-Za-z_]\w*)/);
      if (fld) fkMap.set(fld[1], { model, refCol: refs?.[1] });
    }
    // Pass 2: scalar fields → columns + FK edges.
    for (const line of lines) {
      if (line.startsWith("@@")) continue;
      const fm = line.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?(.*)$/);
      if (!fm) continue;
      const [, fname, ftypeRaw, arr, opt, rest] = fm;
      // Relation navigation fields (object type, no @relation scalar) aren't
      // columns — skip emitting them as scalar columns when they're a list.
      const isModelType = /^[A-Z]/.test(ftypeRaw) && !["String", "Int", "Float", "Boolean", "DateTime", "Json", "Decimal", "BigInt", "Bytes"].includes(ftypeRaw);
      if (isModelType && (arr || /@relation/.test(rest))) continue; // navigation field
      const isId = /@id\b/.test(rest);
      fields.push({
        name: fname,
        type: arr ? "array" : prismaType(ftypeRaw),
        mode: opt ? "NULLABLE" : "REQUIRED",
        isKey: isId || isKeyField(fname) || undefined,
      });
      // FK: explicit @relation mapping wins; else a scalar `<x>Id` convention.
      const explicit = fkMap.get(fname);
      if (explicit) {
        relations.push({
          db: "sql", kind: "fk-reference",
          fromTable: name, fromCol: fname,
          toTable: explicit.model, toCol: explicit.refCol,
          label: fname, confidence: "high",
        });
      } else {
        const conv = fname.match(/^([A-Za-z_]\w*?)Id$/);
        if (conv) {
          const model = conv[1][0].toUpperCase() + conv[1].slice(1);
          relations.push({
            db: "sql", kind: "fk-reference",
            fromTable: name, fromCol: fname,
            toTable: model, label: fname, confidence: "low",
          });
        }
      }
    }
    const key = `sql:${name}`;
    if (!seen.has(key)) {
      tables.push({ db: "sql", name, fields });
      seen.add(key);
    }
  }
}

function prismaType(t: string): string {
  if (/^String$/.test(t)) return "string";
  if (/^(Int|Float|Decimal|BigInt)$/.test(t)) return "number";
  if (/^Boolean$/.test(t)) return "boolean";
  if (/^DateTime$/.test(t)) return "timestamp";
  if (/^Json$/.test(t)) return "map";
  if (/^[A-Z]/.test(t)) return "reference";
  return "unknown";
}

function parseCreateTable(
  src: string,
  rel: string,
  tables: TableDef[],
  relations: RelationDef[],
  seen: Set<string>,
  _warnings: Warning[],
): void {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?([A-Za-z_][\w.]*)["`']?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fqName = m[1];
    const name = fqName.split(".").pop()!;
    const open = src.indexOf("(", m.index + m[0].length - 1);
    const close = matchParen(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    const fields: FieldDef[] = [];
    for (const rawLine of splitTopLevel(body, ",")) {
      const line = rawLine.trim();
      if (!line) continue;
      const upper = line.toUpperCase();
      // Inline FK: `FOREIGN KEY (col) REFERENCES other(col)`.
      const fk = line.match(/FOREIGN\s+KEY\s*\(\s*["`']?(\w+)["`']?\s*\)\s*REFERENCES\s+["`']?(\w+)["`']?\s*\(\s*["`']?(\w+)["`']?\s*\)/i);
      if (fk) {
        relations.push({
          db: "sql", kind: "fk-reference",
          fromTable: name, fromCol: fk[1],
          toTable: fk[2], toCol: fk[3],
          label: fk[1], confidence: "high",
        });
        continue;
      }
      if (/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK|KEY|INDEX)\b/.test(upper)) continue;
      const cm = line.match(/^["`']?(\w+)["`']?\s+([A-Za-z]+)/);
      if (!cm) continue;
      const colName = cm[1];
      const isKey = /\bPRIMARY\s+KEY\b/i.test(line) || isKeyField(colName);
      fields.push({
        name: colName,
        type: sqlType(cm[2]),
        mode: /\bNOT\s+NULL\b/i.test(line) ? "REQUIRED" : "NULLABLE",
        isKey: isKey || undefined,
      });
      // Inline column REFERENCES.
      const colRef = line.match(/REFERENCES\s+["`']?(\w+)["`']?\s*(?:\(\s*["`']?(\w+)["`']?\s*\))?/i);
      if (colRef) {
        relations.push({
          db: "sql", kind: "fk-reference",
          fromTable: name, fromCol: colName,
          toTable: colRef[1], toCol: colRef[2],
          label: colName, confidence: "high",
        });
      }
    }
    const key = `sql:${name}`;
    if (!seen.has(key)) {
      tables.push({ db: "sql", name, fields });
      seen.add(key);
    }
  }
  void rel;
}

// Second-pass relational optimization parser for raw SQL: CREATE INDEX,
// ALTER ... ADD PRIMARY KEY, declarative partitioning, inline PK. parseCreateTable
// handles structure; this attaches the relational-class mechanisms to the matching
// TableDef (bare name). Anything targeting a non-SQL table no-ops.
function parseSqlOptimizations(src: string, byName: Map<string, TableDef>): void {
  const optOf = (raw: string): TableOptimizations | null => {
    const t = byName.get(raw.split(".").pop()!.replace(/["`']/g, "").toLowerCase());
    if (!t) return null;
    return (t.optimizations ??= {});
  };
  const cols = (inner: string): string[] =>
    splitTopLevel(inner, ",")
      .map((c) => c.trim().replace(/["`']/g, "").split(/\s+/)[0])
      .filter(Boolean);

  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] table [USING m] ( ... ) [INCLUDE (...)] [WHERE ...]
  const idxRe =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:["`']?(\w+)["`']?\s+)?ON\s+(?:ONLY\s+)?["`']?([\w.]+)["`']?\s*(?:USING\s+(\w+)\s*)?\(/gi;
  let m: RegExpExecArray | null;
  while ((m = idxRe.exec(src))) {
    const o = optOf(m[3]);
    const open = src.indexOf("(", idxRe.lastIndex - 1);
    const close = matchParen(src, open);
    if (close < 0) continue;
    idxRe.lastIndex = close;
    if (!o) continue;
    const columns = cols(src.slice(open + 1, close));
    const semi = src.indexOf(";", close);
    const tail = src.slice(close + 1, semi < 0 ? src.length : semi);
    const inc = /INCLUDE\s*\(([^)]*)\)/i.exec(tail)?.[1];
    const where = /\bWHERE\s+([^;]+)/i.exec(tail)?.[1]?.trim();
    (o.indexes ??= []).push({
      name: m[2],
      columns,
      method: m[4]?.toLowerCase(),
      unique: m[1] ? true : undefined,
      covering: inc ? cols(inc) : undefined,
      where: where || undefined,
    });
  }

  // ALTER TABLE [ONLY] t ADD [CONSTRAINT c] PRIMARY KEY ( ... )
  const pkRe =
    /ALTER\s+TABLE\s+(?:ONLY\s+)?["`']?([\w.]+)["`']?\s+ADD\s+(?:CONSTRAINT\s+["`']?\w+["`']?\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/gi;
  while ((m = pkRe.exec(src))) {
    const o = optOf(m[1]);
    if (o) o.primaryKey = cols(m[2]);
  }

  // CREATE TABLE … [ ( … ) ] PARTITION BY {RANGE|LIST|HASH} (key)  /  PARTITION OF parent
  const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?([\w.]+)["`']?\s*(\(|PARTITION\s+OF\b)/gi;
  while ((m = ctRe.exec(src))) {
    const o = optOf(m[1]);
    if (!o) continue;
    if (/PARTITION\s+OF/i.test(m[2])) {
      const parent = /PARTITION\s+OF\s+["`']?([\w.]+)/i.exec(src.slice(m.index))?.[1];
      if (parent) (o.notes ??= []).push(`partition of ${parent.split(".").pop()}`);
      continue;
    }
    const open = src.indexOf("(", m.index);
    const close = matchParen(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    const pkInline = /\bPRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(body);
    if (pkInline && !o.primaryKey) o.primaryKey = cols(pkInline[1]);
    const semi = src.indexOf(";", close);
    const tail = src.slice(close + 1, semi < 0 ? src.length : semi);
    const pb = /PARTITION\s+BY\s+(RANGE|LIST|HASH)\s*\(([^)]*)\)/i.exec(tail);
    if (pb) {
      o.partition = {
        strategy: pb[1].toUpperCase() as PartitionDef["strategy"],
        key: cols(pb[2])[0] ?? pb[2].trim(),
      };
    }
  }
}

function sqlType(t: string): string {
  const u = t.toUpperCase();
  if (/CHAR|TEXT|UUID|CLOB/.test(u)) return "string";
  if (/INT|SERIAL|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|MONEY/.test(u)) return "number";
  if (/BOOL/.test(u)) return "boolean";
  if (/DATE|TIME/.test(u)) return "timestamp";
  if (/JSON/.test(u)) return "map";
  if (/ARRAY/.test(u)) return "array";
  return "unknown";
}

// A `.sql` file written in BigQuery dialect (backtick `${project}.${dataset}.table`
// FQNs, FLOAT64 / STRUCT<> types, OPTIONS(description=…), `bq query`, bare
// `PARTITION BY col` + `CLUSTER BY`). These belong to the BigQueryProvider; the
// relational SQL provider ignores them so a BQ migration never registers a phantom
// relational table or engine. This is the raw-`.sql` engine-attribution guard.
function looksLikeBigQuerySql(src: string): boolean {
  return /`\s*\$\{|`[\w-]+\.[\w-]+\.[\w-]+`|OPTIONS\s*\(\s*description|\bFLOAT64\b|\bSTRUCT\s*<|\bbq\s+query\b|\bCLUSTER\s+BY\b/i.test(src);
}

function parseDrizzle(src: string, tables: TableDef[], seen: Set<string>): void {
  const re = /(?:export\s+)?const\s+\w+\s*=\s*(?:pg|mysql|sqlite)Table\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    const open = src.indexOf("{", m.index + m[0].length - 1);
    const close = matchBrace(src, open);
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    const fields: FieldDef[] = [];
    for (const [key, valExpr] of parseObjectKeys(body)) {
      let type = "unknown";
      if (valExpr) {
        if (/\b(varchar|text|char|uuid)\s*\(/.test(valExpr)) type = "string";
        else if (/\b(integer|serial|bigint|numeric|decimal|real|doublePrecision)\s*\(/.test(valExpr)) type = "number";
        else if (/\bboolean\s*\(/.test(valExpr)) type = "boolean";
        else if (/\b(timestamp|date)\s*\(/.test(valExpr)) type = "timestamp";
        else if (/\bjson(b)?\s*\(/.test(valExpr)) type = "map";
      }
      fields.push({ name: key, type, isKey: /\.primaryKey\(/.test(valExpr ?? "") || isKeyField(key) || undefined });
    }
    const k = `sql:${name}`;
    if (!seen.has(k)) {
      tables.push({ db: "sql", name, fields });
      seen.add(k);
    }
  }
}

// ── BigQueryProvider (the BigQuery-specific static provider) ──────────────────

const BQ_FIELD_RE =
  /bigquery\.SchemaField\(\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']\s*,\s*["']([A-Z0-9_]+)["']\s*(?:,\s*mode\s*=\s*["']([A-Z]+)["'])?\s*(?:,\s*description\s*=\s*((?:["'][\s\S]*?["']\s*)+))?\s*\)/g;
const BQ_TABLE_REF_RE = /_table_ref\(\s*client\s*,\s*dataset_id\s*,\s*["']([a-z_][a-z0-9_]*)["']\s*\)/;
const BQ_CLUSTER_RE = /clustering_fields\s*=\s*\[([^\]]*)\]/;
const BQ_PARTITION_FIELD_RE = /field\s*=\s*["']([a-z_][a-z0-9_]*)["']/;

// Precise BigQuery table discovery. BQ tables are ALWAYS fully-qualified —
// `project.dataset.table`, usually with interpolation (`{ds}.recent_signals`).
// We accept a dotted reference ONLY in a real table context (after a SQL table
// keyword, as a `_table_ref(..., "name")` / `.table("name")` call, or as a whole
// FQN literal) and take its last segment — so CTEs, aliases, and `module.fn`
// doc-refs in docstrings never become tables.
const SEG = String.raw`(?:\$?\{[^}]+\}|\`?[A-Za-z_][\w-]*\`?)`;
const BQ_FQN_CLAUSES = [
  new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE|MERGE(?:\s+INTO)?|TABLE)\s+\`?(${SEG}(?:\.${SEG})+)`, "gi"),
];
const BQ_TABLE_CALL_RE = /(?:_table_ref\s*\([^,]*,[^,]*,\s*|[.]\s*table\s*\(\s*)["']([a-z_][a-z0-9_]*)["']/g;
const BQ_WHOLE_FQN_RE = new RegExp(String.raw`^${SEG}(?:\.${SEG}){1,2}$`);

const BQ_KEYWORDS = new Set([
  "select", "from", "where", "join", "on", "as", "and", "or", "group", "order",
  "by", "limit", "offset", "having", "qualify", "partition", "cluster", "over",
  "with", "union", "all", "distinct", "case", "when", "then", "else", "end",
  "unnest", "values", "set", "into", "using", "cross", "inner", "left", "right",
  "outer", "full", "if", "ifnull", "coalesce", "date", "datetime", "timestamp",
  "json", "null", "true", "false", "exists", "in", "not", "is", "asc", "desc",
  "lateral", "table", "row", "rows", "between", "like", "the",
]);
const BQ_NON_TABLE = new Set([
  "dataframe", "columns", "tables", "partitions", "logger", "log", "dataset",
  "dataset_id", "table_id", "project", "project_id", "client", "self", "py",
  "md", "info", "debug", "warning", "error", "live", "staging", "stg", "snap",
  "tbl", "col", "tmp", "temp", "prod", "dev",
  // MERGE / DML pseudo-relations and aliases (not real tables).
  "completed", "deleted", "updated", "inserted", "merged", "matched", "source",
  "target", "dual", "new", "old", "excluded",
]);

function looksLikeFqn(ref: string): boolean {
  return /[{}]/.test(ref) || (ref.match(/\./g) || []).length >= 2;
}
function bqLastSegment(ref: string): string | null {
  if (/information_schema/i.test(ref)) return null;
  const seg = (ref.split(".").pop() ?? "").trim();
  if (/^\$?\{.*\}$/.test(seg)) return null; // pure interpolation → dynamic name
  const cleaned = seg.replace(/[`${}]/g, "").trim();
  if (!/^[A-Za-z]\w*$/.test(cleaned)) return null; // letter-led, no _private
  if (cleaned.endsWith("_")) return null; // incomplete interpolation (e.g. `…_pre_`)
  const lc = cleaned.toLowerCase();
  if (cleaned.length < 3 || BQ_KEYWORDS.has(lc) || BQ_NON_TABLE.has(lc)) return null;
  return cleaned;
}

// Pull SQL/template string-literal contents from a source file (skips #, //, /* */
// comments so doc-text backtick refs don't masquerade as table references).
function bqStringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      // Python triple-quote support: treat """…""" / '''…''' as one literal.
      const triple = src.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const end = src.indexOf(triple, i + 3);
        out.push(src.slice(i + 3, end < 0 ? src.length : end));
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      const q = c;
      let j = i + 1, buf = "";
      while (j < src.length) {
        if (src[j] === "\\") { buf += src[j + 1] ?? ""; j += 2; continue; }
        if (src[j] === q) break;
        buf += src[j]; j++;
      }
      out.push(buf);
      i = j + 1;
      continue;
    }
    if (c === "#") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i); i = e < 0 ? src.length : e + 2; continue; }
    i++;
  }
  return out;
}

// Every table this file references (in a genuine table context).
function collectBqTables(src: string): Set<string> {
  const out = new Set<string>();
  // Explicit table-ref / .table() calls (scan raw — these are unambiguous).
  let m: RegExpExecArray | null;
  BQ_TABLE_CALL_RE.lastIndex = 0;
  while ((m = BQ_TABLE_CALL_RE.exec(src))) out.add(m[1]);
  // FQN references inside string literals only.
  for (const lit of bqStringLiterals(src)) {
    const trimmed = lit.trim();
    if (BQ_WHOLE_FQN_RE.test(trimmed) && looksLikeFqn(trimmed)) {
      const t = bqLastSegment(trimmed);
      if (t) out.add(t);
    }
    for (const re of BQ_FQN_CLAUSES) {
      re.lastIndex = 0;
      while ((m = re.exec(lit))) {
        if (!looksLikeFqn(m[1])) continue;
        const t = bqLastSegment(m[1]);
        if (t) out.add(t);
      }
    }
  }
  return out;
}

// Best-effort JOIN relations: resolve FROM/JOIN aliases to tables, then read
// `ON a.col = b.col` equalities into table↔table join edges.
function collectBqJoins(src: string, known: Set<string>): RelationDef[] {
  const rels: RelationDef[] = [];
  const seen = new Set<string>();
  const aliasRefRe = new RegExp(String.raw`\b(?:FROM|JOIN)\s+\`?(${SEG}(?:\.${SEG})+)\`?(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?`, "gi");
  const onRe = /\bON\b([\s\S]{0,400}?)(?:\bJOIN\b|\bWHERE\b|\bGROUP\b|\bQUALIFY\b|\bORDER\b|$)/gi;
  const eqRe = /([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  for (const lit of bqStringLiterals(src)) {
    if (!/\bJOIN\b/i.test(lit)) continue;
    // alias → table for this query.
    const alias = new Map<string, string>();
    let m: RegExpExecArray | null;
    aliasRefRe.lastIndex = 0;
    while ((m = aliasRefRe.exec(lit))) {
      const t = bqLastSegment(m[1]);
      if (!t || !known.has(t)) continue;
      alias.set(t.toLowerCase(), t);
      if (m[2] && !BQ_KEYWORDS.has(m[2].toLowerCase())) alias.set(m[2].toLowerCase(), t);
    }
    if (alias.size < 2) continue;
    onRe.lastIndex = 0;
    let om: RegExpExecArray | null;
    while ((om = onRe.exec(lit))) {
      eqRe.lastIndex = 0;
      let em: RegExpExecArray | null;
      while ((em = eqRe.exec(om[1]))) {
        const a = alias.get(em[1].toLowerCase()), b = alias.get(em[3].toLowerCase());
        if (!a || !b || a === b) continue;
        const [t1, c1, t2, c2] = a < b ? [a, em[2], b, em[4]] : [b, em[4], a, em[2]];
        const key = `${t1}.${c1}=${t2}.${c2}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rels.push({ db: "bigquery", kind: "joins", fromTable: t1, fromCol: c1, toTable: t2, toCol: c2, confidence: "low" });
      }
    }
  }
  return rels;
}

export class BigQueryProvider implements SchemaProvider {
  db: Db = "bigquery";
  engine = "BigQuery";
  dbClass: DbClass = "analytical";

  async detect(): Promise<boolean> {
    const deps = depNames(await readPackageJson());
    if (deps.has("@google-cloud/bigquery")) return true;
    for (const rel of await this.bqFiles()) {
      const src = await safeRead(rel);
      if (!src) continue;
      if (/bigquery\.SchemaField\(|from\s+google\.cloud\s+import\s+bigquery|google\.cloud\.bigquery|@google-cloud\/bigquery/.test(src)) return true;
      if (collectBqTables(src).size > 0) return true;
    }
    return false;
  }

  private async bqFiles(): Promise<string[]> {
    return walk(REPO_ROOT, (rel) => rel.endsWith(".py") || rel.endsWith(".sql") || isTsLike(rel));
  }

  async introspect(opts: { live?: boolean }): Promise<ProviderResult> {
    const warnings: Warning[] = [];
    if (opts.live) {
      // Live seam: the `bq` CLI INFORMATION_SCHEMA path.
      // Requires BQ_PROJECT_ID/GOOGLE_CLOUD_PROJECT + ambient gcloud auth; not
      // assumed here, so fall back to static and warn.
      warnings.push({
        kind: "live-unavailable",
        detail: "bigquery live introspection needs project + gcloud auth; using static",
      });
    }

    const tables: TableDef[] = [];
    const seen = new Set<string>();
    const referenced = new Set<string>(); // every table name seen via FQN/table-ref

    const files = await this.bqFiles();
    const srcByFile = new Map<string, string>();
    for (const rel of files) {
      const src = await safeRead(rel);
      if (!src) continue;
      srcByFile.set(rel, src);
      // Tables with full schemas come from setup_tables.py SchemaField blocks.
      if (/bigquery\.SchemaField\(/.test(src)) {
        parseBqSetupTables(src, tables, seen, warnings);
      }
      for (const name of collectBqTables(src)) referenced.add(name);
    }

    // Referenced-but-undefined tables (rollups built via CTAS / load_table_*,
    // not in setup_tables.py) → shown as cards; columns need live introspection.
    for (const name of referenced) {
      if (seen.has(`bigquery:${name}`)) continue;
      tables.push({ db: "bigquery", name, fields: [] });
      seen.add(`bigquery:${name}`);
      warnings.push({
        kind: "bq-columns-unknown",
        detail: `${name}: referenced but not defined in setup_tables.py — columns need live introspection`,
      });
    }

    // Relationships: JOIN ... ON equalities between known tables.
    const known = new Set([...tables.map((t) => t.name)]);
    const relations: RelationDef[] = [];
    const relSeen = new Set<string>();
    for (const src of srcByFile.values()) {
      for (const r of collectBqJoins(src, known)) {
        const key = `${r.fromTable}.${r.fromCol}=${r.toTable}.${r.toCol}`;
        if (relSeen.has(key)) continue;
        relSeen.add(key);
        relations.push(r);
      }
    }

    return { tables, relations, warnings };
  }
}

function parseBqSetupTables(src: string, tables: TableDef[], seen: Set<string>, warnings: Warning[]): void {
  const lines = src.split("\n");
  const defLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^def\s+create_[a-z0-9_]+_table\s*\(/.test(lines[i])) defLines.push(i);
  }
  for (let d = 0; d < defLines.length; d++) {
    const start = defLines[d];
    const end = d + 1 < defLines.length ? defLines[d + 1] : lines.length;
    const body = lines.slice(start, end).join("\n");

    const tref = body.match(BQ_TABLE_REF_RE);
    if (!tref) continue;
    const name = tref[1];

    const fields: FieldDef[] = [];
    BQ_FIELD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BQ_FIELD_RE.exec(body))) {
      fields.push({
        name: m[1],
        type: m[2],
        mode: m[3] ?? "NULLABLE",
        description: m[4] ? cleanPyStr(m[4]) : undefined,
        isKey: m[3] === "REQUIRED" && /_id$/.test(m[1]) && /\bPK\b/i.test(m[4] ?? "") || undefined,
      });
    }
    if (fields.length === 0) {
      warnings.push({ kind: "no-fields-parsed", detail: `${name}: SchemaField declarations not parsed` });
    }
    const clusterFields = parsePyList(body.match(BQ_CLUSTER_RE)?.[1]);
    const partitionField = /time_partitioning|range_partitioning/.test(body)
      ? body.match(BQ_PARTITION_FIELD_RE)?.[1]
      : undefined;

    if (!seen.has(`bigquery:${name}`)) {
      const opt: TableOptimizations = {};
      if (partitionField) {
        opt.partition = {
          strategy: /range_partitioning/.test(body) ? "RANGE" : "TIME",
          key: partitionField,
          unit: /TimePartitioningType\.(HOUR|DAY|MONTH|YEAR)/.exec(body)?.[1],
          requireFilter: /require_partition_filter\s*=\s*True/i.test(body) || undefined,
        };
      }
      if (clusterFields.length) opt.clustering = clusterFields;
      tables.push({
        db: "bigquery",
        name,
        fields,
        clusterFields: clusterFields.length ? clusterFields : undefined,
        partitionField,
        optimizations: Object.keys(opt).length ? opt : undefined,
      });
      seen.add(`bigquery:${name}`);
    }
  }
}

function cleanPyStr(raw: string): string {
  return raw
    .replace(/["']\s*["']/g, "")
    .replace(/^["']|["']\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePyList(inner: string | undefined): string[] {
  if (!inner) return [];
  return [...inner.matchAll(/["']([a-z_][a-z0-9_]*)["']/g)].map((m) => m[1]);
}

// ── Low-level lexer helpers (brace/paren/bracket matching, string skipping) ───

function matchParen(s: string, openIdx: number): number {
  return matchDelim(s, openIdx, "(", ")");
}
function matchBrace(s: string, openIdx: number): number {
  return matchDelim(s, openIdx, "{", "}");
}
function matchBracket(s: string, openIdx: number): number {
  return matchDelim(s, openIdx, "[", "]");
}

function matchDelim(s: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let i = openIdx;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Skip a string literal starting at the opening quote; returns index after the
// closing quote. Handles escapes and (best-effort) template-literal `${}`.
function skipString(s: string, i: number): number {
  const q = s[i];
  const n = s.length;
  i++;
  while (i < n) {
    const ch = s[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (q === "`" && ch === "$" && s[i + 1] === "{") {
      const close = matchBrace(s, i + 1);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (ch === q) return i + 1;
    i++;
  }
  return n;
}

// Skip from i to the next top-level comma or closing of the current object,
// honoring nesting and strings. Returns the comma/end index (points at ',' or n).
function skipToComma(s: string, i: number): number {
  let depth = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) return i;
      depth--;
    } else if (ch === "," && depth === 0) {
      return i;
    } else if (ch === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    i++;
  }
  return i;
}

// Skip a full value (used for spreads): from i to next top-level comma.
function skipValue(s: string, i: number): number {
  return skipToComma(s, i);
}

function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(s, i);
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === delim && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
    i++;
  }
  out.push(s.slice(last));
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function safeRead(rel: string): Promise<string | null> {
  try {
    const buf = await readFile(join(REPO_ROOT, rel), "utf8");
    if (buf.length > MAX_FILE_BYTES) return buf.slice(0, MAX_FILE_BYTES);
    return buf;
  } catch {
    return null;
  }
}

// ── Compose graph ─────────────────────────────────────────────────────────────

// ── Generic engine detectors (classify-all, shallow) ─────────────────────────
// The three providers above do deep structure capture. These lightweight
// detectors identify EVERY OTHER engine in the taxonomy — emitting at least a
// classified database node, plus best-effort table names where they're cheaply
// declared in-repo. See DB_CLASSES.md. (Depth is the first-class providers' job.)

interface EngineSignature {
  key: string; // db grouping key (node-id prefix)
  engine: string; // display name
  dbClass: DbClass;
  deps?: string[]; // package.json deps that imply this engine
  src?: RegExp; // a source / config code signal
  tables?: (corpus: { rel: string; src: string }[]) => TableDef[]; // best-effort names
}

// One memoised corpus per build (reset at buildSchemasGraph start) so the many
// generic detectors share a single walk instead of each re-reading the tree.
let _corpus: { rel: string; src: string }[] | null = null;
async function sourceCorpus(): Promise<{ rel: string; src: string }[]> {
  if (_corpus) return _corpus;
  const files = await walk(
    REPO_ROOT,
    (rel) => isTsLike(rel) || /\.(py|go|rb|java|kt|cs|sql|cql|json|ya?ml|toml|tf)$/i.test(rel),
  );
  const out: { rel: string; src: string }[] = [];
  for (const rel of files) {
    const src = await safeRead(rel);
    if (src) out.push({ rel, src });
  }
  _corpus = out;
  return out;
}

const mongooseTables = (corpus: { rel: string; src: string }[]): TableDef[] => {
  const names = new Set<string>();
  for (const { src } of corpus)
    for (const m of src.matchAll(/(?:mongoose|models?)\.model\s*\(\s*["'`]([A-Za-z_]\w*)["'`]/g)) names.add(m[1]);
  return [...names].map((name) => ({ db: "mongodb", name, fields: [] }));
};
const dynamoTables = (corpus: { rel: string; src: string }[]): TableDef[] => {
  const names = new Set<string>();
  for (const { src } of corpus)
    for (const m of src.matchAll(/TableName\s*[:=]\s*["'`]([\w.-]+)["'`]/g)) names.add(m[1]);
  return [...names].map((name) => ({ db: "dynamodb", name, fields: [] }));
};
const cqlTables = (corpus: { rel: string; src: string }[]): TableDef[] => {
  const out: TableDef[] = [];
  const seen = new Set<string>();
  for (const { rel, src } of corpus) {
    if (!rel.endsWith(".cql") && !/PRIMARY\s+KEY\s*\(\s*\(/.test(src)) continue;
    for (const m of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`']?([\w.]+)["`']?\s*\(/gi)) {
      const name = m[1].split(".").pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const pk = /PRIMARY\s+KEY\s*\(\s*\(([^)]*)\)/i.exec(src.slice(m.index))?.[1];
      out.push({ db: "cassandra", name, fields: [], optimizations: pk ? { rowKey: pk.trim() } : undefined });
    }
  }
  return out;
};

// Signals favor package deps + high-specificity source patterns (connection URIs,
// SDK class names, engine-specific DDL with syntax). NO bare case-insensitive words:
// a token like `sortKey` must never imply "Redshift". A mention is not usage.
const ENGINE_SIGNATURES: EngineSignature[] = [
  // document (beyond Firestore)
  { key: "mongodb", engine: "MongoDB", dbClass: "document", deps: ["mongodb", "mongoose"], src: /\bmongoose\b|\bMongoClient\b|mongodb(?:\+srv)?:\/\//, tables: mongooseTables },
  { key: "dynamodb", engine: "DynamoDB", dbClass: "document", deps: ["@aws-sdk/client-dynamodb", "dynamoose"], src: /\bDynamoDB(?:Client|DocumentClient)\b|\bCreateTableCommand\b/, tables: dynamoTables },
  { key: "redis", engine: "Redis", dbClass: "document", deps: ["redis", "ioredis"], src: /\bnew\s+Redis\s*\(|rediss?:\/\// },
  { key: "cosmos", engine: "Cosmos DB", dbClass: "document", deps: ["@azure/cosmos"], src: /\bCosmosClient\b/ },
  { key: "couchbase", engine: "Couchbase", dbClass: "document", deps: ["couchbase"], src: /couchbases?:\/\// },
  // analytical (beyond BigQuery)
  { key: "redshift", engine: "Redshift", dbClass: "analytical", deps: ["@aws-sdk/client-redshift", "@aws-sdk/client-redshift-data"], src: /\bDISTSTYLE\b|\bDISTKEY\s*\(|\bSORTKEY\s*\(|redshift\.amazonaws\.com/ },
  { key: "snowflake", engine: "Snowflake", dbClass: "analytical", deps: ["snowflake-sdk"], src: /\bsnowflake-sdk\b|\.snowflakecomputing\.com/ },
  { key: "synapse", engine: "Synapse", dbClass: "analytical", src: /\.sql\.azuresynapse\.net|\bSynapse\s+Analytics\b/i },
  { key: "databricks", engine: "Databricks", dbClass: "analytical", deps: ["@databricks/sql"], src: /databricks:\/\/|\.databricks\.com|\bdbfs:\// },
  { key: "clickhouse", engine: "ClickHouse", dbClass: "analytical", deps: ["@clickhouse/client", "clickhouse"], src: /clickhouse:\/\/|ENGINE\s*=\s*\w*MergeTree/i },
  // newsql (distributed global relational)
  { key: "spanner", engine: "Cloud Spanner", dbClass: "newsql", deps: ["@google-cloud/spanner"], src: /INTERLEAVE\s+IN\s+PARENT|spanner\.googleapis\.com/i },
  { key: "cockroachdb", engine: "CockroachDB", dbClass: "newsql", src: /cockroachlabs\.cloud|cockroachdb:\/\// },
  { key: "yugabyte", engine: "YugabyteDB", dbClass: "newsql", src: /\byugabytedb\b|yugabyte:\/\// },
  // wide-column / time-series
  { key: "cassandra", engine: "Cassandra", dbClass: "wide-column", deps: ["cassandra-driver"], src: /PRIMARY\s+KEY\s*\(\s*\(|cassandra:\/\//, tables: cqlTables },
  { key: "scylla", engine: "ScyllaDB", dbClass: "wide-column", src: /\bscylladb\b/i },
  { key: "bigtable", engine: "Cloud Bigtable", dbClass: "wide-column", deps: ["@google-cloud/bigtable"], src: /bigtable\.googleapis\.com|\bnew\s+Bigtable\b/ },
  { key: "hbase", engine: "HBase", dbClass: "wide-column", src: /org\.apache\.hadoop\.hbase/ },
  { key: "timestream", engine: "Timestream", dbClass: "wide-column", deps: ["@aws-sdk/client-timestream-write"], src: /\bTimestreamWrite\b|timestream\.[\w-]+\.amazonaws/ },
  // vector
  { key: "pgvector", engine: "pgvector", dbClass: "vector", src: /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?vector\b|USING\s+(?:hnsw|ivfflat)\b|\bvector\s*\(\s*\d{2,}\s*\)/i },
  { key: "pinecone", engine: "Pinecone", dbClass: "vector", deps: ["@pinecone-database/pinecone"], src: /\bPinecone\b|pinecone\.io/ },
  { key: "milvus", engine: "Milvus", dbClass: "vector", deps: ["@zilliz/milvus2-sdk-node"], src: /\bmilvus\b/i },
  { key: "qdrant", engine: "Qdrant", dbClass: "vector", deps: ["@qdrant/js-client-rest"], src: /\bqdrant\b/i },
  { key: "weaviate", engine: "Weaviate", dbClass: "vector", deps: ["weaviate-ts-client", "weaviate-client"], src: /\bweaviate\b/i },
];

// One instance per signature: each carries its own db/engine/dbClass so the build
// loop registers + stamps it correctly. Identification-only when no schema parses.
export class GenericEngineProvider implements SchemaProvider {
  db: Db;
  engine: string;
  dbClass: DbClass;
  private sig: EngineSignature;
  constructor(sig: EngineSignature) {
    this.sig = sig;
    this.db = sig.key;
    this.engine = sig.engine;
    this.dbClass = sig.dbClass;
  }
  async detect(): Promise<boolean> {
    if (this.sig.deps?.length) {
      const deps = depNames(await readPackageJson());
      if (this.sig.deps.some((d) => deps.has(d))) return true;
    }
    if (this.sig.src) {
      for (const { src } of await sourceCorpus()) if (this.sig.src.test(src)) return true;
    }
    return false;
  }
  async introspect(): Promise<ProviderResult> {
    const corpus = await sourceCorpus();
    let tables = this.sig.tables ? this.sig.tables(corpus) : [];
    if (!tables.length) {
      // No statically-declared schema — emit one classified identification node so
      // the database TYPE is still documented on /graphs/schemas.
      tables = [
        {
          db: this.sig.key,
          name: this.sig.engine,
          fields: [],
          optimizations: {
            notes: [`${this.sig.engine} detected; schema is runtime / console-managed (not statically declared in-repo)`],
          },
        },
      ];
    }
    return { tables, relations: [], warnings: [] };
  }
}

const PROVIDERS: SchemaProvider[] = [
  new FirestoreProvider(),
  new SqlProvider(),
  new BigQueryProvider(),
  ...ENGINE_SIGNATURES.map((s) => new GenericEngineProvider(s)),
];

// Firestore composite indexes + TTL come from firestore.indexes.json (the Firebase
// CLI deploy artifact), not app code — read it directly and attach to the matching
// collection. Absent file → a soft note (those indexes are then console-managed and
// invisible to a static scan). This populates the document-class optimization slots.
async function attachFirestoreIndexes(tables: TableDef[], warnings: Warning[]): Promise<void> {
  const fsTables = tables.filter((t) => t.db === "firestore");
  if (!fsTables.length) return;
  let raw: string | null = null;
  for (const cand of [
    "firestore.indexes.json",
    "firestore/firestore.indexes.json",
    "config/firestore.indexes.json",
    "backend/firestore.indexes.json",
  ]) {
    raw = await safeRead(cand);
    if (raw) break;
  }
  if (!raw) {
    warnings.push({
      kind: "firestore-indexes-undeclared",
      detail: "no firestore.indexes.json in repo — Firestore composite indexes / TTL are console-managed and not shown",
    });
    return;
  }
  let cfg: { indexes?: any[]; fieldOverrides?: any[] };
  try {
    cfg = JSON.parse(raw);
  } catch {
    warnings.push({ kind: "firestore-indexes-unparsed", detail: "firestore.indexes.json is not valid JSON" });
    return;
  }
  const byName = new Map<string, TableDef>();
  for (const t of fsTables) byName.set(t.name, t);
  for (const idx of cfg.indexes ?? []) {
    const t = byName.get(idx.collectionGroup);
    if (!t) continue;
    const opt = (t.optimizations ??= {});
    (opt.compositeIndexes ??= []).push({
      fields: (idx.fields ?? []).map(
        (f: any) => `${f.fieldPath}${f.order === "DESCENDING" ? " ↓" : f.arrayConfig ? " []" : ""}`,
      ),
      scope: idx.queryScope,
    });
  }
  for (const ov of cfg.fieldOverrides ?? []) {
    if (ov.ttl) {
      const t = byName.get(ov.collectionGroup);
      if (t) (t.optimizations ??= {}).ttl = { field: ov.fieldPath, note: "TTL eviction" };
    }
  }
}

export async function buildSchemasGraph(opts: { live?: boolean } = {}): Promise<SchemasGraph> {
  _corpus = null; // fresh corpus each build (the server rebuilds graphs on demand)
  const warnings: Warning[] = [];
  const allTables: TableDef[] = [];
  const allRelations: RelationDef[] = [];
  const databases: { db: Db; engine: string; dbClass: DbClass; tables: number }[] = [];
  let liveRan = false;

  // Run detection for every provider, then introspect only the detected ones.
  const detected = await Promise.all(
    PROVIDERS.map(async (p) => ({ p, on: await p.detect().catch(() => false) })),
  );

  for (const { p, on } of detected) {
    if (!on) continue;
    let result: ProviderResult;
    try {
      result = await p.introspect({ live: opts.live });
    } catch (e) {
      warnings.push({
        kind: "provider-failed",
        detail: `${p.db} introspection failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    // Live actually ran only if no live-unavailable warning was emitted.
    if (opts.live && !result.warnings.some((w) => w.kind === "live-unavailable")) liveRan = true;
    for (const t of result.tables) {
      t.engine ??= p.engine;
      t.dbClass ??= p.dbClass;
    }
    allTables.push(...result.tables);
    allRelations.push(...result.relations);
    for (const w of result.warnings) warnings.push(w);
    databases.push({ db: p.db, engine: p.engine, dbClass: p.dbClass, tables: result.tables.length });
  }

  if (databases.length === 0) {
    warnings.push({ kind: "no-database", detail: "no Firestore/SQL/BigQuery usage detected" });
    return {
      nodes: [],
      edges: [],
      meta: {
        built: new Date().toISOString(),
        source: "static",
        counts: { tables: 0, columns: 0, references: 0, joins: 0, subcollections: 0 },
        warnings,
        databases,
      },
    };
  }

  // Firestore composite indexes / TTL (from firestore.indexes.json, if present).
  await attachFirestoreIndexes(allTables, warnings);

  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const seenNodes = new Set<string>();
  const addNode = (n: SchemaNode) => {
    if (!seenNodes.has(n.data.id)) {
      nodes.push(n);
      seenNodes.add(n.data.id);
    }
  };

  const tableId = (db: Db, name: string) => `${db}:${name}`;
  const colId = (db: Db, table: string, col: string) => `${db}:${table}.${col}`;

  // Index tables for relation resolution and to anchor subcollection subOf ids.
  const tableByDbName = new Map<string, TableDef>();
  for (const t of allTables) tableByDbName.set(`${t.db}:${t.name}`, t);

  // Table + column nodes.
  for (const t of allTables) {
    const tid = tableId(t.db, t.name);
    addNode({
      data: {
        id: tid,
        label: t.name,
        kind: "table",
        db: t.db,
        engine: t.engine,
        dbClass: t.dbClass,
        optimizations:
          t.optimizations && Object.keys(t.optimizations).length ? t.optimizations : undefined,
        matview: t.matview || undefined,
        partitionField: t.partitionField,
        clusterFields: t.clusterFields && t.clusterFields.length ? t.clusterFields : undefined,
        subOf: t.subOf ? tableId(t.db, t.subOf) : undefined,
      },
    });
    for (const f of t.fields) {
      addNode({
        data: {
          id: colId(t.db, t.name, f.name),
          label: f.name,
          kind: "column",
          db: t.db,
          parent: tid,
          fieldType: f.type,
          mode: f.mode,
          description: f.description,
          isKey: f.isKey || undefined,
        },
      });
    }
  }

  // Edges. Every endpoint must resolve to a real node id; otherwise warn.
  let ei = 0;
  const fieldExists = (db: Db, table: string, col: string) =>
    seenNodes.has(colId(db, table, col));

  for (const r of allRelations) {
    const srcTableId = tableId(r.db, r.fromTable);
    const dstTableId = tableId(r.db, r.toTable);
    if (!seenNodes.has(srcTableId)) {
      warnings.push({ kind: "dangling-relation", detail: `${r.kind}: source table ${r.fromTable} (${r.db}) not found` });
      continue;
    }
    if (!seenNodes.has(dstTableId)) {
      warnings.push({ kind: "dangling-relation", detail: `${r.kind}: target table ${r.toTable} (${r.db}) not found` });
      continue;
    }

    if (r.kind === "subcollection") {
      edges.push({
        data: { id: `e${ei++}`, source: srcTableId, target: dstTableId, kind: "subcollection" },
      });
      continue;
    }

    // fk-reference / joins resolve to columns when both are known, else anchor
    // on the table node (so the edge is never dangling).
    let source = srcTableId;
    let target = dstTableId;
    if (r.fromCol && fieldExists(r.db, r.fromTable, r.fromCol)) {
      source = colId(r.db, r.fromTable, r.fromCol);
    }
    if (r.toCol && fieldExists(r.db, r.toTable, r.toCol)) {
      target = colId(r.db, r.toTable, r.toCol);
    } else if (r.kind === "fk-reference") {
      // Reference points at the table's identity — anchor on the table node.
      target = dstTableId;
    }
    edges.push({
      data: {
        id: `e${ei++}`,
        source,
        target,
        kind: r.kind,
        label: r.label,
        confidence: r.confidence,
        sourceFile: r.sourceFile,
      },
    });
  }

  const tableCount = nodes.filter((n) => n.data.kind === "table").length;
  const columnCount = nodes.filter((n) => n.data.kind === "column").length;
  const refCount = edges.filter((e) => e.data.kind === "fk-reference").length;
  const joinCount = edges.filter((e) => e.data.kind === "joins").length;
  const subCount = edges.filter((e) => e.data.kind === "subcollection").length;

  const counts: Record<string, number> = {
    tables: tableCount,
    columns: columnCount,
    references: refCount,
    joins: joinCount,
    subcollections: subCount,
  };
  for (const d of databases) counts[d.db] = d.tables;

  return {
    nodes,
    edges,
    meta: {
      built: new Date().toISOString(),
      source: liveRan ? "live" : "static",
      counts,
      warnings,
      databases,
    },
  };
}
