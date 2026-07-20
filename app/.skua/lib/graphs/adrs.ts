import { listAll as listAllAdrs } from "../adrs.ts";
import { listAll as listAllTickets } from "../tickets.ts";

export type AdrGraphNodeKind = "adr" | "draft-ticket" | "materialized-ticket";
export type AdrGraphEdgeKind =
  | "implements_adr"
  | "proposes"
  | "materialized_from"
  | "depends_on"
  | "supersedes";

export type AdrCyNode = {
  data: {
    id: string;
    label: string;
    kind: AdrGraphNodeKind;
    status?: string;
    title?: string;
    adr_id?: string;
  };
};

export type AdrCyEdge = {
  data: {
    id: string;
    source: string;
    target: string;
    kind: AdrGraphEdgeKind;
  };
};

export type AdrCyGraph = {
  nodes: AdrCyNode[];
  edges: AdrCyEdge[];
  meta: {
    built: string;
    counts: {
      adrs: number;
      drafts: number;
      materialized: number;
      edges: number;
    };
  };
};

// Draft IDs are ADR-local (DRAFT-1 in ADR-001 is distinct from DRAFT-1 in
// ADR-002). Namespace them by ADR id for graph uniqueness.
function draftNodeId(adrId: string, draftId: string): string {
  return `${adrId}:${draftId}`;
}

export async function buildAdrGraph(): Promise<AdrCyGraph> {
  const adrs = await listAllAdrs();
  const tickets = await listAllTickets();

  const nodes: AdrCyNode[] = [];
  const edges: AdrCyEdge[] = [];
  const knownNodes = new Set<string>();

  // 1. ADR nodes.
  for (const a of adrs) {
    nodes.push({
      data: {
        id: a.id,
        label: `${a.id} ${a.title}`,
        kind: "adr",
        status: a.status,
        title: a.title,
      },
    });
    knownNodes.add(a.id);
  }

  // 2. Ticket nodes — only for tickets that participate in this graph
  //    (either implements an ADR OR is a materialized draft target).
  //    Avoid pulling in the entire ticket board.
  const ticketsInGraph = new Set<string>();
  for (const t of tickets) {
    // Cast: implements_adr is an ADR-specific frontmatter field; not in
    // the canonical TicketSummary type but tolerated via the Frontmatter
    // index signature.
    const implementsAdr = t.implements_adr;
    if (implementsAdr && knownNodes.has(implementsAdr)) {
      ticketsInGraph.add(t.id);
    }
  }
  // Materialized targets — even if they don't yet have implements_adr set.
  // Need to re-read full ADR bodies to find materialized_tickets[] payload.
  // listAll returns summaries with counts only; widen via fresh read.
  const { readAdr } = await import("../adrs.ts");
  const fullAdrs = await Promise.all(adrs.map((a) => readAdr(a.id)));

  for (const fa of fullAdrs) {
    if (!fa) continue;
    const mat = fa.frontmatter.materialized_tickets ?? [];
    for (const m of mat) {
      if (m.ticket_id) ticketsInGraph.add(m.ticket_id);
    }
  }

  for (const tid of ticketsInGraph) {
    const t = tickets.find((x) => x.id === tid);
    if (!t) continue;
    nodes.push({
      data: {
        id: t.id,
        label: `${t.id} ${t.title}`,
        kind: "materialized-ticket",
        title: t.title,
      },
    });
    knownNodes.add(t.id);
  }

  // 3. Draft-ticket nodes + their edges.
  let edgeIdx = 0;
  for (const fa of fullAdrs) {
    if (!fa) continue;
    const adrId = fa.frontmatter.id!;
    const proposed = fa.frontmatter.proposed_tickets ?? [];
    for (const d of proposed) {
      const nodeId = draftNodeId(adrId, d.draft_id);
      nodes.push({
        data: {
          id: nodeId,
          label: `${d.draft_id} ${d.title}`,
          kind: "draft-ticket",
          title: d.title,
          adr_id: adrId,
        },
      });
      knownNodes.add(nodeId);
      // proposes edge: ADR -> DRAFT
      edges.push({
        data: { id: `e${edgeIdx++}`, source: adrId, target: nodeId, kind: "proposes" },
      });
    }
  }

  // 4. Draft depends_on edges. Resolved AFTER all draft nodes are minted
  //    so we can resolve DRAFT-N references within the same ADR.
  for (const fa of fullAdrs) {
    if (!fa) continue;
    const adrId = fa.frontmatter.id!;
    const proposed = fa.frontmatter.proposed_tickets ?? [];
    for (const d of proposed) {
      const sourceId = draftNodeId(adrId, d.draft_id);
      for (const dep of d.depends_on ?? []) {
        // dep may be a DRAFT-N (resolve within same ADR) or a TKT-NNN (resolve to real ticket node)
        const target = dep.startsWith("DRAFT-")
          ? draftNodeId(adrId, dep)
          : dep;
        if (!knownNodes.has(target)) continue;
        edges.push({
          data: { id: `e${edgeIdx++}`, source: sourceId, target, kind: "depends_on" },
        });
      }
    }
  }

  // 5. materialized_from edges: TKT (real) -> DRAFT (now-historical).
  //    Drafts may no longer exist as nodes (the ADR replaces proposed_tickets
  //    with materialized_tickets on promotion). Skip the edge if the draft
  //    node isn't in the graph. Audit-only edge; absence is fine.
  for (const fa of fullAdrs) {
    if (!fa) continue;
    const adrId = fa.frontmatter.id!;
    const materialized = fa.frontmatter.materialized_tickets ?? [];
    for (const m of materialized) {
      const draftNode = draftNodeId(adrId, m.draft_id);
      if (knownNodes.has(m.ticket_id) && knownNodes.has(draftNode)) {
        edges.push({
          data: {
            id: `e${edgeIdx++}`,
            source: m.ticket_id,
            target: draftNode,
            kind: "materialized_from",
          },
        });
      }
    }
  }

  // 6. implements_adr edges: real TKT -> ADR. Mirrors how the ticket's
  //    `implements_adr` field points back to its parent ADR.
  for (const tid of ticketsInGraph) {
    const t = tickets.find((x) => x.id === tid);
    if (!t) continue;
    const adrId = t.implements_adr;
    if (adrId && knownNodes.has(adrId)) {
      edges.push({
        data: {
          id: `e${edgeIdx++}`,
          source: t.id,
          target: adrId,
          kind: "implements_adr",
        },
      });
    }
  }

  // 7. supersedes edges: ADR -> ADR (the one being superseded).
  for (const fa of fullAdrs) {
    if (!fa) continue;
    const adrId = fa.frontmatter.id!;
    const supersedes = fa.frontmatter.supersedes ?? [];
    for (const target of supersedes) {
      if (!knownNodes.has(target)) continue;
      edges.push({
        data: { id: `e${edgeIdx++}`, source: adrId, target, kind: "supersedes" },
      });
    }
  }

  const draftCount = nodes.filter((n) => n.data.kind === "draft-ticket").length;
  const matCount = nodes.filter((n) => n.data.kind === "materialized-ticket").length;

  return {
    nodes,
    edges,
    meta: {
      built: new Date().toISOString(),
      counts: {
        adrs: adrs.length,
        drafts: draftCount,
        materialized: matCount,
        edges: edges.length,
      },
    },
  };
}
