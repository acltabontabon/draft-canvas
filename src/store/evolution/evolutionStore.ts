/**
 * What the editor shows about history: transient UI state, never saved, undone, shared or
 * exported. Written only by the history service (`service.ts`) and read by the status, the
 * timeline and the lens.
 *
 * The three things a person may care about are kept apart and never shown as one another:
 * - **saved** — the working copy is safe (autosave, the desktop file): not here, it is the save status;
 * - **captured** — a revision is in this device's history: `capture`;
 * - **published** — revisions are on a remote: `remote` (desktop only).
 */
import { create } from 'zustand';
import type { Oid } from '../../evolution/contracts';

export type CaptureState =
  /** History is off for this diagram, or for the device. */
  | { kind: 'off'; reason: 'device' | 'diagram' | 'shared' | 'guest' }
  /** History cannot be recorded here; why, in a sentence. */
  | { kind: 'unavailable'; message: string }
  /** Another tab records this diagram's history; this one shows it read-only. */
  | { kind: 'elsewhere' }
  /** Waiting for the person to say whether this copy continues an existing history. */
  | { kind: 'identity'; title: string; relation: 'moved' | 'copy' }
  | { kind: 'up-to-date' }
  | { kind: 'pending'; since: number }
  | { kind: 'capturing' }
  | { kind: 'failed'; message: string; quota: boolean; retryAt: number | null };

export type RemoteState =
  | { kind: 'none' }
  | { kind: 'not-published'; ahead: number }
  | { kind: 'publishing' }
  | { kind: 'published' }
  | { kind: 'incoming'; behind: number }
  | { kind: 'diverged' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

export interface EvolutionState {
  /** The working copy history is attached to, if any. */
  copyId: string | null;
  repoId: string | null;
  /** The alternative this copy is on; `null` is the primary architecture. */
  altId: string | null;
  altName: string | null;
  tip: Oid | null;
  tipAt: number | null;
  /** Revisions on this alternative, as far as is known (for the status line). */
  revisions: number;
  capture: CaptureState;
  remote: RemoteState;
  /** A notice to show once in the status popover, then never again on this device. */
  firstUse: boolean;
  /** An interrupted operation waits for the person: Resume or Keep current. */
  unfinished: { opId: string; kind: string; reason: string } | null;
  /** Bumped whenever history itself changed (a capture, a milestone, a switch), for views to reload. */
  changes: number;
  /** The timeline strip is open along the canvas's foot. */
  timelineOpen: boolean;
  /** The details popover of the status is open. */
  detailsOpen: boolean;
  /** Settings → History is open (the web shows it; the desktop forwards it to its Settings). */
  settingsOpen: boolean;
}

export const INITIAL_EVOLUTION: EvolutionState = {
  copyId: null,
  repoId: null,
  altId: null,
  altName: null,
  tip: null,
  tipAt: null,
  revisions: 0,
  capture: { kind: 'off', reason: 'device' },
  remote: { kind: 'none' },
  firstUse: false,
  unfinished: null,
  changes: 0,
  timelineOpen: false,
  detailsOpen: false,
  settingsOpen: false,
};

export const useEvolutionStore = create<EvolutionState>(() => INITIAL_EVOLUTION);
