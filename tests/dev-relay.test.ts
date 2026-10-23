// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * scripts/dev-relay.mjs on the wire: its hand-written WebSocket server, driven by Node's own
 * WebSocket client (and a raw socket for the frames no client would send). The room rules behind
 * it are tests/relay-room.test.ts's; this checks the handshake and that frames get where they go.
 */

const ROOT = join(import.meta.dirname, '..');
const ORIGIN = 'http://localhost:5180';
let relay: ChildProcess;
let port = 0;
let rooms = 0;

/** A fresh room for each test, so none can see another's sockets. */
const newRoom = () => `room${String(rooms++).padStart(18, '0')}`;

beforeAll(async () => {
  relay = spawn(process.execPath, [join(ROOT, 'scripts/dev-relay.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise<number>((resolve, reject) => {
    let output = '';
    relay.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /relay listening on (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    relay.once('exit', (code) => reject(new Error(`dev relay exited with ${code}`)));
  });
});

afterAll(async () => {
  if (relay.exitCode !== null) return;
  const exited = new Promise((resolve) => relay.once('exit', resolve));
  relay.kill('SIGTERM');
  await exited;
});

/** Node's WebSocket (undici) takes headers, which the DOM's constructor type does not know. */
type NodeWebSocket = new (url: string, init: { headers: Record<string, string>; protocols: string[] }) => WebSocket;

const PROTOCOL = 'draft-canvas.relay.v1';
/** Each room's owner secret, so a test's host is that room's owner unless it says otherwise. */
const secrets = new Map<string, string>();
const secretOf = (room: string) => {
  if (!secrets.has(room)) secrets.set(room, randomBytes(32).toString('base64url'));
  return secrets.get(room)!;
};

interface Closed {
  code: number;
  reason: string;
}

class Client {
  readonly ws: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<Closed>;
  private readonly inbox: unknown[] = [];
  private readonly waiting: Array<(message: unknown) => void> = [];

  constructor(room: string, role: string, origin = ORIGIN, secret = role === 'host' ? secretOf(room) : null) {
    this.ws = new (WebSocket as unknown as NodeWebSocket)(`ws://127.0.0.1:${port}/r/${room}?role=${role}`, {
      headers: { origin },
      protocols: secret ? [PROTOCOL, `host.${secret}`] : [PROTOCOL],
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('connection failed')));
    });
    // Awaited where a test expects the connection to fail; never an unhandled rejection elsewhere.
    this.opened.catch(() => {});
    this.closed = new Promise((resolve) => this.ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })));
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.waiting.shift();
      if (waiter) waiter(message);
      else this.inbox.push(message);
    });
  }

  static async open(room: string, role: 'host' | 'guest'): Promise<Client> {
    const client = new Client(room, role);
    await client.opened;
    return client;
  }

  next(): Promise<unknown> {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  send(to: string, data: string) {
    this.ws.send(JSON.stringify({ to, data }));
  }
}

/** An HTTP request's status, body and headers, with whatever headers the test needs to send. */
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += chunk.toString()));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, type: response.headers['content-type'] }));
    });
    req.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, body: '', type: undefined });
    });
    req.on('error', reject);
    req.end();
  });
}

const upgrade = (origin?: string, role: 'host' | 'guest' = 'host') => ({
  connection: 'Upgrade',
  upgrade: 'websocket',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-protocol': role === 'host' ? `${PROTOCOL}, host.${'S'.repeat(43)}` : PROTOCOL,
  ...(origin ? { origin } : {}),
});

describe('a room’s owner', () => {
  it('is whoever first hosted it: someone else with the room id can’t take the host’s place', async () => {
    const room = newRoom();
    const owner = await Client.open(room, 'host');
    owner.ws.close();
    await owner.closed;
    const impostor = new Client(room, 'host', ORIGIN, randomBytes(32).toString('base64url'));
    expect(await impostor.closed).toEqual({ code: 4003, reason: 'not-owner' });
    // The owner, coming back with its own secret, is let back in.
    const back = await Client.open(room, 'host');
    expect(back.ws.protocol).toBe(PROTOCOL);
    back.ws.close();
  });
});

