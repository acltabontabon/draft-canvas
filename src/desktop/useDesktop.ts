import { useSyncExternalStore } from 'react';
import type { DesktopController } from './controller';
import { desktopStore, type DesktopState } from './store';

let controller: DesktopController | null = null;

/** Set once by `boot`; the screens under src/desktop/ reach the controller through here. */
export function setDesktopController(next: DesktopController | null): void {
  controller = next;
}

export function useDesktopController(): DesktopController {
  if (!controller) throw new Error('The desktop shell has not started.');
  return controller;
}

export function useDesktopState(): DesktopState {
  return useSyncExternalStore(desktopStore.subscribe, desktopStore.getSnapshot);
}
