// Search tab client — a Zed ⌘⇧F style project search embedded as an <iframe>
// in the terminal stage. Queries GET /api/search (rg / git grep on the server),
// renders results grouped by file into contiguous ±5-line hunks with matched
// substrings highlighted. All match text goes through textContent + <mark>
// nodes — never innerHTML — so a file's contents can't inject markup.

const params = new URLSearchParams(location.search);
const TAB_ID = params.get("id") || "search";
const LAST_KEY = `skua.search-last.${TAB_ID}`;
const DEBOUNCE_MS = 220;

const form = document.getElementById("wsearch-form");
const input = document.getElementById("wsearch-input");
const caseBtn = document.getElementById("wsearch-case");
const regexBtn = document.getElementById("wsearch-regex");
const metaEl = document.getElementById("wsearch-meta");
const resultsEl = document.getElementById("wsearch-results");
const actionsEl = document.getElementById("wsearch-actions");
const expandBtn = document.getElementById("wsearch-expand");
const collapseBtn = document.getElementById("wsearch-collapse");
const rootEl = document.getElementById("wsearch-root");
const rootPathEl = document.getElementById("wsearch-root-path");

let caseSensitive = false;
let regex = false;
let debounceTimer = null;
let reqSeq = 0; // guards against out-of-order responses

// ── restore last session state (per tab) ──────────────────────────────────────
try {
    const saved = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
    if (saved && typeof saved === "object") {
        input.value = typeof saved.q === "string" ? saved.q : "";
        caseSensitive = !!saved.case;
        regex = !!saved.regex;
    }
} catch {
    /* ignore malformed state */
}
syncToggle(caseBtn, caseSensitive);
syncToggle(regexBtn, regex);

function persist() {
    try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ q: input.value, case: caseSensitive, regex }));
    } catch {
        /* best-effort */
    }
}

function syncToggle(btn, on) {
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", String(on));
}

// ── highlight helpers ──────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build the RegExp used to highlight matched substrings inside a match line.
// Returns null if the user's regex is invalid (we still show the line, unhit).
function highlightRe(query) {
    if (!query) return null;
    const src = regex ? query : escapeRe(query);
    try {
        return new RegExp(src, caseSensitive ? "g" : "gi");
    } catch {
        return null;
    }
}

// Append `text` to `parent`, wrapping the server-supplied [start,end) char
// ranges in <mark>. Preferred over the client RegExp: these are the exact spans
// the search engine matched, so regex-mode highlights can't diverge. Ranges are
// clamped/sorted defensively in case the server ever sends odd offsets.
function appendRanges(parent, text, ranges) {
    const spans = ranges
        .filter((r) => Array.isArray(r) && r.length === 2 && r[1] > r[0])
        .sort((a, b) => a[0] - b[0]);
    let last = 0;
    for (const [s, e] of spans) {
        const a = Math.max(s, last);
        const b = Math.min(e, text.length);
        if (b <= a) continue;
        if (a > last) parent.appendChild(document.createTextNode(text.slice(last, a)));
        const mark = document.createElement("mark");
        mark.className = "wsearch-mark";
        mark.textContent = text.slice(a, b);
        parent.appendChild(mark);
        last = b;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// Append `text` to `parent`, wrapping every `re` hit in <mark>. Zero-width or
// non-global matches are handled defensively so we never loop forever.
function appendHighlighted(parent, text, re) {
    if (!re) {
        parent.appendChild(document.createTextNode(text));
        return;
    }
    re.lastIndex = 0;
    let last = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 5000) {
        if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement("mark");
        mark.className = "wsearch-mark";
        mark.textContent = m[0] || "";
        parent.appendChild(mark);
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++; // avoid infinite loop on empty match
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// ── rendering ──────────────────────────────────────────────────────────────────

function renderMessage(text, cls) {
    resultsEl.replaceChildren();
    if (actionsEl) actionsEl.hidden = true;
    const div = document.createElement("div");
    div.className = cls || "wsearch-hint";
    div.textContent = text;
    resultsEl.appendChild(div);
}

function render(data) {
    resultsEl.replaceChildren();

    if (!data.files.length) {
        renderMessage(`No results for “${data.query}”.`, "wsearch-hint");
        return;
    }
    if (actionsEl) actionsEl.hidden = false;
    const re = highlightRe(data.query);

    const frag = document.createDocumentFragment();
    for (const file of data.files) {
        const section = document.createElement("section");
        section.className = "wsearch-file";
        section.dataset.file = file.file;

        const head = document.createElement("button");
        head.type = "button";
        head.className = "wsearch-file-head";
        head.setAttribute("aria-expanded", "true");

        const caret = document.createElement("span");
        caret.className = "wsearch-caret";
        caret.setAttribute("aria-hidden", "true");
        caret.textContent = "▾";

        const path = document.createElement("span");
        path.className = "wsearch-path";
        path.textContent = file.file;

        const count = document.createElement("span");
        count.className = "wsearch-count";
        count.textContent = String(file.matches);

        head.append(caret, path, count);

        const body = document.createElement("div");
        body.className = "wsearch-hunks";

        for (let h = 0; h < file.hunks.length; h++) {
            if (h > 0) {
                const sep = document.createElement("div");
                sep.className = "wsearch-hunk-sep";
                body.appendChild(sep);
            }
            for (const line of file.hunks[h]) {
                const row = document.createElement("div");
                row.className = "wsearch-row" + (line.match ? " is-match" : "");
                row.dataset.line = String(line.n);
                row.title = "click to open in the terminal";
                const ln = document.createElement("span");
                ln.className = "wsearch-ln";
                ln.textContent = String(line.n);
                const code = document.createElement("code");
                code.className = "wsearch-code";
                if (line.match && Array.isArray(line.ranges) && line.ranges.length) {
                    appendRanges(code, line.text, line.ranges);
                } else if (line.match) {
                    appendHighlighted(code, line.text, re);
                } else {
                    code.textContent = line.text;
                }
                row.append(ln, code);
                body.appendChild(row);
            }
        }

        head.addEventListener("click", () => {
            const collapsed = section.classList.toggle("is-collapsed");
            head.setAttribute("aria-expanded", String(!collapsed));
            caret.textContent = collapsed ? "▸" : "▾";
        });

        section.append(head, body);
        frag.appendChild(section);
    }
    resultsEl.appendChild(frag);
}

function renderMeta(data) {
    const parts = [];
    parts.push(`${data.totalMatches} ${data.totalMatches === 1 ? "result" : "results"}`);
    parts.push(`${data.totalFiles} ${data.totalFiles === 1 ? "file" : "files"}`);
    if (data.truncated) parts.push("truncated");
    if (data.engine) parts.push(data.engine);
    metaEl.textContent = parts.join(" · ");
}

// ── search ───────────────────────────────────────────────────────────────────

async function doSearch() {
    const q = input.value;
    persist();
    if (!q.trim()) {
        metaEl.textContent = "";
        renderMessage("Type a string and press Enter to search every file in the repo.");
        return;
    }
    const seq = ++reqSeq;
    metaEl.textContent = "searching…";
    const url = `/api/search?q=${encodeURIComponent(q)}&case=${caseSensitive ? 1 : 0}&regex=${regex ? 1 : 0}`;
    let data;
    try {
        const r = await fetch(url);
        data = await r.json();
        if (!r.ok) throw new Error(data && data.error ? data.error : "search failed");
    } catch (e) {
        if (seq !== reqSeq) return;
        metaEl.textContent = "";
        renderMessage(e.message || String(e), "wsearch-error");
        return;
    }
    if (seq !== reqSeq) return; // a newer search already superseded this one
    renderMeta(data);
    render(data);
}

function scheduleSearch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, DEBOUNCE_MS);
}

// ── events ─────────────────────────────────────────────────────────────────────

form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (debounceTimer) clearTimeout(debounceTimer);
    doSearch();
});
input.addEventListener("input", scheduleSearch);

