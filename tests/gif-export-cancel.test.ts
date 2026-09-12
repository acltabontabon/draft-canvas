import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { addFlow, createFlow } from '../src/document/flow';

// Rasterizing, encoding, and downloading need a real browser; the frame loop around them is what's
// under test here.
vi.mock('../src/render/png/rasterize', () => ({
  rasterizeSvgToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
}));
vi.mock('../src/export/download', () => ({ downloadBlob: vi.fn() }));
vi.mock('gifenc', () => ({
  GIFEncoder: () => ({ writeFrame: vi.fn(), finish: vi.fn(), bytes: () => new Uint8Array() }),
  quantize: () => [[0, 0, 0]],
  applyPalette: () => new Uint8Array(1),
}));

const { exportFlowGifFile, planGifFrames } = await import('../src/export/gif');
const { downloadBlob } = await import('../src/export/download');

function fixture() {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  const edge = createEdge({ source: a.id, target: b.id });
  const flow = createFlow({ title: 'Walkthrough' });
  flow.steps = [{ id: 'fs1', edgeId: edge.id }];
  return { doc: addFlow(addEdges(addNodes(createDocument('Gif'), [a, b]), [edge]), flow), flow };
}

describe('exportFlowGifFile — progress and cancellation', () => {
  beforeEach(() => vi.mocked(downloadBlob).mockClear());

  it('reports progress for every frame, in order, then downloads', async () => {
    const { doc, flow } = fixture();
    const total = planGifFrames(doc, flow.id, 'fast').length;
    const seen: number[] = [];
    await exportFlowGifFile(doc, flow.id, {
      speed: 'fast',
      onProgress: (done, of) => {
        expect(of).toBe(total);
        seen.push(done);
      },
    });
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(downloadBlob).toHaveBeenCalledOnce();
  });

  it('stops between frames once aborted, and never downloads', async () => {
    const { doc, flow } = fixture();
    const controller = new AbortController();
    let frames = 0;
    const exported = exportFlowGifFile(doc, flow.id, {
      speed: 'fast',
      signal: controller.signal,
      onProgress: (done) => {
        frames = done;
        if (done === 2) controller.abort();
      },
    });
    await expect(exported).rejects.toMatchObject({ name: 'AbortError' });
    expect(frames).toBe(2);
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
