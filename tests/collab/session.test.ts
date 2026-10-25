import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestSession } from '../../src/collab/guestSession';
import { HostSession } from '../../src/collab/hostSession';
import type { RejectReason } from '../../src/collab/protocol';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { addEdges, addNodes, removeElements, updateNode } from '../../src/document/operations';
import type { DraftDocument } from '../../src/document/types';
import { PRODUCT } from '../../src/product';
import { __resetCollabBridge, attachCollaborator, joinSession, leaveSession, mayResumeVia, reconnectSession, removeCollaborator, replaceKeeper, setCollaboratorRole, startHosting, stopHosting, undoChangesOf } from '../../src/store/collabBridge';
import { useCollabStore } from '../../src/store/collabStore';
import { __resetClipboardSync, __resetInteraction, fileOf, useEditorStore } from '../../src/store/editorStore';
import { useUiStore } from '../../src/store/uiStore';
import { loopbackPair, sharedContent } from './support';

const store = useEditorStore;

function resetEditor(document: DraftDocument = createDocument('Shared')) {
  __resetInteraction();
  __resetClipboardSync();
  store.setState({
    document,
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    revision: 0,
  });
  useUiStore.setState({ readOnly: null, flowTrace: null, interactionActive: false, toasts: [] } as never);
}

/** A collaborator whose "editor" is a plain variable — the far end of the session under test. */
function collaborator(transport: ReturnType<typeof loopbackPair>['b']) {
  const state = { file: null as DraftDocument | null, rejected: [] as RejectReason[], status: '' };
  const session = new GuestSession(
    {
      readFile: () => state.file!,
      applyRemote: (file) => {
        state.file = file;
        return true;
      },
      isBusy: () => false,
      open: (file) => {
        state.file = file;
      },
      setAccess: () => {},
      appVersion: PRODUCT.version,
      name: 'Ada',
    },
    {
      status: (status) => (state.status = status),
      joined: () => {},
      peers: () => {},
      presence: () => {},
      presenter: () => {},
      rejected: (reason) => state.rejected.push(reason),
      unconfirmed: () => {},
      tooLarge: () => {},
    },
  );
  session.connect(transport);
  return {
    session,
    state,
    edit(fn: (file: DraftDocument) => DraftDocument) {
      state.file = fn(state.file!);
      session.localChanged();
    },
  };
}

function settle(pump: () => number) {
  for (let i = 0; i < 50 && pump() > 0; i += 1);
}