caseBtn.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    syncToggle(caseBtn, caseSensitive);
    doSearch();
});
regexBtn.addEventListener("click", () => {
    regex = !regex;
    syncToggle(regexBtn, regex);
    doSearch();
});

// Expand / collapse every file group at once.
function setAllCollapsed(collapsed) {
    for (const section of resultsEl.querySelectorAll(".wsearch-file")) {
        section.classList.toggle("is-collapsed", collapsed);
        const head = section.querySelector(".wsearch-file-head");
        const caret = section.querySelector(".wsearch-caret");
        if (head) head.setAttribute("aria-expanded", String(!collapsed));
        if (caret) caret.textContent = collapsed ? "▸" : "▾";
    }
}
if (expandBtn) expandBtn.addEventListener("click", () => setAllCollapsed(false));
if (collapseBtn) collapseBtn.addEventListener("click", () => setAllCollapsed(true));

// Click a result line → open that file at that line in the terminal. The parent
// (terminal.js) owns which terminal to target; we just ask via postMessage. A
// click that's really a text selection is ignored so results stay selectable.
resultsEl.addEventListener("click", (e) => {
    const row = e.target.closest(".wsearch-row");
    if (!row) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.toString().trim()) return;
    const section = row.closest(".wsearch-file");
    const file = section && section.dataset.file;
    if (!file) return;
    const line = parseInt(row.dataset.line || "0", 10) || null;
    try {
        window.parent.postMessage({ type: "skua-open", path: file, line }, location.origin);
    } catch {
        /* not embedded / cross-origin — click-to-open unavailable */
    }
});

// ⌘/Ctrl+F focuses the box; Esc clears it.
document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        input.focus();
        input.select();
    } else if (e.key === "Escape" && document.activeElement === input && input.value) {
        input.value = "";
        doSearch();
    }
});

// Follow live theme changes from the dashboard (localStorage write in another
// same-origin frame fires `storage` here).
window.addEventListener("storage", (e) => {
    if (e.key !== "skua-theme") return;
    if (e.newValue === "dark" || e.newValue === "light") {
        document.documentElement.dataset.theme = e.newValue;
    } else {
        delete document.documentElement.dataset.theme;
    }
});

// Show the root directory every search runs against, under the search bar.
(async () => {
    try {
        const r = await fetch("/api/search/root");
        const d = await r.json();
        if (d && typeof d.root === "string" && d.root) {
            rootPathEl.textContent = d.root;
            rootEl.title = d.root;
            rootEl.hidden = false;
        }
    } catch {
        /* root strip stays hidden if the endpoint is unreachable */
    }
})();

// Kick off if we restored a query.
if (input.value.trim()) doSearch();
