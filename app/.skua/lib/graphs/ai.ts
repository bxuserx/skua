// AI ecosystem graph builder — ADR-004.
//
// Stitches every Claude Code primitive (skills, agents, hooks, MCP
// servers, output styles, status line, settings, plugins, marketplaces,
// LSP servers, built-in tools) into a single Cytoscape graph with
// cross-primitive edges using a compound-node (parent) cluster pattern:
// typed `kind`, `parent` for cluster grouping, typed `EdgeKind`,
// and a `meta.warnings` array.
//
// v1 reads only declared static config — no transcript parsing, no
// runtime state. Sources walked:
//   • Skills        — ~/.claude/skills/*/SKILL.md + .claude/skills/*/SKILL.md
//   • Agents        — ~/.claude/agents/**.md + .claude/agents/**.md
//   • Slash cmds    — ~/.claude/commands/**.md + .claude/commands/**.md
//   • Hooks         — settings files + skill/agent inline hooks
//   • MCP           — ~/.claude.json + .mcp.json + plugin .mcp.json
//   • Output styles — ~/.claude/output-styles/**.md + .claude/output-styles/**.md
//   • Plugins       — ~/.claude/plugins/marketplaces/**/plugins/*
//   • Marketplaces  — ~/.claude/plugins/known_marketplaces.json
//   • Settings      — ~/.claude/settings.json, .claude/settings.json,
//                     .claude/settings.local.json
//   • Status line   — settings.json:statusLine
//   • Built-ins     — agents, output styles, hook events, tools (hardcoded)

import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseFm } from "../frontmatter.ts";

// ── Public types ─────────────────────────────────────────────────────────────

export type NodeKind =
  | "skill"
  | "agent"
  | "agent-builtin"
  | "slash-command"
  | "hook"
  | "hook-event"
  | "mcp-server"
  | "mcp-tool"
  | "mcp-prompt"
  | "mcp-resource"
  | "output-style"
  | "output-style-builtin"
  | "plugin"
  | "marketplace"
  | "settings-file"
  | "claude-md"
  | "status-line"
  | "lsp-server"
  | "tool-builtin"
  | "tool-mcp";

export type EdgeKind =
  | "gates"
  | "scopes"
  | "invokes"
  | "provides"
  | "bundles"
  | "lists"
  | "configures"
  | "references"
  | "overrides";

export interface AiNode {
  data: {
    id: string;
    label: string;
    kind: NodeKind;
    scope?: "user" | "project" | "project-local" | "plugin" | "builtin" | "managed";
    path?: string;
    description?: string;
    orphan?: boolean;
  };
}

export interface AiEdge {
  data: {
    id: string;
    source: string;
    target: string;
    kind: EdgeKind;
  };
}

export interface AiGraph {
  nodes: AiNode[];
  edges: AiEdge[];
  meta: {
    built: string;
    counts: Record<string, number>;
    warnings: { kind: string; detail: string }[];
  };
}

// ── Roots ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const PROJECT_CLAUDE = join(PROJECT_ROOT, ".claude");
const USER_HOME = homedir();
const USER_CLAUDE = join(USER_HOME, ".claude");

// ── Built-in registries (versioned by Claude Code release — keep in sync) ────

const BUILTIN_AGENTS: { name: string; description: string }[] = [
  { name: "Explore", description: "Fast read-only codebase exploration agent" },
  { name: "Plan", description: "Plan-mode research agent" },
  { name: "general-purpose", description: "Capable multi-step agent with full tool access" },
  { name: "statusline-setup", description: "Configures the user's status line" },
  { name: "claude-code-guide", description: "Answers questions about Claude Code features" },
];

const BUILTIN_OUTPUT_STYLES: { name: string; description: string }[] = [
  { name: "Default", description: "Software engineering default style" },
  { name: "Proactive", description: "Stronger autonomous-execution guidance" },
  { name: "Explanatory", description: "Educational insights between tasks" },
  { name: "Learning", description: "Collaborative learn-by-doing mode" },
];

// Lifecycle event surface as of Claude Code 2.1.x (May 2026). Hooks
// configured against any of these become `gates`/`invokes` edges.
const BUILTIN_HOOK_EVENTS: string[] = [
  "SessionStart", "Setup", "SessionEnd",
  "UserPromptSubmit", "UserPromptExpansion", "Stop", "StopFailure",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "PermissionRequest", "PermissionDenied",
  "ConfigChange", "CwdChanged", "FileChanged", "Notification",
  "MessageDisplay", "InstructionsLoaded",
  "SubagentStart", "SubagentStop", "TeammateIdle",
  "TaskCreated", "TaskCompleted",
  "WorktreeCreate", "WorktreeRemove",
  "PreCompact", "PostCompact",
  "Elicitation", "ElicitationResult",
];

