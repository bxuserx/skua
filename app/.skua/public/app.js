// Kanban board. One horizontal Scratch Pad row above six lifecycle columns;
// archive lazy-loaded.

import { escapeHtml as esc } from "/components/html-utils.js";

// ── Sort state ─────────────────────────────────────────────────────────────
let sortKey = "id";
let sortDir = "asc";
let currentBucketData = {};

const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

function idNum(id) {
  const m = String(id).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function sortItems(items) {
  const arr = [...items];
  arr.sort((a, b) => {
    let cmp = 0;
    if (sortKey === "id") {
      cmp = idNum(a.id) - idNum(b.id);
    } else if (sortKey === "priority") {
      cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
      if (cmp === 0) cmp = idNum(a.id) - idNum(b.id);
    } else if (sortKey === "domain") {
      cmp = String(a.domain ?? "").localeCompare(String(b.domain ?? ""));
      if (cmp === 0) cmp = idNum(a.id) - idNum(b.id);
    } else if (sortKey === "created") {
      cmp = String(a.created ?? "").localeCompare(String(b.created ?? ""));
      if (cmp === 0) cmp = idNum(a.id) - idNum(b.id);
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
  return arr;
}

// ── Manual per-column order (localStorage) ─────────────────────────────────
// Only consulted when the global sort is the default (id-asc). Keys are
// `skua.column-order.<bucket>` → JSON array of ticket IDs in user-set order.

const ORDER_KEY_PREFIX = "skua.column-order.";

function isDefaultSort() {
  return sortKey === "id" && sortDir === "asc";
}

function loadOrder(bucket) {
  try {
    const raw = localStorage.getItem(ORDER_KEY_PREFIX + bucket);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveOrder(bucket, ids) {
  const seen = new Set();
  const deduped = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  try {
    if (deduped.length === 0) localStorage.removeItem(ORDER_KEY_PREFIX + bucket);
    else localStorage.setItem(ORDER_KEY_PREFIX + bucket, JSON.stringify(deduped));
  } catch { /* quota or disabled */ }
}

function removeFromOrder(bucket, id) {
  const order = loadOrder(bucket);
  const next = order.filter((x) => x !== id);
  if (next.length !== order.length) saveOrder(bucket, next);
}

function addToOrderBottom(bucket, id) {
  const order = loadOrder(bucket);
  if (order.includes(id)) return;
  order.push(id);
  saveOrder(bucket, order);
}

function applyManualOrder(items, bucket) {
  const naturallySorted = sortItems(items);
  if (!isDefaultSort()) return naturallySorted;
  const order = loadOrder(bucket);
  if (order.length === 0) return naturallySorted;
  const byId = new Map(naturallySorted.map((t) => [t.id, t]));
  const positioned = [];
  for (const id of order) {
    const t = byId.get(id);
    if (t) {
      positioned.push(t);
      byId.delete(id);
    }
  }
  const remaining = naturallySorted.filter((t) => byId.has(t.id));
  return [...positioned, ...remaining];
}

// Strip any IDs from each bucket's order that no longer live in that bucket
// (handles AI-driven moves, archive-on-complete, deletes). Run after every
// bucket fetch so stale IDs don't resurrect old positions.
function pruneOrders(bucketData) {
  for (const bucket of Object.keys(bucketData)) {
    const order = loadOrder(bucket);
    if (order.length === 0) continue;
    const present = new Set((bucketData[bucket] ?? []).map((t) => t.id));
    const filtered = order.filter((id) => present.has(id));
    if (filtered.length !== order.length) saveOrder(bucket, filtered);
  }
}

const BUCKETS = [
  { id: "0-backlog", label: "Backlog" },
  { id: "1-staging", label: "Staging" },
  { id: "2-stuck", label: "Stuck" },
  { id: "3-building", label: "Building" },
  { id: "4-testing", label: "Testing" },
  { id: "5-validating", label: "Validating" },
  { id: "6-complete", label: "Complete" },
  { id: "7-archive", label: "Archive" },
];

// ── View mode + hidden columns (localStorage) ──────────────────────────────
const VIEW_MODE_KEY = "skua.view-mode";
const HIDDEN_COLS_KEY = "skua.hidden-columns";
const SCRATCH_COLLAPSED_KEY = "skua.scratch-pad-collapsed";

function loadViewMode() {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "cards";
  } catch { return "cards"; }
}
function saveViewMode(mode) {
  try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* ignore */ }
}
function loadHiddenColumns() {
  try {
    const raw = localStorage.getItem(HIDDEN_COLS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch { return new Set(); }
}
function saveHiddenColumns(set) {
  try {
    const arr = [...set];
    if (arr.length === 0) localStorage.removeItem(HIDDEN_COLS_KEY);
    else localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify(arr));
  } catch { /* ignore */ }
}
function loadScratchPadCollapsed() {
  try { return localStorage.getItem(SCRATCH_COLLAPSED_KEY) === "1"; }
  catch { return false; }
}
function saveScratchPadCollapsed(collapsed) {
  try {
    if (collapsed) localStorage.setItem(SCRATCH_COLLAPSED_KEY, "1");
    else localStorage.removeItem(SCRATCH_COLLAPSED_KEY);
  } catch { /* ignore */ }
}

let viewMode = loadViewMode();
const hiddenColumns = loadHiddenColumns();
let scratchPadCollapsed = loadScratchPadCollapsed();

const board = document.getElementById("board");
const scratchPadRow  = document.getElementById("scratch-pad-row");
const scratchPadList = document.getElementById("scratch-pad-list");
const scratchPadCount = document.getElementById("scratch-pad-count");
const scratchPadToggle = document.getElementById("scratch-pad-toggle");

function cardEl(t) {
  const a = document.createElement("a");
  a.className =
    "card" +
    (viewMode === "list" ? " compact" : ` prio-${cssClass(t.priority)}`);
  a.href = `/ticket/${t.id}`;
  a.draggable = true;
  a.dataset.id = t.id;
  a.dataset.bucket = t.bucket;
  if (viewMode === "list") {
    a.innerHTML = `
      <span class="prio-dot prio-${cssClass(t.priority)}" aria-label="Priority ${esc(t.priority)}"></span>
      <span class="id">${esc(t.id)}</span>
      <span class="dom-text dom-${cssClass(t.domain)}">${esc(t.domain)}</span>
      <span class="title"></span>`;
    a.querySelector(".title").textContent = t.title;
  } else {
    const tagsHtml = t.tags.length
      ? `<div class="meta">${t.tags
          .slice(0, 3)
          .map((tag) => `<span class="pill">${esc(tag)}</span>`)
          .join("")}</div>`
      : "";
    a.innerHTML = `
      <div class="card-header">
        <div class="id">${esc(t.id)}</div>
        <span class="dom-text dom-${cssClass(t.domain)}">${esc(t.domain)}</span>
      </div>
      <div class="title"></div>
      ${tagsHtml}`;
    a.setAttribute("aria-label", `Priority ${t.priority}`);
    a.querySelector(".title").textContent = t.title;
  }
  // Hover tooltip — same singleton + position logic for both view modes.
  a.addEventListener("mouseenter", (e) => showListTooltip(t, e));
  a.addEventListener("mousemove", (e) => positionTooltip(e));
  a.addEventListener("mouseleave", hideListTooltip);
  a.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", t.id);
    e.dataTransfer.effectAllowed = "move";
    a.style.opacity = "0.5";
    a.classList.add("being-dragged");
    hideListTooltip();
  });
  a.addEventListener("dragend", () => {
    a.style.opacity = "1";
    a.classList.remove("being-dragged");
    clearPlaceholder();
  });
  return a;
}

// ── Drop placeholder (visual insertion indicator) ──────────────────────────
let dropPlaceholder = null;
function getPlaceholder() {
  if (!dropPlaceholder) {
    dropPlaceholder = document.createElement("div");
    dropPlaceholder.className = "drop-placeholder";
  }
  return dropPlaceholder;
}
function clearPlaceholder() {
  if (dropPlaceholder && dropPlaceholder.parentNode) {
    dropPlaceholder.parentNode.removeChild(dropPlaceholder);
  }
}
function insertionIndexFor(list, draggedCard, clientY) {
  const cards = [...list.querySelectorAll(".card")].filter((c) => c !== draggedCard);
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return cards.length;
}

function cssClass(s) {
  return String(s).replace(/[^a-zA-Z0-9-]/g, "-");
}

// Custom floating tooltip for list-mode rows. One singleton element shared
// across all rows; populated and positioned on hover.
let tooltipEl = null;
function getTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "skua-tt";
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}
function showListTooltip(t, evt) {
  const tt = getTooltip();
  const tagsHtml = t.tags && t.tags.length
    ? `<div class="skua-tt-tags">${t.tags
        .slice(0, 6)
        .map((tag) => `<span class="pill">${esc(tag)}</span>`)
        .join("")}</div>`
    : "";
  const hintHtml = t.next_step_hint
    ? `<div class="skua-tt-next"><span class="skua-tt-next-label">Next:</span> <span class="skua-tt-next-text"></span></div>`
    : "";
  tt.innerHTML = `
    <div class="skua-tt-title"></div>
    <div class="skua-tt-meta">
      <span class="dom-text dom-${cssClass(t.domain)}">${esc(t.domain)}</span>
      <span class="skua-tt-sep">·</span>
      <span class="prio-text prio-${cssClass(t.priority)}">${esc(t.priority)}</span>
      ${t.created ? `<span class="skua-tt-sep">·</span><span class="skua-tt-muted">${esc(t.created)}</span>` : ""}
    </div>
    ${hintHtml}
    ${tagsHtml}`;
  tt.querySelector(".skua-tt-title").textContent = t.title;
  if (t.next_step_hint) {
    tt.querySelector(".skua-tt-next-text").textContent = t.next_step_hint;
  }
  tt.hidden = false;
  positionTooltip(evt);
}
function positionTooltip(evt) {
  if (!tooltipEl || tooltipEl.hidden) return;
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
function hideListTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

function colEl(bucket) {
  const col = document.createElement("section");
  col.className = "col" + (bucket.id === "7-archive" ? " archive" : "");
  col.dataset.bucket = bucket.id;
  col.innerHTML = `
    <h2>
      <span class="swatch"></span>${bucket.label}<span class="count">0</span>
      <button class="col-hide" type="button" title="Hide column" aria-label="Hide column">×</button>
    </h2>
    <div class="list"></div>`;
  col.querySelector(".col-hide").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hiddenColumns.add(bucket.id);
    saveHiddenColumns(hiddenColumns);
    applyHiddenColumns();
    renderHiddenColsStrip();
  });
  const list = col.querySelector(".list");

  if (bucket.id === "7-archive") {
    const btn = document.createElement("button");
    btn.className = "load-btn";
    btn.textContent = "Load archive";
    btn.addEventListener("click", async () => {
      btn.remove();
      const items = await fetch("/api/buckets/7-archive").then((r) => r.json());
      renderColumn(col, items);
    });
    list.appendChild(btn);
  }

  // Bulk action: move every ticket in Validating → Complete in one click.
  if (bucket.id === "5-validating") {
    const btn = document.createElement("button");
    btn.className = "col-action-btn";
    btn.type = "button";
    btn.textContent = "Complete all";
    btn.title = "Move all tickets in Validating to Complete";
    btn.addEventListener("click", () => completeAllValidating(col, btn));
    col.querySelector("h2").insertAdjacentElement("afterend", btn);
  }

  wireDrop(list, col, bucket.id);
  return col;
}

function wireDrop(dropZone, container, bucketId) {
  // Only lifecycle columns support intra-column reorder; the scratch pad row
  // is a horizontal track and stays out of scope per TKT-149.
  const supportsReorder = bucketId !== "scratch";

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    container.classList.add("dropping");
    if (!supportsReorder) { clearPlaceholder(); return; }
    const draggedCard = document.querySelector(".card.being-dragged");
    if (!draggedCard) { clearPlaceholder(); return; }
    // Placeholder only shows when the drop will reorder within the same bucket
    // under the default sort (the only mode where manual order is honored).
    if (draggedCard.dataset.bucket !== bucketId || !isDefaultSort()) {
      clearPlaceholder();
      return;
    }
    const idx = insertionIndexFor(dropZone, draggedCard, e.clientY);
    const cards = [...dropZone.querySelectorAll(".card")].filter((c) => c !== draggedCard);
    const ph = getPlaceholder();
    if (idx >= cards.length) dropZone.appendChild(ph);
    else dropZone.insertBefore(ph, cards[idx]);
  });
  dropZone.addEventListener("dragleave", (e) => {
    // Only clear the dropping class when the cursor actually leaves the zone,
    // not when it crosses between child cards.
    if (!dropZone.contains(e.relatedTarget)) {
      container.classList.remove("dropping");
      clearPlaceholder();
    }
  });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    container.classList.remove("dropping");
    const id = e.dataTransfer.getData("text/plain");
    if (!id) { clearPlaceholder(); return; }
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (!card) { clearPlaceholder(); return; }

    const fromBucket = card.dataset.bucket;

    // Intra-column reorder
    if (fromBucket === bucketId) {
      if (!supportsReorder || !isDefaultSort()) { clearPlaceholder(); return; }
      const ph = dropPlaceholder;
      if (ph && ph.parentNode === dropZone) {
        dropZone.insertBefore(card, ph);
      } else {
        const idx = insertionIndexFor(dropZone, card, e.clientY);
        const others = [...dropZone.querySelectorAll(".card")].filter((c) => c !== card);
        if (idx >= others.length) dropZone.appendChild(card);
        else dropZone.insertBefore(card, others[idx]);
      }
      clearPlaceholder();
      const ids = [...dropZone.querySelectorAll(".card")].map((c) => c.dataset.id);
      saveOrder(bucketId, ids);
      return;
    }

    // Cross-column move (existing semantics: land at bottom of destination)
    clearPlaceholder();
    dropZone.appendChild(card);
    card.dataset.bucket = bucketId;
    removeFromOrder(fromBucket, id);
    // Only seed the destination's order if it already has one. Adding a lone
    // entry to a previously-unordered column would surface that ticket above
    // every naturally-sorted sibling on the next render.
    if (supportsReorder && loadOrder(bucketId).length > 0) addToOrderBottom(bucketId, id);
    refreshCounts();
    try {
      const res = await fetch(`/api/tickets/${id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: bucketId }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      alert("move failed: " + err.message);
      location.reload();
    }
  });
}

// Move every ticket currently in the Validating column to Complete. Fires the
// moves sequentially so a mid-batch failure leaves the rest of the board
// untouched, then re-syncs from the server.
async function completeAllValidating(col, btn) {
  const ids = [...col.querySelectorAll(".card")].map((c) => c.dataset.id);
  if (ids.length === 0) return;
  if (!confirm(`Move ${ids.length} ticket(s) from Validating to Complete?`)) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Completing…";
  try {
    for (const id of ids) {
      const res = await fetch(`/api/tickets/${id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "6-complete" }),
      });
      if (!res.ok) throw new Error(`${id}: ${await res.text()}`);
      removeFromOrder("5-validating", id);
    }
  } catch (err) {
    alert("complete all failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    await poll();
  }
}

