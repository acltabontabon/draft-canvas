import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeDocument } from '../../src/export/project';
import { createDocument, createNode } from '../../src/document/factory';
import { createHarness, decoder, documentText, type Harness } from './harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The text of a document with one more shape in it: an edit as the app would post it. The same
 * title gives the same text, since a new document has a new id and two of them are never equal.
 */
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

const doc = () => h.store.getSnapshot().doc;

describe('opening a file', () => {
  it('sends its text to the app and shows it as clean', async () => {
    const handle = await openFile();

    expect(h.loads()).toHaveLength(1);
    const load = h.loads()[0]!;
    expect(load.text).toBe(h.files.get(handle)!.text);
    expect(load.title).toBe('payments');
    expect(load).toMatchObject({ background: true, seq: 1 });
    expect(doc()).toMatchObject({ kind: 'file', name: 'payments', dirty: false, displayPath: '~/work/payments.draftcanvas' });
    expect(h.api.reportState).toHaveBeenLastCalledWith({ kind: 'file', dirty: false, name: 'payments', handle });
  });

  it('is not dirtied by the app opening it, or by the app saying what it already holds', async () => {
    const handle = await openFile();
    h.edit(h.files.get(handle)!.text);
    expect(doc()).toMatchObject({ dirty: false });
  });

  it('turns dirty on an edit, and clean again when the edit is undone', async () => {
    const handle = await openFile();
    h.edit(edited());
    expect(doc()).toMatchObject({ dirty: true });
    h.edit(h.files.get(handle)!.text);
    expect(doc()).toMatchObject({ dirty: false });
  });

  it('drops an edit made to a file it has since replaced', async () => {
    await openFile('one');
    const second = h.addFile('two');
    await h.controller.openHandle(second);
    await h.settle();

    h.edit(edited('one'), 1);
    expect(doc()).toMatchObject({ name: 'two', dirty: false });
  });

  it('refuses a file that is not a diagram, telling the user why, and leaves what is open alone', async () => {
    await openFile();
    const broken = h.addFile('broken', '{ this is not a diagram');
    await h.controller.openHandle(broken);
    await h.settle();

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.title).toContain('broken.draftcanvas');
    expect(h.loads()).toHaveLength(1);
    expect(doc()).toMatchObject({ name: 'payments' });
  });

  it('says so when the shell refuses the file', async () => {
    await h.controller.openHandle('h_missing');
    expect(h.errors).toEqual([{ title: 'Couldn’t open the file', message: 'That file is no longer available.' }]);
  });

  it('opens the file the OS asked for', async () => {
    await h.controller.start();
    const handle = h.addFile('from-finder');
    h.hostEvent({ type: 'open', handle, name: 'from-finder', displayPath: '~/from-finder.draftcanvas' });
    await h.settle();
    expect(doc()).toMatchObject({ name: 'from-finder' });
  });
});

