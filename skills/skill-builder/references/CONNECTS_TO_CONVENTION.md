# `connects_to` and `kind` — Local Conventions

These two frontmatter fields are **local to this project** — they are
NOT defined in the official Anthropic skills spec
(https://code.claude.com/docs/en/skills.md#frontmatter-reference).

They drive the `/graphs/skills` view in the `.skua` dashboard
(http://127.0.0.1:5174/graphs/skills) and the `skill-builder.list-orphans`
operation. Tools outside this project ignore them safely.

## `connects_to`

A list of skill slugs that this skill routes to or hands off to. Each entry can be a bare slug (legacy = `handoff`) or a typed `kind:slug` string. Two edge kinds are recognized:

| Prefix | Meaning | When to use |
|---|---|---|
| `parent:` | **A is B's canonical entry point.** "Where do I start to reach B?" answer is A. The graph's `parent` filter view shows ONLY these edges, producing a forest of trees. | Orchestrators marking their cluster of subskills. Each subskill should have **exactly one** parent edge across the whole portfolio (multi-parent is a `multi-parent` audit warning). |
| `handoff:` | **A invokes/recommends B but isn't B's owner.** Cross-cluster handoffs and shared primitives (e.g. `bug-scan → ticket-manager`; many skills → a shared `<domain>-migration-runner`). This is the default if no prefix is given. | Cross-cluster invocations, leaf reuse, post-work handoffs. |

Prose-only "see also" pointers between skills should NOT add an edge — write the reference in the body or in `references/` and leave `connects_to` for things that are actually invoked.

```yaml
connects_to:
  - parent:<leaf-skill>        # I am <leaf-skill>'s canonical entry point
  - parent:<another-leaf>
  - handoff:ticket-manager     # I dispatch to ticket-manager but it has its own parent
  - bug-scan                   # legacy bare slug = handoff (preserved for backwards-compat)
```

Empty list for self-contained skills:

```yaml
connects_to: []
```

### Edge semantics

- **Directional**. `A → B` means A points at B. With a `parent:` prefix, A is B's owner; with `handoff:`, A invokes B without owning it.
- **No bidirectional shorthand**. If B also points back at A, B has its own `connects_to:` entry.
- **Targets must exist**. Every slug listed must resolve to a real `.claude/skills/<slug>/` directory. `audit-skill` flags broken edges as P1.
- **Exactly one parent per target.** Two skills marking themselves as `parent:` of the same target is a portfolio smell — the graph builder emits a `multi-parent` warning. Pick one canonical owner; the other becomes `handoff:`.

### How to choose

Walk this decision tree per outgoing edge:

1. Does this skill **invoke** the target (directly or via a documented routing rule)?
   - **No** → no edge. Mention the target in prose if you want a "see also."
   - **Yes** → continue.
2. Is this skill the **canonical place a user starts** to reach the target? → `parent:`
3. Otherwise (shared leaf primitive, cross-cluster handoff, post-work fan-out) → `handoff:`

### When to add an edge

- **Orchestrator → subskill**. The orchestrator's body explicitly
  dispatches to the subskill (e.g. a `<domain>-router` →
  `<domain>-implementation-audit`).
- **Leaf → next-step skill**. The leaf's body recommends or invokes a
  follow-on skill (e.g. a hypothetical `payments-scaffold` →
  `migration-runner`, because after scaffolding a new thing the user
  typically runs a migration).
- **Generator → consumer**. A builder that depends on another
  builder (e.g. `repo-map` → a downstream graph that reuses its cache).

### When NOT to add an edge

- The two skills happen to share a domain or naming prefix but neither
  invokes nor recommends the other.
- The skills could *theoretically* compose but the body doesn't actually
  reference the target.

The graph should reflect **actual coupling**, not aspirational topology.

### Examples

```yaml
# a hypothetical <domain>-router/SKILL.md — owns the per-surface leaf audits
connects_to:
  - parent:<domain>-frontend-audit
  - parent:<domain>-backend-audit
  - parent:<domain>-cloud-audit
```

```yaml
# a hypothetical <domain>-router/SKILL.md — owns its leaf family, hands off to a shared primitive
connects_to:
  - parent:foo-effectiveness
  - parent:foo-implementation-audit
  - parent:foo-scaffold
  - handoff:repo-map            # repo-map's canonical parent is elsewhere
```

```yaml
# a hypothetical investigation workflow/SKILL.md — downstream, hands off into orchestrators + leaves
connects_to:
  - handoff:security
  - handoff:bug-scan
  - handoff:repo-map
  - handoff:ticket-manager
```

```yaml
# ticket-manager/SKILL.md  (self-contained)
connects_to: []
```

## `kind`

A coarse classification used for graph styling.

```yaml
kind: orchestrator
```

Values:

| Value | Meaning | Examples |
|---|---|---|
| `orchestrator` | Routes/synthesizes intent over a cluster of subskills | hypothetical `backend-router`, `<domain>-review` |
| `audit` | Read-only inspection; produces a report | `security`, `bug-scan`, `adr-researcher` |
| `action` | Mutates state (FS / API / data) | a hypothetical `migration-runner`, `acme-deploy` |
| `generator` | Produces an artifact (graph, scaffold, doc) | `repo-map`, `skill-generator` |
| `utility` | Self-contained tool, not a router or audit | `ticket-manager`, `skill-builder` |
| `specialized` | Doesn't fit the buckets above | hypothetical `<layer>-data-model`, `cache-coordinator`, `route-stack-architect` |
| `workflow` | Procedural multi-step skill with its own logic — not a router/synthesizer, not a leaf audit. Owns a sequence (diagnostic walk, lifecycle controller). | `adr-manager`, `adr-researcher` |

If absent, the dashboard infers `orchestrator` for nodes with
out-degree ≥ 2 and in-degree 0; everything else falls back to `leaf`.

**Omit `kind:` if the bucket is genuinely ambiguous.** Forcing a value
distorts the visualization.

## Why we invented these

- Anthropic does not define a formal "skill-calls-skill" interface.
  Composition today is informal — one skill mentions another in prose.
- Regex-mining the prose is brittle; an explicit frontmatter field is
  cleaner.
- The `.skua` dashboard can render the topology, making orphans /
  duplicated routing / orchestrator overlap visible at a glance.

## How the graph builder uses these

- **Each SKILL.md → one node**. `id = slug`.
- **Each entry in `connects_to` → one directed edge**. `source = skill slug, target = listed slug`. The edge's `edgeKind` field carries `parent` or `handoff` (default `handoff` for legacy bare slugs).
- **Broken edges** (target slug doesn't exist) become `meta.warnings` entries but don't break the build.
- **Multi-parent edges** (a target marked `parent:` by two or more sources) emit a `multi-parent` warning. The portfolio convention is one canonical parent per target.
- **Orphan detection**: a skill with zero incoming AND zero outgoing edges is flagged as an orphan in `meta.counts`.
- **Per-kind counts** (`parentEdges`, `handoffEdges`) are exposed in `meta.counts` so the dashboard's info line can show the breakdown.

The dashboard's `/graphs/skills` view supports an **edge-mode filter** that hides handoff edges to reveal the parent-only "tree view" — useful when the full DAG looks like a hairball.

See `.skua/lib/graphs/skills.ts` (the parent/handoff taxonomy) for the implementation.
