import { listAll } from "../tickets.ts";

export type CyNode = { data: { id: string; label: string; title?: string; bucket?: string; priority?: string; domain?: string; kind: string } };
export type CyEdge = { data: { id: string; source: string; target: string; kind: "depends_on" | "blocks" | "related" | "mention" } };
export type CyGraph = { nodes: CyNode[]; edges: CyEdge[]; meta: Record<string, unknown> };

export async function buildTicketGraph(): Promise<CyGraph> {
  const tickets = await listAll();
  const nodes: CyNode[] = tickets.map((t) => ({
    data: {
      id: t.id,
      label: t.id,
      title: t.title,
      bucket: t.bucket,
      priority: t.priority,
      domain: t.domain,
      kind: "ticket",
    },
  }));
  const edges: CyEdge[] = [];
  let i = 0;
  const known = new Set(tickets.map((t) => t.id));

  for (const t of tickets) {
    for (const dep of t.depends_on) {
      if (!known.has(dep)) continue;
      edges.push({ data: { id: `e${i++}`, source: t.id, target: dep, kind: "depends_on" } });
    }
    for (const blk of t.blocks) {
      if (!known.has(blk)) continue;
      edges.push({ data: { id: `e${i++}`, source: t.id, target: blk, kind: "blocks" } });
    }
    for (const rel of t.related) {
      if (!known.has(rel)) continue;
      edges.push({ data: { id: `e${i++}`, source: t.id, target: rel, kind: "related" } });
    }
  }

  return { nodes, edges, meta: { built: new Date().toISOString(), count: tickets.length } };
}
