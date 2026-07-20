// skua's own xterm.js client for ttyd sessions.
//
// We replace ttyd's bundled web client with this one for a single reason: ttyd's
// client offers no way to remap keys, and the browser's xterm.js sends a plain
// carriage return for Shift+Enter (indistinguishable from Enter) and nothing
// usable for Cmd+Backspace. Native terminals (iTerm2, Ghostty, …) send distinct
// sequences for those; a browser terminal does not. So Claude Code's
// `shift+enter → newline` binding can never fire here, and there's no "delete to
// line start" on Cmd+Backspace. Owning the client lets us translate both at the
// keyboard layer, before bytes reach the pty — see installKeyHandler().
//
// This speaks ttyd's WebSocket protocol directly (validated against ttyd 1.7.7):
//   • subprotocol: "tty"
//   • first client frame (handshake): JSON {AuthToken, columns, rows} (no prefix)
//   • client → server: INPUT = '0' + utf8 ;  RESIZE = '1' + JSON{columns,rows}
//   • server → client: OUTPUT = '0' ; SET_WINDOW_TITLE = '1' ; SET_PREFERENCES = '2'
// AuthToken is empty: skua starts ttyd without --credential, so it's ignored
// (and fetching ttyd's /token cross-origin would be blocked by CORS anyway).
//
// Session persistence and liveness are unaffected — those live in
// lib/terminals.ts (ttyd + zellij in skua's own private socket dir),
// independent of whichever web client is attached. zellij replays the visible
// screen on every attach and keeps scrollback server-side (wheel-scroll), so
// this client carries no scrollback-restore machinery.

const INPUT = 0x30; // '0'
const RECONNECT_MS = 1000;

// ── clipboard/selection debug ─────────────────────────────────────────────────
// Flip CLIP_DEBUG to true to trace the copy path (which branch ran, whether the
// async writeText resolved or rejected, OSC 52 arrivals). Kept because browser
// clipboard rules (focus, keydown-vs-mouseup) make copy behavior non-obvious.
// All output is prefixed "[skua-clip]" for easy console filtering.
const CLIP_DEBUG = false;
function clog(msg) {
    if (CLIP_DEBUG) console.log("[skua-clip] " + msg);
}

const params = new URLSearchParams(location.search);
const port = params.get("port");
const host = location.hostname || "127.0.0.1";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── color scheme ──────────────────────────────────────────────────────────
// The palette is one of the named schemes in terminal-schemes.js (Evening,
// GitHub Dark, Catppuccin, Dracula, Nord, Solarized), chosen in the dashboard
// toolbar and stored in localStorage under SKUA_TERM_SCHEME_KEY. Each scheme is
// a complete, fixed look — surface AND all 16 ANSI colors — and does NOT follow
// the
// dashboard's light/dark toggle (so, unlike before, we don't read `skua-theme`
// here). The parent writes the choice and the same-origin `storage` event below
// recolors us live, no reload.
const SCHEME_KEY = window.SKUA_TERM_SCHEME_KEY;

function activeSchemeTheme() {
    let id = null;
    try {
        id = localStorage.getItem(SCHEME_KEY);
    } catch {
        /* localStorage unavailable — skuaTermScheme falls back to default */
    }
    return window.SKUA_TERM_SCHEMES[window.skuaTermScheme(id)].theme;
}

const term = new Terminal({
    fontSize: 14,
    fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
    cursorBlink: true,
    // Option-as-Meta so Alt/Option chords (word motion, Option+Enter) behave like
    // a configured native terminal — a bonus alongside the explicit remaps below.
    macOptionIsMeta: true,
    // Option+drag forces a LOCAL text selection even when the running TUI (Claude
    // Code) has mouse reporting on and would otherwise swallow the drag. Without
    // this, macOS has no modifier that forces selection while a full-screen app
    // owns the mouse — so you could never select (and thus never Cmd+C copy) text
    // out of a live Claude session. Operates on mousedown; independent of the
    // macOptionIsMeta keyboard path above.
    macOptionClickForcesSelection: true,
    scrollback: 10000,
    theme: activeSchemeTheme(),
});

// Apply the active scheme to the live terminal AND to the page background. The
// #term padding (terminal-xterm.html) reveals the page behind the terminal, so
// matching documentElement's background to the scheme avoids a mismatched
// border. The HTML's inline bootstrap sets this for first paint; this keeps it
// in sync after a live scheme change.
function applyScheme() {
    const theme = activeSchemeTheme();
    term.options.theme = theme;
    document.documentElement.style.background = theme.background;
}

