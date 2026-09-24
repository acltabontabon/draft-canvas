/**
 * `{op:"arrange", move:false}`: re-anchor connectors touching the scope without moving, resizing or
 * re-peer-sizing anything, and without disturbing an untouched neighbour's own anchor or the slot it
 * already occupies on a shared side.
 */
import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { applyUpdate } from '../../src/agent/patch';
import type { DraftDocument, DraftNode } from '../../src/document/types';
import { deserializeDocument } from '../../src/export/project';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_routeonly00').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const byId = (doc: DraftDocument, id: string) => doc.nodes.find((n) => n.id === id) as DraftNode;
const geometry = (n: DraftNode) => ({ x: n.x, y: n.y, width: n.width, height: n.height });

function hub() {
  return build({
    nodes: [
      { id: 'p', type: 'service', label: 'P' },
      { id: 'q', type: 'service', label: 'Q' },
      { id: 'r', type: 'service', label: 'R' },
      { id: 'hub', type: 'service', label: 'Hub' },
    ],
    relationships: [
      { id: 'pe', from: 'p', to: 'hub' },
      { id: 'qe', from: 'q', to: 'hub' },
      { id: 're', from: 'r', to: 'hub' },
    ],
  });
}

describe('route-only arrange (move: false)', () => {
  it('never moves, resizes or re-peer-sizes a shape, even when normalization is requested', () => {
    // A/B start out genuinely different sizes (peer sizing off at creation); move:false must leave
    // them exactly as they are even though normalizePeerSizes is explicitly asked for here.
    const original = build({
      layout: { normalizePeerSizes: false },
      nodes: [
        { id: 'a', type: 'external-system', label: 'A' },
        { id: 'b', type: 'external-system', label: 'B', description: 'A description long enough to need a taller box on its own.' },
      ],
    });
    const before = new Map(original.nodes.map((n) => [n.id, geometry(n)]));
    const { file } = applyUpdate(original, [], [{ op: 'arrange', move: false }], { normalizePeerSizes: true });
    for (const node of file.nodes) expect(geometry(node), node.id).toEqual(before.get(node.id));
  });

  it("re-anchors only the edges touching the scope, and never rewrites or collides with an untouched neighbour's anchor", () => {
    const base = hub();
    const before = base.edges.find((e) => e.id === 're')!;
    const { file, counts } = applyUpdate(base, [], [{ op: 'arrange', move: false, scope: { nodes: ['p', 'q'] } }], undefined);
    // The out-of-scope edge (r -> hub) is byte-identical: never touched, not even re-anchored to the
    // same value it already had.
    expect(file.edges.find((e) => e.id === 're')).toEqual(before);
    // Only the two in-scope edges were counted as arranged.
    expect(counts.arranged).toBe(2);
    // Neither of the newly re-anchored edges landed on the slot the untouched neighbour already has.
    const pe = file.edges.find((e) => e.id === 'pe')!;
    const qe = file.edges.find((e) => e.id === 'qe')!;
    const slot = (a?: { side: string; offset: number }) => (a ? `${a.side}@${a.offset}` : undefined);
    const taken = slot(before.targetAnchor);
    expect(slot(pe.targetAnchor)).not.toBe(taken);
    expect(slot(qe.targetAnchor)).not.toBe(taken);
    expect(slot(pe.targetAnchor)).not.toBe(slot(qe.targetAnchor));
    // No node moved.
    for (const node of file.nodes) expect(geometry(node), node.id).toEqual(geometry(byId(base, node.id)));
  });

  it('keeps a manual routing override under move:false + connectors:"keep", and drops it under the tidy default', () => {
    const base = hub();
    const routed: DraftDocument = { ...base, edges: base.edges.map((e) => (e.id === 'pe' ? { ...e, routeMode: 'direct' as const } : e)) };
    const kept = applyUpdate(routed, [], [{ op: 'arrange', move: false, connectors: 'keep', scope: { nodes: ['p'] } }], undefined);
    expect(kept.file.edges.find((e) => e.id === 'pe')!.routeMode).toBe('direct');
    const tidied = applyUpdate(routed, [], [{ op: 'arrange', move: false, scope: { nodes: ['p'] } }], undefined);
    expect(tidied.file.edges.find((e) => e.id === 'pe')!.routeMode).toBeUndefined();
  });
});
