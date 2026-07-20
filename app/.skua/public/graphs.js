// Cytoscape graph viewer for tickets / dataflow / schemas / ai / adrs.

import { escapeHtml as escHtml } from "/components/html-utils.js";

if (window.cytoscape && window.cytoscapeDagre) cytoscape.use(cytoscapeDagre);

const $ = (s) => document.querySelector(s);
let cy = null;

function currentKind() {
  const m = location.pathname.match(/^\/graphs\/(tickets|dataflow|schemas|ai)/);
  return m ? m[1] : "dataflow";
}

// Cytoscape doesn't read CSS custom properties, so we maintain a JS
// palette per theme and pick at render time. Keep light values in sync
// with styles.css :root; dark values in sync with :root[data-theme="dark"].
const C_LIGHT = {
  ink: "#15130f",
  muted: "#5d574d",
  paper: "#faf8f3",
  border: "#e0dcd2",
  blue: "#1e66f5",
  green: "#40a02b",
  peach: "#fe640b",
  mauve: "#8839ef",
  teal: "#179299",
  red: "#fa7373",
  yellow: "#df8e1d",
  // Bucket fills + borders.
  bucketScratchFill: "#ede7d6", bucketScratchBorder: "#b8b1a0",
  bucketBacklogFill: "#36322a", bucketBacklogBorder: "#2f2b24",
  bucketStagingFill: "#e07474", bucketStagingBorder: "#b85555",
  bucketStuckFill: "#8a6a8a",   bucketStuckBorder: "#6b4f6b",
  bucketBuildingFill: "#ee9a44", bucketBuildingBorder: "#c47a25",
  bucketTestingFill: "#eaae3e",  bucketTestingBorder: "#b3892b",
  bucketValidatingFill: "#e6c238", bucketValidatingBorder: "#a99023",
  bucketCompleteFill: "#6fb058",   bucketCompleteBorder: "#4a8038",
  bucketArchiveFill: "#4a6e40",    bucketArchiveBorder: "#4a6e40",
  // Node-kind pastel fills (re-used from --swatch-* tokens for parity).
  apiFill: "#e6d6fb", analyticsFill: "#dde6fb",
  bqFill: "#fde0cf",  sqlFill: "#fdf0c8",
  specializedFill: "#dceedb",
  actionFill: "#fbdada", utilityFill: "#d4ebec",
  // Schemas graph — one hue per database (soft fills so an expanded table
  // compound reads as a single tinted region). Mirror dark variants below.
  dbFirestoreFill: "#dceedb", dbFirestoreBorder: "#40a02b",
  dbSqlFill:       "#fdf0c8", dbSqlBorder:       "#df8e1d",
  dbBigqueryFill:  "#fde0cf", dbBigqueryBorder:  "#fe640b",
  schemaTableFill: "#f4efe2",
  schemaColumnFill: "#faf8f3", schemaColumnBorder: "#9a9285",
  // ADR status palette — mirrors --adr-* CSS tokens (TKT-208 + TKT-216).
  // Categorical; do NOT reuse --bucket-* / bucket*Fill.
  adrProposed:   "#d4a64a", adrProposedFill:   "#f8e8c0",
  adrAccepted:   "#4caf6f", adrAcceptedFill:   "#d6f0df",
  adrRejected:   "#c9534a", adrRejectedFill:   "#f4d0cd",
  adrSuperseded: "#8a8a8a", adrSupersededFill: "#dcdcdc",
  adrDeprecated: "#8a8a8a", adrDeprecatedFill: "#dcdcdc",
  draftBorder:   "#9aa0a6", draftFill:         "#f1f3f4",
  matFill:       "#dde6fb",
  // AI ecosystem palette (ADR-004) — one color per primitive cluster.
  // Light variants; dark mirrors below. Borders are saturated; fills are
  // soft pastels so compound clusters read as a single hue.
  aiSkillFill:       "#e6d6fb", aiSkillBorder:       "#8839ef",
  aiAgentFill:       "#dde6fb", aiAgentBorder:       "#1e66f5",
  aiCommandFill:     "#d4ebec", aiCommandBorder:     "#179299",
  aiHookFill:        "#fbdada", aiHookBorder:        "#fa7373",
  aiMcpFill:         "#fde0cf", aiMcpBorder:         "#fe640b",
  aiStyleFill:       "#fdf0c8", aiStyleBorder:       "#df8e1d",
  aiPluginFill:      "#dceedb", aiPluginBorder:      "#40a02b",
  aiSettingsFill:    "#ede7d6", aiSettingsBorder:    "#5d574d",
  aiMiscFill:        "#e8e2d4", aiMiscBorder:        "#7a7268",
  aiToolFill:        "#faf8f3", aiToolBorder:        "#15130f",
  aiClusterFill:     "#f4efe2", aiClusterBorder:     "#c8c0ad",
};
const C_DARK = {
  ink: "#ece7da",
  muted: "#9a9285",
  paper: "#211e1a",
  border: "#3a3530",
  blue: "#74c7ec",
  green: "#a6e3a1",
  peach: "#fab387",
  mauve: "#cba6f7",
  teal: "#94e2d5",
  red: "#f38ba8",
  yellow: "#f9e2af",
  bucketScratchFill: "#5a5240",  bucketScratchBorder: "#8a8170",
  bucketBacklogFill: "#6b6557",  bucketBacklogBorder: "#968f80",
  bucketStagingFill: "#c95d5d",  bucketStagingBorder: "#e07474",
  bucketStuckFill: "#8a6a8a",    bucketStuckBorder: "#b094b0",
  bucketBuildingFill: "#d18636", bucketBuildingBorder: "#e0a05a",
  bucketTestingFill: "#d1992c",  bucketTestingBorder: "#e0b748",
  bucketValidatingFill: "#d1ad2c", bucketValidatingBorder: "#e0c948",
  bucketCompleteFill: "#5da046", bucketCompleteBorder: "#7fc66a",
  bucketArchiveFill: "#3f5e36",  bucketArchiveBorder: "#5b8a52",
  apiFill: "#3b2d56", analyticsFill: "#2a3a5c",
  bqFill: "#4a2e1a",  sqlFill: "#4a3a1a",
  specializedFill: "#2a4226",
  actionFill: "#4a2828", utilityFill: "#1f3a3c",
  dbFirestoreFill: "#2a4226", dbFirestoreBorder: "#a6e3a1",
  dbSqlFill:       "#4a3a1a", dbSqlBorder:       "#f9e2af",
  dbBigqueryFill:  "#4a2e1a", dbBigqueryBorder:  "#fab387",
  schemaTableFill: "#28251f",
  schemaColumnFill: "#211e1a", schemaColumnBorder: "#9a9285",
  // ADR status palette — dark variants.
  adrProposed:   "#d4a64a", adrProposedFill:   "#4a3a1a",
  adrAccepted:   "#4caf6f", adrAcceptedFill:   "#1d3a25",
  adrRejected:   "#c9534a", adrRejectedFill:   "#3f1f1c",
  adrSuperseded: "#8a8a8a", adrSupersededFill: "#33312d",
  adrDeprecated: "#8a8a8a", adrDeprecatedFill: "#33312d",
  draftBorder:   "#7a7a7a", draftFill:         "#2c2926",
  matFill:       "#2a3a5c",
  // AI ecosystem palette — dark variants (ADR-004).
  aiSkillFill:       "#3b2d56", aiSkillBorder:       "#cba6f7",
  aiAgentFill:       "#2a3a5c", aiAgentBorder:       "#74c7ec",
  aiCommandFill:     "#1f3a3c", aiCommandBorder:     "#94e2d5",
  aiHookFill:        "#4a2828", aiHookBorder:        "#f38ba8",
  aiMcpFill:         "#4a2e1a", aiMcpBorder:         "#fab387",
  aiStyleFill:       "#4a3a1a", aiStyleBorder:       "#f9e2af",
  aiPluginFill:      "#2a4226", aiPluginBorder:      "#a6e3a1",
  aiSettingsFill:    "#33312d", aiSettingsBorder:    "#9a9285",
  aiMiscFill:        "#2e2b27", aiMiscBorder:        "#8a8170",
  aiToolFill:        "#211e1a", aiToolBorder:        "#ece7da",
  aiClusterFill:     "#28251f", aiClusterBorder:     "#4a443c",
};
function activePalette() {
  const attr = document.documentElement.dataset.theme;
  if (attr === "dark") return C_DARK;
  if (attr === "light") return C_LIGHT;
  // No explicit choice — follow OS.
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? C_DARK
    : C_LIGHT;
}

