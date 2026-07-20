// HTML escaping. The canonical implementation — every page module imports
// `escapeHtml` from here rather than redefining it locally. Keep ONE shared
// implementation; don't redefine it per page.

export function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
