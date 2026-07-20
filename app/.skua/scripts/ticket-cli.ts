// Shell-friendly CLI wrapper around .skua/lib/tickets.ts.
// Lets the ticket-manager / bug-scan skills (and humans) allocate IDs, audit
// the board, and file tickets headlessly — instead of hand-scanning
// `.tickets/*/` with `ls` or requiring the dashboard server to be running.
//
// Run from the .skua/ directory:
//   bun scripts/ticket-cli.ts next-id      # print the next free TKT-NNN
//   bun scripts/ticket-cli.ts audit-ids    # fail if any ID is duplicated / mismatched
//   bun scripts/ticket-cli.ts create --title "..." [--bucket 0-backlog] [...]
//
// `next-id`, `audit-ids`, and `create` all reuse lib/tickets.ts (`nextTicketId`,
// `listAll`, `createTicket`) — the SAME functions the dashboard's quick-create
// uses — so the skills and the GUI can never diverge into two allocators. That
// divergence (scanning lifecycle folders but not `scratch/`) is exactly the
// kind of bug a single shared allocator prevents.
//
// `create` is the one mutating command, added so automation (the bug-scan skill)
// can file backlog tickets during `setup.sh` before the server is up. Move/edit
// still go through the dashboard REST API or the ticket-manager skill.

import { listAll, nextTicketId, createTicket, BUCKETS, type Bucket } from "../lib/tickets.ts";
import { readFileSync } from "node:fs";

const USAGE = `usage: bun scripts/ticket-cli.ts <command> [args]

Commands:
  next-id      Print the next available TKT-NNN id (max existing id + 1,
               scanning ALL buckets incl. scratch/ and 7-archive/).
  audit-ids    Scan every bucket for duplicate ids and filename↔frontmatter
               id mismatches. Prints offenders. Exit 1 if any found.
  create       Create a ticket and print its id. Flags:
                 --title <str>      (required)
                 --bucket <name>    (default: 0-backlog)
                 --domain <str>     (default: meta)
                 --priority <str>   (default: Medium)
                 --complexity <1-5>
                 --tags a,b,c
                 --depends-on TKT-1,TKT-2
                 --related TKT-3
                 --body <str>  |  --body-file <path>

Exits:
  0  success (audit-ids: board is clean)
  1  runtime error, or audit-ids found a collision
  2  unknown command / missing args
`;

const TKT_FILENAME_RE = /^TKT-(\d+)-.*\.md$/;

function usageExit(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

async function cmdNextId(): Promise<void> {
  const id = await nextTicketId();
  process.stdout.write(id + "\n");
}

async function cmdAuditIds(): Promise<void> {
  const all = await listAll();

  // Group by the id encoded in the FILENAME — that is the space
  // `nextTicketId()` allocates over, so it's the authoritative collision key.
  const byFilenameId = new Map<string, { filename: string; bucket: string; frontmatterId: string }[]>();
  const mismatches: { filename: string; bucket: string; frontmatterId: string; filenameId: string }[] = [];

  for (const t of all) {
    const m = t.filename.match(TKT_FILENAME_RE);
    if (!m) continue;
    const filenameId = `TKT-${m[1]}`;
    const entry = { filename: t.filename, bucket: t.bucket, frontmatterId: t.id };
    const arr = byFilenameId.get(filenameId) ?? [];
    arr.push(entry);
    byFilenameId.set(filenameId, arr);
    if (t.id !== filenameId) {
      mismatches.push({ ...entry, filenameId });
    }
  }

  const duplicates = [...byFilenameId.entries()].filter(([, files]) => files.length > 1);

  let clean = true;

  if (duplicates.length > 0) {
    clean = false;
    process.stderr.write(`DUPLICATE IDS (${duplicates.length}):\n`);
    for (const [id, files] of duplicates.sort((a, b) => a[0].localeCompare(b[0]))) {
      process.stderr.write(`  ${id} used by ${files.length} files:\n`);
      for (const f of files) process.stderr.write(`    ${f.bucket}/${f.filename}\n`);
    }
  }

  if (mismatches.length > 0) {
    clean = false;
    process.stderr.write(`FILENAME↔FRONTMATTER ID MISMATCH (${mismatches.length}):\n`);
    for (const m of mismatches) {
      process.stderr.write(`  ${m.bucket}/${m.filename} has frontmatter id ${m.frontmatterId}\n`);
    }
  }

  if (clean) {
    process.stdout.write(`ok: ${all.length} tickets, no duplicate ids, no id mismatches\n`);
    process.exit(0);
  }
  process.exit(1);
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

async function cmdCreate(argv: string[]): Promise<void> {
  const f = parseFlags(argv);
  const title = f.title;
  if (!title) {
    process.stderr.write("create: --title is required\n");
    process.exit(2);
  }
  const bucket = (f.bucket ?? "0-backlog") as Bucket;
  if (!BUCKETS.includes(bucket)) {
    process.stderr.write(`create: invalid --bucket "${bucket}" (one of: ${BUCKETS.join(", ")})\n`);
    process.exit(2);
  }
  const csv = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

  let body = f.body;
  if (f["body-file"]) {
    try {
      body = readFileSync(f["body-file"], "utf8");
    } catch {
      process.stderr.write(`create: cannot read --body-file ${f["body-file"]}\n`);
      process.exit(1);
    }
  }

  let complexity: number | undefined;
  if (f.complexity && /^[1-5]$/.test(f.complexity)) complexity = Number(f.complexity);

  const t = await createTicket({
    title,
    priority: f.priority ?? "Medium",
    domain: f.domain,
    body,
    tags: csv(f.tags),
    depends_on: csv(f["depends-on"]),
    related: csv(f.related),
    bucket,
    complexity,
  });
  process.stdout.write(t.id + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd) usageExit();

try {
  switch (cmd) {
    case "next-id":
      await cmdNextId();
      break;
    case "audit-ids":
      await cmdAuditIds();
      break;
    case "create":
      await cmdCreate(rest);
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