describe('saving', () => {
  it('writes exactly the text the app produced, with the stamp it opened with', async () => {
    const handle = await openFile();
    const text = edited();
    h.edit(text);

    await h.controller.save();

    const [savedHandle, bytes, stamp] = h.api.saveDocument.mock.calls[0]!;
    expect(savedHandle).toBe(handle);
    expect(decoder.decode(bytes)).toBe(text);
    expect(stamp).toBe('v1:1');
    expect(h.files.get(handle)!.text).toBe(text);
    expect(doc()).toMatchObject({ dirty: false });
  });

  it('asks the app to post what is pending before it saves', async () => {
    await openFile();
    h.edit(edited());
    await h.controller.save();
    expect(h.delivered).toContainEqual(expect.objectContaining({ type: 'draft-canvas:command', command: 'flush' }));
  });

  it('has nothing to do for a clean file', async () => {
    await openFile();
    await h.controller.save();
    expect(h.api.saveDocument).not.toHaveBeenCalled();
  });

  it('answers a second request while one is running with the same save, not a second one', async () => {
    await openFile();
    h.edit(edited());
    await Promise.all([h.controller.save(), h.controller.save()]);
    expect(h.api.saveDocument).toHaveBeenCalledTimes(1);
  });

  it('uses the new stamp for the next save', async () => {
    await openFile();
    h.edit(edited());
    await h.controller.save();
    h.edit(edited('Renamed'));
    await h.controller.save();
    expect(h.api.saveDocument.mock.calls[1]![2]).toBe('v1:2');
  });

  it('names the file when it cannot be written', async () => {
    const handle = await openFile('locked');
    h.files.get(handle)!.readOnly = true;
    h.edit(edited());
    await h.controller.save();
    expect(h.errors[0]).toEqual({
      title: 'Couldn’t save locked.draftcanvas',
      message: 'Draft Canvas couldn’t save locked.draftcanvas because the file is read-only.',
    });
    expect(doc()).toMatchObject({ dirty: true });
  });

  describe('when the file changed on disk', () => {
    async function conflicted() {
      const handle = await openFile();
      h.edit(edited());
      const file = h.files.get(handle)!;
      file.text = documentText('Changed elsewhere');
      file.version += 1;
      return handle;
    }

    it('asks before replacing it, and overwrites when told to', async () => {
      const handle = await conflicted();
      h.answer(0);
      await h.controller.save();

      expect(h.asked[0]!.buttons).toEqual(['Overwrite', 'Save As…', 'Cancel']);
      expect(h.api.saveDocument).toHaveBeenCalledTimes(2);
      expect(h.api.saveDocument.mock.calls[1]![2]).toBeUndefined();
      expect(decoder.decode(h.api.saveDocument.mock.calls[1]![1])).toBe(edited());
      expect(h.files.get(handle)!.text).toBe(edited());
      expect(doc()).toMatchObject({ dirty: false });
    });

    it('leaves the file alone and the edit unsaved when cancelled', async () => {
      const handle = await conflicted();
      const before = h.files.get(handle)!.text;
      h.answer(2);
      await h.controller.save();
      expect(h.files.get(handle)!.text).toBe(before);
      expect(doc()).toMatchObject({ dirty: true });
    });

    it('saves a copy elsewhere when told to', async () => {
      await conflicted();
      h.saveAsTo({ name: 'copy', displayPath: '~/work/copy.draftcanvas' });
      h.answer(1);
      await h.controller.save();
      expect(doc()).toMatchObject({ kind: 'file', name: 'copy', dirty: false });
    });
  });
});

describe('Save As', () => {
  it('rebinds the document to the new file', async () => {
    await openFile();
    h.edit(edited());
    h.saveAsTo({ name: 'renamed', displayPath: '~/work/renamed.draftcanvas' });

    await h.controller.saveAs();

    expect(doc()).toMatchObject({ kind: 'file', name: 'renamed', dirty: false });
    expect(decoder.decode(h.api.saveAs.mock.calls[0]![1])).toBe(edited());
  });

  it('changes nothing when the dialog is cancelled', async () => {
    await openFile();
    h.edit(edited());
    h.saveAsTo(null);
    await h.controller.saveAs();
    expect(doc()).toMatchObject({ name: 'payments', dirty: true });
  });

  it('suggests the diagram’s title as the file name', async () => {
    await openFile();
    h.edit(edited('Checkout Flow'));
    h.saveAsTo(null);
    await h.controller.saveAs();
    expect(h.api.saveAs.mock.calls[0]![0]).toBe('checkout-flow');
  });
});

