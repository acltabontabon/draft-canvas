/**
 * Where a collaboration session meets the editor: one host or guest session at a time, fed by the
 * editor's commits and writing the session's files back through `applyRemote`.
 *
 * The session engines (`collab/hostSession.ts`, `collab/guestSession.ts`) know nothing about stores;
 * this is the one place that does. It keeps `collabStore` current for the interface, watches the
 * editor for edits to send, and ends the session when the canvas on screen stops being the shared one.
 */
import { HOST_ORIGIN } from '../collab/hostCore';
import { idsUnique, withinLimits } from '../collab/limits';
import { GuestSession, type GuestStatus } from '../collab/guestSession';
import { HostSession } from '../collab/hostSession';
import { withLocalView } from '../collab/localView';
import type { EndReason, FollowState, PeerView, Presence, RejectReason, Role } from '../collab/protocol';
import type { CollabTransport } from '../collab/connect';
import type { DraftDocument } from '../document/types';
import { announce } from '../lib/announce';
import { logDiagnostic } from '../lib/diagnostics';
import { PRODUCT } from '../product';
import { COLLAB_AT_REST, useCollabStore, type SessionStatus } from './collabStore';
import { documentLoadCount, fileOf, isInteracting, useEditorStore } from './editorStore';
import { useUiStore } from './uiStore';

/** How often edits made during a held gesture (a slider, a resize) are sent: often enough to watch. */
const GESTURE_SEND_MS = 50;

let host: HostSession | null = null;
let guest: GuestSession | null = null;
let stopWatching: (() => void) | null = null;
let sharedDocumentId: string | null = null;
/**
 * Set once the shared canvas is really the one on screen: at once for the owner, and for a
 * collaborator only after their copy has finished opening. An id alone is not proof — a collaborator
 * can hold their own stored copy of the owner's diagram under the same id (exported, then imported),
 * and until `openCollaborative` has replaced it, writing to "the canvas with that id" would write
 * into their Library.
 */
let sharedCanvasOpen = false;
/**
 * Which load put the shared canvas in the store (`documentLoadCount`): an import or a share link can
 * bring a diagram with the very same id, and that file is not the session's. The owner's counts only
 * openings, so the desktop shell reloading the shared file after an outside edit stays shared; a
 * collaborator's copy only ever arrives once.
 */
let sharedLoad: { kind: 'all' | 'openings'; count: number } | null = null;
let gestureTimer: ReturnType<typeof setTimeout> | null = null;
let applyingRemote = false;
let removePageListener: (() => void) | null = null;

/**
 * Whether the canvas on screen is the shared one. A collaborator's copy opens asynchronously, and
 * until it is on screen the editor holds some other canvas — possibly one of this person's own,
 * autosaved — which the session must never write into.
 */
function onSharedCanvas(): boolean {
  return sharedCanvasOpen && isSharedCanvas(useEditorStore.getState().document.metadata.id);
}

function isSharedCanvas(id: string): boolean {
  return sharedDocumentId !== null && id === sharedDocumentId && sharedLoad !== null && documentLoadCount(sharedLoad.kind) === sharedLoad.count;
}

function markSharedLoad(kind: 'all' | 'openings'): void {
  sharedLoad = { kind, count: documentLoadCount(kind) };
}

function isBusy(): boolean {
  const ui = useUiStore.getState();
  return !onSharedCanvas() || isInteracting() || ui.interactionActive || ui.flowTrace !== null;
}

function readFile(): DraftDocument {
  return fileOf(useEditorStore.getState());
}

function applyRemote(file: DraftDocument): boolean {
  if (!onSharedCanvas()) return false;
  applyingRemote = true;
  try {
    return useEditorStore.getState().applyRemote(file);
  } finally {
    applyingRemote = false;
  }
}

/**
 * Sends the editor's edits as they are committed — at once, or every `GESTURE_SEND_MS` while a
 * gesture streams them — and ends the session if a different canvas replaces the shared one.
 */