const fit = new FitAddon.FitAddon();
term.loadAddon(fit);

const mount = document.getElementById("term");
term.open(mount);
// No renderer addon: xterm uses its built-in DOM renderer, which re-renders each
// row from the buffer on refresh, so deleting a line never leaves a ghost. (The
// canvas addon we used before painted stale glyphs — the ghost-on-delete bug.)
applyScheme();
safeFit();

// ── ttyd socket ─────────────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
let disposed = false;

function wsUrl() {
    return `ws://${host}:${port}/ws`;
}

function safeFit() {
    // fit() reads the container box; while the iframe is hidden (display:none)
    // it's 0×0 and proposeDimensions() returns undefined, so this is a safe
    // no-op until the tab is shown and the ResizeObserver re-fits.
    try {
        if (mount.clientWidth > 0 && mount.clientHeight > 0) fit.fit();
    } catch {
        /* ignore transient layout errors */
    }
}

// Re-render every row from xterm's buffer. The DOM renderer repaints on buffer
// change on its own; this is a cheap belt-and-suspenders nudge on focus / live
// scheme change / tab-activate. There's no glyph cache to clear — that was a
// canvas-renderer concern, and we no longer load the canvas addon (the DOM
// renderer is correct for full-screen apps).
function repaint() {
    try {
        term.refresh(0, term.rows - 1);
    } catch {
        /* transient renderer state — ignore */
    }
}

// Send raw bytes to the pty as a ttyd INPUT frame.
function sendInput(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const payload = enc.encode(data);
    const msg = new Uint8Array(payload.length + 1);
    msg[0] = INPUT;
    msg.set(payload, 1);
    ws.send(msg);
}

function sendResize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(enc.encode("1" + JSON.stringify({ columns: term.cols, rows: term.rows })));
}

function applyPrefs(body) {
    // ttyd forwards its `-t key=value` client options here as JSON. They map to
    // xterm ITerminalOptions; apply only the display keys we set ourselves so an
    // unknown key can't throw.
    try {
        const prefs = JSON.parse(dec.decode(body));
        if (typeof prefs.fontSize === "number") term.options.fontSize = prefs.fontSize;
        if (typeof prefs.fontFamily === "string") term.options.fontFamily = prefs.fontFamily;
        safeFit();
    } catch {
        /* non-JSON or unexpected shape — ignore */
    }
}

function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_MS);
}

function connect() {
    let sock;
    try {
        sock = new WebSocket(wsUrl(), "tty");
    } catch {
        scheduleReconnect();
        return;
    }
    sock.binaryType = "arraybuffer";
    ws = sock;

    sock.onopen = () => {
        safeFit();
        // Handshake: raw JSON, no command prefix.
        sock.send(enc.encode(JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows })));
    };
    sock.onmessage = (ev) => {
        const u = new Uint8Array(ev.data);
        if (!u.length) return;
        const cmd = String.fromCharCode(u[0]);
        const body = u.subarray(1);
        if (cmd === "0") term.write(body); // OUTPUT
        else if (cmd === "1") document.title = dec.decode(body); // SET_WINDOW_TITLE
        else if (cmd === "2") applyPrefs(body); // SET_PREFERENCES
    };
    sock.onclose = () => {
        if (ws === sock) ws = null;
        scheduleReconnect(); // ttyd respawn / page wake — zellij keeps the session
    };
    sock.onerror = () => {
        try {
            sock.close();
        } catch {
            /* already closing */
        }
    };
}

// ── no client-side scrollback persistence on this branch ────────────────────
// zellij keeps scrollback server-side (wheel-scroll over the full history) and
// re-emits the visible screen on every attach, so a hard reload comes back with
// the screen intact on its own — the dtach branch's sessionStorage
// serialize/restore machinery is unnecessary here.


// ── clipboard ─────────────────────────────────────────────────────────────────
// xterm.js manages selection as its OWN model (a rendered overlay), not native
// DOM text the OS can see — true regardless of renderer. Two consequences this
// client has to handle: (1) the browser's native Cmd+C has
// nothing to copy (no selected DOM text), and (2) the running TUI's frequent
// repaints (Claude Code's spinner, cursor, status line) clear xterm's selection
// overlay almost as soon as you make it. We stash every non-empty selection here
// so Cmd+C (below) can copy the most recent one even after a repaint wiped the
// on-screen highlight. Paste needs no help: the browser's native paste event
// still reaches xterm's hidden textarea, so Cmd+V works once Cmd+C populates the
// clipboard.
let lastSelection = "";