describe('Quick Draft', () => {
  it('opens a blank diagram at once, with no file behind it', async () => {
    await h.controller.newQuickDraft();
    await h.settle();

    const load = h.loads()[0]!;
    expect(JSON.parse(load.text).metadata.title).toBe('Quick Draft');
    expect(doc()).toEqual({ kind: 'quick', dirty: false });
    expect(h.api.saveAs).not.toHaveBeenCalled();
    expect(h.api.recoveryWrite).not.toHaveBeenCalled();
  });

  it('keeps a recoverable copy once it has been drawn on, never before', async () => {
    vi.useFakeTimers();
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));
    expect(h.api.recoveryWrite).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);

    expect(h.api.recoveryWrite).toHaveBeenCalledTimes(1);
    const [id, origin, title, bytes] = h.api.recoveryWrite.mock.calls[0]!;
    expect(id).toMatch(/^q_[0-9a-f-]{36}$/);
    expect(origin).toEqual({ kind: 'quick' });
    expect(title).toBe('Quick Draft');
    expect(decoder.decode(bytes)).toBe(edited('Quick Draft'));
  });

  it('snapshots during a steady stream of edits instead of waiting for a pause', async () => {
    vi.useFakeTimers();
    await h.controller.newQuickDraft();
    await h.settle();
    for (let i = 0; i < 12; i += 1) {
      h.edit(edited(`Draft ${i}`));
      await vi.advanceTimersByTimeAsync(800);
    }
    expect(h.api.recoveryWrite.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('becomes a file on its first Save, and forgets its recovery copy', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));
    h.saveAsTo({ name: 'meeting', displayPath: '~/work/meeting.draftcanvas' });

    await h.controller.save();

    expect(doc()).toMatchObject({ kind: 'file', name: 'meeting', dirty: false });
    expect(h.recovery.size).toBe(0);
  });

  it('stays a draft if the Save dialog is cancelled', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));
    h.saveAsTo(null);
    await h.controller.save();
    expect(doc()).toEqual({ kind: 'quick', dirty: true });
  });

  it('is kept on Home, without a question, when the user goes back', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));

    await h.controller.returnHome();
    await h.settle();

    expect(h.asked).toEqual([]);
    expect(doc()).toEqual({ kind: 'none' });
    expect(h.recovery.size).toBe(1);
    expect(h.store.getSnapshot().recovery).toHaveLength(1);
  });

  it('leaves nothing behind when it was never drawn on', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    await h.controller.returnHome();
    await h.settle();
    expect(h.recovery.size).toBe(0);
  });

  it('can be recovered from Home, and carries on being kept', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));
    await h.controller.returnHome();
    await h.settle();
    const [entry] = h.store.getSnapshot().recovery;

    await h.controller.recover(entry!.id);
    await h.settle();

    expect(doc()).toEqual({ kind: 'quick', dirty: true });
    expect(h.loads().at(-1)!.text).toBe(edited('Quick Draft'));
  });

  it('can be discarded from Home, after asking', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));
    await h.controller.returnHome();
    await h.settle();
    const [entry] = h.store.getSnapshot().recovery;

    h.answer(1);
    await h.controller.discardRecovery(entry!.id);
    expect(h.recovery.size).toBe(1);

    h.answer(0);
    await h.controller.discardRecovery(entry!.id);
    expect(h.recovery.size).toBe(0);
    expect(h.store.getSnapshot().recovery).toEqual([]);
  });
});

describe('leaving a file with unsaved changes', () => {
  async function dirtyFile() {
    const handle = await openFile();
    h.edit(edited());
    return handle;
  }

  it('asks, and stays put when the user cancels', async () => {
    await dirtyFile();
    h.answer(2);
    await h.controller.newQuickDraft();
    expect(h.asked[0]!.buttons).toEqual(['Save', 'Don’t Save', 'Cancel']);
    expect(doc()).toMatchObject({ name: 'payments', dirty: true });
    expect(h.loads()).toHaveLength(1);
  });

  it('saves first when told to', async () => {
    const handle = await dirtyFile();
    h.answer(0);
    await h.controller.newQuickDraft();
    expect(h.files.get(handle)!.text).toBe(edited());
    expect(doc()).toEqual({ kind: 'quick', dirty: false });
  });

  it('does not leave when the save it was asked for did not happen', async () => {
    const handle = await dirtyFile();
    h.files.get(handle)!.readOnly = true;
    h.answer(0);
    await h.controller.newQuickDraft();
    expect(doc()).toMatchObject({ name: 'payments', dirty: true });
  });

  it('drops the changes, and their recovery copy, when told not to save', async () => {
    vi.useFakeTimers();
    await dirtyFile();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.recovery.size).toBe(1);

    h.answer(1);
    await h.controller.newQuickDraft();
    expect(doc()).toEqual({ kind: 'quick', dirty: false });
    expect(h.recovery.size).toBe(0);
  });

  it('only ever asks once for one switch', async () => {
    await dirtyFile();
    h.answer(1);
    await Promise.all([h.controller.newQuickDraft(), h.controller.newQuickDraft()]);
    expect(h.asked).toHaveLength(1);
  });
});

