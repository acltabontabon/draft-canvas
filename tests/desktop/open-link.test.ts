import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToHostMessage } from '../../src/host/embeddedHost';
import { registerDesktopHost } from '../../src/host/hostInfo';
import { openLink } from '../../src/host/openLink';

/**
 * Documentation, opened from the More menu or the command palette, did nothing in the Windows
 * desktop app: it called `window.open`, which the desktop webview drops, rather than asking the
 * shell to open the system browser the way a clicked link does.
 */
describe('openLink', () => {
  afterEach(() => {
    registerDesktopHost(null);
    vi.restoreAllMocks();
  });

  it('asks the desktop shell to open the page, and never the webview', () => {
    const posted: ToHostMessage[] = [];
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    registerDesktopHost({
      channel: { kind: 'desktop', start: () => () => {}, post: (message) => posted.push(message) },
      returnHome: () => {},
    });

    openLink('https://acltabontabon.com/draft-canvas/docs/');

    expect(posted).toEqual([{ type: 'draft-canvas:open-external', url: 'https://acltabontabon.com/draft-canvas/docs/' }]);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a new tab on the web', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openLink('https://acltabontabon.com/draft-canvas/docs/');
    expect(open).toHaveBeenCalledWith('https://acltabontabon.com/draft-canvas/docs/', '_blank', 'noopener');
  });
});
