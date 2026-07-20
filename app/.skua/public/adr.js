// Detail view for /adrs/:id. Renders the markdown body + side panel with
// status badge, transition controls (FSM-aware), deciders, related tickets,
// proposed/materialized drafts.

import { escapeHtml } from "/components/html-utils.js";
import { formatBytes } from "/components/format.js";
import { slugify } from "/components/accordion.js";

const LEGAL_TRANSITIONS = {
  proposed: ["accepted", "rejected"],
  accepted: ["superseded", "deprecated"],
  rejected: [],
  superseded: [],
  deprecated: [],
};

const bodyEl = document.getElementById("adr-body");
const sideEl = document.getElementById("adr-side");

const id = location.pathname.replace(/^\/adrs\//, "").replace(/\/$/, "");

async function load() {
  try {
    const res = await fetch(`/api/adrs/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const adr = await res.json();
    render(adr);
  } catch (e) {
    bodyEl.innerHTML = `<p class="adrs-empty error">failed to load ${escapeHtml(id)}: ${escapeHtml(String(e))}</p>`;
  }
}

function render(adr, opts = {}) {
  // opts:
  //   viewVersion: number — render this snapshot version (read-only, no transitions)
  //   isCurrent: boolean — true when adr.frontmatter.version is the canonical current
  const fm = adr.frontmatter ?? {};
  const viewVersion = opts.viewVersion ?? fm.version ?? 1;
  const isCurrent = opts.isCurrent !== false;
  document.title = `${fm.id ?? id} — ${fm.title ?? ""}`;

  const banner = !isCurrent
    ? `<div class="adr-version-banner">Viewing snapshot <strong>v${escapeHtml(String(viewVersion))}</strong> — read-only.
       <a href="#" id="adr-back-to-current">Back to current</a></div>`
    : "";

  bodyEl.innerHTML = `
        ${banner}
        <h1>${escapeHtml(fm.id ?? id)} <span class="adr-title-h1">${escapeHtml(fm.title ?? "")}</span></h1>
        <div class="adr-md">${renderMarkdown(adr.body ?? "")}</div>
    `;

  if (isCurrent) {
    renderCommentsAndReferences().catch((e) => {
      console.error("comments/references render failed", e);
    });
  }

  const back = document.getElementById("adr-back-to-current");
  if (back) {
    back.addEventListener("click", (e) => {
      e.preventDefault();
      load();
    });
  }

  const status = fm.status ?? "proposed";
  const legal = LEGAL_TRANSITIONS[status] ?? [];

  const transitionButtons = !isCurrent
    ? `<p class="hint">snapshot view — transitions disabled</p>`
    : legal.length === 0
      ? `<p class="hint">terminal state — no transitions</p>`
      : legal
          .map(
            (to) =>
              `<button class="btn btn--transition" data-to="${escapeHtml(to)}">→ ${escapeHtml(to)}</button>`,
          )
          .join("");

  const deciders =
    (fm.deciders ?? []).map(escapeHtml).join(", ") || "<em>none</em>";
  const related =
    (fm.related_tickets ?? [])
      .map((t) => `<a href="/ticket/${escapeHtml(t)}">${escapeHtml(t)}</a>`)
      .join(", ") || "<em>none</em>";

  const drafts = (fm.proposed_tickets ?? [])
    .map(
      (d) =>
        `<li><code>${escapeHtml(d.draft_id)}</code> ${escapeHtml(d.title)}</li>`,
    )
    .join("");
  const materialized = (fm.materialized_tickets ?? [])
    .map(
      (m) =>
        `<li><code>${escapeHtml(m.draft_id)}</code> → <a href="/ticket/${escapeHtml(m.ticket_id)}">${escapeHtml(m.ticket_id)}</a></li>`,
    )
    .join("");

  sideEl.innerHTML = `
        <section>
            <h3>Status</h3>
            <div class="adr-status-box">
                <span class="adr-status adr-status-${escapeHtml(status)}">${escapeHtml(status)}</span>
            </div>
            <div class="adr-transitions" id="adr-transitions">${transitionButtons}</div>
            <p class="adr-meta-line"><strong>version:</strong> v${escapeHtml(String(viewVersion))}${isCurrent ? " (current)" : ""}</p>
            <p class="adr-meta-line"><strong>created:</strong> ${escapeHtml(fm.created ?? "")}</p>
            ${fm.decided ? `<p class="adr-meta-line"><strong>decided:</strong> ${escapeHtml(fm.decided)}</p>` : ""}
        </section>
        <section id="adr-versions-section">
            <h3>Versions</h3>
            <select id="adr-version-select" class="adr-version-select" disabled>
                <option>loading…</option>
            </select>
        </section>
        <section>
            <h3>Deciders</h3>
            <p>${deciders}</p>
        </section>
        <section>
            <h3>Related tickets</h3>
            <p>${related}</p>
        </section>
        ${drafts ? `<section><h3>Proposed tickets</h3><ul class="adr-drafts">${drafts}</ul></section>` : ""}
        ${materialized ? `<section><h3>Materialized tickets</h3><ul class="adr-drafts">${materialized}</ul></section>` : ""}
        ${fm.domain ? `<section><h3>Domain</h3><p>${escapeHtml(fm.domain)}</p></section>` : ""}
        ${fm.complexity ? `<section><h3>Complexity</h3><p>${escapeHtml(String(fm.complexity))} / 5</p></section>` : ""}
        ${fm.tags?.length ? `<section><h3>Tags</h3><p>${fm.tags.map(escapeHtml).join(", ")}</p></section>` : ""}
    `;

  sideEl.querySelectorAll(".btn--transition").forEach((btn) => {
    btn.addEventListener("click", () => transition(btn.dataset.to));
  });

  populateVersionDropdown(viewVersion).catch((e) => {
    console.error("version dropdown failed", e);
  });
}

async function populateVersionDropdown(activeVersion) {
  const sel = document.getElementById("adr-version-select");
  if (!sel) return;
  let data;
  try {
    const res = await fetch(`/api/adrs/${id}/versions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    sel.innerHTML = `<option>error</option>`;
    return;
  }
  const versions = (data.versions ?? []).slice();
  // Synthesize the "current" entry so the dropdown always shows the canonical
  // head even if no snapshots have been taken yet.
  versions.push({ version: activeVersion, status_at_snapshot: "current", taken_at: "", reason: "current" });
  // Dedupe + sort desc.
  const byVersion = new Map();
  for (const v of versions) byVersion.set(v.version, v);
  const sorted = Array.from(byVersion.values()).sort((a, b) => b.version - a.version);
  sel.innerHTML = sorted
    .map((v) => {
      const isCur = v.reason === "current";
      const label = `v${v.version}${isCur ? " (current)" : ` · ${v.status_at_snapshot}`}`;
      return `<option value="${v.version}"${v.version === activeVersion ? " selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  sel.disabled = false;
  sel.addEventListener("change", async () => {
    const target = parseInt(sel.value, 10);
    if (target === activeVersion) return;
    // Current head → reload via load(); historical snapshot → fetch snapshot.
    const isHead = sorted.find((v) => v.version === target)?.reason === "current";
    if (isHead) { load(); return; }
    try {
      const r = await fetch(`/api/adrs/${id}/versions/${target}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snap = await r.json();
      render(snap, { viewVersion: target, isCurrent: false });
    } catch (e) {
      console.error("snapshot fetch failed", e);
    }
  });
}

async function renderCommentsAndReferences() {
  const md = bodyEl.querySelector(".adr-md");
  if (!md) return;
  // Comments accordion
  const commentsDetails = document.createElement("details");
  commentsDetails.className = "adr-section adr-section-comments";
  commentsDetails.open = true;
  const commentsSummary = document.createElement("summary");
  commentsSummary.className = "adr-section-h";
  commentsSummary.textContent = "Comments";
  const commentsBody = document.createElement("div");
  commentsBody.className = "adr-comments-body";
  commentsBody.innerHTML = `<p class="hint">loading…</p>`;
  commentsDetails.append(commentsSummary, commentsBody);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "adr-add-comment-btn";
  addBtn.textContent = "+ Add comment";
  addBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCommentModal();
  });
  commentsSummary.appendChild(addBtn);

  md.appendChild(commentsDetails);

  // References accordion
  const refsDetails = document.createElement("details");
  refsDetails.className = "adr-section adr-section-references";
  refsDetails.open = false;
  const refsSummary = document.createElement("summary");
  refsSummary.className = "adr-section-h";
  refsSummary.textContent = "References";
  const refsBody = document.createElement("div");
  refsBody.className = "adr-refs-body";
  refsBody.innerHTML = `<p class="hint">loading…</p>`;
  refsDetails.append(refsSummary, refsBody);
  md.appendChild(refsDetails);

  // Parallel fetch.
  const [cmRes, rfRes] = await Promise.all([
    fetch(`/api/adrs/${id}/comments`).then((r) => r.ok ? r.json() : { comments: [] }).catch(() => ({ comments: [] })),
    fetch(`/api/adrs/${id}/references`).then((r) => r.ok ? r.json() : { references: [] }).catch(() => ({ references: [] })),
  ]);

  const comments = cmRes.comments ?? [];
  if (comments.length === 0) {
    commentsBody.innerHTML = `<p class="hint">No comments yet.</p>`;
  } else {
    commentsBody.innerHTML = comments
      .map(
        (c) => `<div class="adr-comment">
            <div class="adr-comment-head">
                <strong class="adr-comment-author">${escapeHtml(c.author)}</strong>
                <span class="adr-comment-date">— ${escapeHtml(c.date)}</span>
                <span class="adr-comment-version">v${escapeHtml(String(c.version))}</span>
            </div>
            <div class="adr-comment-text">${escapeHtml(c.text)}</div>
        </div>`,
      )
      .join("");
  }

  const refs = rfRes.references ?? [];
  if (refs.length === 0) {
    refsBody.innerHTML = `<p class="hint">No references attached. Researcher mode will populate this folder.</p>`;
  } else {
    refsBody.innerHTML = `<ul class="adr-refs-list">${refs
      .map(
        (r) => `<li><a href="/api/adrs/${escapeHtml(id)}/references/${encodeURIComponent(r.filename)}" target="_blank">${escapeHtml(r.filename)}</a> <small>(${formatBytes(r.size)})</small></li>`,
      )
      .join("")}</ul>`;
  }
}