// Core built-in tools Claude Code exposes to the model. Used as targets
// for hook PreToolUse matchers and agent `tools` lists.
const BUILTIN_TOOLS: string[] = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "Agent",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
  "WebFetch", "WebSearch", "NotebookEdit",
  "ScheduleWakeup", "Skill", "ToolSearch",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "AskUserQuestion", "Monitor", "PushNotification", "RemoteTrigger",
  "CronCreate", "CronList", "CronDelete",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function safeReaddir(path: string): Promise<string[]> {
  try {
    const ents = await readdir(path, { withFileTypes: true });
    return ents.filter((e) => !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return [];
  }
}

async function safeReaddirEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

async function safeStat(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ── Walkers ──────────────────────────────────────────────────────────────────

interface ParsedSkill {
  id: string;
  name: string;
  scope: "user" | "project" | "plugin";
  path: string;
  description?: string;
  allowedTools?: string[];
  connectsTo?: string[];   // Bare slugs, normalized — see parseConnectsToTarget.
  plugin?: string;
}

// Mirrors .skua/lib/graphs/skills.ts:parseConnectsToEntry. We only need
// the target slug here (the parent/handoff/cite distinction is a skills-
// graph nicety; the AI graph treats all connects_to as a `references` edge
// per ADR-004's edge taxonomy).
function parseConnectsToTarget(raw: string): string {
  const idx = raw.indexOf(":");
  if (idx === -1) return raw;
  const maybeKind = raw.slice(0, idx).trim();
  const maybeTarget = raw.slice(idx + 1).trim();
  if (["parent", "handoff", "cite"].includes(maybeKind)) return maybeTarget;
  return raw;
}

async function walkSkills(scope: "user" | "project", root: string): Promise<ParsedSkill[]> {
  const out: ParsedSkill[] = [];
  for (const slug of await safeReaddir(root)) {
    const file = join(root, slug, "SKILL.md");
    const raw = await safeReadFile(file);
    if (!raw) continue;
    const { frontmatter } = parseFm(raw);
    const fm = frontmatter as Record<string, unknown>;
    const description = typeof fm.description === "string" ? fm.description : undefined;
    const rawAllowed = (fm as Record<string, unknown>)["allowed-tools"] ?? fm.allowedTools;
    const allowedTools = Array.isArray(rawAllowed) ? rawAllowed.map(String) : undefined;
    const rawConnects = fm.connects_to;
    const connectsTo = Array.isArray(rawConnects)
      ? rawConnects.map(String).map(parseConnectsToTarget)
      : undefined;
    out.push({
      id: `skill:${scope}:${slug}`,
      name: slug,
      scope,
      path: file,
      description,
      allowedTools,
      connectsTo,
    });
  }
  return out;
}

interface ParsedAgent {
  id: string;
  name: string;
  scope: "user" | "project" | "plugin" | "builtin";
  path?: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: string[];
  plugin?: string;
}

async function walkAgents(scope: "user" | "project", root: string): Promise<ParsedAgent[]> {
  const out: ParsedAgent[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await safeReaddirEntries(dir)) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith(".md")) continue;
      const raw = await safeReadFile(full);
      if (!raw) continue;
      const { frontmatter } = parseFm(raw);
      const fm = frontmatter as Record<string, unknown>;
      const name = typeof fm.name === "string" ? fm.name : e.name.replace(/\.md$/, "");
      const description = typeof fm.description === "string" ? fm.description : undefined;
      const tools = Array.isArray(fm.tools) ? fm.tools.map(String) : undefined;
      const disallowedTools = Array.isArray(fm.disallowedTools) ? fm.disallowedTools.map(String) : undefined;
      const skills = Array.isArray(fm.skills) ? fm.skills.map(String) : undefined;
      const mcpServers = Array.isArray(fm.mcpServers) ? fm.mcpServers.map(String) : undefined;
      out.push({
        id: `agent:${scope}:${name}`,
        name, scope, path: full,
        description, tools, disallowedTools, skills, mcpServers,
      });
    }
  };
  await walk(root);
  return out;
}

interface ParsedCommand {
  id: string;
  name: string;
  scope: "user" | "project" | "plugin";
  path: string;
  description?: string;
}

async function walkCommands(scope: "user" | "project", root: string): Promise<ParsedCommand[]> {
  const out: ParsedCommand[] = [];
  for (const e of await safeReaddirEntries(root)) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const full = join(root, e.name);
    const raw = await safeReadFile(full);
    if (!raw) continue;
    const { frontmatter } = parseFm(raw);
    const fm = frontmatter as Record<string, unknown>;
    const name = e.name.replace(/\.md$/, "");
    const description = typeof fm.description === "string" ? fm.description : undefined;
    out.push({ id: `cmd:${scope}:${name}`, name, scope, path: full, description });
  }
  return out;
}

interface ParsedOutputStyle {
  id: string;
  name: string;
  scope: "user" | "project" | "plugin" | "builtin";
  path?: string;
  description?: string;
  forceForPlugin?: boolean;
}

async function walkOutputStyles(scope: "user" | "project", root: string): Promise<ParsedOutputStyle[]> {
  const out: ParsedOutputStyle[] = [];
  for (const e of await safeReaddirEntries(root)) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const full = join(root, e.name);
    const raw = await safeReadFile(full);
    if (!raw) continue;
    const { frontmatter } = parseFm(raw);
    const fm = frontmatter as Record<string, unknown>;
    const name = typeof fm.name === "string" ? fm.name : e.name.replace(/\.md$/, "");
    const description = typeof fm.description === "string" ? fm.description : undefined;
    const forceForPlugin = fm["force-for-plugin"] === true;
    out.push({ id: `style:${scope}:${name}`, name, scope, path: full, description, forceForPlugin });
  }
  return out;
}