describe('the dev relay over HTTP', () => {
  it('answers its health check', async () => {
    expect(await get('/health')).toEqual({ status: 200, body: 'ok', type: 'text/plain; charset=utf-8' });
  });

  it('refuses everything else', async () => {
    expect((await get('/')).status).toBe(400);
    expect((await get(`/r/short?role=host`, upgrade(ORIGIN))).status).toBe(400);
    expect((await get(`/r/${newRoom()}?role=host`)).status).toBe(426);
  });

  it('completes the handshake only for an allowed origin', async () => {
    const room = newRoom();
    expect((await get(`/r/${room}?role=host`, upgrade('https://evil.example'))).status).toBe(403);
    expect((await get(`/r/${room}?role=host`, upgrade())).status).toBe(403);
    expect((await get(`/r/${room}?role=host`, upgrade(ORIGIN))).status).toBe(101);
    const refused = new Client(newRoom(), 'host', 'https://evil.example');
    await expect(refused.opened).rejects.toThrow('connection failed');
  });
});

describe('the dev relay over WebSockets', () => {
  it('introduces a guest to the host and carries messages both ways', async () => {
    const room = newRoom();
    const guest = await Client.open(room, 'guest');
    expect(await guest.next()).toEqual({ event: 'host', present: false });

    const host = await Client.open(room, 'host');
    expect(await host.next()).toEqual({ event: 'ready' });
    expect(await guest.next()).toEqual({ event: 'host', present: true });

    guest.send('host', 'knock');
    const knock = (await host.next()) as { from: string; data: string };
    expect(knock.data).toBe('knock');
    expect(knock.from).toMatch(/^g_[0-9a-z]{12}$/);

    // A frame long enough for a 16-bit length, both ways.
    const offer = 'o'.repeat(16384);
    host.send(knock.from, offer);
    expect(await guest.next()).toEqual({ from: 'host', data: offer });

    guest.ws.close();
    expect(await host.next()).toEqual({ event: 'left', from: knock.from });

    const second = await Client.open(room, 'guest');
    expect(await second.next()).toEqual({ event: 'host', present: true });
    host.ws.close();
    expect(await second.next()).toEqual({ event: 'host', present: false });
    second.ws.close();
  });

  it('turns away a second host while the first is connected', async () => {
    const room = newRoom();
    const host = await Client.open(room, 'host');
    const intruder = new Client(room, 'host', ORIGIN, randomBytes(32).toString('base64url'));
    expect(await intruder.closed).toEqual({ code: 4001, reason: 'host-taken' });
    host.ws.close();
    await host.closed;
    const replacement = await Client.open(room, 'host');
    expect(await replacement.next()).toEqual({ event: 'ready' });
    replacement.ws.close();
  });

  it('lets the owner back in over a socket the relay still thinks is open, and guests hear them return', async () => {
    const room = newRoom();
    const stale = await Client.open(room, 'host');
    expect(await stale.next()).toEqual({ event: 'ready' });
    const guest = await Client.open(room, 'guest');
    expect(await guest.next()).toEqual({ event: 'host', present: true });
    // The owner's laptop slept: no close reached the relay, and the owner connects again.
    const back = await Client.open(room, 'host');
    expect(await back.next()).toEqual({ event: 'ready' });
    expect(await stale.closed).toEqual({ code: 4004, reason: 'replaced' });
    // Gone and back, so whoever was waiting knocks again.
    expect(await guest.next()).toEqual({ event: 'host', present: false });
    expect(await guest.next()).toEqual({ event: 'host', present: true });
    back.ws.close();
    guest.ws.close();
  });

  it('closes on binary frames and on frames past the size limit', async () => {
    const room = newRoom();
    const binary = await Client.open(room, 'guest');
    binary.ws.send(new Uint8Array([1, 2, 3]));
    expect(await binary.closed).toEqual({ code: 1003, reason: 'binary' });

    // 70 000 characters: a 64-bit length, refused from the frame header alone.
    const large = await Client.open(room, 'guest');
    large.send('host', 'x'.repeat(70_000));
    expect(await large.closed).toEqual({ code: 1009, reason: 'too-large' });
  });
});

