/**
 * A connection waiting to be let in: someone who reached the owner directly (the desktop's local
 * network link) rather than by knocking through the relay, held at the same door.
 *
 * Their hello is read — that is where the name they typed is — and kept. While the owner decides,
 * their heartbeat is answered so they don't take the wait for a dropped connection. Let in, the
 * connection is handed to the session with the hello delivered again first, exactly as it arrived;
 * turned away, they are told so and the connection closes.
 */
import { encode, parseWire, readGuestMessage, type HelloMessage, type Role } from './protocol';
import { sameSecret } from './rendezvous';
import type { CollabTransport, TransportState } from './transport/types';

/**
 * The place someone at the door says is theirs, when the session still keeps it and their hello
 * carries its key: for the owner's knock card ("back after a drop") and for letting them in to that
 * place, with the role the owner then chooses. Never a reason to let them in unasked — on the local
 * network the hello and the welcome travel in clear, so anyone on the same Wi‑Fi can have read the
 * key. A wrong key is just a new person knocking.
 */
export function returningPlace(
  door: AtTheDoor,
  waitingPlace: (peerId: string) => { role: Role; key: string } | null,
): { peer: string; role: Role } | null {
  if (!door.returning) return null;
  const place = waitingPlace(door.returning.peer);
  return place && sameSecret(place.key, door.returning.key) ? { peer: door.returning.peer, role: place.role } : null;
}

/** How long a new connection has to say hello before it is dropped at the door. */
export const DOOR_HELLO_MS = 10_000;

export interface AtTheDoor {
  name: string;
  /** Set when they are coming back: the place they had, and its private resume key. */
  returning?: { peer: string; key: string };
  /** The connection for the session, its hello delivered again to whoever listens first. */
  admit(): CollabTransport;
  /** Turned away: told why, then closed. */
  refuse(): void;
  /** Called once if the connection goes before the owner decides. */
  onGone(listener: () => void): void;
}

/** Waits for `transport`'s hello; `null` when it never comes, or what comes isn't one. */
export function holdAtDoor(transport: CollabTransport, timeoutMs = DOOR_HELLO_MS): Promise<AtTheDoor | null> {
  return new Promise((resolve) => {
    let hello: { text: string; message: HelloMessage } | null = null;
    let decided = false;
    let gone: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (hello) return;
      release();
      transport.close('timeout');
      resolve(null);
    }, timeoutMs);
    const offMessage = transport.onMessage((text) => {
      const message = readGuestMessage(parseWire(text));
      if (!hello) {
        if (message?.t !== 'hello') {
          release();
          transport.close('protocol');
          return resolve(null);
        }
        hello = { text, message };
        clearTimeout(timer);
        return resolve(door());
      }
      // Waiting: keep the connection looking alive, and nothing else.
      if (message?.t === 'ping') transport.send(encode({ t: 'pong', n: message.n }), 'presence');
    });
    const offState = transport.onState((state: TransportState) => {
      if (state !== 'closed') return;
      release();
      if (!hello) return resolve(null);
      if (!decided) gone?.();
    });
    function release() {
      clearTimeout(timer);
      offMessage();
      offState();
    }
    function door(): AtTheDoor {
      const resume = hello!.message.resume;
      return {
        name: hello!.message.name,
        ...(resume?.key ? { returning: { peer: resume.peer, key: resume.key } } : {}),
        admit() {
          decided = true;
          release();
          return replayingFirst(transport, hello!.text);
        },
        refuse() {
          decided = true;
          release();
          transport.send(encode({ t: 'end', reason: 'denied' }), 'commit');
          setTimeout(() => transport.close('denied'), 250);
        },
        onGone(listener) {
          gone = listener;
        },
      };
    }
  });
}

/** `transport`, with `first` delivered to the first message listener before anything else. */
function replayingFirst(transport: CollabTransport, first: string): CollabTransport {
  let pending: string | null = first;
  return {
    get kind() {
      return transport.kind;
    },
    get state() {
      return transport.state;
    },
    send: (message, priority) => transport.send(message, priority),
    onMessage(listener) {
      const off = transport.onMessage(listener);
      if (pending !== null) {
        const text = pending;
        pending = null;
        queueMicrotask(() => listener(text));
      }
      return off;
    },
    onState: (listener) => transport.onState(listener),
    close: (reason) => transport.close(reason),
  };
}
