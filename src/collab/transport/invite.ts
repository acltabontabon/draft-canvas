import { Inflate, deflateSync } from 'fflate';

/**
 * Invites and reply codes: the manual, serverless signaling for a WebRTC session.
 *
 * The owner's invite link carries their SDP offer in its fragment (`#join=1.<payload>`), the same
 * way `share/link.ts` carries a diagram: a fragment never reaches the server that serves the app.
 * The collaborator answers with a reply code they send back by hand, so it has to be short.
 *
 * A browser's SDP is mostly boilerplate a DataChannel-only session does not need. What survives is
 * exactly what rebuilds a valid one — ICE ufrag and password, the DTLS fingerprint and setup role,
 * the media id, the SCTP port and max message size, and the gathered candidates — packed into
 * bytes (an ICE string is six bits a character, an IP four or sixteen bytes, an mDNS name sixteen),
 * deflated with fflate when that is shorter, and base64url-encoded.
 *
 * Both codes carry the same 128-bit random nonce, so a reply only fits the invite it answers, and
 * the invite says when it was issued and how long it lives (30 minutes). Decoding is strict and
 * bounded: every read is range-checked, sizes are capped before anything is inflated, and every
 * failure is a `CollabCodeError` with a reason the UI can show.
 *
 * `1.` is the format version, as in share links: a later encoding changes the prefix, so a reader
 * can tell the two apart instead of failing on a payload it was never meant to understand.
 */

export const INVITE_PARAM = 'join';
export const CODE_VERSION = 1;
const PREFIX = `${CODE_VERSION}.`;
export const NONCE_BYTES = 16;
export const INVITE_LIFETIME_MS = 30 * 60 * 1000;
/** How far the collaborator's clock may run ahead of the owner's before a fresh invite reads as expired.
 *  The owner checks the reply against their own clock, so this tolerance never extends an invite. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_INVITE_CHARS = 4096;
export const MAX_REPLY_CHARS = 2048;
/** The largest packed body either code may inflate to. A real one is a few hundred bytes. */
const MAX_BODY_BYTES = 4096;
const MAX_CANDIDATES = 16;

export type CollabCodeReason = 'expired' | 'mismatch' | 'malformed' | 'unsupported';

const MESSAGES: Record<CollabCodeReason, string> = {
  expired: 'This invite has expired. Ask for a new one.',
  mismatch: 'This reply code belongs to a different invite.',
  malformed: 'This code is damaged — part of it may have been lost when it was copied.',
  unsupported: 'This code was made by a different version of Draft Canvas. Update both and try again.',
};

export class CollabCodeError extends Error {
  readonly reason: CollabCodeReason;
  constructor(reason: CollabCodeReason, message = MESSAGES[reason]) {
    super(message);
    this.name = 'CollabCodeError';
    this.reason = reason;
  }
}

// --- The compact session description -------------------------------------------------------------

export type HashAlgorithm = 'sha-1' | 'sha-224' | 'sha-256' | 'sha-384' | 'sha-512';
export type DtlsSetup = 'actpass' | 'active' | 'passive';
export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type TcpType = 'active' | 'passive' | 'so';

export interface CompactCandidate {
  type: CandidateType;
  protocol: 'udp' | 'tcp';
  tcpType?: TcpType;
  priority: number;
  address: string;
  port: number;
}

export interface CompactSdp {
  ufrag: string;
  pwd: string;
  fingerprint: { algorithm: HashAlgorithm; bytes: Uint8Array };
  setup: DtlsSetup;
  mid: string;
  sctpPort: number;
  /** 0 when the description named none. */
  maxMessageSize: number;
  candidates: CompactCandidate[];
}

/** A DTLS fingerprint as one line of text, the same at both ends of the connection it names. */
export function fingerprintText(fingerprint: CompactSdp['fingerprint']): string {
  return `${fingerprint.algorithm} ${Array.from(fingerprint.bytes, (byte) => byte.toString(16).padStart(2, '0')).join(':')}`;
}

const HASHES: [HashAlgorithm, number][] = [['sha-1', 20], ['sha-224', 28], ['sha-256', 32], ['sha-384', 48], ['sha-512', 64]];
const SETUPS: DtlsSetup[] = ['actpass', 'active', 'passive'];
const CANDIDATE_TYPES: CandidateType[] = ['host', 'srflx', 'prflx', 'relay'];
const TCP_TYPES: TcpType[] = ['active', 'passive', 'so'];
/** RFC 8839's ice-char is exactly the base64 alphabet, which is what lets it pack into six bits. */
const ICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MID_PATTERN = /^[A-Za-z0-9_.~-]{1,32}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const MDNS_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

