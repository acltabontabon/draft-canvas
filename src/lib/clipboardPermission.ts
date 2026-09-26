import { readPreference, writePreference } from './preferences';
import type { EditorStore } from '../store/editorStore';
import type { UiStore } from '../store/uiStore';

const KEY = 'clipboard-permission';

function isClipboardReadAvailable(): boolean {
  return typeof navigator.clipboard?.readText === 'function';
}

function getPreference(): 'granted' | 'denied' | 'unknown' {
  const raw = readPreference(KEY);
  return raw === 'granted' || raw === 'denied' ? raw : 'unknown';
}

/**
 * Gate in front of `syncClipboardFromSystem()` for the two call sites with no real
 * `ClipboardEvent` to read from — the context-menu and command-palette "Paste" commands (see
 * `commands/registry.ts`). Plain Cmd/Ctrl+V never goes through here at all: it reads a native
 * paste event's `clipboardData` directly (see `EditorScreen.tsx`), which needs no permission.
 *
 * Never throws, and never leaves `editor.clipboard` untouched-but-broken — a denied/unavailable/
 * dismissed outcome just falls back to whatever's already in the in-memory clipboard, same as
 * `syncClipboardFromSystem` always has.
 *
 * `navigator.permissions.query({name: 'clipboard-read'})` is deliberately not used as a source of
 * truth here — Firefox and Safari don't reliably support querying that permission name, so state
 * is inferred instead from our own dialog's outcome and from real `readText()` results.
 */
export async function requestClipboardRead(editor: EditorStore, ui: UiStore): Promise<void> {
  if (!isClipboardReadAvailable()) return; // nothing to ask permission for

  const pref = getPreference();
  if (pref !== 'unknown') {
    // Asked before (either way): skip our own explanation and just try. A remembered "denied" is
    // not final — a dismissed browser prompt in Firefox/Safari rejects the read once, and the user
    // may since have allowed it in site settings — so every explicit Paste gets a real attempt,
    // and a success flips the preference back.
    const ok = await editor.syncClipboardFromSystem();
    writePreference(KEY, ok ? 'granted' : 'denied');
    if (!ok) ui.notify('Clipboard access is blocked by your browser.');
    return;
  }

  // Never asked — show the small explanation before ever touching navigator.clipboard.
  const allowed = await ui.requestClipboardPermission();
  if (!allowed) return; // "Not now" or dismissed — not persisted; ask again next explicit action

  const ok = await editor.syncClipboardFromSystem();
  writePreference(KEY, ok ? 'granted' : 'denied');
  if (!ok) ui.notify('Clipboard access is blocked by your browser.');
}
