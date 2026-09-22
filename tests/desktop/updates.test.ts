import { beforeEach, describe, expect, it } from 'vitest';
import type { UpdateInfo, UpdatePhase, UpdateSnapshot } from '../../src/desktop/api';
import { canCheck, describeUpdate, inlineParts, parseNotes, updateStatusLine } from '../../src/desktop/updates';
import { createDocument, createNode } from '../../src/document/factory';
import { serializeDocument } from '../../src/export/project';
import { createHarness, type Harness } from './harness';

const info: UpdateInfo = { version: '1.10.0', notes: '### Added\n- **Updates**: the app keeps itself current.' };

function snapshot(state: UpdatePhase, extra: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return { currentVersion: '1.9.4', state, dismissed: false, held: null, error: null, ...extra };
}

describe('what the page says about an update', () => {
  it('stays quiet until there is something to take', () => {
    for (const state of [{ phase: 'idle' }, { phase: 'checking' }, { phase: 'up-to-date', checkedMs: 1 }, { phase: 'unavailable', reason: 'no key' }] as UpdatePhase[]) {
      expect(describeUpdate(snapshot(state)).chip).toBeNull();
    }
    expect(describeUpdate(null).chip).toBeNull();
  });

  it('offers a found update, and only asks to download it', () => {
    const view = describeUpdate(snapshot({ phase: 'available', info }));
    expect(view.chip).toBe('Update available · 1.10.0');
    expect(view.actions).toEqual(['download', 'later']);
    expect(view.notes).toBe(info.notes);
  });

  it('keeps a dismissed update out of the way, but not its failures', () => {
    expect(describeUpdate(snapshot({ phase: 'available', info }, { dismissed: true })).chip).toBeNull();
    const failed = describeUpdate(
      snapshot({ phase: 'available', info }, { dismissed: true, error: { stage: 'download', message: 'The download stopped partway.', manual: true } }),
    );
    expect(failed.chip).not.toBeNull();
    expect(failed.problem).toBe('The download stopped partway.');
  });

  it('shows a download’s progress, and never a percentage it doesn’t know', () => {
    const known = describeUpdate(snapshot({ phase: 'downloading', info, received: 25, total: 100 }));
    expect(known.chip).toBe('Downloading · 25%');
    expect(known.progress).toBe(0.25);
    const unknown = describeUpdate(snapshot({ phase: 'downloading', info, received: 25, total: null }));
    expect(unknown.chip).toBe('Downloading update…');
    expect(unknown.progress).toBeNull();
  });

  it('asks before restarting, and says what happens to unsaved work', () => {
    const view = describeUpdate(snapshot({ phase: 'ready', info }));
    expect(view.chip).toBe('Restart to update');
    expect(view.actions).toEqual(['install', 'later']);
    expect(view.detail).toMatch(/Anything unsaved is kept first/);
  });

  it('says so when the person chose to keep working instead', () => {
    const view = describeUpdate(snapshot({ phase: 'ready', info }, { held: 'You kept working.', dismissed: true }));
    expect(view.chip).toBe('Restart to update');
    expect(view.detail).toBe('You kept working.');
  });

  it('never interrupts anyone with a background check that failed', () => {
    const quiet = snapshot({ phase: 'idle' }, { error: { stage: 'check', message: 'Offline.', manual: false } });
    expect(describeUpdate(quiet).chip).toBeNull();
    expect(describeUpdate(quiet).problem).toBeNull();
    // …except in Settings, where someone went to look.
    expect(updateStatusLine(quiet)).toBe('Offline.');
    const asked = snapshot({ phase: 'idle' }, { error: { stage: 'check', message: 'Offline.', manual: true } });
    expect(updateStatusLine(asked)).toBe('Offline.');
  });

  it('has one line for Settings in every state', () => {
    const now = 10 * 60_000;
    expect(updateStatusLine(snapshot({ phase: 'up-to-date', checkedMs: now - 3 * 60_000 }), now)).toBe('Up to date. Checked 3 min ago.');
    expect(updateStatusLine(snapshot({ phase: 'unavailable', reason: 'This build has no update signing key.' }))).toBe(
      'This build has no update signing key.',
    );
    expect(updateStatusLine(snapshot({ phase: 'ready', info }))).toBe('Version 1.10.0 is downloaded and ready.');
  });

  it('lets a person look only when looking can do something', () => {
    expect(canCheck(snapshot({ phase: 'up-to-date', checkedMs: 1 }))).toBe(true);
    expect(canCheck(snapshot({ phase: 'checking' }))).toBe(false);
    expect(canCheck(snapshot({ phase: 'ready', info }))).toBe(false);
    expect(canCheck(snapshot({ phase: 'unavailable', reason: 'x' }))).toBe(false);
  });
});

