// Navbar ticket search. Self-initialising; finds `#navbar-search` and
// `#navbar-search-results` in the current page and wires both up.
//
// Data source: `window.skuaCurrentBucketData` if the host page already
// fetched `/api/buckets` (board page, app.js poll). Otherwise lazily
// fetches `/api/buckets` on first focus. Archive (`7-archive/`) is
// excluded — search sees backlog → complete.

import { escapeHtml as esc } from "/components/html-utils.js";

const MAX_RESULTS = 8;

let cached = null;           // flat array of ticket summaries
let cacheStamp = 0;
const CACHE_TTL_MS = 5000;

function flatten(bucketData) {
  if (!bucketData || typeof bucketData !== "object") return [];
  const out = [];
  for (const [bucket, items] of Object.entries(bucketData)) {
    if (bucket === "7-archive") continue;
    if (!Array.isArray(items)) continue;
    for (const t of items) out.push(t);
  }
  return out;
}

async function loadTickets() {
  const now = Date.now();
  if (cached && now - cacheStamp < CACHE_TTL_MS) return cached;

  const winData = window.skuaCurrentBucketData;
  if (winData && Object.keys(winData).length > 0) {
    cached = flatten(winData);
    cacheStamp = now;
    return cached;
  }
  try {
    const data = await fetch("/api/buckets").then((r) => r.json());
    cached = flatten(data);
    cacheStamp = now;
    return cached;
  } catch {
    return cached ?? [];
  }
}

function normalizeQuery(raw) {
  const q = String(raw ?? "").trim().toLowerCase();
  if (!q) return { lc: "", digits: "" };
  // "tkt-103" / "tkt 103" / "TKT-103" / "103" → digits "103"
  const digitMatch = q.match(/(?:tkt[\s-]*)?(\d+)/);
  return { lc: q, digits: digitMatch ? digitMatch[1] : "" };
}

function idDigits(id) {
  const m = String(id ?? "").match(/(\d+)/);
  return m ? m[1] : "";
}

function score(ticket, q) {
  if (!q.lc) return -1;
  const id = String(ticket.id ?? "");
  const title = String(ticket.title ?? "").toLowerCase();
  const idLc = id.toLowerCase();
  const digits = idDigits(id);

  // exact id (with or without TKT- prefix)
  if (q.digits && digits === q.digits) return 100;
  // partial id digit match (prefix)
  if (q.digits && digits.startsWith(q.digits)) return 80;
  // partial id digit match (substring)
  if (q.digits && digits.includes(q.digits)) return 70;
  // full id substring (e.g. "tkt-1")
  if (idLc.includes(q.lc)) return 60;
  // title substring
  if (title.includes(q.lc)) return 40;
  return -1;
}

function search(tickets, raw) {
  const q = normalizeQuery(raw);
  if (!q.lc) return [];
  const scored = [];
  for (const t of tickets) {
    const s = score(t, q);
    if (s > 0) scored.push({ t, s });
  }
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    // tie-break: smaller numeric id first
    const an = Number(idDigits(a.t.id)) || 0;
    const bn = Number(idDigits(b.t.id)) || 0;
    return an - bn;
  });
  return scored.slice(0, MAX_RESULTS).map((x) => x.t);
}

function cssClass(s) {
  return String(s).replace(/[^a-zA-Z0-9-]/g, "-");
}

function rowHtml(t) {
  return `
    <span class="ns-id">${esc(t.id)}</span>
    <span class="ns-dom dom-text dom-${cssClass(t.domain ?? "")}">${esc(t.domain ?? "")}</span>
    <span class="ns-title"></span>`;
}

function init() {
  const input = document.getElementById("navbar-search");
  if (!input) return;

  const results = document.createElement("div");
  results.className = "navbar-search-results";
  results.id = "navbar-search-results";
  results.hidden = true;
  input.parentNode.appendChild(results);

  let current = [];
  let highlight = -1;

  function render() {
    results.innerHTML = "";
    if (current.length === 0) {
      results.hidden = true;
      highlight = -1;
      return;
    }
    current.forEach((t, idx) => {
      const row = document.createElement("a");
      row.className = "ns-row" + (idx === highlight ? " hi" : "");
      row.href = `/ticket/${encodeURIComponent(t.id)}`;
      row.dataset.idx = String(idx);
      row.innerHTML = rowHtml(t);
      row.querySelector(".ns-title").textContent = t.title ?? "";
      row.addEventListener("mouseenter", () => {
        highlight = idx;
        updateHighlight();
      });
      results.appendChild(row);
    });
    results.hidden = false;
  }

  function updateHighlight() {
    [...results.querySelectorAll(".ns-row")].forEach((el, idx) => {
      el.classList.toggle("hi", idx === highlight);
    });
  }

  async function refresh() {
    const tickets = await loadTickets();
    current = search(tickets, input.value);
    highlight = current.length > 0 ? 0 : -1;
    render();
  }

  function close() {
    current = [];
    highlight = -1;
    results.hidden = true;
  }

  input.addEventListener("focus", refresh);
  input.addEventListener("input", refresh);

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      if (current.length === 0) return;
      e.preventDefault();
      highlight = (highlight + 1) % current.length;
      updateHighlight();
    } else if (e.key === "ArrowUp") {
      if (current.length === 0) return;
      e.preventDefault();
      highlight = (highlight - 1 + current.length) % current.length;
      updateHighlight();
    } else if (e.key === "Enter") {
      if (highlight >= 0 && highlight < current.length) {
        e.preventDefault();
        const t = current[highlight];
        window.location.href = `/ticket/${encodeURIComponent(t.id)}`;
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      close();
      input.blur();
    }
  });

  // Click-outside closes the dropdown.
  document.addEventListener("click", (e) => {
    if (e.target === input) return;
    if (results.contains(e.target)) return;
    close();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