describe('hosting from the editor', () => {
  let pump: () => number;
  let guest: ReturnType<typeof collaborator>;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCollabBridge();
    const a = createNode({ id: 'n_a', type: 'service', text: 'A', x: 0, y: 0 });
    const b = createNode({ id: 'n_b', type: 'service', text: 'B', x: 300, y: 0 });
    resetEditor(addNodes(createDocument('Shared'), [a, b]));
    startHosting({ name: 'Owner' });
    const pair = loopbackPair();
    pump = pair.pump;
    attachCollaborator(pair.a, 'editor');
    guest = collaborator(pair.b);
    settle(pump);
  });

  afterEach(() => {
    __resetCollabBridge();
    vi.useRealTimers();
  });

  it('sends the owner’s edits and takes the collaborator’s, without an undo step for theirs', () => {
    expect(guest.state.status).toBe('live');
    store.getState().addNode({ type: 'note', x: 0, y: 200, text: 'Owner note' });
    settle(pump);
    expect(guest.state.file!.nodes.map((node) => node.text)).toContain('Owner note');

    const steps = store.getState().history.past.length;
    guest.edit((file) => addNodes(file, [createNode({ type: 'note', x: 0, y: 400, text: 'Guest note' })]));
    settle(pump);
    expect(store.getState().document.nodes.map((node) => node.text)).toContain('Guest note');
    expect(store.getState().history.past).toHaveLength(steps);
    expect(sharedContent(guest.session.local!)).toEqual(sharedContent(fileOf(store.getState())));
  });

  it('holds a collaborator’s edit while the owner drags, then applies it', () => {
    store.getState().beginInteraction('Move');
    store.getState().apply('Move', (doc) => updateNode(doc, 'n_a', { x: 40 }));
    guest.edit((file) => updateNode(file, 'n_b', { text: 'Renamed by Ada' }));
    settle(pump);
    expect(store.getState().document.nodes.find((node) => node.id === 'n_b')!.text).toBe('B');

    store.getState().endInteraction();
    vi.advanceTimersByTime(150);
    settle(pump);
    const nodes = store.getState().document.nodes;
    expect(nodes.find((node) => node.id === 'n_b')!.text).toBe('Renamed by Ada');
    expect(nodes.find((node) => node.id === 'n_a')!.x).toBe(40);
    expect(guest.state.file!.nodes.find((node) => node.id === 'n_a')!.x).toBe(40);
  });

  it('never folds a later edit into one someone else has edited since, so undoing it keeps theirs', () => {
    store.getState().apply('Nudge', (doc) => updateNode(doc, 'n_a', { x: 10 }), { coalesceKey: 'nudge:n_a' });
    settle(pump);
    guest.edit((file) => updateNode(file, 'n_a', { text: 'Renamed by Ada' }));
    settle(pump);
    store.getState().apply('Nudge', (doc) => updateNode(doc, 'n_a', { x: 20 }), { coalesceKey: 'nudge:n_a' });
    settle(pump);

    // One step spanning Ada's rename went back to before it, rename and all.
    store.getState().undo();
    settle(pump);
    const node = store.getState().document.nodes.find((candidate) => candidate.id === 'n_a')!;
    expect(node).toMatchObject({ x: 10, text: 'Renamed by Ada' });
    expect(guest.state.file!.nodes.find((candidate) => candidate.id === 'n_a')!.text).toBe('Renamed by Ada');
  });

  it('undoes only the owner’s own edit, leaving the collaborator’s', () => {
    const added = store.getState().addNode({ type: 'note', x: 0, y: 200, text: 'Mine' });
    settle(pump);
    guest.edit((file) => updateNode(file, 'n_b', { text: 'Theirs' }));
    settle(pump);

    store.getState().undo();
    settle(pump);
    const nodes = store.getState().document.nodes;
    expect(nodes.some((node) => node.id === added.id)).toBe(false);
    expect(nodes.find((node) => node.id === 'n_b')!.text).toBe('Theirs');
    expect(guest.state.file!.nodes.some((node) => node.id === added.id)).toBe(false);

    store.getState().redo();
    settle(pump);
    expect(store.getState().document.nodes.some((node) => node.id === added.id)).toBe(true);
    expect(store.getState().document.nodes.find((node) => node.id === 'n_b')!.text).toBe('Theirs');
  });

  it('refuses to undo something a collaborator has built on', () => {
    const added = store.getState().addNode({ type: 'service', x: 0, y: 200, text: 'New' });
    settle(pump);
    guest.edit((file) => addEdges(file, [createEdge({ source: 'n_b', target: added.id })]));
    settle(pump);
    const notify = vi.spyOn(useUiStore.getState(), 'notify');

    store.getState().undo();
    expect(store.getState().document.nodes.some((node) => node.id === added.id)).toBe(true);
    expect(store.getState().document.edges).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('someone else has built on it'));
  });

  it('turns a patch away once its sender is view-only, and the sender’s copy follows', () => {
    const peer = useCollabStore.getState().peers[0]!.id;
    // The edit is on its way before the role change reaches the collaborator.
    guest.edit((file) => updateNode(file, 'n_a', { text: 'Too late' }));
    setCollaboratorRole(peer, 'viewer');
    settle(pump);
    expect(guest.state.rejected).toEqual(['view-only']);
    expect(guest.session.local!.nodes.find((node) => node.id === 'n_a')!.text).toBe('A');
    expect(store.getState().document.nodes.find((node) => node.id === 'n_a')!.text).toBe('A');
  });

  it('brings the owner out of a room a collaborator deleted', () => {
    store.getState().enterInside('n_a');
    store.getState().addNode({ type: 'component', x: 0, y: 0, text: 'Inner' });
    settle(pump);
    expect(store.getState().path).toEqual(['n_a']);
    guest.edit((file) => removeElements(file, ['n_a']));
    settle(pump);
    expect(store.getState().path).toEqual([]);
    expect(store.getState().document.nodes.some((node) => node.id === 'n_a')).toBe(false);
  });

  it('never takes away a collaborator’s work with undo, even after the session has ended', () => {
    store.getState().addNode({ type: 'note', x: 0, y: 200, text: 'Mine' });
    settle(pump);
    guest.edit((file) => addNodes(file, [createNode({ type: 'note', x: 0, y: 400, text: 'Guest note' })]));
    settle(pump);
    __resetCollabBridge();
    const texts = () => store.getState().document.nodes.map((node) => node.text).sort();
    store.getState().undo();
    expect(texts()).toEqual(['A', 'B', 'Guest note']);
    store.getState().redo();
    expect(texts()).toEqual(['A', 'B', 'Guest note', 'Mine']);
    // An edit made after the session is the owner's alone, and undoes as before.
    store.getState().addNode({ type: 'note', x: 0, y: 600, text: 'Later' });
    store.getState().undo();
    expect(texts()).toEqual(['A', 'B', 'Guest note', 'Mine']);
  });

  it('takes back one collaborator’s changes — and only theirs — as one undoable edit', () => {
    const gus = guest.session.id!;
    expect(useCollabStore.getState().authors[gus]).toBeUndefined();
    guest.edit((file) => removeElements(file, ['n_a', 'n_b']));
    settle(pump);
    expect(store.getState().document.nodes).toHaveLength(0);
    expect(useCollabStore.getState().authors[gus]).toBe('Ada');
    // The owner's own edit since is the owner's, and stays.
    store.getState().addNode({ type: 'note', x: 0, y: 200, text: 'Owner note' });
    settle(pump);

    expect(undoChangesOf(gus, 'Gus')).toBe('done');
    settle(pump);
    const texts = () => store.getState().document.nodes.map((node) => node.text).sort();
    expect(texts()).toEqual(['A', 'B', 'Owner note']);
    expect(sharedContent(guest.state.file!)).toEqual(sharedContent(fileOf(store.getState())));
    // An ordinary undo step: undo puts Gus's changes back.
    store.getState().undo();
    settle(pump);
    expect(texts()).toEqual(['Owner note']);
  });

  it('can still take back a collaborator’s changes once they are gone from the list', () => {
    const gus = guest.session.id!;
    guest.edit((file) => removeElements(file, ['n_a']));
    settle(pump);
    removeCollaborator(gus);
    vi.advanceTimersByTime(1_000);
    settle(pump);
    expect(useCollabStore.getState().peers.some((peer) => peer.id === gus)).toBe(false);
    expect(useCollabStore.getState().authors[gus]).toBe('Ada');
    expect(undoChangesOf(gus, 'Ada')).toBe('done');
    expect(store.getState().document.nodes.map((node) => node.id).sort()).toEqual(['n_a', 'n_b']);
  });

  it('prunes departed authors from the interface when the recovery ledger forgets their identities', () => {
    const host = startHosting({ name: 'Owner' });
    let first = '';
    let last = '';
    for (let i = 0; i < 140; i += 1) {
      const pair = loopbackPair();
      attachCollaborator(pair.a, 'editor');
      const visitor = collaborator(pair.b);
      settle(pair.pump);
      first ||= visitor.session.id!;
      last = visitor.session.id!;
      visitor.edit((file) => updateNode(file, 'n_a', { text: `Visitor ${i}` }));
      settle(pair.pump);
      visitor.session.leave();
      settle(pair.pump);
    }
    const authors = useCollabStore.getState().authors;
    expect(Object.keys(authors).sort()).toEqual(host.authorship.authors().sort());
    expect(Object.keys(authors).length).toBeLessThanOrEqual(128);
    expect(authors[first]).toBeUndefined();
    expect(authors[last]).toBe('Ada');
    expect(undoChangesOf(last, 'Ada')).toBe('done');
    expect(store.getState().document.nodes.find((node) => node.id === 'n_a')!.text).toBe('Visitor 138');
  });

  it('leaves a collaborator’s shape that the owner has built on', () => {
    const gus = guest.session.id!;
    guest.edit((file) => addNodes(file, [createNode({ id: 'n_g', type: 'service', text: 'Gus', x: 0, y: 300 })]));
    settle(pump);
    // As the desktop shell reloads the shared file after an outside edit: the same canvas, kept.
    store.getState().setDocument(addEdges(fileOf(store.getState()), [createEdge({ id: 'e_owner', source: 'n_a', target: 'n_g' })]), { keepPath: true });
    settle(pump);
    expect(undoChangesOf(gus, 'Gus')).toBe('blocked');
    expect(store.getState().document.nodes.some((node) => node.id === 'n_g')).toBe(true);
    expect(undoChangesOf('nobody', 'Nobody')).toBe('nothing');
  });

  it('ends the session when another file with the same id takes the canvas’s place, sending none of it', () => {
    const before = sharedContent(guest.session.local!);
    // A share link (or an import) of this very diagram, opened by the owner: same id, not the shared file.
    store.getState().setDocument({ ...addNodes(createDocument('Old export'), [createNode({ type: 'note', x: 0, y: 0, text: 'Stale' })]), metadata: { ...fileOf(store.getState()).metadata, title: 'Old export' } });
    settle(pump);
    expect(useCollabStore.getState().role).toBe('off');
    expect(guest.state.status).toBe('ended');
    expect(sharedContent(guest.session.local!)).toEqual(before);
  });

  it('stays shared when the desktop shell reloads the same file after an outside edit', () => {
    store.getState().setDocument(updateNode(fileOf(store.getState()), 'n_a', { text: 'Edited outside' }), { keepPath: true });
    settle(pump);
    expect(useCollabStore.getState().role).toBe('host');
    expect(guest.state.file!.nodes.find((node) => node.id === 'n_a')!.text).toBe('Edited outside');
  });

  it('says the session is over, not that nothing is left, when asked to take changes back after it ended', () => {
    stopHosting('ended');
    expect(undoChangesOf('anyone', 'Anyone')).toBe('ended');
  });

  it('ends the session when the owner opens a different canvas', () => {
    store.getState().setDocument(createDocument('Something else'));
    settle(pump);
    expect(useCollabStore.getState().role).toBe('off');
    expect(guest.state.status).toBe('ended');
  });
});

