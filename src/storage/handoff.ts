/**
 * Moving the Library from the editor's first address to its own origin, tab to tab.
 *
 * Browsers keep IndexedDB per origin, so diagrams drawn at `PRODUCT.web.legacyOrigin` are invisible
 * at `PRODUCT.web.appOrigin`. The old address keeps serving this same build, and its Library offers
 * to send them across: it opens the new address in a tab of its own (keeping the opener, so the two
 * can talk), waits for that tab to say it is ready, and posts it the same ZIP a backup writes. The
 * new tab restores it — adding, never overwriting — and answers with what arrived.
 *
 * Nothing touches a network: the bytes go from one tab to the other through `postMessage`, and each
 * side names the other's exact origin as the target and checks it on every message it accepts,
 * together with the window it came from. Never `'*'`: a backup is the whole Library.
 *
 * React-free and parameterized — origins, windows and timers come in as arguments with the real
 * ones as defaults — so `tests/handoff.test.ts` drives both halves against fake windows.
 */

import { PRODUCT } from '../product';
import { buildBackup, restoreBackup, type RestoreResult } from './backup';
import type { DraftRepository } from './DraftRepository';

export const HANDOFF_TYPE = 'draft-canvas:handoff';
export const HANDOFF_VERSION = 1;
export const HANDOFF_HASH = '#handoff';
/** The preference that remembers when this Library was last sent to the new address (ISO, 24 chars). */
export const MOVED_DIAGRAMS_PREFERENCE = 'moved-diagrams-at';
/** Far above any real Library; a payload past it is refused before it is unzipped. */
export const HANDOFF_MAX_BYTES = 200 * 1024 * 1024;

/** How long the old tab waits for the new one to load and say hello. */
const READY_TIMEOUT_MS = 60_000;
/** How long either side waits once the backup is on its way: restoring hundreds of diagrams takes a while. */
const TRANSFER_TIMEOUT_MS = 180_000;
/** How often the old tab looks for the new one having been closed, rather than waiting out a timeout. */
const CLOSED_POLL_MS = 500;

interface Envelope<Step extends string> {
  type: typeof HANDOFF_TYPE;
  version: typeof HANDOFF_VERSION;
  step: Step;
}
export type HandoffReady = Envelope<'ready'>;
export interface HandoffBackup extends Envelope<'backup'> {
  bytes: ArrayBuffer;
  /** Diagrams in the archive. */
  count: number;
}
export interface HandoffAck extends Envelope<'ack'> {
  restored: number;
  renamed: number;
  /** Archive entries the new tab couldn't read — a count, never their names. */
  skipped: number;
  /** Set when nothing could be restored at all. */
  error?: string;
}
export type HandoffMessage = HandoffReady | HandoffBackup | HandoffAck;

/** The part of a window the other side is reached through. */
export interface HandoffPeer {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
  readonly closed?: boolean;
}

/** The part of this window messages arrive at. */
export interface MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

const envelope = <Step extends HandoffMessage['step']>(step: Step): Envelope<Step> => ({ type: HANDOFF_TYPE, version: HANDOFF_VERSION, step });

const ALLOWED_KEYS: Record<HandoffMessage['step'], readonly string[]> = {
  ready: ['type', 'version', 'step'],
  backup: ['type', 'version', 'step', 'bytes', 'count'],
  ack: ['type', 'version', 'step', 'restored', 'renamed', 'skipped', 'error'],
};

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';

/** Whether `data` is one of ours at all — anything else (an extension's chatter) is simply not for us. */
function isEnvelope(data: unknown): data is { type: string; version: number; step: string } {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === HANDOFF_TYPE;
}

/**
 * `data` as the message `step` expects, or null. Strict: the right version, no keys beyond the
 * step's own, and every field of its type — a backup's bytes an `ArrayBuffer` (or a view of one)
 * under the size cap.
 */
export function parseHandoff(data: unknown, step: 'ready'): HandoffReady | null;
export function parseHandoff(data: unknown, step: 'backup'): HandoffBackup | null;
export function parseHandoff(data: unknown, step: 'ack'): HandoffAck | null;
export function parseHandoff(data: unknown, step: HandoffMessage['step']): HandoffMessage | null {
  if (!isEnvelope(data) || data.version !== HANDOFF_VERSION || data.step !== step) return null;
  const record = data as unknown as Record<string, unknown>;
  if (!Object.keys(record).every((key) => ALLOWED_KEYS[step].includes(key))) return null;
  if (step === 'ready') return envelope('ready');
  if (step === 'backup') {
    const raw = record.bytes;
    const bytes = isArrayBuffer(raw)
      ? raw
      : raw instanceof Uint8Array && isArrayBuffer(raw.buffer)
        ? (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
        : null;
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > HANDOFF_MAX_BYTES || !isCount(record.count)) return null;
    return { ...envelope('backup'), bytes, count: record.count };
  }
  if (!isCount(record.restored) || !isCount(record.renamed) || !isCount(record.skipped)) return null;
  if (record.error !== undefined && typeof record.error !== 'string') return null;
  return {
    ...envelope('ack'),
    restored: record.restored,
    renamed: record.renamed,
    skipped: record.skipped,
    ...(typeof record.error === 'string' ? { error: record.error.slice(0, 300) } : {}),
  };
}

