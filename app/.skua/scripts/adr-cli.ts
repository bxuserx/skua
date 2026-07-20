// Shell-friendly CLI wrapper around .skua/lib/adrs.ts.
// Lets adr-manager (and humans) invoke read-only ops without the
// awkward `bun -e "import('./lib/adrs.ts').then(...)"` pattern.
//
// Run from the .skua/ directory:
//   bun scripts/adr-cli.ts next-id
//   bun scripts/adr-cli.ts list [status]
//   bun scripts/adr-cli.ts read ADR-NNN
//
// Mutations (transition, create, write) go through the dashboard's
// REST API or the adr-manager skill directly — not exposed here, by
// design. CLI is read-only + ID-mint utility.

import { listAll, readAdr, nextAdrId, ADR_STATES, type AdrState } from "../lib/adrs.ts";

const USAGE = `usage: bun scripts/adr-cli.ts <command> [args]

Commands:
  next-id              Print the next available ADR-NNN id (zero-padded).
  list [status]        List all ADRs, one per line: <id>\\t<status>\\t<title>.
                       Optional status filter: ${ADR_STATES.join(" | ")}.
  read <ADR-NNN>       Print the full ADR (frontmatter + body) to stdout.

Exits:
  0  success
  1  ADR not found or other runtime error
  2  unknown command / missing args
`;

function usageExit(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

async function cmdNextId(): Promise<void> {
  const id = await nextAdrId();
  process.stdout.write(id + "\n");
}

async function cmdList(filter?: string): Promise<void> {
  if (filter !== undefined && !ADR_STATES.includes(filter as AdrState)) {
    process.stderr.write(`unknown status: ${filter}\nvalid: ${ADR_STATES.join(", ")}\n`);
    process.exit(2);
  }
  const all = await listAll();
  const rows = filter ? all.filter((a) => a.status === filter) : all;
  for (const a of rows) {
    process.stdout.write(`${a.id}\t${a.status}\t${a.title}\n`);
  }
}

async function cmdRead(id: string): Promise<void> {
  const parsed = await readAdr(id);
  if (!parsed) {
    process.stderr.write(`ADR not found: ${id}\n`);
    process.exit(1);
  }
  // Reconstruct full file contents from frontmatter + body for stdout.
  // Use the lib's serializer to guarantee round-trip fidelity.
  const { serializeAdr } = await import("../lib/adrs.ts");
  process.stdout.write(serializeAdr(parsed));
  if (!parsed.body.endsWith("\n")) process.stdout.write("\n");
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd) usageExit();

try {
  switch (cmd) {
    case "next-id":
      await cmdNextId();
      break;
    case "list":
      await cmdList(rest[0]);
      break;
    case "read":
      if (!rest[0]) {
        process.stderr.write("read requires an ADR id\n");
        process.exit(2);
      }
      await cmdRead(rest[0]);
      break;
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      usageExit();
  }
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
