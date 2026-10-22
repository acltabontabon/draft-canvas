import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'fflate';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { createOpenPoint } from '../src/document/openPoints';
import { createFlow } from '../src/document/flow';
import { serializeDocument } from '../src/export/project';
import { compactShareSnapshot } from '../src/share/compact';
import { compressShare } from '../src/share/compress';
import { decodeShareLink, encodeShareLink } from '../src/share/link';
import { encryptExportBytes } from '../src/crypto/passphraseExport';

afterEach(() => vi.unstubAllGlobals());

describe('compact sharing', () => {
  it.each([undefined, 'separate rich text passphrase'])('preserves rich text and actor styling through a share link (%s)', async (passphrase) => {
    const file = createDocument('Styled reader');
    const text = createNode({ type: 'text', x: 20, y: 40, width: 360, text: '## Release **checklist**\n- [x] Validate `order.id`\n- [ ] [Review]{.rose}', textFont: 'serif', textBackground: 'card', textBold: true, textItalic: true, textAlign: 'center', accent: 'violet' });
    const agent = createNode({ type: 'actor', x: 480, y: 40, text: 'Review assistant', actorKind: 'agent', actorFrame: 'borderless' });
    agent.inside = { nodes: [text], edges: [], flows: [], viewport: file.viewport };
    file.nodes = [agent];
    const before = serializeDocument(file);
    const encoded = await encodeShareLink(file, 'https://app.draftcanvas.dev/', { path: [agent.id] }, passphrase);
    if (!('url' in encoded)) throw new Error('Expected a link');
    const decoded = await decodeShareLink(new URL(encoded.url).hash, passphrase);
    if (!decoded?.ok) throw new Error('Expected a document');
    expect(decoded.repairs).toEqual([]);
    expect(decoded.document.nodes[0]).toMatchObject({ actorKind: 'agent', actorFrame: 'borderless', text: agent.text });
    expect(decoded.document.nodes[0]!.inside!.nodes[0]).toMatchObject({ text: text.text, textFont: 'serif', textBackground: 'card', textBold: true, textItalic: true, textAlign: 'center', accent: 'violet', width: 360 });
    expect(decoded.start?.path).toEqual([decoded.document.nodes[0]!.id]);
    expect(serializeDocument(file)).toBe(before);
  });

  it('preserves content and geometry while remapping every structural reference, including nested starting points', () => {
    const file = createDocument('Shared architecture');
    const boundary = createNode({ type: 'group', x: -30, y: -30 });
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'API', technology: 'TypeScript' });
    api.parentId = boundary.id;
    api.attachments = [{ id: 'a-long-random-id', type: 'code', code: `const original = '${api.id}';`, language: 'typescript' }];
    const inner = createNode({ type: 'component', x: 12, y: 34, text: 'Handler', description: 'Validate the request.' });
    inner.evidence = [{ path: 'src/handler.ts', basis: 'observed', line: 42 }];
    const innerFlow = createFlow({ title: 'Inspect handler' });
    innerFlow.steps = [{ id: 'fs-inner-long', extraNodeIds: [inner.id], caption: 'Validate input.' }];
    api.inside = { nodes: [inner], edges: [], flows: [innerFlow], viewport: { x: 4, y: 8, zoom: 1.2 } };
    const db = createNode({ type: 'database', x: 300, y: 0 });
    const edge = createEdge({ source: api.id, target: db.id, label: 'Store' });
    edge.waypoints = [{ x: 200, y: 80 }];
    edge.sourceAnchor = { side: 'right', offset: 0.5 };
    edge.attachments = [{ id: 'a-edge-long', type: 'note', noteKind: 'decision', text: 'Use transactions.' }];
    const flow = createFlow({ title: 'Write' });
    flow.steps = [{ id: 'fs-long', edgeId: edge.id, extraEdgeIds: [edge.id], extraNodeIds: [api.id], viewport: { x: 1, y: 2, zoom: 0.8 } }];
    const variant = { ...createFlow({ title: 'Alternative' }), variantOf: flow.id, steps: [{ id: 'fs-variant-long', edgeId: edge.id }] };
    file.nodes = [boundary, api, db];
    file.edges = [edge];
    file.flows = [flow, variant];
    file.openPoints = [createOpenPoint('awaiting', [{ kind: 'node', id: inner.id }, { kind: 'edge', id: edge.id }], 'Confirm validation policy.')!];
    const before = serializeDocument(file);
    const compact = compactShareSnapshot(JSON.stringify({ document: file, start: { path: [api.id], flowId: innerFlow.id } }));
    const [, nextApi, nextDb] = compact.document.nodes;
    const nextInner = nextApi!.inside!.nodes[0]!;
    expect(nextApi!.parentId).toBe(compact.document.nodes[0]!.id);
    expect(nextApi).toMatchObject({ type: api.type, x: api.x, y: api.y, width: api.width, height: api.height, text: api.text, technology: api.technology });
    expect(nextApi!.attachments![0]!.code).toBe(api.attachments[0]!.code);
    expect(nextInner).toMatchObject({ x: 12, y: 34, text: 'Handler', description: inner.description, evidence: inner.evidence });
    expect(compact.document.edges[0]).toMatchObject({ source: nextApi!.id, target: nextDb!.id, label: edge.label, waypoints: edge.waypoints, sourceAnchor: edge.sourceAnchor });
    expect(compact.document.edges[0]!.attachments![0]!.text).toBe('Use transactions.');
    expect(compact.document.flows[1]!.variantOf).toBe(compact.document.flows[0]!.id);
    expect(compact.document.flows[0]!.steps[0]).toMatchObject({ edgeId: compact.document.edges[0]!.id, extraEdgeIds: [compact.document.edges[0]!.id], extraNodeIds: [nextApi!.id], viewport: flow.steps[0]!.viewport });
    expect(compact.start).toEqual({ path: [nextApi!.id], flowId: nextApi!.inside!.flows[0]!.id });
    expect(compact.document.openPoints[0]!.targets).toEqual([{ kind: 'node', id: nextInner.id }, { kind: 'edge', id: compact.document.edges[0]!.id }]);
    expect(serializeDocument(file)).toBe(before);
  });

  it('makes a substantial reduction on a large diagram and still opens every shape and connection', async () => {
    const file = createDocument('System overview');
    file.nodes = Array.from({ length: 150 }, (_, i) => createNode({ type: i % 3 ? 'service' : 'database', x: i % 10 * 240, y: Math.floor(i / 10) * 160, text: `Component ${i}` }));
    file.edges = file.nodes.slice(1).map((node, i) => createEdge({ source: file.nodes[i]!.id, target: node.id }));
    const legacy = deflateSync(new TextEncoder().encode(serializeDocument(file)));
    const encoded = await encodeShareLink(file, 'https://example.test/');
    if (!('url' in encoded)) throw new Error('Expected a link');
    expect(new URL(encoded.url).hash.length).toBeLessThan(Math.ceil(legacy.length * 4 / 3) * 0.75);
    const decoded = await decodeShareLink(new URL(encoded.url).hash);
    if (!decoded?.ok) throw new Error('Expected a document');
    expect(decoded.document.nodes).toHaveLength(150);
    expect(decoded.document.edges).toHaveLength(149);
    expect(decoded.repairs).toEqual([]);
  });

  it('continues to open an older link containing the original ids', async () => {
    const file = createDocument('Legacy link');
    file.nodes = [createNode({ type: 'service', x: 40, y: 80, text: 'Original shape' })];
    const bytes = deflateSync(new TextEncoder().encode(serializeDocument(file)));
    const payload = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decoded = await decodeShareLink(`#d=1.${payload}`);
    if (!decoded?.ok) throw new Error('Expected a legacy document');
    expect(decoded.document.nodes).toEqual(file.nodes);
  });

  it('continues to unlock an older protected link with its original identities and starting metadata', async () => {
    const file = createDocument('Legacy protected link');
    file.nodes = [createNode({ type: 'database', x: 40, y: 80, text: 'Orders' })];
    const json = JSON.stringify({ document: JSON.parse(serializeDocument(file)), start: { path: [] } });
    const envelope = await encryptExportBytes(new Uint8Array(deflateSync(new TextEncoder().encode(json))), 'legacy separate passphrase');
    const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
    const ciphertext = decode(envelope.ciphertext);
    const packed = new Uint8Array(32 + ciphertext.length);
    new DataView(packed.buffer).setUint32(0, envelope.iterations);
    packed.set(decode(envelope.salt), 4);
    packed.set(decode(envelope.iv), 20);
    packed.set(ciphertext, 32);
    const payload = btoa(String.fromCharCode(...packed)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await decodeShareLink(`#d=2.${payload}`, 'legacy separate passphrase');
    if (!result?.ok) throw new Error('Expected a legacy protected diagram');
    expect(result.document.nodes).toEqual(file.nodes);
    expect(result.start).toEqual({ path: [] });
  });
});

describe('sharing worker lifecycle', () => {
  it('reports the actual worker stage and terminates work when cancelled', async () => {
    const threads: Array<{ onmessage: ((event: MessageEvent) => void) | null; terminate: ReturnType<typeof vi.fn> }> = [];
    class TestWorker {
      onmessage = null;
      onerror = null;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { threads.push(this); }
    }
    vi.stubGlobal('Worker', TestWorker);
    const controller = new AbortController();
    const progress = vi.fn();
    const job = compressShare('{}', true, { signal: controller.signal, onProgress: progress });
    const thread = threads[0]!;
    const rejected = expect(job).rejects.toMatchObject({ name: 'AbortError' });
    thread.onmessage!({ data: { stage: 'compressing' } } as MessageEvent);
    expect(progress).toHaveBeenCalledWith('compressing');
    controller.abort();
    await rejected;
    expect(thread.terminate).toHaveBeenCalledOnce();
  });

  it('falls back to native asynchronous compression when a worker cannot be created', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('Blocked worker'); } });
    const result = await compressShare(JSON.stringify({ document: createDocument('Fallback') }), false);
    expect(result.bytes.length).toBeGreaterThan(0);
  });
});
