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
import type { DepthPath } from '../../depth/tree';
import type { DraftDocument } from '../../document/types';
import type { Oid } from '../../evolution/contracts';
import type { SemanticDiff } from '../../evolution/diff';
import type { Revision, RevisionQuery } from '../../evolution/timeline';

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
  timeline: TimelineState;
  /** A past revision on screen in place of the live diagram, privately and read-only. */
  lens: LensState | null;
  playback: PlaybackState;
  /** Two versions compared on the canvas, while the person looks. */
  compare: CompareState | null;
}

export interface CompareSide {
  /** A revision, or `'now'`: the live diagram as it was when the comparison began. */
  oid: Oid | 'now';
  label: string;
  file: DraftDocument;
}

export interface CompareState {
  /** The earlier side. */
  base: CompareSide;
  /** The later side. */
  target: CompareSide;
  diff: SemanticDiff;
  mode: 'overlay' | 'split';
  /** In overlay mode: which side is drawn, with the other's differences marked on it. */
  side: 'after' | 'before';
  /** Only additions, removals and changes of structure, relationships, grouping and links. */
  structuralOnly: boolean;
  /** The change the camera was last taken to, for the list to show. */
  focused: string | null;
}

export interface TimelineState {
  revisions: Revision[];
  loading: boolean;
  error: string | null;
  /** More, older revisions exist than are loaded. */
  more: boolean;
  query: RevisionQuery;
}

export interface LensState {
  /** The revision shown; `'live'` while the lens is easing back to the live diagram before it closes. */
  oid: Oid | 'live';
  /** The whole file of that revision (its history content). */
  file: DraftDocument;
  /** What was on screen before this, for the transition between them. */
  previous: DraftDocument | null;
  /** The room shown, inside the revision. */
  path: DepthPath;
  /** Increases with every change of what is shown: a transition belongs to one value of it. */
  step: number;
  /** A room or Junction the revision does not have, when navigation asked for one. */
  missing: string | null;
}

export interface PlaybackState {
  playing: boolean;
  /** Revisions per second, roughly: 0.5, 1 or 2. */
  speed: 0.5 | 1 | 2;
  /** Move the camera to what changed. */
  focus: boolean;
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
  timeline: { revisions: [], loading: false, error: null, more: false, query: {} },
  lens: null,
  playback: { playing: false, speed: 1, focus: true },
  compare: null,
};

export const useEvolutionStore = create<EvolutionState>(() => INITIAL_EVOLUTION);
