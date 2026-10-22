// Types for relay-room.js, for tests/relay-room.test.ts. Not deployed: only .js and .jsonc files are.

export interface Close {
  readonly code: number;
  readonly reason: string;
}

export interface SocketState {
  role: 'host' | 'guest';
  /** The relay-assigned guest tag; `null` for the host. */
  tag: string | null;
  tokens: number;
  at: number;
  bad: number;
  born: number;
  last: number;
  gone: boolean;
}

export interface Peer {
  read(): SocketState;
  write(state: SocketState): void;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export type Verdict =
  | { kind: 'health' }
  | { kind: 'connect'; room: string; role: 'host' | 'guest'; secret: string | null }
  | { kind: 'reject'; status: number; body: string; headers: Record<string, string> };

export const LIMITS: {
  readonly maxData: number;
  readonly maxFrame: number;
  readonly maxGuests: number;
  readonly rateMessages: number;
  readonly rateWindowMs: number;
  readonly maxBadFrames: number;
  readonly idleMs: number;
  readonly lifetimeMs: number;
  readonly connectsPerMinute: number;
};

export const CLOSE: {
  readonly hostTaken: Close;
  readonly notOwner: Close;
  readonly roomFull: Close;
  readonly congested: Close;
  readonly binary: Close;
  readonly tooLarge: Close;
  readonly rate: Close;
  readonly invalid: Close;
  readonly idle: Close;
  readonly expired: Close;
};

export const PROTOCOL: string;
export const DEFAULT_ORIGINS: readonly string[];
export const GUEST_TAG: RegExp;

export function parseOrigins(value: string | undefined | null): string[];
export function originAllowed(origin: string | null | undefined, origins: readonly string[], options?: { loopback?: boolean }): boolean;
export function checkRequest(
  request: { method: string; url: string; upgrade: string | null | undefined; origin: string | null | undefined; protocols?: string | null | undefined },
  options: { origins: readonly string[]; loopback?: boolean },
): Verdict;
export function secretDigest(secret: string): Promise<string>;
export function connectionAllowed(seen: Map<string, number[]>, address: string, now: number): boolean;
export interface OwnerClaim {
  digest: string;
  until: number;
}
export function checkOwner(
  claim: OwnerClaim | null | undefined,
  digest: string | null,
  now: number,
): { verdict: 'owner' } | { verdict: 'claim'; claim: OwnerClaim } | { verdict: 'not-owner' };
export function guestTag(random?: (bytes: Uint8Array) => Uint8Array): string;
export function uniqueGuestTag(peers: Peer[], random?: (bytes: Uint8Array) => Uint8Array): string;
export function live(peers: Peer[]): Peer[];
export function admission(peers: Peer[], role: 'host' | 'guest'): Close | null;
export function openState(peers: Peer[], role: 'host' | 'guest', tag: string | null, now: number): SocketState;
export const events: {
  ready(): string;
  host(present: boolean): string;
  left(tag: string): string;
  message(from: string, data: string): string;
};
export function opened(peers: Peer[], peer: Peer): void;
export function closePeer(peers: Peer[], peer: Peer, close: Close): void;
export function departed(peers: Peer[], peer: Peer): void;
export function received(peers: Peer[], peer: Peer, text: string | null, now: number): void;
export function deadline(peers: Peer[]): number | null;
export function sweep(peers: Peer[], now: number): number | null;
