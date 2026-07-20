# Introspection Signatures

The catalog the `introspect-codebase` op feeds to its `Explore` subagent. Each signature is a (pattern, evidence-shape, signal-type) triple — the subagent grep-walks the repo and returns matches with `file:line` evidence.

Every match MUST have evidence. A signature that finds no evidence yields no signal.

## v0.2 changelog

Three refinements driven by lessons from prior self-tests:

1. **Payments/billing providers re-categorized** from "Data layers" → new "External services" section. A payments provider (e.g. Stripe) is an API the codebase calls into, not a persistent store the codebase reads/writes its own data from. Downstream mapping unchanged — `subscription-tier-audit` is still the right proposal when a payments provider is present.
2. **Allow/deny scope filter pattern tightened.** An early introspector cited a weak inline assignment (e.g. `_WHITELIST = "..."`) when the canonical constant lived in a dedicated constants module. v0.2 prefers the canonical-constant location and treats inline lists / single-assignment constants as **weak evidence** (signal still fires but lower confidence).
3. **Cost-sensitive operations gain a concrete full-scan grep pattern.** An early version mentioned per-query / partition-filter cost as a pattern but gave no actionable regex; v0.2 documents a multiline pattern for detecting `FROM <namespace>.<dataset>.<table>` blocks (any metered query engine) without a `WHERE`-clause filter on the table's partition/clustering column within ~10 lines.

---

## Deploy unit signatures

What counts as a deploy unit: a top-level directory that ships independently (own Dockerfile, own dependency manifest, own framework signature).

No stack is privileged — this is an open catalog; a repo typically matches a small subset. Every row carries the same generic placeholder evidence shape; substitute the actual matched path at detection time.

| Signal | Patterns | Evidence shape |
|---|---|---|
| **JS/TS SPA or SSR frontend (Next.js)** | `<frontend-dir>/package.json` containing `"next":`; `next.config.{js,ts,mjs}`; `app/` or `pages/` dir | `<frontend-dir>/package.json:<line>` |
| **JS/TS frontend (Vue/Nuxt)** | `nuxt.config.*`; `package.json` containing `"vue":` / `"nuxt":` | `<frontend-dir>/package.json:<line>` |
| **JS/TS frontend (SvelteKit)** | `svelte.config.*`; `package.json` containing `"@sveltejs/kit":` | `<frontend-dir>/package.json:<line>` |
| **JS/TS frontend (Angular)** | `angular.json`; `package.json` containing `"@angular/core":` | `<frontend-dir>/package.json:<line>` |
| **JS/TS SPA (Vite)** | `vite.config.*`; `package.json` containing `"vite":` | `<frontend-dir>/package.json:<line>` |
| **Python web backend (FastAPI)** | `*.py` containing `from fastapi import` AND `app = FastAPI(`; `requirements.txt` containing `fastapi` | `<backend-dir>/<entry>.<ext>:<line>` |
| **Node backend (Express/Nest)** | `package.json` containing `"express":` / `"@nestjs/core":`; an HTTP-server entrypoint | `<backend-dir>/<entry>.<ext>:<line>` |
| **Python web backend (Django)** | `manage.py`; `settings.py` with `INSTALLED_APPS` | `<backend-dir>/<entry>.<ext>:<line>` |
| **Ruby backend (Rails)** | `config/routes.rb`; `Gemfile` containing `rails` | `<backend-dir>/<entry>.<ext>:<line>` |
| **JVM backend (Spring Boot)** | `pom.xml` / `build.gradle` containing a Spring Boot starter; `@SpringBootApplication` | `<backend-dir>/<entry>.<ext>:<line>` |
| **.NET backend** | `*.csproj`; `Program.cs` with a web host builder | `<backend-dir>/<entry>.<ext>:<line>` |
| **Go backend (Gin/net-http)** | `go.mod` AND a `func main()` registering routes | `<backend-dir>/<entry>.<ext>:<line>` |
| **PHP backend (Laravel)** | `composer.json` containing `laravel/framework`; `artisan` | `<backend-dir>/<entry>.<ext>:<line>` |
| **Containerized service** | `Dockerfile` adjacent to a service; matching dependency manifest | `<service-dir>/Dockerfile:<line>` |
| **Bun dashboard** | `package.json` containing `"bun":` or `"@types/bun":`; `bun.lockb` | `<frontend-dir>/package.json:<line>` |
| **Static site** | `index.html` at root OR `_config.yml` (Jekyll) OR `astro.config.*` | `<frontend-dir>/index.html:<line>` |
| **Python CLI/library** | `pyproject.toml` containing `[project.scripts]` or `[tool.poetry.scripts]` | `pyproject.toml:<line>` |
| **Node CLI** | `package.json` containing `"bin":` | `package.json:<line>` |
| **iOS/Android mobile** | `*.xcodeproj`, `*.gradle`, `AndroidManifest.xml` | `<mobile-dir>/<project>:<line>` |
| **Rust service** | `Cargo.toml` containing `[[bin]]` | `Cargo.toml:<line>` |
| **Go service** | `go.mod` AND `main.go` containing `func main()` | `<service-dir>/main.go:<line>` |