/**
 * The parts of a browser's offer or answer that a DataChannel session needs. Attributes may sit at
 * session or media level (Firefox puts the fingerprint at session level); only the first
 * `application` section counts. Throws `CollabCodeError('unsupported')` for a description this
 * format cannot carry — that is a local problem, never the other side's input.
 */
export function compactSdp(sdp: string): CompactSdp {
  const lines = sdp.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const session = new Map<string, string[]>();
  const media = new Map<string, string[]>();
  let section: 'session' | 'application' | 'other' = 'session';
  let found = false;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      section = !found && /^m=application \d+ (UDP\/)?DTLS\/SCTP webrtc-datachannel$/.test(line) ? 'application' : 'other';
      found ||= section === 'application';
      continue;
    }
    if (!line.startsWith('a=') || section === 'other') continue;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line.slice(2) : line.slice(2, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);
    const target = section === 'session' ? session : media;
    target.set(name, [...(target.get(name) ?? []), value]);
  }
  if (!found) throw unsupported('no data channel section');
  const attr = (name: string) => media.get(name)?.[0] ?? session.get(name)?.[0];

  const ufrag = attr('ice-ufrag');
  const pwd = attr('ice-pwd');
  if (!ufrag || !pwd || !isIceString(ufrag, 4) || !isIceString(pwd, 22)) throw unsupported('ICE credentials');

  const fingerprints = [...(media.get('fingerprint') ?? []), ...(session.get('fingerprint') ?? [])];
  const parsed = fingerprints.map(parseFingerprint).filter((value) => value !== null);
  const fingerprint = parsed.find((value) => value.algorithm === 'sha-256') ?? parsed[0];
  if (!fingerprint) throw unsupported('DTLS fingerprint');

  const setup = attr('setup');
  if (!SETUPS.includes(setup as DtlsSetup)) throw unsupported('DTLS setup');
  const mid = attr('mid') ?? '0';
  if (!MID_PATTERN.test(mid)) throw unsupported('media id');
  const sctpPort = Number(attr('sctp-port') ?? 5000);
  if (!Number.isInteger(sctpPort) || sctpPort < 1 || sctpPort > 0xffff) throw unsupported('SCTP port');
  const rawSize = attr('max-message-size');
  const maxMessageSize = rawSize === undefined ? 0 : Number(rawSize);
  if (!Number.isInteger(maxMessageSize) || maxMessageSize < 0 || maxMessageSize > 0xffffffff) throw unsupported('max message size');

  const candidates = (media.get('candidate') ?? [])
    .map(parseCandidate)
    .filter((candidate) => candidate !== null)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_CANDIDATES);
  return { ufrag, pwd, fingerprint, setup: setup as DtlsSetup, mid, sctpPort, maxMessageSize, candidates };
}

/**
 * A valid SDP for `compact`. Foundations are renumbered (they only group candidates, and unique
 * ones are always correct), and non-host candidates carry the masked related address browsers
 * already send. The description is complete: candidates were gathered before it was encoded.
 */
export function expandSdp(compact: CompactSdp, sessionId = '1'): string {
  const lines = [
    'v=0',
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${compact.mid}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...compact.candidates.map((candidate, index) => `a=candidate:${candidateLine(candidate, index + 1)}`),
    'a=end-of-candidates',
    `a=ice-ufrag:${compact.ufrag}`,
    `a=ice-pwd:${compact.pwd}`,
    `a=fingerprint:${compact.fingerprint.algorithm} ${[...compact.fingerprint.bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')}`,
    `a=setup:${compact.setup}`,
    `a=mid:${compact.mid}`,
    `a=sctp-port:${compact.sctpPort}`,
    ...(compact.maxMessageSize ? [`a=max-message-size:${compact.maxMessageSize}`] : []),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function candidateLine(candidate: CompactCandidate, foundation: number): string {
  let line = `${foundation} 1 ${candidate.protocol} ${candidate.priority} ${candidate.address} ${candidate.port} typ ${candidate.type}`;
  if (candidate.type !== 'host') line += ' raddr 0.0.0.0 rport 0';
  if (candidate.tcpType) line += ` tcptype ${candidate.tcpType}`;
  return line;
}

function unsupported(detail: string): CollabCodeError {
  return new CollabCodeError('unsupported', `This browser described the connection in a way Draft Canvas cannot carry (${detail}).`);
}

function isIceString(value: string, min: number): boolean {
  return value.length >= min && value.length <= 255 && [...value].every((char) => ICE_CHARS.includes(char));
}

function parseFingerprint(value: string): CompactSdp['fingerprint'] | null {
  const [name, hex] = value.trim().split(/\s+/);
  const entry = HASHES.find(([algorithm]) => algorithm === name?.toLowerCase());
  if (!entry || !hex || !/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2})*$/.test(hex)) return null;
  const bytes = Uint8Array.from(hex.split(':'), (pair) => parseInt(pair, 16));
  return bytes.length === entry[1] ? { algorithm: entry[0], bytes } : null;
}

