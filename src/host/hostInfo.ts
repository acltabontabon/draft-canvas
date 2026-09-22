import type { HostChannel } from './channel';
import { embeddedHost } from './embeddedHost';

/**
 * Which host is running the app, if any. `embeddedHost` is only the VS Code frame: the file is the
 * document there and there is no Library to go back to. The desktop app is a host too — its file is
 * the document as well, and it has a Home of its own — so it registers itself here at startup
 * (`src/desktop/boot.ts`), before anything renders, rather than the app testing for a Tauri
 * global wherever it needs to know.
 */
export type HostKind = 'vscode' | 'desktop';

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
  return desktopHost ? 'desktop' : embeddedHost;
}

/** Leaves the open document for Home. Unsaved work is the desktop shell's to settle first; anywhere else it is just closed. */
export function returnHome(closeDocument: () => Promise<void>): void {
  if (desktopHost) desktopHost.returnHome();
  else void closeDocument();
}