---

## Data layer signatures

What counts as a data layer: a persistent store the codebase reads from or writes to.

No store is privileged — substitute the actual matched client/init module at detection time. Evidence shapes below use generic roles: `<datastore-client-module>` (a SQL/warehouse client wrapper), `<datastore-client>` (a document-store handle), `<auth-sdk-init>` (a managed-auth SDK init).

| Signal | Patterns | Evidence shape |
|---|---|---|
| **BigQuery** | `from google.cloud import bigquery`; `@google-cloud/bigquery`; `bq query` in shell scripts | `<datastore-client-module>:<line>` |
| **AWS Athena** | `boto3.client('athena')`; `start_query_execution`; `athena://` / PyAthena | `<datastore-client-module>:<line>` |
| **Snowflake** | `snowflake.connector`; `snowflake-sqlalchemy`; `.snowflakecomputing.com` account URLs | `<datastore-client-module>:<line>` |
| **Redshift** | `redshift_connector`; `redshift+psycopg2://`; `*.redshift.amazonaws.com` URLs | `<datastore-client-module>:<line>` |
| **PostgreSQL (asyncpg)** | `import asyncpg`; `asyncpg.connect`; `postgresql://` URLs | `<datastore-client-module>:<line>` |
| **PostgreSQL (psycopg)** | `import psycopg`; `psycopg2`; `psycopg.connect` | `<datastore-client-module>:<line>` |
| **PostgreSQL (SQLAlchemy)** | `from sqlalchemy`; `create_engine("postgresql://"` | `<datastore-client-module>:<line>` |
| **MySQL** | `import pymysql`; `mysql.connector`; `mysql://` URLs | `<datastore-client-module>:<line>` |
| **SQLite** | `import sqlite3`; `*.db` or `*.sqlite` files committed | `<datastore-client-module>:<line>` |
| **Firestore** | `from google.cloud import firestore`; `firebase-admin`; `firestore.rules` | `<datastore-client>:<line>` |
| **Firebase Auth** | `import firebase_admin`; `firebase/auth` in JS; `firebase.json` | `<auth-sdk-init>:<line>` |
| **Redis** | `import redis`; `ioredis`; `redis://` URLs | `<datastore-client-module>:<line>` |
| **MongoDB** | `pymongo`; `mongoose`; `mongodb://` URLs | `<datastore-client>:<line>` |
| **Kafka** | `kafka-python`; `kafkajs`; `KAFKA_BOOTSTRAP_SERVERS` env | `<datastore-client-module>:<line>` |
| **Elasticsearch** | `elasticsearch-py`; `@elastic/elasticsearch` | `<datastore-client-module>:<line>` |
| **S3 / GCS object storage** | `boto3.client('s3')`; `from google.cloud import storage`; bucket env vars | `<datastore-client-module>:<line>` |

For each match, also capture: (a) read-only vs read-write usage (look for `INSERT`, `UPDATE`, `client.write_*`, `bucket.upload_*`), (b) which deploy unit imports the client.