interface ParsedSettings {
  id: string;
  scope: "user" | "project" | "project-local";
  path: string;
  data: Record<string, unknown>;
}

async function readSettings(scope: ParsedSettings["scope"], path: string): Promise<ParsedSettings | null> {
  const raw = await safeReadFile(path);
  if (!raw) return null;
  const data = safeJsonParse<Record<string, unknown>>(raw);
  if (!data) return null;
  return { id: `settings:${scope}`, scope, path, data };
}

interface ParsedHook {
  id: string;
  event: string;
  matcher?: string;
  type: string;
  command?: string;
  url?: string;
  server?: string;
  tool?: string;
  ifFilter?: string;
  ownerId: string;       // settings-file id, plugin id, skill/agent id
  ownerLabel: string;
}

function extractHooks(ownerId: string, ownerLabel: string, hooksBlock: unknown): ParsedHook[] {
  if (!hooksBlock || typeof hooksBlock !== "object") return [];
  const out: ParsedHook[] = [];
  let idx = 0;
  const events = hooksBlock as Record<string, unknown>;
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const matcher = typeof e.matcher === "string" ? e.matcher : undefined;
      const handlers = Array.isArray(e.hooks) ? e.hooks : [];
      for (const h of handlers) {
        if (!h || typeof h !== "object") continue;
        const hh = h as Record<string, unknown>;
        const type = typeof hh.type === "string" ? hh.type : "command";
        const command = typeof hh.command === "string" ? hh.command : undefined;
        const url = typeof hh.url === "string" ? hh.url : undefined;
        const server = typeof hh.server === "string" ? hh.server : undefined;
        const tool = typeof hh.tool === "string" ? hh.tool : undefined;
        const ifFilter = typeof hh.if === "string" ? hh.if : undefined;
        out.push({
          id: `hook:${ownerId}:${event}:${idx++}`,
          event, matcher, type, command, url, server, tool, ifFilter,
          ownerId, ownerLabel,
        });
      }
    }
  }
  return out;
}

interface ParsedMcpServer {
  id: string;
  name: string;
  scope: "user" | "project" | "plugin" | "claudeai";
  transport: string;
  command?: string;
  url?: string;
  ownerId: string;
}

function extractMcpServers(ownerId: string, scope: ParsedMcpServer["scope"], mcpBlock: unknown): ParsedMcpServer[] {
  if (!mcpBlock || typeof mcpBlock !== "object") return [];
  const out: ParsedMcpServer[] = [];
  const servers = mcpBlock as Record<string, unknown>;
  for (const [name, def] of Object.entries(servers)) {
    if (!def || typeof def !== "object") continue;
    const d = def as Record<string, unknown>;
    const transport = typeof d.type === "string" ? d.type : (typeof d.url === "string" ? "http" : "stdio");
    const command = typeof d.command === "string" ? d.command : undefined;
    const url = typeof d.url === "string" ? d.url : undefined;
    out.push({
      id: `mcp:${scope}:${name}`,
      name, scope, transport, command, url, ownerId,
    });
  }
  return out;
}

interface ParsedPlugin {
  id: string;
  name: string;
  marketplace: string;
  root: string;
}

interface ParsedMarketplace {
  id: string;
  name: string;
  source?: string;
  installLocation: string;
}

async function walkPluginsAndMarketplaces(): Promise<{ marketplaces: ParsedMarketplace[]; plugins: ParsedPlugin[] }> {
  const marketplaces: ParsedMarketplace[] = [];
  const plugins: ParsedPlugin[] = [];
  const knownPath = join(USER_CLAUDE, "plugins", "known_marketplaces.json");
  const known = safeJsonParse<Record<string, { source?: { repo?: string }; installLocation: string }>>(
    await safeReadFile(knownPath),
  );
  if (!known) return { marketplaces, plugins };
  for (const [name, def] of Object.entries(known)) {
    const installLocation = def.installLocation;
    marketplaces.push({
      id: `marketplace:${name}`, name,
      source: def.source?.repo, installLocation,
    });
    // Each marketplace has a `plugins/` subdir holding plugin directories.
    const pluginsDir = join(installLocation, "plugins");
    for (const slug of await safeReaddir(pluginsDir)) {
      const root = join(pluginsDir, slug);
      const isDir = (await safeStat(root)) && (await safeStat(join(root, "plugin.json")) || await safeStat(join(root, "skills")) || await safeStat(join(root, "agents")));
      if (!isDir) continue;
      plugins.push({
        id: `plugin:${name}:${slug}`,
        name: slug,
        marketplace: `marketplace:${name}`,
        root,
      });
    }
  }
  return { marketplaces, plugins };
}

// ── Edge helpers ─────────────────────────────────────────────────────────────

function edgeId(idx: { n: number }, prefix = "e"): string {
  return `${prefix}${idx.n++}`;
}

// ── Public builder ───────────────────────────────────────────────────────────

