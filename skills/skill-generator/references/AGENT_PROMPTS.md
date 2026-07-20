# Agent Prompts

The 5 prompt skeletons the v0.2 DAG uses to spawn subagents. Each is a fill-in template — the parent skill substitutes the bracketed placeholders at spawn time.

Every skeleton enforces:
- **Read-only operations only** — no Bash writes, no file edits, no destructive commands. Deny-list listed inline.
- **Evidence-required output** — every claim must cite a file:line, command-output excerpt, or grep result. Bare verdicts are auto-rejected.
- **Structured JSON output** — the parent parses; no prose around the JSON.

Spawn each via the `Agent` tool. Pass the substituted prompt as the `prompt` parameter. Block writes via prompt-level deny-lists (the actual tool-level disallowedTools enforcement is configured by the harness or by the parent at spawn time where supported).

---

## 1. `introspect` (DAG node 1, subagent_type: `Explore`)

**Purpose:** walk the target codebase and produce a structured signal report.

**Inputs the parent substitutes:**
- `{{TARGET_REPO_ROOT}}` — absolute path to the repo root.
- `{{SIGNATURE_CATALOG}}` — the full contents of `references/INTROSPECTION_SIGNATURES.md` inlined.
- `{{THOROUGHNESS}}` — `quick` | `medium` | `very thorough`. Default `medium`.

### Prompt skeleton

```
You are the `introspect-codebase` subagent for the `skill-generator`
skill (v0.2 DAG node 1). Walk the target repo at
`{{TARGET_REPO_ROOT}}` and produce a structured signal report.

**Thoroughness: {{THOROUGHNESS}}.**

**Signature catalog** — apply these patterns; return only signals
with `file:line` evidence cites. No evidence → no entry.

{{SIGNATURE_CATALOG}}

**Output schema** (return ONLY this JSON, no prose):

{
  "deploy_units":  [{"name", "path", "framework", "evidence"}],
  "data_layers":   [{"name", "read": bool, "write": bool, "evidence": [...]}],
  "cross_cutting": [{"name", "evidence": [...]}],
  "deploy_targets": [{"name", "evidence": [...]}],
  "notes": "free-form introspection notes / ambiguous signals / gaps"
}

**Rules:**
- Every entry MUST have at least one `file:line` evidence cite.
- Do NOT invent signals — empty buckets are correct when no evidence found.
- Skip `.git/`, `node_modules/`, `.next/`, `__pycache__/`, `.venv/`, `dist/`, `build/`.
- Read-only: use Glob, Grep, Read. NO Bash writes, NO Edit, NO Write.
```

### Output gate

- Empty report (no deploy units AND no data layers AND no cross-cutting) → parent surfaces "repo too sparse for portfolio" and stops the DAG.

---

## 2. `verify-cites` (DAG node 2, subagent_type: `general-purpose`)

**Purpose:** grep-validate every `file:line` in the signal report. Hard gate before synthesis runs.

**Inputs the parent substitutes:**
- `{{SIGNAL_REPORT_JSON}}` — the JSON from DAG node 1.
- `{{TARGET_REPO_ROOT}}` — absolute path.

### Prompt skeleton

```
You are the `verify-cites` subagent for the `skill-generator` skill
(v0.2 DAG node 2). Validate every `file:line` cite in the signal
report by reading the file and confirming the cited line matches the
signal claim.

**Signal report:**
{{SIGNAL_REPORT_JSON}}

**Target repo root:** {{TARGET_REPO_ROOT}}

**For each evidence cite in deploy_units / data_layers /
cross_cutting / deploy_targets:**
1. Open the cited file via Read.
2. Confirm the cited line exists and contains content consistent
   with the signal claim. For example, if the signal claims a
   "<datastore> data layer" with cite `<file>:<line>`, the cited
   line should reference that datastore's client / import /
   handle (an ORM model, a SQL client, a driver import, or a
   collection handle).
3. If the line exists but content doesn't match, flag as drift.
4. If the file doesn't exist or has fewer lines than the cite, flag
   as missing.

**Output schema** (return ONLY this JSON):

{
  "pass": true|false,
  "verified_count": N,
  "failed_cites": [
    {"cite": "file:line", "signal": "...", "reason": "drift|missing|out_of_range"}
  ],
  "notes": "any patterns observed (e.g. all N signals of the same type share the same drift)"
}

**Rules:**
- `pass: true` IFF zero failed_cites.
- ANY drift OR missing flag → `pass: false`.
- Read-only: Read + Grep + Glob only.
- Bare "looks good" is auto-rejected; output schema is strict.
```

