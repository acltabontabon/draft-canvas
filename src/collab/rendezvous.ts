/**
 * Knocking: how someone holding a session link asks the owner to let them in, and how the owner's
 * answer reaches only them — through a relay that can read none of it.
 *
 * A session link (`#join=2.<room>.<secret>`) carries two random values in its fragment, which never
 * leaves the browser: a room id for the relay to route by, and a 256-bit secret. Every message is
 * sealed with AES-GCM under a key derived from that secret, so the relay sees only ciphertext, and
 * someone who never had the link can't knock at all.
 *
 * Everyone with the link shares that key, though, so it can't keep one knocker's connection from
 * another. Each knock therefore brings a fresh ECDH public key, and the owner answers it with one of
 * its own: the connection offer and its answer are sealed again under the key those two derive, so
 * only the person whose knock was allowed can read the offer, and only they can answer it. Another
 * link holder watching the room can't take an approval meant for someone else.
 *
 * Every message names its direction in the AEAD's associated data, so one can't be reflected back
 * at its sender. Nothing here touches the network; `transport/relay.ts` carries the sealed text.
 *
 * Knowing the room key is not knowing who the owner is, though: anyone with the link could connect
 * to the relay as the room's host while the owner's own connection is down, and greet knockers as
 * if they were the owner. So the owner also holds an ECDSA signing key made when the session starts,
 * and the link carries a fingerprint of its public half. The owner signs each greeting — binding the
 * knocker's key and the owner's key for that knock — and a knocker trusts no greeting whose key
 * doesn't match the link's fingerprint. Everything after the greeting rides the pair key the signed
 * greeting set up, so an impostor can't offer, refuse or end anything either.
 */
import { readName } from './protocol';

export const SESSION_PREFIX = '2.';
const ROOM_BYTES = 16;
const SECRET_BYTES = 32;
/** A sealed message larger than this is not one of ours. */
const MAX_SEALED = 12_000;

export interface SessionLink {
  /** 22 base64url characters: what the relay routes by. */
  room: string;
  /** 43 base64url characters: what every message is sealed with. Never sent anywhere. */
  secret: string;
  /** 43 base64url characters: the SHA-256 of the owner's signing key — who may greet knockers. */
  owner: string;
}

/** The owner's signing key for one session: its public half travels in greetings, its fingerprint in the link. */
export interface OwnerIdentity {
  publicKey: string;
  fingerprint: string;
  sign(data: string): Promise<string>;
}

export async function newOwnerIdentity(): Promise<OwnerIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: toBase64Url(raw),
    fingerprint: toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource))),
    async sign(data) {
      return toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, ENCODER.encode(data))));
    },
  };
}

/** Whether `publicKey` is the owner the link names, and signed `data`. */
export async function verifyOwner(link: SessionLink, publicKey: string, data: string, signature: string): Promise<boolean> {
  try {
    const raw = fromBase64Url(publicKey);
    if (raw.length !== 65) return false;
    const fingerprint = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource)));
    if (fingerprint !== link.owner) return false;
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature) as BufferSource, ENCODER.encode(data));
  } catch {
    return false;
  }
}

/** What an owner's greeting signs: this room, this knocker's key, the owner's key for this knock, and the name the owner gives. */
export function greetingStatement(link: SessionLink, knockerKey: string, ownerExchangeKey: string, ownerName: string): string {
  return `draft-canvas greeting v1|${link.room}|${knockerKey}|${ownerExchangeKey}|${ownerName}`;
}

/**
 * A returning collaborator's proof that the place they name is theirs: an HMAC, keyed with that
 * place's private resume key (given to them alone in `welcome`), over this room and this knock's
 * fresh public key — so it can't be made without the key, or replayed into another knock.
 */
export async function returningProof(resumeKey: string, link: SessionLink, knockerKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', ENCODER.encode(resumeKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, ENCODER.encode(`draft-canvas returning v1|${link.room}|${knockerKey}`));
  return toBase64Url(new Uint8Array(mac));
}

/**
 * Proof of a place's resume key over one connection, by `side`: the collaborator's that the place is
 * theirs, the owner's that it is the session they left. Over the connection's `binding` (the owner's
 * certificate, which the browser checks), so the key itself never crosses a connection — one opened
 * by someone else's invite learns nothing it could use — and a proof made for one is no use on another.
 */
export async function resumeProof(resumeKey: string, side: 'guest' | 'owner', session: string, binding: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', ENCODER.encode(resumeKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, ENCODER.encode(`draft-canvas resume v1|${side}|${session}|${binding}`));
  return toBase64Url(new Uint8Array(mac));
}

/** Compares two strings in time that doesn't depend on where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function newSessionLink(owner: OwnerIdentity): SessionLink {
  return { room: toBase64Url(randomBytes(ROOM_BYTES)), secret: toBase64Url(randomBytes(SECRET_BYTES)), owner: owner.fingerprint };
}

export function sessionPayload(link: SessionLink): string {
  return `${SESSION_PREFIX}${link.room}.${link.secret}.${link.owner}`;
}

/** The session link a `#join=` payload names, or `null` when it is something else (a direct invite, a LAN link). */
export function readSessionPayload(payload: string): SessionLink | null {
  const match = /^2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(payload);
  return match ? { room: match[1]!, secret: match[2]!, owner: match[3]! } : null;
}

/** Whether this page can knock or host one: sealing needs the platform's crypto, a secure context. */
export function rendezvousAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === 'function';
}

