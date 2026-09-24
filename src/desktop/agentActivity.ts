/**
 * What AI agents are doing right now, for the person watching (desktop only): one entry per request
 * that changes a diagram, from the moment the page takes it until it is answered. In memory only — a
 * reload forgets every entry, which is right, since the requests it describes are gone with it.
 *
 * - **Quiet when quick.** An entry is only shown after `SHOW_AFTER_MS`, so a request that finishes
 *   sooner just appears finished — nothing flashes, and nothing is ever slowed down to be seen.
 * - **In order.** Progress is numbered by the job that sends it; anything older than what was
 *   already taken (a late or duplicated message) is dropped.
 * - **Bounded.** One candidate per entry (the latest), and at most `MAX_ENTRIES` entries.
 *
 * Nothing here ever reaches the document, its history or autosave: a candidate is a picture of what
 * an agent is preparing, drawn on top (`uiStore.agentPreview`, `AgentActivity.tsx`), and discarded
 * with the entry.
 */

import type { Candidate, Stage } from '../agent/progress';
import type { Progress } from '../agent/offThread';
import { useUiStore } from '../store/uiStore';

export const SHOW_AFTER_MS = 300;
const MAX_ENTRIES = 4;

/** Where the change is going: a new file, the diagram on screen, or one that isn't open. */
export type AgentTarget = 'new' | 'open' | 'file';

export interface AgentOp {
  /** The bridge's request id: the one `agentCancel` takes. */
  id: number;
  tool: 'create_diagram' | 'update_diagram';
  title: string;
  target: AgentTarget;
  /** The view being changed, for a preview on the open diagram. */
  path: readonly string[];
  stage: Stage;
  seq: number;
  startedAt: number;
  /** Past `SHOW_AFTER_MS` and still working. */
  shown: boolean;
  /** Its candidate is on screen (the generation view for a new or closed diagram). */
  watching: boolean;
  /** Re-frame the view on every new candidate. Off by default: the camera is the person's. */
  follow: boolean;
  /** Past its commit gate: too late to cancel — Undo is the way back now. */
  applying: boolean;
  /** The person asked to cancel it; the gate will refuse it. */
  cancelling: boolean;
  candidate?: Candidate;
}

type Listener = () => void;

let ops: AgentOp[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(next: AgentOp[]): void {
  ops = next;
  for (const listener of listeners) listener();
  syncPreview();
}

function patch(id: number, change: Partial<AgentOp>): void {
  if (!ops.some((op) => op.id === id)) return;
  emit(ops.map((op) => (op.id === id ? { ...op, ...change } : op)));
}

/** The provisional layer on the canvas: the latest candidate of a change to the open diagram. */
function syncPreview(): void {
  const current = ops.find((op) => op.target === 'open' && op.shown && op.candidate && !op.cancelling);
  const ui = useUiStore.getState();
  if (!current) {
    if (ui.agentPreview) ui.setAgentPreview(null);
    return;
  }
  if (ui.agentPreview?.opId === current.id && ui.agentPreview.seq === current.seq) return;
  ui.setAgentPreview({ opId: current.id, seq: current.seq, path: current.path, nodes: current.candidate!.nodes, edges: current.candidate!.edges });
}

export const agentActivity = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  snapshot(): readonly AgentOp[] {
    return ops;
  },

  /** A request the page has taken. `reveal`: the generation view may open by itself (see `agent.ts`). */
  begin(op: Pick<AgentOp, 'id' | 'tool' | 'title' | 'target' | 'path'>, reveal = false): void {
    const entry: AgentOp = { ...op, stage: 'preparing', seq: 0, startedAt: Date.now(), shown: false, watching: false, follow: false, applying: false, cancelling: false };
    const kept = [...ops.filter((o) => o.id !== op.id), entry];
    for (const dropped of kept.slice(0, Math.max(0, kept.length - MAX_ENTRIES))) clearTimeout(timers.get(dropped.id));
    emit(kept.slice(-MAX_ENTRIES));
    timers.set(
      op.id,
      setTimeout(() => {
        timers.delete(op.id);
        patch(op.id, { shown: true, ...(reveal && op.target !== 'open' ? { watching: true } : {}) });
      }, SHOW_AFTER_MS),
    );
  },

  progress(id: number, progress: Progress): void {
    const op = ops.find((o) => o.id === id);
    if (!op || progress.seq <= op.seq || op.applying) return;
    patch(id, { seq: progress.seq, stage: progress.stage, ...(progress.candidate ? { candidate: progress.candidate } : {}) });
  },

  /** Past the gate: the change is being applied and can no longer be cancelled. */
  applying(id: number): void {
    patch(id, { applying: true, stage: 'finishing' });
  },

  /** Answered, one way or another: gone, and its preview with it. */
  end(id: number): void {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (ops.some((op) => op.id === id)) emit(ops.filter((op) => op.id !== id));
  },

  watch(id: number, watching: boolean): void {
    patch(id, { watching });
  },

  follow(id: number, follow: boolean): void {
    patch(id, { follow });
  },

  cancelling(id: number): void {
    patch(id, { cancelling: true });
  },

  /** Test seam. */
  __reset(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    emit([]);
  },
};
