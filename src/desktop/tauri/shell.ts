import { convertFileSrc, isTauri } from '@tauri-apps/api/core';

/**
 * Whether this page is in the desktop app's own window, where the shell answers. The desktop build
 * is also what the app's LAN relay serves to collaborators' browsers (`src-tauri/src/collab/`):
 * there nothing answers, and the page must start as the web app so an invite link's join runs.
 *
 * Tauri flags its windows; a stand-in bridge (the desktop e2e suite's mock shell) may not, so the
 * bridge itself is asked too, with a call that has no effect: converting a path. A plain browser has
 * no bridge, and the call throws.
 */
export function insideDesktopShell(): boolean {
  try {
    if (isTauri()) return true;
    convertFileSrc('');
    return true;
  } catch {
    return false;
  }
}
