#!/usr/bin/env node
// The live-collaboration relay for local development and the e2e suite: the same contract as
// relay.draftcanvas.dev (www/cloudflare/relay.js), with the same rules (www/cloudflare/relay-room.js),
// on a plain node:http server with no dependencies.
//
//   node scripts/dev-relay.mjs [--port 8791] [--host 127.0.0.1]
//
// `--port 0` picks a free port. Prints `relay listening on <port>` once it accepts connections.
// Pages on http://localhost:* and http://127.0.0.1:* may connect, besides ALLOWED_ORIGINS (or the
// production defaults). Like the production relay, it keeps nothing and logs nothing about rooms.
//
// The WebSocket side is RFC 6455 written out by hand: the handshake, masked client frames, 7-, 16-
// and 64-bit lengths, and text, close, ping and pong. Fragmented messages and extensions are not
// supported — no client of the relay sends a 17 KB frame in pieces — and are refused.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  CLOSE,
  LIMITS,
  PROTOCOL,
  admission,
  checkOwner,
  checkRequest,
  connectionAllowed,
  closePeer,
  deadline,
  departed,
  live,
  openState,
  opened,
  parseOrigins,
  received,
  secretDigest,
  sweep,
  uniqueGuestTag,
} from '../www/cloudflare/relay-room.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY = /^[A-Za-z0-9+/]{22}==$/;
/** A text frame's UTF-8 can take up to three bytes per character the rules count. */
const MAX_TEXT_BYTES = LIMITS.maxFrame * 3;
/** How long a closing socket waits for the client's close frame before it is cut off. */
const CLOSE_GRACE_MS = 2000;

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = length;
  } else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code, reason = '') {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

const sendable = (code) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** One accepted WebSocket: the frame reader, and the `Peer` the room rules talk to. */
class Connection {
  /** @param {import('node:net').Socket} socket */
  constructor(socket, room, head, relay) {
    this.socket = socket;
    this.room = room;
    this.relay = relay;
    this.state = null;
    this.buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    this.closing = false;
    this.ended = false;
    this.timer = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    // http.Server allows half-open sockets; a client that stops sending is gone all the same.
    socket.on('end', () => this.end());
    socket.on('error', () => this.end());
    socket.on('close', () => this.end());
  }

  // ── Peer ────────────────────────────────────────────────────────────────────────────────────────
  read() {
    return this.state;
  }

  write(state) {
    this.state = state;
  }

  send(text) {
    if (this.closing || this.ended) return;
    // A client that never reads must not grow this process without end.
    if (this.socket.writableLength > MAX_BUFFERED_BYTES) return this.fail(CLOSE.congested.code, CLOSE.congested.reason);
    this.socket.write(frame(OP.text, Buffer.from(text, 'utf8')));
  }

  close(code, reason) {
    if (this.closing || this.ended) return;
    this.closing = true;
    this.socket.write(frame(OP.close, closePayload(code, reason)));
    this.timer = setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS);
    this.timer.unref();
  }

  // ── Frames ──────────────────────────────────────────────────────────────────────────────────────
  /** A protocol error: tell the room the socket is gone, then close it with `code`. */
  fail(code, reason) {
    this.buffer = Buffer.alloc(0);
    // A socket refused at the door has no state and is already closing.
    if (!this.state) return this.close(code, reason);
    closePeer(this.relay.peers(this.room), this, { code, reason });
  }

  drain() {
    while (!this.ended) {
      const buffer = this.buffer;
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const rsv = buffer[0] & 0x70;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (rsv !== 0 || !masked) return this.fail(1002, 'protocol');
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) return this.fail(1002, 'protocol');
      if (!control && (!fin || opcode === OP.continuation)) return this.fail(1003, 'fragmented');
      if (![OP.text, OP.binary, OP.close, OP.ping, OP.pong].includes(opcode)) return this.fail(1002, 'protocol');
      // Refused on the header alone, before a byte of the payload is buffered.
      if (opcode === OP.binary) return this.fail(CLOSE.binary.code, CLOSE.binary.reason);
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const long = buffer.readBigUInt64BE(2);
        if (long > BigInt(MAX_TEXT_BYTES)) return this.fail(CLOSE.tooLarge.code, CLOSE.tooLarge.reason);
        length = Number(long);
        offset = 10;
      }
      if (length > MAX_TEXT_BYTES) return this.fail(CLOSE.tooLarge.code, CLOSE.tooLarge.reason);
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = buffer.subarray(offset + 4 + length);
      this.handle(opcode, payload);
    }
  }

  handle(opcode, payload) {
    if (opcode === OP.ping) {
      // Pings cost a write each, so they are budgeted too, and answered only while the client reads.
      const now = Date.now();
      this.pings = (this.pings ?? []).filter((at) => at > now - PING_WINDOW_MS);
      if (this.pings.length >= MAX_PINGS) return this.fail(CLOSE.rate.code, CLOSE.rate.reason);
      this.pings.push(now);
      if (this.socket.writableLength > MAX_BUFFERED_BYTES) return this.fail(CLOSE.congested.code, CLOSE.congested.reason);
      if (!this.closing) this.socket.write(frame(OP.pong, payload));
    } else if (opcode === OP.close) {
      this.closeReceived(payload);
    } else if (opcode === OP.text) {
      if (this.closing) return;
      let text;
      try {
        text = utf8.decode(payload);
      } catch {
        return this.fail(1007, 'utf-8');
      }
      received(this.relay.peers(this.room), this, text, Date.now());
    }
    // A pong needs nothing.
  }

  closeReceived(payload) {
    if (this.closing) {
      // The client answered our close: the handshake is complete.
      this.socket.end();
      return;
    }
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
    departed(this.relay.peers(this.room), this);
    this.closing = true;
    this.socket.end(frame(OP.close, closePayload(sendable(code) ? code : 1000)));
  }

  end() {
    if (this.ended) return;
    if (this.state) departed(this.relay.peers(this.room), this);
    this.ended = true;
    clearTimeout(this.timer);
    this.relay.forget(this.room, this);
    this.socket.destroy();
  }
}

