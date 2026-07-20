---
id: TKT-101
title: "Run the skua setup"
status: "Todo"
priority: "High"
assignee: "Claude-Agent"
created: 2026-06-16
domain: "meta"
tags:
  - setup
  - onboarding
depends_on: []
blocks: []
related: []
files_touched: []
complexity: 1
---

## Objective

Install skua into a repo: vendor the dashboard, install the skills + hook, scaffold the board, and build the graphs.

## Context

`setup.sh` is idempotent and non-destructive. It copies `app/.skua` into `<repo>/.skua`, merges the hook into `<repo>/.claude/settings.json`, scaffolds `<repo>/.tickets/` with the lifecycle buckets, writes `skua.config.json` + a starter `CLAUDE.md`, builds the dataflow/schemas/ai graphs, and — if Claude Code is present — runs an initial `bug-scan` to seed the backlog.

## Acceptance Criteria

- [ ] `bash setup.sh /path/to/your/repo` exits 0.
- [ ] `<repo>/.skua`, `<repo>/.claude/skills`, and `<repo>/.tickets` all exist.
- [ ] `cd <repo>/.skua && bun run start` serves the board at http://127.0.0.1:5174.

## Pass-2 review

Cold-reader pass: scope is clear and self-contained, the script is idempotent, and the AC are verifiable from the shell. Ready to approve and build.