function renderColumn(col, items) {
  const list = col.querySelector(".list");
  list.innerHTML = "";
  const ordered = applyManualOrder(items, col.dataset.bucket);
  for (const t of ordered) list.appendChild(cardEl(t));
  updateCount(col);
}

function rerenderAll() {
  // Any card under the cursor is about to be replaced; the new card won't fire
  // mouseenter at the current position, so hide the tooltip to avoid orphaning.
  hideListTooltip();
  renderScratchPadRow(currentBucketData["scratch"] ?? []);
  for (const b of BUCKETS) {
    if (b.id === "7-archive") continue;
    const col = board.querySelector(`.col[data-bucket="${b.id}"]`);
    if (col) renderColumn(col, currentBucketData[b.id] ?? []);
  }
}
function renderScratchPadRow(items) {
  scratchPadList.innerHTML = "";
  for (const t of items) scratchPadList.appendChild(cardEl(t));
  scratchPadCount.textContent = items.length;
}
function updateCount(col) {
  col.querySelector(".count").textContent =
    col.querySelectorAll(".card").length;
}
function refreshCounts() {
  document.querySelectorAll(".col").forEach(updateCount);
  scratchPadCount.textContent = scratchPadList.querySelectorAll(".card").length;
}

// ── Sort controls ──────────────────────────────────────────────────────────