/**
 * `sdp` without the candidates an invite would never carry — a DNS name for the browser to look up,
 * anything unreadable. For the descriptions that travel outside an invite: an ICE restart's, which
 * the other side writes and this side's browser would otherwise act on as given.
 */
export function withSafeCandidates(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('a=candidate:') || parseCandidate(line.slice('a=candidate:'.length)) !== null)
    .join('\r\n');
}

/** `candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...` */
function parseCandidate(value: string): CompactCandidate | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  // Bundled, rtcp-muxed data channels use component 1 only.
  if (parts[1] !== '1') return null;
  const protocol = parts[2]!.toLowerCase();
  if (protocol !== 'udp' && protocol !== 'tcp') return null;
  const priority = Number(parts[3]);
  const port = Number(parts[5]);
  const type = parts[7] as CandidateType;
  if (!Number.isInteger(priority) || priority < 0 || priority > 0xffffffff) return null;
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) return null;
  if (!CANDIDATE_TYPES.includes(type)) return null;
  const address = parts[4]!;
  // A browser offers only IP addresses and mDNS names; a DNS name would have the other side's browser
  // look it up, telling whoever runs that name's server it is there.
  const kind = addressKind(address);
  if (kind === null || kind === 'hostname' || !reachable(address)) return null;
  let tcpType: TcpType | undefined;
  for (let i = 8; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'tcptype' && TCP_TYPES.includes(parts[i + 1] as TcpType)) tcpType = parts[i + 1] as TcpType;
  }
  if (protocol === 'tcp' && !tcpType) return null;
  return { type, protocol, ...(protocol === 'tcp' ? { tcpType } : {}), priority, address: normalizeAddress(address), port };
}

// --- Addresses ------------------------------------------------------------------------------------

type AddressKind = 'ipv4' | 'ipv6' | 'mdns' | 'hostname';
const ADDRESS_KINDS: AddressKind[] = ['ipv4', 'ipv6', 'mdns', 'hostname'];

function addressKind(address: string): AddressKind | null {
  if (parseIpv4(address)) return 'ipv4';
  if (parseIpv6(address)) return 'ipv6';
  if (MDNS_PATTERN.test(address)) return 'mdns';
  if (HOSTNAME_PATTERN.test(address)) return 'hostname';
  return null;
}

/**
 * Whether a peer may be told to try `address`. Loopback, unspecified and multicast are never where a
 * peer is; IPv4 link-local is where cloud metadata services listen. A description written by the other
 * side could otherwise point this browser's connection checks — UDP and TCP — at services on this
 * very machine or network that were never part of the session.
 */
function reachable(address: string): boolean {
  const v6 = parseIpv6(address);
  if (v6) {
    if (v6.every((byte, i) => byte === (i === 15 ? 1 : 0)) || v6.every((byte) => byte === 0)) return false;
    if (v6[0] === 0xff) return false;
    // An IPv4 address written as IPv6 (`::ffff:127.0.0.1`) is held to the IPv4 rules.
    const mapped = v6.slice(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff;
    return mapped ? reachableV4(v6.slice(12)) : true;
  }
  const v4 = parseIpv4(address);
  return v4 ? reachableV4(v4) : true;
}

function reachableV4(bytes: Uint8Array): boolean {
  const [a, b] = [bytes[0]!, bytes[1]!];
  return a !== 0 && a !== 127 && !(a === 169 && b === 254) && a < 224;
}

function normalizeAddress(address: string): string {
  const v6 = parseIpv6(address);
  if (v6) return formatIpv6(v6);
  return MDNS_PATTERN.test(address) ? address.toLowerCase() : address;
}

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return Uint8Array.from(parts, Number);
}

