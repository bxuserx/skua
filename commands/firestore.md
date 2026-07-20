---
allowed-tools: Bash(bun .skua/scripts/firestore.ts:*), Bash(bun run firestore:*), Read
description: Enable or manage the optional Firestore mirror of the ticket board (status → Firestore via local Google credentials)
---

Manage skua's optional **Firestore mirror** (see the `firestore` skill).

Parse `$ARGUMENTS` as the verb (default `status`):

- **(empty) / `status`** — run `bun .skua/scripts/firestore.ts status` and report: whether the mirror is configured, the projectId / database / collection / board, whether a token can be minted from local ADC, and the cached-doc count. If it's OFF, tell the user how to enable it.
- **`enable` / `init`** — run `bun .skua/scripts/firestore.ts init` (pass a `--project <id>` through if the user gave one). This writes the `firestore` block, verifies credentials + database with a probe, and backfills the board. Surface any remediation the CLI prints (missing database, missing IAM role, or `gcloud auth application-default login`).
- **`sync`** — run `bun .skua/scripts/firestore.ts sync` and report how many docs changed.
- **`test`** — run `bun .skua/scripts/firestore.ts test` and report whether the probe write/delete succeeded.
- **`off`** — run `bun .skua/scripts/firestore.ts off` and relay how to disable (add `--write-config` to actually remove the block only if the user asks).

Prerequisites for enabling: a GCP project with a Firestore database (Native mode), `gcloud auth application-default login`, and the `roles/datastore.user` role. Once enabled, ticket status syncs automatically — the user does not run this per change.

This command only reads config and runs the firestore CLI; it does not edit code or move tickets.