function makeStyle() {
  const C = activePalette();
  return [
  {
    selector: "node",
    style: {
      label: "data(label)",
      color: C.ink,
      "font-family": "JetBrains Mono, ui-monospace, monospace",
      "font-size": 9,
      "background-color": C.paper,
      "border-width": 1.2,
      "border-color": C.muted,
      width: 22,
      height: 22,
      "text-wrap": "wrap",
      "text-max-width": 160,
      "text-valign": "bottom",
      "text-margin-y": 4,
    },
  },

  // ── Tickets view ──────────────────────────────────────────────────────
  // Pastel lifecycle palette — must match .skua/public/styles.css
  // --bucket-* custom properties (see TKT-151). Fills are the soft
  // pastels; borders are a slightly darker shade so the node reads as
  // one color rather than the old saturated accent ring.
  {
    selector: 'node[bucket="scratch"]',
    style: { "background-color": C.bucketScratchFill, "border-color": C.bucketScratchBorder },
  },
  {
    selector: 'node[bucket="0-backlog"]',
    style: { "background-color": C.bucketBacklogFill, "border-color": C.bucketBacklogBorder },
  },
  {
    selector: 'node[bucket="1-staging"]',
    style: { "background-color": C.bucketStagingFill, "border-color": C.bucketStagingBorder },
  },
  {
    selector: 'node[bucket="2-stuck"]',
    style: { "background-color": C.bucketStuckFill, "border-color": C.bucketStuckBorder },
  },
  {
    selector: 'node[bucket="3-building"]',
    style: { "background-color": C.bucketBuildingFill, "border-color": C.bucketBuildingBorder },
  },
  {
    selector: 'node[bucket="4-testing"]',
    style: { "background-color": C.bucketTestingFill, "border-color": C.bucketTestingBorder },
  },
  {
    selector: 'node[bucket="5-validating"]',
    style: { "background-color": C.bucketValidatingFill, "border-color": C.bucketValidatingBorder },
  },
  {
    selector: 'node[bucket="6-complete"]',
    style: { "background-color": C.bucketCompleteFill, "border-color": C.bucketCompleteBorder },
  },
  {
    selector: 'node[bucket="7-archive"]',
    style: { "background-color": C.bucketArchiveFill, "border-color": C.bucketArchiveBorder },
  },
  {
    selector: 'node[priority="High"]',
    style: { width: 30, height: 30, "border-width": 1.8 },
  },

  // ── Edges ─────────────────────────────────────────────────────────────
  {
    selector: "edge",
    style: {
      width: 1,
      "line-color": C.muted,
      "target-arrow-color": C.muted,
      opacity: 0.55,
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      "arrow-scale": 0.8,
    },
  },
  // Tickets edges.
  {
    selector: 'edge[kind="depends_on"]',
    style: {
      "line-color": C.blue,
      "target-arrow-color": C.blue,
      opacity: 0.85,
    },
  },
  {
    selector: 'edge[kind="blocks"]',
    style: { "line-color": C.red, "target-arrow-color": C.red, opacity: 0.85 },
  },
  { selector: 'edge[kind="related"]', style: { "line-style": "dashed" } },

  // ── Skills view ───────────────────────────────────────────────────────
  {
    selector: 'node[kind="orchestrator"]',
    style: {
      width: 36,
      height: 36,
      "border-width": 1.8,
      "border-color": C.mauve,
      "background-color": C.apiFill,
      "font-size": 10,
      "font-weight": 500,
    },
  },
  {
    selector: 'node[kind="audit"]',
    style: { "border-color": C.peach, "background-color": C.bqFill },
  },
  {
    selector: 'node[kind="action"]',
    style: { "border-color": C.red, "background-color": C.actionFill },
  },
  {
    selector: 'node[kind="generator"]',
    style: { "border-color": C.blue, "background-color": C.analyticsFill },
  },
  {
    selector: 'node[kind="utility"]',
    style: { "border-color": C.teal, "background-color": C.utilityFill },
  },
  {
    selector: 'node[kind="specialized"]',
    style: { "border-color": C.green, "background-color": C.specializedFill },
  },
  {
    selector: 'node[kind="workflow"]',
    style: { "border-color": C.peach, "background-color": C.actionFill },
  },
  {
    selector: 'node[kind="leaf"]',
    style: { "border-color": C.muted, "background-color": C.paper },
  },
  {
    selector: "node[?orphan]",
    style: { "border-style": "dashed", "border-color": C.muted, opacity: 0.7 },
  },
  // Skills edges — three flavors per the parent/handoff/cite taxonomy. The
  // schema embeds the flavor in `edgeKind` (set by .skua/lib/graphs/skills.ts);
  // legacy edges with no edgeKind fall through to the muted default below.
  {
    selector: 'edge[kind="connects_to"][edgeKind="parent"]',
    style: {
      "line-color": C.mauve,
      "target-arrow-color": C.mauve,
      "line-style": "solid",
      opacity: 0.95,
      width: 2.2,
    },
  },
  {
    selector: 'edge[kind="connects_to"][edgeKind="handoff"]',
    style: {
      "line-color": C.muted,
      "target-arrow-color": C.muted,
      "line-style": "dashed",
      opacity: 0.55,
      width: 1.2,
    },
  },
  // Legacy fallback (any connects_to edge without an edgeKind attribute).
  {
    selector: 'edge[kind="connects_to"][!edgeKind]',
    style: {
      "line-color": C.mauve,
      "target-arrow-color": C.mauve,
      opacity: 0.75,
      width: 1.2,
    },
  },

  // ── ADR view ─────────────────────────────────────────────────────────
  // Node kinds: adr (status-colored), draft-ticket (dashed border —
  // proposed, not yet minted), materialized-ticket (filled like a real
  // ticket, cross-links into /graphs/tickets).
  {
    selector: 'node[kind="adr"]',
    style: {
      width: 44,
      height: 44,
      "border-width": 2.2,
      "border-color": C.muted,
      "background-color": C.paper,
      "font-size": 11,
      "font-weight": 600,
      shape: "round-rectangle",
    },
  },
  {
    selector: 'node[kind="adr"][status="proposed"]',
    style: { "border-color": C.adrProposed, "background-color": C.adrProposedFill },
  },
  {
    selector: 'node[kind="adr"][status="accepted"]',
    style: { "border-color": C.adrAccepted, "background-color": C.adrAcceptedFill },
  },
  {
    selector: 'node[kind="adr"][status="rejected"]',
    style: { "border-color": C.adrRejected, "background-color": C.adrRejectedFill },
  },
  {
    selector: 'node[kind="adr"][status="superseded"]',
    style: { "border-color": C.adrSuperseded, "background-color": C.adrSupersededFill, opacity: 0.7 },
  },
  {
    selector: 'node[kind="adr"][status="deprecated"]',
    style: { "border-color": C.adrDeprecated, "background-color": C.adrDeprecatedFill, opacity: 0.6, "border-style": "dashed" },
  },
  {
    selector: 'node[kind="draft-ticket"]',
    style: {
      width: 30,
      height: 30,
      "border-width": 1.6,
      "border-style": "dashed",
      "border-color": C.draftBorder,
      "background-color": C.draftFill,
      "font-size": 9,
      opacity: 0.85,
      shape: "round-rectangle",
    },
  },
  {
    selector: 'node[kind="materialized-ticket"]',
    style: {
      width: 32,
      height: 32,
      "border-width": 1.4,
      "border-color": C.blue,
      "background-color": C.matFill,
      "font-size": 9,
      shape: "round-rectangle",
    },
  },
  // ADR edge kinds. Five total; visually distinct per ADR-001 D4.
  {
    selector: 'edge[kind="proposes"]',
    style: {
      "line-color": C.muted,
      "target-arrow-color": C.muted,
      "line-style": "dashed",
      opacity: 0.6,
      width: 1.2,
    },
  },
  {
    selector: 'edge[kind="implements_adr"]',
    style: {
      "line-color": C.adrAccepted,
      "target-arrow-color": C.adrAccepted,
      opacity: 0.75,
      width: 1.4,
    },
  },
  {
    selector: 'edge[kind="materialized_from"]',
    style: {
      "line-color": C.blue,
      "target-arrow-color": C.blue,
      "line-style": "dotted",
      opacity: 0.5,
      width: 1.1,
    },
  },
  {
    selector: 'edge[kind="supersedes"]',
    style: {
      "line-color": C.adrRejected,
      "target-arrow-color": C.adrRejected,
      opacity: 0.85,
      width: 2,
    },
  },
  // depends_on edge style already declared in the tickets block above;
  // reuses cleanly for DRAFT → DRAFT / DRAFT → TKT in the ADR graph.

  // ── AI ecosystem view (ADR-004) ──────────────────────────────────────
  // Flat node set — no compound parent grouping. Color + shape per
  // `kind` carry the cluster semantics.
  { selector: 'node[kind="skill"]',                style: { "background-color": C.aiSkillFill,    "border-color": C.aiSkillBorder,    "border-width": 1.2 } },
  { selector: 'node[kind="agent"]',                style: { "background-color": C.aiAgentFill,    "border-color": C.aiAgentBorder,    "border-width": 1.2 } },
  { selector: 'node[kind="agent-builtin"]',        style: { "background-color": C.aiAgentFill,    "border-color": C.aiAgentBorder,    "border-width": 1.2, "border-style": "dashed", opacity: 0.85 } },
  { selector: 'node[kind="slash-command"]',        style: { "background-color": C.aiCommandFill,  "border-color": C.aiCommandBorder,  "border-width": 1.2 } },
  { selector: 'node[kind="hook"]',                 style: { "background-color": C.aiHookFill,     "border-color": C.aiHookBorder,     "border-width": 1.2, shape: "diamond", width: 18, height: 18 } },
  { selector: 'node[kind="hook-event"]',           style: { "background-color": C.aiHookFill,     "border-color": C.aiHookBorder,     "border-width": 1, "border-style": "dotted", opacity: 0.75, shape: "round-tag" } },
  { selector: 'node[kind="mcp-server"]',           style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1.4, shape: "barrel" } },
  // Scope-precedence visual cues (ADR-004 / CCO-inspired). SHADOWED: dimmed
  // dashed border. CONFLICT: red ring + bumped border weight.
  { selector: 'node[precedence="SHADOWED"]',       style: { "border-style": "dashed", opacity: 0.55 } },
  { selector: 'node[precedence="CONFLICT"]',       style: { "border-color": C.red, "border-width": 2.4 } },
  { selector: 'node[kind="mcp-tool"]',             style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1, shape: "ellipse", width: 16, height: 16 } },
  { selector: 'node[kind="mcp-prompt"]',           style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1, shape: "triangle" } },
  { selector: 'node[kind="mcp-resource"]',         style: { "background-color": C.aiMcpFill,      "border-color": C.aiMcpBorder,      "border-width": 1, shape: "rhomboid" } },
  { selector: 'node[kind="output-style"]',         style: { "background-color": C.aiStyleFill,    "border-color": C.aiStyleBorder,    "border-width": 1.2 } },
  { selector: 'node[kind="output-style-builtin"]', style: { "background-color": C.aiStyleFill,    "border-color": C.aiStyleBorder,    "border-width": 1, "border-style": "dashed", opacity: 0.85 } },
  { selector: 'node[kind="plugin"]',               style: { "background-color": C.aiPluginFill,   "border-color": C.aiPluginBorder,   "border-width": 1.2 } },
  { selector: 'node[kind="marketplace"]',          style: { "background-color": C.aiPluginFill,   "border-color": C.aiPluginBorder,   "border-width": 1.6, shape: "round-rectangle", width: 30, height: 24 } },
  { selector: 'node[kind="settings-file"]',        style: { "background-color": C.aiSettingsFill, "border-color": C.aiSettingsBorder, "border-width": 1.2, shape: "round-rectangle" } },
  { selector: 'node[kind="claude-md"]',            style: { "background-color": C.aiSettingsFill, "border-color": C.aiSettingsBorder, "border-width": 1, shape: "round-rectangle", "border-style": "dashed" } },
  { selector: 'node[kind="status-line"]',          style: { "background-color": C.aiMiscFill,     "border-color": C.aiMiscBorder,     "border-width": 1.2, shape: "tag" } },
  { selector: 'node[kind="lsp-server"]',           style: { "background-color": C.aiMiscFill,     "border-color": C.aiMiscBorder,     "border-width": 1.2, shape: "round-rectangle" } },
  { selector: 'node[kind="tool-builtin"]',         style: { "background-color": C.aiToolFill,     "border-color": C.aiToolBorder,     "border-width": 1, shape: "round-rectangle", width: 24, height: 16 } },
  { selector: 'node[kind="tool-mcp"]',             style: { "background-color": C.aiToolFill,     "border-color": C.aiMcpBorder,      "border-width": 1, shape: "round-rectangle", width: 24, height: 16 } },

  // AI ecosystem edge kinds — nine total. Color follows the SOURCE cluster
  // intent (gates=hook=red, scopes=agent=blue, invokes=blue solid,
  // provides=mcp=peach, bundles=plugin=green, lists=plugin=green,
  // configures=settings=muted, references=muted, overrides=mauve).
  { selector: 'edge[kind="gates"]',      style: { "line-color": C.aiHookBorder,     "target-arrow-color": C.aiHookBorder,     opacity: 0.8,  width: 1.6, "line-style": "dashed" } },
  { selector: 'edge[kind="scopes"]',     style: { "line-color": C.aiAgentBorder,    "target-arrow-color": C.aiAgentBorder,    opacity: 0.7,  width: 1.3, "line-style": "dashed" } },
  { selector: 'edge[kind="invokes"]',    style: { "line-color": C.aiAgentBorder,    "target-arrow-color": C.aiAgentBorder,    opacity: 0.85, width: 1.6 } },
  { selector: 'edge[kind="provides"]',   style: { "line-color": C.aiMcpBorder,      "target-arrow-color": C.aiMcpBorder,      opacity: 0.75, width: 1.3 } },
  { selector: 'edge[kind="bundles"]',    style: { "line-color": C.aiPluginBorder,   "target-arrow-color": C.aiPluginBorder,   opacity: 0.8,  width: 1.4 } },
  { selector: 'edge[kind="lists"]',      style: { "line-color": C.aiPluginBorder,   "target-arrow-color": C.aiPluginBorder,   opacity: 0.55, width: 1.1, "line-style": "dotted" } },
  { selector: 'edge[kind="configures"]', style: { "line-color": C.aiSettingsBorder, "target-arrow-color": C.aiSettingsBorder, opacity: 0.6,  width: 1.1, "line-style": "dashed" } },
  { selector: 'edge[kind="references"]', style: { "line-color": C.muted,            "target-arrow-color": C.muted,            opacity: 0.45, width: 1,   "line-style": "dotted" } },
  { selector: 'edge[kind="overrides"]',  style: { "line-color": C.mauve,            "target-arrow-color": C.mauve,            opacity: 0.7,  width: 1.4, "line-style": "dashed" } },

  // ── Repo-map view ─────────────────────────────────────────────────────
  // Generic code-structure graph: directory + file nodes, contains/imports
  // edges. Flat (no compound parents) so the default dagre layout is happy.
  {
    selector: 'node[kind="dir"]',
    style: {
      shape: "round-rectangle",
      "background-color": C.aiClusterFill,
      "border-color": C.muted,
      "border-width": 1.4,
      width: "label",
      height: 20,
      padding: 6,
      "font-size": 10,
      "font-weight": 600,
      color: C.ink,
      "text-valign": "center",
      "text-halign": "center",
      "text-margin-y": 0,
    },
  },
  {
    selector: 'node[kind="file"]',
    style: { "background-color": C.paper, "border-color": C.muted, width: 18, height: 18 },
  },
  { selector: 'node[kind="file"][lang="ts"]', style: { "border-color": C.blue,   "background-color": C.analyticsFill } },
  { selector: 'node[kind="file"][lang="js"]', style: { "border-color": C.yellow, "background-color": C.sqlFill } },
  { selector: 'node[kind="file"][lang="py"]', style: { "border-color": C.green,  "background-color": C.specializedFill } },
  { selector: 'node[kind="file"][lang="go"]', style: { "border-color": C.teal,   "background-color": C.utilityFill } },
  { selector: 'node[kind="file"][lang="rs"]', style: { "border-color": C.peach,  "background-color": C.bqFill } },
  { selector: 'node[kind="file"][lang="rb"]', style: { "border-color": C.red,    "background-color": C.actionFill } },
  { selector: 'node[kind="file"][?entry]',    style: { shape: "star", width: 28, height: 28, "border-color": C.mauve, "border-width": 1.8 } },
  { selector: 'edge[kind="contains"]', style: { "line-color": C.border, "target-arrow-color": C.border, "line-style": "dotted", opacity: 0.35, width: 1, "target-arrow-shape": "none" } },
  { selector: 'edge[kind="imports"]',  style: { "line-color": C.blue,   "target-arrow-color": C.blue,   opacity: 0.6,  width: 1.1 } },

  // ── Dataflow view ─────────────────────────────────────────────────────
  // Architecture diagram: frontend route → container · endpoint → data store.
  {
    selector: 'node[kind="fe-route"]',
    style: {
      shape: "round-rectangle", "background-color": C.paper, "border-color": C.ink,
      "border-width": 1, width: "label", height: 18, padding: 6, "font-size": 10,
      color: C.ink, "text-valign": "center", "text-halign": "center", "text-margin-y": 0,
    },
  },
  { selector: 'node[kind="fe-route"][?cached]', style: { "border-color": C.blue, "border-width": 1.4 } },
  // Deploy container (the backend service the endpoints run in).
  {
    selector: 'node[kind="container"]',
    style: {
      shape: "round-rectangle", "background-color": C.aiClusterFill, "border-color": C.muted,
      "border-width": 1.8, width: "label", height: 26, padding: 10, "font-size": 11,
      "font-weight": 600, color: C.ink, "text-valign": "center", "text-halign": "center", "text-margin-y": 0,
    },
  },
  // Access endpoints — server actions (mauve) vs API routes (blue).
  {
    selector: 'node[kind="endpoint"]',
    style: {
      shape: "round-rectangle", "background-color": C.apiFill, "border-color": C.mauve,
      "border-width": 1, width: "label", height: 18, padding: 6, "font-size": 10,
      color: C.mauve, "text-valign": "center", "text-halign": "center", "text-margin-y": 0,
    },
  },
  { selector: 'node[kind="endpoint"][access="api-route"]', style: { "background-color": C.analyticsFill, "border-color": C.blue, color: C.blue } },
  // Data stores — barrel, coloured per database.
  {
    selector: 'node[kind="store"]',
    style: {
      shape: "barrel", "background-color": C.specializedFill, "border-color": C.green,
      "border-width": 1.4, width: "label", height: 22, padding: 8, "font-size": 11,
      color: C.green, "text-valign": "center", "text-halign": "center", "text-margin-y": 0,
    },
  },
  { selector: 'node[kind="store"][db="firestore"]', style: { "background-color": C.dbFirestoreFill, "border-color": C.dbFirestoreBorder, color: C.dbFirestoreBorder } },
  { selector: 'node[kind="store"][db="sql"]',       style: { "background-color": C.dbSqlFill,       "border-color": C.dbSqlBorder,       color: C.dbSqlBorder } },
  { selector: 'node[kind="store"][db="bigquery"]',  style: { "background-color": C.dbBigqueryFill,  "border-color": C.dbBigqueryBorder,  color: C.dbBigqueryBorder } },
  // Dataflow edges.
  { selector: 'edge[kind="fetch"]', style: { "line-color": C.muted, "target-arrow-color": C.muted, opacity: 0.55 } },
  { selector: 'edge[kind="fetch"][?cached]', style: { "line-color": C.blue, "target-arrow-color": C.blue, opacity: 0.8, width: 1.4 } },
  { selector: 'edge[kind="hosts"]', style: { "line-color": C.border, "target-arrow-color": C.border, "line-style": "dotted", opacity: 0.4, width: 1, "target-arrow-shape": "none" } },
  { selector: 'edge[kind="reads"]', style: { "line-color": C.peach, "target-arrow-color": C.peach, opacity: 0.5, "line-style": "dashed" } },
  { selector: 'edge[kind="writes"]', style: { "line-color": C.red, "target-arrow-color": C.red, opacity: 0.85, width: 1.6 } },

  // ── Schemas view ──────────────────────────────────────────────────────
  // Tables are compound parents (columns are children), coloured per database.
  {
    selector: 'node[kind="table"]',
    style: {
      shape: "round-rectangle", "background-color": C.schemaTableFill, "background-opacity": 0.45,
      "border-width": 1.6, "border-color": C.muted, "font-size": 12, "font-weight": 600, color: C.ink,
      "text-valign": "top", "text-halign": "center", "text-margin-y": -2, padding: 10, "min-width": 40, "min-height": 20,
    },
  },
  { selector: 'node[kind="table"][db="firestore"]', style: { "border-color": C.dbFirestoreBorder, "background-color": C.dbFirestoreFill } },
  { selector: 'node[kind="table"][db="sql"]',       style: { "border-color": C.dbSqlBorder,       "background-color": C.dbSqlFill } },
  { selector: 'node[kind="table"][db="bigquery"]',  style: { "border-color": C.dbBigqueryBorder,  "background-color": C.dbBigqueryFill } },
  { selector: 'node[kind="table"][?matview]', style: { "border-style": "dashed" } },
  // Collapsed table — solid pill, not a hollow cluster region (.collapsed toggled by applySchemaCollapse()).
  { selector: 'node[kind="table"].collapsed', style: { "background-opacity": 1, "text-valign": "center", "text-margin-y": 0, height: 22, width: "label" } },
  // Columns (children).
  {
    selector: 'node[kind="column"]',
    style: {
      shape: "ellipse", width: 12, height: 12, "background-color": C.schemaColumnFill, "border-color": C.schemaColumnBorder,
      "border-width": 1, "font-size": 8, color: C.muted, "text-valign": "center", "text-halign": "right", "text-margin-x": 3,
    },
  },
  { selector: 'node[kind="column"][?isKey]', style: { shape: "diamond", width: 14, height: 14, "border-width": 1.6, "border-color": C.peach, color: C.ink } },
  // Schema edges: joins (SQL/BQ), fk-reference (cross-table refs), subcollection (Firestore nesting).
  { selector: 'edge[kind="joins"]', style: { "line-color": C.teal, "target-arrow-color": C.teal, "target-arrow-shape": "none", opacity: 0.7, width: 1.5, label: "data(label)", "font-size": 7, color: C.muted, "text-rotation": "autorotate", "text-background-color": C.paper, "text-background-opacity": 0.7 } },
  { selector: 'edge[kind="joins"][confidence="low"]', style: { "line-style": "dashed", opacity: 0.4, width: 1 } },
  { selector: 'edge[kind="fk-reference"]', style: { "line-color": C.mauve, "target-arrow-color": C.mauve, "target-arrow-shape": "triangle", "line-style": "solid", opacity: 0.85, width: 1.6, label: "data(label)", "font-size": 7, color: C.muted, "text-rotation": "autorotate", "text-background-color": C.paper, "text-background-opacity": 0.7 } },
  { selector: 'edge[kind="subcollection"]', style: { "line-color": C.green, "target-arrow-color": C.green, "target-arrow-shape": "triangle-tee", "line-style": "dotted", opacity: 0.75, width: 1.4 } },

  // ── Faded (dimmed) state — used by focus / text filter ───────────────
  { selector: ".faded", style: { opacity: 0.08, "text-opacity": 0.1 } },
  { selector: "edge.faded", style: { opacity: 0.04 } },
  {
    selector: ".highlight",
    style: { "border-width": 2, "border-color": C.ink },
  },
  ];
}