function watchEdits(send: () => void, onReplaced: () => void): () => void {
  const flush = () => {
    if (gestureTimer !== null) clearTimeout(gestureTimer);
    gestureTimer = null;
    send();
  };
  // Until the shared canvas has been on screen, a different one there is the one being left, not a
  // replacement — and nothing on it is an edit to share.
  let seen = onSharedCanvas();
  const unsubscribe = useEditorStore.subscribe((state, prev) => {
    if (!isSharedCanvas(state.document.metadata.id)) {
      if (seen) onReplaced();
      return;
    }
    if (!seen) {
      seen = true;
      return;
    }
    if (applyingRemote) return;
    if (state.revision === prev.revision && state.document.metadata.title === prev.document.metadata.title) return;
    if (!isBusy()) return flush();
    gestureTimer ??= setTimeout(flush, GESTURE_SEND_MS);
  });
  return () => {
    unsubscribe();
    if (gestureTimer !== null) clearTimeout(gestureTimer);
    gestureTimer = null;
  };
}

function onPageLeave(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('pagehide', handler);
  return () => window.removeEventListener('pagehide', handler);
}

function cleanUp(): void {
  stopWatching?.();
  stopWatching = null;
  removePageListener?.();
  removePageListener = null;
  sharedDocumentId = null;
  sharedCanvasOpen = false;
  sharedLoad = null;
}

/**
 * Says who came and went, for a screen reader as for anyone not looking at the people column — read
 * off the change in the list, so a reconnect that changes nothing says nothing.
 */
function announcePeers(next: readonly PeerView[]): void {
  const before = new Map(useCollabStore.getState().peers.filter((peer) => peer.link !== 'gone').map((peer) => [peer.id, peer]));
  const after = next.filter((peer) => peer.link !== 'gone');
  for (const peer of after) if (!before.has(peer.id)) announce(`${peer.name} joined the session.`);
  for (const [id, peer] of before) if (!after.some((other) => other.id === id)) announce(`${peer.name} left the session.`);
  for (const peer of after) {
    const was = before.get(peer.id);
    if (was && was.role !== peer.role && peer.role !== 'owner') announce(`${peer.name} ${peer.role === 'editor' ? 'can now edit' : 'can now only view'}.`);
  }
}

/** Ends that point at a fault rather than a choice, for the local diagnostic report (no content, no names). */
const FAULTS: ReadonlySet<EndReason> = new Set(['protocol', 'timeout', 'too-large', 'version']);

function setPresenceOf(peerId: string, presence: Presence | null): void {
  useCollabStore.setState((state) => {
    if (presence === null) {
      if (!(peerId in state.presence)) return state;
      const { [peerId]: _gone, ...rest } = state.presence;
      return { presence: rest };
    }
    return { presence: { ...state.presence, [peerId]: presence } };
  });
}

/* ------------------------------------------------------------------ host -- */

export interface HostOptions {
  /** The owner's name as collaborators see it. */
  name: string;
  /** A desktop LAN session's secret, checked on every hello. */
  token?: string;
}

/** Starts sharing the canvas on screen. Idempotent while a session is running. */
export function startHosting(options: HostOptions): HostSession {
  if (host && !host.isEnded) return host;
  if (guest) throw new Error('Leave the session you joined before sharing a canvas of your own.');
  // Nobody's file: everyone could edit it, and nothing would be saved.
  if (useUiStore.getState().readOnly) throw new Error('A read-only copy can’t be shared live. Make an editable copy first.');
  const editor = useEditorStore.getState();
  sharedDocumentId = editor.document.metadata.id;
  sharedCanvasOpen = true;
  markSharedLoad('openings');
  const token = options.token;
  host = new HostSession(
    {
      readFile,
      applyRemote,
      isBusy,
      appVersion: PRODUCT.version,
      ...(token === undefined ? {} : { checkToken: (candidate: string | undefined) => candidate !== undefined && constantTimeEqual(candidate, token) }),
    },
    {
      peers: (peers: PeerView[]) => {
        const others = peers.filter((peer) => peer.id !== HOST_ORIGIN);
        announcePeers(others);
        useCollabStore.setState({ peers: others });
      },
      presence: setPresenceOf,
      authored: (peerId: string, name: string) => useCollabStore.setState((state) => ({ authors: { ...state.authors, [peerId]: name } })),
    },
    { name: options.name },
  );
  useCollabStore.setState({ ...COLLAB_AT_REST, role: 'host', status: 'live', access: 'owner', selfId: HOST_ORIGIN, selfName: options.name });
  const session = host;
  stopWatching = watchEdits(
    () => session.commitLocal(),
    () => stopHosting('document-changed'),
  );
  removePageListener = onPageLeave(() => stopHosting('owner-left'));
  return session;
}

