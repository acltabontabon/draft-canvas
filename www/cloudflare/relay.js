// relay.draftcanvas.dev — introduces a live session's owner to the people joining it.
//
// The two browsers trade a knock and a WebRTC offer and answer here, encrypted end to end with a key
// that never leaves the invite link's fragment, and then talk directly; the relay steps aside. Each
// room is one Durable Object (named by the room id), holding nothing but its open sockets. It uses
// the WebSocket Hibernation API, so a room waiting on someone costs nothing while it waits: each
// socket's role, tag and limits live in its attachment, not in the object's memory.
//
// Nothing is logged, and the only thing stored is each room's owner claim — the SHA-256 of a secret
// only the owner's browser has, kept for the room's lifetime at most (`checkOwner`), so nobody else
// can host the room. `relay-room.js` holds the rules; this file only adapts
// Cloudflare's sockets to them. `scripts/dev-relay.mjs` runs the same rules locally.
import { DurableObject } from 'cloudflare:workers';
import {
  admission,
  checkOwner,
  checkRequest,
  CLOSE,
  PROTOCOL,
  secretDigest,
  closePeer,
  deadline,
  departed,
  live,
  openState,
  opened,
  parseOrigins,
  received,
  sweep,
  uniqueGuestTag,
} from './relay-room.js';

const OPEN = 1;

const sendable = (code) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export default {
  async fetch(request, env) {
    const verdict = checkRequest(
      {
        method: request.method,
        url: request.url,
        upgrade: request.headers.get('upgrade'),
        origin: request.headers.get('origin'),
        protocols: request.headers.get('sec-websocket-protocol'),
      },
      { origins: parseOrigins(env.ALLOWED_ORIGINS) },
    );
    if (verdict.kind === 'health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
    }
    if (verdict.kind === 'reject') {
      return new Response(verdict.body, { status: verdict.status, headers: { ...verdict.headers, ...SECURITY_HEADERS } });
    }
    // One address can't open sockets without end, across rooms: each costs a Durable Object wake-up.
    if (env.CONNECTIONS) {
      const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.CONNECTIONS.limit({ key: address });
      if (!success) return new Response('too many connections\n', { status: 429, headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60', ...SECURITY_HEADERS } });
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(verdict.room));
    // The room learns the role from a header of our own, never from the client's query string as such:
    // the Worker has already validated it.
    const headers = new Headers(request.headers);
    headers.set('x-relay-role', verdict.role);
    // The room never sees a host's secret, only its digest.
    headers.delete('sec-websocket-protocol');
    if (verdict.secret) headers.set('x-relay-owner', await secretDigest(verdict.secret));
    return room.fetch(new Request(request.url, { method: 'GET', headers }));
  },
};

export class RelayRoom extends DurableObject {
  /** One wrapper per socket for as long as this instance lives, so `peers` compare by identity. */
  #peers = new WeakMap();

  #peer(ws) {
    let peer = this.#peers.get(ws);
    if (!peer) {
      peer = {
        read: () => ws.deserializeAttachment(),
        write: (state) => {
          try {
            ws.serializeAttachment(state);
          } catch {
            // A socket that has finished closing keeps no attachment; nothing reads it again.
          }
        },
        send: (text) => {
          try {
            ws.send(text);
          } catch {
            // The socket closed between being listed and being written to; its close event follows.
          }
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            // Already closing.
          }
        },
      };
      this.#peers.set(ws, peer);
    }
    return peer;
  }

  /** Every socket the room still has open. A socket's attachment is set as it is accepted. */
  #room() {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === OPEN && ws.deserializeAttachment())
      .map((ws) => this.#peer(ws));
  }

  async fetch(request) {
    const role = request.headers.get('x-relay-role');
    if (role !== 'host' && role !== 'guest') return new Response(null, { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    const answered = { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': PROTOCOL } };
    const peers = this.#room();
    let refused = admission(peers, role);
    if (!refused && role === 'host') {
      const digest = request.headers.get('x-relay-owner');
      const owner = digest ? checkOwner(await this.ctx.storage.get('owner'), digest, Date.now()) : { verdict: 'not-owner' };
      if (owner.verdict === 'claim') await this.ctx.storage.put('owner', owner.claim);
      else if (owner.verdict === 'not-owner') refused = CLOSE.notOwner;
    }
    if (refused) {
      // Accepted without hibernation only to say why: the socket never joins the room.
      server.accept();
      server.close(refused.code, refused.reason);
      return new Response(null, answered);
    }
    const tag = role === 'guest' ? uniqueGuestTag(peers) : null;
    const now = Date.now();
    this.ctx.acceptWebSocket(server, tag ? [role, tag] : [role]);
    server.serializeAttachment(openState(peers, role, tag, now));
    const room = [...peers, this.#peer(server)];
    opened(room, this.#peer(server));
    // A newcomer resets the idle clock, so the next look is never earlier than the one set before.
    await this.ctx.storage.setAlarm(deadline(room));
    return new Response(null, answered);
  }

  async webSocketMessage(ws, message) {
    const peer = this.#peer(ws);
    const peers = this.#room();
    received(peers.includes(peer) ? peers : [...peers, peer], peer, typeof message === 'string' ? message : null, Date.now());
  }

  async webSocketClose(ws, code) {
    departed(this.#room(), this.#peer(ws));
    // Answer the client's close, for runtimes that do not do it themselves. Only codes that may be sent
    // on the wire are echoed (1005 and 1006, for one, only ever describe a close).
    this.#peer(ws).close(sendable(code) ? code : 1000);
  }

  async webSocketError(ws) {
    const peer = this.#peer(ws);
    const peers = this.#room();
    if (peers.includes(peer)) closePeer(peers, peer, { code: 1011, reason: 'error' });
    else departed(peers, peer);
  }

  async alarm() {
    const now = Date.now();
    const next = sweep(this.#room(), now);
    if (next !== null) return this.ctx.storage.setAlarm(next);
    if (live(this.#room()).length > 0) return;
    // An empty room keeps its owner's claim until the room's lifetime is up, then forgets everything.
    const claim = await this.ctx.storage.get('owner');
    if (claim && now < claim.until) await this.ctx.storage.setAlarm(claim.until);
    else await this.ctx.storage.deleteAll();
  }
}
