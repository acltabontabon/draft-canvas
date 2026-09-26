import { samePath, viewOf } from '../depth/tree';
import type { DraftDocument } from '../document/types';

export interface Selection {
  nodes: string[];
  edges: string[];
}

export const EMPTY_SELECTION: Selection = { nodes: [], edges: [] };

/**
 * A snapshot of `editorStore`'s `selectedFlowId`/`flowPlayback` fields — mirrored
 * structurally here rather than imported from `store/editorStore.ts`, since that module already
 * imports this one (an import the other way would be circular). Deliberately *not* a general
 * mechanism: `flowPlayback`/`focus` are documented in `editorStore.ts` as "never pushed
 * to history" because playing or editing a flow is not itself an editorial action, and that stays
 * true — nothing here changes when playback starts/stops or which flow is selected. This exists
 * for exactly one case: `deleteFlow` forcibly clears these fields as a *side effect* of a document
 * edit that already gets a history entry, and undoing that edit should undo the side effect with
 * it. `HistoryEntry.flowSessionBefore`/`flowSessionAfter` stay `undefined` for every other entry.
 */
export interface FlowSessionSnapshot {
  selectedFlowId: string | null;
  flowPlayback: { active: boolean; flowId: string | null; step: number; phase?: 'request' | 'response' };
}

export interface HistoryEntry {
  label: string;
  /** Whole-file snapshots: an edit made inside a shape is still an edit to the one file. */
  before: DraftDocument;
  after: DraftDocument;
  /**
   * Which room the edit happened in (owner node ids from the file outward-in; empty at the
   * root). Undo restores the file and stands the user where the change was, rather than silently
   * changing something they cannot see — and two edits made in different rooms never coalesce,
   * however close together they were.
   */
  path: readonly string[];
  selectionBefore: Selection;
  selectionAfter: Selection;
  at: number;
  /**
   * Entries sharing a key within the coalesce window collapse into one, so
   * typing a node's name is a single undo rather than one per keystroke.
   */
  coalesceKey?: string;
  /** See `FlowSessionSnapshot`. Only ever set by `deleteFlow`. */
  flowSessionBefore?: FlowSessionSnapshot;
  flowSessionAfter?: FlowSessionSnapshot;
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

/** Deep enough for a long session, shallow enough to stay small in memory. */
export const HISTORY_LIMIT = 150;

const COALESCE_WINDOW_MS = 900;

/**
 * Snapshot-based history.
 *
 * Every document operation returns a new document that shares structure with
 * the previous one, so an entry costs roughly the objects that actually
 * changed — on the order of a kilobyte for a node move, even in a document with
 * a hundred nodes. Storing whole snapshots avoids maintaining a second, inverse
 * implementation of every operation, where a bug would silently corrupt a
 * user's diagram rather than merely being wrong on screen.
 */
export function pushEntry(
  history: HistoryState,
  entry: HistoryEntry,
): HistoryState {
  const top = history.past[history.past.length - 1];
  const canCoalesce =
    top !== undefined &&
    entry.coalesceKey !== undefined &&
    top.coalesceKey === entry.coalesceKey &&
    samePath(top.path, entry.path) &&
    entry.at - top.at < COALESCE_WINDOW_MS;

  if (canCoalesce) {
    // Typed and then erased, or a slider dragged away and back, inside one burst: the burst as a
    // whole changed nothing, so it shouldn't leave an undo step that does nothing.
    if (sameContent(top.before, entry.after, entry.path)) {
      return { past: history.past.slice(0, -1), future: [] };
    }
    const merged: HistoryEntry = {
      ...top,
      after: entry.after,
      selectionAfter: entry.selectionAfter,
      at: entry.at,
    };
    return { past: [...history.past.slice(0, -1), merged], future: [] };
  }

  const past = [...history.past, entry];
  // Any new action invalidates the redo branch.
  return { past: past.length > HISTORY_LIMIT ? past.slice(-HISTORY_LIMIT) : past, future: [] };
}

/**
 * Whether two files hold the same content, as seen from the room the burst was typed in.
 *
 * Operations share structure, so almost everything compares by identity and only the few rebuilt
 * objects are walked; the depth bound keeps a pathological document from making a keystroke
 * expensive (deeper differences count as changes). Comparing the *room* rather than the file is
 * what keeps that bound meaningful at depth — an edit three rooms down sits below it, so two
 * files would always look different and typing-then-erasing inside would leave a dead step.
 */
function sameContent(a: DraftDocument, b: DraftDocument, path: readonly string[]): boolean {
  const viewA = viewOf(a, path);
  const viewB = viewOf(b, path);
  if (!viewA || !viewB) return false;
  return (
    a.metadata.title === b.metadata.title &&
    // What the room says it shows is content like anything else. `shallowEqualDocument` already
    // treats it that way, and a burst that ended by changing only the level would otherwise look
    // like a burst that changed nothing and be thrown away.
    viewA.level === viewB.level &&
    viewA.viewport === viewB.viewport &&
    equivalent(viewA.nodes, viewB.nodes, 4) &&
    equivalent(viewA.edges, viewB.edges, 4) &&
    equivalent(viewA.flows, viewB.flows, 4) &&
    equivalent(a.settings, b.settings, 4) &&
    // Read off the file, not the view, because open points are root-only — and compared for the same
    // reason the rest of this is: a point's context typed and erased again within the coalesce
    // window has to come out as a burst that changed nothing, not a dead undo step.
    equivalent(a.openPoints, b.openPoints, 5)
  );
}

function equivalent(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (key) => Object.hasOwn(b, key) && equivalent((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth - 1),
  );
}

export function undo(history: HistoryState): {
  history: HistoryState;
  entry: HistoryEntry | null;
} {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { history, entry: null };
  return {
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
    entry,
  };
}

export function redo(history: HistoryState): {
  history: HistoryState;
  entry: HistoryEntry | null;
} {
  const entry = history.future[0];
  if (!entry) return { history, entry: null };
  return {
    history: { past: [...history.past, entry], future: history.future.slice(1) },
    entry,
  };
}

export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}