export function stopHosting(reason: EndReason = 'ended'): void {
  if (!host) return;
  const session = host;
  host = null;
  session.end(reason);
  cleanUp();
  useCollabStore.setState(COLLAB_AT_REST);
}

export function hostSession(): HostSession | null {
  return host && !host.isEnded ? host : null;
}

/** A collaborator's connection, from an accepted invite or the LAN server. */
export function attachCollaborator(transport: CollabTransport, role: Role, reuse?: string, requireKey?: boolean): void {
  if (!host || host.isEnded) return transport.close('ended');
  host.attach(transport, { role, ...(reuse === undefined ? {} : { reuse }), ...(requireKey ? { requireKey } : {}) });
}

export function setCollaboratorRole(peerId: string, role: Role): void {
  host?.setRole(peerId, role);
}

export function removeCollaborator(peerId: string): void {
  host?.remove(peerId);
}

/** What taking back one person's changes came to, for the owner to be told. */
export type UndoChangesOutcome = 'done' | 'partial' | 'nothing' | 'blocked' | 'too-large' | 'busy' | 'ended';

/**
 * Takes back everything `peerId` changed this session, where nobody has changed it since and nobody
 * built on it — the owner's way back from one collaborator's edits going wrong, since those never
 * enter the owner's own undo history. One undoable edit, reaching everyone like any other.
 */
export function undoChangesOf(peerId: string, name: string): UndoChangesOutcome {
  // Said as it is: "nothing left of theirs" was the answer to a session already over, and to an
  // owner mid-drag, alike.
  if (!host || host.isEnded || !onSharedCanvas()) return 'ended';
  if (isBusy()) return 'busy';
  // Anything typed here and not yet shared goes into the session first, so it counts as the owner's.
  host.commitLocal();
  const current = readFile();
  const result = host.authorship.revert(peerId, current);
  if (result.file === current) return result.blocked ? 'blocked' : 'nothing';
  const reverted = result.file;
  // Bringing back what they deleted, after others have added their own, could pass the limits —
  // the same check every collaborator's patch gets.
  if (!withinLimits(reverted) || !idsUnique(reverted)) return 'too-large';
  if (!useEditorStore.getState().applyToFile(`Undo ${name}’s changes`, (file) => withLocalView(reverted, file))) return 'nothing';
  return result.partial || result.kept ? 'partial' : 'done';
}

/**
 * Answers a knock: lets that person in as `role`, or (`null`) turns them away. The waiting room lives
 * in the collaboration chunk (`ui/collab/lobbyStore.ts`), which registers itself here, so the dock
 * on the canvas can answer without loading any of it.
 */
let knockHandler: ((id: string, role: Role | null) => void) | null = null;
/** The same, for people at the door who came by the desktop's local network link (`lan:` ids). */
let lanKnockHandler: ((id: string, role: Role | null) => void) | null = null;

export function setKnockHandler(handler: ((id: string, role: Role | null) => void) | null): void {
  knockHandler = handler;
}

export function setLanKnockHandler(handler: ((id: string, role: Role | null) => void) | null): void {
  lanKnockHandler = handler;
}

export function answerKnock(id: string, role: Role | null): void {
  if (id.startsWith('lan:')) lanKnockHandler?.(id, role);
  else knockHandler?.(id, role);
}

/** What the owner is showing while presenting, for collaborators who follow. */
export function publishPresenter(state: FollowState | null): void {
  host?.setFollow(state);
}

/** Compares two secrets in time that does not depend on where they first differ. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ----------------------------------------------------------------- guest -- */

export interface JoinOptions {
  name: string;
  token?: string;
  /**
   * The session the link names, where it names one (`room:` and owner for a session link, `lan:` and
   * token for the local network): a later link may pick this session back up only if it names the same.
   */
  via?: string;
  /**
   * Opens the owner's file in the editor as a collaborator's copy — never stored, never autosaved.
   * Resolves `false` when the canvas on screen could not be left (unsaved work kept it open).
   */
  open(file: DraftDocument): Promise<boolean>;
  /** The connection dropped: the caller reconnects (LAN) or offers to ask for a new invite (WebRTC). */
  lost?(): void;
  /**
   * What keeps reconnecting this session (the local network link's): told when the connection drops,
   * and stopped when the session ends or is left, so it can never pick up a later one.
   */
  keeper?: SessionKeeper;
}

