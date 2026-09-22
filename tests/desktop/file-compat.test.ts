import { describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes } from '../../src/document/operations';
import { deserializeDocument, serializeDocument } from '../../src/export/project';
import { createHarness, decoder } from './harness';

/**
 * A `.draftcanvas` file is the one format all three hosts share: the browser's Export and Import, the
 * VS Code extension, and this. Whatever the desktop writes has to be readable by the others, and
 * whatever they write readable by it — and it has no business adding anything of its own.
 */
describe('a .draftcanvas file across hosts', () => {
  const doc = () => addNodes(createDocument('Payments'), [createNode({ type: 'service', x: 10, y: 20 }), createNode({ type: 'queue', x: 300, y: 20 })]);

  it('is written exactly as the web app’s own export would write it', async () => {
    const h = createHarness();
    const text = serializeDocument(doc());
    const handle = h.addFile('payments', documentBefore());
    await h.controller.openHandle(handle);
    await h.settle();

    h.edit(text);
    await h.controller.save();

    // Byte for byte: the desktop only ever hands the shell what the app serialized.
    expect(h.files.get(handle)!.text).toBe(text);
    expect(decoder.decode(h.api.saveDocument.mock.calls[0]![1])).toBe(text);
  });

  it('adds nothing to the document: the same top-level fields the web export has, and no others', async () => {
    const h = createHarness();
    const web = JSON.parse(serializeDocument(doc())) as Record<string, unknown>;
    const handle = h.addFile('payments', documentBefore());
    await h.controller.openHandle(handle);
    await h.settle();

    h.edit(serializeDocument(doc()));
    await h.controller.save();
    const written = JSON.parse(h.files.get(handle)!.text) as Record<string, unknown>;

    expect(Object.keys(written)).toEqual(Object.keys(web));
  });

  it('reads back through the shared parser into the diagram that was saved', async () => {
    const h = createHarness();
    const original = doc();
    const handle = h.addFile('payments', documentBefore());
    await h.controller.openHandle(handle);
    await h.settle();
    h.edit(serializeDocument(original));
    await h.controller.save();

    // What the browser's Import (and VS Code) would do with the file.
    const parsed = deserializeDocument(h.files.get(handle)!.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.repairs).toEqual([]);
    expect(parsed.document.nodes.map((node) => node.type)).toEqual(['service', 'queue']);
    expect(parsed.document.metadata.title).toBe('Payments');
  });

  it('opens a file made elsewhere without changing it: opening is not an edit', async () => {
    const h = createHarness();
    const fromBrowser = serializeDocument(doc());
    const handle = h.addFile('from-the-browser', fromBrowser);

    await h.controller.openHandle(handle);
    await h.settle();

    // The text the app is sent is the file's own, and saving what it echoes back is a no-op.
    expect(h.loads()[0]!.text).toBe(fromBrowser);
    await h.controller.save();
    expect(h.api.saveDocument).not.toHaveBeenCalled();
  });

  it('keeps a Quick Draft’s working copy in the same format, so recovering one is just opening a file', async () => {
    const h = createHarness();
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(serializeDocument(doc()));
    await h.controller.returnHome();
    await h.settle();

    const [held] = [...h.recovery.values()];
    const parsed = deserializeDocument(held!.text);
    expect(parsed.ok).toBe(true);
    expect(Object.keys(JSON.parse(held!.text))).toEqual(Object.keys(JSON.parse(serializeDocument(doc()))));
  });
});

/** Any valid file to start from: what is opened is not what these tests compare against. */
function documentBefore(): string {
  return serializeDocument(createDocument('Before'));
}
