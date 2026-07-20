import { renderAccordion, slugify } from "/components/accordion.js";
import { escapeHtml } from "/components/html-utils.js";

const id = location.pathname.split("/").pop();
const $ = (sel) => document.querySelector(sel);
const status = $("#status");

let original = null;

const csv  = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const ucsv = (a) => (a ?? []).join(", ");

async function loadDomains() {
  const list = $("#domain-list");
  try {
    const domains = await fetch("/api/domains").then((r) => r.json());
    list.innerHTML = domains.map((d) => `<option value="${escapeHtml(d)}">`).join("");
  } catch { /* leave empty — input still accepts free text */ }
}

async function load() {
  const r = await fetch(`/api/tickets/${id}`);
  if (!r.ok) { status.textContent = "load failed"; return; }
  const t = await r.json();
  original = t;
  document.title = `${t.id} — ${t.title}`;
  $("#f-id").textContent   = t.frontmatter.id ?? t.id;
  $("#f-title").value      = t.frontmatter.title ?? t.title;
  $("#f-bucket").value     = t.bucket;
  $("#f-priority").value   = t.frontmatter.priority ?? "Medium";
  $("#f-domain").value     = t.frontmatter.domain ?? "meta";
  $("#f-tags").value       = ucsv(t.frontmatter.tags);
  $("#f-complexity").value = typeof t.frontmatter.complexity === "number"
    ? String(t.frontmatter.complexity)
    : "auto";
  $("#f-depends_on").value = ucsv(t.frontmatter.depends_on);
  $("#f-blocks").value     = ucsv(t.frontmatter.blocks);
  $("#f-related").value    = ucsv(t.frontmatter.related);
  renderBodySections(t.body ?? "");
  status.textContent = "";
  renderImplSummary(t);
  renderFilesTouched(t);
}

function renderFilesTouched(t) {
  const panel = $("#files-touched");
  const list  = $("#files-list");
  const meta  = $("#files-meta");
  const files = t.frontmatter.files_touched ?? [];
  if (files.length === 0) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }
  panel.hidden = false;
  meta.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
  list.innerHTML = files
    .map((f) => `<li>${escapeHtml(f)}</li>`)
    .join("");
}

// ── Body sections (initial plan accordions) ───────────────────────────────
//
// The ticket body is markdown with `### Section` headers. We split it into
// one accordion per section so each is editable in isolation; on save we
// recompose the full body in original header order.

function parseBodySections(body) {
  const re = /^###\s+(.+?)\s*$/gm;
  const matches = [...body.matchAll(re)];
  if (matches.length === 0) return { prelude: body, sections: [] };
  const prelude = matches[0].index > 0 ? body.slice(0, matches[0].index) : "";
  const sections = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    return {
      header: m[1].trim(),
      content: body.slice(start, end).replace(/^\n+/, "").replace(/\n+$/, ""),
    };
  });
  return { prelude: prelude.replace(/\n+$/, ""), sections };
}

function renderBodySections(body) {
  const container = $("#f-body-sections");
  const { prelude, sections } = parseBodySections(body);
  let html = "";
  if (prelude || sections.length === 0) {
    html += `<textarea data-prelude class="ticket-section-textarea" placeholder="content before first section">${escapeHtml(prelude)}</textarea>`;
  }
  sections.forEach((s, i) => {
    html += renderAccordion({
      title: s.header,
      open: true,
      contentHtml: `<textarea class="ticket-section-textarea" data-section="${i}">${escapeHtml(s.content)}</textarea>`,
    });
  });
  container.innerHTML = html;
  container.dataset.headers = JSON.stringify(sections.map((s) => s.header));

  // Auto-fit each textarea to its content; re-fit on input and when a
  // section is expanded (a collapsed <details> has 0 scrollHeight).
  container.querySelectorAll("textarea").forEach((ta) => {
    autosize(ta);
    ta.addEventListener("input", () => autosize(ta));
  });
  container.querySelectorAll("details.adr-section").forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open) d.querySelectorAll("textarea").forEach(autosize);
    });
  });
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

function readBodySections() {
  const container = $("#f-body-sections");
  const headers = JSON.parse(container.dataset.headers || "[]");
  const preludeEl = container.querySelector("[data-prelude]");
  const prelude = preludeEl ? preludeEl.value.replace(/\n+$/, "") : "";
  const parts = [];
  if (prelude.trim()) parts.push(prelude);
  headers.forEach((h, i) => {
    const ta = container.querySelector(`[data-section="${i}"]`);
    const content = ta ? ta.value.replace(/\n+$/, "") : "";
    parts.push(`### ${h}\n${content}`);
  });
  return parts.join("\n\n") + "\n";
}

