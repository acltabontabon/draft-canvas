import type { DraftDocument } from '../document/types';

export interface Selection {
  nodes: string[];
  edges: string[];
}

export const EMPTY_SELECTION: Selection = { nodes: [], edges: [] };

export interface HistoryEntry {
  label: string;
  before: DraftDocument;
  after: DraftDocument;
  selectionBefore: Selection;
  selectionAfter: Selection;
  at: number;
  /**
   * Entries sharing a key within the coalesce window collapse into one, so
   * typing a node's name is a single undo rather than one per keystroke.
   */
  coalesceKey?: string;
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
    entry.at - top.at < COALESCE_WINDOW_MS;

  if (canCoalesce) {
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

export function sameSelection(a: Selection, b: Selection): boolean {
  return (
    a.nodes.length === b.nodes.length &&
    a.edges.length === b.edges.length &&
    a.nodes.every((id, i) => b.nodes[i] === id) &&
    a.edges.every((id, i) => b.edges[i] === id)
  );
}
