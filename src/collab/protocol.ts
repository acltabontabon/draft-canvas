/**
 * What a session's two ends say to each other, and the strict reading of what arrives.
 *
 * Neither end trusts the other. A collaborator's copy may be modified, and an invite link may have
 * reached someone it was not meant for; an owner's copy may be too. Every message is size-capped
 * before parsing, rejected if it carries keys that only exist to attack an object model, and read
 * field by field into a typed message — a message that does not read is dropped, never half-used.
 * Changes inside a message stay `unknown` here: `sanitizeChanges` is what turns them into changes.
 */
import { isRecord } from '../lib/isRecord';
import { LIMITS } from '../document/limits';

export const PROTOCOL_VERSION = 1;

/**
 * The largest message either end sends or accepts — the transports' own cap (`transport/chunk.ts`,
 * the desktop relay's frame limit). Smaller than the largest file the importer opens: a diagram
 * past it can be edited and exported, but not shared live.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Whether `text` is too big to send. The cap counts UTF-8 bytes, as the transports do; a string can
 * take up to three bytes per UTF-16 unit, so only a long one needs encoding to find out.
 */
export function exceedsMessageLimit(text: string, max = MAX_MESSAGE_BYTES): boolean {
  if (text.length * 3 <= max) return false;
  if (text.length > max) return true;
  return new TextEncoder().encode(text).byteLength > max;
}

/**
 * The largest message a collaborator may send the owner. Only the owner ever sends a whole file (a
 * snapshot); a collaborator's patch is an edit, and the owner pays to read every byte of it — so the
 * cap that keeps one peer from tying up the owner's tab is far below the transports' own.
 */
export const MAX_GUEST_MESSAGE_BYTES = 4 * 1024 * 1024;

export const MAX_NAME_LENGTH = 40;

/** A session holds the owner and at most this many collaborators. */
export const MAX_COLLABORATORS = 10;

export type Role = 'editor' | 'viewer';

export interface PeerInfo {
  id: string;
  name: string;
  /** One of `PEER_COLORS`, by index — never a free-form colour another peer could abuse. */
  color: number;
  role: Role | 'owner';
}

/** How a peer's connection is doing, as far as the other end can tell. */
export type LinkState = 'connecting' | 'live' | 'reconnecting' | 'gone';

export interface PeerView extends PeerInfo {
  link: LinkState;
}

export interface Point {
  x: number;
  y: number;
}

export interface Presence {
  /** The room this person is looking at, by the id of its owner — `''` for the document. */
  room: string;
  /** Flow coordinates in that room, or `null` while the pointer is off the canvas. */
  pointer: Point | null;
  selection: { nodes: string[]; edges: string[] };
  /** The shape whose text this person is typing into, if any. */
  editing: string | null;
}

export interface FollowState {
  path: string[];
  /**
   * The presenter's camera measured from the *centre* of their window (same zoom; the flow origin's
   * offset from the middle), so each follower can re-anchor it on the middle of their own window.
   */
  viewport: { x: number; y: number; zoom: number };
  /** The presenter's window, so a smaller one can zoom out to show all of what they show. */
  view?: { width: number; height: number };
  presenting: boolean;
  flowId: string | null;
  step: number | null;
}

export type RejectReason = 'view-only' | 'malformed' | 'limits';

export type EndReason =
  | 'owner-left'
  | 'ended'
  | 'removed'
  | 'version'
  | 'full'
  | 'unauthorized'
  | 'protocol'
  | 'timeout'
  | 'document-changed'
  | 'too-large'
  /** Turned away at the door, before joining. */
  | 'denied';

export interface HelloMessage {
  t: 'hello';
  v: number;
  /** The app's version (`PRODUCT.version`); a different major is refused. */
  app: string;
  /** The newest document schema this copy reads (`CURRENT_VERSION`). */
  doc: number;
  name: string;
  /** A desktop LAN session's secret. WebRTC sessions are authenticated by the connection itself. */
  token?: string;
  /**
   * Present when reconnecting: who this was, and the last commit it applied, with the secret it was
   * given to prove it — as `proof` (`resumeProof`) over a connection with a `binding`, and as the
   * `key` itself only over one without (the local network socket, where it is exposed anyway).
   */
  resume?: { peer: string; seq: number; key?: string; proof?: string };
}