function parseIpv6(text: string): Uint8Array | null {
  if (!text.includes(':') || text.length > 45) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (half: string): number[] | null => {
    if (half === '') return [];
    const out: number[] = [];
    const parts = half.split(':');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i === parts.length - 1 && part.includes('.')) {
        const v4 = parseIpv4(part);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...new Array<number>(missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** RFC 5952 text: lower-case, no leading zeros, the longest run of two or more zero groups as `::`. */
function formatIpv6(bytes: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) => (bytes[i * 2]! << 8) | bytes[i * 2 + 1]!);
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

// --- Bytes ----------------------------------------------------------------------------------------

/** Thrown inside the decoder only; `decodeBody` turns it into `CollabCodeError('malformed')`. */
class Truncated extends Error {}

class Writer {
  private bytes: number[] = [];
  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }
  raw(bytes: Uint8Array): void {
    for (const byte of bytes) this.bytes.push(byte);
  }
  /** Unsigned LEB128, up to 2^32 - 1. */
  varint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.bytes.push(rest);
  }
  text(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.byte(bytes.length);
    this.raw(bytes);
  }
  /** Six bits a character; the length is in characters. */
  iceString(value: string): void {
    this.byte(value.length);
    let bits = 0;
    let acc = 0;
    for (const char of value) {
      acc = (acc << 6) | ICE_CHARS.indexOf(char);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        this.bytes.push((acc >> bits) & 0xff);
        acc &= (1 << bits) - 1;
      }
    }
    if (bits > 0) this.bytes.push((acc << (8 - bits)) & 0xff);
  }
  done(): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  byte(): number {
    if (this.offset >= this.bytes.length) throw new Truncated();
    return this.bytes[this.offset++]!;
  }
  raw(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new Truncated();
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  varint(max: number): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (value > max) throw new Truncated();
      if (!(byte & 0x80)) {
        // Overlong forms (a trailing zero group) are refused so every value has one encoding.
        if (i > 0 && byte === 0) throw new Truncated();
        return value;
      }
      scale *= 0x80;
    }
    throw new Truncated();
  }
  text(): string {
    const bytes = this.raw(this.byte());
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  iceString(min: number): string {
    const length = this.byte();
    if (length < min) throw new Truncated();
    const packed = this.raw(Math.ceil((length * 6) / 8));
    let out = '';
    let acc = 0;
    let bits = 0;
    for (const byte of packed) {
      acc = (acc << 8) | byte;
      bits += 8;
      while (bits >= 6 && out.length < length) {
        bits -= 6;
        out += ICE_CHARS[(acc >> bits) & 0x3f];
        acc &= (1 << bits) - 1;
      }
    }
    // Padding bits must be zero, again so every value has one encoding.
    if (out.length !== length || acc !== 0) throw new Truncated();
    return out;
  }
}

function writeSdp(writer: Writer, sdp: CompactSdp): void {
  writer.iceString(sdp.ufrag);
  writer.iceString(sdp.pwd);
  const hashIndex = HASHES.findIndex(([algorithm]) => algorithm === sdp.fingerprint.algorithm);
  writer.byte((hashIndex << 2) | SETUPS.indexOf(sdp.setup));
  writer.raw(sdp.fingerprint.bytes);
  writer.text(sdp.mid);
  writer.varint(sdp.sctpPort);
  writer.varint(sdp.maxMessageSize);
  writer.byte(sdp.candidates.length);
  for (const candidate of sdp.candidates) {
    const kind = addressKind(candidate.address)!;
    // type (2 bits) | tcp (1) | tcptype (2) | address kind (2)
    writer.byte(
      CANDIDATE_TYPES.indexOf(candidate.type) |
        (candidate.protocol === 'tcp' ? 1 << 2 : 0) |
        ((candidate.tcpType ? TCP_TYPES.indexOf(candidate.tcpType) : 0) << 3) |
        (ADDRESS_KINDS.indexOf(kind) << 5),
    );
    writer.varint(candidate.priority);
    writer.varint(candidate.port);
    if (kind === 'ipv4') writer.raw(parseIpv4(candidate.address)!);
    else if (kind === 'ipv6') writer.raw(parseIpv6(candidate.address)!);
    else if (kind === 'mdns') writer.raw(hexBytes(MDNS_PATTERN.exec(candidate.address)!.slice(1).join('')));
    else writer.text(candidate.address);
  }
}