describe('the dev relay with hand-made frames', () => {
  interface Frame {
    opcode: number;
    payload: Buffer;
  }

  /** The relay's frames (unmasked, and short in these tests: 7-bit lengths only). */
  function framesOf(bytes: Buffer): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset + 2 <= bytes.length) {
      const length = bytes[offset + 1]! & 0x7f;
      if (offset + 2 + length > bytes.length) break;
      frames.push({ opcode: bytes[offset]! & 0x0f, payload: bytes.subarray(offset + 2, offset + 2 + length) });
      offset += 2 + length;
    }
    return frames;
  }

  /**
   * A raw socket past the handshake. It answers the relay's close frame as a client must, and
   * `frames()` resolves with everything the relay sent once the connection has ended.
   */
  async function rawSocket(): Promise<{ socket: Socket; frames: () => Promise<Frame[]> }> {
    const socket = connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let start = -1;
    const ended = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    const upgraded = new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (start === -1 && buffer.includes('\r\n\r\n')) {
          start = buffer.indexOf('\r\n\r\n') + 4;
          resolve();
        }
        if (start !== -1 && framesOf(buffer.subarray(start)).some((frame) => frame.opcode === 0x8)) socket.end();
      });
    });
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const headers = Object.entries(upgrade(ORIGIN, 'guest')).map(([name, value]) => `${name}: ${value}`);
    socket.write([`GET /r/${newRoom()}?role=guest HTTP/1.1`, `host: 127.0.0.1:${port}`, ...headers, '', ''].join('\r\n'));
    await upgraded;
    const handshake = buffer.subarray(0, start).toString();
    // RFC 6455's own example key, and the accept value the RFC gives for it.
    expect(handshake).toMatch(/^HTTP\/1\.1 101 /);
    expect(handshake).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    return { socket, frames: () => ended.then(() => framesOf(buffer.subarray(start))) };
  }

  const closeOf = (frames: Frame[]): Closed | undefined => {
    const frame = frames.find((candidate) => candidate.opcode === 0x8);
    return frame && { code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString() };
  };

  const masked = (first: number, text: string) => {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    return Buffer.concat([Buffer.from([first, 0x80 | payload.length]), mask, payload.map((byte, i) => byte ^ mask[i & 3]!)]);
  };

  it('answers a ping with a pong carrying the same payload, and a close with a close', async () => {
    const { socket, frames } = await rawSocket();
    socket.write(masked(0x89, 'are you there'));
    socket.write(masked(0x88, ''));
    const sent = await frames();
    expect(sent.map((frame) => frame.opcode)).toEqual([0x1, 0xa, 0x8]);
    expect(JSON.parse(sent[0]!.payload.toString())).toEqual({ event: 'host', present: false });
    expect(sent[1]!.payload.toString()).toBe('are you there');
    expect(closeOf(sent)?.code).toBe(1000);
  });

  it('refuses a fragmented message with 1003', async () => {
    const { socket, frames } = await rawSocket();
    socket.write(masked(0x01, '{"to":"host",'));
    expect(closeOf(await frames())).toEqual({ code: 1003, reason: 'fragmented' });
  });

  it('refuses an unmasked client frame with 1002', async () => {
    const { socket, frames } = await rawSocket();
    socket.write(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from('{}')]));
    expect(closeOf(await frames())).toEqual({ code: 1002, reason: 'protocol' });
  });
});
