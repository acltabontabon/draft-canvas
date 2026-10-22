import type { LanRelay, LanRelayEvent } from '../collab/lan';
import type { DesktopApi, HostEvent } from './api';

/**
 * Where the shell's `collab-lan-*` events go. The controller hears every host event and hands these
 * here; whoever runs network sharing (`ui/collab/LanShare.tsx`, through `startLanSharing`) listens.
 * Events with no listener are dropped: the relay only runs while someone is sharing.
 */

export type CollabLanEvent = Extract<HostEvent, { type: LanRelayEvent['type'] }>;

const listeners = new Set<(event: LanRelayEvent) => void>();

const LAN_EVENTS: ReadonlySet<string> = new Set<LanRelayEvent['type']>([
  'collab-lan-open',
  'collab-lan-message',
  'collab-lan-close',
  'collab-lan-stopped',
]);

export function isCollabLanEvent(event: HostEvent): event is CollabLanEvent {
  return LAN_EVENTS.has(event.type);
}

export function dispatchCollabLanEvent(event: CollabLanEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error(error);
    }
  }
}

export function onCollabLanEvent(listener: (event: LanRelayEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The relay as `collab/lan.ts` drives it: the shell's four commands and these events. */
export function lanRelayOf(api: Pick<DesktopApi, 'collabLanStart' | 'collabLanStop' | 'collabLanSend' | 'collabLanClose'>): LanRelay {
  return {
    start: (token) => api.collabLanStart({ token }),
    stop: (token) => api.collabLanStop(token === undefined ? undefined : { token }),
    send: (connId, text) => api.collabLanSend(connId, text),
    close: (connId, reason) => api.collabLanClose(connId, reason),
    subscribe: onCollabLanEvent,
  };
}