**Not in this section** (per v0.2): **Stripe**, **Sentry**, **Datadog**, **SendGrid**, **Twilio**, and other external services that the codebase calls into but does not own data ownership of. These move to "External services" below. The downstream heuristic mapping is unaffected — `subscription-tier-audit` still fires on Stripe regardless of which section the signal lives in.

---

## External services

External APIs the codebase calls into for capability rather than for data storage. Distinct from data layers because the codebase doesn't OWN the data — it sends requests and receives responses, often with side effects on the external service. Downstream heuristics (subscription-tier-audit, observability skills, etc.) consume signals from this section the same way they consume from data layers.

| Signal | Patterns | Evidence shape |
|---|---|---|
| **Payments / billing provider (e.g. Stripe)** | `stripe.api_key`; `@stripe/stripe-js`; `@stripe/react-stripe-js`; webhook signature constants | `<billing-integration-module>:<line>` |
| **Error tracking (e.g. Sentry)** | `sentry_sdk.init`; `@sentry/nextjs`; `@sentry/node` | `<integration-module>:<line>` |
| **APM / metrics (e.g. Datadog)** | `datadog`; `ddtrace`; `@datadog/browser-rum` | `<integration-module>:<line>` |
| **Transactional email (SendGrid / Postmark / SES)** | `sendgrid`; `postmark`; `boto3.client('ses')` | `<integration-module>:<line>` |
| **SMS / voice (e.g. Twilio)** | `twilio`; `twilio.rest.Client` | `<integration-module>:<line>` |
| **LLM API (OpenAI / Anthropic / generic)** | `openai`; `anthropic`; `@anthropic-ai/sdk` (skip if this skill IS the consumer — context-dependent) | `<integration-module>:<line>` |
| **Notifications (e.g. Slack)** | `slack_sdk`; `@slack/web-api`; webhook URLs | `<integration-module>:<line>` |
| **Source-host API (e.g. GitHub)** | `PyGithub`; `octokit`; `gh` CLI invocations from code | `<integration-module>:<line>` |

---

## Cross-cutting concern signatures

What counts as a cross-cutting concern: a domain that touches multiple deploy units OR doesn't map cleanly to a single one.

| Signal | Patterns | Evidence shape |
|---|---|---|
| **Authentication** | managed-auth SDK import (e.g. `firebase-admin`); `verifyIdToken`; OAuth callback routes; `Authorization: Bearer`; JWT decode | `<auth-module>:<line>` |
| **Subscription / billing** | payments-SDK key (e.g. `stripe.api_key`); `webhook_secret`; subscription/plan/tier columns; entitlement claims | `<billing-route>:<line>` |
| **Webhook handling** | `webhook` in route paths; signature verification (`hmac.compare_digest`, provider `construct_event`) | `<webhook-route>:<line>` |
| **Rate limiting** | `from slowapi`; `@limiter.limit`; `RateLimiter` middleware; edge/CDN config | `<middleware-module>:<line>` |
| **CORS** | `CORSMiddleware`; `allow_origins`; `Access-Control-Allow-Origin` | `<middleware-module>:<line>` |
| **Observability — logging** | `import logging` with structured logging; `loguru`; `structlog`; `pino` | `<logging-init>:<line>` |
| **Observability — tracing** | `opentelemetry`; `sentry_sdk.init`; `datadog`; `@sentry/nextjs` | `<tracing-init>:<line>` |
| **Observability — metrics** | `prometheus_client`; `@opentelemetry/api-metrics` | `<metrics-init>:<line>` |
| **Cost-sensitive operations** | metered-query full scans without a partition/cluster filter (see "Unbounded full-scan / per-query-cost pattern" below); large `SELECT *`; unbounded loops over expensive APIs | `<query-module>:<line>` |
| **Numeric conventions** | scale comments (percent-vs-decimal, units); `_pct` / `_bps` / `_cents` column suffixes; `Decimal(...)` usage in money/measurement code | `<schema-or-model>:<line>` |
| **Batch / pipeline pattern** | repeated `*_job` / `*_processor` / `*_runner` modules sharing a common row schema; directories like `jobs/`, `processors/`, `pipelines/` | `<pipeline-module>:<line>` |
| **Allow / deny scope filter** | a named allow/deny scope constant (e.g. `*_WHITELIST` / `*_ALLOWED` / `*_EXCLUDED`) in a dedicated constants module (canonical strong evidence); similar named constants elsewhere (medium evidence); hard-coded inline lists, single-assignment constants (weak evidence — signal still fires but lower confidence) | prefer the canonical `<constants-module>:<line>` when that location matches |