/* ------------------------------------------------------------- old side -- */

/** Whether this page is the editor's old address, the one that offers to send its Library. */
export function offersHandoff(origin: string = globalThis.location?.origin ?? '', legacyOrigin: string = PRODUCT.web.legacyOrigin): boolean {
  return origin === legacyOrigin;
}

export type SendOutcome =
  | { kind: 'moved'; restored: number; renamed: number; skipped: number; /** Diagrams this tab couldn't read to send. */ unreadable: number }
  /** `window.open` returned nothing: a popup blocker. */
  | { kind: 'blocked' }
  | { kind: 'timeout'; stage: 'ready' | 'ack' }
  | { kind: 'closed' }
  | { kind: 'failed'; message: string };

export interface SendOptions {
  repository: DraftRepository;
  /** Opens the new address. Must keep the opener (no `noopener`) — the new tab answers through it. */
  open?: (url: string) => HandoffPeer | null;
  /** Where the new tab's answers arrive: this window. */
  target?: MessageTarget;
  appUrl?: string;
  appOrigin?: string;
  readyTimeoutMs?: number;
  ackTimeoutMs?: number;
  closedPollMs?: number;
}

/**
 * Sends this Library to the new address. Call it straight from the click: the tab is opened
 * synchronously, before the first `await`, or a popup blocker refuses it.
 */
export function sendDiagrams(options: SendOptions): Promise<SendOutcome> {
  const {
    repository,
    appUrl = PRODUCT.web.app,
    appOrigin = PRODUCT.web.appOrigin,
    readyTimeoutMs = READY_TIMEOUT_MS,
    ackTimeoutMs = TRANSFER_TIMEOUT_MS,
    closedPollMs = CLOSED_POLL_MS,
  } = options;
  const target: MessageTarget = options.target ?? window;
  const open = options.open ?? ((url: string): HandoffPeer | null => window.open(url, '_blank'));
  const popup = open(`${appUrl}${HANDOFF_HASH}`);
  if (!popup) return Promise.resolve({ kind: 'blocked' });

  /** The next message `step` from the new tab — and only from it, at its origin. */
  const next = <T>(parse: (data: unknown) => T | null, timeoutMs: number, stage: 'ready' | 'ack') =>
    new Promise<T | SendOutcome>((resolve) => {
      const finish = (value: T | SendOutcome) => {
        target.removeEventListener('message', onMessage);
        clearTimeout(timer);
        clearInterval(poll);
        resolve(value);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== appOrigin || event.source !== popup) return;
        const parsed = parse(event.data);
        if (parsed) finish(parsed);
      };
      target.addEventListener('message', onMessage);
      const timer = setTimeout(() => finish({ kind: 'timeout', stage }), timeoutMs);
      const poll = setInterval(() => {
        if (popup.closed) finish({ kind: 'closed' });
      }, closedPollMs);
    });

  return (async (): Promise<SendOutcome> => {
    const ready = await next((data) => parseHandoff(data, 'ready'), readyTimeoutMs, 'ready');
    if ('kind' in ready) return ready;
    let backup;
    try {
      backup = await buildBackup(repository);
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : 'Your diagrams could not be read.' };
    }
    const { bytes, count, skipped } = backup;
    // Transferred, not copied: a Library can be tens of megabytes. Only a view over the whole
    // buffer can hand that buffer over; anything else is copied out first.
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    if (buffer.byteLength > HANDOFF_MAX_BYTES) {
      return { kind: 'failed', message: 'This Library is too large to send in one go. Back up here and restore it there instead.' };
    }
    // Listening before posting: a quick answer must not arrive before anyone is waiting for it.
    const answer = next((data) => parseHandoff(data, 'ack'), ackTimeoutMs, 'ack');
    try {
      const message: HandoffBackup = { ...envelope('backup'), bytes: buffer, count };
      popup.postMessage(message, appOrigin, [buffer]);
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : 'Your diagrams could not be sent.' };
    }
    const ack = await answer;
    if ('kind' in ack) return ack;
    if (ack.error !== undefined) return { kind: 'failed', message: ack.error };
    return { kind: 'moved', restored: ack.restored, renamed: ack.renamed, skipped: ack.skipped, unreadable: skipped.length };
  })();
}