const sortKeyEl = document.getElementById("sort-key");
const sortDirBtn = document.getElementById("sort-dir");

sortKeyEl.addEventListener("change", () => {
  sortKey = sortKeyEl.value;
  rerenderAll();
});
sortDirBtn.addEventListener("click", () => {
  sortDir = sortDir === "asc" ? "desc" : "asc";
  sortDirBtn.textContent = sortDir === "asc" ? "↑" : "↓";
  rerenderAll();
});

// ── View-mode toggle ───────────────────────────────────────────────────────

const viewModeBtn = document.getElementById("view-mode-btn");

function updateViewModeBtnLabel() {
  viewModeBtn.textContent = viewMode === "list" ? "List" : "Cards";
  viewModeBtn.dataset.mode = viewMode;
}
updateViewModeBtnLabel();

viewModeBtn.addEventListener("click", () => {
  viewMode = viewMode === "cards" ? "list" : "cards";
  saveViewMode(viewMode);
  updateViewModeBtnLabel();
  rerenderAll();
});

// ── Hidden columns ─────────────────────────────────────────────────────────

const hiddenColsStrip = document.getElementById("hidden-cols-strip");

function applyHiddenColumns() {
  for (const b of BUCKETS) {
    const col = board.querySelector(`.col[data-bucket="${b.id}"]`);
    if (!col) continue;
    col.classList.toggle("col-hidden", hiddenColumns.has(b.id));
  }
  // Relax the per-column max-width when anything is hidden so the visible
  // columns flex to fill the freed horizontal space.
  board.classList.toggle("has-hidden-cols", hiddenColumns.size > 0);
}

