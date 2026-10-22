import { create } from 'zustand';
import type { EndReason, FollowState, PeerView, Presence, Role } from '../collab/protocol';

export type { LinkState, PeerView } from '../collab/protocol';

/**
 * A collaboration session as the interface sees it — who is here, where they are pointing, how the
 * connection is doing.
 *
 * Transient by design, like `uiStore.presentation`: none of this is ever saved, undone or exported.
 * The file itself lives in `editorStore` as always; a session only changes how edits reach it.
 * Written by the session bridge (`collab/session/bridge.ts`) and read by the collaboration UI.
 */

export type SessionRole = 'off' | 'host' | 'guest';

export type SessionStatus = 'idle' | 'joining' | 'live' | 'reconnecting' | 'ended';

export interface CollabState {
  role: SessionRole;
  status: SessionStatus;
  /** Why the session ended, while the banner saying so is up. */
  endReason: EndReason | null;
  /** This copy's id in the session; the owner's is fixed. */
  selfId: string | null;
  /** The name this person goes by in the session. */
  selfName: string;
  /** Their colour in it — the owner's is always 0, and the owner hands out the rest. */
  selfColor: number;
  /** What this person may do: the owner, or a collaborator's role as the owner set it. */
  access: Role | 'owner';
  /** Everyone else in the session, the owner included when this is a collaborator. */
  peers: readonly PeerView[];
  /** Where each other person is pointing and what they have selected, by peer id. */
  presence: Readonly<Record<string, Presence>>;
  /** What the presenter is showing, while they present; `null` otherwise. */
  presenter: FollowState | null;
  /** Whether this collaborator's camera follows the presenter. Turned off by panning. */
  following: boolean;
  /** Edits made here that the owner has not confirmed yet. */
  unconfirmed: number;
  /** The owner's: people at the door, waiting to be let in, in the order they knocked. */
  knocks: readonly KnockView[];
  /** The owner's: people waiting at the door who came by the desktop's local network link. */
  lanKnocks: readonly KnockView[];
  /** The owner's: the one link anyone joins by (approved at the door), once the relay has the room. */
  sessionLink: string | null;
  /**
   * The owner's: whether knocking works right now, or only direct invites do. `local` is the owner's
   * own choice ("Only my network"): no relay is contacted at all.
   */
  rendezvous: 'off' | 'local' | 'connecting' | 'open' | 'unavailable';
}

export interface KnockView {
  id: string;
  /** As they typed it themselves — the owner never names anyone. */
  name: string;
  at: number;
  /** Set once the owner let them in, while their connection is made. */
  admitting?: Role;
}

export const COLLAB_AT_REST: CollabState = {
  role: 'off',
  status: 'idle',
  endReason: null,
  selfId: null,
  selfName: '',
  selfColor: 0,
  access: 'owner',
  peers: [],
  presence: {},
  presenter: null,
  following: false,
  unconfirmed: 0,
  knocks: [],
  lanKnocks: [],
  sessionLink: null,
  rendezvous: 'off',
};

export const useCollabStore = create<CollabState>(() => COLLAB_AT_REST);

/** Whether this copy's edits are shared with anyone right now — the one question the editor asks. */
export function isSharedEditing(): boolean {
  const { role, status } = useCollabStore.getState();
  return role !== 'off' && status !== 'ended';
}
