import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { describeEdge } from '../src/edges/describe';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { replyLabelPlan } from '../src/edges/replyLabels';
import { flattenPath } from '../src/edges/routing';
import { deserializeDocument } from '../src/export/project';
import { getMeasurer } from '../src/render/text/measure';
import { DARK } from '../src/render/theme/tokens';

/**
 * Reply labels of neighbouring connectors keep clear of each other (`edges/replyLabels.ts`): each is
 * placed from its own connector alone, so two replies coming home along one corridor could be written
 * over each other.
 */

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Every reply label's box as the exporter draws it, with or without the plan's shifts. */
function replyBoxes(doc: Pick<DraftDocument, 'nodes' | 'edges'>, shifted: boolean): Map<string, Box> {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const plan = replyLabelPlan(doc.nodes, doc.edges, 'transient');
  const boxes = new Map<string, Box>();
  for (const edge of doc.edges) {
    if (!edge.hasResponse || !edge.response) continue;
    const routes = connectorRoutes(edge, doc, 'transient', byId);
    if (!routes) continue;
    const described = describeEdge(edge, byId, {
      theme: DARK, measurer: getMeasurer(), showSequence: false, routes,
      ...(shifted ? { replyShift: plan.shiftFor(edge.id) } : {}),
    })!;
    // The reply's mask is drawn before the request's own chip, so it is the overlay's first rect.
    const rects = described.overlay.filter((shape) => shape.t === 'rect') as unknown as Box[];
    boxes.set(edge.id, rects[0]!);
  }
  return boxes;
}

function overlapping(boxes: Map<string, Box>): string[] {
  const ids = [...boxes.keys()];
  const pairs: string[] = [];
  for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
    if (overlap(boxes.get(ids[i]!)!, boxes.get(ids[j]!)!)) pairs.push(`${ids[i]}|${ids[j]}`);
  }
  return pairs;
}

function saga(): DraftDocument {
  const text = readFileSync(resolve(process.cwd(), 'tests/fixtures/starters/starters/patterns/saga-orchestration/saga-orchestration.draftcanvas'), 'utf8');
  const parsed = deserializeDocument(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

describe('reply labels beside each other', () => {
  it('moves the Saga starter’s two reply labels off each other, each still on its own run', () => {
    const doc = saga();
    expect(overlapping(replyBoxes(doc, false))).toHaveLength(1);
    expect(overlapping(replyBoxes(doc, true))).toEqual([]);

    const byId = new Map(doc.nodes.map((node) => [node.id, node]));
    const plan = replyLabelPlan(doc.nodes, doc.edges, 'transient');
    let moved = 0;
    for (const edge of doc.edges) {
      const shift = plan.shiftFor(edge.id);
      if (!shift) continue;
      moved += 1;
      // Along the run only, and the anchor stays on a stretch of the reply line.
      expect(shift.x === 0 || shift.y === 0).toBe(true);
      const routes = connectorRoutes(edge, doc, 'transient', byId)!;
      const at = { x: routes.responseLabel!.x + shift.x, y: routes.responseLabel!.y + shift.y };
      const vertices = flattenPath(routes.response!.d);
      const onLine = vertices.some((b, i) => {
        if (i === 0) return false;
        const a = vertices[i - 1]!;
        return at.x >= Math.min(a.x, b.x) - 0.5 && at.x <= Math.max(a.x, b.x) + 0.5 && at.y >= Math.min(a.y, b.y) - 0.5 && at.y <= Math.max(a.y, b.y) + 0.5;
      });
      expect(onLine, edge.id).toBe(true);
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('leaves reply labels with room where they were, and costs nothing without replies', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'Orders' });
    const b = createNode({ id: 'b', type: 'service', x: 500, y: 0, text: 'Billing' });
    const c = createNode({ id: 'c', type: 'service', x: 500, y: 400, text: 'Stock' });
    const far = [
      { ...createEdge({ id: 'ab', source: 'a', target: 'b', label: 'Charge', hasResponse: true }), response: 'charged / declined' },
      { ...createEdge({ id: 'ac', source: 'a', target: 'c', label: 'Reserve', hasResponse: true }), response: 'reserved / failed' },
    ];
    const plan = replyLabelPlan([a, b, c], far, 'transient');
    expect(plan.shiftFor('ab')).toBeUndefined();
    expect(plan.shiftFor('ac')).toBeUndefined();
    const plain = [createEdge({ id: 'p', source: 'a', target: 'b', label: 'Charge' })];
    expect(replyLabelPlan([a, b], plain, 'transient').shiftFor('p')).toBeUndefined();
  });

  it('hands back the same plan for the same view', () => {
    const doc = saga();
    expect(replyLabelPlan(doc.nodes, doc.edges, 'transient')).toBe(replyLabelPlan(doc.nodes, doc.edges, 'transient'));
  });
});
