/**
 * What a change to one part of a diagram touches: what its work reaches, what reaches it, what
 * the drawing says fails if it stops, which flows run over it, which boundaries it crosses, what
 * it shares, and what is still open about it.
 *
 * Every answer is read from the drawing and says so. Reach follows the arrows as drawn. What
 * fails is the outage walk's reading (`traffic/outage.ts`), by the same rules, never a second
 * set. None of it is a measurement: there is no rate, likelihood, capacity or availability here,
 * and where the drawing is silent the answer is absent rather than guessed.
 */

import type { DraftDocument } from '../document/types';
import { roomsOf } from '../depth/tree';
import { downstreamOf, upstreamOf } from '../model/graph';
import { labelOf, modelOf, type ArchModel } from '../model/model';
import { analyzeTraffic, outageOf, type OutageState } from '../traffic';

/** Ids listed under each heading before the rest are only counted. */
export const IMPACT_LIMIT = 200;

export interface ImpactReach {
  ids: string[];
  /** How many there are in all, when more than are listed. */
  total: number;
  /** The walk stopped at its limit: there may be more than `total`. */
  truncated: boolean;
}

export interface ImpactOutage {
  /** One sentence, in the diagram's own names. */
  headline: string;
  /** What the outage does to each part that takes part, the ones it leaves alone left out. */
  affected: { id: string; state: Exclude<OutageState, 'unaffected'> }[];
  /** What happens, what stops it spreading, and what the drawing leaves open, in that order. */
  notes: { tone: 'effect' | 'shield' | 'question'; text: string; focus: string[] }[];
  flows: { id: string; title: string; state: 'breaks' | 'recovery' | 'unaffected'; note: string }[];
}

export interface Impact {
  id: string;
  kind: 'part' | 'boundary';
  name: string;
  /** The view it is in: owner ids from the document inward. */
  room: string[];
  /** The shapes whose insides it is drawn in, nearest first. A change to it is a change to them. */
  inside: string[];
  /** Parts drawn in its own inside view, or held by it when it is a boundary. */
  contains: string[];
  /** Where its work goes, following the arrows, nearest first. */
  downstream: ImpactReach;
  /** What leads to it, following the arrows back, nearest first. */
  upstream: ImpactReach;
  /** Its own relations that cross a boundary, with the boundaries crossed. */
  crossings: { relation: string; other: string; boundaries: string[] }[];
  /** What it points at that something else points at too. */
  shares: { id: string; with: string[] }[];
  /** Flows with a step over one of its relations. */
  flows: { id: string; title: string }[];
  /** Open points attached to it or to one of its connectors. */
  openPoints: string[];
  /** What the drawing says happens if it stops. Absent when the drawing says nothing about that. */
  outage?: ImpactOutage;
  /** How to read all of the above. */
  basis: 'Read from the drawing: what is drawn as connected, not what was measured.';
}

function reach(found: { ids: string[]; truncated: boolean }): ImpactReach {
  return { ids: found.ids.slice(0, IMPACT_LIMIT), total: found.ids.length, truncated: found.truncated };
}

/** The impact of the shape or boundary `id`, or `undefined` when the file has no such part. */
export function impactOf(file: DraftDocument, id: string, model: ArchModel = modelOf(file)): Impact | undefined {
  const part = model.entities.get(id);
  const boundary = part ? undefined : model.boundaries.get(id);
  const subject = part ?? boundary;
  if (!subject) return undefined;

  const room = roomsOf(file).find((candidate) => candidate.path.length === subject.room.length && candidate.path.every((owner, index) => owner === subject.room[index]));
  const own = model.relations.filter((relation) => relation.from === id || relation.to === id);
  const ownEdges = new Set(own.flatMap((relation) => relation.edges));

  const contains = boundary
    ? [...model.entities.values()].filter((entity) => entity.boundaries.includes(id)).map((entity) => entity.id)
    : (model.rooms.find((candidate) => candidate.path.length === subject.room.length + 1 && candidate.path[candidate.path.length - 1] === id)?.entities ?? []);

  const pointedAt = own.filter((relation) => relation.from === id).map((relation) => relation.to);
  const shares = pointedAt
    .filter((target, index) => pointedAt.indexOf(target) === index)
    .map((target) => ({ id: target, with: [...new Set(model.relations.filter((relation) => relation.to === target && relation.from !== id).map((relation) => relation.from))] }))
    .filter((entry) => entry.with.length > 0);

  const flows = (room?.graph.flows ?? [])
    .filter((flow) => flow.steps.some((step) => (step.edgeId && ownEdges.has(step.edgeId)) || step.extraEdgeIds?.some((edge) => ownEdges.has(edge)) || step.extraNodeIds?.includes(id)))
    .map((flow) => ({ id: flow.id, title: flow.title }));

  const openPoints = (file.openPoints ?? [])
    .filter((point) => point.targets.some((target) => (target.kind === 'node' ? target.id === id : ownEdges.has(target.id))))
    .map((point) => point.id);

  let outage: ImpactOutage | undefined;
  if (room) {
    const { nodes, edges } = room.graph;
    const read = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, { id, whole: true }, room.graph.flows);
    if (read) {
      outage = {
        headline: read.headline,
        affected: [...read.nodes].flatMap(([node, state]) => (state === 'unaffected' ? [] : [{ id: node, state }])).slice(0, IMPACT_LIMIT),
        notes: read.notes.slice(0, IMPACT_LIMIT).map((note) => ({ tone: note.tone, text: note.text, focus: note.focus })),
        flows: read.flows.map((flow) => ({ id: flow.id, title: flow.title, state: flow.state, note: flow.note })),
      };
    }
  }

  return {
    id,
    kind: part ? 'part' : 'boundary',
    name: labelOf(subject),
    room: [...subject.room],
    inside: [...subject.room].reverse(),
    contains,
    downstream: reach(downstreamOf(model, id)),
    upstream: reach(upstreamOf(model, id)),
    crossings: own
      .filter((relation) => relation.crosses.length > 0)
      .map((relation) => ({ relation: relation.id, other: relation.from === id ? relation.to : relation.from, boundaries: relation.crosses })),
    shares,
    flows,
    openPoints,
    ...(outage ? { outage } : {}),
    basis: 'Read from the drawing: what is drawn as connected, not what was measured.',
  };
}
