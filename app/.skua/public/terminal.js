// Terminal tab — control bar + session list (left panel) + embedded terminal
// <iframe> (right). Each iframe loads skua's own xterm.js client
// (terminal-xterm.html), which speaks ttyd's protocol to the session's port —
// owning the client is what lets us remap Shift+Enter / Cmd+Backspace. Session
// lifecycle is server-side (lib/terminals.ts); live status + summaries come from
// the skua_terminal_live.ts hook. This module drives the UI and polls
// /api/terminals every 2.5s to refresh the status dot + summary.
//
// Iframes are mounted once per session and kept in the DOM (hidden when
// inactive) so switching is instant and never tears down a live connection.

import { statusIcon, STATUS_LABEL } from "/components/status-icons.js";

const CWD_KEY = "skua.terminal-cwd";
const COLLAPSED_KEY = "skua.terminal-sidebar-collapsed";
const SIDEBAR_W_KEY = "skua.terminal-sidebar-width";
const SIDEBAR_W_DEFAULT = 276; // px — matches the CSS fallback in main.terminal-page
const SIDEBAR_W_MIN = 180; // px
const SEARCH_TABS_KEY = "skua.search-tabs";
const POLL_MS = 2500;
const CLOSE_AT = 0.94; // close progress (0=top/open … 1=bottom/close) at/above which slide-to-close fires

const mainEl = document.querySelector("main.terminal-page");
const listEl = document.getElementById("term-list");
const stageEl = document.getElementById("term-stage");
const emptyEl = document.getElementById("term-empty");
const newBtn = document.getElementById("term-new");
const searchNewBtn = document.getElementById("term-search-new");
const cwdForm = document.getElementById("term-cwd-form");
const cwdInput = document.getElementById("term-cwd");
const savedTag = document.getElementById("term-cwd-saved");
const errEl = document.getElementById("term-bar-error");
const collapseBtn = document.getElementById("term-collapse");
const resizer = document.getElementById("term-resizer");
const schemeSelect = document.getElementById("term-scheme");
const utilsToggle = document.getElementById("term-utils-toggle");
const utilsPanel = document.getElementById("term-utils");

/** @type {Map<string, HTMLIFrameElement>} id -> iframe */
const frames = new Map();
let activeId = null;
let savedTimer = null;
let currentIdsKey = "";
let draggingId = null; // id of the tab currently being drag-reordered, else null
let lastSessions = []; // most recent /api/terminals payload (drives the tab hovercards)

// ── search tabs ────────────────────────────────────────────────────────────────
// Project-search tabs live alongside terminals in the same sidebar list, but are
// purely client-side: each is an <iframe> to /search.html (no ttyd/zellij). They're
// pinned above the terminals and persisted so they survive a reload; the search
// page itself remembers its last query per tab id.
function loadSearchTabs() {
    try {
        const raw = JSON.parse(localStorage.getItem(SEARCH_TABS_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((t) => t && typeof t.id === "string")
            .map((t) => ({ id: t.id, title: typeof t.title === "string" ? t.title : "Search" }));
    } catch {
        return [];
    }
}
let searchTabs = loadSearchTabs();
function saveSearchTabs() {
    try {
        localStorage.setItem(SEARCH_TABS_KEY, JSON.stringify(searchTabs));
    } catch {
        /* persistence best-effort */
    }
}

// The unified tab model the list + stage render from: search tabs first (pinned),
// then the server's terminal sessions. Terminals carry their full payload; search
// tabs carry just {id, kind, title}.
function buildTabs(sessions) {
    const search = searchTabs.map((t) => ({ id: t.id, kind: "search", title: t.title }));
    const terms = sessions.map((s) => ({ ...s, kind: "term" }));
    return [...search, ...terms];
}

// Set-identity key (sorted) — decides ONLY whether a poll must rebuild the list
// (a tab was added/removed). It's deliberately order-insensitive: a pure drag
// reorder keeps the same set, so the poll patches in place and preserves the
// user's DOM order instead of snapping back to the server's order.
const idsKey = (sessions) => sessions.map((s) => s.id).sort().join(",");

// Hydrate the saved default working directory into the bar.
try {
    cwdInput.value = localStorage.getItem(CWD_KEY) || "";
} catch {
    /* localStorage unavailable — fall back to empty (=> ~) */
}

// ── status / summary helpers ────────────────────────────────────────────────

// The dot renders two bits the server hands us — is Claude RUNNING, and does it
// NEED YOU — crossed with one bit we own: have you looked at this tab since it
// started needing you.
//
//   none     no Claude session here (plain shell, or `claude` has exited)
//   working  Claude is running                       → spinner (the only motion)
//   blocked  waiting on you to answer something      → red !
//   unread   finished, and you haven't looked        → envelope
//   seen     finished, and you've already looked     → check
//   stale    claims to be working but stopped
//            checking in (killed / crashed / Esc)    → broken ring
//
// "Unread" is a timestamp comparison, not a transition we have to witness: it
// survives a reload and can't miss a turn that began and ended between two polls.
//
// Note the asymmetry between the two kinds of needs-you: reading a FINISHED turn
// settles it, but reading a permission prompt does not answer it — Claude is
// still blocked and will sit there indefinitely — so `waiting` keeps its own
// glyph whether you've looked or not, and only answering it clears it.
//
// Each state is a distinct SHAPE, so the set survives being read in greyscale;
// colour only reinforces what the glyph already says.
function dotState(s) {
    if (!s.isClaude) return "none";
    if (s.stale) return "stale";
    if (s.status === "working") return "working";
    if (s.status === "waiting") return "blocked";
    return isUnread(s) ? "unread" : "seen";
}

// Paint `el` for session `s`. The glyph is rebuilt ONLY when the state actually
// changes: re-creating it on every 2.5s poll would restart the spinner
// mid-rotation and make a working tab stutter.
function applyDot(el, s) {
    const state = dotState(s);
    if (el.dataset.state !== state) {
        el.dataset.state = state;
        const icon = statusIcon(state);
        if (icon) el.replaceChildren(icon);
        else el.replaceChildren();
    }
    el.className = "term-status-dot is-" + state;
    const label = STATUS_LABEL[state];
    if (label) {
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", label);
    } else {
        el.removeAttribute("role");
        el.removeAttribute("aria-label");
    }
}

// Sub-line shows what the session is up to: a live summary if the hook has one
// (it survives Stop, so a finished tab still shows what it last worked on), else
// the cwd — which is all a plain shell ever has.
function subInfo(s) {
    if (s.summary) return { text: s.summary, isSummary: true };
    return { text: s.cwd, isSummary: false };
}

// ── seen tracking ─────────────────────────────────────────────────────────────
// When you last LOOKED at each tab (not merely "it was the last one clicked"):
// the active tab counts as looked-at only while this page is actually visible and
// focused, so a terminal left selected behind another window keeps its unread
// flash. Persisted, so the mark survives a reload the way the server's
// awaitingSince does.
const SEEN_KEY = "skua.terminal-seen";

function loadSeen() {
    try {
        const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
        return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
        return {};
    }
}
let seenAt = loadSeen(); // id -> ISO string of when you last looked at that tab

function saveSeen() {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seenAt));
    } catch {
        /* persistence best-effort — unread still works for this page's lifetime */
    }
}

