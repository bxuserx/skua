// chaos mode — live dashboard banner.
//
// Polls /api/chaos/active and shows a red bar whenever a chaos run is active
// (or paused on usage). Self-contained and injected on every page by the
// server's navbar render; a no-op when no run is active.

const el = document.getElementById("chaos-banner");

function render(a) {
  if (!el) return;
  if (!a) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const paused = a.status === "paused_usage";
  const flight = a.in_flight && a.in_flight.length ? ` · building ${a.in_flight.join(", ")}` : "";
  const invented = a.generated_features ? ` · ${a.generated_features} invented` : "";
  el.hidden = false;
  el.classList.toggle("paused", paused);
  el.innerHTML =
    `<span class="chaos-dot"></span>` +
    `<span><strong>CHAOS</strong> run <code>${a.id}</code> ${paused ? "paused (usage limit)" : "active"} — ` +
    `${a.built} built · ${a.skipped} skipped${invented}${flight}.</span>` +
    `<span class="chaos-hint">branches land in <code>5-validating</code> · stop with <code>/chaos stop</code></span>`;
}

async function poll() {
  try {
    const res = await fetch("/api/chaos/active");
    const { active } = await res.json();
    render(active);
  } catch {
    /* keep last state on a transient error */
  }
}

if (el) {
  poll();
  setInterval(poll, 5000);
}