export interface SessionKeeper {
  lost(): void;
  stop(): void;
}

/** The current guest session's keeper, if it has one: see `JoinOptions.keeper`. */
let keeper: SessionKeeper | null = null;

/**
 * Hands the session a new keeper, stopping the one it had: "Rejoin" on the local network link makes
 * its own, and two at once closed each other's connections for good.
 */
export function replaceKeeper(next: SessionKeeper | null): void {
  const previous = keeper;
  keeper = next;
  if (previous && previous !== next) previous.stop();
}

const REJECTIONS: Record<RejectReason, string> = {
  'view-only': 'Your change was not applied — the owner has made you view-only.',
  malformed: 'Your change could not be applied and was undone.',
  limits: 'Your change was not applied — the diagram is at its size limit.',
  'too-much': 'Your change was not applied — it moved too much at once. Try it in smaller steps.',
};

export function joinSession(transport: CollabTransport, options: JoinOptions): GuestSession {
  if (host && !host.isEnded) throw new Error('Stop sharing your canvas before joining someone else’s.');
  leaveSession();
  const ui = useUiStore.getState();
  let title = '';
  const setAccess = (access: Role) => {
    const before = useCollabStore.getState().access;
    if (before !== access && useCollabStore.getState().status === 'live') announce(access === 'editor' ? 'The owner let you edit.' : 'The owner made you view-only.');
    useCollabStore.setState({ access });
    // Only the shared copy: while it is still opening, the canvas on screen is this person's own.
    if (onSharedCanvas()) useUiStore.getState().setReadOnly(access === 'viewer' ? { sharedTitle: title, collaborative: true } : null);
  };
  const session: GuestSession = new GuestSession(
    {
      readFile,
      applyRemote,
      isBusy,
      appVersion: PRODUCT.version,
      name: options.name,
      ...(options.token === undefined ? {} : { token: options.token }),
      open(file) {
        title = file.metadata.title;
        sharedDocumentId = file.metadata.id;
        sharedCanvasOpen = false;
        sharedLoad = null;
        stopWatching?.();
        stopWatching = null;
        void options.open(file).then((opened) => {
          if (guest !== session) {
            // The session ended (or another replaced it) while the copy was opening. It is on screen
            // now, and nobody's file: read-only with the way to keep a copy, never left to look editable.
            if (opened && useEditorStore.getState().document.metadata.id === file.metadata.id) {
              useUiStore.getState().setReadOnly({ sharedTitle: title, collaborative: true });
            }
            return;
          }
          if (!opened) {
            useUiStore.getState().notify('Left the session — the canvas you were on has unsaved changes. Save or export it, then open the invite again.', 'error');
            return leaveSession();
          }
          // Only now is the canvas on screen the collaborator's copy, never saved anywhere.
          sharedCanvasOpen = true;
          markSharedLoad('all');
          stopWatching = watchEdits(
            () => session.localChanged(),
            () => leaveSession(),
          );
          // Read now: the owner may have changed it while the copy was opening (an unsaved-changes
          // prompt can hold that open for as long as it likes).
          setAccess(session.role);
          // Commits that arrived while the canvas was opening waited for it.
          session.drainHeld();
        });
      },
      setAccess,
    },
    {
      status(status: GuestStatus, reason?: EndReason) {
        const was = useCollabStore.getState().status;
        const mapped: SessionStatus = status;
        useCollabStore.setState({ status: mapped, endReason: reason ?? null, ...(status === 'ended' ? { peers: [], presence: {}, presenter: null, following: false } : {}) });
        if (status === 'ended') {
          if (reason) announce(`The live session ended.`, { assertive: true });
          if (reason && FAULTS.has(reason)) logDiagnostic(new Error('collab ended'), { operation: 'collab-session' });
          // What is on screen stays — every unconfirmed edit included — but it is nobody's file now.
          if (onSharedCanvas()) useUiStore.getState().setReadOnly({ sharedTitle: title, collaborative: true });
          cleanUp();
          guest = null;
          replaceKeeper(null);
        } else if (status === 'reconnecting' && was !== 'reconnecting') {
          // Only on going from live to dropped: a reconnect under way says "reconnecting" again, and
          // answering that with another knock raced the rejoin it was part of.
          options.lost?.();
          keeper?.lost();
        }
      },
      joined: (selfId: string, access: Role, color?: number) => useCollabStore.setState({ selfId, access, ...(color === undefined ? {} : { selfColor: color }) }),
      peers: (peers: PeerView[]) => {
        announcePeers(peers);
        useCollabStore.setState({ peers });
      },
      presence: setPresenceOf,
      presenter: (state: FollowState | null) => useCollabStore.setState({ presenter: state }),
      rejected: (reason: RejectReason) => ui.notify(REJECTIONS[reason], 'error'),
      unconfirmed: (count: number) => useCollabStore.setState({ unconfirmed: count }),
      tooLarge: () => ui.notify('That change is too large to share live, so it was undone. Smaller edits still go through.', 'error'),
      refusedLink: () => {
        // The link opened was for some other session; this one carries on reconnecting.
        useUiStore.getState().setJoinInvite(null);
        ui.notify('That invite is for a different session. Yours is still reconnecting — ask its owner for a new invite if it doesn’t come back.', 'error');
      },
    },
  );
  guest = session;
  joinedVia = options.via ?? null;
  replaceKeeper(options.keeper ?? null);
  useCollabStore.setState({ ...COLLAB_AT_REST, role: 'guest', status: 'joining', access: 'viewer', selfName: options.name });
  removePageListener = onPageLeave(() => leaveSession());
  session.connect(transport);
  return session;
}