export async function buildAiGraph(): Promise<AiGraph> {
  const nodes: AiNode[] = [];
  const edges: AiEdge[] = [];
  const warnings: { kind: string; detail: string }[] = [];
  const nodeIds = new Set<string>();
  const edgeIdx = { n: 0 };

  const addNode = (n: AiNode): void => {
    if (nodeIds.has(n.data.id)) return;
    nodeIds.add(n.data.id);
    nodes.push(n);
  };
  const addEdge = (source: string, target: string, kind: EdgeKind): void => {
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      warnings.push({ kind: "broken-edge", detail: `${kind}: ${source} → ${target}` });
      return;
    }
    edges.push({ data: { id: edgeId(edgeIdx), source, target, kind } });
  };

  // Flat node set — no compound `parent` grouping. Color and shape per
  // `kind` are enough to read the primitive type; the explicit cluster
  // boxes added visual noise and collapsed dagre's sibling layouts.

  // ── Skills ─────────────────────────────────────────────────────────────
  const skills: ParsedSkill[] = [
    ...await walkSkills("user", join(USER_CLAUDE, "skills")),
    ...await walkSkills("project", join(PROJECT_CLAUDE, "skills")),
  ];
  for (const s of skills) {
    addNode({
      data: {
        id: s.id, label: s.name, kind: "skill",
        scope: s.scope, path: s.path,
        description: truncate(s.description, 400),
      },
    });
  }

  // ── Agents (built-in + user + project) ─────────────────────────────────
  for (const a of BUILTIN_AGENTS) {
    const id = `agent:builtin:${a.name}`;
    addNode({
      data: { id, label: a.name, kind: "agent-builtin",
              scope: "builtin",
              description: a.description },
    });
  }
  const agents: ParsedAgent[] = [
    ...await walkAgents("user", join(USER_CLAUDE, "agents")),
    ...await walkAgents("project", join(PROJECT_CLAUDE, "agents")),
  ];
  for (const a of agents) {
    addNode({
      data: { id: a.id, label: a.name, kind: "agent",
              scope: a.scope, path: a.path,
              description: truncate(a.description, 400) },
    });
  }

  // ── Slash commands (legacy commands/ dir) ──────────────────────────────
  const commands: ParsedCommand[] = [
    ...await walkCommands("user", join(USER_CLAUDE, "commands")),
    ...await walkCommands("project", join(PROJECT_CLAUDE, "commands")),
  ];
  for (const c of commands) {
    addNode({
      data: { id: c.id, label: c.name, kind: "slash-command",
              scope: c.scope, path: c.path,
              description: truncate(c.description, 400) },
    });
  }

  // ── Output styles (built-in + user + project) ──────────────────────────
  for (const s of BUILTIN_OUTPUT_STYLES) {
    addNode({
      data: { id: `style:builtin:${s.name}`, label: s.name,
              kind: "output-style-builtin", 
              scope: "builtin", description: s.description },
    });
  }
  const styles: ParsedOutputStyle[] = [
    ...await walkOutputStyles("user", join(USER_CLAUDE, "output-styles")),
    ...await walkOutputStyles("project", join(PROJECT_CLAUDE, "output-styles")),
  ];
  for (const s of styles) {
    addNode({
      data: { id: s.id, label: s.name, kind: "output-style",
              scope: s.scope, path: s.path,
              description: truncate(s.description, 400) },
    });
  }

  // ── Hook event nodes (built-in registry) ───────────────────────────────
  for (const ev of BUILTIN_HOOK_EVENTS) {
    addNode({
      data: { id: `event:${ev}`, label: ev, kind: "hook-event",
              scope: "builtin" },
    });
  }

  // ── Built-in tool nodes ────────────────────────────────────────────────
  for (const t of BUILTIN_TOOLS) {
    addNode({
      data: { id: `tool:builtin:${t}`, label: t, kind: "tool-builtin",
              scope: "builtin" },
    });
  }

  // ── Settings files + hooks they configure ──────────────────────────────
  const settingsCandidates: ParsedSettings[] = [];
  const userSettings = await readSettings("user", join(USER_CLAUDE, "settings.json"));
  if (userSettings) settingsCandidates.push(userSettings);
  const projSettings = await readSettings("project", join(PROJECT_CLAUDE, "settings.json"));
  if (projSettings) settingsCandidates.push(projSettings);
  const projLocalSettings = await readSettings("project-local", join(PROJECT_CLAUDE, "settings.local.json"));
  if (projLocalSettings) settingsCandidates.push(projLocalSettings);

  for (const s of settingsCandidates) {
    addNode({
      data: { id: s.id, label: relative(PROJECT_ROOT, s.path) || s.path,
              kind: "settings-file", 
              scope: s.scope, path: s.path },
    });
  }

  // Status line nodes — each settings file with a statusLine command gets one.
  for (const s of settingsCandidates) {
    const sl = s.data.statusLine as Record<string, unknown> | undefined;
    if (!sl || typeof sl !== "object") continue;
    const cmd = typeof sl.command === "string" ? sl.command : "";
    if (!cmd) continue;
    const id = `status:${s.scope}`;
    addNode({
      data: { id, label: "status-line", kind: "status-line",
              scope: s.scope,
              description: truncate(cmd, 200) },
    });
    addEdge(s.id, id, "configures");
  }

  // Output-style setting → output-style node (containment override).
  for (const s of settingsCandidates) {
    const styleName = typeof s.data.outputStyle === "string" ? s.data.outputStyle : undefined;
    if (!styleName) continue;
    const target =
      [...nodeIds].find((id) => id === `style:user:${styleName}` || id === `style:project:${styleName}` || id === `style:builtin:${styleName}`)
      ?? null;
    if (target) addEdge(s.id, target, "configures");
    else warnings.push({ kind: "missing-output-style", detail: `${s.scope} settings → ${styleName}` });
  }

  // Settings precedence chain (user → project → project-local: each
  // higher-precedence file `overrides` the next).
  const precedence: ParsedSettings["scope"][] = ["user", "project", "project-local"];
  for (let i = 0; i < precedence.length - 1; i++) {
    const lower = settingsCandidates.find((s) => s.scope === precedence[i]);
    const higher = settingsCandidates.find((s) => s.scope === precedence[i + 1]);
    if (lower && higher) addEdge(higher.id, lower.id, "overrides");
  }

  // ── Hooks (from settings) ──────────────────────────────────────────────
  const allHooks: ParsedHook[] = [];
  for (const s of settingsCandidates) {
    const hooks = extractHooks(s.id, `${s.scope} settings`, s.data.hooks);
    allHooks.push(...hooks);
  }
  for (const h of allHooks) {
    addNode({
      data: { id: h.id, label: `${h.event}${h.matcher ? `(${h.matcher})` : ""}`,
              kind: "hook", 
              description: truncate(`${h.type}: ${h.command ?? h.url ?? h.server ?? ""}`, 200) },
    });
    // hook → event (containment-ish; resolver in TKT-235 adds gates/invokes).
    const eventId = `event:${h.event}`;
    if (nodeIds.has(eventId)) addEdge(h.id, eventId, "references");
    // settings configures hook.
    addEdge(h.ownerId, h.id, "configures");
  }

  // ── MCP servers ────────────────────────────────────────────────────────
  const allMcp: ParsedMcpServer[] = [];

  // Project-level .mcp.json
  const projMcp = safeJsonParse<{ mcpServers?: unknown }>(await safeReadFile(join(PROJECT_ROOT, ".mcp.json")));
  if (projMcp?.mcpServers) {
    allMcp.push(...extractMcpServers("settings:project", "project", projMcp.mcpServers));
  }

  // User-level ~/.claude.json (project-keyed)
  const userClaudeJson = safeJsonParse<{ projects?: Record<string, { mcpServers?: unknown }>; mcpServers?: unknown }>(
    await safeReadFile(join(USER_HOME, ".claude.json")),
  );
  if (userClaudeJson?.mcpServers) {
    allMcp.push(...extractMcpServers("settings:user", "user", userClaudeJson.mcpServers));
  }
  if (userClaudeJson?.projects) {
    const projEntry = userClaudeJson.projects[PROJECT_ROOT];
    if (projEntry?.mcpServers) {
      allMcp.push(...extractMcpServers("settings:user", "user", projEntry.mcpServers));
    }
  }

  // Scope-precedence detection (ADR-004 DRAFT-4 / CCO-inspired). When the
  // same MCP server name appears at multiple scopes, the higher-precedence
  // entry wins; the others are tagged SHADOWED so the UI can dim them.
  // Precedence (high → low): claudeai > plugin > project > user.
  const MCP_PRECEDENCE: Record<string, number> = {
    "claudeai": 4, "plugin": 3, "project": 2, "user": 1,
  };
  const mcpByName = new Map<string, ParsedMcpServer[]>();
  for (const m of allMcp) {
    const arr = mcpByName.get(m.name) ?? [];
    arr.push(m);
    mcpByName.set(m.name, arr);
  }
  const mcpPrecedence = new Map<string, "GLOBAL" | "WINNING" | "SHADOWED" | "CONFLICT">();
  for (const [name, group] of mcpByName) {
    if (group.length === 1) {
      mcpPrecedence.set(group[0].id, group[0].scope === "user" ? "GLOBAL" : "WINNING");
      continue;
    }
    let topScore = -Infinity;
    for (const m of group) topScore = Math.max(topScore, MCP_PRECEDENCE[m.scope] ?? 0);
    let winners = 0;
    for (const m of group) if ((MCP_PRECEDENCE[m.scope] ?? 0) === topScore) winners++;
    for (const m of group) {
      const score = MCP_PRECEDENCE[m.scope] ?? 0;
      if (score < topScore) {
        mcpPrecedence.set(m.id, "SHADOWED");
        warnings.push({ kind: "shadowed-mcp", detail: `${m.scope}:${name} shadowed by higher-precedence scope` });
      } else if (winners > 1) {
        mcpPrecedence.set(m.id, "CONFLICT");
        warnings.push({ kind: "conflict-mcp", detail: `${name} defined at multiple equal-precedence scopes` });
      } else {
        mcpPrecedence.set(m.id, "WINNING");
      }
    }
  }

  for (const m of allMcp) {
    const badge = mcpPrecedence.get(m.id);
    const descParts = [`${m.transport}: ${m.url ?? m.command ?? ""}`];
    if (badge && badge !== "WINNING") descParts.unshift(`[${badge}]`);
    addNode({
      data: { id: m.id, label: badge && badge !== "WINNING" ? `${m.name} (${badge})` : m.name,
              kind: "mcp-server", scope: m.scope,
              description: truncate(descParts.join(" "), 200),
              ...(badge ? { precedence: badge } : {}) } as AiNode["data"] & { precedence?: string },
    });
    if (nodeIds.has(m.ownerId)) addEdge(m.ownerId, m.id, "configures");
  }

  // ── Plugins + marketplaces ─────────────────────────────────────────────
  const { marketplaces, plugins } = await walkPluginsAndMarketplaces();
  for (const m of marketplaces) {
    addNode({
      data: { id: m.id, label: m.name, kind: "marketplace",
              scope: "user",
              description: truncate(m.source, 200) },
    });
  }
  for (const p of plugins) {
    addNode({
      data: { id: p.id, label: p.name, kind: "plugin",
              scope: "plugin", path: p.root },
    });
    if (nodeIds.has(p.marketplace)) addEdge(p.marketplace, p.id, "lists");

    // Plugin-bundled skills.
    for (const slug of await safeReaddir(join(p.root, "skills"))) {
      const skillFile = join(p.root, "skills", slug, "SKILL.md");
      if (!(await safeStat(skillFile))) continue;
      const id = `skill:plugin:${p.name}:${slug}`;
      const raw = await safeReadFile(skillFile);
      const description = raw ? (parseFm(raw).frontmatter as Record<string, unknown>).description : undefined;
      addNode({
        data: { id, label: slug, kind: "skill",
                scope: "plugin", path: skillFile,
                description: truncate(typeof description === "string" ? description : undefined, 400) },
      });
      addEdge(p.id, id, "bundles");
    }

    // Plugin-bundled agents.
    for (const e of await safeReaddirEntries(join(p.root, "agents"))) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const full = join(p.root, "agents", e.name);
      const raw = await safeReadFile(full);
      if (!raw) continue;
      const fm = parseFm(raw).frontmatter as Record<string, unknown>;
      const name = typeof fm.name === "string" ? fm.name : e.name.replace(/\.md$/, "");
      const id = `agent:plugin:${p.name}:${name}`;
      addNode({
        data: { id, label: name, kind: "agent",
                scope: "plugin", path: full,
                description: truncate(typeof fm.description === "string" ? fm.description : undefined, 400) },
      });
      addEdge(p.id, id, "bundles");
    }

    // Plugin-bundled commands (legacy commands/ dir).
    for (const e of await safeReaddirEntries(join(p.root, "commands"))) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const name = e.name.replace(/\.md$/, "");
      const id = `cmd:plugin:${p.name}:${name}`;
      addNode({
        data: { id, label: name, kind: "slash-command",
                scope: "plugin",
                path: join(p.root, "commands", e.name) },
      });
      addEdge(p.id, id, "bundles");
    }

    // Plugin-bundled output styles.
    for (const e of await safeReaddirEntries(join(p.root, "output-styles"))) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const full = join(p.root, "output-styles", e.name);
      const raw = await safeReadFile(full);
      if (!raw) continue;
      const fm = parseFm(raw).frontmatter as Record<string, unknown>;
      const name = typeof fm.name === "string" ? fm.name : e.name.replace(/\.md$/, "");
      const id = `style:plugin:${p.name}:${name}`;
      addNode({
        data: { id, label: name, kind: "output-style",
                scope: "plugin", path: full,
                description: truncate(typeof fm.description === "string" ? fm.description : undefined, 400) },
      });
      addEdge(p.id, id, "bundles");
    }

    // Plugin-bundled hooks from hooks/hooks.json.
    const pluginHooksRaw = await safeReadFile(join(p.root, "hooks", "hooks.json"));
    const pluginHooksJson = safeJsonParse<{ hooks?: unknown }>(pluginHooksRaw);
    if (pluginHooksJson?.hooks) {
      const hs = extractHooks(p.id, p.name, pluginHooksJson.hooks);
      for (const h of hs) {
        addNode({
          data: { id: h.id, label: `${h.event}${h.matcher ? `(${h.matcher})` : ""}`,
                  kind: "hook", scope: "plugin",
                  description: truncate(`${h.type}: ${h.command ?? h.url ?? h.server ?? ""}`, 200) },
        });
        addEdge(p.id, h.id, "bundles");
        const eventId = `event:${h.event}`;
        if (nodeIds.has(eventId)) addEdge(h.id, eventId, "references");
        allHooks.push(h);   // Allow the matcher resolver below to walk plugin hooks too.
      }
    }

    // Plugin-bundled LSP servers from .lsp.json.
    const pluginLspRaw = await safeReadFile(join(p.root, ".lsp.json"));
    const pluginLsp = safeJsonParse<Record<string, unknown>>(pluginLspRaw);
    if (pluginLsp) {
      for (const [lang, cfg] of Object.entries(pluginLsp)) {
        if (!cfg || typeof cfg !== "object") continue;
        const id = `lsp:${p.name}:${lang}`;
        addNode({
          data: { id, label: lang, kind: "lsp-server",
                  scope: "plugin",
                  description: truncate(JSON.stringify(cfg), 200) },
        });
        addEdge(p.id, id, "bundles");
      }
    }

    // Plugin-bundled MCP from .mcp.json or plugin.json (best-effort).
    const pluginMcpRaw = (await safeReadFile(join(p.root, ".mcp.json")))
      ?? (await safeReadFile(join(p.root, "plugin.json")));
    const pluginMcp = safeJsonParse<{ mcpServers?: unknown }>(pluginMcpRaw);
    if (pluginMcp?.mcpServers) {
      const ms = extractMcpServers(p.id, "plugin", pluginMcp.mcpServers);
      for (const m of ms) {
        // Use a plugin-scoped id to avoid collisions with user/project MCP.
        const id = `mcp:plugin:${p.name}:${m.name}`;
        addNode({
          data: { id, label: m.name, kind: "mcp-server",
                  scope: "plugin",
                  description: truncate(`${m.transport}: ${m.url ?? m.command ?? ""}`, 200) },
        });
        addEdge(p.id, id, "bundles");
        allMcp.push({ ...m, id, ownerId: p.id });
      }
    }
  }

  // ── CLAUDE.md notes (user + project) ───────────────────────────────────
  for (const [scope, root] of [["user", USER_CLAUDE], ["project", PROJECT_ROOT]] as const) {
    const claudeMd = join(root, "CLAUDE.md");
    if (await safeStat(claudeMd)) {
      const id = `claudemd:${scope}`;
      addNode({
        data: { id, label: `CLAUDE.md (${scope})`, kind: "claude-md",
                scope, path: claudeMd },
      });
    }
  }

  // ── Cross-primitive edge resolution (ADR-004 DRAFT-2) ──────────────────
  //
  // After all nodes are placed we resolve the matcher → target edges:
  //   hook PreToolUse/PostToolUse matcher → tool node     (gates)
  //   hook matcher mcp__server__tool       → mcp-server   (gates)
  //   hook matcher SubagentStart/Stop      → agent node   (invokes)
  //   hook type=mcp_tool                   → mcp-server   (invokes)
  //   hook type=agent                      → agent node   (invokes)
  //   agent tools[] / disallowedTools[]    → tool node    (scopes)
  //   agent skills[]                       → skill node   (invokes)
  //   agent mcpServers[]                   → mcp-server   (invokes)
  //
  // Matchers may be regex/glob (Bash|Edit) — split on `|` and resolve each.
  // Unresolved targets become `broken-*` warnings rather than silent drops.

  const findToolNode = (name: string): string | null => {
    const id = `tool:builtin:${name}`;
    if (nodeIds.has(id)) return id;
    return null;
  };
  const findMcpServerByName = (name: string): string | null => {
    for (const candidate of [
      `mcp:user:${name}`, `mcp:project:${name}`, `mcp:claudeai:${name}`,
    ]) if (nodeIds.has(candidate)) return candidate;
    for (const id of nodeIds) {
      if (id.startsWith(`mcp:plugin:`) && id.endsWith(`:${name}`)) return id;
    }
    return null;
  };
  const findAgentByName = (name: string): string | null => {
    for (const candidate of [
      `agent:builtin:${name}`, `agent:user:${name}`, `agent:project:${name}`,
    ]) if (nodeIds.has(candidate)) return candidate;
    return null;
  };
  const findSkillBySlug = (slug: string): string | null => {
    for (const candidate of [
      `skill:user:${slug}`, `skill:project:${slug}`,
    ]) if (nodeIds.has(candidate)) return candidate;
    return null;
  };

  const TOOL_MATCH_EVENTS = new Set([
    "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "PermissionDenied",
  ]);
  const AGENT_MATCH_EVENTS = new Set(["SubagentStart", "SubagentStop"]);

  for (const h of allHooks) {
    // hook type wiring (independent of matcher).
    if (h.type === "mcp_tool" && h.server) {
      const tgt = findMcpServerByName(h.server);
      if (tgt) addEdge(h.id, tgt, "invokes");
      else warnings.push({ kind: "broken-hook-mcp", detail: `${h.id} → server ${h.server}` });
    }
    if (h.type === "agent") {
      // Hook's `agent` payload usually carries an agent name in `prompt`
      // metadata; v1 can't infer reliably, so we leave this unresolved.
    }

    // Matcher-driven wiring.
    if (!h.matcher) continue;
    const tokens = h.matcher.split("|").map((s) => s.trim()).filter(Boolean);

    if (TOOL_MATCH_EVENTS.has(h.event)) {
      for (const tok of tokens) {
        // MCP tool form: mcp__server__tool (we resolve to the server).
        const mcpMatch = tok.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
        if (mcpMatch) {
          const serverName = mcpMatch[1];
          const tgt = findMcpServerByName(serverName);
          if (tgt) addEdge(h.id, tgt, "gates");
          else warnings.push({ kind: "broken-hook-mcp-matcher", detail: `${h.id} matcher ${tok}` });
          continue;
        }
        // Plain built-in tool.
        const tgt = findToolNode(tok);
        if (tgt) addEdge(h.id, tgt, "gates");
        else if (/^[A-Z][A-Za-z]+$/.test(tok)) {
          warnings.push({ kind: "broken-hook-tool", detail: `${h.id} matcher ${tok}` });
        }
        // Otherwise treat as regex/wildcard — skip silently.
      }
    } else if (AGENT_MATCH_EVENTS.has(h.event)) {
      for (const tok of tokens) {
        const tgt = findAgentByName(tok);
        if (tgt) addEdge(h.id, tgt, "invokes");
        else warnings.push({ kind: "broken-hook-agent", detail: `${h.id} matcher ${tok}` });
      }
    }
  }

  // Agent → tool / skill / mcp-server edges from frontmatter.
  for (const a of agents) {
    const allTools = [...(a.tools ?? []), ...(a.disallowedTools ?? [])];
    for (const t of allTools) {
      const tgt = findToolNode(t);
      if (tgt) addEdge(a.id, tgt, "scopes");
      else warnings.push({ kind: "broken-agent-tool", detail: `${a.id} → ${t}` });
    }
    for (const slug of a.skills ?? []) {
      const tgt = findSkillBySlug(slug);
      if (tgt) addEdge(a.id, tgt, "invokes");
      else warnings.push({ kind: "broken-agent-skill", detail: `${a.id} → ${slug}` });
    }
    for (const s of a.mcpServers ?? []) {
      const tgt = findMcpServerByName(s);
      if (tgt) addEdge(a.id, tgt, "invokes");
      else warnings.push({ kind: "broken-agent-mcp", detail: `${a.id} → ${s}` });
    }
  }

  // Skill → tool edges from `allowed-tools` frontmatter.
  for (const s of skills) {
    for (const t of s.allowedTools ?? []) {
      const tgt = findToolNode(t);
      if (tgt) addEdge(s.id, tgt, "scopes");
    }
  }

  // Skill → skill edges from `connects_to` frontmatter (the same source
  // the dedicated /graphs/skills view uses). Drawn as `references` per
  // ADR-004's edge taxonomy. This is the dominant edge population on a
  // sparse user portfolio — without it the graph reads as disconnected.
  for (const s of skills) {
    for (const target of s.connectsTo ?? []) {
      const tgt = findSkillBySlug(target);
      if (tgt) addEdge(s.id, tgt, "references");
      else warnings.push({ kind: "broken-skill-connects-to", detail: `${s.id} → ${target}` });
    }
  }

  // ── Orphan detection (nodes with no edges) ─────────────────────────────
  const touched = new Set<string>();
  for (const e of edges) { touched.add(e.data.source); touched.add(e.data.target); }
  for (const n of nodes) {
    if (!touched.has(n.data.id)) n.data.orphan = true;
  }

  // ── Counts ─────────────────────────────────────────────────────────────
  const counts: Record<string, number> = {
    skills: skills.length,
    agents: agents.length + BUILTIN_AGENTS.length,
    commands: commands.length,
    hooks: allHooks.length,
    mcp: allMcp.length,
    outputStyles: styles.length + BUILTIN_OUTPUT_STYLES.length,
    plugins: plugins.length,
    marketplaces: marketplaces.length,
    settingsFiles: settingsCandidates.length,
    tools: BUILTIN_TOOLS.length,
    edges: edges.length,
    orphans: nodes.filter((n) => n.data.orphan).length,
  };

  return {
    nodes,
    edges,
    meta: { built: new Date().toISOString(), counts, warnings },
  };
}