// Transition flow — opens the in-page <dialog> modal instead of native prompt/alert.
// The modal is defined in adr.html (#transition-modal); we wire submit/cancel/close
// handlers here and reset state on each open.
const modalEl = document.getElementById("transition-modal");
const modalForm = document.getElementById("transition-form");
const modalTitle = document.getElementById("transition-modal-title");
const modalSubhead = document.getElementById("transition-modal-subhead");
const modalDeciders = document.getElementById("transition-deciders");
const modalError = document.getElementById("transition-modal-error");
const modalSubmit = document.getElementById("transition-submit");
const modalCancel = document.getElementById("transition-cancel");
const modalClose = document.getElementById("transition-modal-close");

let pendingTransition = null;

function openTransitionModal(to) {
  pendingTransition = to;
  modalTitle.textContent = `Transition to "${to}"`;
  modalSubhead.textContent = `This will change ADR ${id}'s status to "${to}" and stamp today's date as the decided date.`;
  modalDeciders.value = "bx";
  modalError.hidden = true;
  modalError.textContent = "";
  modalSubmit.disabled = false;
  modalSubmit.textContent = "Confirm";
  modalEl.showModal();
  // Defer focus so it lands after the dialog mounts.
  requestAnimationFrame(() => modalDeciders.focus());
}

