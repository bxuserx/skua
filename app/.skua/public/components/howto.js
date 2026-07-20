// How-to modal wiring for the .skua dashboard. Self-initialising shared
// module (same pattern as theme.js / navbar-search.js): finds the help
// button (#howto-btn, in the shared navbar) and the modal (#howto-modal,
// injected by server.ts from howto-modal.html) on whatever page loaded it,
// and wires open / close / Escape. Loaded on every view so the help button
// works everywhere — previously this lived only in app.js for the board.

const btn = document.getElementById("howto-btn");
const modal = document.getElementById("howto-modal");

if (btn && modal) {
    btn.addEventListener("click", () => {
        modal.hidden = false;
    });
    modal.addEventListener("click", (e) => {
        if (e.target.matches("[data-modal-close]")) modal.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
    });
}
