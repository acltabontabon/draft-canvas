import { useSyncExternalStore } from 'react';

/**
 * Where Nodi is between conversations: its bunk at the end of the status bar. The companion
 * (`ui/Companion.tsx`) says whether it is on the canvas at all (`present`) and whether it is down in
 * the bunk (`docked`); the status bar (`ui/NodiDock.tsx`) draws the bunk, and Nodi in it while docked.
 * Transient, never saved: a new window starts with Nodi out on the canvas or not there at all.
 */
export type NodiDock = { present: boolean; docked: boolean; resting: 'idle' | 'asleep' };

const AWAY: NodiDock = { present: false, docked: false, resting: 'idle' };

let dock = AWAY;
const listeners = new Set<() => void>();

export function nodiDock(): NodiDock {
  return dock;
}

export function setNodiDock(next: NodiDock): void {
  if (next.present === dock.present && next.docked === dock.docked && next.resting === dock.resting) return;
  dock = next;
  for (const listener of listeners) listener();
}

export function clearNodiDock(): void {
  setNodiDock(AWAY);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNodiDock(): NodiDock {
  return useSyncExternalStore(subscribe, nodiDock, nodiDock);
}

/** The bunk on screen, for Nodi's jump into and out of it; null where there is none (no status bar). */
export function dockRect(): DOMRect | null {
  if (typeof document === 'undefined') return null;
  const slot = document.querySelector<HTMLElement>('[data-nodi-dock]');
  if (!slot) return null;
  const rect = slot.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}