describe('a file’s recovery copy', () => {
  it('is written for unsaved changes, and never touches the file itself', async () => {
    vi.useFakeTimers();
    const handle = await openFile();
    const before = h.files.get(handle)!.text;
    h.edit(edited());

    await vi.advanceTimersByTimeAsync(1500);

    const [id, origin] = h.api.recoveryWrite.mock.calls[0]!;
    expect(id).toMatch(/^f_/);
    expect(origin).toEqual({ kind: 'file', handle, baseStamp: 'v1:1' });
    expect(h.files.get(handle)!.text).toBe(before);
    expect(h.api.saveDocument).not.toHaveBeenCalled();
  });

  it('is removed once the file is saved', async () => {
    vi.useFakeTimers();
    await openFile();
    h.edit(edited());
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.recovery.size).toBe(1);

    await h.controller.save();
    expect(h.recovery.size).toBe(0);
  });

  it('is offered back when the file is opened again, and comes back as unsaved changes', async () => {
    // What a crash leaves behind: a snapshot in the data folder, and no session that knows of it.
    const crashed = createHarness();
    const again = crashed.addFile('payments');
    crashed.recovery.set('f_11111111-1111-4111-8111-111111111111', {
      text: edited(),
      entry: {
        id: 'f_11111111-1111-4111-8111-111111111111',
        title: 'payments',
        updatedAt: Date.now(),
        bytes: 10,
        origin: { kind: 'file', name: 'payments', displayPath: crashed.files.get(again)!.displayPath, handle: again },
      },
    });
    crashed.answer(0);

    await crashed.controller.openHandle(again);
    await crashed.settle();

    expect(crashed.asked[0]!.buttons).toEqual(['Recover', 'Discard', 'Cancel']);
    expect(crashed.loads()[0]!.text).toBe(edited());
    expect(crashed.store.getSnapshot().doc).toMatchObject({ name: 'payments', dirty: true });
  });

  it('is discarded, and the saved file opened, when the user chooses that', async () => {
    const crashed = createHarness();
    const handle = crashed.addFile('payments');
    crashed.recovery.set('f_22222222-2222-4222-8222-222222222222', {
      text: edited(),
      entry: {
        id: 'f_22222222-2222-4222-8222-222222222222',
        title: 'payments',
        updatedAt: Date.now(),
        bytes: 10,
        origin: { kind: 'file', name: 'payments', displayPath: crashed.files.get(handle)!.displayPath, handle },
      },
    });
    crashed.answer(1);

    await crashed.controller.openHandle(handle);
    await crashed.settle();

    expect(crashed.recovery.size).toBe(0);
    expect(crashed.loads()[0]!.text).toBe(crashed.files.get(handle)!.text);
    expect(crashed.store.getSnapshot().doc).toMatchObject({ dirty: false });
  });

  it('does not open the file at all when the user cancels', async () => {
    const crashed = createHarness();
    const handle = crashed.addFile('payments');
    crashed.recovery.set('f_33333333-3333-4333-8333-333333333333', {
      text: edited(),
      entry: {
        id: 'f_33333333-3333-4333-8333-333333333333',
        title: 'payments',
        updatedAt: Date.now(),
        bytes: 10,
        origin: { kind: 'file', name: 'payments', displayPath: crashed.files.get(handle)!.displayPath, handle },
      },
    });
    crashed.answer(2);

    await crashed.controller.openHandle(handle);

    expect(crashed.loads()).toEqual([]);
    expect(crashed.recovery.size).toBe(1);
  });
});

