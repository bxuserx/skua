// Expand-all / collapse-all toggle. Any page that includes this script
// gets the behaviour by adding `<button data-expand-all>` somewhere in
// the toolbar. The button flips every details.adr-section /
// details.adr-subsection on the page, and keeps its own label
// ("expand all" vs "collapse all") in sync with the current state —
// including state changes from clicking an individual section.
//
// IMPORTANT: writing btn.textContent inside update() creates a childList
// mutation in document.body's subtree. If a MutationObserver(update) is
// watching body+subtree, that write would re-trigger update() via the
// microtask queue forever — freezing the tab so badly that DevTools can't
// attach. So:
//   1. Every DOM write in update() is guarded by an equality check.
//   2. The observer scopes to `[data-expand-all-scope]` (the page's
//      accordion container) instead of document.body, so unrelated
//      mutations (e.g. board ticket-row renders) don't fire it. If no
//      element carries that attribute, fall back to .adr-md ancestors;
//      if none of those either, skip the observer entirely.
(function () {
  const SEL = "details.adr-section, details.adr-subsection";

  function init() {
    const btn = document.querySelector("[data-expand-all]");
    if (!btn) return;

    function all() {
      return Array.from(document.querySelectorAll(SEL));
    }
    function update() {
      const d = all();
      const allOpen = d.length > 0 && d.every((x) => x.open);
      const label = allOpen ? "collapse all" : "expand all";
      const pressed = allOpen ? "true" : "false";
      const disabled = d.length === 0;
      // Write-guards: only touch the DOM when the value actually changes.
      // Without these, btn.textContent = label would create a childList
      // mutation that re-fires the MutationObserver below → infinite loop.
      if (btn.textContent !== label) btn.textContent = label;
      if (btn.getAttribute("aria-pressed") !== pressed) {
        btn.setAttribute("aria-pressed", pressed);
      }
      if (btn.disabled !== disabled) btn.disabled = disabled;
    }
    btn.addEventListener("click", () => {
      const d = all();
      const anyClosed = d.some((x) => !x.open);
      d.forEach((x) => {
        x.open = anyClosed;
      });
      update();
    });
    // Catch individual section toggles so the label stays honest.
    document.addEventListener("toggle", update, true);
    // Watch for accordion DOM mutations to refresh the label as accordions
    // render asynchronously. Scope to the accordion container(s) so the
    // observer can't be triggered by writes to the button itself or by
    // unrelated render activity elsewhere in the body.
    const scopes = Array.from(
      document.querySelectorAll("[data-expand-all-scope], .adr-md"),
    );
    for (const scope of scopes) {
      new MutationObserver(update).observe(scope, {
        childList: true,
        subtree: true,
      });
    }
    update();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
