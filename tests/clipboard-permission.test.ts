import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorStore } from '../src/store/editorStore';
import type { UiStore } from '../src/store/uiStore';

// Node's own experimental `globalThis.localStorage` shadows jsdom's implementation in this
// environment (unrelated to app code) — a tiny in-memory fake stands in for `lib/preferences.ts`
// so this test exercises `requestClipboardRead`'s actual branching, same pattern as
// `personality-preference.test.tsx`.
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
}));

const { requestClipboardRead } = await import('../src/lib/clipboardPermission');

function fakeEditor(syncResult: boolean) {
  return { syncClipboardFromSystem: vi.fn().mockResolvedValue(syncResult) } as unknown as EditorStore;
}

function fakeUi(allow: boolean) {
  return {
    notify: vi.fn(),
    requestClipboardPermission: vi.fn().mockResolvedValue(allow),
  } as unknown as UiStore;
}

describe('requestClipboardRead', () => {
  beforeEach(() => {
    prefs.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when the Clipboard API is unavailable — no dialog, no read, no notify', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const editor = fakeEditor(true);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).not.toHaveBeenCalled();
    expect(editor.syncClipboardFromSystem).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it('never asked + Allow + success: shows the dialog, reads, and persists "granted"', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(true);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).toHaveBeenCalledOnce();
    expect(editor.syncClipboardFromSystem).toHaveBeenCalledOnce();
    expect(prefs.get('clipboard-permission')).toBe('granted');
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it('never asked + Allow + failure: persists "denied" and shows the graceful message', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(false);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(prefs.get('clipboard-permission')).toBe('denied');
    expect(ui.notify).toHaveBeenCalledWith('Clipboard access is blocked by your browser.');
  });

  it('never asked + Not now: reads nothing, persists nothing, notifies nothing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(true);
    const ui = fakeUi(false);

    await requestClipboardRead(editor, ui);

    expect(editor.syncClipboardFromSystem).not.toHaveBeenCalled();
    expect(prefs.has('clipboard-permission')).toBe(false);
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it('already granted: skips the dialog and reads directly', async () => {
    prefs.set('clipboard-permission', 'granted');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(true);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).not.toHaveBeenCalled();
    expect(editor.syncClipboardFromSystem).toHaveBeenCalledOnce();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it('already granted but the read now fails: flips the preference to "denied" and notifies', async () => {
    prefs.set('clipboard-permission', 'granted');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(false);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(prefs.get('clipboard-permission')).toBe('denied');
    expect(ui.notify).toHaveBeenCalledWith('Clipboard access is blocked by your browser.');
  });

  it('already denied: skips both the dialog and the read, and just notifies', async () => {
    prefs.set('clipboard-permission', 'denied');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(true);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).not.toHaveBeenCalled();
    expect(editor.syncClipboardFromSystem).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith('Clipboard access is blocked by your browser.');
  });
});