// Re-render the active cytoscape on theme change. We re-apply the style
// array in place rather than destroy+rebuild so the user's current focus
// state / layout position aren't lost.
window.addEventListener("skua:theme-changed", () => {
  if (cy) cy.style(makeStyle());
});

function layoutOpts(name) {
  if (name === "dagre")
    return {
      name: "dagre",
      rankDir: "LR", // left-to-right ⇒ fe-route | be-route | table columns
      nodeSep: 14,
      edgeSep: 6,
      rankSep: 110,
      fit: true,
      padding: 24,
    };
  if (name === "cose")
    return {
      name: "cose",
      animate: false,
      randomize: true,
      fit: true,
      padding: 24,
      idealEdgeLength: 110,
      nodeRepulsion: () => 9000,
      nodeOverlap: 16,
      gravity: 0.25,
      componentSpacing: 70,
      numIter: 2500,
    };
  if (name === "breadthfirst")
    return {
      name: "breadthfirst",
      directed: true,
      padding: 24,
      spacingFactor: 0.9,
    };
  if (name === "circle") return { name: "circle", padding: 24 };
  return { name: "grid", padding: 24 };
}

// All graph kinds default to dagre — clean rank layout. The AI graph
// is flat (no compound `parent` grouping) so dagre handles it the same
// way it handles the skills graph.
function defaultLayout(_kind) {
  return "dagre";
}

