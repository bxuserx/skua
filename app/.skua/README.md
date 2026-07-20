# .skua — local ticketing dashboard

Local Bun-served HTML dashboard for the `.tickets/` board. Drag tickets
between buckets, edit tickets in the browser, and visualize dependencies +
your codebase. No databases, no build pipeline, no external services — files
on disk are the source of truth.

## Run

```bash
cd .skua
bun run start          # serves at http://127.0.0.1:5174
```

Port override: `PORT=5180 bun run start` (or set `port` in `skua.config.json`).

## What the server does

- `GET /api/buckets` — visible buckets (excludes archive).
- `GET /api/buckets/7-archive` — archive bucket on demand (lazy load).
- `GET /api/tickets/:id` — full ticket (frontmatter + body).
- `PUT /api/tickets/:id` — atomic rewrite (temp file + rename).
- `POST /api/tickets` — create a ticket.
- `POST /api/tickets/:id/move` — `mv` between bucket folders + status update.
- `GET /api/graphs/{tickets|repo-map|skills|adrs|ai}` — cached JSON; `?rebuild=1` to refresh.
- `GET/POST/PUT /api/adrs…` — Architecture Decision Records.

**The server never runs git.**

## Layout

```
.skua/
├── server.ts              # Bun.serve + REST
├── skua.config.ts        # path/port resolver (env + skua.config.json overrides)
├── lib/
│   ├── frontmatter.ts     # YAML parse/serialize (subset)
│   ├── tickets.ts         # list / read / write / move tickets
│   ├── adrs.ts            # ADR lifecycle (FSM-validated)
│   └── graphs/
│       ├── tickets.ts     # depends_on / blocks / related → Cytoscape JSON
│       ├── repo-map.ts    # filesystem walk → dir/file + import-edge graph
│       ├── skills.ts      # SKILL.md frontmatter → connects_to graph
│       ├── adrs.ts        # ADRs + implements_adr edges
│       ├── ai.ts          # Claude Code ecosystem (skills/agents/hooks/MCP/…)
│       └── build-all.ts   # CLI: `bun run build:graphs`
├── public/
│   ├── index.html         # Kanban board (drag/drop)
│   ├── ticket.html        # ticket editor
│   ├── graphs.html        # Cytoscape viewer
│   ├── adrs.html / adr.html
│   ├── app.js / ticket-edit.js / graphs.js / adr*.js / styles.css
│   └── vendor/            # cytoscape + dagre (vendored for offline use)
├── scripts/
│   ├── ticket-cli.ts      # next-id / audit-ids / create
│   └── adr-cli.ts         # next-id / list / read
└── cache/                 # *-graph.json (regenerated on demand)
```

## Frontmatter

Tickets are markdown with a YAML frontmatter block. The link fields drive the
dependency graph:

```yaml
depends_on: []   # IDs this ticket needs done first → solid arrow
blocks: []       # IDs this ticket unblocks         → solid arrow
related: []      # weak link, no direction          → dashed edge
```

Edit them in-browser via the ticket editor, or by hand.

## Graphs

| Graph | Source | Notes |
|---|---|---|
| **repo-map** | a filesystem walk of the repo (richer via the `repo-map` skill) | dirs + files + relative-import edges; the default view |
| **tickets** | every `.tickets/*/TKT-*.md` | nodes coloured by bucket, sized by priority |
| **skills** | every `.claude/skills/*/SKILL.md` | `connects_to` orchestration graph |
| **adrs** | `.tickets/ADRs/*` + ticket `implements_adr` | decisions + the tickets that implement them |
| **ai** | `~/.claude` + project `.claude` + `.mcp.json` + plugins | the full Claude Code ecosystem |

Click any `TKT-*` node in the tickets graph to jump to its editor.

## Configuration

Paths default to the vendored layout (`.skua/` at the repo root, beside
`.tickets/` and `.claude/`). Override via `skua.config.json` at the repo root,
or the `SKUA_REPO_ROOT` / `SKUA_TICKETS_ROOT` / `SKUA_ADRS_ROOT` / `PORT`
environment variables.

## Boundaries (do not violate)

- Never run git — neither in `server.ts` nor in the graph builders.
- No *automatic* deletion: the lifecycle's terminal state is `7-archive`, and
  nothing acting on its own (the server poll, graph builders, skills) ever
  removes a ticket. Outright deletion happens only on an explicit, confirm-gated
  user action in the UI (`DELETE /api/tickets/:id` → `deleteTicket`).
- Localhost-only bind (`127.0.0.1`); no auth layer.
