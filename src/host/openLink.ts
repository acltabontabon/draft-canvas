import { currentDesktopHost } from './hostInfo';

/**
 * Opens a page on another site: a new tab on the web, the system browser in the desktop app.
 *
 * `window.open` goes nowhere inside the desktop app's webview — on Windows it does nothing at all —
 * so there the shell is asked to open it, with the same message a clicked link sends
 * (`useHostDocument`). Anything that opens a URL from code rather than from an `<a>` comes through
 * here. A link, not a fetch: nothing in `src/` makes a network request of its own.
 */
export function openLink(url: string): void {
  const host = currentDesktopHost();
  if (host) host.channel.post({ type: 'draft-canvas:open-external', url });
  else window.open(url, '_blank', 'noopener');
}