function runLayout() {
  if (!cy) return;
  let name = $("#layout").value;
  // dagre cannot lay out compound (parent) nodes — on the schemas graph an
  // expanded table is a compound parent of its columns, so fall back to cose
  // whenever column nodes are present.
  if (currentKind() === "schemas" && name === "dagre" && cy.nodes('[kind="column"]').length > 0) {
    name = "cose";
  }
  cy.layout(layoutOpts(name)).run();
}

// ── Manual node-position persistence (localStorage, per-graph-kind) ─────────
// Dagre recomputes every load, throwing away any manual drag. We snapshot
// node x/y on drag-release into localStorage and re-apply on load so a
// hand-arranged graph survives a refresh.
function positionsEnabled(kind) {
  // The schemas graph rebuilds its compound table/column set on every
  // expand/collapse, so saved absolute positions would fight the live layout.
  return kind !== "schemas";
}
function posKey(kind) {
  return `skua:positions:${kind}`;
}
function loadPositions(kind) {
  try {
    const raw = localStorage.getItem(posKey(kind));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveCurrentPositions(kind) {
  if (!cy) return;
  const map = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    map[n.id()] = { x: p.x, y: p.y };
  });
  try {
    localStorage.setItem(posKey(kind), JSON.stringify(map));
  } catch {
    /* quota / private mode — silently skip */
  }
}
// Re-apply saved positions on top of whatever the layout produced. Nodes with
// no saved entry (added since last save) keep their fresh layout position.
function applySavedPositions(kind) {
  const saved = loadPositions(kind);
  if (!saved) return;
  let applied = 0;
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const p = saved[n.id()];
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        n.position(p);
        applied++;
      }
    });
  });
  if (applied) cy.fit(undefined, 24);
}

