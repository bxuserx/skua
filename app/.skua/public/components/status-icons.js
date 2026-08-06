// Terminal status glyphs — one shape per state of the sidebar's status mark.
//
// Split out of terminal.js so the whole set can be rendered on its own — six
// glyphs side by side — without booting the terminal page and staging six live
// sessions to see them. terminal.js owns WHICH state a session is in; this file
// only knows what each one looks like.
//
// The static states are SVGs drawn in `currentColor`, so the stylesheet owns
// size and colour (.term-status-dot.is-* in styles/terminal.css). "working" is
// the exception: it's a CSS box-shadow loader, an element with no geometry.
//
// The three states that describe a Claude CONVERSATION share one speech-bubble
// silhouette and differ by the mark inside it (nothing / check / x), so they
// read as one family. The two that describe the terminal rather than the
// conversation deliberately don't: "working" is a flickering block grid and
// "stale" a broken ring, so neither can be mistaken for a message.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Every state a status mark can be in, in escalating order of "wants you". */
export const STATUS_STATES = ["none", "seen", "stale", "working", "unread", "blocked"];

/** Accessible names, used as the mark's aria-label. "" means "render nothing". */
export const STATUS_LABEL = {
    none: "",
    working: "Claude is working",
    blocked: "Claude is blocked on you",
    unread: "Claude finished — unread",
    seen: "Claude is idle",
    stale: "status unknown — session stopped reporting",
};

// Build one <svg> from a list of [tag, attrs].
function statusSvg(parts, attrs = {}) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({
        viewBox: "0 0 16 16", fill: "none", stroke: "none", "aria-hidden": "true", ...attrs,
    })) svg.setAttribute(k, v);
    for (const [tag, a] of parts) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
        svg.appendChild(el);
    }
    return svg;
}

const STROKE = { fill: "none", stroke: "currentColor", "stroke-linecap": "round" };

// The three Claude-conversation states are a matched set from SVG Repo
// (message-circle, message-circle-check, message-circle-xmark): one speech
// bubble, three inner marks. Drawn on a 24 viewBox rather than the 16 the other
// glyphs use, so they carry their own viewBox and stroke settings.
//
// Only two things were changed from the downloaded files: `#000000` became
// `currentColor` so the stylesheet can theme them, and the shared bubble is
// factored into one constant instead of being repeated three times.
const BUBBLE =
    "M21.0039 12C21.0039 16.9706 16.9745 21 12.0039 21C9.9675 21 3.00463 21 3.00463 21" +
    "C3.00463 21 4.56382 17.2561 3.93982 16.0008C3.34076 14.7956 3.00391 13.4372 3.00391 12" +
    "C3.00391 7.02944 7.03334 3 12.0039 3C16.9745 3 21.0039 7.02944 21.0039 12Z";

// Shared presentation for the bubble family — set on the <svg> so the paths
// inherit it and each one carries nothing but its own geometry.
const BUBBLE_SVG = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
};

/**
 * The glyph for `state`, or null for "none" — a terminal with no Claude session
 * in it gets no mark at all, rather than a faint one you have to squint at.
 */
export function statusIcon(state) {
    switch (state) {
        // Working: the flickering 3x4 block grid (css-loaders.com, "l29"), the one
        // moving thing anywhere in the sidebar. Deliberately NOT an svg — the whole
        // shape is 12 box-shadows on a single element, so it lives in CSS
        // (.skua-loader in styles/terminal.css) and this is just its anchor.
        case "working": {
            const el = document.createElement("span");
            el.className = "skua-loader";
            return el;
        }
        // Blocked: the bubble with an x — Claude asked something and is stopped
        // until you answer.
        case "blocked":
            return statusSvg([
                ["path", { d: "M9.5 9.4185L14.5 14.4185M14.5 9.4185L9.5 14.4185" }],
                ["path", { d: BUBBLE }],
            ], BUBBLE_SVG);
        // Unread: the bubble with a check — a turn came back and you haven't
        // read it.
        case "unread":
            return statusSvg([
                ["path", { d: "M9 12.2222L10.8462 14L15 10" }],
                ["path", { d: BUBBLE }],
            ], BUBBLE_SVG);
        // Seen: the bare bubble — a conversation with nothing new in it.
        case "seen":
            return statusSvg([["path", { d: BUBBLE }]], BUBBLE_SVG);
        // Stale: a ring with pieces missing — "the signal stopped", which is a
        // different claim from "idle" and has to look like one.
        case "stale":
            return statusSvg([
                ["circle", { cx: "8", cy: "8", r: "5.6", ...STROKE, "stroke-width": "1.7", "stroke-dasharray": "2.4 3.1" }],
            ]);
        default:
            return null;
    }
}