// Last-resort copy for when the async Clipboard API is unavailable (insecure
// context / old browser). It STEALS FOCUS — focusing the throwaway textarea and
// handing focus back to the terminal churns focus, which clears xterm's on-screen
// selection. That's invisible under a repainting TUI (Claude Code), but in a
// plain shell it makes a fresh drag-selection vanish the instant you release. So
// this is a fallback ONLY, never the normal path.
function execCommandCopy(text) {
    clog("execCommandCopy running (FOCUS STEAL)");
    try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        term.focus();
        clog("execCommandCopy done ok=" + ok);
        if (ok) showCopied();
    } catch (err) {
        clog("execCommandCopy threw: " + err);
    }
}

// Copy `text` to the system clipboard.
//
// `allowFocusSteal` gates the execCommandCopy fallback. That fallback focuses a
// throwaway textarea, which CLEARS xterm's on-screen selection — acceptable for
// an explicit Cmd+C (you asked to copy; losing the highlight after is normal),
// but forbidden for copy-on-select, where the whole point is that the drag
// highlight survives. Crucially, some browsers (Safari especially) accept
// clipboard writes from a keydown but REJECT them from a mouseup — so on
// copy-on-select the async write can reject, and if we let the .catch run the
// focus-stealing fallback it wipes the highlight the instant you release the
// drag. So copy-on-select passes allowFocusSteal=false: async-write or nothing,
// never a focus steal. Cmd+C stays the reliable backstop there (keydown writes
// aren't rejected).
function copyText(text, allowFocusSteal = true) {
    if (!text) return;
    clog(`copyText len=${text.length} steal=${allowFocusSteal} hasAsync=${!!navigator.clipboard?.writeText} hasFocus=${document.hasFocus()}`);
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
            () => {
                clog("writeText OK");
                showCopied();
            },
            (err) => {
                clog(`writeText REJECT ${err && err.name}: ${err && err.message}`);
                if (allowFocusSteal) execCommandCopy(text);
            },
        );
        return;
    }
    clog("copyText: no async clipboard API");
    if (allowFocusSteal) execCommandCopy(text);
}

// ── "Copied" toast ────────────────────────────────────────────────────────────
// Copies can be silent (copy-on-select fires on mouseup; a TUI repaint may wipe
// the highlight right after). This flashes a small confirmation, ~0.8s, so a
// copy is never silent.
// Colors invert the active scheme (fg-on-bg → bg-on-fg) so it always reads and
// matches whatever palette is live. pointer-events:none so it never blocks the
// terminal; it's positioned within the iframe, i.e. over the terminal pane.
let toastEl = null;
let toastTimer = null;
function showCopied() {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.textContent = "Copied";
        toastEl.setAttribute("aria-live", "polite");
        Object.assign(toastEl.style, {
            position: "fixed",
            bottom: "12px",
            left: "50%",
            transform: "translateX(-50%)",
            padding: "3px 12px",
            borderRadius: "6px",
            font: '600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
            letterSpacing: "0.03em",
            pointerEvents: "none",
            opacity: "0",
            transition: "opacity 150ms ease",
            zIndex: "9999",
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
        });
        document.body.appendChild(toastEl);
    }
    const theme = activeSchemeTheme();
    toastEl.style.background = theme.foreground;
    toastEl.style.color = theme.background;
    toastEl.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        if (toastEl) toastEl.style.opacity = "0";
    }, 800);
}

// ── custom key handling — the reason this client exists ───────────────────────
function installKeyHandler() {
    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;

        // Shift+Enter → newline. The terminal would otherwise send a bare CR and
        // Claude (or the shell) would submit. We send LF (0x0A = Ctrl-J), which
        // Claude Code treats as "insert newline" in every terminal, no
        // terminal-specific escape required.
        if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            sendInput("\n");
            return false;
        }

        // Cmd+Backspace → delete to start of line (macOS muscle memory). Sends
        // Ctrl-U (0x15), which Claude Code's input — and zsh's line editor —
        // read as kill-to-line-start.
        if (e.key === "Backspace" && e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            sendInput("\x15");
            return false;
        }

        // Cmd+Left / Cmd+Right → start / end of line (macOS muscle memory). A
        // browser xterm.js sends nothing for Cmd+Arrow — native terminals are
        // configured to, browsers aren't — so these never reach the pty. We send
        // Ctrl-A (0x01) / Ctrl-E (0x05), the emacs-style motions that Claude
        // Code's input and zsh's (default emacs-mode) line editor both honor.
        if (e.key === "ArrowLeft" && e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            sendInput("\x01");
            return false;
        }
        if (e.key === "ArrowRight" && e.metaKey && !e.altKey && !e.ctrlKey) {
            e.preventDefault();
            sendInput("\x05");
            return false;
        }

        // Cmd+C → copy the selection. xterm has no native browser copy (it owns
        // its selection model), so we do it: write the live selection, or the last one we saw
        // before a repaint cleared it, to the clipboard. With nothing selected we
        // fall through — Cmd+C has no terminal meaning, and Ctrl+C/SIGINT is ctrl,
        // not meta, so it stays untouched.
        if (e.key === "c" && e.metaKey && !e.altKey && !e.ctrlKey) {
            const sel = term.getSelection() || lastSelection;
            if (sel) {
                e.preventDefault();
                copyText(sel);
                return false;
            }
        }

        return true; // everything else: xterm's normal handling
    });
}