// ── Implementation summary panel ──────────────────────────────────────────

const POST_IMPL_BUCKETS = new Set(["4-testing", "5-validating", "6-complete", "7-archive"]);

function parseImplSummary(body) {
  const match = body.match(/###\s+Implementation Summary\n([\s\S]*?)(?=\n###\s|$)/);
  if (!match) return null;
  const section = match[1].trim();
  if (!section || section.startsWith("<Empty") || section.startsWith("<!--")) return null;

  const mainBullets = [], deviations = [], notes = [];
  let current = "main";

  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (/^\*\*Deviations/.test(line)) { current = "dev"; continue; }
    if (/^\*\*Implementation [Nn]otes/.test(line)) { current = "notes"; continue; }
    if (line.startsWith("- ")) {
      const text = line.slice(2).trim();
      if (current === "main") mainBullets.push(text);
      else if (current === "dev") deviations.push(text);
      else notes.push(text);
    }
  }
  if (!mainBullets.length && !deviations.length && !notes.length) return null;
  return { mainBullets, deviations, notes };
}

function renderBullets(listEl, items) {
  listEl.innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
}

function renderImplSummary(t) {
  const panel = $("#impl-summary-field");
  if (!POST_IMPL_BUCKETS.has(t.bucket)) { panel.hidden = true; return; }
  const parsed = parseImplSummary(t.body ?? "");
  if (!parsed) { panel.hidden = true; return; }

  renderBullets($("#impl-main-list"), parsed.mainBullets);

  const devSec = $("#impl-deviations-section");
  if (parsed.deviations.length) {
    renderBullets($("#impl-deviations-list"), parsed.deviations);
    devSec.hidden = false;
  } else {
    devSec.hidden = true;
  }

  const notesSec = $("#impl-notes-section");
  if (parsed.notes.length) {
    renderBullets($("#impl-notes-list"), parsed.notes);
    notesSec.hidden = false;
  } else {
    notesSec.hidden = true;
  }

  panel.hidden = false;
}

async function save() {
  status.textContent = "saving…";

  // Move bucket first if changed (this also updates the `status` field server-side).
  const newBucket = $("#f-bucket").value;
  if (newBucket !== original.bucket) {
    const mv = await fetch(`/api/tickets/${id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: newBucket }),
    });
    if (!mv.ok) { status.textContent = "move failed"; return; }
  }

  // Refetch so we preserve any server-managed fields (status, completed).
  const refetched = await fetch(`/api/tickets/${id}`).then((r) => r.json());
  const fm = { ...refetched.frontmatter };
  fm.title       = $("#f-title").value.trim();
  fm.priority    = $("#f-priority").value;
  fm.domain      = $("#f-domain").value.trim() || "meta";
  fm.tags        = csv($("#f-tags").value);
  fm.depends_on  = csv($("#f-depends_on").value);
  fm.blocks      = csv($("#f-blocks").value);
  fm.related     = csv($("#f-related").value);
  const cVal = $("#f-complexity").value;
  if (cVal && cVal !== "auto") fm.complexity = parseInt(cVal, 10);
  else delete fm.complexity;

  const body = readBodySections();
  const put = await fetch(`/api/tickets/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frontmatter: fm, body }),
  });
  if (!put.ok) { status.textContent = "save failed: " + (await put.text()); return; }
  await loadDomains();   // newly-added domain becomes a suggestion
  await load();
  status.textContent = "saved";
  setTimeout(() => { status.textContent = ""; }, 3000);
}

function openDeleteModal() {
  const msg = document.getElementById("delete-modal-msg");
  if (msg) msg.textContent = `${id} will be permanently removed. This cannot be undone.`;
  document.getElementById("delete-modal").hidden = false;
}

function closeDeleteModal() {
  document.getElementById("delete-modal").hidden = true;
}

async function confirmDelete() {
  closeDeleteModal();
  const r = await fetch(`/api/tickets/${id}`, { method: "DELETE" });
  if (!r.ok) { status.textContent = "delete failed: " + (await r.text()); return; }
  window.location.href = "/";
}

$("#save").addEventListener("click", save);
$("#delete").addEventListener("click", openDeleteModal);
document.getElementById("delete-modal-cancel").addEventListener("click", closeDeleteModal);
document.getElementById("delete-modal-cancel-btn").addEventListener("click", closeDeleteModal);
document.getElementById("delete-modal-cancel-btn2").addEventListener("click", closeDeleteModal);
document.getElementById("delete-modal-confirm").addEventListener("click", confirmDelete);

loadDomains();
load().catch((e) => { status.textContent = "error: " + e.message; });
