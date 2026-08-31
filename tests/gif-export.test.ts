import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { addFlow, createFlow } from '../src/document/flow';
import { renderFlowFrameSvg } from '../src/render/svg/flowFrame';
import { planGifFrames } from '../src/export/gif';
import { DARK } from '../src/render/theme/tokens';

function parseSvg(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

/** A→B→C, two steps, one flow — enough to exercise active/shown/hidden tiers. */
function fixture() {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  const c = createNode({ type: 'service', x: 400, y: 0, text: 'C' });
  const e1 = createEdge({ source: a.id, target: b.id, accent: 'teal' });
  const e2 = createEdge({ source: b.id, target: c.id, accent: 'amber' });
  const doc = addEdges(addNodes(createDocument('Frame fixture'), [a, b, c]), [e1, e2]);
  const flow = createFlow({ title: 'Walkthrough' });
  flow.steps = [
    { id: 'fs1', edgeId: e1.id },
    { id: 'fs2', edgeId: e2.id },
  ];
  return { doc: addFlow(doc, flow), flow, a, b, c, e1, e2 };
}

const CANVAS = { width: 960, height: 600 };
const CENTERED = { x: 0, y: 0, zoom: 1 };

function nodeGroup(svgDoc: Document, x: number, y: number): Element | undefined {
  return [...svgDoc.querySelectorAll('svg > g')].find(
    (g) => g.getAttribute('transform') === `translate(${x} ${y})`,
  );
}

/** The connector's own line — not the same-colored decorative path inside its `<marker>` def. */
function edgePath(svgDoc: Document, color: string): Element | null {
  const matches = [...svgDoc.querySelectorAll(`path[stroke="${color}"]`)];
  return matches.find((path) => !path.closest('marker')) ?? null;
}

describe('renderFlowFrameSvg (Phase 4.3 GIF export frames)', () => {
  it('lights the active step: its edge and both endpoints at full opacity, no filter', () => {
    const { doc, flow } = fixture();
    const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0);
    const parsed = parseSvg(svg);

    expect(nodeGroup(parsed, 0, 0)?.getAttribute('opacity')).toBe('1');
    expect(nodeGroup(parsed, 0, 0)?.hasAttribute('filter')).toBe(false);
    expect(nodeGroup(parsed, 200, 0)?.getAttribute('opacity')).toBe('1');

    const teal = DARK.accents.teal.chip;
    const active = edgePath(parsed, teal);
    expect(active?.closest('g')?.getAttribute('opacity')).toBe('1');
    expect(active?.getAttribute('stroke-dasharray')).toBe('3 9');
  });

  it('dims a node/edge not yet reached, mirroring canvas.css exactly', () => {
    const { doc, flow } = fixture();
    const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0);
    const parsed = parseSvg(svg);

    // C is only touched by step 2's edge, not yet reached at step 1.
    expect(nodeGroup(parsed, 400, 0)?.getAttribute('opacity')).toBe('0.3');
    expect(nodeGroup(parsed, 400, 0)?.getAttribute('filter')).toBe('grayscale(0.5)');

    const amber = DARK.accents.amber.chip;
    const hidden = edgePath(parsed, amber);
    expect(hidden?.closest('g')?.getAttribute('opacity')).toBe('0.22');
    expect(hidden?.hasAttribute('stroke-dasharray')).toBe(false);
  });

  it('advances tiers on the next step: the first edge becomes "shown", the second "active"', () => {
    const { doc, flow } = fixture();
    const { svg } = renderFlowFrameSvg(doc, flow, 2, CENTERED, CANVAS, 0);
    const parsed = parseSvg(svg);

    const teal = DARK.accents.teal.chip;
    const amber = DARK.accents.amber.chip;
    expect(edgePath(parsed, teal)?.closest('g')?.getAttribute('opacity')).toBe('0.55');
    expect(edgePath(parsed, amber)?.closest('g')?.getAttribute('opacity')).toBe('1');

    // A is only touched by the now-shown step; B is an endpoint of both, and
    // takes the best (active) tier — matching `explainNodeTier`'s contract.
    expect(nodeGroup(parsed, 0, 0)?.getAttribute('opacity')).toBe('0.65');
    expect(nodeGroup(parsed, 0, 0)?.getAttribute('filter')).toBe('grayscale(0.2)');
    expect(nodeGroup(parsed, 200, 0)?.getAttribute('opacity')).toBe('1');
  });

  it('computes the pulse dash offset deterministically, wrapping past 1', () => {
    const { doc, flow } = fixture();
    const teal = DARK.accents.teal.chip;
    const offsetAt = (phase: number) => {
      const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, phase);
      return edgePath(parseSvg(svg), teal)?.getAttribute('stroke-dashoffset');
    };
    expect(offsetAt(0)).toBe('0');
    expect(offsetAt(0.5)).toBe('-12');
    expect(offsetAt(1)).toBe('0');
  });

  it('frames the camera viewport via viewBox, not a content-bounds fit', () => {
    const { doc, flow } = fixture();
    const { svg, width, height } = renderFlowFrameSvg(
      doc,
      flow,
      1,
      { x: -100, y: -50, zoom: 2 },
      CANVAS,
      0,
    );
    expect(width).toBe(CANVAS.width);
    expect(height).toBe(CANVAS.height);
    // camX = -(-100)/2 = 50, camY = -(-50)/2 = 25, camW = 960/2, camH = 600/2.
    expect(parseSvg(svg).documentElement.getAttribute('viewBox')).toBe('50 25 480 300');
  });
});

describe('planGifFrames', () => {
  it('produces a hold per step plus a transition between them, all at the fixed sample rate', () => {
    const { doc, flow } = fixture();
    const frames = planGifFrames(doc, flow.id, 'fast');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.step).toBe(1);
    expect(frames.at(-1)!.step).toBe(2);
    expect(frames.some((f) => f.step === 1)).toBe(true);
    expect(frames.some((f) => f.step === 2)).toBe(true);
    for (const frame of frames) expect(frame.delayMs).toBe(100);
  });

  it('holds longer at "slow" than at "fast"', () => {
    const { doc, flow } = fixture();
    const slow = planGifFrames(doc, flow.id, 'slow').filter((f) => f.step === 1);
    const fast = planGifFrames(doc, flow.id, 'fast').filter((f) => f.step === 1);
    expect(slow.length).toBeGreaterThan(fast.length);
  });

  it('rejects a flow with no resolvable steps', () => {
    const { doc } = fixture();
    const empty = createFlow({ title: 'Empty' });
    const withEmpty = addFlow(doc, empty);
    expect(() => planGifFrames(withEmpty, empty.id)).toThrow();
  });
});