function renderHiddenColsStrip() {
  hiddenColsStrip.innerHTML = "";
  if (hiddenColumns.size === 0) {
    hiddenColsStrip.hidden = true;
    return;
  }
  hiddenColsStrip.hidden = false;
  for (const b of BUCKETS) {
    if (!hiddenColumns.has(b.id)) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "hidden-col-chip";
    chip.dataset.bucket = b.id;
    chip.title = `Show ${b.label}`;
    chip.innerHTML = `<span class="swatch"></span><span class="label">${esc(b.label)}</span><span class="plus" aria-hidden="true">+</span>`;
    chip.addEventListener("click", () => {
      hiddenColumns.delete(b.id);
      saveHiddenColumns(hiddenColumns);
      applyHiddenColumns();
      renderHiddenColsStrip();
    });
    hiddenColsStrip.appendChild(chip);
  }
}

// ── Modal ──────────────────────────────────────────────────────────────────

const modal = document.getElementById("create-modal");
const form  = document.getElementById("create-form");
const mStatus = document.getElementById("m-status");

function openModal() {
  modal.hidden = false;
  loadDomainSuggestions().catch(() => { /* ignore */ });
  setTimeout(() => document.getElementById("m-title").focus(), 0);
}
function closeModal() {
  modal.hidden = true;
  form.reset();
  mStatus.textContent = "";
  const acc = form.querySelector("details.accordion");
  if (acc) acc.open = false;
}

