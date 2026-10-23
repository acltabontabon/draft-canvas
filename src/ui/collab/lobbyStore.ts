import { HostLobby } from '../../collab/lobby';
import { relayUrl } from '../../collab/connect';
import type { Role } from '../../collab/protocol';
import { newOwnerIdentity, newSessionLink, rendezvousAvailable, sessionPayload } from '../../collab/rendezvous';
import { hostKind } from '../../host/hostInfo';
import { PRODUCT } from '../../product';
import { attachCollaborator, hostSession, setKnockHandler } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { announce } from '../../lib/announce';
import { logDiagnostic } from '../../lib/diagnostics';
import { isLookalike, readConnectionPreferences } from './collabCopy';

/**
 * The owner's waiting room, for as long as a session runs: one session link for everyone, a knock
 * for each person who opens it, and Allow or Deny for each. Kept out of the dialog so knocks keep
 * arriving — and can be answered from the canvas — with the dialog closed.
 */
let lobby: HostLobby | null = null;

/** The app the session link opens: this page's own address, or the public app from the desktop. */
function linkBase(): string {
  if (__DESKTOP__ || hostKind() === 'desktop') return PRODUCT.web.app;
  const here = new URL(window.location.href);
  here.hash = '';
  return here.toString();
}

/** Opens the waiting room for a session that just started. Without the relay, direct invites still work. */
export function openLobby(owner: string): void {
  closeLobby();
  const url = relayUrl();
  if (!url || !rendezvousAvailable()) {
    useCollabStore.setState({ rendezvous: 'unavailable', sessionLink: null, knocks: [] });
    return;
  }
  const generation = ++opening;
  useCollabStore.setState({ rendezvous: 'connecting', sessionLink: null, knocks: [] });
  void newOwnerIdentity().then(
    (identity) => {
      if (generation === opening && useCollabStore.getState().role === 'host') start(owner, url, identity);
    },
    () => useCollabStore.setState({ rendezvous: 'unavailable' }),
  );
}

/** Bumped by every open and close, so an identity still being made for an older session is dropped. */
let opening = 0;

function start(owner: string, url: string, identity: Awaited<ReturnType<typeof newOwnerIdentity>>): void {
  const link = newSessionLink(identity);
  const base = new URL(linkBase());
  base.hash = new URLSearchParams({ join: sessionPayload(link) }).toString();
  const seen = new Set<string>();
  const current = new HostLobby(link, identity, url, owner, readConnectionPreferences(), {
    status: (status) => {
      if (lobby !== current) return;
      // Locally recorded only, as a category: the relay couldn't be reached (no address, no room id).
      if (status === 'unavailable' && useCollabStore.getState().rendezvous !== 'unavailable') logDiagnostic(new Error('relay'), { operation: 'collab-relay' });
      // The link appears once the relay holds the room for this owner, and stays through reconnects:
      // handed out sooner, someone holding it could claim the room first and keep the owner out.
      const shown = useCollabStore.getState().sessionLink !== null;
      useCollabStore.setState({ rendezvous: status, sessionLink: status === 'open' || (status === 'connecting' && shown) ? base.toString() : null });
    },
    knocks: (knocks) => {
      if (lobby !== current) return;
      useCollabStore.setState({ knocks });
      // The door card on the canvas asks the question; only while presenting (when the canvas's
      // chrome is hidden) does a knock need a notice of its own.
      for (const knock of knocks) {
        if (seen.has(knock.id)) continue;
        seen.add(knock.id);
        if (!knock.admitting) announce(`${knock.name} is asking to join.`);
        if (useEditorStore.getState().mode === 'present' && !knock.admitting) {
          // No one-click "Let in" for a name someone here already has: that is for the door card,
          // where the owner sees the warning beside the question.
          if (isLookalike(useCollabStore.getState(), knock)) {
            useUiStore.getState().notify(`${knock.name} wants to join — someone here already goes by that name. Check who it is before letting them in.`);
          } else {
            useUiStore.getState().notify(`${knock.name} wants to join`, 'info', { label: 'Let in', run: () => void current.allow(knock.id, 'editor') });
          }
        }
      }
    },
    admitted: (transport, role, reuse) => attachCollaborator(transport, role, reuse, reuse !== undefined),
    // A knock proves the place's key without carrying it, so a place whose link only looks up from
    // here (it dropped on their side first) is theirs to take back — not a stranger at the door.
    isReturning: (peerId) => hostSession()?.waitingPlace(peerId, { evenIfLive: true }) ?? null,
    failed: (name, reason) => {
      logDiagnostic(new Error(reason), { operation: 'collab-knock' });
      useUiStore
        .getState()
        .notify(
          reason === 'timeout'
            ? `${name} didn’t finish connecting. They can open the link again.`
            : `Couldn’t connect ${name}. On different networks, some office networks block direct connections — a direct invite from Collaborate may work.`,
          'error',
        );
    },
  });
  lobby = current;
  setKnockHandler((id, role: Role | null) => {
    if (lobby !== current) return;
    if (role) void current.allow(id, role);
    else void current.deny(id);
  });
  void current.open();
}

export function closeLobby(): void {
  opening += 1;
  const current = lobby;
  lobby = null;
  setKnockHandler(null);
  void current?.close();
  useCollabStore.setState({ knocks: [], sessionLink: null, rendezvous: 'off' });
}

// The waiting room belongs to the session: however the session ends, the door closes with it.
useCollabStore.subscribe((state, prev) => {
  if (prev.role === 'host' && state.role !== 'host') closeLobby();
});