// Is the user actually looking at this page? A tab in a background window or
// another space is not "read", however long it has been selected.
function isViewing() {
    return document.visibilityState === "visible" && document.hasFocus();
}

function markSeen(id) {
    if (!id) return;
    seenAt[id] = new Date().toISOString();
    saveSeen();
}

// Both stamps are ISO-8601 UTC from the same machine, so a string compare is a
// time compare. No awaitingSince (still working, or a fresh session that has
// produced nothing yet) means there is nothing to read.
function isUnread(s) {
    if (!s.awaitingSince) return false;
    const seen = seenAt[s.id];
    return !seen || seen < s.awaitingSince;
}

// Keep the active tab's seen-stamp rolling while you're watching it, and forget
// tabs that no longer exist so the store can't grow forever. Only terminals get
// a stamp: search tabs have no session and would be pruned right back out on the
// next poll, writing to localStorage twice a tick for nothing.
function reconcileSeen(sessions) {
    const live = new Set(sessions.map((s) => s.id));
    if (activeId && live.has(activeId) && isViewing()) markSeen(activeId);
    let dropped = false;
    for (const id of Object.keys(seenAt)) {
        if (!live.has(id)) {
            delete seenAt[id];
            dropped = true;
        }
    }
    if (dropped) saveSeen();
}

// Coming back to the window is itself an act of reading: stamp the tab you're on
// and repaint immediately rather than leaving it flashing until the next poll.
function onLook() {
    if (!activeId || !isViewing()) return;
    if (lastSessions.some((s) => s.id === activeId)) markSeen(activeId);
    patchStatus(lastSessions);
}
document.addEventListener("visibilitychange", onLook);
window.addEventListener("focus", onLook);

// Another dashboard page (second browser tab/window) marked something read.
// Adopt any stamp newer than ours, so reading a tab in one page settles it in
// both — and so this page's next save can't clobber a mark it never saw.
window.addEventListener("storage", (e) => {
    if (e.key !== SEEN_KEY) return;
    const other = loadSeen();
    let changed = false;
    for (const id of Object.keys(other)) {
        if (!seenAt[id] || seenAt[id] < other[id]) {
            seenAt[id] = other[id];
            changed = true;
        }
    }
    if (changed) patchStatus(lastSessions);
});

function applyDead(nameEl, s) {
    let dead = nameEl.querySelector(".term-item-dead");
    if (s.alive === false && !dead) {
        dead = document.createElement("span");
        dead.className = "term-item-dead";
        dead.title = "ttyd not running — reconnecting on open";
        dead.textContent = "⚠";
        nameEl.appendChild(dead);
    } else if (s.alive !== false && dead) {
        dead.remove();
    }
}

// ── iframes ─────────────────────────────────────────────────────────────────

function ensureFrame(tab) {
    let f = frames.get(tab.id);
    if (!f) {
        f = document.createElement("iframe");
        f.className = "term-frame";
        // clipboard-* in `allow` grants the frame's copy path permission-policy
        // access so Cmd+C / copy-on-select reaches the system clipboard in every
        // browser, not just same-origin-default Chrome.
        f.allow = "clipboard-read; clipboard-write";
        if (tab.kind === "search") {
            // Self-contained project-search page (search.html + search.js).
            f.src = `/search.html?id=${encodeURIComponent(tab.id)}`;
        } else {
            // skua's own xterm client (not ttyd's bundled page) so we can remap
            // keys. It connects its WebSocket back to THIS origin, which proxies
            // to the session's ttyd over a unix socket — the session id is all
            // it needs, and there is no port to go stale on a respawn.
            f.src = `/terminal-xterm.html?id=${encodeURIComponent(tab.id)}`;
        }
        f.title = tab.title;
        f.hidden = true;
        stageEl.appendChild(f);
        frames.set(tab.id, f);
    }
    return f;
}

// Remember which tab was active so a reload can re-select it (see load()): the
// reselected tab is un-hidden BEFORE its iframe connects, so the handshake and
// zellij's reattach replay happen at the pane's real size instead of the hidden
// 80×24. Key mirrors SKUA_TERM_SCHEME_KEY's style.
const ACTIVE_TERM_KEY = "skua-active-term";

