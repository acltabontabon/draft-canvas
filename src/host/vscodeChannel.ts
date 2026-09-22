import type { HostChannel } from './channel';
import { HOST_PROTOCOL, isHostOrigin, type ToHostMessage } from './embeddedHost';

/**
 * VS Code's end of the line: the app is framed by the extension's webview, and messages cross
 * `postMessage`. Only that webview's origin is believed, and the document is only ever posted back
 * to the origin its first `load` came from.
 */
export function vscodeChannel(): HostChannel {
  let hostOrigin: string | null = null;
  return {
    kind: 'vscode',
    start(onMessage) {
      const onWindowMessage = (event: MessageEvent) => {
        if (event.source !== window.parent || !isHostOrigin(event.origin)) return;
        const data = event.data as { type?: unknown; text?: unknown } | null;
        if (data?.type === 'draft-canvas:load' && typeof data.text === 'string') hostOrigin = event.origin;
        onMessage(event.data);
      };
      window.addEventListener('message', onWindowMessage);
      // No data in it, so any parent may hear it; the document only ever goes to the host's origin.
      window.parent.postMessage({ type: 'draft-canvas:ready', protocol: HOST_PROTOCOL } satisfies ToHostMessage, '*');
      return () => window.removeEventListener('message', onWindowMessage);
    },
    post(message) {
      if (hostOrigin) window.parent.postMessage(message, hostOrigin);
    },
  };
}