### Unbounded full-scan / per-query-cost pattern (v0.2, expands "Cost-sensitive operations")

Applies to ANY metered query engine — one that charges per byte scanned or per query (e.g. BigQuery, Athena, Snowflake, Redshift, Databricks SQL). When a query reads a large partitioned/clustered table without a `WHERE` clause filtering the table's declared partition/clustering column, the engine full-scans the table — for large tables (>100K rows) this is typically a P0 cost finding (high scan cost).

The introspection subagent should grep for `FROM` clauses of `<namespace>.<dataset>.<table>` shape (or backtick/quoted equivalents) and confirm a `WHERE` clause referencing the partition/clustering-column predicate appears within ~10 lines of the `FROM`. The predicate column is whatever the table declares as its partition/clustering column — commonly a timestamp/date column (e.g. a `ts` / `date` / `*_ts` / `*_date` column).

**BigQuery-flavored example (Python regex, DOTALL) — one engine's syntax; adapt the table-reference shape and column name per engine:**

```python
FROM\s+`?\w+\.\w+\.\w+`?(?:[^;]{0,500})WHERE(?:[^;]{0,500})\b(?:ts|date|\w+_ts|\w+_date)\s*(>=|>|=|BETWEEN)
```

Match → partition-filtered (clean). **Non-match → flag as missing-partition-filter** for a downstream cost-sizing step to size + price. The introspection subagent should report the offending `file:line` of the `FROM` clause and the table name; cost projection is downstream work, not this skill's.

False-positive notes:
- A small lookup table (`<10K rows`) doesn't need a partition filter; the size check is downstream too.
- `SELECT FROM ... LIMIT 1` is sometimes safe even without a partition filter (depends on table layout) but flag anyway — let the downstream cost-sizing step decide.
- Subqueries with their own partition filter on the same table count; the regex above doesn't catch nested cases, so flag-and-let-downstream-decide is the right discipline.

---

## Deploy target signatures

| Signal | Patterns | Evidence shape |
|---|---|---|
| **GCP Cloud Run** | `gcloud run deploy`; `cloud-run-*.yaml`; `Cloud Run` in deploy docs | `<build-file>:<line>` |
| **GCP Cloud Scheduler** | `gcloud scheduler`; `cloud-scheduler-*.yaml` | `<deploy-config>:<line>` |
| **AWS Lambda** | `serverless.yml`; `template.yaml` (SAM); `lambda_handler` | `<deploy-config>:<line>` |
| **AWS ECS / Fargate** | `task-definition.json`; `ecs-cli` | `<deploy-config>:<line>` |
| **Vercel** | `vercel.json`; `.vercel/` | `<deploy-config>:<line>` |
| **Netlify** | `netlify.toml`; `_redirects` | `<deploy-config>:<line>` |
| **Fly.io** | `fly.toml` | `<deploy-config>:<line>` |
| **Docker (generic)** | `Dockerfile`; `docker-compose*.yml` | `<service-dir>/Dockerfile:<line>` |
| **Kubernetes** | `*.yaml` with `apiVersion: apps/v1` and `kind: Deployment` | `<deploy-config>:<line>` |

---

## Subagent prompt fragment

When the `Explore` subagent is spawned, include this signature catalog inline. Instruct it to walk the repo with these patterns, return the structured report defined in `SKILL.md § introspect-codebase`, and **only return signals with file:line evidence**. No evidence → no entry.