### Output gate (HARD)

- `pass: false` → parent writes the failure to `cache/plans/_stuck/<target>-<DATE>-cite-verification.md` and aborts the DAG. No synthesis runs.

---

## 3. `synthesize` (DAG node 3, subagent_type: `general-purpose`)

**Purpose:** map verified signals to skill-family candidates + harness extras. THE WORK that previously ran in the parent context.

**Inputs the parent substitutes:**
- `{{SIGNAL_REPORT_JSON}}` — the verified report.
- `{{PORTFOLIO_HEURISTICS_FULL_TEXT}}` — the complete contents of `references/PORTFOLIO_HEURISTICS.md` inlined. This is the load-bearing bit: the heuristic mapping table travels INSIDE the agent's context, not the parent's.
- `{{EXISTING_SKILL_LIST}}` — output of `ls .claude/skills/` (one slug per line).
- `{{EXISTING_BACKLOG_TICKETS}}` — for the overlap-vs-existing-ticket check, output of `ls .tickets/0-backlog/ .tickets/1-staging/ .tickets/3-building/` (filenames only).

### Prompt skeleton

```
You are the `synthesize-plan` subagent for the `skill-generator`
skill (v0.2 DAG node 3). Given a verified signal report and the
portfolio heuristics, produce a structured draft plan: which skill
families to propose, which existing skills cover the same ground,
which harness extras are justified.

**Verified signal report:**
{{SIGNAL_REPORT_JSON}}

**Portfolio heuristics** (apply these rules — do not improvise):
{{PORTFOLIO_HEURISTICS_FULL_TEXT}}

**Existing portfolio** (do NOT propose any slug from this list):
{{EXISTING_SKILL_LIST}}

**Existing backlog tickets** (note overlap; do NOT propose duplicates):
{{EXISTING_BACKLOG_TICKETS}}

**Output schema** (return ONLY this JSON):

{
  "clusters": [
    {
      "name": "...",
      "orchestrator": {"slug": "...", "kind": "orchestrator", "exists": bool}
        OR null if cluster doesn't need an orchestrator,
      "members": [{"slug": "...", "exists": bool, "kind": "audit|action|utility|..."}],
      "rationale": "what signals justify this cluster",
      "connects_to_edges": [["a", "b", "reason"]]
    }
  ],
  "proposed_new": [
    {
      "slug": "...",
      "kind": "...",
      "cluster": "...",
      "justifying_signals": ["file:line", ...],
      "matches_existing_ticket": "TKT-NNN" | null
    }
  ],
  "skipped_existing": [
    {"candidate": "...", "existing_skill": "...", "coverage": "full|partial"}
  ],
  "harness": {
    "extras_proposed": [{"component": "...", "justification": "...", "evidence_signal": "..."}],
    "extras_already_present": ["CLAUDE.md", "..."]
  },
  "notes": "introspection caveats, ambiguous mappings, evidence drift the heuristics couldn't resolve"
}

**Rules:**
- Every proposed_new entry MUST have at least one entry in `justifying_signals` traceable to the signal report.
- An orchestrator (`kind: orchestrator`) requires ≥3 members.
- Do NOT propose any slug already in `existing_skill_list`.
- Do NOT propose any skill whose title overlaps an existing backlog ticket — set `matches_existing_ticket` instead.
- Read-only: NO Bash writes, NO Edit, NO Write.
```

### Output gate

- None at this node — proceeds directly to the validator (DAG node 4) which judges fitness.

