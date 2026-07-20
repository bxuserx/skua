// List view for /adrs. Renders the table of ADRs from GET /api/adrs.
// Status filter is client-side over the fetched list (small N — no
// server-side pagination needed).

import { escapeHtml } from "/components/html-utils.js";

const listEl = document.getElementById("adrs-list");
const filterEl = document.getElementById("status-filter");

let allAdrs = [];

async function load() {
  try {
    const res = await fetch("/api/adrs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allAdrs = await res.json();
    render();
  } catch (e) {
    listEl.innerHTML = `<p class="adrs-empty error">failed to load: ${escapeHtml(String(e))}</p>`;
  }
}

function render() {
  const status = filterEl.value;
  const filtered =
    status === "all" ? allAdrs : allAdrs.filter((a) => a.status === status);
  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="adrs-empty">no ADRs with status "${escapeHtml(status)}"</p>`;
    return;
  }
  const rows = filtered.map((adr) => {
    const dateLabel = adr.decided
      ? `decided ${adr.decided}`
      : `proposed ${adr.created}`;
    const draftCount =
      (adr.proposed_count ?? 0) + (adr.materialized_count ?? 0);
    return `
            <a class="adr-row" href="/adrs/${escapeHtml(adr.id)}">
                <div class="adr-row-head">
                    <span class="adr-id">${escapeHtml(adr.id)}</span>
                    <span class="adr-status adr-status-${escapeHtml(adr.status)}">${escapeHtml(adr.status)}</span>
                    <span class="adr-title">${escapeHtml(adr.title)}</span>
                </div>
                <div class="adr-row-meta">
                    <span>${escapeHtml(dateLabel)}</span>
                    <span class="dot">·</span>
                    <span>${adr.related_tickets?.length ?? 0} related tickets</span>
                    <span class="dot">·</span>
                    <span>${draftCount} drafts/materialized</span>
                    ${adr.domain ? `<span class="dot">·</span><span class="adr-domain">${escapeHtml(adr.domain)}</span>` : ""}
                </div>
            </a>
        `;
  });
  listEl.innerHTML = rows.join("");
}

filterEl.addEventListener("change", render);

// ---------------------------------------------------------------------------
// Create-ADR modal — opens via the toolbar button, composes a full ADR body
// from the per-section textareas, POSTs to /api/adrs, refreshes the list on
// success. Errors render INSIDE the modal (no alert). Mirrors the modal
// pattern from adr.js (TKT-216).
// ---------------------------------------------------------------------------

const createBtn = document.getElementById("create-adr-btn");
const createModal = document.getElementById("create-adr-modal");
const createForm = document.getElementById("create-adr-form");
const createCancel = document.getElementById("create-adr-cancel");
const createClose = document.getElementById("create-adr-close");
const createSubmit = document.getElementById("create-adr-submit");
const createError = document.getElementById("create-adr-error");

function openCreateModal() {
  createForm.reset();
  document.getElementById("cadr-deciders").value = "bx";
  createError.hidden = true;
  createError.textContent = "";
  createSubmit.disabled = false;
  createSubmit.textContent = "Create ADR";
  createModal.showModal();
  requestAnimationFrame(() => document.getElementById("cadr-title").focus());
}

function closeCreateModal() {
  if (createModal.open) createModal.close();
}

function showCreateError(msg) {
  createError.textContent = msg;
  createError.hidden = false;
}

function composeBody(fields) {
  // Order matches the template + the section-render expectations of adr.js.
  // Top-level sections with empty content emit a "_(none provided)_"
  // placeholder so structure is predictable. The Decision section is
  // standardized into 4 sub-categories (TKT-220): Approach +
  // Rationale (required), Scope + Reversibility (optional, omitted when
  // empty).
  const out = [];
  function push(heading, content) {
    out.push(`### ${heading}`);
    out.push("");
    out.push(content.trim() || `_(none provided)_`);
    out.push("");
  }
  function pushSub(heading, content, { skipIfEmpty } = {}) {
    const t = content.trim();
    if (skipIfEmpty && !t) return;
    out.push(`#### ${heading}`);
    out.push("");
    out.push(t || `_(none provided)_`);
    out.push("");
  }

  push("TL;DR", fields.tldr);

  // Decision: Approach is required; Scope + Reversibility are optional and
  // emitted only when filled. Context + Rationale are filled in during the
  // enrichment pass (Researcher or User-Driven), not at create-time.
  out.push("### Decision");
  out.push("");
  pushSub("Approach", fields.decision_chosen);
  pushSub("Scope", fields.decision_scope, { skipIfEmpty: true });
  pushSub("Reversibility", fields.decision_reversibility, {
    skipIfEmpty: true,
  });

  push("Consequences", fields.consequences);
  push("Alternatives considered", fields.alternatives);
  return out.join("\n");
}

async function submitCreate(event) {
  event.preventDefault();
  const fields = {
    title: document.getElementById("cadr-title").value.trim(),
    domain: document.getElementById("cadr-domain").value,
    complexity: document.getElementById("cadr-complexity").value,
    deciders: document.getElementById("cadr-deciders").value.trim(),
    tags: document.getElementById("cadr-tags").value.trim(),
    related_tickets: document.getElementById("cadr-related").value.trim(),
    supersedes: document.getElementById("cadr-supersedes").value.trim(),
    tldr: document.getElementById("cadr-tldr").value.trim(),
    decision_chosen: document
      .getElementById("cadr-decision-chosen")
      .value.trim(),
    decision_scope: document.getElementById("cadr-decision-scope").value.trim(),
    decision_reversibility: document
      .getElementById("cadr-decision-reversibility")
      .value.trim(),
    consequences: document.getElementById("cadr-consequences").value.trim(),
    alternatives: document.getElementById("cadr-alternatives").value.trim(),
  };
  if (!fields.title) {
    showCreateError("Title is required.");
    return;
  }
  if (!fields.tldr) {
    showCreateError("TL;DR is required.");
    return;
  }
  if (!fields.decision_chosen) {
    showCreateError("Decision → Approach is required.");
    return;
  }

  const payload = {
    title: fields.title,
    domain: fields.domain || "meta",
    deciders: fields.deciders,
    tags: fields.tags,
    related_tickets: fields.related_tickets,
    supersedes: fields.supersedes,
    body: composeBody(fields),
  };
  if (fields.complexity) payload.complexity = fields.complexity;

  createSubmit.disabled = true;
  createSubmit.textContent = "Creating…";
  try {
    const res = await fetch("/api/adrs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      showCreateError(
        `Create failed: ${errBody.error ?? `HTTP ${res.status}`}`,
      );
      createSubmit.disabled = false;
      createSubmit.textContent = "Create ADR";
      return;
    }
    const created = await res.json();
    closeCreateModal();
    // Refresh list so the new ADR appears. Optionally navigate to it:
    //   location.href = `/adrs/${created.id}`;
    // For now we just refresh + leave the user on the list to confirm.
    await load();
  } catch (e) {
    showCreateError(`Create failed: ${e?.message ?? e}`);
    createSubmit.disabled = false;
    createSubmit.textContent = "Create ADR";
  }
}

createBtn.addEventListener("click", openCreateModal);
createCancel.addEventListener("click", closeCreateModal);
createClose.addEventListener("click", closeCreateModal);
createForm.addEventListener("submit", submitCreate);
createModal.addEventListener("click", (e) => {
  if (e.target === createModal) closeCreateModal();
});

load();
