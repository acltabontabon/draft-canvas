/**
 * A diagram that begins as one of the native Architecture Starters: built by the starter's own
 * factory (`buildStarter`, authored geometry, matrix-derived semantics and its predefined flows), with
 * ids the agent can predict (`prefix` + the starter's own keys), then the agent's overrides and
 * extra elements on top. Nothing is copied out of the catalog and nothing marks the result as a
 * starter — as when a person inserts one from ⌘K.
 */

import { buildStarter, starterById } from '../starters';
import type { ArchitectureStarter } from '../starters/types';
import { createDocument } from '../document/factory';
import type { DraftEdge, DraftNode } from '../document/types';
import { assignAnchors } from '../layout/anchors';
import type { DescribeContext } from '../nodes/describe';
import { GUTTER } from '../starters/compose';
import { AgentError } from './errors';
import type { CreateSpec, LayoutSpec, RoomSpec } from './input';
import { anchorRectOf, attachNote, captionSizer, connectorFor, edgeLabelSize, flowFromSpec, lineOf, linkVariants, placeBlock, placeRoom, sizeToFit, type PlacedRoom } from './place';
import { repairAnchors } from './route';

export function starterFor(id: string): ArchitectureStarter {
  const starter = starterById(id as Parameters<typeof starterById>[0]);
  if (!starter) throw new AgentError('NOT_FOUND', `No starter "${id}".`);
  return starter;
}

/** The ids a starter's elements and connectors get under `prefix` — what an agent refers to them by. */
export function starterIds(starter: ArchitectureStarter, prefix: string) {
  const nodes = starter.nodes.map((n) => ({ id: `${prefix}${n.key}`, key: n.key, group: n.type === 'group' }));
  const edges = starter.edges.map((e, i) => `${prefix}${e.key ?? `e${i + 1}`}`);
  const flows = (starter.flows ?? []).map((_, i) => `${prefix}flow${i + 1}`);
  return { nodes, edges, flows };
}

