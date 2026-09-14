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

const host = vi.hoisted(() => ({ value: null as 'vscode' | null, clipboard: false }));
vi.mock('../src/host/embeddedHost', () => ({
  get embeddedHost() {
    return host.value;
  },
}));
vi.mock('../src/host/hostClipboard', () => ({
  hostClipboard: () => (host.clipboard ? { write: vi.fn(), read: vi.fn() } : null),
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
    host.value = null;
    host.clipboard = false;
  });

  it('framed by a host that offers its clipboard: reads through it, with no dialog and no notice', async () => {
    host.value = 'vscode';
    host.clipboard = true;
    const editor = fakeEditor(true);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).not.toHaveBeenCalled();
    expect(editor.syncClipboardFromSystem).toHaveBeenCalledOnce();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it('framed by VS Code, which always refuses the read: no dialog, no read, no "blocked" notice', async () => {
    host.value = 'vscode';
    prefs.set('clipboard-permission', 'denied');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(false);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).not.toHaveBeenCalled();
    expect(editor.syncClipboardFromSystem).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
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

  it('previously denied: skips the dialog but still tries the read, and notifies if it fails again', async () => {
    prefs.set('clipboard-permission', 'denied');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(false);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(ui.requestClipboardPermission).not.toHaveBeenCalled();
    expect(editor.syncClipboardFromSystem).toHaveBeenCalledOnce();
    expect(prefs.get('clipboard-permission')).toBe('denied');
    expect(ui.notify).toHaveBeenCalledWith('Clipboard access is blocked by your browser.');
  });

  it('previously denied but the read now succeeds: recovers to "granted" without a notice', async () => {
    prefs.set('clipboard-permission', 'denied');
    vi.stubGlobal('navigator', { ...navigator, clipboard: { readText: vi.fn() } });
    const editor = fakeEditor(true);
    const ui = fakeUi(true);

    await requestClipboardRead(editor, ui);

    expect(prefs.get('clipboard-permission')).toBe('granted');
    expect(ui.notify).not.toHaveBeenCalled();
  });
});

describe('uiStore.requestClipboardPermission', () => {
  it('a second ask while the dialog is up settles with the same answer as the first', async () => {
    const { useUiStore } = await import('../src/store/uiStore');
    const first = useUiStore.getState().requestClipboardPermission();
    const second = useUiStore.getState().requestClipboardPermission();
    useUiStore.getState().resolveClipboardPermissionRequest(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(useUiStore.getState().clipboardPermissionRequest).toBeNull();
  });
});

describe('ClipboardPermissionDialog', () => {
  it('an ask left unanswered when the editor unmounts resolves as "not now"', async () => {
    const { createElement } = await import('react');
    const { act, render } = await import('@testing-library/react');
    const { useUiStore } = await import('../src/store/uiStore');
    const { ClipboardPermissionDialog } = await import('../src/ui/common/ClipboardPermissionDialog');

    const view = render(createElement(ClipboardPermissionDialog));
    let answer: Promise<boolean>;
    act(() => {
      answer = useUiStore.getState().requestClipboardPermission();
    });
    expect(view.getByRole('alertdialog')).toBeTruthy();

    view.unmount();
    await expect(answer!).resolves.toBe(false);
    expect(useUiStore.getState().clipboardPermissionRequest).toBeNull();
  });
});