---

## 4. `validate-plan` (DAG node 4, subagent_type: `general-purpose`)

**Purpose:** cold-reader judge on the synthesized plan. 4 orthogonal axes. Distinct from `verify-cites` (which only checks signal-report file:lines).

**Inputs the parent substitutes:**
- `{{DRAFT_PLAN_JSON}}` — the JSON from DAG node 3.
- `{{SIGNAL_REPORT_JSON}}` — the verified report.
- `{{EXISTING_SKILL_LIST}}` — repeated for the overlap-correctness axis.

### Prompt skeleton

```
You are the `validate-plan` subagent for the `skill-generator`
skill (v0.2 DAG node 4). Grade the draft plan on 4 orthogonal axes
as a senior cold-reader. Evidence-required output.

**Draft plan:**
{{DRAFT_PLAN_JSON}}

**Signal report (for back-reference):**
{{SIGNAL_REPORT_JSON}}

**Existing skill list (for overlap correctness spot-check):**
{{EXISTING_SKILL_LIST}}

**Axes:**

1. **signal_fidelity** — does every proposed_new skill trace back
   to at least one signal-report entry with file:line evidence?
   Spot-check 2-3 by actually reading the cited file:line.

2. **overlap_correctness** — does every proposed_new slug actually
   NOT exist in the current portfolio? Spot-check by running
   `ls .claude/skills/` and confirming. Also spot-check the
   skipped_existing table: pick 3 random entries and confirm the
   claimed existing skill DOES exist.

3. **cluster_sanity** — is every orchestrator cluster's member
   count ≥3 (the orchestrator-justification threshold)? Are
   `connects_to_edges` coherent (no dangling references)?

4. **harness_justification** — is every harness extra justified by
   at least one signal entry? No speculative additions.

**Output schema** (return ONLY this JSON):

{
  "pass": true|false,
  "axes": {
    "signal_fidelity":      {"pass": bool, "evidence": "..."},
    "overlap_correctness":  {"pass": bool, "evidence": "..."},
    "cluster_sanity":       {"pass": bool, "evidence": "..."},
    "harness_justification": {"pass": bool, "evidence": "..."}
  },
  "flagged_items": [{"item": "...", "reason": "..."}],
  "notes": "any cold-reader concerns the axes don't capture"
}

**Rules:**
- Overall `pass: true` IFF all 4 axes pass.
- Each axis's evidence MUST cite a file:line, command output, or
  specific draft-plan element. Vague evidence ("looks good") is
  auto-rejected.
- Read-only: Read + Grep + Glob + read-only Bash (ls, wc) only.
```

### Output gate

- `pass: false` → parent writes draft + validator report to `cache/plans/_stuck/<target>-<DATE>.md` and surfaces failure. No drafter fan-out runs.
- `pass: true` → proceeds to drafter fan-out (DAG node 5).

---

## 5. `draft-child-ticket` (DAG node 5 × N, subagent_type: `general-purpose`, **parallel fan-out**)

**Purpose:** draft a complete ticket body for one proposed skill. N instances run in parallel — one per proposed_new entry.

**Inputs the parent substitutes per drafter:**
- `{{SKILL_SPEC_JSON}}` — the single `proposed_new` entry from DAG node 3 (slug, kind, cluster, justifying_signals, etc.).
- `{{CLUSTER_RATIONALE}}` — the cluster's rationale string (lifted from the draft plan).
- `{{PER_SKILL_AC_TEMPLATE}}` — the AC boilerplate from `PORTFOLIO_HEURISTICS.md § Per-skill AC template`.
- `{{PARENT_TICKET_ID}}` — typically the ticket the user was working under when they ran the bootstrap (e.g. `TKT-NNN`).

### Prompt skeleton

