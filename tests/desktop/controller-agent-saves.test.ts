import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeDocument } from '../../src/export/project';
import { createDocument, createNode } from '../../src/document/factory';
import type { AgentHost } from '../../src/desktop/agent';
import type { SaveResult } from '../../src/desktop/api';
import { createHarness, type Harness } from './harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

const editedTexts = new Map<string, string>();
function edited(title = 'Payments'): string {
  let text = editedTexts.get(title);
  if (!text) {
    const doc = createDocument(title);
    doc.nodes.push(createNode({ type: 'service', x: 0, y: 0 }));
    text = serializeDocument(doc);
    editedTexts.set(title, text);
  }
  return text;
}

async function openFile(name = 'payments') {
  const handle = h.addFile(name);
  await h.controller.openHandle(handle);
  await h.settle();
  return handle;
}

/** What the agent module is handed: the controller's side of an agent's request. */
const host = () => (h.controller as unknown as { agentHost: AgentHost }).agentHost;
const doc = () => h.store.getSnapshot().doc as { dirty?: boolean; outside?: string; name?: string };

/** Holds the next `saveDocument` until released, then does what the shell would have. */
function holdNextSave() {
  const real = h.api.saveDocument.getMockImplementation()!;
  let release!: () => void;
  h.api.saveDocument.mockImplementationOnce(
    (...args) => new Promise<SaveResult>((resolve) => (release = () => resolve(real(...args)))),
  );
  return () => release();
}

describe('a file whose timestamp moved under unsaved edits', () => {
  it('adopts the new stamp when the bytes are the same, so agents and ⌘S are not told it changed', async () => {
    const handle = await openFile();
    h.edit(edited());
    h.files.get(handle)!.version += 1;

    expect(await host().syncWithDisk()).toBe('unchanged');
    expect(doc()).toMatchObject({ dirty: true });
    expect(doc().outside).toBeUndefined();
    expect(h.loads()).toHaveLength(1);

    await h.controller.save();
    expect(h.asked).toHaveLength(0);
    expect(h.api.saveDocument.mock.calls[0]![2]).toBe('v1:2');
  });

  it('still flags a real change on disk', async () => {
    const handle = await openFile();
    h.edit(edited());
    const file = h.files.get(handle)!;
    file.text = edited('Changed elsewhere');
    file.version += 1;

    expect(await host().syncWithDisk()).toBe('changed');
    expect(doc()).toMatchObject({ dirty: true, outside: 'changed' });
  });

  it('stops saying the file is gone once it is back where it was', async () => {
    const handle = await openFile();
    h.edit(edited());
    const file = h.files.get(handle)!;
    h.files.delete(handle);
    expect(await host().syncWithDisk()).toBe('missing');
    expect(doc()).toMatchObject({ outside: 'missing' });

    h.files.set(handle, file);
    expect(await host().syncWithDisk()).toBe('unchanged');
    expect(doc().outside).toBeUndefined();
  });
});

describe('an agent’s quiet save', () => {
  it('refuses when a Save As it waited behind moved the document to another file', async () => {
    const handle = await openFile();
    h.edit(edited());
    let complete!: (saved: { handle: string; name: string; displayPath: string; stamp: string }) => void;
    h.api.saveAs.mockImplementationOnce(async () => new Promise((resolve) => (complete = resolve)));
    const savingAs = h.controller.saveAs();
    await vi.waitFor(() => expect(h.api.saveAs).toHaveBeenCalled());

    const quiet = host().saveQuietly(handle);
    complete({ handle: 'h_copy', name: 'copy', displayPath: '~/copy.draftcanvas', stamp: 'v1:1' });
    await savingAs;

    expect(await quiet).toMatchObject({ saved: false });
    expect(h.api.saveDocument).not.toHaveBeenCalled();
    expect(doc()).toMatchObject({ name: 'copy' });
  });

  it('is not opened behind an open Save As dialog, so the controller’s turn is not held', async () => {
    await openFile();
    const other = h.addFile('other');
    h.api.saveAs.mockImplementationOnce(async () => new Promise(() => {}));
    void h.controller.saveAs();
    await vi.waitFor(() => expect(h.api.saveAs).toHaveBeenCalled());

    expect(await host().openQuietly(other)).toEqual({ opened: false, reason: 'A save is in progress.' });
    expect(doc()).toMatchObject({ name: 'payments' });
  });

  it('stays the save in flight when the save it chained on ends, so a second ⌘S does not write alongside it', async () => {
    const handle = await openFile();
    h.edit(edited('First'));
    const releaseFirst = holdNextSave();
    const first = h.controller.save();
    await vi.waitFor(() => expect(h.api.saveDocument).toHaveBeenCalledTimes(1));

    h.edit(edited('Second'));
    const quiet = host().saveQuietly(handle);
    const releaseQuiet = holdNextSave();
    releaseFirst();
    await first;
    await vi.waitFor(() => expect(h.api.saveDocument).toHaveBeenCalledTimes(2));

    void h.controller.save();
    await h.settle();
    expect(h.api.saveDocument).toHaveBeenCalledTimes(2);

    releaseQuiet();
    expect(await quiet).toEqual({ saved: true });
    expect(doc()).toMatchObject({ dirty: false });
  });
});

describe('renaming a file with unsaved changes', () => {
  it('rewrites its recovery copy under the new handle and path', async () => {
    await openFile('plan');
    h.edit(edited('Plan'));
    const renamed = await h.controller.renameOpenFile('roadmap');
    await vi.waitFor(() => expect(h.recovery.size).toBe(1));
    const [entry] = [...h.recovery.values()];
    expect(entry!.entry.origin).toMatchObject({ kind: 'file', handle: renamed.handle, displayPath: '~/work/roadmap.draftcanvas' });
  });
});