export type GuestMessage =
  | HelloMessage
  /**
   * `epoch` is the owner's count of fresh copies this collaborator has taken in (`Resend`): a patch
   * sent before the latest was taken in is already part of the one patch sent after it.
   */
  | { t: 'patch'; clientSeq: number; changes: unknown; epoch?: number }
  | { t: 'resync' }
  | { t: 'presence'; presence: Presence }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }
  | { t: 'bye' };

/**
 * What comes with every fresh copy of the file sent to one collaborator: the newest of their patches
 * the owner has handled (in the copy, or refused), and a new epoch. From the copy on, the owner takes
 * only patches marked with that epoch, and the collaborator sends everything it still has
 * unconfirmed as one patch so marked — so a patch in flight when the copy was made can never be
 * applied out of order, and nothing is sent twice. Absent from an older owner's messages.
 */
export interface Resend {
  handled?: number;
  epoch?: number;
}

export type HostMessage =
  /** `key` is this collaborator's alone: peer ids are visible to everyone, so reclaiming one after a drop takes the key too. */
  /** `proof` answers a resume made by proof: the owner's `resumeProof`, so the collaborator knows it is the session they left. */
  | ({ t: 'welcome'; v: number; session: string; peer: string; key: string; role: Role; seq: number; snapshot: unknown; peers: PeerInfo[]; proof?: string } & Resend)
  | ({ t: 'snapshot'; seq: number; snapshot: unknown } & Resend)
  | { t: 'commit'; seq: number; changes: unknown; origin: string; clientSeq?: number }
  | { t: 'ack'; clientSeq: number; rejected?: RejectReason }
  | { t: 'peers'; peers: PeerInfo[] }
  | { t: 'role'; role: Role }
  | { t: 'presence'; peer: string; presence: Presence | null }
  | { t: 'follow'; state: FollowState | null }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }
  | { t: 'end'; reason: EndReason };

export function encode(message: GuestMessage | HostMessage): string {
  return JSON.stringify(message);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class ForbiddenKey extends Error {}

/** Text off the wire as a plain value, or `null` when it is too big, not JSON, or hostile. */
export function parseWire(text: string): unknown {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_BYTES) return null;
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new ForbiddenKey();
      return value;
    });
  } catch {
    return null;
  }
}

const isInt = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readId(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  if (value === '') return allowEmpty ? value : null;
  return value.length <= LIMITS.maxIdLength ? value : null;
}

function readIds(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    const id = readId(item);
    if (id === null) return null;
    out.push(id);
  }
  return out;
}

function readRole(value: unknown): Role | null {
  return value === 'editor' || value === 'viewer' ? value : null;
}