function activate(id) {
    if (!frames.has(id)) return;
    activeId = id;
    try { localStorage.setItem(ACTIVE_TERM_KEY, id); } catch { /* localStorage unavailable */ }
    // Opening a tab reads it — but only if you're actually here (this also runs
    // when a reload re-selects the last tab, possibly in a hidden window), and
    // only for real terminals (a search tab has no session to be unread). Repaint
    // its dot now instead of waiting for the next poll; a session that is still
    // working keeps pulsing, because looking at a tab doesn't stop the work.
    const s = lastSessions.find((x) => x.id === id);
    if (s && isViewing()) markSeen(id);
    const li = listEl.querySelector(`.term-item[data-id="${id}"]`);
    const dot = li && li.querySelector(".term-status-dot");
    if (dot && s) applyDot(dot, s);
    for (const [fid, f] of frames) f.hidden = fid !== id;
    // The now-visible terminal re-fits + repaints: a frame that connected while
    // hidden handshaked at xterm's default 80×24 (its safeFit no-ops at 0×0), so
    // this is where it corrects its pty size and clears any stale glyphs. Harmless
    // for search tabs (same-origin, no handler). See terminal-xterm.js "message".
    const af = frames.get(id);
    if (af && af.contentWindow) {
        try {
            af.contentWindow.postMessage({ type: "skua-activate" }, location.origin);
        } catch {
            /* frame not ready — the client re-fits on its own load */
        }
    }
    for (const li of listEl.children) {
        li.classList.toggle("active", li.dataset.id === id);
    }
    if (emptyEl) emptyEl.hidden = frames.size > 0;
}

// The active terminal's pending prompt (what its Claude is waiting on) surfaces
// in that tab's hovercard via `term-hovercard-notif` — no intrusive overlay.

// ── drag-to-reorder ───────────────────────────────────────────────────────────

// Make a whole tab draggable for vertical reorder. dragstart marks it dragging
// (its id drives the listEl-level dragover reordering); dragend clears the mark
// and persists the new order. Drags that begin on the close slider, fork button,
// or an open rename input are ignored so those controls keep their own behavior.
function wireTabDrag(li, id) {
    li.addEventListener("dragstart", (e) => {
        if (e.target.closest(".term-item-close, .term-item-fork, .term-item-rename-input")) {
            e.preventDefault();
            return;
        }
        draggingId = id;
        li.classList.add("dragging");
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            try {
                e.dataTransfer.setData("text/plain", id);
            } catch {
                /* setData unsupported — drag still works */
            }
        }
    });
    li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
        draggingId = null;
        persistOrder();
    });
}

// The item the dragged row should sit BEFORE, given the pointer's Y — the first
// tab whose vertical midpoint is below the cursor. null → drop at the end.
function dragAfterElement(y) {
    let closest = { offset: Number.NEGATIVE_INFINITY, el: null };
    for (const child of listEl.querySelectorAll(".term-item:not(.dragging)")) {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
    }
    return closest.el;
}

// Wired ONCE on the persistent list element (not per render). While a drag is in
// flight it live-reorders the DOM as the pointer moves; the drop is committed by
// the tab's dragend → persistOrder.
function wireListDnd() {
    listEl.addEventListener("dragover", (e) => {
        if (!draggingId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const dragging = listEl.querySelector(`.term-item[data-id="${draggingId}"]`);
        if (!dragging) return;
        const after = dragAfterElement(e.clientY);
        if (after == null) listEl.appendChild(dragging);
        else if (after !== dragging) listEl.insertBefore(dragging, after);
    });
    listEl.addEventListener("drop", (e) => {
        if (draggingId) e.preventDefault();
    });
}

// Persist the current DOM order to the server. Best-effort: the reorder is
// already reflected locally, and the next poll re-syncs from the server if this
// fails. The set of ids is unchanged, so polling keeps patching in place (see
// idsKey) and won't rebuild over the new order.
async function persistOrder() {
    // Only real ttyd sessions are server-ordered; search tabs are client-side.
    const ids = [...listEl.querySelectorAll(".term-item")]
        .map((li) => li.dataset.id)
        .filter((id) => id && id.startsWith("term-"));
    try {
        await fetch("/api/terminals/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids }),
        });
    } catch {
        /* best-effort — server order re-syncs on the next add/remove rebuild */
    }
}

// ── rendering ───────────────────────────────────────────────────────────────

// A search tab: search glyph + editable title + slide-to-close, no status dot or
// fork (it has no live session). Reuses the terminal item chrome/classes.
// ── tab hovercard ─────────────────────────────────────────────────────────────

// A floating card shown on tab hover/focus with the tab's FULL title, what its
// session is working on, and its cwd — the un-clipped version of the one-line
// label. Replaces the native `title=` tooltip, whose ~0.5s reveal delay is fixed
// by the OS and can't be styled; this shows after HOVERCARD_DELAY_MS and is
// keyboard-reachable (focus). One shared element, positioned beside the hovered
// tab and clamped to the viewport; pointer-events:none so it never eats a click.
const HOVERCARD_DELAY_MS = 500; // 0.5s — the first-hover reveal delay
let hoverEl = null;
let hoverTimer = null;
let hoverId = null; // id the card is currently showing for
let hoverPendingId = null; // id armed but not yet shown (delay in flight)
let hoverPointer = false; // the pending focus change is pointer-driven → don't focus-show

function ensureHovercard() {
    if (hoverEl) return hoverEl;
    hoverEl = document.createElement("div");
    hoverEl.className = "term-hovercard";
    hoverEl.hidden = true;
    document.body.appendChild(hoverEl);
    return hoverEl;
}

function hovercardRow(cls, text) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
}