describe('release notes', () => {
  it('reads the changelog’s headings and bullets, joining wrapped lines', () => {
    expect(parseNotes('### Added\n\n- One thing\n  that wraps.\n- Two\n\nPlain words.')).toEqual([
      { kind: 'heading', text: 'Added' },
      { kind: 'item', text: 'One thing that wraps.' },
      { kind: 'item', text: 'Two' },
      { kind: 'text', text: 'Plain words.' },
    ]);
    expect(parseNotes(null)).toEqual([]);
    expect(parseNotes('The first alpha,\nwrapped over lines.\n\nA second paragraph.')).toEqual([
      { kind: 'text', text: 'The first alpha, wrapped over lines.' },
      { kind: 'text', text: 'A second paragraph.' },
    ]);
  });

  it('keeps bold and code, and treats everything else as text', () => {
    expect(inlineParts('A **bold** `code` <b>tag</b>')).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'strong', text: 'bold' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' <b>tag</b>' },
    ]);
  });
});

describe('the controller and the updater', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('knows where an update stands from the start, and follows every change', async () => {
    h.setUpdate(snapshot({ phase: 'up-to-date', checkedMs: 5 }));
    await h.controller.start();
    expect(h.store.getSnapshot().update?.state.phase).toBe('up-to-date');

    h.hostEvent({ type: 'update', snapshot: snapshot({ phase: 'available', info }) });
    await h.settle();
    expect(h.store.getSnapshot().update?.state.phase).toBe('available');
  });

  it('asks the shell for each step and takes its answer', async () => {
    await h.controller.start();
    h.setUpdate(snapshot({ phase: 'ready', info }));
    await h.controller.downloadUpdate();
    expect(h.api.updateDownload).toHaveBeenCalled();
    expect(h.store.getSnapshot().update?.state.phase).toBe('ready');

    h.store.update({ updateOpen: true });
    await h.controller.dismissUpdate();
    expect(h.store.getSnapshot().updateOpen).toBe(false);
    expect(h.store.getSnapshot().update?.dismissed).toBe(true);

    await h.controller.checkForUpdate();
    expect(h.api.updateCheck).toHaveBeenCalledWith(true);
  });

  it('turns automatic checks on and off through the shell', async () => {
    await h.controller.start();
    await h.controller.setAutoCheckUpdates(false);
    expect(h.api.settingsSet).toHaveBeenCalledWith({ autoCheckUpdates: false });
    expect(h.store.getSnapshot().settings.autoCheckUpdates).toBe(false);
  });

  it('asks the quit question before an update, naming the restart', async () => {
    const handle = h.addFile('payments');
    await h.controller.openHandle(handle);
    await h.settle();
    const doc = createDocument('Payments');
    doc.nodes.push(createNode({ type: 'service', x: 0, y: 0 }));
    h.edit(serializeDocument(doc));
    await h.controller.start();
    h.answer(2);

    h.hostEvent({ type: 'update-requested' });
    await h.settle();

    expect(h.asked[0]!.title).toBe('Save the changes to payments.draftcanvas before updating?');
    expect(h.asked[0]!.message).toMatch(/restarts to finish the update/);
    // Cancel keeps working, and a copy of the changes is kept either way.
    expect(h.api.quitAck.mock.calls.map(([decision]) => decision)).toEqual(['prompting', 'cancel']);
    expect(h.recovery.size).toBe(1);
  });

  it('goes straight ahead when there is nothing to ask about', async () => {
    await h.controller.start();
    h.hostEvent({ type: 'update-requested' });
    await h.settle();
    expect(h.asked).toEqual([]);
    expect(h.api.quitAck).toHaveBeenCalledWith('ready');
  });
});
