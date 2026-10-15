/**
 * Applies `place` requests (`placement.ts`) to a view: exact or relative positions and sizes, with
 * what rides along — a group's contents, free notes sitting right beside a moved shape, and the bends
 * of a connector whose both ends moved together.
 */

import { LIMITS } from '../document/limits';
import { updateNode } from '../document/operations';
import type { DraftDocument, DraftNode } from '../document/types';
import type { DescribeContext } from '../nodes/describe';
import { fitGroups, nearestShape } from './arrange';
import { AgentError } from './errors';
import { sizeToFit } from './place';
import type { PlaceSpec } from './placement';

const DEFAULT_GAP = 48;
/** How far a free note may sit from a shape and still move with it — `arrange`'s own reach. */
const BESIDE_REACH = 48;

/** The smallest a shape may be made: what its text needs (the type's floor for a shape without). */
function minimumSize(node: DraftNode, ctx: DescribeContext): { width: number; height: number } {
  if (node.type === 'group') return { width: LIMITS.minNodeSize, height: LIMITS.minNodeSize };
  try {
    const fitted = sizeToFit({ ...node, width: LIMITS.minNodeSize, height: LIMITS.minNodeSize }, ctx);
    return { width: Math.max(LIMITS.minNodeSize, fitted.width), height: Math.max(LIMITS.minNodeSize, fitted.height) };
  } catch {
    return { width: node.width, height: node.height };
  }
}

function descendants(view: DraftDocument, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length) {
    const at = queue.shift()!;
    for (const node of view.nodes) {
      if (node.parentId !== at || seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node.id);
      queue.push(node.id);
    }
  }
  return out;
}

const isFreeNote = (node: DraftNode) => node.type === 'note' || node.type === 'code' || node.type === 'text';

/**
 * Puts every node in `places` where it says, in dependency order (a node beside another that is
 * itself being placed goes after it). Moving a group moves what it holds; a free note sitting right
 * beside a moved shape goes with it; boundaries grow to hold what moved into or across them.
 */
export function applyPlaces(view: DraftDocument, places: ReadonlyMap<string, PlaceSpec>, ctx: DescribeContext, at = '/place'): DraftDocument {
  if (places.size === 0) return view;
  for (const id of places.keys()) {
    if (!view.nodes.some((n) => n.id === id)) throw new AgentError('INVALID_REFERENCE', `${at}: nothing called "${id}" in this view to place.`);
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, chain: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      throw new AgentError('INVALID_INPUT', `${at}: placements refer to each other in a loop (${[...chain, id].join(' → ')}).`);
    }
    state.set(id, 'visiting');
    const target = places.get(id)?.beside?.id;
    if (target !== undefined) {
      if (target === id) throw new AgentError('INVALID_INPUT', `${at}: "${id}" can't be placed beside itself.`);
      if (!view.nodes.some((n) => n.id === target)) throw new AgentError('INVALID_REFERENCE', `${at}: "${id}" is placed beside "${target}", which isn't in this view.`);
      if (places.has(target)) visit(target, [...chain, id]);
    }
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of places.keys()) visit(id, []);

  let next = view;
  for (const id of order) {
    const spec = places.get(id)!;
    const node = next.nodes.find((n) => n.id === id)!;
    const floor = minimumSize(node, ctx);
    const width = spec.width !== undefined ? Math.max(spec.width, node.type === 'group' ? spec.width : floor.width) : node.width;
    let height = spec.height !== undefined ? Math.max(spec.height, floor.height) : node.height;
    // Narrower can mean taller: a note's text wraps onto more lines.
    if (spec.width !== undefined && node.type !== 'group') height = Math.max(height, minimumSize({ ...node, width }, ctx).height);
    let x = node.x;
    let y = node.y;
    if (spec.beside) {
      const other = next.nodes.find((n) => n.id === spec.beside!.id)!;
      const gap = spec.gap ?? DEFAULT_GAP;
      const along = (start: number, size: number, own: number) =>
        spec.align === 'start' ? start : spec.align === 'end' ? start + size - own : start + (size - own) / 2;
      switch (spec.beside.relation) {
        case 'rightOf':
          x = other.x + other.width + gap;
          y = along(other.y, other.height, height);
          break;
        case 'leftOf':
          x = other.x - gap - width;
          y = along(other.y, other.height, height);
          break;
        case 'below':
          y = other.y + other.height + gap;
          x = along(other.x, other.width, width);
          break;
        case 'above':
          y = other.y - gap - height;
          x = along(other.x, other.width, width);
          break;
      }
    }
    if (spec.x !== undefined) x = spec.x;
    if (spec.y !== undefined) y = spec.y;
    x = Math.round(x);
    y = Math.round(y);
    const dx = x - node.x;
    const dy = y - node.y;
    // What travels with it: a group's contents, and free notes sitting right beside it.
    const riders = new Set(node.type === 'group' ? descendants(next, id) : []);
    if (node.type !== 'group' && (dx || dy)) {
      for (const other of next.nodes) {
        if (!isFreeNote(other) || other.id === id || places.has(other.id) || other.parentId !== node.parentId) continue;
        if (nearestShape(other, next.nodes, BESIDE_REACH)?.id === id) riders.add(other.id);
      }
    }
    next = updateNode(next, id, { x, y, width, height });
    for (const rider of riders) {
      if (places.has(rider)) continue;
      const moving = next.nodes.find((n) => n.id === rider)!;
      next = updateNode(next, rider, { x: moving.x + dx, y: moving.y + dy });
    }
    // Bends on a connector whose both ends just moved together go with them, as in the editor.
    if (dx || dy) {
      const moved = new Set([id, ...riders]);
      next = {
        ...next,
        edges: next.edges.map((edge) =>
          edge.waypoints && moved.has(edge.source) && moved.has(edge.target)
            ? { ...edge, waypoints: edge.waypoints.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
            : edge,
        ),
      };
    }
    next = fitGroups(next, id);
  }
  return next;
}
