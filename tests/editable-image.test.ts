import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { documentChunk, readDocumentFromPng, readDocumentFromSvg, withDocumentChunk, withDocumentMetadata } from '../src/export/editable';
import { serializeDocument } from '../src/export/project';
import { readEditableImage } from '../src/import/editableImage';
import { crc32 } from '../src/render/png/phys';
import { renderDocumentSvg } from '../src/render/svg/document';

/**
 * An editable image is a picture that is still the diagram: the `.draftcanvas` text rides inside
 * an SVG `<metadata>` element or a PNG `iTXt` chunk and comes back out byte-for-byte. A damaged
 * chunk is a plain picture, never a failed import.
 */
function fixture(): DraftDocument {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A ]]> & <b>"q"</b>' });
  const b = createNode({ type: 'database', x: 300, y: 0, text: 'B' });
  return { ...createDocument('Round "trip" <doc>'), nodes: [a, b], edges: [createEdge({ source: a.id, target: b.id, label: 'writes' })] };
}

/** The smallest PNG there is: signature, IHDR, one IDAT, IEND — enough for a chunk walk. */
function tinyPng(): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: number[]) => {
    const body = new Uint8Array(4 + data.length);
    body.set([...type].map((c) => c.charCodeAt(0)), 0);
    body.set(data, 4);
    const out = new Uint8Array(4 + body.length + 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(4 + body.length, crc32(body));
    return out;
  };
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    chunk('IDAT', [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
    chunk('IEND', []),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('SVG', () => {
  it('round-trips the document through <metadata>, leaving the picture as it was', () => {
    const document = fixture();
    const { svg } = renderDocumentSvg(document);
    const editable = withDocumentMetadata(svg, document);
    expect(editable).toContain('<metadata id="draftcanvas">');
    expect(editable.replace(/<metadata id="draftcanvas">[\s\S]*?<\/metadata>/, '')).toBe(svg);
    expect(new DOMParser().parseFromString(editable, 'image/svg+xml').querySelector('parsererror')).toBeNull();

    const result = readDocumentFromSvg(editable);
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(serializeDocument(result.document)).toBe(serializeDocument(document));
  });

  it('embeds once however often it is asked, and reads nothing from a plain SVG', () => {
    const document = fixture();
    const once = withDocumentMetadata(renderDocumentSvg(document).svg, document);
    expect(withDocumentMetadata(once, document)).toBe(once);
    expect(readDocumentFromSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBeNull();
    expect(readDocumentFromSvg('not even svg')).toBeNull();
  });
});

describe('PNG', () => {
  it('round-trips the document through an iTXt chunk after IHDR, keeping every other chunk', () => {
    const document = fixture();
    const png = tinyPng();
    const editable = withDocumentChunk(png, document);
    expect(editable.length).toBe(png.length + documentChunk(document).length);
    expect(String.fromCharCode(...editable.subarray(8 + 25 + 4, 8 + 25 + 8))).toBe('iTXt');
    expect(editable.subarray(editable.length - 12)).toEqual(png.subarray(png.length - 12)); // IEND intact

    const result = readDocumentFromPng(editable);
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(serializeDocument(result.document)).toBe(serializeDocument(document));
  });

  it('replaces an earlier chunk rather than stacking a second one', () => {
    const first = fixture();
    const second = { ...fixture(), metadata: { ...first.metadata, title: 'Second' } };
    const twice = withDocumentChunk(withDocumentChunk(tinyPng(), first), second);
    expect(twice.length).toBe(tinyPng().length + documentChunk(second).length);
    const result = readDocumentFromPng(twice);
    expect(result?.ok && result.document.metadata.title).toBe('Second');
  });

  it('ignores a chunk whose checksum does not match, and a file that is not a PNG', () => {
    const editable = withDocumentChunk(tinyPng(), fixture());
    const corrupt = new Uint8Array(editable);
    // Flip a byte inside the chunk's text: the CRC no longer matches.
    corrupt[8 + 25 + 8 + 20] = (corrupt[8 + 25 + 8 + 20] ?? 0) ^ 0xff;
    expect(readDocumentFromPng(corrupt)).toBeNull();
    expect(readDocumentFromPng(tinyPng())).toBeNull();
    expect(readDocumentFromPng(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(withDocumentChunk(new Uint8Array([1, 2, 3]), fixture())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a truncated file quietly', () => {
    const editable = withDocumentChunk(tinyPng(), fixture());
    expect(readDocumentFromPng(editable.subarray(0, 8 + 25 + 30))).toBeNull();
  });
});

describe('readEditableImage', () => {
  it('reads an editable SVG and PNG, and answers null for a plain picture or another kind of file', async () => {
    const document = fixture();
    const svg = withDocumentMetadata(renderDocumentSvg(document).svg, document);
    const fromSvg = await readEditableImage(new File([svg], 'diagram.svg', { type: 'image/svg+xml' }));
    expect(fromSvg?.ok).toBe(true);

    const png = withDocumentChunk(tinyPng(), document);
    const fromPng = await readEditableImage(new File([png], 'diagram.png', { type: 'image/png' }));
    expect(fromPng?.ok).toBe(true);

    expect(await readEditableImage(new File([tinyPng()], 'plain.png', { type: 'image/png' }))).toBeNull();
    expect(await readEditableImage(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'plain.svg'))).toBeNull();
    expect(await readEditableImage(new File(['{}'], 'diagram.draftcanvas'))).toBeNull();
  });
});