// Fill the card from the latest payload for `id`, then place it beside `li`.
// Only rows that carry text are rendered.
function showHovercard(li, id) {
    const s = lastSessions.find((x) => x.id === id);
    if (!s) return;
    const card = ensureHovercard();
    card.replaceChildren();

    card.appendChild(hovercardRow("term-hovercard-title", s.title || "terminal"));
    // The same summary the sub-line clips — shown here in full.
    const { text, isSummary } = subInfo(s);
    if (isSummary && text) card.appendChild(hovercardRow("term-hovercard-summary", text));
    if (s.cwd) card.appendChild(hovercardRow("term-hovercard-cwd", s.cwd));
    if (s.notification && s.notification.message) {
        card.appendChild(hovercardRow("term-hovercard-notif", s.notification.message));
    }

    // Reveal off-screen first so we can measure it, then place it — no flash at a
    // stale position.
    card.style.left = "-9999px";
    card.style.top = "0px";
    card.hidden = false;
    positionHovercard(li);
}

// Sit the card just right of the tab (the sidebar is on the left); flip to the
// left and clamp if it would run off-screen.
function positionHovercard(li) {
    const card = ensureHovercard();
    const r = li.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 8;
    let left = r.right + gap;
    if (left + cw > window.innerWidth - 8) left = r.left - gap - cw; // no room right → flip left
    if (left < 8) left = 8;
    let top = Math.min(r.top, window.innerHeight - 8 - ch);
    if (top < 8) top = 8;
    card.style.left = left + "px";
    card.style.top = top + "px";
}

function hideHovercard() {
    if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
    }
    hoverPendingId = null;
    hoverId = null;
    if (hoverEl) hoverEl.hidden = true;
}

// Delegated hover + focus wiring on the persistent list element (wired once). The
// HOVERCARD_DELAY_MS arm only gates the FIRST reveal so quick passes don't flash
// the card; once a card is up, moving to another tab switches instantly. Focus
// shows it at once for keyboard users. A drag, mousedown, or scroll dismisses it.
function wireHovercard() {
    listEl.addEventListener("mouseover", (e) => {
        if (draggingId) return;
        const li = e.target.closest(".term-item");
        if (!li) return;
        const id = li.dataset.id;
        if (id === hoverId || id === hoverPendingId) return; // already showing/arming this tab
        if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
        }
        if (hoverEl && !hoverEl.hidden) {
            hoverPendingId = null; // a card is already up — switch tabs with no delay
            hoverId = id;
            showHovercard(li, id);
            return;
        }
        hoverPendingId = id;
        hoverTimer = setTimeout(() => {
            hoverTimer = null;
            hoverPendingId = null;
            hoverId = id;
            showHovercard(li, id);
        }, HOVERCARD_DELAY_MS);
    });
    listEl.addEventListener("mouseout", (e) => {
        const to = e.relatedTarget;
        if (to && to.closest && to.closest(".term-item")) return; // moved onto another tab
        hideHovercard();
    });
    listEl.addEventListener("focusin", (e) => {
        if (hoverPointer) return; // a click focused this tab — the hover path owns mouse
        const li = e.target.closest(".term-item");
        if (!li) return;
        if (hoverTimer) {
            clearTimeout(hoverTimer);
            hoverTimer = null;
        }
        hoverPendingId = null;
        hoverId = li.dataset.id;
        showHovercard(li, li.dataset.id);
    });
    listEl.addEventListener("focusout", (e) => {
        const to = e.relatedTarget;
        if (to && to.closest && to.closest(".term-item")) return;
        hideHovercard();
    });
    // A click focuses the tab button; flag it so the ensuing focusin doesn't
    // pop the card on every click. Cleared next tick (focusin runs synchronously
    // right after mousedown, before this timer).
    listEl.addEventListener("mousedown", () => {
        hoverPointer = true;
        setTimeout(() => {
            hoverPointer = false;
        }, 0);
        hideHovercard();
    });
    window.addEventListener("scroll", hideHovercard, true);
}

function renderSearchItem(tab) {
    const li = document.createElement("li");
    li.className = "term-item is-search";
    li.dataset.id = tab.id;
    if (tab.id === activeId) li.classList.add("active");

    const label = document.createElement("button");
    label.type = "button";
    label.className = "term-item-label";
    label.title = tab.title || "Search";

    const name = document.createElement("span");
    name.className = "term-item-name";
    name.appendChild(searchIcon());

    const title = document.createElement("span");
    title.className = "term-item-title";
    title.textContent = tab.title || "Search";
    name.appendChild(title);

    const sub = document.createElement("span");
    sub.className = "term-item-cwd is-summary";
    sub.textContent = "project search";
    sub.title = "project search";

    label.append(name, sub);
    label.addEventListener("click", () => activate(tab.id));

    const closer = makeCloser(tab.id, "search", tab.title || "Search");
    li.append(label, closer);
    return li;
}

