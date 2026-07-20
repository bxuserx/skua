---
id: ADR-001
title: "Familiarize yourself with the skua UI"
status: proposed
version: 1
created: 2026-06-17
decided: null
deciders: []
supersedes: []
superseded_by: null
related_tickets: []
proposed_tickets: []
materialized_tickets: []
tags:
  - onboarding
  - ui
  - sample
domain: meta
---

### TL;DR

This is a sample Architecture Decision Record — its real job is to get you oriented. skua's dashboard is the single local surface for three things: the **board** (your tickets), the **graphs** (your codebase, visualized), and **ADRs** (durable decisions like this one). Spend two minutes clicking through the tabs; this record doubles as the tour.

### Decision

Treat the skua dashboard at `http://127.0.0.1:5174` as home base for tracked work and codebase understanding:

- **Board** (`/`) — tickets flow left-to-right through lifecycle buckets (backlog → staging → building → testing → validating → complete). Drag a card between columns, or click it to edit its markdown in place.
- **Graphs** (`/graphs/…`) — four views of this repo: **dataflow** (architecture diagram), **schemas** (your databases), **ai** (the Claude Code skill / agent / hook ecosystem), and **tickets** (dependency links across the board).
- **ADRs** (`/adrs`) — decisions, each a folder with versions, references, and comments. You're reading ADR-001.

### Consequences

- New work starts as a ticket on the board; significant decisions get written down as ADRs and linked to the tickets that carry them out.
- The dashboard is read/write and localhost-only — your edits land as plain markdown on disk under `.tickets/`. Nothing leaves your machine.
- Because it's just files, you can drive everything from the UI, the `ticket-manager` / `adr-manager` skills, or the CLI — all three read and write the same source of truth.

### Alternatives considered

- **An external tracker / wiki (Jira, Notion, etc.)** — rejected for a local-first tool: it splits the source of truth off-disk and off-repo, breaking the "markdown files are the truth" model.
- **A README or scattered docs for decisions** — rejected: no lifecycle, no supersede chain, no link to the tickets that implement a decision. ADRs give a decision a status and an audit trail.
