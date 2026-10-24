import { useSyncExternalStore } from 'react';
import { readPreference, writePreference } from '../lib/preferences';

/**
 * Whether Nodi is shown in the canvas corner: on unless the person switched it off in Settings → AI
 * agents. A preference of this window's, read once and then kept here, so the switch and the canvas
 * agree without either reading storage on every render.
 */
const KEY = 'companion.shown';

let shown = readPreference(KEY) !== 'off';
const listeners = new Set<() => void>();

export function nodiShown(): boolean {
  return shown;
}

export function setNodiShown(next: boolean): void {
  if (next === shown) return;
  shown = next;
  writePreference(KEY, next ? 'on' : 'off');
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNodiShown(): boolean {
  return useSyncExternalStore(subscribe, nodiShown, nodiShown);
}