function closeTransitionModal() {
  pendingTransition = null;
  if (modalEl.open) modalEl.close();
}

function showModalError(message) {
  modalError.textContent = message;
  modalError.hidden = false;
}

async function submitTransition(event) {
  event.preventDefault();
  if (!pendingTransition) return;
  const to = pendingTransition;
  const decidersStr = modalDeciders.value.trim();
  const deciders = decidersStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (deciders.length === 0) {
    showModalError("At least one decider is required.");
    modalDeciders.focus();
    return;
  }
  modalSubmit.disabled = true;
  modalSubmit.textContent = "Submitting…";
  try {
    const res = await fetch(`/api/adrs/${id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, deciders }),
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      const msg = errorBody.error ?? `HTTP ${res.status}`;
      showModalError(`Transition failed: ${msg}`);
      modalSubmit.disabled = false;
      modalSubmit.textContent = "Confirm";
      return;
    }
    closeTransitionModal();
    load();
  } catch (e) {
    showModalError(`Transition failed: ${e?.message ?? e}`);
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Confirm";
  }
}

modalForm.addEventListener("submit", submitTransition);
modalCancel.addEventListener("click", closeTransitionModal);
modalClose.addEventListener("click", closeTransitionModal);
// Backdrop click closes the modal (clicking the dialog element itself fires
// when the click lands on the ::backdrop because the dialog covers it).
modalEl.addEventListener("click", (event) => {
  if (event.target === modalEl) closeTransitionModal();
});

function transition(to) {
  openTransitionModal(to);
}

// ---------------------------------------------------------------------------
// Comments — append-only via POST /api/adrs/:id/comments. Each comment is
// stamped with the canonical version at write-time and stored in the ADR
// folder's comments.jsonl. Rendered by renderCommentsAndReferences().
// ---------------------------------------------------------------------------

const commentModal = document.getElementById("comment-modal");
const commentForm = document.getElementById("comment-form");
const commentAuthorInput = document.getElementById("comment-author");
const commentTextInput = document.getElementById("comment-text");
const commentError = document.getElementById("comment-modal-error");
const commentSubmit = document.getElementById("comment-submit");
const commentCancel = document.getElementById("comment-cancel");
const commentClose = document.getElementById("comment-modal-close");

function openCommentModal() {
  commentForm.reset();
  commentAuthorInput.value = "bx";
  commentTextInput.value = "";
  commentError.hidden = true;
  commentError.textContent = "";
  commentSubmit.disabled = false;
  commentSubmit.textContent = "Add comment";
  commentModal.showModal();
  requestAnimationFrame(() => commentTextInput.focus());
}

function closeCommentModal() {
  if (commentModal.open) commentModal.close();
}

function showCommentError(msg) {
  commentError.textContent = msg;
  commentError.hidden = false;
}

async function submitComment(event) {
  event.preventDefault();
  const author = commentAuthorInput.value.trim();
  const text = commentTextInput.value.trim();
  if (!author) {
    showCommentError("Author is required.");
    return;
  }
  if (!text) {
    showCommentError("Comment text is required.");
    return;
  }

  commentSubmit.disabled = true;
  commentSubmit.textContent = "Adding…";
  try {
    const res = await fetch(`/api/adrs/${id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author, text }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      showCommentError(`Add failed: ${errBody.error ?? `HTTP ${res.status}`}`);
      commentSubmit.disabled = false;
      commentSubmit.textContent = "Add comment";
      return;
    }
    closeCommentModal();
    load();
  } catch (e) {
    showCommentError(`Add failed: ${e?.message ?? e}`);
    commentSubmit.disabled = false;
    commentSubmit.textContent = "Add comment";
  }
}

