#!/usr/bin/env node
// chaos mode — SessionStart awareness note.
//
// When a chaos run is active, every session (interactive or otherwise) is
// reminded of the contract and the controls. Inert unless `.chaos-active`
// exists, so it costs nothing outside a run. Mirrors ponytail-activate's
// lightweight SessionStart emission.

const fs = require("fs");
const os = require("os");
const path = require("path");

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

const flag = path.join(claudeDir(), ".chaos-active");
if (!fs.existsSync(flag)) process.exit(0);

let runId = "";
try {
  runId = fs.readFileSync(flag, "utf8").trim();
} catch {
  /* flag exists but unreadable — still note the run */
}

const note =
  `A CHAOS run is active${runId ? ` (run ${runId})` : ""} — skua's fully-autonomous ticket mode. ` +
  "Contract: work happens on chaos/TKT-NNN branches and lands in 5-validating/ for review; nothing is merged to main autonomously. " +
  "Irreversible git-history and data-destruction commands are blocked while chaos is active. " +
  "Controls: /chaos status · /chaos stop (or `touch .tickets/STOP`).";

try {
  process.stdout.write(note);
} catch {
  /* EPIPE at hook exit must not surface as a failure */
}
process.exit(0);