export function readName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 400) return null;
  // Every control, format, line- and paragraph-separator character goes — the invisible and
  // direction-changing ones that could make one name pass for another — except the zero-width
  // joiner, which emoji are built with. Stacks of combining marks are cut to two, and the result
  // must show at least one letter, digit or symbol: a name has to be something you can see.
  const cleaned = value
    .replace(/(?!\u200D)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    // Characters Unicode counts as letters or symbols that draw nothing: Hangul fillers, the blank
    // Braille pattern.
    .replace(/[\u115F\u1160\u3164\uFFA0\u2800]/g, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut by code point, so a surrogate pair is never split in half.
  const name = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return /[\p{L}\p{N}\p{S}]/u.test(name) ? name : null;
}

function readPeer(value: unknown): PeerInfo | null {
  if (!isRecord(value)) return null;
  const id = readId(value.id);
  const name = readName(value.name);
  const role = value.role === 'owner' ? 'owner' : readRole(value.role);
  if (!id || !name || !role || !isInt(value.color) || value.color > 64) return null;
  return { id, name, color: value.color, role };
}

function readPeers(value: unknown): PeerInfo[] | null {
  if (!Array.isArray(value) || value.length > MAX_COLLABORATORS + 1) return null;
  const peers: PeerInfo[] = [];
  for (const item of value) {
    const peer = readPeer(item);
    if (!peer) return null;
    peers.push(peer);
  }
  return peers;
}

function readPoint(value: unknown): Point | null {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  if (Math.abs(value.x) > LIMITS.maxCoordinate * 2 || Math.abs(value.y) > LIMITS.maxCoordinate * 2) return null;
  return { x: value.x, y: value.y };
}

/** A selection bigger than this is drawn as no selection — presence is a hint, not a copy of the file. */
const MAX_PRESENCE_SELECTION = 500;

export function readPresence(value: unknown): Presence | null {
  if (!isRecord(value) || !isRecord(value.selection)) return null;
  const room = readId(value.room, true);
  const pointer = value.pointer === null ? null : readPoint(value.pointer);
  const nodes = readIds(value.selection.nodes, MAX_PRESENCE_SELECTION);
  const edges = readIds(value.selection.edges, MAX_PRESENCE_SELECTION);
  const editing = value.editing === null ? null : readId(value.editing);
  if (room === null || (value.pointer !== null && !pointer) || !nodes || !edges || (value.editing !== null && editing === null)) return null;
  return { room, pointer, selection: { nodes, edges }, editing };
}

function readFollow(value: unknown): FollowState | null {
  if (!isRecord(value) || !isRecord(value.viewport)) return null;
  const path = readIds(value.path, LIMITS.maxInsideDepth);
  const { x, y, zoom } = value.viewport;
  if (!path || !isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(zoom)) return null;
  if (typeof value.presenting !== 'boolean') return null;
  const flowId = value.flowId === null ? null : readId(value.flowId);
  const step = value.step === null ? null : isInt(value.step) ? value.step : undefined;
  if ((value.flowId !== null && flowId === null) || step === undefined) return null;
  let view: FollowState['view'];
  if (value.view !== undefined) {
    if (!isRecord(value.view) || !isFiniteNumber(value.view.width) || !isFiniteNumber(value.view.height)) return null;
    if (value.view.width < 1 || value.view.height < 1 || value.view.width > 20_000 || value.view.height > 20_000) return null;
    view = { width: value.view.width, height: value.view.height };
  }
  return {
    path,
    viewport: {
      x: Math.max(-LIMITS.maxCoordinate, Math.min(LIMITS.maxCoordinate, x)),
      y: Math.max(-LIMITS.maxCoordinate, Math.min(LIMITS.maxCoordinate, y)),
      zoom: Math.max(LIMITS.minZoom, Math.min(LIMITS.maxZoom, zoom)),
    },
    ...(view ? { view } : {}),
    presenting: value.presenting,
    flowId,
    step,
  };
}

const END_REASONS: readonly EndReason[] = ['owner-left', 'ended', 'removed', 'version', 'full', 'unauthorized', 'protocol', 'timeout', 'document-changed', 'too-large', 'denied'];
const REJECT_REASONS: readonly RejectReason[] = ['view-only', 'malformed', 'limits'];

/** A message from a collaborator, as the host reads it. */
export function readGuestMessage(value: unknown): GuestMessage | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'hello': {
      const name = readName(value.name);
      if (!isInt(value.v, 1) || typeof value.app !== 'string' || value.app.length > 40 || !isInt(value.doc, 1) || !name) return null;
      const hello: HelloMessage = { t: 'hello', v: value.v, app: value.app, doc: value.doc, name };
      if (value.token !== undefined) {
        if (typeof value.token !== 'string' || value.token.length > 128) return null;
        hello.token = value.token;
      }
      if (value.resume !== undefined) {
        if (!isRecord(value.resume)) return null;
        const peer = readId(value.resume.peer);
        const key = value.resume.key === undefined ? undefined : readId(value.resume.key);
        const proof = value.resume.proof === undefined ? undefined : readProof(value.resume.proof);
        // One way of proving it, never both.
        if (!peer || !isInt(value.resume.seq) || (key === undefined) === (proof === undefined) || key === null || proof === null) return null;
        hello.resume = { peer, seq: value.resume.seq, ...(key === undefined ? {} : { key }), ...(proof === undefined ? {} : { proof }) };
      }
      return hello;
    }
    case 'patch': {
      if (!isInt(value.clientSeq, 1) || !Array.isArray(value.changes)) return null;
      if (value.epoch !== undefined && !isInt(value.epoch, 1)) return null;
      return { t: 'patch', clientSeq: value.clientSeq, changes: value.changes, ...(value.epoch === undefined ? {} : { epoch: value.epoch as number }) };
    }
    case 'resync':
      return { t: 'resync' };
    case 'presence': {
      const presence = readPresence(value.presence);
      return presence ? { t: 'presence', presence } : null;
    }
    case 'ping':
    case 'pong':
      return isInt(value.n) ? { t: value.t, n: value.n } : null;
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

/** A `resumeProof`: an HMAC-SHA-256, base64url. */
function readProof(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** Both of `Resend`'s fields or neither: one alone would be read as the other's absence. */
function readResend(value: Record<string, unknown>): Resend | null {
  if (value.handled === undefined && value.epoch === undefined) return {};
  return isInt(value.handled) && isInt(value.epoch, 1) ? { handled: value.handled, epoch: value.epoch } : null;
}

/** A message from the owner, as a collaborator reads it. */
export function readHostMessage(value: unknown): HostMessage | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case 'welcome': {
      const session = readId(value.session);
      const peer = readId(value.peer);
      const key = readId(value.key);
      const role = readRole(value.role);
      const peers = readPeers(value.peers);
      const resend = readResend(value);
      const proof = value.proof === undefined ? undefined : readProof(value.proof);
      if (!isInt(value.v, 1) || !session || !peer || !key || !role || !isInt(value.seq) || !peers || !isRecord(value.snapshot) || !resend || proof === null) return null;
      return { t: 'welcome', v: value.v, session, peer, key, role, seq: value.seq, snapshot: value.snapshot, peers, ...resend, ...(proof === undefined ? {} : { proof }) };
    }
    case 'snapshot': {
      const resend = readResend(value);
      return isInt(value.seq) && isRecord(value.snapshot) && resend ? { t: 'snapshot', seq: value.seq, snapshot: value.snapshot, ...resend } : null;
    }
    case 'commit': {
      const origin = readId(value.origin);
      if (!isInt(value.seq, 1) || !origin || !Array.isArray(value.changes)) return null;
      if (value.clientSeq !== undefined && !isInt(value.clientSeq, 1)) return null;
      return {
        t: 'commit',
        seq: value.seq,
        changes: value.changes,
        origin,
        ...(value.clientSeq === undefined ? {} : { clientSeq: value.clientSeq as number }),
      };
    }
    case 'ack': {
      if (!isInt(value.clientSeq, 1)) return null;
      if (value.rejected === undefined) return { t: 'ack', clientSeq: value.clientSeq };
      return REJECT_REASONS.includes(value.rejected as RejectReason)
        ? { t: 'ack', clientSeq: value.clientSeq, rejected: value.rejected as RejectReason }
        : null;
    }
    case 'peers': {
      const peers = readPeers(value.peers);
      return peers ? { t: 'peers', peers } : null;
    }
    case 'role': {
      const role = readRole(value.role);
      return role ? { t: 'role', role } : null;
    }
    case 'presence': {
      const peer = readId(value.peer);
      if (!peer) return null;
      if (value.presence === null) return { t: 'presence', peer, presence: null };
      const presence = readPresence(value.presence);
      return presence ? { t: 'presence', peer, presence } : null;
    }
    case 'follow': {
      if (value.state === null) return { t: 'follow', state: null };
      const state = readFollow(value.state);
      return state ? { t: 'follow', state } : null;
    }
    case 'ping':
    case 'pong':
      return isInt(value.n) ? { t: value.t, n: value.n } : null;
    case 'end':
      return END_REASONS.includes(value.reason as EndReason) ? { t: 'end', reason: value.reason as EndReason } : null;
    default:
      return null;
  }
}

/** The major part of a version string, for the handshake's compatibility check. */
export function majorOf(version: string): number | null {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}
