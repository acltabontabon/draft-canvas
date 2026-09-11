/**
 * Turns an authored `ArchitectureStarter` into real document elements.
 *
 * Pure and deterministic apart from id generation: the same starter always produces the same
 * geometry, which is what `tests/starters.test.ts` asserts against and what makes a starter safe to
 * insert twice on one canvas.
 */

import { capabilityFor, categoryOf, inferRelationship } from '../document/connectorSemantics';
import { createAttachment, createEdge, createNode, defaultSizeFor } from '../document/factory';
import { createFlow } from '../document/flow';
import { createId } from '../document/ids';
import { LIMITS } from '../document/limits';
import type { DraftEdge, DraftFlow, DraftFlowStep, DraftNode } from '../document/types';
import type { ArchitectureStarter, StarterNodeSpec } from './types';

export interface BuiltStarter {
  nodes: DraftNode[];
  edges: DraftEdge[];
  /** The starter's predefined flows, already pointing at `edges`' generated ids. Empty for most. */
  flows: DraftFlow[];
}

/** How many `group` ancestors a spec has. Drives z-order so a nested boundary sits in front of the
 *  one containing it, and both sit behind ordinary nodes. */
function groupDepth(spec: StarterNodeSpec, byKey: Map<string, StarterNodeSpec>): number {
  let depth = 0;
  let parent = spec.parent ? byKey.get(spec.parent) : undefined;
  while (parent) {
    if (parent.type === 'group') depth += 1;
    parent = parent.parent ? byKey.get(parent.parent) : undefined;
  }
  return depth;
}

export function sizeOfSpec(spec: StarterNodeSpec): { width: number; height: number } {
  const fallback = defaultSizeFor(spec.type);
  return { width: spec.width ?? fallback.width, height: spec.height ?? fallback.height };
}

/** The starter's own bounding box, in starter-local coordinates. */
export function starterSize(starter: ArchitectureStarter): { width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const spec of starter.nodes) {
    const size = sizeOfSpec(spec);
    minX = Math.min(minX, spec.x);
    minY = Math.min(minY, spec.y);
    maxX = Math.max(maxX, spec.x + size.width);
    maxY = Math.max(maxY, spec.y + size.height);
  }
  if (minX === Infinity) return { width: 0, height: 0 };
  return { width: maxX - minX, height: maxY - minY };
}

/**
 * Builds the starter with its bounding box's top-left corner at `origin`.
 *
 * Every edge's `semantic`/`kind` comes from the capability matrix rather than from the catalog, so
 * a starter's relationships are the same ones the user would have got by drawing the connection
 * themselves — and `semanticsOrigin: 'inferred'` keeps them eligible for re-inference if the user
 * later changes a node's kind, exactly like a hand-drawn connector. `hasResponse` is deliberately
 * never set: `connect()` doesn't draw a reply line by default either, and an architecture starter
 * is the last place that wants its arrow count doubled.
 */
