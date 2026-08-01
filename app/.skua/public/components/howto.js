// How-to modal wiring for the .skua dashboard. Self-initialising shared
// module (same pattern as theme.js / navbar-search.js): finds the help
// button (#howto-btn, in the shared navbar) and the modal (#howto-modal,
// injected by server.ts from howto-modal.html) on whatever page loaded it,
// and wires open / close / Escape / tab switching. Loaded on every view so the
// help button works everywhere — previously this lived only in app.js for the
// board, and the Neovim / Terminal / Claude panels were separate modals behind
// their own buttons on the /terminal route.

const btn = document.getElementById("howto-btn");
const modal = document.getElementById("howto-modal");

// Which tab was open last, so reopening help lands where you left off. Scoped
// per browser, not per page: the reference you want is usually the one you
// wanted a minute ago, whatever view you were on.
const TAB_KEY = "skua.howto.tab";

if (btn && modal) {
    const tabs = [...modal.querySelectorAll(".howto-tab")];
    const body = modal.querySelector(".howto-body");

    function selectTab(tab, { focus = false } = {}) {
        if (!tab) return;
        for (const t of tabs) {
            const on = t === tab;
            t.setAttribute("aria-selected", on ? "true" : "false");
            // Roving tabindex: only the selected tab is in the Tab order, so
            // Tab moves past the tablist and arrows move within it.
            t.tabIndex = on ? 0 : -1;
            const panel = document.getElementById(
                t.getAttribute("aria-controls"),
            );
            if (panel) panel.hidden = !on;
        }
        // Each panel is its own document — starting a new one mid-scroll would
        // look like content is missing.
        if (body) body.scrollTop = 0;
        if (focus) tab.focus();
        try {
            localStorage.setItem(TAB_KEY, tab.id);
        } catch {
            /* private mode / quota — the tab still switched */
        }
    }

    for (const [i, tab] of tabs.entries()) {
        tab.addEventListener("click", () => selectTab(tab));
        tab.addEventListener("keydown", (e) => {
            const delta =
                e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (delta) {
                e.preventDefault();
                selectTab(tabs[(i + delta + tabs.length) % tabs.length], {
                    focus: true,
                });
                return;
            }
            if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                selectTab(e.key === "Home" ? tabs[0] : tabs.at(-1), {
                    focus: true,
                });
            }
        });
    }

    btn.addEventListener("click", () => {
        let restored = null;
        try {
            restored = document.getElementById(localStorage.getItem(TAB_KEY));
        } catch {
            /* ignore */
        }
        // Only restore something that is actually a tab in this modal — a stale
        // id from an older build must not blank the body.
        if (restored && tabs.includes(restored)) selectTab(restored);
        modal.hidden = false;
    });
    modal.addEventListener("click", (e) => {
        if (e.target.matches("[data-modal-close]")) modal.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
    });
}