async function load(rebuild = false) {
  const kind = currentKind();
  $("#info").textContent = "loading…";
  const url = `/api/graphs/${kind}${rebuild ? "?rebuild=1" : ""}`;
  const data = await fetch(url).then((r) => r.json());
  if (cy) cy.destroy();
  // Schemas is a CARD view (not a graph): one expandable card per table showing
  // its columns, DB-agnostic. Render cards and skip the cytoscape path entirely.
  if (kind === "schemas") {
    cy = null;
    renderSchemaCards(data);
    const line = infoLine(kind, data);
    $("#info").innerHTML = line;
    $("#info").dataset.fullLine = line;
    return;
  }
  // schemas ships every column as a compound child in the initial payload; use
  // a compound-safe layout for the first paint (setupSchema collapses + re-lays
  // out immediately) so dagre never sees compound nodes.
  const initLayout = kind === "schemas" ? "grid" : $("#layout").value;
  cy = cytoscape({
    container: $("#cy"),
    elements: [...(data.nodes ?? []), ...(data.edges ?? [])],
    style: makeStyle(),
    layout: layoutOpts(initLayout),
    wheelSensitivity: 0.2,
  });
  cy.on("tap", "node", (e) => {
    const id = e.target.data("id");
    if (id.startsWith("TKT-")) {
      location.href = `/ticket/${id}`;
      return;
    }
    if (kind === "schemas") {
      onSchemaNodeTap(e.target);
      return;
    }
    focusLineage(e.target);
  });
  cy.on("tap", (e) => {
    if (e.target === cy) {
      clearFocus();
      if (kind === "schemas") hideInspector();
    }
  });
  // Grabbing a node (mouse-down to drag) should dismiss the hover card so it
  // doesn't sit stuck over the graph while you reposition. positionTooltip
  // no-ops while hidden, so it stays gone for the whole drag.
  cy.on("grab", "node", hideSkillTooltip);
  if (kind === "schemas") setupSchema(data);
  if (kind === "ai") {
    cy.on("mouseover", "node", (e) => showAiTooltip(e.target, e.originalEvent));
    cy.on("mousemove", "node", (e) => positionTooltip(e.originalEvent));
    cy.on("mouseout", "node", hideSkillTooltip);
  }
  if (kind === "tickets") {
    cy.on("mouseover", "node", (e) => showTicketTooltip(e.target, e.originalEvent));
    cy.on("mousemove", "node", (e) => positionTooltip(e.originalEvent));
    cy.on("mouseout", "node", hideSkillTooltip);
  }
  const line = infoLine(kind, data);
  // The AI + schemas graphs embed a clickable warn pill (`<span class="warn-pill">`)
  // so we render as HTML there. Other graphs stay textContent for safety.
  if (kind === "ai" || kind === "schemas") $("#info").innerHTML = line;
  else $("#info").textContent = line;
  $("#info").dataset.fullLine = line;
  applyTextFilter();
  applyEdgeMode();
  // applyEdgeMode runs the final layout, so re-apply saved positions last
  // (they must win over the auto-layout) and start tracking drags.
  if (positionsEnabled(kind)) {
    applySavedPositions(kind);
    cy.on("free", "node", () => saveCurrentPositions(kind));
  }
}

// ── Schemas CARD view ───────────────────────────────────────────────────────
// DB-agnostic: every table (BigQuery, Firestore, SQL/Cloud-SQL/RDS/Aurora/
// Redshift/Spanner, DynamoDB, Cosmos, Mongo, …) renders as one expandable card
// showing its columns. The provider layer tags each table with a `db`; this map
// turns any engine into a label + accent colour (unknown engines fall back to a
// neutral badge, so the view never breaks on a new database type).
const DB_META = {
  bigquery:  { label: "BigQuery",   color: "#fe640b" },
  firestore: { label: "Firestore",  color: "#40a02b" },
  sql:       { label: "SQL",        color: "#df8e1d" },
  postgres:  { label: "Postgres",   color: "#336791" },
  mysql:     { label: "MySQL",      color: "#00758f" },
  sqlite:    { label: "SQLite",     color: "#0f80cc" },
  spanner:   { label: "Spanner",    color: "#4285f4" },
  redshift:  { label: "Redshift",   color: "#c1474b" },
  snowflake: { label: "Snowflake",  color: "#29b5e8" },
  dynamodb:  { label: "DynamoDB",   color: "#4053d6" },
  cosmos:    { label: "Cosmos DB",  color: "#0078d4" },
  mongodb:   { label: "MongoDB",    color: "#13aa52" },
  cassandra: { label: "Cassandra",  color: "#1287b1" },
  redis:     { label: "Redis",      color: "#d82c20" },
  s3:        { label: "S3",         color: "#e25444" },
};
function dbMeta(db) {
  return DB_META[db] || { label: db || "database", color: "var(--muted)" };
}
function tableIdOf(elId) {
  // column ids are "<db>:<table>.<col>"; table ids are "<db>:<table>".
  const dot = elId.indexOf(".");
  return dot < 0 ? elId : elId.slice(0, dot);
}

function renderSchemaCards(data) {
  const host = $("#schema-cards");
  if (!host) return;
  const nodes = data.nodes ?? [];
  const tables = nodes.filter((n) => n.data.kind === "table").map((n) => n.data);
  const cols = nodes.filter((n) => n.data.kind === "column").map((n) => n.data);
  const colsByTable = new Map();
  for (const c of cols) {
    if (!colsByTable.has(c.parent)) colsByTable.set(c.parent, []);
    colsByTable.get(c.parent).push(c);
  }
  // Related tables (joins / fk-reference) → chips on each card.
  const nameById = new Map(tables.map((t) => [t.id, t.label]));
  const related = new Map();
  for (const e of data.edges ?? []) {
    if (e.data.kind !== "joins" && e.data.kind !== "fk-reference") continue;
    const a = tableIdOf(e.data.source), b = tableIdOf(e.data.target);
    if (a === b) continue;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!nameById.has(x) || !nameById.has(y)) continue;
      if (!related.has(x)) related.set(x, new Set());
      related.get(x).add(nameById.get(y));
    }
  }

  // Group by database, then sort tables (defined-with-columns first, then name).
  tables.sort((a, b) =>
    (a.db || "").localeCompare(b.db || "") ||
    (colsByTable.has(b.id) - colsByTable.has(a.id)) ||
    a.label.localeCompare(b.label));
  const dbCounts = {};
  for (const t of tables) dbCounts[t.db] = (dbCounts[t.db] || 0) + 1;

  const toolbar = `
    <div class="sc-bar">
      <div class="sc-dbs">${Object.entries(dbCounts).map(([db, n]) => {
        const m = dbMeta(db);
        return `<span class="sc-badge" style="--c:${m.color}">${escHtml(m.label)} · ${n}</span>`;
      }).join("")}</div>
      <div class="sc-actions">
        <button class="sc-expand-all" type="button">expand all</button>
        <button class="sc-collapse-all" type="button">collapse all</button>
      </div>
    </div>`;

  const cards = tables.map((t) => {
    const m = dbMeta(t.db);
    const fields = (colsByTable.get(t.id) ?? []).slice().sort((a, b) => {
      // keys first, then declaration order (stable)
      return (b.isKey ? 1 : 0) - (a.isKey ? 1 : 0);
    });
    const optLines = fmtOptimizations(t.optimizations);
    const meta = [
      classChip(t),
      ...(optLines.length ? optLines : [
        t.matview ? "materialized view" : "",
        t.partitionField ? `partition: ${t.partitionField}` : "",
        t.clusterFields?.length ? `cluster: ${t.clusterFields.join(", ")}` : "",
      ]),
      t.subOf ? `subcollection of ${String(t.subOf).replace(/^[a-z]+:/, "")}` : "",
    ].filter(Boolean);
    const relChips = related.get(t.id);
    const searchStr = [t.label, ...fields.map((f) => f.label)].join(" ").toLowerCase();

    const hasDesc = fields.some((f) => f.description);
    const rows = fields.map((f) => {
      const mode = f.mode === "REQUIRED" ? "required" : f.mode === "REPEATED" ? "repeated" : "";
      const modeCls = f.mode === "REQUIRED" ? " req" : f.mode === "REPEATED" ? " rep" : "";
      return `<tr class="f-row${f.isKey ? " is-key" : ""}">`
        + `<td class="f-name">${f.isKey ? "◆ " : ""}${escHtml(f.label)}</td>`
        + `<td class="f-type">${escHtml(f.fieldType ?? "")}</td>`
        + `<td class="f-mode${modeCls}">${mode}</td>`
        + (hasDesc ? `<td class="f-desc" title="${escHtml(f.description ?? "")}">${escHtml(f.description ?? "")}</td>` : "")
        + `</tr>`;
    }).join("");
    const body = fields.length
      ? `<table class="sc-cols"><tbody>${rows}</tbody></table>`
      : `<div class="sc-empty">No static schema — this table is built at runtime (CTAS / load job). Append <code>?live=1</code> to the URL for live introspection.</div>`;
    const metaStrip = meta.length
      ? `<div class="sc-meta">${meta.map((x) => `<span>${escHtml(x)}</span>`).join("")}</div>`
      : "";

    return `
      <section class="sc-card" data-db="${escHtml(t.db || "")}" data-search="${escHtml(searchStr)}" style="--c:${m.color}">
        <header class="sc-head" tabindex="0" role="button" aria-expanded="false">
          <span class="sc-dot"></span>
          <span class="sc-name" title="${escHtml(t.label)}">${escHtml(t.label)}</span>
          <span class="sc-badge" style="--c:${m.color}">${escHtml(m.label)}</span>
          <span class="sc-count">${fields.length ? `${fields.length} col${fields.length === 1 ? "" : "s"}` : "?live=1"}</span>
          <span class="sc-chev">▸</span>
        </header>
        <div class="sc-body" hidden>
          ${metaStrip}
          ${body}
          ${relChips && relChips.size ? `<div class="sc-rel">↔ joins: ${[...relChips].map((r) => `<code>${escHtml(r)}</code>`).join(" ")}</div>` : ""}
        </div>
      </section>`;
  }).join("");

  host.innerHTML = toolbar + `<div class="sc-grid">${cards}</div>`;

  // Interaction: toggle a card; expand/collapse all.
  host.onclick = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".sc-expand-all")) { setAllCards(host, true); return; }
    if (target.closest(".sc-collapse-all")) { setAllCards(host, false); return; }
    const head = target.closest(".sc-head");
    if (head) toggleCard(head.parentElement);
  };
  host.onkeydown = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const head = e.target instanceof Element ? e.target.closest(".sc-head") : null;
    if (head) { e.preventDefault(); toggleCard(head.parentElement); }
  };
}