let joinedVia: string | null = null;

/**
 * Whether a link may pick the dropped session back up. A session link or local network link must name
 * this session. A direct invite names none: it is how the owner's Re-invite brings anyone back, so it
 * may pick up any session but a local network one (whose own reconnecting it would fight) — and the
 * resume proof keeps one from anyone else from taking the place, or passing for this session. Any
 * other link joins its own session, and leaves this one be.
 */
export function mayResumeVia(via: string | null): boolean {
  if (guest === null || guest.isEnded || useCollabStore.getState().status !== 'reconnecting') return false;
  return via === joinedVia || (via === null && !joinedVia?.startsWith('lan:'));
}

/** A new connection to the same owner after a drop (a LAN reconnect, or a re-invite). */
export function reconnectSession(transport: CollabTransport): void {
  if (!guest || guest.isEnded) return transport.close('ended');
  guest.connect(transport);
}

/**
 * Leaves on purpose, keeping what's on screen: read-only, with the banner's way to keep a copy —
 * left editable, it would look like a canvas that saves, and it saves nowhere.
 */
export function leaveSessionKeepingView(
  notice: { message: string; tone?: 'error' } = {
    // As the banner offers it: over the local network link's plain-http page, an export.
    message: typeof window !== 'undefined' && !window.isSecureContext ? 'You left the session. Export a copy to keep what you see.' : 'You left the session. Make an editable copy to keep what you see.',
  },
): void {
  leaveSession();
  useUiStore.getState().notify(notice.message, notice.tone);
}

/**
 * Leaves on purpose — or, after the owner ended it, puts the session's leftovers away. A copy still
 * on screen stays, read-only: whichever way the session goes (joining another that then fails, a
 * dialog closed mid-rejoin), it must never be left looking like a canvas that saves.
 */
export function leaveSession(): void {
  const session = guest;
  const keep = onSharedCanvas() ? useEditorStore.getState().document.metadata.title : null;
  guest = null;
  replaceKeeper(null);
  // First, so the goodbye's own "ended" can't mark whatever canvas comes next read-only.
  cleanUp();
  session?.leave();
  if (useCollabStore.getState().role === 'guest') useCollabStore.setState(COLLAB_AT_REST);
  if (keep !== null) useUiStore.getState().setReadOnly({ sharedTitle: keep, collaborative: true });
}

export function guestSession(): GuestSession | null {
  return guest && !guest.isEnded ? guest : null;
}

/** This person's own pointer and selection, for everyone else in the session. */
export function publishPresence(presence: Presence): void {
  if (host && !host.isEnded) host.setPresence(presence);
  else if (guest && !guest.isEnded) guest.setPresence(presence);
}

/** Test seam: drops whatever session a test left running. */
export function __resetCollabBridge(): void {
  host?.end('ended');
  guest?.leave();
  host = guest = null;
  cleanUp();
  useCollabStore.setState(COLLAB_AT_REST);
}