commentForm.addEventListener("submit", submitComment);
commentCancel.addEventListener("click", closeCommentModal);
commentClose.addEventListener("click", closeCommentModal);
commentModal.addEventListener("click", (e) => {
  if (e.target === commentModal) closeCommentModal();
});

// ---------------------------------------------------------------------------
// Delete — hard-removes the ADR folder. Gated by a typed-id confirm so a
// fat-fingered click can't nuke an ADR. Other ADRs that reference this one
// via supersedes / superseded_by aren't auto-rewritten — that's a known
// trade-off documented in the modal copy.
// ---------------------------------------------------------------------------

const deleteBtn = document.getElementById("adr-delete-btn");
const deleteModal = document.getElementById("delete-modal");
const deleteForm = document.getElementById("delete-form");
const deleteConfirm = document.getElementById("delete-confirm");
const deleteError = document.getElementById("delete-modal-error");
const deleteSubmit = document.getElementById("delete-submit");
const deleteCancel = document.getElementById("delete-cancel");
const deleteClose = document.getElementById("delete-modal-close");

function openDeleteModal() {
  deleteConfirm.value = "";
  deleteError.hidden = true;
  deleteError.textContent = "";
  deleteSubmit.disabled = false;
  deleteSubmit.textContent = "Delete";
  deleteModal.showModal();
  requestAnimationFrame(() => deleteConfirm.focus());
}