describe('going back to Home', () => {
  it('asks about unsaved changes before it closes the document', async () => {
    await openFile();
    h.edit(edited());
    h.answer(2);
    await h.controller.returnHome();
    expect(h.delivered).not.toContainEqual(expect.objectContaining({ command: 'close' }));
    expect(doc()).toMatchObject({ kind: 'file' });
  });

  it('closes a clean file at once, and Home refreshes what it lists', async () => {
    await openFile();
    h.api.recentsList.mockClear();
    await h.controller.returnHome();
    await h.settle();
    expect(doc()).toEqual({ kind: 'none' });
    expect(h.api.reportState).toHaveBeenLastCalledWith({ kind: 'none', dirty: false });
    expect(h.api.recentsList).toHaveBeenCalled();
  });

  it('still hears about it when the app closes the document on its own', async () => {
    await openFile();
    h.link.onMessage({ type: 'draft-canvas:closed' });
    expect(doc()).toEqual({ kind: 'none' });
  });
});

describe('quitting', () => {
  it('goes ahead when nothing is open or unsaved', async () => {
    await h.controller.start();
    h.hostEvent({ type: 'quit-requested' });
    await h.settle();
    expect(h.api.quitAck).toHaveBeenCalledWith('ready');
  });

  it('never asks about a Quick Draft, and keeps it', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.edit(edited('Quick Draft'));
    await h.controller.start();

    h.hostEvent({ type: 'quit-requested' });
    await h.settle();

    expect(h.asked).toEqual([]);
    expect(h.recovery.size).toBe(1);
    expect(h.api.quitAck).toHaveBeenCalledWith('ready');
  });

  it('asks about a file with unsaved changes, after keeping a copy of them', async () => {
    await openFile();
    h.edit(edited());
    await h.controller.start();
    h.answer(2);

    h.hostEvent({ type: 'quit-requested' });
    await h.settle();

    expect(h.recovery.size).toBe(1);
    expect(h.api.quitAck.mock.calls.map(([decision]) => decision)).toEqual(['prompting', 'cancel']);
  });

  it('saves and then quits when told to save', async () => {
    const handle = await openFile();
    h.edit(edited());
    await h.controller.start();
    h.answer(0);

    h.hostEvent({ type: 'quit-requested' });
    await h.settle();

    expect(h.files.get(handle)!.text).toBe(edited());
    expect(h.api.quitAck.mock.calls.map(([decision]) => decision)).toEqual(['prompting', 'ready']);
  });

  it('quits, dropping the changes and their copy, when told not to save', async () => {
    await openFile();
    h.edit(edited());
    await h.controller.start();
    h.answer(1);

    h.hostEvent({ type: 'quit-requested' });
    await h.settle();

    expect(h.recovery.size).toBe(0);
    expect(h.api.quitAck.mock.calls.map(([decision]) => decision)).toEqual(['prompting', 'ready']);
  });
});

describe('coming back to the window', () => {
  it('reloads a clean file that changed on disk, and says so', async () => {
    const handle = await openFile();
    const file = h.files.get(handle)!;
    file.text = documentText('Edited in another app');
    file.version += 1;
    await h.controller.start();

    h.hostEvent({ type: 'window-focused' });
    await h.settle();

    expect(h.loads().at(-1)!.text).toBe(file.text);
    expect(h.notices[0]).toContain('was changed outside Draft Canvas');
  });

  it('leaves unsaved work on screen and flags the file instead', async () => {
    const handle = await openFile();
    h.edit(edited());
    const file = h.files.get(handle)!;
    file.version += 1;
    await h.controller.start();

    h.hostEvent({ type: 'window-focused' });
    await h.settle();

    expect(h.loads()).toHaveLength(1);
    expect(doc()).toMatchObject({ dirty: true, outside: 'changed' });
  });

  it('says once when the file has gone', async () => {
    const handle = await openFile();
    h.files.delete(handle);
    await h.controller.start();

    h.hostEvent({ type: 'window-focused' });
    await h.settle();
    h.hostEvent({ type: 'window-focused' });
    await h.settle();

    expect(doc()).toMatchObject({ outside: 'missing' });
    expect(h.notices.filter((notice) => notice.includes('moved or deleted'))).toHaveLength(1);
  });

  it('asks nothing of the disk while Home is showing a folder', async () => {
    await h.controller.start();
    h.hostEvent({ type: 'window-focused' });
    await h.settle();
    expect(h.api.checkStamp).not.toHaveBeenCalled();
  });
});

