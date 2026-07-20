# Database classes & optimization documentation — the schema-graph standard

The contract for `schemas.ts` (the `/graphs/schemas` builder) and every
`SchemaProvider`. Each detected engine is mapped to **one of six canonical
classes**; each class implies a family of data-organization / query-optimization
mechanisms. Providers detect those mechanisms **statically at init/setup**
(`bun run build:graphs`, no credentials) by parsing the artifacts where they are
declared, and record them in `TableDef.optimizations` so the dashboard documents,
per table: **what the DB is (class + engine), what tables it has, and how each is
physically structured.**

Single source of truth in code: `DbClass`, `DB_CLASS_OF` (engine→class),
`DB_CLASS_OPTIMIZATIONS` (the family blurb), and `TableOptimizations` in
`schemas.ts`. This doc is the human contract behind them — keep them in sync.

## The six classes

| # | `DbClass` | Examples (OSS · AWS · GCP · Azure) | Data organization & query-optimization mechanisms |
|---|---|---|---|
| 1 | `relational` | PostgreSQL/MySQL/SQL Server · RDS/Aurora · Cloud SQL/AlloyDB · Azure SQL | B-tree/Hash/GIN/GiST indexes · **covering** (`INCLUDE`) · tablespaces/filegroups · **RANGE/LIST/HASH partitioning** · sharding |
| 2 | `document` | Mongo/Cassandra/Redis · DynamoDB/DocumentDB · Firestore · Cosmos | **GSI/LSI** · composite keys (`UserID#Date`) · **composite indexes** · **TTL** eviction · partition salting / pre-split |
| 3 | `analytical` | Snowflake/Databricks · Redshift · **BigQuery** · Synapse/Fabric | **columnar storage** · **partitioning** · **sort/clustering keys** · **MPP distribution** (KEY/EVEN/ALL) · **materialized views** (auto-rewrite) · search indexes |
| 4 | `newsql` | CockroachDB/YugabyteDB · Aurora Global · Cloud Spanner · Cosmos (strong) | **interleaved (co-located) tables** · **non-sequential PKs** (UUID/bit-reversed) · range-split directories |
| 5 | `wide-column` | Cassandra/ScyllaDB/HBase · Keyspaces/Timestream · Bigtable · Cosmos (Cassandra) | **row-key engineering** (`SensorID#YYYYMMDD`, lexicographic) · **column families** · size-tiered / leveled **compaction** |
| 6 | `vector` | Pinecone/Milvus/Qdrant/Weaviate · pgvector · Vertex/Cosmos vector | **HNSW** graph · **IVF-PQ** · **scalar quantization** (ANN search) |

`DB_CLASS_OF` maps a lowercased engine name to its class. Add a row there and the
engine classifies automatically.

## Detection contract — what each provider parses and fills

A provider sets `engine` + `dbClass`, lowers tables into `TableDef`, and fills
ONLY the `TableOptimizations` slots its class uses. Everything is static (parse
source); the `live` seam (behind `?live=1` / credentials) may later verify against
the engine's catalog.

| Provider | Class · engine | Reads | Fills (`TableOptimizations`) |
|---|---|---|---|
| `BigQueryProvider` | `analytical` · BigQuery | `setup_tables.py` `SchemaField` blocks (`clustering_fields`, `time/range_partitioning`, `require_partition_filter`) | `partition` (TIME/RANGE + unit + requireFilter), `clustering`, `materialized` |
| `SqlProvider` | `relational` · PostgreSQL/MySQL/SQLite | `*.sql` (`CREATE TABLE`/`CREATE INDEX`/`ALTER … ADD PRIMARY KEY`/`PARTITION BY`), Prisma, Drizzle. **Ignores BigQuery-dialect `.sql`** (`looksLikeBigQuerySql`) so a BQ migration never registers a phantom relational table. | `primaryKey`, `indexes` (method/unique/covering/partial), `partition` (RANGE/LIST/HASH) |
| `FirestoreProvider` | `document` · Firestore | collection/subcollection chains in app code; `firestore.indexes.json` (`indexes[]`, `fieldOverrides[].ttl`) | `compositeIndexes`, `ttl`. Absent file → `firestore-indexes-undeclared` warning (console-managed). |

Slots `distribution`, `rowKey`/`columnFamilies`, and `vectorIndex` are defined for
classes 3–6 and wired through rendering.

### Generic detectors (classify-all)

Beyond the three deep providers, `ENGINE_SIGNATURES` + `GenericEngineProvider`
detect **every other engine** in the taxonomy (Mongo/DynamoDB/Redis/Cosmos/Couchbase ·
Redshift/Snowflake/Synapse/Databricks/ClickHouse · Spanner/Cockroach/Yugabyte ·
Cassandra/Scylla/Bigtable/HBase/Timestream · pgvector/Pinecone/Milvus/Qdrant/Weaviate).
Each signature is `{ key, engine, dbClass, deps?, src?, tables? }`:

- **Signals favor package deps + high-specificity source patterns** — connection URIs,
  SDK class names, engine-specific DDL with syntax. **Never bare case-insensitive words:**
  a token like `sortKey` must not imply Redshift. *A mention is not usage.*
- A cheap `tables()` extractor (Mongoose models, DynamoDB `TableName`, CQL
  `CREATE TABLE` + composite PK) captures names / row-keys best-effort.
- Otherwise the engine emits **one classified identification node** so the DB *type* is
  still documented, with a `notes` line ("schema is runtime / console-managed").
- All detectors share one memoized source corpus per build (`sourceCorpus`).

**Shallow boundary:** a Redshift/Snowflake `.sql` is parsed for *structure* by the
relational provider while the analytical *engine* is identified separately — the table
is not yet re-attributed to the analytical engine. Deepen by adding a dialect-aware
analytical SQL path if needed.

## Engine attribution (raw `.sql`)

A bare `.sql` file carries no engine tag, and BigQuery DDL *looks* like SQL
(`CREATE TABLE … PARTITION BY … CLUSTER BY …`). Attribution rule:
`looksLikeBigQuerySql()` (backtick `${proj}.${ds}.tbl` FQNs, `FLOAT64`/`STRUCT<>`,
`OPTIONS(description=…)`, `bq query`, `CLUSTER BY`) routes a file to the
BigQuery provider; otherwise it is relational. Without this, the same logical
table double-cards under two engines.

## Rendering

Table cards + the inspector show a **class chip** (`ANALYTICAL · BigQuery`) and a
compact **optimization line** built by `fmtOptimizations()` in `graphs.js` from
`data.optimizations`. The chip/line stay in sync with this taxonomy via
`DB_CLASS_LABEL` (a mirror of `DbClass`).

## Extending

1. Add the engine → `DB_CLASS_OF` (and `DB_CLASS_LABEL` in `graphs.js` if a new class).
2. Give the provider `engine` + `dbClass`; fill the class's optimization slots from
   wherever they're declared in-repo.
3. Add a row to the **Detection contract** table above.
4. `fmtOptimizations()` already renders any slot present — extend it only for a new slot shape.
