/**
 * An agent's change to a diagram that wasn't open is written straight to its file (the shell does the
 * write, under the stamp it read). What the file held before and after is kept here — in memory, for
 * this session only — so that opening that file afterwards shows the change as one Undo step, exactly
 * as if it had been made with the file open.
 *
 * Only a file still exactly as the agent left it qualifies (same path, same stamp): anything written
 * since, by the person or another app, and the entry is simply never used. Bounded by count and by
 * size; the oldest goes first.
 */

export interface AgentWrite {
  displayPath: string;
  stamp: string;
  title: string;
  before: string;
  after: string;
}

const MAX_ENTRIES = 8;
/** Characters of before+after text kept in all, across entries. */
const MAX_CHARS = 16 * 1024 * 1024;

/** Worked out and gated, waiting for the shell to say the write happened. By request id. */
const pending = new Map<number, Omit<AgentWrite, 'displayPath' | 'stamp'>>();
/** Written, most recent last. */
let written: AgentWrite[] = [];

const size = (w: { before: string; after: string }) => w.before.length + w.after.length;

export function rememberPendingWrite(id: number, entry: Omit<AgentWrite, 'displayPath' | 'stamp'>): void {
  if (size(entry) > MAX_CHARS) return;
  pending.set(id, entry);
  while (pending.size > MAX_ENTRIES) pending.delete(pending.keys().next().value as number);
}

/** The shell wrote request `id`'s change: it is now `displayPath` at `stamp`. */
export function confirmWrite(id: number, displayPath: string, stamp: string): AgentWrite | undefined {
  const entry = pending.get(id);
  pending.delete(id);
  if (!entry) return undefined;
  const full: AgentWrite = { ...entry, displayPath, stamp };
  // A newer write to the same file replaces the older one: its "before" is the older one's "after".
  written = [...written.filter((w) => w.displayPath !== displayPath), full];
  while (written.length > MAX_ENTRIES || written.reduce((sum, w) => sum + size(w), 0) > MAX_CHARS) written.shift();
  return full;
}

/** Taken (once) when the file is opened exactly as the agent left it. */
export function takeWrite(displayPath: string, stamp: string): AgentWrite | undefined {
  const found = written.find((w) => w.displayPath === displayPath && w.stamp === stamp);
  if (found) written = written.filter((w) => w !== found);
  return found;
}

/** A request that never reached its write (refused, cancelled): nothing to remember. */
export function forgetPendingWrite(id: number): void {
  pending.delete(id);
}

/** Test seam. */
export function __resetAgentWrites(): void {
  pending.clear();
  written = [];
}
