import { describe, expect, it, vi } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { PRODUCT } from '../src/product';
import { buildBackup } from '../src/storage/backup';
import { HANDOFF_TYPE, parseHandoff, receiveDiagrams, sendDiagrams, type HandoffPeer, type ReceiverHost } from '../src/storage/handoff';
import { MemoryRepository } from '../src/storage/MemoryRepository';

const APP = PRODUCT.web.appOrigin;
const LEGACY = PRODUCT.web.legacyOrigin;
const EVIL = 'https://evil.example';

type Listener = (event: MessageEvent) => void;

/** A window's message side: what `addEventListener('message')` sees, delivered by hand. */
class FakeTarget {
  readonly listeners = new Set<Listener>();
  addEventListener(_type: 'message', listener: Listener) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: Listener) {
    this.listeners.delete(listener);
  }
  deliver(data: unknown, origin: string, source: unknown) {
    for (const listener of [...this.listeners]) listener({ data, origin, source } as MessageEvent);
  }
}

interface Posted {
  message: unknown;
  targetOrigin: string;
  transfer?: Transferable[];
}

/** The other tab, as seen from this one: something to post to, which may be closed. */
class FakePeer implements HandoffPeer {
  readonly posted: Posted[] = [];
  closed = false;
  private readonly onPost?: (posted: Posted) => void;
  constructor(onPost?: (posted: Posted) => void) {
    this.onPost = onPost;
  }
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]) {
    const posted = { message, targetOrigin, transfer };
    this.posted.push(posted);
    this.onPost?.(posted);
  }
}

class FakeHost extends FakeTarget implements ReceiverHost {
  location: { origin: string; hash: string; pathname: string; search: string } = { origin: APP, hash: '#handoff', pathname: '/', search: '' };
  history = {
    state: null,
    replaceState: vi.fn((_data: unknown, _unused: string, url?: string | URL | null) => {
      this.location.hash = String(url).includes('#') ? String(url).slice(String(url).indexOf('#')) : '';
    }),
  };
  opener: HandoffPeer | null;
  constructor(opener: HandoffPeer | null) {
    super();
    this.opener = opener;
  }
}

async function seeded(titles = ['Orders', 'Billing']): Promise<MemoryRepository> {
  const repository = new MemoryRepository();
  for (const title of titles) {
    await repository.save(addNodes(createDocument(title), [createNode({ type: 'service', x: 0, y: 0, text: `${title} API` })]));
  }
  return repository;
}