async function loadDomainSuggestions() {
  const list = document.getElementById("m-domain-list");
  if (!list || list.dataset.loaded === "1") return;
  try {
    const domains = await fetch("/api/domains").then((r) => r.json());
    list.innerHTML = domains.map((d) => `<option value="${esc(d)}">`).join("");
    list.dataset.loaded = "1";
  } catch { /* leave empty */ }
}

document.getElementById("scratch-pad-btn").addEventListener("click", openModal);

// ── Scratch Pad minimize toggle ────────────────────────────────────────────

function applyScratchPadCollapsed() {
  scratchPadRow.classList.toggle("collapsed", scratchPadCollapsed);
  scratchPadToggle.textContent = scratchPadCollapsed ? "▸" : "▾";
  scratchPadToggle.setAttribute("aria-expanded", scratchPadCollapsed ? "false" : "true");
  scratchPadToggle.title = scratchPadCollapsed ? "Expand Scratch Pad" : "Minimize Scratch Pad";
}
applyScratchPadCollapsed();

scratchPadToggle.addEventListener("click", () => {
  scratchPadCollapsed = !scratchPadCollapsed;
  saveScratchPadCollapsed(scratchPadCollapsed);
  applyScratchPadCollapsed();
});

// Force-expand the collapsed row while any card is being dragged so the
// existing wireDrop hook on #scratch-pad-list remains reachable.
document.addEventListener("dragstart", (e) => {
  if (e.target instanceof Element && e.target.classList.contains("card")) {
    scratchPadRow.classList.add("drag-active");
  }
});
document.addEventListener("dragend", () => {
  scratchPadRow.classList.remove("drag-active");
});
modal.addEventListener("click", (e) => {
  if (e.target.matches("[data-modal-close]")) closeModal();
});

