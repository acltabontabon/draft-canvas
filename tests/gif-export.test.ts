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

/** One step, one connector — with (or, for a control case, without) a `response` set. */
function responseFixture(response?: string) {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  // `response`, like `condition`, is only ever set post-creation — see `rendering.test.ts`'s
  // identical fixture for why this spreads it on rather than passing it to `createEdge`.
  // `hasResponse` is the independent gate for the reply line/pulse's existence — see
  // `DraftEdge.hasResponse`.
  const e1 = {
    ...createEdge({ source: a.id, target: b.id, accent: 'teal' as const }),
    response,
    hasResponse: Boolean(response),
  };
  const doc = addEdges(addNodes(createDocument('Response fixture'), [a, b]), [e1]);
  const flow = createFlow({ title: 'Walkthrough' });
  flow.steps = [{ id: 'fs1', edgeId: e1.id }];
  return { doc: addFlow(doc, flow), flow, e1 };
}

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

  it('reflects the selected Intentional Roughness preset in every frame, not Clean by default', () => {
    const { doc, flow } = fixture();
    const clean = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0);
    const sketch = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0, 'request', { preset: 'sketch' });
    expect(sketch.svg).not.toBe(clean.svg);
  });

  it('composes preset jitter with Presentation Mode tier decoration independently', () => {
    const { doc, flow } = fixture();
    const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0, 'request', { preset: 'sketch' });
    const parsed = parseSvg(svg);
    // The active node's tier opacity is unaffected by the preset.
    expect(nodeGroup(parsed, 0, 0)?.getAttribute('opacity')).toBe('1');
    expect(nodeGroup(parsed, 400, 0)?.getAttribute('opacity')).toBe('0.3');
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

describe('planGifFrames — request/response phase split', () => {
  it('tags every hold frame "request" for a step whose edge has no response', () => {
    const { doc, flow } = responseFixture();
    const frames = planGifFrames(doc, flow.id, 'slow').filter((f) => f.step === 1);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame.phase).toBe('request');
  });

  it('splits the hold into a request run followed by a response run when the edge has one', () => {
    const responseFx = responseFixture('200 Customer');
    const plainFx = responseFixture();
    const withResponse = planGifFrames(responseFx.doc, responseFx.flow.id, 'slow').filter((f) => f.step === 1);
    const withoutResponse = planGifFrames(plainFx.doc, plainFx.flow.id, 'slow').filter((f) => f.step === 1);
    // Same total frame count either way — a response never drops or adds a frame, only relabels some.
    expect(withResponse.length).toBe(withoutResponse.length);

    const phases = withResponse.map((f) => f.phase);
    const firstResponseIndex = phases.indexOf('response');
    expect(firstResponseIndex).toBeGreaterThan(0);
    // Every frame before the switch is 'request', every one from the switch on is 'response' — one
    // contiguous run each, not interleaved.
    expect(phases.slice(0, firstResponseIndex).every((p) => p === 'request')).toBe(true);
    expect(phases.slice(firstResponseIndex).every((p) => p === 'response')).toBe(true);
    // Each phase's own pulse restarts from 0 at the switch, mirroring the live CSS animation
    // starting fresh on whichever line just began matching `[data-flow-active]`.
    expect(withResponse[firstResponseIndex]!.pulsePhase).toBe(0);
  });
});

describe('renderFlowFrameSvg — request/response pulse targeting', () => {
  it("pulses the primary line, not the response line, during the 'request' phase", () => {
    const { doc, flow } = responseFixture('200 Customer');
    const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0.5, 'request');
    const parsed = parseSvg(svg);
    const teal = DARK.accents.teal.chip;
    const paths = [...parsed.querySelectorAll(`path[stroke="${teal}"]`)].filter((p) => !p.closest('marker'));
    expect(paths.length).toBe(2);
    const primary = paths.find((p) => p.getAttribute('stroke-width') === '1.6');
    const response = paths.find((p) => p.getAttribute('stroke-width') === '1');
    expect(primary?.hasAttribute('stroke-dashoffset')).toBe(true);
    expect(response?.hasAttribute('stroke-dashoffset')).toBe(false);
  });

  it("pulses the response line, not the primary line, during the 'response' phase", () => {
    const { doc, flow } = responseFixture('200 Customer');
    const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0.5, 'response');
    const parsed = parseSvg(svg);
    const teal = DARK.accents.teal.chip;
    const paths = [...parsed.querySelectorAll(`path[stroke="${teal}"]`)].filter((p) => !p.closest('marker'));
    const primary = paths.find((p) => p.getAttribute('stroke-width') === '1.6');
    const response = paths.find((p) => p.getAttribute('stroke-width') === '1');
    expect(primary?.hasAttribute('stroke-dashoffset')).toBe(false);
    expect(response?.hasAttribute('stroke-dashoffset')).toBe(true);
  });

  it("ignores framePhase for a step whose edge has no response — always pulses the one line", () => {
    const { doc, flow } = responseFixture();
    const { svg } = renderFlowFrameSvg(doc, flow, 1, CENTERED, CANVAS, 0.5, 'response');
    const teal = DARK.accents.teal.chip;
    const path = edgePath(parseSvg(svg), teal);
    expect(path?.hasAttribute('stroke-dashoffset')).toBe(true);
  });
});
