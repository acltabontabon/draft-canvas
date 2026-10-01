import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneDocumentAsNew, createDocument, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { addNodes, setSettings } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { adoptEmbeddedBackground, backgroundTravels, withEmbeddedBackground } from '../src/export/background';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { __setRepository } from '../src/storage';
import { MemoryRepository } from '../src/storage/MemoryRepository';

let repository: MemoryRepository;

beforeEach(() => {
  repository = new MemoryRepository();
  __setRepository(repository);
});

afterEach(() => {
  __setRepository(null);
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function withBackground(bytes: BlobPart = PNG_BYTES, imageId = 'bg_1'): Promise<DraftDocument> {
  const document = setSettings(addNodes(createDocument('Backdrop'), [createNode({ type: 'service', x: 0, y: 0 })]), {
    background: { enabled: true, fit: 'contain', dim: 0.3, blur: 0.1, imageId },
  });
  await repository.save(document);
  await repository.saveBackgroundImage(document.metadata.id, new Blob([bytes], { type: 'image/png' }), { width: 640, height: 480 }, imageId);
  return document;
}

describe('a background image in a .draftcanvas file', () => {
  it('says whether one travels: none without a background, embedded when small, too large otherwise', async () => {
    expect(await backgroundTravels(createDocument('Plain'))).toBe('none');
    expect(await backgroundTravels(await withBackground())).toBe('embedded');
    expect(await backgroundTravels(await withBackground(new Uint8Array(LIMITS.maxEmbeddedBackgroundBytes + 1)))).toBe('too-large');
    // Turned on but nothing stored (the canvas already shows none): nothing to carry.
    const orphan = setSettings(createDocument('Orphan'), { background: { enabled: true, fit: 'cover', dim: 0, blur: 0 } });
    expect(await backgroundTravels(orphan)).toBe('none');
  });

  it('is embedded on export, as a data URI with its natural size, and the store copy is untouched', async () => {
    const document = await withBackground();
    const file = await withEmbeddedBackground(document);

    expect(file.settings.background.image).toMatchObject({ width: 640, height: 480 });
    expect(file.settings.background.image!.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(document.settings.background.image).toBeUndefined();
    expect(file.settings.background.imageId).toBe('bg_1');
  });

  it('stays home when too large, leaving the file exactly as it would be without one', async () => {
    const document = await withBackground(new Uint8Array(LIMITS.maxEmbeddedBackgroundBytes + 1));
    expect(await withEmbeddedBackground(document)).toBe(document);
  });

  it('survives the file: written, read back and validated, the image is still there', async () => {
    const file = await withEmbeddedBackground(await withBackground());
    const text = serializeDocument(file);
    const result = deserializeDocument(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    expect(result.document.settings.background.image).toEqual(file.settings.background.image);
    expect(serializeDocument(result.document)).toBe(text);
  });

  it('is stored once on import: the bytes go to the image store, the document loses the field', async () => {
    const file = await withEmbeddedBackground(await withBackground());
    const text = serializeDocument(file);

    // Another machine: a fresh store, and the file arrives as a new canvas.
    const other = new MemoryRepository();
    const parsed = deserializeDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const imported = cloneDocumentAsNew(parsed.document, parsed.document.metadata.title);
    const stored = await adoptEmbeddedBackground(imported, other);
    await other.save(stored);

    expect(stored.settings.background.image).toBeUndefined();
    expect(stored.settings.background).toMatchObject({ enabled: true, fit: 'contain', dim: 0.3, blur: 0.1, imageId: 'bg_1' });
    expect((await other.load(stored.metadata.id))!.settings.background.image).toBeUndefined();
    const image = await other.loadBackgroundImage(stored.metadata.id, 'bg_1');
    expect(image).toMatchObject({ width: 640, height: 480 });
    expect(image!.blob.type).toBe('image/png');
    expect(new Uint8Array(await image!.blob.arrayBuffer())).toEqual(PNG_BYTES);
    // Only the new canvas got the image: the id the file was exported under has none here.
    expect(await other.loadBackgroundImage(file.metadata.id, 'bg_1')).toBeNull();
  });

  it('is left out on import when nothing travelled, without touching the store', async () => {
    const document = createDocument('Plain');
    expect(await adoptEmbeddedBackground(document, repository)).toBe(document);
    expect(await repository.loadBackgroundImage(document.metadata.id)).toBeNull();
  });

  it('is dropped by validation unless it is a well-formed, small enough image data URI with a size', () => {
    const write = (image: unknown) => {
      const raw = JSON.parse(serializeDocument(createDocument('Raw'))) as { settings: { background: Record<string, unknown> } };
      raw.settings.background.image = image;
      const result = deserializeDocument(JSON.stringify(raw));
      return result.ok ? result.document.settings.background.image : result;
    };
    expect(write({ dataUri: 'data:image/png;base64,AAAA', width: 2, height: 2 })).toEqual({ dataUri: 'data:image/png;base64,AAAA', width: 2, height: 2 });
    expect(write({ dataUri: 'data:text/html;base64,AAAA', width: 2, height: 2 })).toBeUndefined();
    expect(write({ dataUri: 'https://example.com/a.png', width: 2, height: 2 })).toBeUndefined();
    // A present-but-out-of-range size is repaired, not dropped — the same rule as every other number here.
    expect(write({ dataUri: 'data:image/png;base64,AAAA', width: 0, height: 2 })).toMatchObject({ width: 1, height: 2 });
    expect(write({ dataUri: 'data:image/png;base64,AAAA', width: 'wide', height: 2 })).toBeUndefined();
    expect(write({ dataUri: 'data:image/png;base64,AAAA' })).toBeUndefined();
    expect(write('data:image/png;base64,AAAA')).toBeUndefined();
    const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((LIMITS.maxEmbeddedBackgroundBytes + 3) / 3) * 4)}`;
    expect(write({ dataUri: oversized, width: 2, height: 2 })).toBeUndefined();
  });
});