// The how-to modal (#howto-modal) is injected by server.ts and wired by the
// shared howto.js module, so its open/close/Escape handling lives there now.

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!modal.hidden) closeModal();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  mStatus.textContent = "creating…";
  const payload = {
    title:    form.title.value.trim(),
    priority: form.priority.value,
    body:     form.body.value,
    domain:   form.domain.value.trim() || undefined,
    tags:        form.tags.value,
    depends_on:  form.depends_on.value,
    blocks:      form.blocks.value,
    related:     form.related.value,
  };
  // complexity: "auto" → omit so the AI sets it during refinement;
  // 1–5 → send as int.
  const cVal = form.complexity?.value;
  if (cVal && cVal !== "auto") payload.complexity = parseInt(cVal, 10);
  try {
    const res = await fetch("/api/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const created = await res.json();
    scratchPadList.appendChild(cardEl(created));
    scratchPadCount.textContent = scratchPadList.querySelectorAll(".card").length;
    closeModal();
  } catch (err) {
    mStatus.textContent = "error: " + err.message;
  }
});

// Make the Scratch Pad row a drop target so cards can be demoted back if a
// user changes their mind. (Symmetric with the lifecycle columns.)
wireDrop(scratchPadList, scratchPadRow, "scratch");

// ── Active-flows chip bar (TKT-169 agentic flow, TKT-196 multi-flow) ───────
// Polls /api/stacks/active and renders one chip per active flow. Each chip
// links to its lead ticket; the X dismisses locally (persisted in
// localStorage).

const DISMISSED_STACKS_KEY = "skua.dismissed-stacks";

const stackFlowsBar    = document.getElementById("stack-flows-bar");
const stackFlowsChips  = document.getElementById("stack-flows-chips");

function loadDismissedStacks() {
  try {
    const raw = localStorage.getItem(DISMISSED_STACKS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e) => e && typeof e === "object"
        && typeof e.id === "string"
        && typeof e.status_at_dismiss === "string",
    );
  } catch { return []; }
}
function saveDismissedStacks(arr) {
  try {
    if (arr.length === 0) localStorage.removeItem(DISMISSED_STACKS_KEY);
    else localStorage.setItem(DISMISSED_STACKS_KEY, JSON.stringify(arr));
  } catch { /* ignore */ }
}

function isDismissed(record, dismissed) {
  if (!record || typeof record.id !== "string") return false;
  const match = dismissed.find((d) => d.id === record.id);
  if (!match) return false;
  // Re-show the chip if the underlying status has changed since dismissal.
  return match.status_at_dismiss === (record.status ?? "");
}