/* ------------------------------------------------------------- new side -- */

/** The page the receiver reads and tidies: this window's address, history and opener. */
export interface ReceiverHost extends MessageTarget {
  location: Pick<Location, 'origin' | 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'state' | 'replaceState'>;
  opener: HandoffPeer | null;
}

export type ReceiveOutcome =
  /** Not a handoff: another origin, or no `#handoff`. */
  | { kind: 'none' }
  /** `#handoff` with no tab behind it — opened from a bookmark or pasted. The hash is cleared. */
  | { kind: 'no-opener' }
  | { kind: 'received'; result: RestoreResult }
  | { kind: 'timeout' }
  | { kind: 'failed'; message: string };

export interface ReceiveOptions {
  repository: DraftRepository;
  host?: ReceiverHost;
  appOrigin?: string;
  legacyOrigin?: string;
  timeoutMs?: number;
}

/**
 * One receipt per page, however many times it is asked for — React StrictMode runs an effect twice,
 * and two restores would put every diagram in the Library twice. A second call gets the first's promise.
 */
const receipts = new WeakMap<object, Promise<ReceiveOutcome>>();

/** Whether this page was opened by the old address to receive its Library. */
export function receivesHandoff(host: Pick<ReceiverHost, 'location'>, appOrigin: string = PRODUCT.web.appOrigin): boolean {
  return host.location.origin === appOrigin && host.location.hash === HANDOFF_HASH;
}

export function receiveDiagrams(options: ReceiveOptions): Promise<ReceiveOutcome> {
  const host = options.host ?? (window as unknown as ReceiverHost);
  const appOrigin = options.appOrigin ?? PRODUCT.web.appOrigin;
  if (!receivesHandoff(host, appOrigin)) return receipts.get(host) ?? Promise.resolve({ kind: 'none' });
  const pending = receipts.get(host);
  if (pending) return pending;
  const receipt = receive(host, { ...options, appOrigin });
  receipts.set(host, receipt);
  return receipt;
}

async function receive(host: ReceiverHost, options: ReceiveOptions & { appOrigin: string }): Promise<ReceiveOutcome> {
  const { repository, legacyOrigin = PRODUCT.web.legacyOrigin, timeoutMs = TRANSFER_TIMEOUT_MS } = options;
  // Leaves `#handoff` behind once it has been answered, so a reload doesn't wait for a tab that has
  // moved on — and only that: anything the address has gained since stays.
  const clearHash = () => {
    if (host.location.hash !== HANDOFF_HASH) return;
    host.history.replaceState(host.history.state, '', `${host.location.pathname}${host.location.search}`);
  };
  const opener = host.opener;
  if (!opener) {
    clearHash();
    return { kind: 'no-opener' };
  }

  const payload = await new Promise<HandoffBackup | 'invalid' | 'timeout'>((resolve) => {
    const finish = (value: HandoffBackup | 'invalid' | 'timeout') => {
      host.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== legacyOrigin || event.source !== opener || !isEnvelope(event.data)) return;
      if (event.data.step !== 'backup') return;
      // One of ours, from the right tab, claiming to be the backup: it is the one payload accepted,
      // well-formed or not.
      finish(parseHandoff(event.data, 'backup') ?? 'invalid');
    };
    host.addEventListener('message', onMessage);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      opener.postMessage(envelope('ready'), legacyOrigin);
    } catch {
      finish('timeout');
    }
  });

  if (payload === 'timeout') {
    clearHash();
    return { kind: 'timeout' };
  }
  const answer = (ack: Omit<HandoffAck, keyof Envelope<'ack'>>) => {
    try {
      opener.postMessage({ ...envelope('ack'), ...ack } satisfies HandoffAck, legacyOrigin);
    } catch {
      // The old tab has gone; this side's outcome stands regardless.
    }
  };

  let outcome: ReceiveOutcome;
  if (payload === 'invalid') {
    outcome = { kind: 'failed', message: 'What arrived was not a Draft Canvas Library.' };
  } else {
    try {
      outcome = { kind: 'received', result: await restoreBackup(repository, new Uint8Array(payload.bytes)) };
    } catch (error) {
      outcome = { kind: 'failed', message: error instanceof Error ? error.message : 'The diagrams could not be read.' };
    }
  }
  if (outcome.kind === 'received') {
    const { restored, renamed, skipped } = outcome.result;
    answer({ restored, renamed, skipped: skipped.length });
  } else if (outcome.kind === 'failed') {
    answer({ restored: 0, renamed: 0, skipped: 0, error: outcome.message });
  }
  clearHash();
  return outcome;
}
