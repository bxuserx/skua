import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { buildTicketGraph } from "./tickets.ts";
import { buildDataflowGraph } from "./dataflow.ts";
import { buildSchemasGraph } from "./schemas.ts";
import { buildAdrGraph } from "./adrs.ts";
import { buildAiGraph } from "./ai.ts";

const CACHE = join(import.meta.dir, "..", "..", "cache");

async function main() {
  await mkdir(CACHE, { recursive: true });
  // Each builder is caught individually so one failure doesn't hide the others,
  // but a failure must still fail the command — a silent exit 0 made a broken
  // builder invisible to anything that didn't read stdout (setup.sh swallows it too).
  const failed: string[] = [];
  for (const [name, builder] of [
    ["tickets",  buildTicketGraph],
    ["dataflow", buildDataflowGraph],
    ["schemas",  buildSchemasGraph],
    ["adrs",     buildAdrGraph],
    ["ai",       buildAiGraph],
  ] as const) {
    try {
      const g = await builder();
      const file = join(CACHE, `${name}-graph.json`);
      await writeFile(file, JSON.stringify(g, null, 2), "utf8");
      console.log(`wrote ${file} — ${g.nodes.length} nodes, ${g.edges.length} edges`);
    } catch (e) {
      failed.push(name);
      console.error(`FAILED ${name}-graph: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
  if (failed.length) {
    console.error(`\nbuild:graphs failed — ${failed.length} of 5 builders threw: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