function chipEl(record) {
  const id = typeof record.id === "string" ? record.id : "(no id)";
  const status = typeof record.status === "string" ? record.status : "";
  const members = Array.isArray(record.members) ? record.members : [];
  const lead = typeof members[0] === "string" ? members[0] : null;

  const chip = document.createElement("a");
  chip.className = "stack-flow-chip";
  chip.dataset.stackId = id;
  chip.setAttribute("role", "listitem");
  if (lead) {
    chip.href = `/ticket/${lead}`;
    chip.title = `Open ${lead} (stack ${id}, status ${status})`;
  } else {
    chip.href = "#";
    chip.title = `Stack ${id} — no member tickets`;
  }
  chip.innerHTML =
    `<span class="warn" aria-hidden="true">⚠</span>`
    + `<span class="id"></span>`
    + `<span class="status"></span>`;
  chip.querySelector(".id").textContent = lead ?? id;
  chip.querySelector(".status").textContent = status;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "stack-flow-chip-dismiss";
  dismiss.setAttribute("aria-label", `Dismiss flow ${id}`);
  dismiss.title = "Dismiss (flow keeps running)";
  dismiss.textContent = "×";
  dismiss.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dismissed = loadDismissedStacks().filter((d) => d.id !== id);
    dismissed.push({ id, status_at_dismiss: status });
    saveDismissedStacks(dismissed);
    renderActiveFlows(lastActiveList);
  });
  chip.appendChild(dismiss);

  return chip;
}

let lastActiveList = [];

function renderActiveFlows(list) {
  lastActiveList = Array.isArray(list) ? list : [];
  // GC dismissed entries whose stack is no longer active.
  const activeIds = new Set(
    lastActiveList
      .map((r) => (r && typeof r.id === "string" ? r.id : null))
      .filter(Boolean),
  );
  const dismissed = loadDismissedStacks();
  const gc = dismissed.filter((d) => activeIds.has(d.id));
  if (gc.length !== dismissed.length) saveDismissedStacks(gc);

  const visible = lastActiveList.filter((r) => !isDismissed(r, gc));
  stackFlowsChips.innerHTML = "";
  if (visible.length === 0) {
    stackFlowsBar.hidden = true;
    return;
  }
  stackFlowsBar.hidden = false;
  for (const record of visible) {
    stackFlowsChips.appendChild(chipEl(record));
  }
}

async function pollActiveFlows() {
  try {
    const r = await fetch("/api/stacks/active");
    const data = await r.json();
    const list = Array.isArray(data.active_list)
      ? data.active_list
      : (data.active ? [data.active] : []);
    renderActiveFlows(list);
  } catch { /* transient */ }
}

// ── Boot & polling ─────────────────────────────────────────────────────────

const POLL_MS = 5000;

async function boot() {
  for (const b of BUCKETS) board.appendChild(colEl(b));
  applyHiddenColumns();
  renderHiddenColsStrip();
  const data = await fetch("/api/buckets").then((r) => r.json());
  pruneOrders(data);
  currentBucketData = data;
  window.skuaCurrentBucketData = data;
  renderScratchPadRow(data["scratch"] ?? []);
  for (const b of BUCKETS) {
    if (b.id === "7-archive") continue; // lazy
    const col = board.querySelector(`.col[data-bucket="${b.id}"]`);
    renderColumn(col, data[b.id] ?? []);
  }
}

async function poll() {
  // Skip re-render while the user is mid-drag
  if (document.querySelector(".card.being-dragged")) return;
  try {
    const data = await fetch("/api/buckets").then((r) => r.json());
    pruneOrders(data);
    currentBucketData = data;
    window.skuaCurrentBucketData = data;
    rerenderAll();
  } catch { /* ignore transient fetch errors */ }
}

boot()
  .then(() => {
    setInterval(poll, POLL_MS);
    pollActiveFlows();
    setInterval(pollActiveFlows, POLL_MS);
  })
  .catch((e) => { document.body.append("boot error: " + e.message); });
