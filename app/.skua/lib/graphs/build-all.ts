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
      console.warn(`skipped ${name}-graph: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