// ── wiring ────────────────────────────────────────────────────────────────

if (!port) {
    term.write("\r\n\x1b[31mskua: missing ?port= for this terminal\x1b[0m\r\n");
} else {
    installKeyHandler();
    term.onData((d) => sendInput(d));
    // onResize fires only on a real cols/rows change: tell the pty the new size.
    // ttyd resizes its pty, the zellij client relays it to the session, and the
    // app redraws itself on SIGWINCH.
    term.onResize(() => sendResize());

    // ── OSC 52 → system clipboard ─────────────────────────────────────────────
    // A program in the pane can set the system clipboard by emitting an OSC 52
    // escape (e.g. vim with `set clipboard=unnamed` + an OSC-52 yank plugin, or
    // any tool that copies via OSC 52). xterm.js ignores OSC 52 by default, so we
    // decode it and push the text to the clipboard. With mouse_mode on, a plain
    // drag is a zellij selection — zellij copies it via OSC 52 too, so mouse
    // copies still reach the system clipboard.
    term.parser.registerOscHandler(52, (data) => {
        // data = "<targets>;<base64|?>"  e.g. "c;SGVsbG8=" ; "?" is a read query.
        const semi = data.indexOf(";");
        if (semi === -1) return false;
        const payload = data.slice(semi + 1);
        if (payload === "?" || payload === "") return true; // read-back query — unsupported
        let text = "";
        try {
            text = new TextDecoder().decode(
                Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0)),
            );
        } catch {
            clog("OSC52 malformed base64 — ignored");
            return true;
        }
        clog(`OSC52 → clipboard len=${text.length}`);
        copyText(text, true); // no xterm selection to protect here; fallback is fine
        return true;
    });

    // Remember the most recent non-empty selection so Cmd+C can copy it even
    // after a TUI repaint clears the on-screen highlight (see installKeyHandler).
    term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) lastSelection = sel;
    });

    // Copy-on-select (classic terminal behavior): the moment a drag finishes
    // with a non-empty selection, put it on the clipboard — no Cmd+C needed, and
    // no race with the TUI repaint that would otherwise clear the highlight. We
    // fire on mouseup (drag settled) rather than onSelectionChange (fires per
    // pixel during the drag) to avoid hammering the clipboard mid-drag.
    // allowFocusSteal=false: NEVER fall back to the focus-stealing execCommand
    // path here — that would clear the very highlight we just made (see copyText).
    mount.addEventListener("mouseup", () => {
        const sel = term.getSelection();
        if (sel) copyText(sel, false);
    });

    new ResizeObserver(() => safeFit()).observe(mount);
    window.addEventListener("resize", safeFit);

    // Parent (terminal.js) → child signal. A frame that connected while its tab
    // was hidden handshaked at xterm's default 80×24 (safeFit no-ops at 0×0); on
    // tab-activate we re-fit — which fires onResize → sendResize, correcting the
    // pty size — then repaint.
    window.addEventListener("message", (e) => {
        if (e.origin !== location.origin) return;
        if (e.data && e.data.type === "skua-activate") {
            safeFit();
            repaint();
        }
    });

    // Regaining focus (tab/window switch) can surface a frame that went stale
    // while hidden; a cheap refresh clears it.
    window.addEventListener("focus", repaint);

    // Live scheme sync: the dashboard's scheme picker writes localStorage from
    // the parent document; the `storage` event fires here (same origin, sibling
    // browsing context) so we recolor without a reload. Repaint so any glyphs in
    // the previous palette are re-rendered in the new one.
    window.addEventListener("storage", (e) => {
        if (e.key === SCHEME_KEY) {
            applyScheme();
            repaint();
        }
    });

    connect();
    term.focus();
}