function toggleCard(card, force) {
  if (!card) return;
  const open = force === undefined ? !card.classList.contains("open") : force;
  card.classList.toggle("open", open);
  const body = card.querySelector(".sc-body");
  const head = card.querySelector(".sc-head");
  if (body) body.hidden = !open;
  if (head) head.setAttribute("aria-expanded", String(open));
}
function setAllCards(host, open) {
  for (const card of host.querySelectorAll(".sc-card")) {
    if (card.style.display === "none") continue; // respect active filter
    toggleCard(card, open);
  }
}
function filterSchemaCards() {
  const host = $("#schema-cards");
  if (!host) return;
  const q = $("#filter").value.trim().toLowerCase();
  let shown = 0;
  for (const card of host.querySelectorAll(".sc-card")) {
    const hit = !q || (card.dataset.search || "").includes(q);
    card.style.display = hit ? "" : "none";
    if (hit) shown++;
    // Auto-expand a card when the query matches one of its columns.
    if (q && hit && !(card.dataset.search || "").startsWith(q)) toggleCard(card, true);
    if (!q) toggleCard(card, false);
  }
}

// ── Focus mode ────────────────────────────────────────────────────────────
// Click a node ⇒ keep its full upstream + downstream lineage visible, dim
// everything else. Click background to restore.
function focusLineage(node) {
  if (!cy) return;
  const lineage = node.predecessors().union(node.successors()).union(node);
  cy.elements().addClass("faded");
  lineage.removeClass("faded");
  node.addClass("highlight");
  $("#info").dataset.focus = node.data("label");
  $("#info").textContent =
    `focus: ${node.data("label")} · ${lineage.nodes().length - 1} connected`;
}
function clearFocus() {
  if (!cy) return;
  cy.elements().removeClass("faded").removeClass("highlight");
  delete $("#info").dataset.focus;
  applyTextFilter(); // text filter, if active, re-applies
  // Restore the original info line.
  const kind = currentKind();
  $("#info").textContent = $("#info").dataset.fullLine ?? "";
}

// ── Text filter ───────────────────────────────────────────────────────────
function applyTextFilter() {
  if (!cy) return;
  const q = $("#filter").value.trim().toLowerCase();
  if (!q) {
    cy.elements().removeClass("faded");
    return;
  }
  // On the AI ecosystem graph the filter matches BOTH label and kind so
  // typing "hook" / "mcp" / "skill" isolates a primitive cluster. ADR-004
  // Pass 4. Other graphs keep label-only behavior to avoid surprises.
  const matchesKind = currentKind() === "ai";
  const matches = cy.nodes().filter((n) => {
    if ((n.data("label") ?? "").toLowerCase().includes(q)) return true;
    if (matchesKind && (n.data("kind") ?? "").toLowerCase().includes(q)) return true;
    return false;
  });
  const keep = matches.union(matches.connectedEdges());
  cy.elements().addClass("faded");
  keep.removeClass("faded");
}

