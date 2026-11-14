/**
 * When each participant is working: the bars on the lifelines.
 *
 * Worked out from what the messages say (`SeqMessage.activate` / `deactivate`), never stored and
 * never guessed from a message's kind — the kind only chooses what a new message starts with.
 *
 * Branches are read the way they run. Each branch of an `alt` or a `par` starts from what was
 * running when the fragment began, so "the call returns in either branch" is one bar ended twice,
 * not a second end with nothing left to end — which is what a flat top-to-bottom reading makes of
 * it, and why other tools reject the most ordinary success/failure diagram.
 */
import { isBranching } from '../document/sequenceModel';
import type { DraftSequence, SeqItem } from '../document/types';

export interface Execution {
  participantId: string;
  /** The message whose arrival starts it. */
  startId: string;
  /** The message that ends it, or the last message its participant takes part in. */
  endId: string;
  /** `'at'`: ended by `endId` leaving. `'after'`: never ended, so drawn to just past `endId`. */
  ends: 'at' | 'after';
  /** How many bars were already running on this lifeline when it began. */
  depth: number;
}

export interface ExecutionPlan {
  executions: Execution[];
  /** Messages that end their sender's work when it had none running. */
  unmatched: string[];
}

interface Running {
  participantId: string;
  startId: string;
  endId: string | null;
  ends: 'at' | 'after';
  depth: number;
}

type Stacks = Map<string, Running[]>;

interface State {
  all: Running[];
  unmatched: string[];
}

const stackOf = (stacks: Stacks, participantId: string): Running[] => {
  let stack = stacks.get(participantId);
  if (!stack) {
    stack = [];
    stacks.set(participantId, stack);
  }
  return stack;
};

/**
 * Reads one list top to bottom. Answers the last message each participant took part in here,
 * which is where a bar this list started and never ended is drawn to.
 */
function read(items: readonly SeqItem[], stacks: Stacks, state: State): Map<string, string> {
  const touched = new Map<string, string>();
  const opened: Running[] = [];

  for (const item of items) {
    if (item.t === 'message') {
      touched.set(item.from, item.id);
      touched.set(item.to, item.id);
      if (item.deactivate) {
        const top = stackOf(stacks, item.from).pop();
        if (top) {
          top.endId = item.id;
          top.ends = 'at';
        } else {
          state.unmatched.push(item.id);
        }
      }
      if (item.kind === 'destroy') {
        // Nothing runs on a lifeline that has ended.
        for (const running of stackOf(stacks, item.to)) {
          running.endId = item.id;
          running.ends = 'at';
        }
        stacks.set(item.to, []);
      } else if (item.activate) {
        const stack = stackOf(stacks, item.to);
        const running: Running = { participantId: item.to, startId: item.id, endId: null, ends: 'after', depth: stack.length };
        stack.push(running);
        opened.push(running);
        state.all.push(running);
      }
      continue;
    }
    if (item.t !== 'fragment' || item.operands.length === 0) continue;

    if (!isBranching(item.operator)) {
      for (const [participantId, id] of read(item.operands[0]!.items, stacks, state)) touched.set(participantId, id);
      continue;
    }
    const entry = new Map([...stacks].map(([participantId, stack]) => [participantId, stack.slice()] as const));
    for (const branch of item.operands) {
      const local: Stacks = new Map([...entry].map(([participantId, stack]) => [participantId, stack.slice()] as const));
      for (const [participantId, id] of read(branch.items, local, state)) touched.set(participantId, id);
    }
    // Ended in any branch is ended: the bar runs to the last place a branch ends it.
    stacks.clear();
    for (const [participantId, stack] of entry) stacks.set(participantId, stack.filter((running) => running.endId === null));
  }

  for (const running of opened) {
    if (running.endId !== null) continue;
    running.endId = touched.get(running.participantId) ?? running.startId;
    running.ends = 'after';
    const stack = stacks.get(running.participantId);
    if (stack) stacks.set(running.participantId, stack.filter((other) => other !== running));
  }
  return touched;
}

const plans = new WeakMap<DraftSequence, ExecutionPlan>();

export function executionsOf(sequence: DraftSequence): ExecutionPlan {
  const cached = plans.get(sequence);
  if (cached) return cached;
  const state: State = { all: [], unmatched: [] };
  read(sequence.items, new Map(), state);
  const plan: ExecutionPlan = {
    executions: state.all.map((running) => ({
      participantId: running.participantId,
      startId: running.startId,
      endId: running.endId ?? running.startId,
      ends: running.ends,
      depth: running.depth,
    })),
    unmatched: state.unmatched,
  };
  plans.set(sequence, plan);
  return plan;
}