describe('joining from the editor', () => {
  let ownerFile: DraftDocument;
  let owner: HostSession;
  let pump: () => number;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCollabBridge();
    // This person's own canvas is on screen when they open the invite.
    resetEditor(addNodes(createDocument('Mine'), [createNode({ id: 'n_mine', type: 'note', x: 0, y: 0, text: 'My own' })]));
    ownerFile = addNodes(createDocument('Owner’s'), [createNode({ id: 'n_o', type: 'service', x: 0, y: 0, text: 'Owner' })]);
    owner = new HostSession(
      {
        readFile: () => ownerFile,
        applyRemote: (file) => {
          ownerFile = file;
          return true;
        },
        isBusy: () => false,
        appVersion: PRODUCT.version,
      },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const pair = loopbackPair();
    pump = pair.pump;
    owner.attach(pair.a, { role: 'editor' });
    let finishOpening: () => void = () => {};
    joinSession(pair.b, {
      name: 'Guest',
      open: (file) =>
        new Promise<boolean>((resolve) => {
          finishOpening = () => {
            store.getState().setDocument(file);
            resolve(true);
          };
        }),
    });
    settle(pump);
    // Something changes on the owner's side while the copy is still opening.
    ownerFile = addNodes(ownerFile, [createNode({ id: 'n_late', type: 'note', x: 0, y: 200, text: 'Late' })]);
    owner.commitLocal();
    settle(pump);
    // The canvas on screen is still this person's own, and nothing was written into it.
    expect(store.getState().document.metadata.title).toBe('Mine');
    expect(store.getState().document.nodes.map((node) => node.id)).toEqual(['n_mine']);
    finishOpening();
  });

  afterEach(() => {
    owner.end();
    __resetCollabBridge();
    vi.useRealTimers();
  });

  async function opened() {
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(150);
    settle(pump);
  }

  it('opens the owner’s file, catches up on what changed while it opened, and sends edits back', async () => {
    await opened();
    expect(store.getState().document.metadata.id).toBe(ownerFile.metadata.id);
    expect(store.getState().document.nodes.map((node) => node.id).sort()).toEqual(['n_late', 'n_o']);
    expect(useCollabStore.getState()).toMatchObject({ role: 'guest', status: 'live', access: 'editor' });

    store.getState().addNode({ type: 'note', x: 0, y: 400, text: 'From the guest' });
    settle(pump);
    expect(ownerFile.nodes.map((node) => node.text)).toContain('From the guest');
  });

  it('becomes read-only when the owner makes this person a viewer, and when the session ends', async () => {
    await opened();
    const [peer] = owner.peers().filter((candidate) => candidate.role !== 'owner');
    owner.setRole(peer!.id, 'viewer');
    settle(pump);
    expect(useUiStore.getState().readOnly).toMatchObject({ collaborative: true });

    owner.setRole(peer!.id, 'editor');
    settle(pump);
    expect(useUiStore.getState().readOnly).toBeNull();

    owner.end('owner-left');
    settle(pump);
    // Who owned it outlives the cleared people list, for the card the canvas closes behind.
    expect(useCollabStore.getState()).toMatchObject({ status: 'ended', endReason: 'owner-left', peers: [], endedOwner: { name: 'Owner', color: 0 } });
    expect(useUiStore.getState().readOnly).toMatchObject({ collaborative: true });
  });

  it('leaves the session, sending nothing, when a file with the copy’s id is dropped onto it', async () => {
    await opened();
    const before = sharedContent(ownerFile);
    // An export of the owner's diagram, imported: same id, older content.
    store.getState().setDocument({ ...createDocument('Old export'), metadata: { ...ownerFile.metadata, title: 'Old export' } });
    settle(pump);
    expect(sharedContent(ownerFile)).toEqual(before);
    expect(useCollabStore.getState().role).toBe('off');
    // The imported file is this person's own now: not read-only.
    expect(useUiStore.getState().readOnly).toBeNull();
  });

  it('can’t undo while view-only: nothing changes that the owner would never hear about', async () => {
    await opened();
    store.getState().addNode({ type: 'note', x: 0, y: 400, text: 'From the guest' });
    settle(pump);
    const [peer] = owner.peers().filter((candidate) => candidate.role !== 'owner');
    owner.setRole(peer!.id, 'viewer');
    settle(pump);
    const shown = sharedContent(fileOf(store.getState()));
    store.getState().undo();
    expect(sharedContent(fileOf(store.getState()))).toEqual(shown);
    owner.setRole(peer!.id, 'editor');
    settle(pump);
    store.getState().addNode({ type: 'note', x: 0, y: 600, text: 'Later' });
    settle(pump);
    expect(ownerFile.nodes.map((node) => node.text)).toEqual(expect.arrayContaining(['From the guest', 'Later']));
  });
});