describe('the canvas’s background image', () => {
  it('is kept beside the file, and only once the file is saved', async () => {
    const handle = await openFile();
    h.link.onMessage({ type: 'draft-canvas:background-write', mime: 'image/png', data: 'AAAA' });
    h.edit(edited());
    expect(h.api.sidecarWrite).not.toHaveBeenCalled();

    await h.controller.save();

    expect(h.api.sidecarWrite).toHaveBeenCalledWith(handle, 'image/png', 'AAAA');
  });

  it('is removed from beside the file when the canvas drops it', async () => {
    const handle = await openFile();
    h.link.onMessage({ type: 'draft-canvas:background-remove' });
    h.edit(edited());
    await h.controller.save();
    expect(h.api.sidecarRemove).toHaveBeenCalledWith(handle);
  });

  it('is handed to the app when the file has one', async () => {
    const handle = await openFile();
    h.sidecars.set(handle, { mime: 'image/webp', base64: 'BBBB' });
    h.link.onMessage({ type: 'draft-canvas:background-read', id: 7 });
    await h.settle();
    expect(h.delivered).toContainEqual({ type: 'draft-canvas:background', id: 7, mime: 'image/webp', data: 'BBBB' });
  });

  it('is answered with nothing for a draft that has no file', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.link.onMessage({ type: 'draft-canvas:background-read', id: 3 });
    await h.settle();
    expect(h.delivered).toContainEqual({ type: 'draft-canvas:background', id: 3 });
  });

  it('goes to the new file when a draft is saved for the first time', async () => {
    await h.controller.newQuickDraft();
    await h.settle();
    h.link.onMessage({ type: 'draft-canvas:background-write', mime: 'image/jpeg', data: 'CCCC' });
    h.edit(edited('Quick Draft'));
    h.saveAsTo({ name: 'pic', displayPath: '~/pic.draftcanvas' });

    await h.controller.save();

    expect(h.api.sidecarWrite).toHaveBeenCalledWith(expect.any(String), 'image/jpeg', 'CCCC');
  });
});

describe('from the app', () => {
  it('turns ⌘S into a save, and ⌘⇧S into Save As', async () => {
    await openFile();
    h.edit(edited());
    h.saveAsTo(null);

    h.link.onMessage({ type: 'draft-canvas:save', saveAs: false });
    await h.settle();
    expect(h.api.saveDocument).toHaveBeenCalledTimes(1);

    h.edit(edited('Again'));
    h.link.onMessage({ type: 'draft-canvas:save', saveAs: true });
    await h.settle();
    expect(h.api.saveAs).toHaveBeenCalledTimes(1);
  });

  it('opens a link in the browser', async () => {
    h.link.onMessage({ type: 'draft-canvas:open-external', url: 'https://example.com' });
    expect(h.api.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('runs the native Edit menu through the app', async () => {
    await h.controller.start();
    h.hostEvent({ type: 'menu', command: 'undo' });
    h.hostEvent({ type: 'menu', command: 'select-all' });
    await h.settle();
    expect(h.ui.editCommand).toHaveBeenNthCalledWith(1, 'undo');
    expect(h.ui.editCommand).toHaveBeenNthCalledWith(2, 'select-all');
  });
});

describe('start-up', () => {
  it('shows recents and what was left unsaved, and opens nothing on its own', async () => {
    h.api.recentsList.mockResolvedValueOnce([{ handle: 'h_9', kind: 'file', name: 'old', displayPath: '~/old.draftcanvas', lastOpenedMs: 1 }]);
    await h.controller.start();
    expect(h.store.getSnapshot()).toMatchObject({ ready: true, platform: 'macos', recents: [expect.objectContaining({ name: 'old' })] });
    expect(h.loads()).toEqual([]);
  });
});