async function backupMessage(repository: MemoryRepository) {
  const { bytes, count } = await buildBackup(repository);
  return { type: HANDOFF_TYPE, version: 1, step: 'backup', bytes: bytes.slice().buffer, count };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const later = (run: () => void) => setTimeout(run, 0);

describe('handoff between the old address and the new one', () => {
  it('moves every diagram tab to tab, naming the exact origin on every post', async () => {
    const source = await seeded();
    const destination = new MemoryRepository();
    const oldWindow = new FakeTarget();
    // Each tab's posts arrive at the other with the poster's origin and window as the browser says.
    const opener: FakePeer = new FakePeer(({ message, targetOrigin }) => {
      if (targetOrigin === LEGACY) later(() => oldWindow.deliver(message, APP, popup));
    });
    const newTab = new FakeHost(opener);
    const popup: FakePeer = new FakePeer(({ message, targetOrigin }) => {
      if (targetOrigin === APP) later(() => newTab.deliver(message, LEGACY, opener));
    });
    let received: Promise<unknown> | undefined;
    const opened: string[] = [];

    const outcome = await sendDiagrams({
      repository: source,
      target: oldWindow,
      open: (url) => {
        opened.push(url);
        later(() => {
          received = receiveDiagrams({ repository: destination, host: newTab });
        });
        return popup;
      },
    });

    expect(opened).toEqual([`${PRODUCT.web.app}#handoff`]);
    expect(outcome).toEqual({ kind: 'moved', restored: 2, renamed: 0, skipped: 0, unreadable: 0 });
    expect(await received).toMatchObject({ kind: 'received', result: { restored: 2, renamed: 0 } });
    expect((await destination.list()).map((entry) => entry.title).sort()).toEqual(['Billing', 'Orders']);
    // Both directions name the other's origin, never '*'.
    expect(popup.posted.map((post) => post.targetOrigin)).toEqual([APP]);
    expect(opener.posted.map((post) => post.targetOrigin)).toEqual([LEGACY, LEGACY]);
    expect(popup.posted[0]!.transfer?.length).toBe(1);
    expect(opener.posted.map((post) => (post.message as { step: string }).step)).toEqual(['ready', 'ack']);
    // The address is tidied once the move has been answered, and nothing is left listening.
    expect(newTab.location.hash).toBe('');
    expect(newTab.history.replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(newTab.listeners.size).toBe(0);
    expect(oldWindow.listeners.size).toBe(0);
  });

  it('says so when the new tab was blocked or never answered', async () => {
    const repository = await seeded();
    expect(await sendDiagrams({ repository, target: new FakeTarget(), open: () => null })).toEqual({ kind: 'blocked' });

    const target = new FakeTarget();
    const popup = new FakePeer();
    const waiting = sendDiagrams({ repository, target, open: () => popup, readyTimeoutMs: 40 });
    // A "ready" from the wrong origin, then from the right origin but another window, is not the new tab's.
    target.deliver({ type: HANDOFF_TYPE, version: 1, step: 'ready' }, EVIL, popup);
    target.deliver({ type: HANDOFF_TYPE, version: 1, step: 'ready' }, APP, new FakePeer());
    expect(await waiting).toEqual({ kind: 'timeout', stage: 'ready' });
    expect(popup.posted).toEqual([]);
    expect(target.listeners.size).toBe(0);

    const closing = new FakePeer();
    const closed = sendDiagrams({ repository, target, open: () => closing, closedPollMs: 5 });
    closing.closed = true;
    expect(await closed).toEqual({ kind: 'closed' });
  });

  it('ignores an ack from anywhere but the new tab', async () => {
    const repository = await seeded();
    const target = new FakeTarget();
    const popup = new FakePeer();
    const waiting = sendDiagrams({ repository, target, open: () => popup, ackTimeoutMs: 60 });
    target.deliver({ type: HANDOFF_TYPE, version: 1, step: 'ready' }, APP, popup);
    await vi.waitFor(() => expect(popup.posted).toHaveLength(1));
    const forged = { type: HANDOFF_TYPE, version: 1, step: 'ack', restored: 99, renamed: 0, skipped: 0 };
    target.deliver(forged, EVIL, popup);
    target.deliver(forged, APP, new FakePeer());
    expect(await waiting).toEqual({ kind: 'timeout', stage: 'ack' });
  });

  it('accepts the backup only from the opener, at the old origin', async () => {
    const opener = new FakePeer();
    const host = new FakeHost(opener);
    const destination = new MemoryRepository();
    const receiving = receiveDiagrams({ repository: destination, host });
    expect(opener.posted).toEqual([{ message: { type: HANDOFF_TYPE, version: 1, step: 'ready' }, targetOrigin: LEGACY, transfer: undefined }]);

    const message = await backupMessage(await seeded(['Forged']));
    host.deliver(message, EVIL, opener);
    host.deliver(message, LEGACY, new FakePeer());
    await tick();
    expect(await destination.list()).toEqual([]);

    host.deliver(await backupMessage(await seeded(['Real'])), LEGACY, opener);
    expect(await receiving).toMatchObject({ kind: 'received', result: { restored: 1 } });
    expect((await destination.list()).map((entry) => entry.title)).toEqual(['Real']);
    expect(opener.posted.every((post) => post.targetOrigin === LEGACY)).toBe(true);
  });

  it('restores one payload once, however many arrive or however often it is asked', async () => {
    const opener = new FakePeer();
    const host = new FakeHost(opener);
    const destination = new MemoryRepository();
    // StrictMode runs the effect twice: the second call gets the first's receipt.
    const first = receiveDiagrams({ repository: destination, host });
    const second = receiveDiagrams({ repository: destination, host });
    expect(second).toBe(first);
    expect(opener.posted).toHaveLength(1);

    const message = await backupMessage(await seeded());
    host.deliver(message, LEGACY, opener);
    host.deliver(await backupMessage(await seeded()), LEGACY, opener);
    await first;
    await tick();
    expect(await destination.list()).toHaveLength(2);
    expect(opener.posted.map((post) => (post.message as { step: string }).step)).toEqual(['ready', 'ack']);
    // Asked again after the hash is gone, still the same answer, not a fresh wait.
    expect(receiveDiagrams({ repository: destination, host })).toBe(first);
  });

  it('refuses a malformed backup and says so to the old tab', async () => {
    const opener = new FakePeer();
    const host = new FakeHost(opener);
    const destination = new MemoryRepository();
    const receiving = receiveDiagrams({ repository: destination, host });
    host.deliver({ type: HANDOFF_TYPE, version: 1, step: 'backup', bytes: 'not bytes', count: 1 }, LEGACY, opener);
    expect(await receiving).toMatchObject({ kind: 'failed' });
    expect(opener.posted[1]!.message).toMatchObject({ step: 'ack', restored: 0, error: expect.any(String) });
    expect(opener.posted[1]!.targetOrigin).toBe(LEGACY);
    expect(await destination.list()).toEqual([]);
    expect(host.location.hash).toBe('');
  });

  it('clears #handoff without an opener, and stays out of the way anywhere else', async () => {
    const lonely = new FakeHost(null);
    expect(await receiveDiagrams({ repository: new MemoryRepository(), host: lonely })).toEqual({ kind: 'no-opener' });
    expect(lonely.history.replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(lonely.location.hash).toBe('');

    const opener = new FakePeer();
    const elsewhere = new FakeHost(opener);
    elsewhere.location.origin = LEGACY;
    expect(await receiveDiagrams({ repository: new MemoryRepository(), host: elsewhere })).toEqual({ kind: 'none' });
    const plain = new FakeHost(opener);
    plain.location.hash = '';
    expect(await receiveDiagrams({ repository: new MemoryRepository(), host: plain })).toEqual({ kind: 'none' });
    expect(opener.posted).toEqual([]);
  });

  it('parses messages strictly', () => {
    const ready = { type: HANDOFF_TYPE, version: 1, step: 'ready' };
    expect(parseHandoff(ready, 'ready')).toEqual(ready);
    expect(parseHandoff({ ...ready, version: 2 }, 'ready')).toBeNull();
    expect(parseHandoff({ ...ready, extra: true }, 'ready')).toBeNull();
    expect(parseHandoff({ ...ready, type: 'other' }, 'ready')).toBeNull();
    expect(parseHandoff(ready, 'backup')).toBeNull();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(parseHandoff({ ...ready, step: 'backup', bytes, count: 1 }, 'backup')?.bytes.byteLength).toBe(3);
    expect(parseHandoff({ ...ready, step: 'backup', bytes: new ArrayBuffer(0), count: 1 }, 'backup')).toBeNull();
    expect(parseHandoff({ ...ready, step: 'backup', bytes: bytes.buffer, count: -1 }, 'backup')).toBeNull();
    expect(parseHandoff({ ...ready, step: 'ack', restored: 1, renamed: 0, skipped: '0' }, 'ack')).toBeNull();
  });
});