/* ------------------------------------------------------------------- keys -- */

export type Direction = 'to-host' | 'to-guest';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export async function roomKey(link: SessionLink): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', fromBase64Url(link.secret) as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ENCODER.encode(link.room), info: ENCODER.encode('draft-canvas room v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface Exchange {
  /** This side's public key, as it travels (base64url, uncompressed P-256 point). */
  publicKey: string;
  /** The key this side and the holder of `theirs` share. */
  pairWith(theirs: string, link: SessionLink): Promise<CryptoKey>;
}

export async function newExchange(): Promise<Exchange> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return {
    publicKey,
    async pairWith(theirs, link) {
      const raw = fromBase64Url(theirs);
      if (raw.length !== 65) throw new Error('Not a public key.');
      const other = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, pair.privateKey, 256);
      const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      // Both public keys in the derivation, in a fixed order, bind the key to exactly this pair.
      const [first, second] = [publicKey, theirs].sort();
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: ENCODER.encode(`${link.room}.${first}.${second}`), info: ENCODER.encode('draft-canvas knock v1') },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    },
  };
}

/* -------------------------------------------------------------- envelopes -- */

export async function seal(key: CryptoKey, direction: Direction, value: unknown): Promise<string> {
  const iv = randomBytes(12);
  const plain = ENCODER.encode(JSON.stringify(value));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: ENCODER.encode(direction) }, key, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

/** The value sealed in `text`, or `null` for anything that doesn't open — wrong key, wrong direction, tampered, too big. */
export async function unseal(key: CryptoKey, direction: Direction, text: string): Promise<unknown> {
  if (typeof text !== 'string' || text.length > MAX_SEALED || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    // Inside: some lengths are not base64 at all, and decoding them throws.
    const bytes = fromBase64Url(text);
    if (bytes.length < 12 + 16) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) as BufferSource, additionalData: ENCODER.encode(direction) },
      key,
      bytes.slice(12) as BufferSource,
    );
    return JSON.parse(DECODER.decode(plain), (k, v: unknown) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- messages -- */

/** Guest → owner, sealed with the room key. */
export interface Knock {
  t: 'knock';
  name: string;
  publicKey: string;
  /** Coming back after a drop: the place they had, and `returningProof` that it is theirs. */
  returning?: { peer: string; proof: string };
}

/**
 * Owner → guest, sealed with the room key: the knock arrived, and here is the owner's half of the
 * pair — signed (`greetingStatement`) by the signing key the link's fingerprint names.
 */
export interface Seen {
  t: 'seen';
  owner: string;
  publicKey: string;
  ownerKey: string;
  signature: string;
}

/** Owner → guest: the connection offer, sealed again with the pair key inside. */
export interface Offer {
  t: 'offer';
  box: string;
}

/** Owner → guest: turned away, or the session is over — pair-sealed, so only the greeting's owner can say it. */
export interface Closed {
  t: 'closed';
  box: string;
}

/** Guest → owner: the answer, sealed with the pair key. */
export interface Answer {
  t: 'answer';
  box: string;
}

export type ToHost = Knock | Answer | { t: 'cancel' };
/**
 * `busy`: the door is full, try again shortly. Sealed with the room key only, so not proof it came
 * from the owner — but the relay lets no one else address a guest, and it can already drop a knock.
 */
export type ToGuest = Seen | Offer | Closed | { t: 'busy' };

const KEY = /^[A-Za-z0-9_-]{87}$/;
/** A P-256 ECDSA signature as WebCrypto writes it: 64 bytes, IEEE P1363. */
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const BOX = /^[A-Za-z0-9_-]{40,11000}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readToHost(value: unknown): ToHost | null {
  if (!isRecord(value)) return null;
  if (value.t === 'knock') {
    const name = readName(value.name);
    if (!name || typeof value.publicKey !== 'string' || !KEY.test(value.publicKey)) return null;
    const knock: Knock = { t: 'knock', name, publicKey: value.publicKey };
    if (value.returning !== undefined) {
      const returning = value.returning;
      if (!isRecord(returning) || typeof returning.peer !== 'string' || returning.peer.length > 64) return null;
      if (typeof returning.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(returning.proof)) return null;
      knock.returning = { peer: returning.peer, proof: returning.proof };
    }
    return knock;
  }
  if (value.t === 'answer') return typeof value.box === 'string' && BOX.test(value.box) ? { t: 'answer', box: value.box } : null;
  if (value.t === 'cancel') return { t: 'cancel' };
  return null;
}

export function readToGuest(value: unknown): ToGuest | null {
  if (!isRecord(value)) return null;
  if (value.t === 'seen') {
    const owner = readName(value.owner);
    if (!owner || typeof value.publicKey !== 'string' || !KEY.test(value.publicKey)) return null;
    if (typeof value.ownerKey !== 'string' || !KEY.test(value.ownerKey)) return null;
    if (typeof value.signature !== 'string' || !SIGNATURE.test(value.signature)) return null;
    return { t: 'seen', owner, publicKey: value.publicKey, ownerKey: value.ownerKey, signature: value.signature };
  }
  if (value.t === 'offer') return typeof value.box === 'string' && BOX.test(value.box) ? { t: 'offer', box: value.box } : null;
  if (value.t === 'closed') return typeof value.box === 'string' && BOX.test(value.box) ? { t: 'closed', box: value.box } : null;
  if (value.t === 'busy') return { t: 'busy' };
  return null;
}

/* ---------------------------------------------------------------- base64 -- */

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
