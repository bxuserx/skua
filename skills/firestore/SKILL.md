---
name: firestore
description: "Optional Firestore mirror of the skua ticket board. Reflects each ticket's status + metadata into a Firestore collection so the board can be watched from OUTSIDE the repo (a phone, a shared page, a cron report). Zero-dependency: mints a token from your local Google Application Default Credentials and calls the Firestore REST API — no firebase-admin / @google-cloud/firestore. Layered + convergent: real-time upserts fire from the ticket mutators (dashboard, chaos, auto-archive), and a diffed full-board reconcile runs from the dashboard poll, the chaos loop, and an end-of-turn hook, so every status change lands even when tickets are moved by hand. Opt-in and graceful: with no `firestore` block in skua.config.json (or SKUA_FIRESTORE_DISABLE=1) it no-ops everywhere, and a sync error can never break a ticket op."
when_to_use: "When you want ticket status mirrored to Firestore: 'enable firestore for skua', 'sync tickets to firestore', 'set up the firestore mirror', '/firestore'. Also for troubleshooting the mirror (auth, permissions, project/database). NOT needed for normal ticket work — once enabled it runs automatically."
connects_to:
  - handoff:ticket-manager
kind: integration
---

# Firestore mirror

Skua's board lives as markdown files on disk. **Firestore mirror** reflects each ticket's current status + metadata into a Firestore collection so you can watch the board from OUTSIDE the repo — a phone, a shared dashboard, a Slack/cron report — without exposing the filesystem.

It is **deterministic and zero-dependency**: it mints an access token from your local Google Application Default Credentials (ADC) and writes to the Firestore REST API with `fetch` — no `firebase-admin`, no `@google-cloud/firestore`. Credentials are NEVER stored in config or git.

## Why it's reliable (the design)

Tickets are moved by three independent actors — the dashboard server, Claude following the `ticket-manager` skill (a plain `mv` + edit), and the headless chaos supervisor — so no single hook catches everything. The mirror is therefore **layered + convergent**:

- **Real-time** — `syncTicket` fires from the `moveTicket` / `writeTicket` / `createTicket` / `deleteTicket` primitives in `lib/tickets.ts`, so every *programmatic* move (dashboard drag, all chaos transitions, the 7-day auto-archive, ADR rollback) mirrors within a moment.
- **Convergent reconcile** — a diffed full-board `syncBoard` runs from the dashboard's 5s poll, once per chaos loop, and from an end-of-turn **Stop hook** — this closes the interactive raw-`mv` gap and self-heals any missed event. A local hash cache means a reconcile only writes the docs that actually changed, so the layers never thrash.

Miss one trigger and the next one catches up — there's no correctness hole.

## Enabling it (one-time)

1. **Google Cloud prerequisites** (you likely have these):
   - a GCP project with a **Firestore database in Native mode** (create one at <https://console.cloud.google.com/firestore>, or `gcloud firestore databases create --location=<region>`);
   - **local credentials**: `gcloud auth application-default login`;
   - your identity needs the `roles/datastore.user` role on the project.
2. **Turn it on** — from the repo root:
   ```
   bun .skua/scripts/firestore.ts init --project <your-gcp-project-id>
   ```
   `init` writes a `firestore` block to `skua.config.json`, verifies the credentials + database with a probe write/delete, and does a first full backfill of the board. `--project` is optional — it defaults to your `gcloud config` project, then your ADC quota project.

   `setup.sh --firestore` runs the same thing during install.

The `firestore` block (all optional except `projectId`):
```jsonc
"firestore": {
  "projectId": "my-gcp-project",   // REQUIRED — enables the mirror
  "database": "(default)",          // optional (default shown)
  "collection": "skua_tickets",    // optional — top-level collection for ticket docs
  "board": "my-repo",               // optional — namespace so one DB serves many repos (default: repo dir name)
  "prune": false                    // optional — delete remote docs whose ticket file is gone
}
```

## Credentials (token resolution)

The mirror never stores a secret. At runtime it mints an access token from your
local Google credentials, trying in order: **(1) ADC** (`gcloud auth
application-default login` — user creds, refreshed via a pure `fetch` or gcloud),
then **(2) the active gcloud account** (`gcloud auth print-access-token` —
whatever `gcloud config` points at, *including an activated service account*). So
a machine whose ADC is stale but that has an activated service account (common on
servers/backends) still works. Whichever identity mints the token needs
`roles/datastore.user` on the project. Tokens are cached ~50 min under
`.skua/cache/firestore/` (gitignored, mode 0600).

## What's stored

One document per ticket at `skua_tickets/{board}__{TKT-id}`, holding: `ticketId`, `board`, `title`, `status`, `bucket`, `priority`, `domain`, `complexity`, `tags`, `depends_on`, `blocks`, `related`, `files_touched`, `next_step_hint`, `created`, `completed`, the chaos fields (`chaos_branch`, `merged`, `merge_conflict`) when present, and a `syncedAt` timestamp. The ticket **body** is not stored — this mirrors *status*, not content.

## Commands

```
bun .skua/scripts/firestore.ts status   # resolved config + token check + cached-doc count
bun .skua/scripts/firestore.ts sync      # forced full-board reconcile (also runs on every turn)
bun .skua/scripts/firestore.ts test      # probe write/delete — proves creds + DB + IAM
bun .skua/scripts/firestore.ts init      # (re)write config, verify, backfill
bun .skua/scripts/firestore.ts off       # how to disable  (--write-config removes the block)
```
or, from `.skua/`, `bun run firestore <verb>`.

## Troubleshooting

- **`403` / permission denied** → grant `roles/datastore.user`:
  `gcloud projects add-iam-policy-binding <project> --member='user:<you>' --role=roles/datastore.user`
- **`404` / database not found** → create a Firestore database (Native mode) in the project.
- **no token / credential error** → `gcloud auth application-default login`.
- Failures are logged to `.skua/cache/firestore/sync.log` and NEVER affect ticket operations.

## Kill switch

`SKUA_FIRESTORE_DISABLE=1` forces a no-op everywhere. To disable permanently, remove the `firestore` block from `skua.config.json` (`bun .skua/scripts/firestore.ts off --write-config`).

## Repo-scoped, by construction

The token cache + per-doc hash cache live under `.skua/cache/firestore/` (gitignored) — never machine-global, never `~/.claude`. Consistent with the chaos repo-scoping guard.