function readSdp(reader: Reader): CompactSdp {
  const ufrag = reader.iceString(4);
  const pwd = reader.iceString(22);
  const flags = reader.byte();
  const hash = HASHES[flags >> 2];
  const setup = SETUPS[flags & 0b11];
  if (!hash || !setup) throw new Truncated();
  const fingerprint = { algorithm: hash[0], bytes: reader.raw(hash[1]) };
  const mid = reader.text();
  if (!MID_PATTERN.test(mid)) throw new Truncated();
  const sctpPort = reader.varint(0xffff);
  if (sctpPort === 0) throw new Truncated();
  const maxMessageSize = reader.varint(0xffffffff);
  const count = reader.byte();
  if (count > MAX_CANDIDATES) throw new Truncated();
  const candidates: CompactCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const bits = reader.byte();
    const type = CANDIDATE_TYPES[bits & 0b11]!;
    const tcp = (bits >> 2) & 1;
    const tcpType = TCP_TYPES[(bits >> 3) & 0b11];
    const kind = ADDRESS_KINDS[(bits >> 5) & 0b11]!;
    if (bits >> 7 || !tcpType || (!tcp && (bits >> 3) & 0b11)) throw new Truncated();
    const priority = reader.varint(0xffffffff);
    const port = reader.varint(0xffff);
    let address: string;
    if (kind === 'ipv4') address = [...reader.raw(4)].join('.');
    else if (kind === 'ipv6') address = formatIpv6(reader.raw(16));
    else if (kind === 'mdns') {
      const hex = [...reader.raw(16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      address = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
    } else {
      // Read past, never used: see `parseCandidate`. The kind stays in the format so older codes still read.
      address = reader.text();
      if (addressKind(address) !== 'hostname') throw new Truncated();
      continue;
    }
    candidates.push({ type, protocol: tcp ? 'tcp' : 'udp', ...(tcp ? { tcpType } : {}), priority, address, port });
  }
  return { ufrag, pwd, fingerprint, setup, mid, sctpPort, maxMessageSize, candidates };
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

// --- Text -----------------------------------------------------------------------------------------

const BASE64_CHUNK = 0x8000;
const RAW = 0;
const DEFLATED = 1;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A body as text: one marker byte, then the body raw or deflated, whichever is shorter. */
function encodeBody(body: Uint8Array): string {
  const deflated = deflateSync(body, { level: 9 });
  const packed = deflated.length < body.length ? [DEFLATED, deflated] as const : [RAW, body] as const;
  const out = new Uint8Array(1 + packed[1].length);
  out[0] = packed[0];
  out.set(packed[1], 1);
  return PREFIX + toBase64Url(out);
}

function decodeBody(text: string, maxChars: number): Uint8Array {
  // People paste codes out of chat apps, which wrap long lines and add stray spaces.
  const compact = text.replace(/\s+/g, '');
  if (compact.length > maxChars) throw new CollabCodeError('malformed');
  const dot = compact.indexOf('.');
  const version = dot === -1 ? compact : compact.slice(0, dot);
  if (dot === -1 || !/^\d{1,4}$/.test(version)) throw new CollabCodeError('malformed');
  if (Number(version) !== CODE_VERSION) throw new CollabCodeError('unsupported');
  const bytes = fromBase64Url(compact.slice(dot + 1));
  if (!bytes || bytes.length < 2) throw new CollabCodeError('malformed');
  if (bytes[0] === RAW) return bytes.subarray(1);
  if (bytes[0] !== DEFLATED) throw new CollabCodeError('malformed');
  const deflated = bytes.subarray(1);
  const body = inflateBounded(deflated, MAX_BODY_BYTES);
  // A deflate stream says where it ends, and inflating ignores anything after it. Every byte must
  // be needed, so the code without its last byte has to fail; otherwise something trails the stream.
  if (!body || inflateBounded(deflated.subarray(0, -1), MAX_BODY_BYTES)) throw new CollabCodeError('malformed');
  return body;
}

/**
 * Inflates in small slices and stops at `limit`, so a hostile code — a few kilobytes that inflate
 * to megabytes — is refused before it is ever held whole. Null for anything but one complete stream.
 */
function inflateBounded(bytes: Uint8Array, limit: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  const inflater = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new RangeError('inflated past its cap');
    chunks.push(chunk);
    if (final) ended = true;
  });
  try {
    for (let offset = 0; offset < bytes.length; offset += 64) {
      inflater.push(bytes.subarray(offset, offset + 64), offset + 64 >= bytes.length);
    }
  } catch {
    return null;
  }
  if (!ended) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// --- Invites and replies --------------------------------------------------------------------------

const INVITE_KIND = 0;
const REPLY_KIND = 1;

export interface Invite {
  nonce: Uint8Array;
  /** Milliseconds, whole seconds: the code carries seconds. */
  issuedAt: number;
  expiresAt: number;
  offer: CompactSdp;
}

export function newNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/** The invite text (`1.<payload>`), and when it stops being accepted. */
export function encodeInvite(input: { nonce: Uint8Array; issuedAt: number; offer: CompactSdp }): { payload: string; expiresAt: number } {
  if (input.nonce.length !== NONCE_BYTES) throw new RangeError('An invite nonce is 16 bytes.');
  const issuedSeconds = Math.floor(input.issuedAt / 1000);
  const writer = new Writer();
  writer.byte(CODE_VERSION);
  writer.byte(INVITE_KIND);
  writer.raw(input.nonce);
  writer.varint(issuedSeconds);
  writer.varint(INVITE_LIFETIME_MS / 1000);
  writeSdp(writer, input.offer);
  return { payload: encodeBody(writer.done()), expiresAt: (issuedSeconds * 1000) + INVITE_LIFETIME_MS };
}

/** The invite `text` carries, checked against the collaborator's clock (with `CLOCK_SKEW_MS` grace). */
export function decodeInvite(text: string, now = Date.now()): Invite {
  const invite = decodeCode(text, MAX_INVITE_CHARS, INVITE_KIND, (reader) => {
    const nonce = reader.raw(NONCE_BYTES);
    const issuedSeconds = reader.varint(0xffffffff);
    const lifetimeSeconds = reader.varint(INVITE_LIFETIME_MS / 1000);
    if (lifetimeSeconds === 0) throw new Truncated();
    const offer = readSdp(reader);
    if (offer.setup !== 'actpass') throw new Truncated();
    return { nonce, issuedAt: issuedSeconds * 1000, expiresAt: (issuedSeconds + lifetimeSeconds) * 1000, offer };
  });
  if (now > invite.expiresAt + CLOCK_SKEW_MS) throw new CollabCodeError('expired');
  return invite;
}

export function encodeReply(input: { nonce: Uint8Array; answer: CompactSdp }): string {
  if (input.nonce.length !== NONCE_BYTES) throw new RangeError('An invite nonce is 16 bytes.');
  const writer = new Writer();
  writer.byte(CODE_VERSION);
  writer.byte(REPLY_KIND);
  writer.raw(input.nonce);
  writeSdp(writer, input.answer);
  return encodeBody(writer.done());
}

/**
 * The answer a reply code carries, accepted only for the invite it answers (`expected.nonce`) and
 * only while that invite is live by the owner's own clock.
 */
export function decodeReply(text: string, expected: { nonce: Uint8Array; expiresAt: number }, now = Date.now()): CompactSdp {
  const reply = decodeCode(text, MAX_REPLY_CHARS, REPLY_KIND, (reader) => {
    const nonce = reader.raw(NONCE_BYTES);
    const answer = readSdp(reader);
    if (answer.setup === 'actpass') throw new Truncated();
    return { nonce, answer };
  });
  if (!sameBytes(reply.nonce, expected.nonce)) throw new CollabCodeError('mismatch');
  if (now > expected.expiresAt) {
    throw new CollabCodeError('expired', 'The invite this reply answers has expired. Send a new invite.');
  }
  return reply.answer;
}

function decodeCode<T>(text: string, maxChars: number, kind: number, read: (reader: Reader) => T): T {
  if (typeof text !== 'string') throw new CollabCodeError('malformed');
  const reader = new Reader(decodeBody(text, maxChars));
  try {
    if (reader.byte() !== CODE_VERSION) throw new CollabCodeError('unsupported');
    const actual = reader.byte();
    if (actual !== kind) {
      if (actual === INVITE_KIND || actual === REPLY_KIND) {
        throw new CollabCodeError('mismatch', kind === REPLY_KIND ? 'That is an invite link, not a reply code.' : 'That is a reply code, not an invite link.');
      }
      throw new CollabCodeError('malformed');
    }
    const value = read(reader);
    if (reader.remaining !== 0) throw new Truncated();
    return value;
  } catch (error) {
    if (error instanceof CollabCodeError) throw error;
    throw new CollabCodeError('malformed');
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// --- Links ----------------------------------------------------------------------------------------

/** The invite payload in a fragment, or null when the address carries none. */
export function invitePayloadFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get(INVITE_PARAM);
}

/** The fragment (without `#`) that carries `payload`. */
export function inviteFragment(payload: string): string {
  return new URLSearchParams({ [INVITE_PARAM]: payload }).toString();
}
