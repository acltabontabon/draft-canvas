import type { HostChannel } from './channel';

/**
 * Which host is running the app, if any. The desktop app is the one host: its file is the document,
 * and it has a Home of its own. It registers itself here at startup (`src/desktop/boot.ts`), before
 * anything renders, rather than the app testing for a Tauri global wherever it needs to know.
 */
export type HostKind = 'desktop';

export interface DesktopHost {
  channel: HostChannel;
  /** The Back button, and the error screen's "Return home": lets the host settle unsaved work first. */
  returnHome(): void;
}

let desktopHost: DesktopHost | null = null;

export function registerDesktopHost(host: DesktopHost | null): void {
  desktopHost = host;
}

export function currentDesktopHost(): DesktopHost | null {
  return desktopHost;
}

export function hostKind(): HostKind | null {
  return desktopHost ? 'desktop' : null;
}

/** Leaves the open document for Home. Unsaved work is the desktop shell's to settle first; anywhere else it is just closed. */
export function returnHome(closeDocument: () => Promise<void>): void {
  if (desktopHost) desktopHost.returnHome();
  else void closeDocument();
}
