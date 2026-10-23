/**
 * What collaboration sessions talk through. `src/collab/transport/` is the one place in `src/` that
 * may touch network APIs (`tests/privacy.test.ts` enforces it); everything above this line sees only
 * whole JSON messages and a connection state.
 */

export type TransportState = 'connecting' | 'open' | 'degraded' | 'closed';
export type SendPriority = 'commit' | 'presence';
export interface CollabTransport {
  readonly kind: 'webrtc' | 'socket' | 'loopback';
  readonly state: TransportState;
  /**
   * What this connection's far end is authenticated by, the same text at both ends: for WebRTC, the
   * owner's DTLS certificate fingerprint, which the browser checks in the handshake. A proof of a
   * resume key is made over it, so one made for this connection is no use on any other. Absent where
   * the connection authenticates nothing (the local network socket, a test's loopback).
   */
  readonly binding?: string;
  /** One whole application message (JSON text). The transport chunks and reassembles. Returns false when a presence message was dropped under backpressure; commits are never dropped (queue, or move to 'degraded'). */
  send(message: string, priority: SendPriority): boolean;
  onMessage(listener: (message: string) => void): () => void;
  onState(listener: (state: TransportState, reason?: string) => void): () => void;
  close(reason?: string): void;
}
export interface IceConfig { servers: { urls: string | string[]; username?: string; credential?: string }[]; localOnly: boolean }
