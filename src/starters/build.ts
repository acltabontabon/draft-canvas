/**
 * Turns an authored `ArchitectureStarter` into real document elements.
 *
 * Pure and deterministic apart from id generation: the same starter always produces the same
 * geometry, which is what `tests/starters.test.ts` asserts against and what makes a starter safe to
 * insert twice on one canvas.
 */

import { inferRelationship } from '../document/connectorSemantics';
import { createEdge, createNode, defaultSizeFor } from '../document/factory';
import type { DraftEdge, DraftNode } from '../document/types';
import type { ArchitectureStarter, StarterNodeSpec } from './types';

export interface BuiltStarter {
  nodes: DraftNode[];
  edges: DraftEdge[];
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
    });
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
  for (const spec of starter.edges) {
    const sourceId = ids.get(spec.from);
    const targetId = ids.get(spec.to);
    if (!sourceId || !targetId) continue;
    const source = byId.get(sourceId)!;
    const target = byId.get(targetId)!;
    const relationship = inferRelationship(source, target);
    edges.push(
      createEdge({
        source: sourceId,
        target: targetId,
        sourceAnchor: spec.sourceAnchor,
        targetAnchor: spec.targetAnchor,
        semantic: relationship?.semantic,
        kind: relationship?.kind,
        semanticsOrigin: relationship?.semantic ? 'inferred' : undefined,
        ...(spec.label !== undefined ? { label: spec.label } : {}),
        ...(spec.condition !== undefined ? { condition: spec.condition } : {}),
        ...(spec.routeMode !== undefined ? { routeMode: spec.routeMode } : {}),
        ...(spec.routing !== undefined ? { routing: spec.routing } : {}),
      }),
    );
  }

  return { nodes, edges };
}