function writeResponse(socket, status, text, body = '', headers = {}) {
  const lines = [`HTTP/1.1 ${status} ${text}`, 'Connection: close', 'Cache-Control: no-store', `Content-Length: ${Buffer.byteLength(body)}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

/** Bytes queued for one client before it counts as not reading, and is closed. */
const MAX_BUFFERED_BYTES = 256 * 1024;
/** Pings one client may send per window. */
const MAX_PINGS = 30;
const PING_WINDOW_MS = 10_000;

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 426: 'Upgrade Required', 429: 'Too Many Requests' };

/**
 * Starts a relay. Resolves once it is listening, with its port and a `close()` that ends every
 * room. Exported so a test or harness can run one in-process; the CLI below is a thin wrapper.
 */
export function startRelay({ port = 8791, host = '127.0.0.1', origins = parseOrigins(process.env.ALLOWED_ORIGINS) } = {}) {
  /** @type {Map<string, Set<Connection>>} */
  const rooms = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const sweeps = new Map();

  const relay = {
    peers: (room) => [...(rooms.get(room) ?? [])].filter((connection) => connection.state && !connection.closing && !connection.ended),
    forget(room, connection) {
      const members = rooms.get(room);
      if (!members) return;
      members.delete(connection);
      if (members.size > 0) return;
      rooms.delete(room);
      clearTimeout(sweeps.get(room));
      sweeps.delete(room);
    },
  };

  /** Looks at the room again when it could next go idle or expire, as the Durable Object's alarm does. */
  function schedule(room) {
    clearTimeout(sweeps.get(room));
    sweeps.delete(room);
    const next = deadline(relay.peers(room));
    if (next === null) return;
    const timer = setTimeout(() => {
      if (sweep(relay.peers(room), Date.now()) !== null) schedule(room);
    }, Math.max(0, next - Date.now()));
    timer.unref();
    sweeps.set(room, timer);
  }

  const verdictOf = (request, upgrade) =>
    checkRequest(
      { method: request.method, url: request.url, upgrade, origin: request.headers.origin, protocols: request.headers['sec-websocket-protocol'] },
      { origins, loopback: true },
    );
  /** Each room's owner claim — the digest of its first host's secret — as the Durable Object stores it. */
  const claims = new Map();
  /** Recent connection times per client address, for `connectionAllowed`. */
  const connections = new Map();

  const server = createServer((request, response) => {
    const verdict = verdictOf(request, request.headers.upgrade);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (verdict.kind === 'health') {
      response.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('ok');
    } else if (verdict.kind === 'reject') {
      response.writeHead(verdict.status, { ...headers, ...verdict.headers }).end(verdict.body);
    } else {
      // An upgrade request is handled by 'upgrade'; this is a plain request that claimed one.
      response.writeHead(426, { ...headers, upgrade: 'websocket', 'content-type': 'text/plain; charset=utf-8' }).end('websocket upgrade required\n');
    }
  });

  server.on('upgrade', async (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    const verdict = verdictOf(request, request.headers.upgrade);
    if (verdict.kind === 'health') return writeResponse(socket, 426, STATUS_TEXT[426], 'websocket upgrade not served here\n');
    if (verdict.kind === 'reject') {
      return writeResponse(socket, verdict.status, STATUS_TEXT[verdict.status] ?? 'Error', verdict.body, verdict.headers);
    }
    if (!connectionAllowed(connections, socket.remoteAddress ?? 'unknown', Date.now())) {
      return writeResponse(socket, 429, STATUS_TEXT[429], 'too many connections\n', { 'Retry-After': '60' });
    }
    const key = request.headers['sec-websocket-key'];
    if (request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !KEY.test(key)) {
      return writeResponse(socket, 400, STATUS_TEXT[400], 'bad websocket handshake\n', { 'Sec-WebSocket-Version': '13' });
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const { room, role, secret } = verdict;
    const digest = secret ? await secretDigest(secret) : null;
    // No extension is negotiated (permessage-deflate included), so every frame arrives as sent.
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, `Sec-WebSocket-Protocol: ${PROTOCOL}`, '', ''].join('\r\n'),
    );

    const connection = new Connection(socket, room, head, relay);
    const peers = relay.peers(room);
    let refused = admission(peers, role);
    if (!refused && role === 'host') {
      const owner = checkOwner(claims.get(room) ?? null, digest, Date.now());
      if (owner.verdict === 'claim') claims.set(room, owner.claim);
      else if (owner.verdict === 'not-owner') refused = CLOSE.notOwner;
    }
    if (refused) {
      connection.close(refused.code, refused.reason);
      return;
    }
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(connection);
    connection.write(openState(peers, role, role === 'guest' ? uniqueGuestTag(peers) : null, Date.now()));
    opened(relay.peers(room), connection);
    schedule(room);
    connection.drain();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            // Everyone goes at once, as when a room is swept: nobody is told about anybody else.
            for (const members of rooms.values()) {
              const peers = live([...members].filter((connection) => connection.state));
              for (const peer of peers) peer.write({ ...peer.read(), gone: true });
              for (const peer of peers) peer.close(1001, 'going-away');
            }
            for (const timer of sweeps.values()) clearTimeout(timer);
            // Resolves once every socket has finished its closing handshake or been cut off.
            server.close(() => done());
          }),
      });
    });
  });
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const port = Number(option(args, '--port', '8791'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('dev-relay: --port must be a whole number from 0 to 65535');
    process.exit(2);
  }
  const relay = await startRelay({ port, host: option(args, '--host', '127.0.0.1') }).catch((error) => {
    console.error(`dev-relay: ${error.message}`);
    process.exit(1);
  });
  console.log(`relay listening on ${relay.port}`);
  const stop = () => relay.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