// ── Skill hover tooltip ───────────────────────────────────────────────────
let tooltipEl = null;
function getSkillTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "skua-tt";
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}
function showSkillTooltip(node, evt) {
  const d = node.data();
  if (!d.description && !d.whenToUse) return;
  const tt = getSkillTooltip();
  const whenHtml = d.whenToUse
    ? `<div class="skua-tt-next"><span class="skua-tt-next-label">When:</span> <span class="skua-tt-next-text">${escHtml(d.whenToUse)}</span></div>`
    : "";
  tt.innerHTML = `
    <div class="skua-tt-title">${escHtml(d.label)}</div>
    <div class="skua-tt-meta">
      <span class="skua-tt-muted">${escHtml(d.kind ?? "")}</span>
    </div>
    ${d.description ? `<div class="skua-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(d.description)}</div>` : ""}
    ${whenHtml}`;
  tt.hidden = false;
  positionTooltip(evt);
}
function positionTooltip(evt) {
  if (!tooltipEl || tooltipEl.hidden || !evt) return;
  const pad = 14;
  const rect = tooltipEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width + 8 > vw) x = evt.clientX - rect.width - pad;
  if (y + rect.height + 8 > vh) y = evt.clientY - rect.height - pad;
  tooltipEl.style.left = `${Math.max(8, x)}px`;
  tooltipEl.style.top = `${Math.max(8, y)}px`;
}
function hideSkillTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

function showTicketTooltip(node, evt) {
  const d = node.data();
  if (!d.title) return;
  const tt = getSkillTooltip();
  const metaBits = [d.bucket, d.priority, d.domain].filter(Boolean).map(escHtml).join(" · ");
  tt.innerHTML = `
    <div class="skua-tt-title">${escHtml(d.id)}</div>
    <div class="skua-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(d.title)}</div>
    ${metaBits ? `<div class="skua-tt-meta"><span class="skua-tt-muted">${metaBits}</span></div>` : ""}`;
  tt.hidden = false;
  positionTooltip(evt);
}

// ── AI ecosystem hover tooltip (ADR-004) ──────────────────────────────────
// Per-kind one-liner explaining what each node IS, in case the node has no
// frontmatter description to fall back on (built-in tools, hook events,
// etc.). Reuses the .skua-tt DOM element + CSS from the skills tooltip.
const AI_KIND_EXPLAINER = {
  "skill":                "Claude Code skill — invoked via /name or auto-discovered by description",
  "agent":                "Custom subagent — runs in its own context window with restricted tools",
  "agent-builtin":        "Built-in Claude Code subagent",
  "slash-command":        "Slash command (legacy commands/ dir; merged into skills as of v2.1.73)",
  "hook":                 "Configured lifecycle hook — fires on the matched event",
  "hook-event":           "Claude Code lifecycle event — hooks register against these",
  "mcp-server":           "MCP server providing tools / prompts / resources",
  "mcp-tool":             "Tool exposed by an MCP server",
  "mcp-prompt":           "Prompt exposed by an MCP server (surfaces as /mcp__server__prompt)",
  "mcp-resource":         "Resource exposed by an MCP server (@server:protocol://...)",
  "output-style":         "Custom output style — modifies the system prompt role/tone",
  "output-style-builtin": "Built-in output style",
  "plugin":               "Installed plugin — may bundle skills, agents, hooks, MCP, LSP, output styles",
  "marketplace":          "Plugin marketplace — source for installable plugins",
  "settings-file":        "Settings file — configures hooks, MCP allow/deny, outputStyle, statusLine",
  "claude-md":            "CLAUDE.md memory file — instructions loaded at session start",
  "status-line":          "Status line script invoked from settings.json:statusLine",
  "lsp-server":           "Language Server — plugin-bundled, gives Claude real-time diagnostics",
  "tool-builtin":         "Built-in Claude Code tool — exposed to the model",
  "tool-mcp":             "Tool exposed via MCP",
};
const AI_SCOPE_LABEL = {
  "user":          "~/.claude (user)",
  "project":       ".claude (project)",
  "project-local": ".claude/settings.local.json (project, gitignored)",
  "plugin":        "shipped by a plugin",
  "builtin":       "built into Claude Code",
  "managed":       "managed by enterprise policy",
};
function showAiTooltip(node, evt) {
  const d = node.data();
  const tt = getSkillTooltip();
  const explainer = AI_KIND_EXPLAINER[d.kind] ?? d.kind ?? "";
  const scopeLabel = d.scope ? (AI_SCOPE_LABEL[d.scope] ?? d.scope) : null;
  // Description from frontmatter (skills, agents, output styles) — fall
  // back to the per-kind explainer when nothing user-facing was parsed.
  const descSource = d.description || explainer;
  const scopeHtml = scopeLabel
    ? `<span class="skua-tt-sep">·</span><span class="skua-tt-muted">${escHtml(scopeLabel)}</span>`
    : "";
  const pathHtml = d.path
    ? `<div class="skua-tt-next"><span class="skua-tt-next-label">path:</span> <span class="skua-tt-next-text"><code>${escHtml(d.path)}</code></span></div>`
    : "";
  // Precedence badge (TKT-237) when scope-overlap puts this node on the
  // losing side.
  const precHtml = d.precedence && d.precedence !== "WINNING"
    ? `<div class="skua-tt-next"><span class="skua-tt-next-label">precedence:</span> <span class="skua-tt-next-text">${escHtml(d.precedence)}</span></div>`
    : "";
  tt.innerHTML = `
    <div class="skua-tt-title">${escHtml(d.label)}</div>
    <div class="skua-tt-meta">
      <span class="skua-tt-muted">${escHtml(d.kind ?? "")}</span>
      ${scopeHtml}
    </div>
    <div class="skua-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(descSource)}</div>
    ${pathHtml}
    ${precHtml}`;
  tt.hidden = false;
  positionTooltip(evt);
}

// ── Schemas interactive subsystem (collapse/expand tables + field inspector) ──
// Tables are compound parents of their columns; collapsed by default. Column-
// level fk/join edges get deduped table↔table "proxy" edges so a relationship
// still shows when a table is collapsed. Firestore `subcollection` edges are
// already table→table and stay visible in every state.
let schemaState = null;

function setupSchema(data) {
  const colNodes = (data.nodes ?? []).filter((n) => n.data.kind === "column");
  const colToTable = new Map(colNodes.map((n) => [n.data.id, n.data.parent]));
  const colEdges = (data.edges ?? []).filter(
    (e) => e.data.kind === "joins" || e.data.kind === "fk-reference",
  );

  // Preserve the bare table name before the chevron relabel overwrites `label`.
  cy.nodes('[kind="table"]').forEach((t) => {
    if (t.data("name") == null) t.data("name", t.data("label"));
  });

  // Deduped table↔table proxy edges (one per pair+kind), strongest confidence wins.
  const proxyByKey = new Map();
  for (const e of colEdges) {
    const a = colToTable.get(e.data.source);
    const b = colToTable.get(e.data.target);
    if (!a || !b || a === b) continue;
    const [s, t] = [a, b].sort();
    const key = `${s}|${t}|${e.data.kind}`;
    const prev = proxyByKey.get(key);
    const conf = e.data.confidence === "low" && prev?.conf !== "high" ? "low" : "high";
    proxyByKey.set(key, { s, t, kind: e.data.kind, conf });
  }
  const proxyDefs = [...proxyByKey.entries()].map(([key, v]) => ({
    data: { id: `proxy:${key}`, source: v.s, target: v.t, kind: v.kind, proxy: true, confidence: v.conf },
  }));
  cy.add(proxyDefs);

  schemaState = { colNodes, colEdges, colToTable, expanded: new Set() };

  // Collapse everything by default: remove all column children.
  cy.remove(cy.nodes('[kind="column"]'));
  applySchemaCollapse();
}

function applySchemaCollapse() {
  if (!schemaState || !cy) return;
  const { colNodes, colEdges, expanded } = schemaState;
  cy.batch(() => {
    cy.nodes('[kind="table"]').forEach((t) => {
      const isExp = expanded.has(t.data("id"));
      t.toggleClass("collapsed", !isExp);
      const mv = t.data("matview") ? " ⊳" : "";
      t.data("label", `${isExp ? "▾" : "▸"} ${t.data("name") ?? t.data("id")}${mv}`);
    });
    const present = new Set(
      colNodes.filter((n) => expanded.has(n.data.parent)).map((n) => n.data.id),
    );
    cy.nodes('[kind="column"]').forEach((n) => {
      if (!present.has(n.data("id"))) cy.remove(n);
    });
    for (const n of colNodes) {
      if (present.has(n.data.id) && cy.getElementById(n.data.id).length === 0) cy.add(n);
    }
    for (const e of colEdges) {
      if (present.has(e.data.source) && present.has(e.data.target) && cy.getElementById(e.data.id).length === 0) {
        cy.add(e);
      }
    }
    // Proxy table↔table edges: visible only when at least one side is collapsed.
    cy.edges("[?proxy]").forEach((pe) => {
      const bothExpanded = expanded.has(pe.data("source")) && expanded.has(pe.data("target"));
      pe.style("display", bothExpanded ? "none" : "element");
    });
  });
  runLayout();
}

function onSchemaNodeTap(node) {
  const kind = node.data("kind");
  if (kind === "table") {
    const id = node.data("id");
    if (schemaState.expanded.has(id)) schemaState.expanded.delete(id);
    else schemaState.expanded.add(id);
    applySchemaCollapse();
    showInspector(node);
  } else if (kind === "column") {
    showInspector(node);
  }
}

let inspectorEl = null;
function getInspector() {
  if (inspectorEl) return inspectorEl;
  inspectorEl = document.createElement("div");
  inspectorEl.className = "skua-tt bq-inspector";
  inspectorEl.style.cssText =
    "position:fixed;top:150px;left:16px;width:300px;max-height:70vh;overflow:auto;z-index:50;padding:12px 14px;";
  inspectorEl.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.classList.contains("bqi-close")) hideInspector();
  });
  document.body.appendChild(inspectorEl);
  return inspectorEl;
}
function hideInspector() {
  if (inspectorEl) inspectorEl.hidden = true;
}
// Compact, class-agnostic summary of a table's TableOptimizations (see DB_CLASSES.md).
function fmtOptimizations(o) {
  if (!o) return [];
  const out = [];
  if (o.primaryKey && o.primaryKey.length) out.push(`PK(${o.primaryKey.join(", ")})`);
  if (o.partition) {
    const p = o.partition;
    const k = p.strategy === "TIME" ? `${p.key}${p.unit ? "/" + p.unit : ""}` : `${p.strategy}(${p.key})`;
    out.push(`partition: ${k}${p.requireFilter ? " ·filter-required" : ""}`);
  }
  if (o.clustering && o.clustering.length) out.push(`cluster: ${o.clustering.join(", ")}`);
  if (o.materialized) out.push("materialized view");
  if (o.distribution) out.push(`dist: ${o.distribution}`);
  if (o.indexes) for (const ix of o.indexes) {
    out.push(`idx${ix.unique ? "*" : ""} ${ix.method ? ix.method + " " : ""}(${(ix.columns || []).join(", ")})`
      + `${ix.covering && ix.covering.length ? ` +incl(${ix.covering.join(", ")})` : ""}${ix.where ? " WHERE…" : ""}`);
  }
  if (o.compositeIndexes) for (const ci of o.compositeIndexes) out.push(`composite (${(ci.fields || []).join(", ")})`);
  if (o.ttl) out.push(`TTL${o.ttl.field ? ": " + o.ttl.field : ""}`);
  if (o.rowKey) out.push(`rowkey: ${o.rowKey}`);
  if (o.vectorIndex) out.push(`vector: ${o.vectorIndex.method}`);
  if (o.notes) for (const n of o.notes) out.push(n);
  return out;
}
const DB_CLASS_LABEL = {
  relational: "RELATIONAL", document: "DOCUMENT", analytical: "ANALYTICAL",
  newsql: "NEWSQL", "wide-column": "WIDE-COLUMN", vector: "VECTOR",
};
// "ANALYTICAL · BigQuery" — the database-class badge for a table card.
function classChip(d) {
  const cls = d.dbClass ? (DB_CLASS_LABEL[d.dbClass] || d.dbClass) : "";
  return [cls, d.engine].filter(Boolean).join(" · ");
}

function inspectorHead(kindLabel, name, state) {
  return `<div class="bqi-head"><div><span class="bqi-kind">${escHtml(kindLabel)}</span> <code>${escHtml(name)}</code>${state ? ` <span class="skua-tt-muted">${escHtml(state)}</span>` : ""}</div><button class="bqi-close" title="close">×</button></div>`;
}
function showInspector(node) {
  const d = node.data();
  const el = getInspector();
  let html = "";
  if (d.kind === "table") {
    const cols = schemaState.colNodes.filter((n) => n.data.parent === d.id);
    const optLines = fmtOptimizations(d.optimizations);
    const meta = [
      escHtml(classChip(d)) || (d.db ? `db: ${escHtml(d.db)}` : ""),
      d.subOf ? `subcollection of ${escHtml(String(d.subOf).replace(/^[a-z]+:/, ""))}` : "",
      ...(optLines.length ? optLines.map(escHtml) : [
        d.matview ? "materialized view" : "",
        d.partitionField ? `partition: ${escHtml(d.partitionField)}` : "",
        d.clusterFields ? `cluster: ${escHtml(d.clusterFields.join(", "))}` : "",
      ]),
    ].filter(Boolean).join(" · ");
    const rows = cols.length
      ? cols.map((c) => {
          const cd = c.data;
          const key = cd.isKey ? ' <span style="color:var(--peach,#fe640b)">◆</span>' : "";
          const desc = cd.description ? `<div class="skua-tt-muted" style="margin:0 0 4px 0;font-size:10px">${escHtml(cd.description)}</div>` : "";
          return `<li style="margin:3px 0"><code>${escHtml(cd.label)}</code>${key} <span class="skua-tt-muted">${escHtml(cd.fieldType ?? "")}${cd.mode === "REQUIRED" ? " ·req" : ""}</span>${desc}</li>`;
        }).join("")
      : `<li class="skua-tt-muted">no columns parsed for this table</li>`;
    html = `
      ${inspectorHead("table", d.name ?? d.id, schemaState.expanded.has(d.id) ? "expanded" : "collapsed")}
      <div class="skua-tt-meta"><span class="skua-tt-muted">${meta}</span></div>
      <div class="skua-tt-muted" style="margin:6px 0 2px;font-size:10px">${cols.length} columns${schemaState.expanded.has(d.id) ? "" : " · click the table to show them on the graph"}</div>
      <ul style="list-style:none;padding:0;margin:0">${rows}</ul>`;
  } else {
    const conns = schemaState.colEdges
      .filter((e) => e.data.source === d.id || e.data.target === d.id)
      .map((e) => {
        const other = e.data.source === d.id ? e.data.target : e.data.source;
        const verb = e.data.kind === "fk-reference" ? "→ references" : "↔ joins";
        const low = e.data.confidence === "low" ? " <span class='skua-tt-muted'>(low-conf)</span>" : "";
        return `<li style="margin:3px 0">${verb} <code>${escHtml(other)}</code>${low}</li>`;
      }).join("");
    html = `
      ${inspectorHead("column", d.label, "")}
      <div class="skua-tt-meta"><span class="skua-tt-muted">${escHtml(d.fieldType ?? "")} · ${escHtml(d.mode ?? "")}${d.isKey ? " · key ◆" : ""}</span></div>
      ${d.description ? `<div class="skua-tt-next" style="border-top:none;padding-top:4px;margin-top:4px">${escHtml(d.description)}</div>` : ""}
      ${conns ? `<div class="skua-tt-muted" style="margin:6px 0 2px;font-size:10px">connections</div><ul style="list-style:none;padding:0;margin:0">${conns}</ul>` : ""}`;
  }
  el.innerHTML = html;
  el.hidden = false;
}

function infoLine(kind, data) {
  const n = (data.nodes ?? []).length;
  const e = (data.edges ?? []).length;
  const built = data.meta?.built?.slice(0, 16).replace("T", " ") ?? "?";
  if (kind === "dataflow") {
    const c = data.meta?.counts ?? {};
    const w = data.meta?.warnings?.length ?? 0;
    return `${c.routes ?? 0} routes · ${c.containers ?? 0} containers · ${c.endpoints ?? 0} endpoints · ${c.stores ?? 0} stores · ${e} edges · ${w} warn · ${built}`;
  }
  if (kind === "schemas") {
    const c = data.meta?.counts ?? {};
    const w = data.meta?.warnings?.length ?? 0;
    window.__skuaWarnings = data.meta?.warnings ?? [];
    const src = data.meta?.source ?? "static";
    const dbs = (data.meta?.databases ?? []).map((d) => d.db).join(" / ") || "none";
    const warnHtml = w > 0
      ? ` · <span class="warn-pill" title="click for details" style="cursor:pointer;text-decoration:underline dotted">${w} warn</span>`
      : ` · 0 warn`;
    return `${c.tables ?? 0} tables · ${c.columns ?? 0} cols · ${c.references ?? 0} refs · ${c.subcollections ?? 0} subcoll · ${dbs} · ${src}${warnHtml} · ${built}`;
  }
  if (kind === "ai") {
    const c = data.meta?.counts ?? {};
    const w = data.meta?.warnings?.length ?? 0;
    // Stash for the click-to-expand handler.
    window.__skuaWarnings = data.meta?.warnings ?? [];
    const warnHtml = w > 0
      ? ` · <span class="warn-pill" title="click for details" style="cursor:pointer;text-decoration:underline dotted">${w} warn</span>`
      : ` · 0 warn`;
    return `${c.skills ?? 0} skills · ${c.agents ?? 0} agents · ${c.hooks ?? 0} hooks · ${c.mcp ?? 0} mcp · ${c.outputStyles ?? 0} styles · ${c.plugins ?? 0} plugins · ${c.tools ?? 0} tools · ${c.edges ?? 0} edges · ${c.orphans ?? 0} orphans${warnHtml} · ${built}`;
  }
  return `${n} nodes · ${e} edges · built ${built}`;
}

$("#layout").addEventListener("change", () => {
  // Re-run layout in place without refetching data.
  runLayout();
});
$("#filter").addEventListener("input", () => {
  if (currentKind() === "schemas") { filterSchemaCards(); return; }
  clearFocusClasses();
  applyTextFilter();
});
$("#rebuild").addEventListener("click", () => load(true));
$("#reset-layout").addEventListener("click", () => {
  // Drop the saved arrangement for this kind and snap back to auto-layout.
  try {
    localStorage.removeItem(posKey(currentKind()));
  } catch {
    /* ignore */
  }
  runLayout();
  if (cy) cy.fit(undefined, 24);
});

// Click the warning count in the info line to surface the warning list
// (ADR-004 DRAFT-4). Cheaper than a dedicated panel; matches the
// dashboard's existing "info-line is the bar" pattern.
$("#info").addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (!target.classList.contains("warn-pill")) return;
  const warnings = window.__skuaWarnings ?? [];
  if (warnings.length === 0) return;
  const lines = warnings.map((w) => `${w.kind}: ${w.detail}`).join("\n");
  alert(`${warnings.length} warning(s)\n\n${lines}`);
});

function clearFocusClasses() {
  if (cy) cy.elements().removeClass("highlight");
}

// Pre-select the default layout in the dropdown so a fresh page load
// uses the kind-appropriate layout (ai → cose; everything else → dagre).
// load() reads $("#layout").value, so this must be set BEFORE load fires.
$("#layout").value = defaultLayout(currentKind());

// Reveal the legend matching the current kind; hide the others.
for (const k of ["tickets", "dataflow", "schemas", "ai"]) {
  const el = document.getElementById(`legend-${k}`);
  if (el) el.hidden = k !== currentKind();
}

// Schemas is a CARD view, not a graph: swap the canvas for the card grid, hide
// graph-only toolbar controls (layout / reset-layout) and the graph legend, and
// retune the filter placeholder.
if (currentKind() === "schemas") {
  const cyEl = $("#cy"); if (cyEl) cyEl.style.display = "none";
  const cards = $("#schema-cards"); if (cards) cards.hidden = false;
  const lay = $("#layout");
  if (lay) { lay.hidden = true; if (lay.previousElementSibling) lay.previousElementSibling.hidden = true; }
  const reset = $("#reset-layout"); if (reset) reset.hidden = true;
  const legend = document.getElementById("legend-schemas"); if (legend) legend.hidden = true;
  const f = $("#filter"); if (f) f.placeholder = "filter tables or columns…";
}

// AI graph: surface the kind-aware search hint in the filter input
// placeholder so the behavior is discoverable without a separate UI.
if (currentKind() === "ai") {
  const f = $("#filter");
  if (f) f.placeholder = "filter by name or kind (try: hook, mcp, agent)…";
}

// Edge-mode filter only makes sense on /graphs/skills (parent/handoff/cite
// taxonomy). Show the control there, leave it hidden everywhere else.
const edgeModeLabel = document.getElementById("edge-mode-label");
if (edgeModeLabel) edgeModeLabel.hidden = true;

function applyEdgeMode() {
  if (!cy) return;
  const mode = document.getElementById("edge-mode")?.value ?? "all";
  cy.edges('[kind="connects_to"]').forEach((edge) => {
    const k = edge.data("edgeKind") ?? "handoff";
    const visible = mode === "all" || (mode === "parent" && k === "parent");
    edge.style("display", visible ? "element" : "none");
  });
  // Re-run layout so the visible-edges-only view doesn't keep stale positions.
  runLayout();
}
document.getElementById("edge-mode")?.addEventListener("change", applyEdgeMode);

// Mark the active sub-nav entry.
for (const a of document.querySelectorAll("#subnav a")) {
  a.classList.toggle("active", a.dataset.kind === currentKind());
}

// Title bar: name the current view + say what you can do here. The subtitle
// doubles as the click instruction so it's always visible, not buried in the
// collapsed legend.
const GRAPH_TITLES = {
  tickets:     ["Tickets", "depends_on · blocks · related across the .tickets board · click a node to open it"],
  dataflow:    ["Dataflow", "frontend route → container · endpoint → database · click a node to focus its lineage"],
  schemas:     ["Schemas", "every database table as a card · click a card (▸) to expand its columns · filter by table or column name"],
  ai:          ["AI ecosystem", "skills · agents · hooks · MCP · tools · click a node to focus its lineage"],
};
{
  const [name, sub] = GRAPH_TITLES[currentKind()] ?? [currentKind(), ""];
  const nameEl = document.getElementById("graph-title-name");
  const subEl = document.getElementById("graph-title-sub");
  if (nameEl) nameEl.textContent = name;
  if (subEl) subEl.textContent = sub;
}

document.title = `skua graphs · ${currentKind()}`;
load(false).catch((e) => {
  $("#info").textContent = "error: " + e.message;
});
