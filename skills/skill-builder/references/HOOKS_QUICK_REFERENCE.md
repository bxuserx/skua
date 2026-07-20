# Hooks Quick Reference

Abbreviated reference for Claude Code hooks. Full docs:
https://code.claude.com/docs/en/hooks.md.

## Where hooks live

| Location | Scope |
|---|---|
| `~/.claude/settings.json` | User — applies to every project |
| `.claude/settings.json` | Project (shared, checked into git) |
| `.claude/settings.local.json` | Project (personal, gitignored) |
| Plugin `hooks/hooks.json` | When the plugin is enabled |
| Skill / agent frontmatter `hooks:` | Active only while that skill / agent runs |

## Lifecycle events

| Group | Events |
|---|---|
| **Session** | `SessionStart`, `SessionEnd` |
| **Turn** | `UserPromptSubmit`, `Stop`, `StopFailure` |
| **Tool** | `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PermissionDenied` |
| **Async** | `FileChanged`, `ConfigChange`, `CwdChanged`, `Notification`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded` |

## Handler types

Five types — pick the one that fits the job.

### `command`

Shell command. Receives JSON on stdin (event details). Exit codes:

- `0` — success; parse JSON from stdout
- `2` — blocking error; stderr is the user-facing message
- other — non-blocking error

Fields: `command`, `args` (exec form, no shell), `async`, `asyncRewake`,
`shell` (`bash` | `powershell`).

### `http`

POST to a URL. Body is the event JSON. Allowed URLs gated by
`allowedHttpHookUrls` setting; env vars allowed in payload gated by
`httpHookAllowedEnvVars`.

### `mcp_tool`

Call a tool on an MCP server.

### `prompt`

Send the event to Claude with a yes/no question. Use for soft policy
checks ("should I block this push?").

### `agent`

Spawn a subagent to verify.

## Matcher patterns

- `"*"`, `""`, or omitted = match all
- Letters / digits / `_` / `|` = exact string or alternation list
- Other chars = JavaScript regex
- Tool events match on tool name: `Bash`, `Edit|Write`, `mcp__.*`

## Common output schema (from JSON stdout)

```json
{
  "continue": true,
  "stopReason": "Build failed",
  "suppressOutput": false,
  "systemMessage": "Warning message",
  "terminalSequence": "...",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Context for Claude",
    "permissionDecision": "allow | deny | ask | defer"
  }
}
```

## Common input fields (stdin to command hooks)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "default | plan | acceptEdits | auto | dontAsk | bypassPermissions",
  "effort": {"level": "medium"},
  "hook_event_name": "PreToolUse",
  "agent_id": "subagent-123",
  "agent_type": "security-reviewer"
}
```

## Path placeholders inside hook commands

- `${CLAUDE_PROJECT_DIR}` — project root
- `${CLAUDE_PLUGIN_ROOT}` — plugin directory
- `${CLAUDE_PLUGIN_DATA}` — plugin persistent data

## When to use a hook vs a skill

| Want | Use |
|---|---|
| Behavior runs automatically on every tool call | Hook (`PreToolUse` / `PostToolUse`) |
| Behavior runs on a user request | Skill |
| Behavior persists across sessions without re-asking | Hook |
| Behavior is conversational / multi-step | Skill |
| "Every time I save a file, lint it" | Hook |
| "When I say 'audit X', do these steps" | Skill |

Memory cannot fulfill "whenever X" requests. Only hooks can — memory is
read-only context, not executable behavior.

## Settings that affect hooks

- `disableAllHooks` — kill switch
- `allowedHttpHookUrls` — allowlist for `http` hook URLs
- `httpHookAllowedEnvVars` — env vars allowed in `http` hook payloads
- `allowManagedHooksOnly` — restrict to managed (org-level) hooks only

## Reference URL

Full hooks docs: https://code.claude.com/docs/en/hooks.md
