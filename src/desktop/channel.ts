import type { HostChannel } from '../host/channel';
import type { ToHostMessage } from '../host/embeddedHost';

/** The desktop controller's side of the line: what it can say to the app, and what it hears from it. */
export interface HostLink {
  /** Delivers a message to the app. Held until the app has started listening, so a file the OS opened
   *  before the editor was up isn't lost. */
  deliver(message: unknown): void;
  /** What the app said. Set once, by the controller. */
  onMessage: (message: ToHostMessage) => void;
  /** See `HostChannel.opened`. */
  onOpened: (info: { text: string; seq?: number }) => void;
}

/**
 * The desktop's end of the line between app and host. Both live in this one page, so there's no
 * frame or origin to check: a message is passed straight across, and the controller plays the part
 * VS Code's extension does — it owns the file, the app owns the canvas.
 */
export function createHostLink(): { channel: HostChannel; link: HostLink } {
  let sink: ((data: unknown) => void) | null = null;
  const waiting: unknown[] = [];

  const link: HostLink = {
    deliver(message) {
      if (sink) sink(message);
      else waiting.push(message);
    },
    onMessage: () => {},
    onOpened: () => {},
  };

  const channel: HostChannel = {
    kind: 'desktop',
    start(onMessage) {
      sink = onMessage;
      for (const message of waiting.splice(0)) onMessage(message);
      return () => {
        if (sink === onMessage) sink = null;
      };
    },
    post: (message) => link.onMessage(message),
    opened: (info) => link.onOpened(info),
  };

  return { channel, link };
}
