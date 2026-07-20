---
name: skua-terminal
description: "Knowledge + debugging playbook for the skua dashboard's in-browser terminal — the xterm.js (DOM renderer) → ttyd → zellij → shell stack under `.skua/`. Encodes the layer-localization diagnostic (the Playwright buffer-probe that reads xterm's buffer and compares it to ground truth, plus bypass-the-persistence-layer and renderer-swap), and the history of why the stack is what it is: tmux was removed because its client re-emit drops scroll/line-delete updates (proven byte-level on a stock config — config cannot fix it); dtach rendered perfectly but has no server-side scrollback (reload needed a client-side restore hack); zellij's re-emit passed the same probes with zero grid diffs AND natively replays the screen on reattach, so it became the default (2026-07-17). Produces a diagnosis plus the specific change to apply."
when_to_use: "Vim or a TUI renders wrong in the skua browser terminal — garbled/doubled/stale glyphs, a ghost line after a delete, blank/missing bands after scrolling, misaligned or wrong-wrapping text (especially after resize or tab-switch), missing colors, or a session stuck at 80×24. Also: 'how does the skua terminal stack work', 'why does the browser terminal look different from iTerm', 'debug ttyd/zellij/xterm rendering', 'should we bring back tmux or dtach'."
connects_to: []
kind: specialized
---

# Skua Terminal