```
You are a `draft-child-ticket` subagent for the `skill-generator`
skill (v0.2 DAG node 5, one of N parallel drafters). Draft a
complete ticket body for the proposed skill below. Your output
becomes a ticket-manager.create-ticket payload.

**Skill spec:**
{{SKILL_SPEC_JSON}}

**Cluster rationale:**
{{CLUSTER_RATIONALE}}

**Per-skill AC template** (use as scaffolding; customize bullets
where the skill's specifics warrant):
{{PER_SKILL_AC_TEMPLATE}}

**Parent ticket:** {{PARENT_TICKET_ID}}

**Output schema** (return ONLY this JSON):

{
  "slug": "...",
  "title": "<sentence-case noun phrase, no trailing period>",
  "domain": "app|infra|docs|meta",
  "secondary_domains": ["..."],
  "tags": ["..."],
  "complexity": 1|2|3|4|5,
  "depends_on": ["TKT-NNN", ...],
  "related": ["{{PARENT_TICKET_ID}}", ...],
  "objective": "1-3 sentences, what + why",
  "context": "bulleted markdown with file:line citations from justifying_signals",
  "acceptance_criteria": "numbered markdown list, 2-6 testable bullets",
  "out_of_scope": "optional bulleted markdown"
}

**Rules:**
- `objective` MUST reference the signal evidence — anchor scope to
  what was actually detected, not aspirational scope.
- `context` MUST embed at least 2 of the `justifying_signals`
  cites as bulleted file:line references.
- `acceptance_criteria` MUST be independently verifiable
  (commands, file paths, grep matches — not aspirations).
- `complexity` per the 1-5 rubric in ticket-manager.
- Read-only: NO file writes; the parent will hand this JSON to
  ticket-manager.create-ticket.
```

### Output gate

- Per-drafter failure (e.g. schema violation, missing evidence) → that single drafter's output is rejected; the parent notes the skip but continues with the rest. Plan's child-ticket list reflects the skip.

---

## How the parent uses these

The parent (`generate-bootstrap-plan` op) executes the DAG in this exact shape:

```python
# Pseudocode — actual implementation is the parent skill's procedure
signal_report = spawn_agent("Explore", introspect_prompt)
if signal_report.empty: stop()

verify_result = spawn_agent("general-purpose", verify_cites_prompt)
if not verify_result.pass: write_stuck(); stop()

draft_plan = spawn_agent("general-purpose", synthesize_prompt)

validator_result = spawn_agent("general-purpose", validate_plan_prompt)
if not validator_result.pass: write_stuck(); stop()

# Parallel fan-out — N concurrent Agent calls in a single message:
drafts = spawn_agents_parallel([
    ("general-purpose", draft_prompt_for(skill))
    for skill in draft_plan.proposed_new
])

final_plan = render_template(BOOTSTRAP_PLAN_TEMPLATE, {
    signal_report, draft_plan, validator_result, drafts
})
write(plan_path, final_plan)
```

Note the parent's main-context work after each step is reduced to: parse JSON, decide whether to gate, hand the result to the next spawn. **No heuristic mapping, no synthesis, no per-ticket drafting in the parent.** That property is the v0.2 architecture's load-bearing claim.

---

## Deny-list (applies to every agent)

Every spawned subagent runs read-only. The following are explicitly forbidden in every prompt and (where the harness supports it) by tool-level `disallowedTools` configuration:

```
Bash(rm:*), Bash(rm -rf:*)
Block mutating cloud-CLI verbs (e.g. gcloud / aws / az / kubectl); allow only read-only subcommands (auth / config / list / describe)
Bash(<expensive-cli> query:*)  — non-dry-run query against a metered backend
Bash(git push:*), Bash(git rm:*), Bash(git reset --hard:*), Bash(git commit:*)
Bash(bun update:*)
Bash(npm install:*), Bash(npm publish:*)
Bash(curl:*)                — to non-localhost addresses
Edit, Write, NotebookEdit
Any MCP write surface
```

Allowed: Read, Glob, Grep, read-only Bash (`ls`, `wc`, `head`, `tail`, `cat`, `git diff --name-only`, `git status --short`), and (for the Explore agent) anything the Explore agent type already provides except `Edit` / `Write` / `NotebookEdit`.