function renderList(tabs) {
    hideHovercard(); // the hovered <li> is about to be torn down
    listEl.replaceChildren();
    for (const s of tabs) {
        ensureFrame(s); // pre-mount so connections persist while switching

        if (s.kind === "search") {
            listEl.appendChild(renderSearchItem(s));
            continue;
        }

        const li = document.createElement("li");
        li.className = "term-item";
        li.dataset.id = s.id;
        if (s.id === activeId) li.classList.add("active");

        // Reorder by dragging the tab itself — the whole row is the handle, no grip
        // glyph. Drags that start on the close slider, fork button, or an open
        // rename input are ignored so those keep working; drop logic is wired once
        // on listEl (wireListDnd).
        li.draggable = true;
        wireTabDrag(li, s.id);

        const label = document.createElement("button");
        label.type = "button";
        label.className = "term-item-label";
        // Full title/summary/cwd surface on hover via the tab hovercard (no native
        // title= — its ~0.5s OS delay isn't tunable and it can't be styled).

        const name = document.createElement("span");
        name.className = "term-item-name";

        const dot = document.createElement("span");
        applyDot(dot, s);

        const title = document.createElement("span");
        title.className = "term-item-title";
        title.textContent = s.title;
        title.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            startRename(li, label, s);
        });

        name.append(dot, title);
        applyDead(name, s);

        const sub = document.createElement("span");
        sub.className = "term-item-cwd";
        const { text, isSummary } = subInfo(s);
        sub.textContent = text;
        if (isSummary) sub.classList.add("is-summary");

        label.append(name, sub);
        label.addEventListener("click", () => activate(s.id));

        // Slide-to-close (custom vertical slider). Built by makeCloser; sliding
        // all the way down IS the confirmation, so no prompt.
        const closer = makeCloser(s.id, "term", s.title);

        // Fork: open a new terminal that resumes THIS tab's Claude session as a
        // divergent copy. Enabled only once the session has a recorded id (i.e.
        // `claude` has run ≥1 turn here, so the live hook captured session_id).
        const fork = document.createElement("button");
        fork.type = "button";
        fork.className = "term-item-fork";
        fork.appendChild(forkIcon());
        applyForkState(fork, s);
        fork.addEventListener("click", (e) => {
            e.stopPropagation();
            forkSession(s.id);
        });

        li.append(label, fork, closer);
        listEl.appendChild(li);
    }

    // Drop iframes whose tab no longer exists.
    const live = new Set(tabs.map((t) => t.id));
    for (const [id, f] of frames) {
        if (!live.has(id)) {
            f.remove();
            frames.delete(id);
            if (activeId === id) activeId = null;
        }
    }
    currentIdsKey = idsKey(tabs);
    if (emptyEl) emptyEl.hidden = frames.size > 0;
}

// Update dot + summary on existing items in place — no DOM teardown, so the
// active selection, focus, and live iframes are untouched.
function patchStatus(sessions) {
    for (const s of sessions) {
        const li = listEl.querySelector(`.term-item[data-id="${s.id}"]`);
        if (!li) continue;
        const dot = li.querySelector(".term-status-dot");
        if (dot) applyDot(dot, s);
        const name = li.querySelector(".term-item-name");
        if (name) applyDead(name, s);
        // Keep the tab label in sync with the live last-command title, unless the
        // user is mid-rename on this tab (the input is a sibling of the label).
        if (!li.querySelector(".term-item-rename-input")) {
            const titleEl = li.querySelector(".term-item-title");
            if (titleEl && titleEl.textContent !== s.title) titleEl.textContent = s.title;
        }
        const sub = li.querySelector(".term-item-cwd");
        if (sub) {
            const { text, isSummary } = subInfo(s);
            sub.textContent = text;
            sub.classList.toggle("is-summary", isSummary);
        }
        // Keep the fork button in sync without a full re-render — a bare shell that
        // just started `claude` gains a sessionId mid-poll, which should enable it.
        const fork = li.querySelector(".term-item-fork");
        if (fork) applyForkState(fork, s);
    }
    // Keep an open hovercard's summary live as polls land (patch keeps the <li>).
    if (hoverId && hoverEl && !hoverEl.hidden) {
        const li = listEl.querySelector(`.term-item[data-id="${hoverId}"]`);
        if (li) showHovercard(li, hoverId);
    }
}

async function fetchSessions() {
    const r = await fetch("/api/terminals");
    return await r.json();
}

async function load() {
    let sessions = [];
    let reached = true;
    try {
        sessions = await fetchSessions();
    } catch {
        sessions = [];
        reached = false; // "the server didn't answer" is NOT "you have no terminals"
    }
    // Only reconcile against a real answer: pruning against a fabricated empty
    // list would wipe every seen-stamp, and every tab would flash unread again
    // the moment the server came back.
    if (reached) reconcileSeen(sessions);
    lastSessions = sessions;
    const tabs = buildTabs(sessions);
    renderList(tabs);
    if (tabs.length && (!activeId || !frames.has(activeId))) {
        // Re-select the tab that was active before a reload (if it still exists),
        // so it — the one the user is looking at — reattaches at its real size.
        // Falls back to the first tab (e.g. first ever load, or it was closed).
        let want = null;
        try { want = localStorage.getItem(ACTIVE_TERM_KEY); } catch { /* unavailable */ }
        const pick = want && tabs.some((t) => t.id === want) ? want : tabs[0].id;
        activate(pick);
    }
}

// Poll: patch in place when the tab set is unchanged; re-render only when tabs
// (terminals or search tabs) were added/removed.
async function refresh() {
    let sessions;
    try {
        sessions = await fetchSessions();
    } catch {
        return;
    }
    reconcileSeen(sessions);
    lastSessions = sessions;
    const tabs = buildTabs(sessions);
    if (idsKey(tabs) !== currentIdsKey) {
        renderList(tabs);
        if (tabs.length && (!activeId || !frames.has(activeId))) activate(tabs[0].id);
    } else {
        patchStatus(sessions);
    }
}

// Re-render the list from current client state (after adding/closing a search
// tab). Server-driven refreshes go through load()/refresh().
function rerender() {
    renderList(buildTabs(lastSessions));
    if (!activeId && frames.size) activate(frames.keys().next().value);
}

// ── actions ─────────────────────────────────────────────────────────────────

function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = false;
}
function clearError() {
    if (errEl) errEl.hidden = true;
}

function flashSaved() {
    if (!savedTag) return;
    savedTag.hidden = false;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
        savedTag.hidden = true;
    }, 1500);
}