Debugging playbook + model for the skua dashboard's in-browser terminal: the
`xterm.js (DOM renderer) → ttyd → zellij → shell` stack under `.skua/`. Diagnose
"vim/TUI renders wrong" reports by **localizing the layer with ground truth**
(read xterm's actual buffer and diff it against what the app emitted) instead of
guessing — the failure mode that made these bugs recur.

## The load-bearing history (read this before "fixing" rendering)

**tmux era (→ July 2026):** the ghost-line-after-delete, blank bands after
scroll, and resize corruption were one bug — tmux's client re-emit. tmux parses
the app's output into its own grid and re-emits to the client, and that re-emit
**drops scroll/line-delete updates and discards output under fast scrolling**.
First blamed on config (the outer TERM was misconfigured twice: `tmux-256color`,
then a custom `xterm-256color-skua` terminfo with scroll caps cancelled), but a
**clean-config retest (2026-07-17, tmux 3.7a, stock xterm-256color outer /
tmux-256color inner)** reproduced it at the byte level: after `dd`, tmux emitted
only vim's cell repaints — no scroll, no delete-line — while its own
`capture-pane` grid showed the delete applied; under 6× Ctrl-D it sent 3.9 KB
where dtach sent 12.4 KB (38 blank xterm rows). **The drop is tmux-intrinsic. No
TERM/terminfo/option fixes it. Do NOT reintroduce tmux**, and do NOT re-add the
scaffolding that papered over it (custom terminfo, `applySessionOptions`,
`refreshSession`/resync routes, the xterm CanvasAddon — whose texture-atlas
staleness was a second, independent ghost source).

**dtach era (July 2026):** dtach is a byte-passthrough — no re-emit, so
rendering was perfect. But it keeps no server-side scrollback, so a hard reload
came back blank and needed a client-side sessionStorage grid-serialize/restore
hack with real caveats (background tabs at 80×24, padding-gap edge cases). That
implementation is preserved on branch `terminal-dtach` (including its skill
write-up) if a passthrough fallback is ever needed.

**zellij (default since 2026-07-17):** the same buffer-probe on zellij 0.44.3
passed all four tests with **zero grid diffs** — no ghost line, no blank bands,
resize consistent — because zellij re-emits full-line repaints (chatty but
correct; ~64 KB where dtach sent 12 KB, irrelevant over localhost). And it
natively replays the visible screen on reattach + keeps scrollback server-side,
which deleted the entire client-side restore hack. Probe harnesses live in
`scripts/buffer-probe.mjs` (tmux/dtach, capture-pane ground truth; edit its
hardcoded ports before reuse) and `scripts/buffer-probe-zellij.mjs`
(`dump-screen` ground truth; args: `<ttydPort> <sessionName> <dashboardPort>
<socketDir> <configDir>` — dump-screen only answers while a client is attached,
which the probe's own page provides).

## The stack now

```
browser xterm.js (FitAddon only → built-in DOM renderer)   ← renders glyphs
   ⇅ WebSocket (ttyd "tty" protocol: 0x30 output / 0x31 resize)
ttyd  (-W, -T xterm-256color, localhost)                   ← PTY host
   ⇅ pty
zellij attach (private ZELLIJ_SOCKET_DIR, bare-pane layout) ← grid + persistence
   ⇅ pty
shell → vim
```

- zellij IS a re-emitter (like tmux) — but its client-update path is proven
  correct by the buffer-probe. TERM is `xterm-256color` on both sides (zellij
  ships no terminfo; panes inherit it from the creating env).
- Isolation: every zellij call runs with `ZELLIJ_SOCKET_DIR=
  .skua/cache/terminals/zellij` and `ZELLIJ_CONFIG_DIR=.skua/lib/zellij`, so
  skua's sessions/config never touch a personal zellij. The bare-pane layout
  (`lib/zellij/layouts/skua.kdl`, wired by `default_layout "skua"`) removes
  all zellij chrome; `default_mode "locked"` passes every key through except two
  interceptors: the tmux prefix (Ctrl-a; see Keybindings) and Ctrl-g (zellij's
  native mode toggle).
- Persistence: the detached session (created `attach --create-background`)
  outlives ttyd / the browser / a dashboard restart. Liveness = a non-EXITED
  `zellij list-sessions` entry.
- **GOTCHA — `zellij action write-chars` requires an ATTACHED client** (verified
  0.44.3: against a detached session it exits 0 and silently drops the bytes;
  `dump-screen` likewise returns empty detached). There is NO tmux
  `send-keys`-style eager injection. The cmd-hook + startup command therefore
  ride a generated per-session **ZDOTDIR** (`cache/terminals/zdot/<id>/.zshrc`:
  chains the user's `~/.zshrc`, sources the hook, runs the startup command once
  via a consumed `once` marker — so a ttyd recreate never re-runs it). zsh-only;
  another $SHELL gets a bare shell.
- Status dots come from the file-based `skua_terminal_live.ts` claude hook
  (env `SKUA_*`), independent of the terminal layer.

## When to invoke

- "vim renders garbled / ghost line after delete / blank bands / stale rows" → run the buffer-probe diagnostic
- "text misaligned or wraps wrong (esp. after resize / tab switch)" → the resize / re-fit model
- "how does the skua terminal stack work", "why is a session stuck at 80×24", "why zellij and not tmux/dtach" → read the model sections

## When NOT to invoke

- Session **lifecycle** bugs (won't start/persist, port conflicts, zellij
  session/socket-dir issues) — that's `.skua/lib/terminals.ts` logic /
  `docker-colima`, not rendering.
- Dashboard **graph** views — `skua-dataflow-graph` / `skua-schema-graph` / `skua-codebase-graph`.
- Copy/paste or xterm-level key handling — the OSC-52 handler /
  `attachCustomKeyEventHandler` in `terminal-xterm.js`. (zellij prefix/keybindings
  in `config.kdl` ARE in scope — see Keybindings.)

## Procedure — buffer-probe diagnostic (do FIRST; do not guess)

The reliable way to localize a render bug is to read xterm's **buffer model**
(what xterm thinks the screen is, independent of paint) and compare it to ground
truth. This is what convicted tmux (after two wrong guesses: canvas, then
terminfo) and acquitted zellij. Drive the real client headless with the vendored
Playwright (chromium at `.skua/cache/browsers`):

1. **Read xterm's buffer.** `page.evaluate(() => { const g = term; const b = g.buffer.active; … b.getLine(b.baseY+i).translateToString(true) … })`. `term` is a top-level `const` in the classic script, reachable from `page.evaluate`. Force a paint with `g.refresh(0, g.rows-1)` so a stale screenshot can't fool you (headless throttles rAF).
2. **Establish ground truth.** Diff xterm's rows against zellij's own grid: `zellij --session <s> action dump-screen` (stdout; remember the private env vars). For a scripted edit (a file of `GHOSTLINE-01..20`, `10G`, `dd`) the correct buffer is also known a priori: line 10 must become `GHOSTLINE-11`. Stale xterm + correct zellij grid ⇒ re-emit/transport bug, NOT a paint bug.
3. **Bypass the persistence layer.** Spawn `ttyd -T xterm-256color -W <shell>` (no zellij) and repro. Correct there but wrong through zellij ⇒ the multiplexer; wrong even direct ⇒ ttyd/xterm.js.
4. **Capture the bytes.** Tee `term.write` in the browser (`window.__w.push(dec.decode(x))`) and dump what actually arrived around the failing keystroke. Complete escapes + wrong buffer ⇒ xterm parse bug; missing escapes (e.g. no scroll) ⇒ the layer that emitted them.
5. **Renderer swap (only if bytes are correct but pixels wrong).** The DOM renderer is default (no addon). A canvas/webgl addon would be the only reason to suspect glyph-cache staleness — we don't load one, so this is rarely the answer now.

Scratch-harness pattern (see `scripts/buffer-probe-zellij.mjs`): create a
throwaway session via `POST /api/terminals`, drive
`/terminal-xterm.html?port=<p>`, `DELETE` after.

## The resize / re-fit model

**Stale 80×24 handshake.** A terminal iframe opens its WebSocket while its tab is
hidden; `safeFit()` no-ops at 0×0, so the handshake sends xterm's default 80×24.
Fix: `activate()` in `terminal.js` posts `skua-activate` to the now-visible
iframe; `terminal-xterm.js` re-fits (fires `onResize → sendResize`, correcting the
pty) then repaints. `activate()` also persists the tab id (`ACTIVE_TERM_KEY`) so
a reload re-selects the viewed tab and its reattach replay happens at real size.
Tell-tale: a session rendering at 80×24 while active.

**Resize with vim open.** `onResize → sendResize` tells ttyd's pty the new size,
the zellij client relays it to the session, and the app redraws on SIGWINCH —
verified diff-clean by the probe's resize test. No resync needed.

## Scrollback & reload (native — no client machinery)

zellij keeps scrollback server-side and re-emits the visible screen on every
attach, so a hard reload comes back with the screen intact by itself — the
dtach-era sessionStorage serialize/restore machinery is gone (see branch
`terminal-dtach` for it). Wheel-scroll reaches the full server-side history
(`mouse_mode true`, `scroll_buffer_size 10000`); a mouse drag is a zellij
selection, copied via OSC 52 into `terminal-xterm.js`'s handler → system
clipboard. The only zellij-owned keys in locked mode are the tmux prefix (Ctrl-a)
and Ctrl-g (native mode toggle); everything else passes through.

## Keybindings (tmux-style, in `config.kdl`)

`config.kdl` defines a tmux prefix scheme: locked mode binds **Ctrl-a** →
`Tmux` mode, and a `tmux clear-defaults=true` block owns every prefix command,
each ending in `SwitchToMode "Locked"` so you land back "in the shell" (the
default tmux block returns to `Normal`, which would trap keystrokes — don't use
it as-is). Bindings follow the popular tmux set: `|`/`-` (+ `%`/`"`) splits,
`h/j/k/l` (+ arrows) nav, `H/J/K/L` (+ Ctrl-arrows) repeatable resize, `c`/`n`/`p`/`1-9`
windows, `[`→Scroll, `,`→RenameTab. `scroll` and `renametab` modes are overridden
to exit to `Locked` too. `Write 1` sends a literal Ctrl-a (byte 0x01). Config
loads ONLY from `ZELLIJ_CONFIG_DIR` (`.skua/lib/zellij/config.kdl`) — never a
personal `~/.config/zellij`; zellij still layers it over its own compiled-in
defaults (so un-cleared modes keep their default binds).

**Edit → validate → roll out.** A KDL error breaks terminal startup, so after any
edit: (1) parse check `zellij --config .skua/lib/zellij/config.kdl setup --check`
(expect `[CONFIG FILE]: Well defined.`); (2) runtime launch on a throwaway socket
(`ZELLIJ_SOCKET_DIR=$(mktemp -d) … attach --create-background t; list-sessions;
kill-all-sessions`) — parse-OK but semantically-rejected binds only surface on
launch. Pull authoritative action/mode syntax for the installed version from
`zellij setup --dump-config` (don't hand-write action names from memory).
Rollout: **new** terminals load the change immediately; **already-open** ones keep
the old config until ttyd reattaches (fresh terminal or dashboard restart) —
zellij has no live config reload.

## Recovery levers

- **`repaint()`** (`terminal-xterm.js`) = `term.refresh(0, rows-1)`; auto-fires on
  focus, live scheme change, and tab-activate. Cheap DOM re-render — there is no
  glyph cache to clear.
- **Reconnect** re-runs ttyd's `zellij attach --create` against the surviving
  session; zellij replays the screen on attach.
- **Kill switch** (`#term-kill` → `killAllSessions`) reaps every skua ttyd +
  zellij session, then `kill-all-sessions` inside the private socket dir — the
  user's own zellij (if any) is untouched.

## Key files

- `.skua/lib/terminals.ts` — session lifecycle: `spawnMaster`
  (`attach --create-background`), `ttydArgs` (`attach --create`),
  `writeZdot`/`removeZdot` (the ZDOTDIR bootstrap: hook + run-once startup
  command — replaces send-keys injection, which zellij can't do detached),
  `zellijHasSession` (list-sessions parse), `zellijEnv` (socket/config dirs +
  SKUA_* + ZDOTDIR), `killMaster`, `killAllSessions`, `reconcile`/`respawnTtyd`.
- `.skua/lib/zellij/` — `config.kdl` (locked mode, bare layout, mouse,
  scrollback, no serialization, tmux-style keybind set — see Keybindings) +
  `layouts/skua.kdl` (single chrome-less pane).
  Passed as `ZELLIJ_CONFIG_DIR`; a `--layout` flag would be ignored by
  `attach --create`, which is why the layout rides in the config dir.
- `.skua/public/terminal-xterm.js` — Terminal construction (FitAddon, DOM
  renderer), `safeFit`, `repaint`, the `message`/`skua-activate` listener,
  key handler + OSC-52 clipboard. No scrollback-restore code.
- `.skua/public/terminal.js` — `activate()` (`skua-activate`; persists
  `ACTIVE_TERM_KEY`), `load()` (re-activates the persisted tab on reload),
  `ensureFrame()` (iframe `?port=…`), `killSwitch()`.
- `.skua/server.ts` — `/api/terminals` routes (create/list/kill/rename/reorder,
  `kill-server`). No `/resync` route.

## Prerequisites

- `ttyd` and `zellij` on PATH (`brew install ttyd zellij`; probed on zellij
  0.44.3, CLI targets ≥ 0.40). No tmux, no dtach, no `tic`/terminfo.
- The dashboard runs via `bun --hot`; **client JS/HTML changes need a browser
  refresh + a ttyd respawn (close/reopen the tab)**, and a *structural* server
  change (new module exports, lifecycle rewrites) can wedge `bun --hot` — restart
  the dashboard process to load it, and verify the fix on a throwaway instance
  (`PORT=5175 bun server.ts`) rather than trusting the hot-reloaded one.
