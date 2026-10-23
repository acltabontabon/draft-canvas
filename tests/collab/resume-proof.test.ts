import { afterEach, describe, expect, it } from 'vitest';
import { GuestSession, type GuestEvents } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import { encode, PROTOCOL_VERSION, type PeerView } from '../../src/collab/protocol';
import { createDocument, createNode } from '../../src/document/factory';
import { addNodes, updateNode } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { loopbackPair } from './support';

/**
 * Coming back over a connection that names its far end (WebRTC: the owner's certificate) proves the
 * place's key instead of sending it, and the owner proves it back — so "Rejoin" on an invite from
 * anyone else hands them nothing they could use, and can't pass their session off as the real one.
 */

const ended: Array<{ end(): void } | { leave(): void }> = [];

afterEach(() => {
  for (const session of ended.splice(0)) 'end' in session ? session.end() : session.leave();
});

function owner(file: DraftDocument) {
  const state = { file, peers: [] as PeerView[] };
  const host = new HostSession(
    { readFile: () => state.file, applyRemote: (next) => ((state.file = next), true), isBusy: () => false, appVersion: PRODUCT.version },
    { peers: (peers) => (state.peers = peers), presence: () => {} },
    { name: 'Owner' },
  );
  ended.push(host);
  return { host, state };
}

function collaborator() {
  const state = { file: null as DraftDocument | null, ended: null as string | null };
  const events: GuestEvents = {
    status: (status, reason) => {
      if (status === 'ended') state.ended = reason ?? 'ended';
    },
    joined: () => {},
    peers: () => {},
    presence: () => {},
    presenter: () => {},
    rejected: () => {},
    unconfirmed: () => {},
    tooLarge: () => {},
  };
  const session = new GuestSession(
    {
      readFile: () => state.file!,
      applyRemote: (file) => ((state.file = file), true),
      isBusy: () => false,
      open: (file) => (state.file = file),
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: 'Vic',
    },
    events,
  );
  ended.push(session);
  return { session, state };
}

/** Until the proofs (WebCrypto, so truly asynchronous) are made and every message delivered. */
async function settle(pump: () => number) {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    pump();
  }
}

const base = () => addNodes(createDocument('Proof'), [createNode({ id: 'n_a', type: 'service', text: 'A', x: 0, y: 0 })]);

