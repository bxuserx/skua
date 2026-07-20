---
id: TKT-102
title: "Check for bugs"
status: "Todo"
priority: "Medium"
assignee: "Claude-Agent"
created: 2026-06-16
domain: "qa"
tags:
  - bugs
  - quality
depends_on: []
blocks: []
related: []
files_touched: []
complexity: 3
---

## Objective

Run a fan-out bug hunt across the codebase and file each verified finding back into the backlog.

## Context

This is the standing quality pass. The `bug-scan` skill spawns parallel hunters, adversarially verifies every candidate to drop false positives, and files the survivors as backlog tickets. Run it interactively with `/bug-scan`, or let `setup.sh` trigger the headless pass.

## Acceptance Criteria

- [ ] `/bug-scan` completes a full fan-out + adversarial-verify pass.
- [ ] Every confirmed bug is filed as its own backlog ticket with a repro and a proposed fix.
- [ ] False positives are dropped during verification, not filed.