export function buildFromStarter(spec: CreateSpec, layout: LayoutSpec, ctx: DescribeContext, insideRooms?: ReadonlyMap<RoomSpec, PlacedRoom>): PlacedRoom {
  const choice = spec.starter;
  if (!choice) throw new AgentError('INTERNAL', 'No starter requested.');
  const starter = starterFor(choice.id);
  const ids = starterIds(starter, choice.prefix);
  const built = buildStarter(
    starter,
    { x: 0, y: 0 },
    {
      node: (key) => `${choice.prefix}${key}`,
      edge: (_edge, index) => ids.edges[index] as string,
      flow: (index) => ids.flows[index] as string,
    },
  );
  const advisories: string[] = [];
  // Overrides: the agent's own names and C4 text on the starter's shapes. A shape grows (never
  // shrinks) to show them in full; the quality check refuses the result if that crowds a neighbour.
  const nodes: DraftNode[] = built.nodes.map((node) => {
    const key = node.id.slice(choice.prefix.length);
    const override = choice.overrides[key];
    if (!override) return node;
    const next: DraftNode = {
      ...node,
      ...(override.label ? { text: override.label, textOrigin: 'explicit' as const } : {}),
      ...(override.description ? { description: override.description } : {}),
      ...(override.technology ? { technology: override.technology } : {}),
    };
    if (next.type === 'group') return next;
    const sized = sizeToFit(next, ctx);
    return { ...sized, width: Math.max(sized.width, node.width), height: Math.max(sized.height, node.height) };
  });
  const unknown = Object.keys(choice.overrides).filter((key) => !starter.nodes.some((n) => n.key === key));
  if (unknown.length) {
    throw new AgentError('INVALID_REFERENCE', `No element "${unknown[0]}" in the ${starter.name} starter.`, {
      path: `/starter/overrides/${unknown[0]}`,
      details: { keys: starter.nodes.map((n) => n.key) },
    });
  }
  const edges: DraftEdge[] = [...built.edges];

  // Anything the agent adds beside the starter: arranged on its own, then set to the side of it in
  // the reading direction, and connected to the starter's shapes.
  const starterIdSet = new Set(nodes.map((n) => n.id));
  const starterEdgeIds = new Set(edges.map((e) => e.id));
  const extras = spec.nodes;
  // A note attached to one of the starter's own shapes or connectors rides on it; it is not part of
  // the block laid out beside the starter (where its host is nowhere to be found).
  const onStarter = (note: CreateSpec['notes'][number]) => !!note.attachTo && (starterIdSet.has(note.attachTo.id) || starterEdgeIds.has(note.attachTo.id));
  const ownNotes = spec.notes.filter((note) => !onStarter(note));
  if (extras.length || spec.groups.length || ownNotes.length) {
    const own = new Set([...extras.map((n) => n.id)]);
    const inner = spec.relationships.filter((r) => own.has(r.from) && own.has(r.to));
    const room = placeRoom({ ...spec, relationships: inner, flows: [], notes: ownNotes }, layout, ctx, undefined, insideRooms);
    advisories.push(...room.advisories);
    const minX = Math.min(...room.nodes.map((n) => n.x));
    const minY = Math.min(...room.nodes.map((n) => n.y));
    const size = { width: Math.max(...room.nodes.map((n) => n.x + n.width)) - minX, height: Math.max(...room.nodes.map((n) => n.y + n.height)) - minY };
    // Beside the starter shape it connects to most, the way an update places an addition — so a
    // consumer added to a starter's topic sits on the topic's line, not off in a corner.
    const bridging = spec.relationships.filter((r) => own.has(r.from) !== own.has(r.to));
    const weight = new Map<string, number>();
    for (const r of bridging) {
      const outside = own.has(r.from) ? r.to : r.from;
      if (starterIdSet.has(outside)) weight.set(outside, (weight.get(outside) ?? 0) + 1);
    }
    const hostId = [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    const host = hostId ? nodes.find((n) => n.id === hostId) : undefined;
    const lookup = new Map([...nodes, ...room.nodes].map((node) => [node.id, node]));
    const captionRoom = Math.max(
      0,
      ...bridging.map((r) => {
        const s = lookup.get(r.from);
        const t = lookup.get(r.to);
        return s && t ? edgeLabelSize(connectorFor(r, s, t, []), s, t, ctx).width : 0;
      }),
    );
    const feedsHost = bridging.filter((r) => r.to === hostId).length > bridging.filter((r) => r.from === hostId).length;
    const touching = bridging.map((r) => (own.has(r.from) ? r.from : r.to)).map((id) => room.nodes.find((n) => n.id === id))[0];
    const meets = touching ? lineOf(touching) : undefined;
    const beside = host
      ? placeBlock({ ...createDocument(), nodes }, host, size, layout.direction, undefined, Math.max(72, captionRoom + 40), feedsHost, [], meets && { x: meets.x - minX, y: meets.y - minY })
      : undefined;
    const origin = beside ?? {
      x: layout.direction === 'right' ? Math.max(...nodes.map((n) => n.x + n.width)) + GUTTER * 2 : 0,
      y: layout.direction === 'right' ? 0 : Math.max(...nodes.map((n) => n.y + n.height)) + GUTTER * 2,
    };
    for (const node of room.nodes) nodes.push({ ...node, x: Math.round(node.x - minX + origin.x), y: Math.round(node.y - minY + origin.y) });
    edges.push(...room.edges);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cross = spec.relationships.filter((r) => starterIdSet.has(r.from) || starterIdSet.has(r.to));
  const crossEdges = cross.map((r) => connectorFor(r, byId.get(r.from) as DraftNode, byId.get(r.to) as DraftNode, advisories));
  const rects = new Map(nodes.map((n) => [n.id, anchorRectOf(n)]));
  const anchors = assignAnchors(crossEdges, rects, layout.direction);
  for (const edge of crossEdges) {
    const a = anchors.get(edge.id);
    if (a) Object.assign(edge, a);
  }
  repairAnchors(crossEdges, nodes, captionSizer(nodes, ctx), [...edges, ...crossEdges]);
  edges.push(...crossEdges);
  for (const note of spec.notes.filter(onStarter)) {
    const target = note.attachTo!;
    const at = target.kind === 'node' ? nodes.findIndex((n) => n.id === target.id) : edges.findIndex((e) => e.id === target.id);
    const host = target.kind === 'node' ? { ...nodes[at]! } : { ...edges[at]! };
    attachNote(host, target.kind, note);
    if (target.kind === 'node') nodes[at] = host as DraftNode;
    else edges[at] = host as DraftEdge;
  }

  const flows = linkVariants([...built.flows, ...spec.flows.map(flowFromSpec)], spec.flows, advisories);
  return { nodes, edges, flows, ...(spec.level ? { level: spec.level } : {}), advisories };
}