describe('a session that ends while the collaborator’s copy is still opening', () => {
  it('leaves the copy, once it opens, read-only rather than looking like a canvas that saves', async () => {
    vi.useFakeTimers();
    __resetCollabBridge();
    resetEditor(createDocument('Mine'));
    let ownerFile = addNodes(createDocument('Owner’s'), [createNode({ id: 'n_o', type: 'service', x: 0, y: 0, text: 'Owner' })]);
    const owner = new HostSession(
      { readFile: () => ownerFile, applyRemote: (file) => ((ownerFile = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const pair = loopbackPair();
    owner.attach(pair.a, { role: 'editor' });
    let finishOpening: () => void = () => {};
    joinSession(pair.b, {
      name: 'Guest',
      open: (file) =>
        new Promise<boolean>((resolve) => {
          finishOpening = () => {
            store.getState().setDocument(file);
            resolve(true);
          };
        }),
    });
    settle(pair.pump);
    owner.end('owner-left');
    settle(pair.pump);
    finishOpening();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().document.metadata.id).toBe(ownerFile.metadata.id);
    expect(useUiStore.getState().readOnly).toMatchObject({ collaborative: true });
    __resetCollabBridge();
    vi.useRealTimers();
  });
});

describe('a shared canvas that fails to open', () => {
  afterEach(() => {
    __resetCollabBridge();
    vi.useRealTimers();
  });

  it.each(['throw', 'reject'] as const)('leaves cleanly when opening fails by %s, preserving the local canvas', async (failure) => {
    vi.useFakeTimers();
    __resetCollabBridge();
    const mine = createDocument('Mine');
    resetEditor(mine);
    const file = createDocument('Owner’s');
    const owner = new HostSession(
      { readFile: () => file, applyRemote: () => true, isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const pair = loopbackPair();
    const keeper = { lost: vi.fn(), stop: vi.fn() };
    owner.attach(pair.a, { role: 'editor' });
    const guest = joinSession(pair.b, {
      name: 'Guest',
      keeper,
      open: () => {
        if (failure === 'throw') throw new Error('Opening failed');
        return Promise.reject(new Error('Opening failed'));
      },
    });
    settle(pair.pump);
    await Promise.resolve();
    settle(pair.pump);
    expect(guest.isEnded).toBe(true);
    expect(useCollabStore.getState().role).toBe('off');
    expect(keeper.stop).toHaveBeenCalledTimes(1);
    expect(store.getState().document).toBe(mine);
    expect(useUiStore.getState().readOnly).toBeNull();
    expect(useUiStore.getState().toasts.some((toast) => toast.message.includes('Couldn’t open the shared canvas'))).toBe(true);
    owner.end();
  });
});

describe('a collaborator holding their own copy of the owner’s diagram', () => {
  afterEach(() => {
    __resetCollabBridge();
    vi.useRealTimers();
  });

  it('is never written into while the session copy is still opening', () => {
    vi.useFakeTimers();
    __resetCollabBridge();
    let ownerFile = addNodes(createDocument('Same id'), [createNode({ id: 'n_o', type: 'service', x: 0, y: 0, text: 'Owner' })]);
    // Exported by the owner once, imported here: the same document id, this person's own stored copy.
    resetEditor({ ...addNodes(createDocument('Mine'), [createNode({ id: 'n_mine', type: 'note', x: 0, y: 0, text: 'My own' })]), metadata: { ...ownerFile.metadata, title: 'My copy' } });
    const owner = new HostSession(
      { readFile: () => ownerFile, applyRemote: (file) => ((ownerFile = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const pair = loopbackPair();
    owner.attach(pair.a, { role: 'editor' });
    joinSession(pair.b, { name: 'Guest', open: () => new Promise<boolean>(() => {}) });
    settle(pair.pump);
    ownerFile = addNodes(ownerFile, [createNode({ id: 'n_late', type: 'note', x: 0, y: 200, text: 'Late' })]);
    owner.commitLocal();
    settle(pair.pump);
    vi.advanceTimersByTime(1000);
    expect(store.getState().document.metadata.title).toBe('My copy');
    expect(store.getState().document.nodes.map((node) => node.id)).toEqual(['n_mine']);
    owner.end();
  });
});

describe('a role changed while the collaborator’s copy is still opening', () => {
  afterEach(() => {
    __resetCollabBridge();
    vi.useRealTimers();
  });

  it('is the role the copy opens with, and leaves the canvas still on screen alone', async () => {
    vi.useFakeTimers();
    __resetCollabBridge();
    resetEditor(addNodes(createDocument('Mine'), [createNode({ id: 'n_mine', type: 'note', x: 0, y: 0, text: 'My own' })]));
    let ownerFile = addNodes(createDocument('Owner’s'), [createNode({ id: 'n_o', type: 'service', x: 0, y: 0, text: 'Owner' })]);
    const owner = new HostSession(
      { readFile: () => ownerFile, applyRemote: (file) => ((ownerFile = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const pair = loopbackPair();
    owner.attach(pair.a, { role: 'editor' });
    let finishOpening: () => void = () => {};
    joinSession(pair.b, {
      name: 'Guest',
      open: (file) =>
        new Promise<boolean>((resolve) => {
          finishOpening = () => {
            store.getState().setDocument(file);
            resolve(true);
          };
        }),
    });
    settle(pair.pump);
    const [peer] = owner.peers().filter((candidate) => candidate.role !== 'owner');
    owner.setRole(peer!.id, 'viewer');
    settle(pair.pump);
    // Their own canvas is still on screen: not this session's to make read-only.
    expect(useUiStore.getState().readOnly).toBeNull();

    finishOpening();
    await Promise.resolve();
    await Promise.resolve();
    expect(useCollabStore.getState().access).toBe('viewer');
    expect(useUiStore.getState().readOnly).toMatchObject({ collaborative: true });
    owner.end();
  });
});

describe('what keeps a collaborator’s session reconnecting', () => {
  function setup() {
    vi.useFakeTimers();
    __resetCollabBridge();
    resetEditor(createDocument('Mine'));
    let ownerFile = addNodes(createDocument('Owner’s'), [createNode({ id: 'n_o', type: 'service', x: 0, y: 0, text: 'Owner' })]);
    const owner = new HostSession(
      { readFile: () => ownerFile, applyRemote: (file) => ((ownerFile = file), true), isBusy: () => false, appVersion: PRODUCT.version },
      { peers: () => {}, presence: () => {} },
      { name: 'Owner' },
    );
    const pair = loopbackPair();
    owner.attach(pair.a, { role: 'editor' });
    const keeper = { lost: vi.fn(), stop: vi.fn() };
    const lost = vi.fn();
    joinSession(pair.b, { name: 'Guest', open: async (file) => (store.getState().setDocument(file), true), keeper, lost });
    settle(pair.pump);
    return { owner, pair, keeper, lost };
  }

  afterEach(() => {
    __resetCollabBridge();
    vi.useRealTimers();
  });

  it('may be picked up by the owner’s Re-invite, never by a link to another session', async () => {
    const { pair } = setup();
    await Promise.resolve();
    pair.drop();
    expect(mayResumeVia(null)).toBe(true);
    expect(mayResumeVia('room:other:owner')).toBe(false);
  });

  it('is stopped when the session is left, so it can never pick up the next one', () => {
    const { owner, keeper } = setup();
    leaveSession();
    expect(keeper.stop).toHaveBeenCalledTimes(1);
    owner.end();
  });

  it('is stopped when the session ends, and replaced — never doubled — by a rejoin’s own', () => {
    const { owner, pair, keeper } = setup();
    const next = { lost: vi.fn(), stop: vi.fn() };
    replaceKeeper(next);
    expect(keeper.stop).toHaveBeenCalledTimes(1);
    owner.end('owner-left');
    settle(pair.pump);
    expect(next.stop).toHaveBeenCalledTimes(1);
  });

  it('hears of a drop once, not again when a reconnect under way says "reconnecting" itself', async () => {
    const { owner, pair, keeper, lost } = setup();
    await Promise.resolve();
    await Promise.resolve();
    pair.drop();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(keeper.lost).toHaveBeenCalledTimes(1);
    // The rejoin's own connection: still reconnecting, and no second knock.
    const back = loopbackPair();
    owner.attach(back.a, { role: 'editor' });
    reconnectSession(back.b);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(keeper.lost).toHaveBeenCalledTimes(1);
    owner.end();
  });
});
