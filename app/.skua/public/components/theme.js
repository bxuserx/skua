// Theme toggle for the .skua dashboard. Persists to localStorage and
// broadcasts `skua:theme-changed` so cytoscape consumers can re-render.
//
// The FOUC-prevention bit (read localStorage → set data-theme before paint)
// is inlined synchronously at the top of each HTML page's <head>. This
// module handles toggle clicks and exposes helpers for live consumers.

const STORAGE_KEY = "skua-theme";

export function getActiveTheme() {
    // data-theme on <html> is the source of truth at runtime — set either
    // by the inline FOUC bootstrap (localStorage) or by an explicit toggle.
    // Absence means "follow system preference"; reflect that back as
    // "light" or "dark" so callers don't have to re-do the matchMedia
    // dance.
    const attr = document.documentElement.dataset.theme;
    if (attr === "dark" || attr === "light") return attr;
    return systemPrefersDark() ? "dark" : "light";
}

export function applyTheme(theme) {
    // Persist + reflect + broadcast. Anything cytoscape-shaped subscribes
    // to skua:theme-changed and re-builds itself.
    if (theme !== "dark" && theme !== "light") return;
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // Private-window / storage-disabled: just keep the in-DOM state.
    }
    window.dispatchEvent(
        new CustomEvent("skua:theme-changed", { detail: { theme } }),
    );
    syncToggleButtons(theme);
}

function systemPrefersDark() {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function syncToggleButtons(theme) {
    // Update every toggle button's label + aria-label so users on either
    // page see the same icon for the same state.
    for (const btn of document.querySelectorAll(".theme-toggle-btn")) {
        btn.textContent = theme === "dark" ? "☼" : "☾";
        btn.setAttribute(
            "aria-label",
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        );
        btn.setAttribute(
            "title",
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        );
    }
}

function wire() {
    syncToggleButtons(getActiveTheme());
    for (const btn of document.querySelectorAll(".theme-toggle-btn")) {
        btn.addEventListener("click", () => {
            const next = getActiveTheme() === "dark" ? "light" : "dark";
            applyTheme(next);
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
} else {
    wire();
}