// ── Cache-freshness source set (single source of truth for what an edit
// has to touch in order to bust the AI-graph cache). TKT-240 — exported
// so future tickets / docs can cite it; the builder's walkers above
// read roughly the same set imperatively (different walker per primitive
// kind, so a flat iteration here doesn't replace the builder logic).
export const AI_SOURCE_DIRS: readonly string[] = [
  USER_CLAUDE,                          // entire ~/.claude/ tree (skills, agents,
                                        // commands, output-styles, plugins, …)
  PROJECT_CLAUDE,                       // entire project .claude/ tree
];
export const AI_SOURCE_FILES: readonly string[] = [
  join(USER_HOME, ".claude.json"),      // user MCP scope
  join(PROJECT_ROOT, ".mcp.json"),      // project MCP scope
  join(USER_CLAUDE, "settings.json"),
  join(PROJECT_CLAUDE, "settings.json"),
  join(PROJECT_CLAUDE, "settings.local.json"),
  join(PROJECT_ROOT, "CLAUDE.md"),
  join(USER_CLAUDE, "CLAUDE.md"),
];

// Dirs the recursive walk should refuse to descend into. Matches
// server.ts:IGNORE_DIRS so the two walkers stay coherent.
const AI_IGNORE_DIRS = new Set([
  "node_modules", "__pycache__", ".next", ".git",
  ".venv", "venv", "dist", "build",
]);

// Source-file mtime aggregator (for cache freshness check in server.ts).
// TKT-239 — recursive walk over the entire AI_SOURCE_DIRS, not the
// previous one-level-deep version that missed plugin marketplaces nested
// under ~/.claude/plugins/marketplaces/<mp>/plugins/<plugin>/.
export async function aiSourceMtimes(): Promise<number> {
  let newest = 0;
  const probe = async (p: string): Promise<void> => {
    try { const s = await stat(p); if (s.mtimeMs > newest) newest = s.mtimeMs; } catch { /* skip */ }
  };
  const walk = async (root: string): Promise<void> => {
    for (const e of await safeReaddirEntries(root)) {
      if (AI_IGNORE_DIRS.has(e.name)) continue;
      const full = join(root, e.name);
      if (e.isDirectory()) await walk(full);
      else await probe(full);
    }
  };
  await Promise.all(AI_SOURCE_FILES.map(probe));
  for (const root of AI_SOURCE_DIRS) await walk(root);
  return newest;
}
