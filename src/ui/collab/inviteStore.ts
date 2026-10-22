import { create } from 'zustand';
import { CollabCodeError, createInvite, inviteLink, type HostOffer } from '../../collab/connect';
import type { Role } from '../../collab/protocol';
import { hostKind } from '../../host/hostInfo';
import { PRODUCT } from '../../product';
import { attachCollaborator } from '../../store/collabBridge';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { readConnectionPreferences } from './collabCopy';
import { logDiagnostic } from '../../lib/diagnostics';

/**
 * The invite the owner is in the middle of: made, sent, waiting for the reply code to be pasted.
 * Outside the dialog on purpose — sending a link and waiting for an answer takes minutes, and closing
 * the dialog meanwhile must not throw the invite away.
 */
export type InviteStage =
  | { kind: 'idle' }
  | { kind: 'preparing'; role: Role; reuse?: string }
  /** `spent`: the code was applied and the connection failed — this invite can't be used again. */
  | { kind: 'ready'; role: Role; reuse?: string; link: string; expiresAt: number; error?: string; spent?: boolean }
  | { kind: 'connecting'; role: Role; reuse?: string; link: string; expiresAt: number };

interface InviteState {
  stage: InviteStage;
  create(role: Role, reuse?: string): Promise<void>;
  accept(code: string): Promise<void>;
  cancel(): void;
}

let offer: HostOffer | null = null;
/** Each create bumps this, so a slow one finishing after a newer one (or a cancel) is ignored. */
let generation = 0;

/** Where the invite link points: the app this page came from, or the public one from the desktop app. */
function inviteBase(): string {
  if (__DESKTOP__ || hostKind() === 'desktop') return PRODUCT.web.app;
  const here = new URL(window.location.href);
  here.hash = '';
  return here.toString();
}

export const useInviteStore = create<InviteState>((set, get) => ({
  stage: { kind: 'idle' },

  async create(role, reuse) {
    get().cancel();
    const mine = (generation += 1);
    set({ stage: { kind: 'preparing', role, ...(reuse === undefined ? {} : { reuse }) } });
    try {
      const made = await createInvite(readConnectionPreferences());
      if (mine !== generation) return made.cancel();
      offer = made;
      set({ stage: { kind: 'ready', role, ...(reuse === undefined ? {} : { reuse }), link: inviteLink(made, inviteBase()), expiresAt: made.expiresAt } });
    } catch (error) {
      if (mine !== generation) return;
      logDiagnostic(error, { operation: 'collab-invite' });
      set({ stage: { kind: 'idle' } });
      useUiStore.getState().notify(error instanceof Error ? `Couldn’t prepare an invite: ${error.message}` : 'Couldn’t prepare an invite.', 'error');
    }
  },

  async accept(code) {
    const stage = get().stage;
    if (stage.kind !== 'ready' || !offer) return;
    const current = offer;
    const mine = generation;
    set({ stage: { kind: 'connecting', role: stage.role, ...(stage.reuse === undefined ? {} : { reuse: stage.reuse }), link: stage.link, expiresAt: stage.expiresAt } });
    try {
      const transport = await current.acceptReply(code);
      if (mine !== generation) return transport.close('cancelled');
      attachCollaborator(transport, stage.role, stage.reuse);
      offer = null;
      set({ stage: { kind: 'idle' } });
    } catch (error) {
      if (mine !== generation) return;
      if (error instanceof CollabCodeError && error.reason !== 'expired') {
        // A mistyped or wrong code leaves the invite usable: paste the right one.
        set({ stage: { ...stage, error: error.message } });
        return;
      }
      offer = null;
      logDiagnostic(error, { operation: 'collab-invite' });
      const message =
        error instanceof CollabCodeError
          ? error.message
          : // The transport names the reason it closed inside its message ("…before it opened (connect-timeout).").
            error instanceof Error && error.message.includes('connect-timeout')
            ? 'Couldn’t connect. On different networks, start the session with “Anyone with the link”; some office networks block direct connections entirely.'
            : 'Couldn’t connect with that code.';
      set({ stage: { kind: 'ready', role: stage.role, ...(stage.reuse === undefined ? {} : { reuse: stage.reuse }), link: stage.link, expiresAt: stage.expiresAt, error: `${message} Create a new invite to try again.`, spent: true } });
    }
  },

  cancel() {
    generation += 1;
    offer?.cancel();
    offer = null;
    set({ stage: { kind: 'idle' } });
  },
}));

// An invite belongs to the session it was made for: however the session ends — End session, another
// canvas opened, the tab closing — a half-finished invite goes with it, peer connection and all.
useCollabStore.subscribe((state, prev) => {
  if (prev.role === 'host' && state.role !== 'host') useInviteStore.getState().cancel();
});
