import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes, setTitle } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { decodeShareLink, encodeShareLink, MAX_SHARE_PAYLOAD_BYTES, sharePayloadFromHash } from '../src/share/link';
import { copyShareLink, SHARE_LINK_COPIED } from '../src/share/copy';

/**
 * A share link is the whole diagram in a fragment: deflated, base64url-encoded, versioned, capped.
 * The decoder is an import path like any other — it has to refuse a damaged link, keep a huge one
 * out, and never let the sender's id into the reader's library.
 */

const BASE = 'https://example.test/editor/';

function diagram(): DraftDocument {
  const a = createNode({ type: 'service', x: 0, y: 0 });
  const b = createNode({ type: 'database', x: 300, y: 0 });
  const edge = createEdge({ source: a.id, target: b.id });
  return setTitle(addEdges(addNodes(createDocument('Checkout'), [a, b]), [edge]), 'Checkout');
}

describe('encodeShareLink', () => {
  it('round-trips a diagram through the fragment', async () => {
    const source = diagram();
    const link = await encodeShareLink(source, BASE);
    expect('url' in link).toBe(true);
    if (!('url' in link)) return;
    expect(link.url.startsWith(`${BASE}#d=1.`)).toBe(true);
    // base64url only: nothing a chat app or URL encoder would rewrite.
    expect(sharePayloadFromHash(new URL(link.url).hash)).toMatch(/^1\.[A-Za-z0-9_-]+$/);

    const result = await decodeShareLink(new URL(link.url).hash);
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.document.metadata.title).toBe('Checkout');
    expect(result.document.nodes.map((n) => n.type)).toEqual(['service', 'database']);
    expect(result.document.edges).toHaveLength(1);
    expect(result.document.edges[0]?.source).toBe(source.nodes[0]?.id);
    expect(result.repairs).toEqual([]);
  });

  it('gives the decoded document a fresh id, so it can never collide with the reader\'s own', async () => {
    const source = diagram();
    const link = await encodeShareLink(source, BASE);
    if (!('url' in link)) throw new Error('expected a link');
    const result = await decodeShareLink(new URL(link.url).hash);
    if (!result?.ok) throw new Error('expected a document');
    expect(result.document.metadata.id).not.toBe(source.metadata.id);
    expect(result.document.metadata.id).toMatch(/^d_/);
  });

  it('leaves the background image behind', async () => {
    const source = diagram();
    source.settings.background = {
      ...source.settings.background,
      enabled: true,
      image: { dataUri: `data:image/png;base64,${'A'.repeat(4000)}`, width: 10, height: 10 },
    };
    const link = await encodeShareLink(source, BASE);
    if (!('url' in link)) throw new Error('expected a link');
    const result = await decodeShareLink(new URL(link.url).hash);
    if (!result?.ok) throw new Error('expected a document');
    expect(result.document.settings.background.image).toBeUndefined();
    // And the source was not mutated to get there.
    expect(source.settings.background.image).toBeDefined();
  });

  it('refuses a diagram whose encoded payload would pass the cap, and says how big it was', async () => {
    let doc = createDocument('Big');
    // Random text defeats deflate, so a few hundred nodes of it are well past 32 KB.
    const nodes = Array.from({ length: 400 }, (_, i) =>
      createNode({
        type: 'note',
        x: i * 10, y: 0,
        text: Array.from({ length: 24 }, () => Math.random().toString(36).slice(2)).join(' '),
      }),
    );
    doc = addNodes(doc, nodes);
    const link = await encodeShareLink(doc, BASE);
    expect('tooLarge' in link).toBe(true);
    if (!('tooLarge' in link)) return;
    expect(link.bytes).toBeGreaterThan(MAX_SHARE_PAYLOAD_BYTES);
  });
});

describe('decodeShareLink', () => {
  it('returns null when the address carries no share payload', async () => {
    expect(await decodeShareLink('')).toBeNull();
    expect(await decodeShareLink('#doc=d_abc')).toBeNull();
  });

  it('refuses a tampered payload rather than opening garbage', async () => {
    const link = await encodeShareLink(diagram(), BASE);
    if (!('url' in link)) throw new Error('expected a link');
    const hash = new URL(link.url).hash;
    // Truncated: part of the link lost in a paste.
    const truncated = await decodeShareLink(hash.slice(0, hash.length - 12));
    expect(truncated?.ok).toBe(false);
    // Corrupted in the middle: deflate either throws or yields something that is not a document.
    const middle = Math.floor(hash.length / 2);
    const corrupted = await decodeShareLink(`${hash.slice(0, middle)}!!!!${hash.slice(middle + 4)}`);
    expect(corrupted?.ok).toBe(false);
    // Not base64 at all.
    const junk = await decodeShareLink('#d=1.%%%%');
    expect(junk?.ok).toBe(false);
  });

  it('refuses a payload from a format it does not know', async () => {
    const result = await decodeShareLink('#d=2.AAAA');
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error).toMatch(/newer version/);
  });

  it('refuses a payload past the cap without inflating it', async () => {
    const result = await decodeShareLink(`#d=1.${'A'.repeat(MAX_SHARE_PAYLOAD_BYTES + 1)}`);
    expect(result?.ok).toBe(false);
  });

  it('validates what it decoded as an import: a valid payload that is not a document is refused', async () => {
    // Deflate "{}" by hand through the encoder's own pipeline: build a link, then swap its bytes.
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const stream = new (globalThis as unknown as { CompressionStream: new (f: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    void writer.write(bytes).then(() => writer.close());
    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const binary = chunks.map((c) => String.fromCharCode(...c)).join('');
    const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await decodeShareLink(`#d=1.${payload}`);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error).toMatch(/not a Draft Canvas document/);
  });
});

describe('copyShareLink', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('puts the link on the clipboard and says who can read it', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const notify = vi.fn();
    await copyShareLink(diagram(), notify);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toMatch(/#d=1\./);
    expect(notify).toHaveBeenCalledWith(SHARE_LINK_COPIED);
  });

  it('falls back to a prompt holding the link when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied'); }) },
      configurable: true,
    });
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => null);
    const notify = vi.fn();
    await copyShareLink(diagram(), notify);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[1]).toMatch(/#d=1\./);
    expect(notify).not.toHaveBeenCalled();
    prompt.mockRestore();
  });
});