async function createSession(cwd) {
    clearError();
    let data;
    try {
        const r = await fetch("/api/terminals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: cwd || undefined }),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data && data.error ? data.error : "failed to create terminal");
    } catch (e) {
        showError(e.message || String(e));
        return;
    }
    await load();
    activate(data.id);
}

// Inline-rename a tab. The label is a <button> (can't nest an <input>), so we
// hide it and drop a text input in its place inside the <li>. Enter/blur commits
// (empty clears the custom name → reverts to the auto last-command title); Escape
// cancels. The PATCH persists customTitle server-side; load() re-renders with it.
function startRename(li, label, s) {
    if (li.querySelector(".term-item-rename-input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "term-item-rename-input";
    input.value = s.customTitle || "";
    input.placeholder = s.baseTitle || s.title || "name";
    input.setAttribute("aria-label", "rename terminal");
    label.hidden = true;
    li.insertBefore(input, label.nextSibling);
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit) => {
        if (done) return;
        done = true;
        input.remove();
        label.hidden = false;
        if (!commit) return;
        const v = input.value.trim();
        if (v === (s.customTitle || "")) return; // unchanged
        try {
            await fetch(`/api/terminals/${s.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: v }),
            });
        } catch {
            /* leave the label as-is; next poll reflects server truth */
        }
        await load();
    };

    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
    });
    input.addEventListener("blur", () => finish(true));
    // Keep clicks/drags on the input from bubbling to the tab (activate/close).
    for (const ev of ["click", "pointerdown", "dblclick"]) {
        input.addEventListener(ev, (e) => e.stopPropagation());
    }
}

async function closeSession(id) {
    try {
        await fetch(`/api/terminals/${id}`, { method: "DELETE" });
    } catch {
        /* still drop it locally */
    }
    const f = frames.get(id);
    if (f) {
        f.remove();
        frames.delete(id);
    }
    if (activeId === id) activeId = null;
    await load();
    if (!activeId && frames.size) activate(frames.keys().next().value);
}

// The fork glyph — a small git-branch icon, built with createElementNS to match
// this file's no-innerHTML DOM style. `stroke: currentColor` so it inherits the
// button's muted/accent/disabled colors.
function forkIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({
        viewBox: "0 0 16 16", width: "12", height: "12", fill: "none",
        stroke: "currentColor", "stroke-width": "1.4",
        "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    })) svg.setAttribute(k, v);
    const parts = [
        ["circle", { cx: "4", cy: "3.5", r: "1.6" }],
        ["circle", { cx: "4", cy: "12.5", r: "1.6" }],
        ["circle", { cx: "12", cy: "5.5", r: "1.6" }],
        ["path", { d: "M4 5.1v5.8" }],
        ["path", { d: "M12 7.1c0 3-4 2.6-6.2 3.9" }],
    ];
    for (const [tag, attrs] of parts) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        svg.appendChild(el);
    }
    return svg;
}

// The search glyph shown on a search tab's name — a small magnifier, built with
// createElementNS to match this file's no-innerHTML DOM style.
function searchIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({
        viewBox: "0 0 16 16", width: "12", height: "12", fill: "none",
        stroke: "currentColor", "stroke-width": "1.5",
        "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    })) svg.setAttribute(k, v);
    svg.classList.add("term-item-search-glyph");
    const parts = [
        ["circle", { cx: "7", cy: "7", r: "4.2" }],
        ["path", { d: "M10.2 10.2 14 14" }],
    ];
    for (const [tag, attrs] of parts) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        svg.appendChild(el);
    }
    return svg;
}

// Open a new project-search tab (pinned above the terminals) and select it.
function newSearchTab() {
    const id = `search-${Date.now().toString(36)}`;
    searchTabs = [...searchTabs, { id, title: "Search" }];
    saveSearchTabs();
    rerender();
    activate(id);
}

// Close a search tab: drop it from client state + tear down its iframe.
function closeSearchTab(id) {
    searchTabs = searchTabs.filter((t) => t.id !== id);
    saveSearchTabs();
    const f = frames.get(id);
    if (f) {
        f.remove();
        frames.delete(id);
    }
    if (activeId === id) activeId = null;
    rerender();
}

// Open a repo file (clicked in a search tab) in a NEW terminal tab, at the given
// line (vim +N). Always a fresh tab — never types into a running session — then
// switch to it so the file is on screen.
async function openInTerminal(path, line) {
    clearError();
    try {
        const r = await fetch("/api/terminals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ open: { path, line: line ?? undefined } }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data && data.error ? data.error : "failed to open file");
        await load();
        activate(data.id);
    } catch (e) {
        showError(e.message || String(e));
    }
}

// Bridge from the search-tab iframe: it posts {type:"skua-open", path, line}.
window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== "skua-open" || typeof d.path !== "string") return;
    const line = typeof d.line === "number" && isFinite(d.line) ? d.line : null;
    openInTerminal(d.path, line);
});

// Enable the fork button only when the tab has a Claude session id to resume, and
// keep its tooltip/aria in sync. Shared by first render and in-place polling.
function applyForkState(el, s) {
    const ok = !!s.sessionId;
    el.disabled = !ok;
    el.title = ok
        ? "Fork this conversation into a new terminal"
        : "Run `claude` here first — then you can fork it";
    el.setAttribute("aria-label", ok ? `fork ${s.title}` : `fork ${s.title} (no session yet)`);
}

// Fork a tab: ask the server to open a new terminal that resumes the tab's Claude
// session as a divergent copy, in the SAME cwd. Resolve the session from
// lastSessions at click time so we never act on a stale sessionId. Mirrors
// createSession() (auto-selects the new tab).
async function forkSession(id) {
    const s = lastSessions.find((x) => x.id === id);
    if (!s || !s.sessionId) return;
    clearError();
    let data;
    try {
        const r = await fetch("/api/terminals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                cwd: s.cwd || undefined,
                title: `fork: ${s.title}`,
                fork: { sessionId: s.sessionId },
            }),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data && data.error ? data.error : "failed to fork terminal");
    } catch (e) {
        showError(e.message || String(e));
        return;
    }
    await load();
    activate(data.id);
}

// Build a slide-to-close control (track div + thumb div, no native <input> or
// vendor pseudo-elements) and wire it. `kind` decides whether the close hits the
// terminal DELETE endpoint or just drops the client-side search tab.
function makeCloser(id, kind, title) {
    const closer = document.createElement("div");
    closer.className = "term-item-close";
    closer.tabIndex = 0;
    closer.title = "slide down to close";
    closer.setAttribute("role", "slider");
    closer.setAttribute("aria-orientation", "vertical");
    closer.setAttribute("aria-label", `slide down to close ${title}`);
    closer.setAttribute("aria-valuemin", "0");
    closer.setAttribute("aria-valuemax", "100");
    closer.setAttribute("aria-valuenow", "0");
    const thumb = document.createElement("div");
    thumb.className = "term-item-close-thumb";
    closer.appendChild(thumb);
    wireCloseSlider(closer, id, kind);
    return closer;
}

// Wire one tab's slide-to-close slider. Progress `f` runs 0 (top, open) → 1
// (bottom, close); CSS positions the thumb from the `--f` custom property.
// Reaching CLOSE_AT closes the tab (once). Operable by pointer drag and by
// keyboard: ↓/→ and End slide toward close, ↑/←/Home back toward open.
function wireCloseSlider(el, id, kind) {
    let f = 0;
    let closing = false;
    const clamp = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
    const setF = (next) => {
        f = clamp(next);
        el.style.setProperty("--f", String(f));
        el.setAttribute("aria-valuenow", String(Math.round(f * 100)));
        if (f >= CLOSE_AT && !closing) {
            closing = true; // fire once — the close re-renders and drops this node
            if (kind === "search") closeSearchTab(id);
            else closeSession(id);
        }
    };
    // Relative drag: progress moves by how far the pointer travels from where it
    // was pressed, not by absolute position — so a plain click does nothing and
    // only a deliberate downward slide closes. A full capsule-length drag = 0→1.
    let startY = 0;
    let startF = 0;
    el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add("is-dragging"); // disables the thumb's snap transition
        startY = e.clientY;
        startF = f;
    });
    el.addEventListener("pointermove", (e) => {
        if (!el.hasPointerCapture(e.pointerId)) return;
        const h = el.getBoundingClientRect().height;
        setF(startF + (e.clientY - startY) / h);
    });
    const release = () => {
        if (!el.classList.contains("is-dragging")) return;
        el.classList.remove("is-dragging");
        if (!closing) setF(0); // released short of the bottom — snap back to open
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("click", (e) => e.stopPropagation());

    el.addEventListener("keydown", (e) => {
        const STEP = 0.2;
        switch (e.key) {
            case "ArrowDown":
            case "ArrowRight": setF(f + STEP); break;
            case "ArrowUp":
            case "ArrowLeft": setF(f - STEP); break;
            case "Home": setF(0); break;
            case "End": setF(1); break;
            default: return;
        }
        e.preventDefault();
        e.stopPropagation();
    });
}

// ── sidebar drawer ────────────────────────────────────────────────────────────

// Collapse the left panel to a thin rail (the chevron stays put to reopen).
// State persists across reloads; the button's label/title reflect the action
// it will perform next.
function setCollapsed(collapsed) {
    mainEl.classList.toggle("sidebar-collapsed", collapsed);
    if (collapsed) setUtilsOpen(false);
    if (collapseBtn) {
        const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
        collapseBtn.title = label;
        collapseBtn.setAttribute("aria-label", label);
        collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    }
    try {
        localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
        /* persistence best-effort */
    }
}

try {
    if (localStorage.getItem(COLLAPSED_KEY) === "1") setCollapsed(true);
} catch {
    /* localStorage unavailable — start expanded */
}

if (collapseBtn) {
    collapseBtn.addEventListener("click", () =>
        setCollapsed(!mainEl.classList.contains("sidebar-collapsed")),
    );
}

// ── draggable sidebar width ─────────────────────────────────────────────────
// The .term-resizer handle on the sidebar/stage seam sets --term-sidebar-w
// (an inline var on main) live as you drag; the value persists across reloads.
// Pointer capture keeps mouse-moves flowing to the handle even while the cursor
// is over the terminal <iframe> (which otherwise swallows them); the
// .is-resizing class also drops the iframe's pointer-events as a belt-and-braces
// fallback. Collapsed rail is a fixed width, so dragging is a no-op there.
let sidebarWidth = SIDEBAR_W_DEFAULT;

function sidebarMax() {
    // Never let the sidebar crowd out the terminal past a usable minimum.
    return Math.max(SIDEBAR_W_MIN, Math.min(680, window.innerWidth - 240));
}

function clampSidebarWidth(w) {
    return Math.round(Math.max(SIDEBAR_W_MIN, Math.min(sidebarMax(), w)));
}

function applySidebarWidth(w) {
    sidebarWidth = w;
    mainEl.style.setProperty("--term-sidebar-w", `${w}px`);
}

function saveSidebarWidth(w) {
    try {
        localStorage.setItem(SIDEBAR_W_KEY, String(w));
    } catch {
        /* persistence best-effort */
    }
}

try {
    const saved = parseInt(localStorage.getItem(SIDEBAR_W_KEY) || "", 10);
    if (Number.isFinite(saved)) applySidebarWidth(clampSidebarWidth(saved));
} catch {
    /* localStorage unavailable — keep the CSS default */
}

if (resizer) {
    let dragging = false;

    resizer.addEventListener("pointerdown", (e) => {
        if (mainEl.classList.contains("sidebar-collapsed")) return;
        dragging = true;
        mainEl.classList.add("is-resizing");
        try {
            resizer.setPointerCapture(e.pointerId);
        } catch {
            /* capture unsupported — the .is-resizing fallback still works */
        }
        e.preventDefault();
    });

    resizer.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const left = mainEl.getBoundingClientRect().left;
        applySidebarWidth(clampSidebarWidth(e.clientX - left));
    });

    const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        mainEl.classList.remove("is-resizing");
        try {
            resizer.releasePointerCapture(e.pointerId);
        } catch {
            /* ignore */
        }
        saveSidebarWidth(sidebarWidth);
    };
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);

    // Double-click restores the default width.
    resizer.addEventListener("dblclick", () => {
        applySidebarWidth(SIDEBAR_W_DEFAULT);
        saveSidebarWidth(SIDEBAR_W_DEFAULT);
    });

    // Keyboard: arrow keys nudge the width when the handle is focused.
    resizer.addEventListener("keydown", (e) => {
        if (mainEl.classList.contains("sidebar-collapsed")) return;
        let next = sidebarWidth;
        if (e.key === "ArrowLeft") next -= 16;
        else if (e.key === "ArrowRight") next += 16;
        else return;
        e.preventDefault();
        applySidebarWidth(clampSidebarWidth(next));
        saveSidebarWidth(sidebarWidth);
    });

    // Keep the width inside the max as the window shrinks.
    window.addEventListener("resize", () => {
        const clamped = clampSidebarWidth(sidebarWidth);
        if (clamped !== sidebarWidth) applySidebarWidth(clamped);
    });
}

// ── number-key tab switching ──────────────────────────────────────────────────
// Press 1–9 (no modifier) to jump to the Nth tab in the sidebar, counted in the
// order shown (search tabs first, then terminals). Only fires when focus is on
// the dashboard chrome — while you're typing in a terminal the iframe owns the
// keystroke, so digits reach the shell as usual. Text inputs (rename / cwd /
// search) and open modals are skipped so digits there still type digits.
document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const ae = document.activeElement;
    const tag = ae ? ae.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (ae && ae.isContentEditable)) return;
    if (document.querySelector(".modal:not([hidden])")) return;
    const li = listEl.querySelectorAll(".term-item")[n - 1];
    if (!li) return;
    e.preventDefault();
    activate(li.dataset.id);
});

// ── utils dropdown ──────────────────────────────────────────────────────────────
// The centered caret reveals the theme picker, default-dir form and vim-tips
// button below the toolbar. Closes on outside click, Escape, or collapse.
function setUtilsOpen(open) {
    if (!utilsPanel || !utilsToggle) return;
    utilsPanel.hidden = !open;
    utilsToggle.setAttribute("aria-expanded", String(open));
}

if (utilsToggle && utilsPanel) {
    utilsToggle.addEventListener("click", () => setUtilsOpen(utilsPanel.hidden));
    document.addEventListener("click", (e) => {
        if (utilsPanel.hidden) return;
        if (utilsToggle.contains(e.target) || utilsPanel.contains(e.target)) return;
        setUtilsOpen(false);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !utilsPanel.hidden) setUtilsOpen(false);
    });
}

// ── color scheme picker ───────────────────────────────────────────────────────
// Populate the dropdown from the shared registry (terminal-schemes.js) and
// persist the choice to localStorage. Writing localStorage fires a `storage`
// event in every same-origin terminal <iframe> — they recolor live (see
// terminal-xterm.js). The registry is a window global set by the classic script
// loaded before this module; guard in case it somehow didn't load.
function wireSchemePicker() {
    if (!schemeSelect || !window.SKUA_TERM_SCHEMES) return;
    const KEY = window.SKUA_TERM_SCHEME_KEY;

    schemeSelect.replaceChildren();
    const entries = Object.entries(window.SKUA_TERM_SCHEMES).sort((a, b) =>
        a[1].label.localeCompare(b[1].label),
    );
    // Split into Dark / Light with real <optgroup>s rather than a disabled
    // "──────" option: the browser renders the group label natively, it can't be
    // selected by accident, and screen readers announce the grouping.
    const groups = [
        ["Dark", entries.filter(([, s]) => !s.light)],
        ["Light", entries.filter(([, s]) => s.light)],
    ];
    for (const [groupLabel, groupEntries] of groups) {
        if (!groupEntries.length) continue;
        const group = document.createElement("optgroup");
        group.label = groupLabel;
        for (const [id, { label }] of groupEntries) {
            const opt = document.createElement("option");
            opt.value = id;
            opt.textContent = label;
            group.appendChild(opt);
        }
        schemeSelect.appendChild(group);
    }

    let saved = null;
    try {
        saved = localStorage.getItem(KEY);
    } catch {
        /* localStorage unavailable — fall back to the default */
    }
    schemeSelect.value = window.skuaTermScheme(saved);

    schemeSelect.addEventListener("change", () => {
        try {
            localStorage.setItem(KEY, schemeSelect.value);
        } catch {
            /* persistence best-effort; the live iframes won't update without it */
        }
    });
}
wireSchemePicker();

newBtn.addEventListener("click", () => createSession(cwdInput.value.trim()));
if (searchNewBtn) searchNewBtn.addEventListener("click", newSearchTab);

// ── tips modals (vim + claude) ─────────────────────────────────────────────────
// The Neovim / Terminal / Claude quick references moved into the shared help
// (?) modal in the navbar; components/howto.js owns their wiring now.

cwdForm.addEventListener("submit", (e) => {
    e.preventDefault();
    clearError();
    try {
        localStorage.setItem(CWD_KEY, cwdInput.value.trim());
    } catch {
        /* persistence best-effort */
    }
    flashSaved();
});

wireListDnd(); // once — the list element persists across renders
wireHovercard(); // once — delegated hover/focus on the persistent list element
load();
setInterval(refresh, POLL_MS);