export function buildStarter(
  starter: ArchitectureStarter,
  origin: { x: number; y: number },
): BuiltStarter {
  const byKey = new Map(starter.nodes.map((spec) => [spec.key, spec]));
  let minX = Infinity;
  let minY = Infinity;
  for (const spec of starter.nodes) {
    minX = Math.min(minX, spec.x);
    minY = Math.min(minY, spec.y);
  }
  const dx = origin.x - (minX === Infinity ? 0 : minX);
  const dy = origin.y - (minY === Infinity ? 0 : minY);

  const deepest = starter.nodes.reduce(
    (max, spec) => (spec.type === 'group' ? Math.max(max, groupDepth(spec, byKey)) : max),
    0,
  );

  const ids = new Map<string, string>();
  const nodes: DraftNode[] = starter.nodes.map((spec) => {
    const size = sizeOfSpec(spec);
    const node = createNode({
      type: spec.type,
      x: Math.round(spec.x + dx),
      y: Math.round(spec.y + dy),
      width: size.width,
      height: size.height,
      // A boundary must render behind what it contains, and a nested one in front of its own
      // container — the same "boundary first" ordering `groupSelection` establishes with `minZ - 1`.
      z: spec.type === 'group' ? groupDepth(spec, byKey) - deepest - 1 : 0,
      ...(spec.text !== undefined ? { text: spec.text } : {}),
      ...(spec.accent !== undefined ? { accent: spec.accent } : {}),
      ...(spec.serviceKind ? { serviceKind: spec.serviceKind } : {}),
      ...(spec.databaseKind ? { databaseKind: spec.databaseKind } : {}),
      ...(spec.queueKind ? { queueKind: spec.queueKind } : {}),
      ...(spec.actorKind ? { actorKind: spec.actorKind } : {}),
      ...(spec.componentKind ? { componentKind: spec.componentKind } : {}),
      ...(spec.boundaryPreset ? { boundaryPreset: spec.boundaryPreset } : {}),
      ...(spec.annotation ? { annotation: spec.annotation } : {}),
      ...(spec.deliveryRole ? { deliveryRole: spec.deliveryRole } : {}),
    });
    if (spec.attachments?.length) node.attachments = spec.attachments.map(createAttachment);
    ids.set(spec.key, node.id);
    return node;
  });

  // Parenting is a second pass: a spec may name a parent declared after it.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const spec of starter.nodes) {
    if (!spec.parent) continue;
    const parentId = ids.get(spec.parent);
    const node = byId.get(ids.get(spec.key)!);
    if (parentId && node) node.parentId = parentId;
  }

  const edges: DraftEdge[] = [];
  const edgeIds = new Map<string, string>();
  for (const spec of starter.edges) {
    const sourceId = ids.get(spec.from);
    const targetId = ids.get(spec.to);
    if (!sourceId || !targetId) continue;
    const source = byId.get(sourceId)!;
    const target = byId.get(targetId)!;
    const relationship = inferRelationship(source, target);
    // An authored relation counts only if the matrix offers it for this pairing — see
    // `StarterEdgeSpec.semantic`. Then it is the user's own explicit pick, origin included.
    const offered = capabilityFor(categoryOf(source), categoryOf(target))?.relations ?? [];
    const explicit = spec.semantic !== undefined && offered.includes(spec.semantic) ? spec.semantic : undefined;
    const edge = createEdge({
      source: sourceId,
      target: targetId,
      sourceAnchor: spec.sourceAnchor,
      targetAnchor: spec.targetAnchor,
      semantic: explicit ?? relationship?.semantic,
      kind: relationship?.kind,
      async: relationship?.async,
      semanticsOrigin: explicit ? 'explicit' : relationship?.semantic ? 'inferred' : undefined,
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
      ...(spec.routeMode !== undefined ? { routeMode: spec.routeMode } : {}),
      ...(spec.routing !== undefined ? { routing: spec.routing } : {}),
      ...(spec.deliveryAttempts !== undefined ? { deliveryAttempts: spec.deliveryAttempts } : {}),
      ...(spec.accent !== undefined ? { accent: spec.accent } : {}),
    });
    // Same assignment `convertToJunction` makes — `createEdge` has no attachment input of its own.
    if (spec.attachments?.length) edge.attachments = spec.attachments.map(createAttachment);
    if (spec.key !== undefined) edgeIds.set(spec.key, edge.id);
    edges.push(edge);
  }

  // A flow is built the way `addStepToFlow` would build it, one step per resolved key, so a
  // starter's flow is indistinguishable from one the user assembled by hand. An unresolved key is
  // skipped rather than thrown: `tests/starters.test.ts` guarantees the catalog has none.
  const flows: DraftFlow[] = (starter.flows ?? []).map((spec) => {
    const flow = createFlow({ title: spec.title });
    if (spec.accent) flow.accent = spec.accent;
    for (const stepSpec of spec.steps) {
      if (flow.steps.length >= LIMITS.maxStepsPerFlow) break;
      const edgeId = edgeIds.get(stepSpec.edgeKey);
      if (!edgeId) continue;
      const step: DraftFlowStep = { id: createId('fs'), edgeId };
      if (stepSpec.caption?.trim()) step.caption = stepSpec.caption.trim().slice(0, LIMITS.maxLabelLength);
      flow.steps.push(step);
    }
    return flow;
  });

  return { nodes, edges, flows };
}