describe('coming back over a connection with a binding', () => {
  it('proves the place without sending its key, and keeps the edit made while away', async () => {
    const { host, state } = owner(base());
    const first = loopbackPair('webrtc', 'sha-256 aa');
    host.attach(first.a, { role: 'editor' });
    const vic = collaborator();
    vic.session.connect(first.b);
    await settle(first.pump);
    const id = vic.session.id!;
    first.drop();
    vic.state.file = updateNode(vic.state.file!, 'n_a', { text: 'Made offline' });
    vic.session.localChanged();

    const back = loopbackPair('webrtc', 'sha-256 bb');
    host.attach(back.a, { role: 'editor' });
    vic.session.connect(back.b);
    await settle(back.pump);

    const hello = JSON.parse(back.sent.b[0]!) as { resume: Record<string, unknown>; token?: string };
    expect(hello.resume).toMatchObject({ peer: id, proof: expect.any(String) });
    expect(hello.resume.key).toBeUndefined();
    // No secret of the local network's in a hello, ever: it is proved to the desktop's server instead.
    expect(hello.token).toBeUndefined();
    expect(vic.session.id).toBe(id);
    expect(vic.state.ended).toBeNull();
    expect(state.file.nodes[0]!.text).toBe('Made offline');
  });

  it('gives whoever made the invite nothing: their proof opens no place, and their welcome is refused', async () => {
    const { host, state } = owner(base());
    const first = loopbackPair('webrtc', 'sha-256 aa');
    host.attach(first.a, { role: 'editor' });
    const vic = collaborator();
    vic.session.connect(first.b);
    await settle(first.pump);
    const id = vic.session.id!;
    const sessionId = host.id;
    first.drop();

    // "Rejoin" on Mallory's invite: her connection, her certificate.
    const mallory = loopbackPair('webrtc', 'sha-256 ee');
    vic.session.connect(mallory.b);
    await settle(mallory.pump);
    const hello = JSON.parse(mallory.sent.b[0]!) as { resume: { peer: string; seq: number; proof: string; key?: string } };
    expect(hello.resume.key).toBeUndefined();

    // She hands the proof to the real owner, over her own connection to it: no place.
    const replay = loopbackPair('webrtc', 'sha-256 ff');
    host.attach(replay.a, { role: 'viewer' });
    replay.b.send(JSON.stringify({ ...hello, name: 'Vic' }), 'commit');
    await settle(replay.pump);
    const welcome = replay.sent.a.map((text) => JSON.parse(text) as { t: string; peer?: string; role?: string; proof?: string }).find((message) => message.t === 'welcome');
    expect(welcome).toMatchObject({ role: 'viewer' });
    expect(welcome?.peer).not.toBe(id);
    expect(welcome?.proof).toBeUndefined();

    // And her own welcome, dressed as the session Vic left (its id is no secret), is refused.
    mallory.a.send(
      encode({ t: 'welcome', v: PROTOCOL_VERSION, session: sessionId, peer: id, key: 'k'.repeat(32), role: 'editor', seq: 99, snapshot: base(), peers: [] }),
      'commit',
    );
    await settle(mallory.pump);
    // Her connection is dropped; Vic's session carries on reconnecting, its edits never sent to her.
    expect(mallory.b.state).toBe('closed');
    expect(vic.state.ended).toBeNull();
    expect(mallory.sent.b.some((text) => text.includes('"t":"patch"'))).toBe(false);
    expect(state.file.nodes[0]!.text).toBe('A');
  });

  it('keeps the connection when an edit arrives while the owner is still checking the proof', async () => {
    const { host, state } = owner(base());
    const first = loopbackPair('webrtc', 'sha-256 aa');
    host.attach(first.a, { role: 'editor' });
    const vic = collaborator();
    vic.session.connect(first.b);
    await settle(first.pump);
    first.drop();

    const back = loopbackPair('webrtc', 'sha-256 bb');
    host.attach(back.a, { role: 'editor' });
    vic.session.connect(back.b);
    // An edit made at once, while the proof is still being worked out: never sent ahead of the hello.
    vic.state.file = updateNode(vic.state.file!, 'n_a', { text: 'Right away' });
    vic.session.localChanged();
    expect(back.sent.b).toHaveLength(0);
    await settle(back.pump);
    // And one arriving while the owner checks (a hand-made client): ignored, not a protocol error.
    expect(vic.state.ended).toBeNull();
    expect(state.file.nodes[0]!.text).toBe('Right away');
  });

  it('lets someone whose place was forgotten long ago back in by proof', async () => {
    const { host, state } = owner(base());
    const first = loopbackPair('webrtc', 'sha-256 aa');
    host.attach(first.a, { role: 'editor' });
    const vic = collaborator();
    vic.session.connect(first.b);
    await settle(first.pump);
    first.drop();
    vic.state.file = updateNode(vic.state.file!, 'n_a', { text: 'Made offline' });
    vic.session.localChanged();
    // Many others come and go meanwhile: their place is long forgotten.
    for (let i = 0; i < 80; i += 1) {
      const other = loopbackPair();
      host.attach(other.a, { role: 'viewer' });
      other.b.send(encode({ t: 'hello', v: PROTOCOL_VERSION, app: PRODUCT.version, doc: state.file.version, name: `Visitor ${i}` }), 'commit');
      other.pump();
      other.drop();
    }
    const back = loopbackPair('webrtc', 'sha-256 cc');
    host.attach(back.a, { role: 'editor' });
    vic.session.connect(back.b);
    await settle(back.pump);
    expect(vic.state.ended).toBeNull();
    expect(state.file.nodes[0]!.text).toBe('Made offline');
  });
});