function closeDeleteModal() {
  if (deleteModal.open) deleteModal.close();
}

function showDeleteError(msg) {
  deleteError.textContent = msg;
  deleteError.hidden = false;
}

async function submitDelete(event) {
  event.preventDefault();
  if (deleteConfirm.value.trim() !== id) {
    showDeleteError(`Type "${id}" exactly to confirm.`);
    deleteConfirm.focus();
    return;
  }
  deleteSubmit.disabled = true;
  deleteSubmit.textContent = "Deleting…";
  try {
    const res = await fetch(`/api/adrs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      showDeleteError(`Delete failed: ${errBody.error ?? `HTTP ${res.status}`}`);
      deleteSubmit.disabled = false;
      deleteSubmit.textContent = "Delete";
      return;
    }
    closeDeleteModal();
    location.href = "/adrs";
  } catch (e) {
    showDeleteError(`Delete failed: ${e?.message ?? e}`);
    deleteSubmit.disabled = false;
    deleteSubmit.textContent = "Delete";
  }
}

deleteBtn.addEventListener("click", openDeleteModal);
deleteForm.addEventListener("submit", submitDelete);
deleteCancel.addEventListener("click", closeDeleteModal);
deleteClose.addEventListener("click", closeDeleteModal);
deleteModal.addEventListener("click", (e) => {
  if (e.target === deleteModal) closeDeleteModal();
});

// Very small markdown subset for body rendering — headings, code spans,
// links, paragraphs, lists, tables. Good enough for ADR bodies; not a full
// CommonMark renderer. If we ever need full fidelity, swap in marked.
//
// Section-aware (TKT-219) + accordion-aware (TKT-220):
//   ### Heading → <details class="adr-section adr-section-<slug>" [open]>
//                   <summary class="adr-section-h">Heading</summary>
//                   ...content...
//                 </details>
//   #### Heading → nested <details class="adr-subsection adr-subsection-<slug>" open>
//                    <summary class="adr-subsection-h">Heading</summary>
//                    ...content...
//                  </details>
// Default-open H3 sections: tldr, decision (per TKT-220 spec). Others
// default-closed for skimmability. Nested H4 sub-sections default-open.
const SECTION_OPEN_BY_DEFAULT = new Set(["tldr", "decision", "comments"]);

function renderMarkdown(md) {
  const lines = md.split("\n");
  const out = [];
  let inList = false;
  let inTable = false;
  let tableHeaderEmitted = false;
  let inCodeBlock = false;
  let codeBlockBuf = [];
  let inSection = false;
  let inSubsection = false;

  function closeList() {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  }
  function closeTable() {
    if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
      tableHeaderEmitted = false;
    }
  }
  function flushCode() {
    if (inCodeBlock) {
      out.push(
        `<pre><code>${escapeHtml(codeBlockBuf.join("\n"))}</code></pre>`,
      );
      codeBlockBuf = [];
      inCodeBlock = false;
    }
  }
  function closeSubsection() {
    if (inSubsection) {
      closeList();
      closeTable();
      out.push("</details>");
      inSubsection = false;
    }
  }
  function closeSection() {
    if (inSection) {
      closeSubsection();
      closeList();
      closeTable();
      out.push("</details>");
      inSection = false;
    }
  }
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) {
      if (inCodeBlock) flushCode();
      else {
        closeList();
        closeTable();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBlockBuf.push(line);
      continue;
    }

    // tables
    if (/^\|/.test(line)) {
      closeList();
      if (/^\|[\s:|\-]+\|$/.test(line)) {
        if (inTable && !tableHeaderEmitted) {
          out.push("</tr></thead><tbody>");
          tableHeaderEmitted = true;
        }
        continue;
      }
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      if (!inTable) {
        out.push(
          "<table><thead><tr>" +
            cells.map((c) => `<th>${inlineMd(c)}</th>`).join("") +
            "</tr>",
        );
        inTable = true;
        tableHeaderEmitted = false;
      } else {
        if (!tableHeaderEmitted) {
          out.push("</tr></thead><tbody>");
          tableHeaderEmitted = true;
        }
        out.push(
          "<tr>" +
            cells.map((c) => `<td>${inlineMd(c)}</td>`).join("") +
            "</tr>",
        );
      }
      continue;
    } else if (inTable) {
      closeTable();
    }

    // headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = h[2];
      // H3 = ADR section boundary. Close any prior section + open a new
      // <details> wrapper. open attribute driven by SECTION_OPEN_BY_DEFAULT.
      if (level === 3) {
        closeSection();
        const slug = slugify(text);
        const openAttr = SECTION_OPEN_BY_DEFAULT.has(slug) ? " open" : "";
        out.push(
          `<details class="adr-section adr-section-${escapeHtml(slug)}"${openAttr}>`,
        );
        out.push(`<summary class="adr-section-h">${inlineMd(text)}</summary>`);
        inSection = true;
        continue;
      }
      // H4 = sub-section boundary inside an H3 section. Nested <details>,
      // default-open so the user sees the structure expanded.
      if (level === 4 && inSection) {
        closeSubsection();
        const slug = slugify(text);
        out.push(
          `<details class="adr-subsection adr-subsection-${escapeHtml(slug)}" open>`,
        );
        out.push(
          `<summary class="adr-subsection-h">${inlineMd(text)}</summary>`,
        );
        inSubsection = true;
        continue;
      }
      // Other heading levels stay as plain headings.
      out.push(`<h${level}>${inlineMd(text)}</h${level}>`);
      continue;
    }
    // list items
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    // blank line
    if (!line.trim()) {
      continue;
    }
    // paragraph
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  closeTable();
  flushCode();
  closeSection();
  return out.join("\n");
}

// Schemes safe to place in an href. Anything else (javascript:, data:,
// vbscript:, …) renders as plain label text so a crafted ADR body can't run
// script when a link is clicked. The href is already escapeHtml'd, so quotes
// can't break the attribute — this guards the scheme.
const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:|\/|#|\.{1,2}\/)/i;

function inlineMd(s) {
  let out = escapeHtml(s);
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  // code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // links — only emit an anchor for a safe-scheme href; otherwise drop to the
  // bare label text.
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, href) => (SAFE_HREF_RE.test(href.trim()) ? `<a href="${href}">${label}</a>` : label),
  );
  return out;
}

load();
