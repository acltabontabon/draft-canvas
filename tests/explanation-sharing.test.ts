import { describe, expect, it } from 'vitest';
import { ORDER_PROCESSING } from '../src/starters/order-processing';
import { starterDocument, PRIMARY_STARTERS } from '../src/starters';
import { decodeShareLink, encodeShareLink } from '../src/share/link';
import { createDocument, createNode } from '../src/document/factory';
import { parseDocument } from '../src/document/validate';
import { serializeDocument } from '../src/export/project';

describe('complete example and shared starting points', () => {
  it('builds ordinary editable content with fresh ids and a playable explanation', () => {
    const first = starterDocument(ORDER_PROCESSING);
    const second = starterDocument(ORDER_PROCESSING);
    expect(first.nodes).toHaveLength(4);
    expect(first.flows[0]!.steps).toHaveLength(3);
    expect(first.nodes[1]!.attachments).toHaveLength(1);
    expect(first.nodes.map((node) => node.id)).not.toEqual(second.nodes.map((node) => node.id));
    expect(PRIMARY_STARTERS).toHaveLength(5);
    expect(parseDocument(serializeDocument(first)).ok).toBe(true);
  });

  it('opens a flow inside a nested room without modifying the original or the wire document', async () => {
    const room = starterDocument(ORDER_PROCESSING);
    const owner = { ...createNode({ type: 'service', x: 0, y: 0 }), inside: { nodes: room.nodes, edges: room.edges, flows: room.flows, viewport: room.viewport } };
    const file = { ...createDocument('Root'), nodes: [owner] };
    const before = serializeDocument(file);
    const start = { path: [owner.id], flowId: room.flows[0]!.id };
    const encoded = await encodeShareLink(file, 'https://example.test/draft-canvas/editor/', start);
    if (!('url' in encoded)) throw new Error('Expected link');
    const decoded = await decodeShareLink(new URL(encoded.url).hash);
    expect(decoded?.ok).toBe(true);
    expect(decoded?.start).toEqual(start);
    expect(serializeDocument(file)).toBe(before);
  });

  it('falls back from invalid metadata but keeps older links valid', async () => {
    const encoded = await encodeShareLink(starterDocument(ORDER_PROCESSING), 'https://example.test');
    if (!('url' in encoded)) throw new Error('Expected link');
    expect((await decodeShareLink(new URL(encoded.url).hash))?.start).toBeUndefined();
    const result = await decodeShareLink(new URL(encoded.url).hash + '&start=%7Bbroken');
    expect(result?.ok).toBe(true);
    expect(result?.startWarning).toContain('overview');
  });
});

it('counts starting metadata toward the encoded limit and rejects unavailable references', async () => {
  const document = starterDocument(ORDER_PROCESSING);
  const valid = await encodeShareLink(document, 'https://example.test/editor/');
  if (!('url' in valid)) throw new Error('Expected link');
  for (const start of [{ path: ['missing'] }, { path: [], flowId: 'missing' }]) {
    const parsed = await decodeShareLink(new URL(valid.url).hash + '&start=' + encodeURIComponent(JSON.stringify(start)));
    expect(parsed?.ok).toBe(true);
    expect(parsed?.start).toBeUndefined();
    expect(parsed?.startWarning).toContain('overview');
  }
  const tooLarge = await encodeShareLink(document, 'https://example.test/editor/', { path: ['x'.repeat(33000)] });
  expect('tooLarge' in tooLarge).toBe(true);
});
