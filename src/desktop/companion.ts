/**
 * The agent companion's conversations (desktop only): what the person asked on each diagram and what
 * their agent did about it, folded from the shell's `companion` events. In memory only — never saved,
 * undone or exported, like `agentActivity.ts`. The shell keeps which agent session to resume.
 *
 * No React here: `ui/Companion.tsx` reads it through `subscribe`/`snapshot`.
 */
import type { RunEvent, RunSnapshot, StopReason, ToolStatus, Usage } from './api';

export interface Step {
  id: string;
  /** The Draft Canvas tool name, or the agent's own name for anything else. */
  tool: string;
  status: ToolStatus;
  error: string | null;
}

export interface Turn {
  runId: string;
  /** What the person typed. */
  prompt: string;
  /** What the prompt was about, as the person saw it ("Orders database", "2 shapes"); null for the view. */
  about: string | null;
  steps: Step[];
  /** The agent's reply, as it streamed in. */
  reply: string;
  /** Null while the agent is working. */
  stop: StopReason | null;
  summary: string | null;
  costMicroUsd: number | null;
  /** The tokens the turn used, once it stopped and if the agent said. */
  usage: Usage | null;
  /** A proposal this turn submitted that is still waiting for review. */
  proposalId: string | null;
  /** What the person decided about the turn's proposal, once they have. */
  outcome: 'accepted' | 'rejected' | null;
}

export interface Conversation {
  diagramId: string;
  turns: Turn[];
  /** What turns no longer kept (past `KEEP_TURNS`) used, so the conversation's total stays whole. */
  earlier?: Spent;
}

/** What a conversation has used so far. */
export interface Spent {
  usage: Usage;
  costMicroUsd: number | null;
  /** Turns that reported their tokens. */
  turns: number;
}

/** Turns kept per diagram; the card shows the latest, and older ones only scroll. */
const KEEP_TURNS = 20;

/** Friendly words for each step, as the card lists them. */
const STEP_TEXT: Record<string, string> = {
  get_capabilities: 'Getting ready',
  read_diagram: 'Reading the diagram',
  read_selection: 'Looking at the selection',
  read_attachment: 'Reading a note',
  get_implementation_context: 'Reading the details',
  render_diagram: 'Checking how it looks',
  preview_diagram: 'Drafting the change',
  update_diagram: 'Changing the diagram',
  submit_proposal: 'Preparing a proposal',
  get_proposal: 'Checking the proposal',
  list_proposals: 'Checking proposals',
};

export function stepText(tool: string): string {
  return STEP_TEXT[tool] ?? tool;
}

export function newTurn(runId: string, prompt: string, about: string | null): Turn {
  return { runId, prompt, about, steps: [], reply: '', stop: null, summary: null, costMicroUsd: null, usage: null, proposalId: null, outcome: null };
}

function add(spent: Spent | null | undefined, turn: { usage: Usage | null; costMicroUsd: number | null }): Spent | null {
  if (!turn.usage) return spent ?? null;
  const usage = spent?.usage ?? { input: 0, cached: 0, output: 0 };
  return {
    usage: { input: usage.input + turn.usage.input, cached: usage.cached + turn.usage.cached, output: usage.output + turn.usage.output },
    costMicroUsd: turn.costMicroUsd === null ? (spent?.costMicroUsd ?? null) : (spent?.costMicroUsd ?? 0) + turn.costMicroUsd,
    turns: (spent?.turns ?? 0) + 1,
  };
}

/** What the conversation has used so far, its earlier turns included; null until a turn says. */
export function spentOn(conversation: Conversation | undefined): Spent | null {
  if (!conversation) return null;
  return conversation.turns.reduce<Spent | null>(add, conversation.earlier ?? null);
}

/** A part of the diagram the reply points at: `[[id]]`, as the brief asks the agent to write it. */
const PART = /\[\[([^\]\s]{1,120})\]\]/g;

/** The ids a piece of the reply points at, each once, in the order it names them. */
export function partsIn(text: string): string[] {
  return [...new Set([...text.matchAll(PART)].map((match) => match[1]!))];
}

/** A paragraph or bullet of the reply, with the number it is pinned on the canvas by, if it names a part. */
export interface ReplyEntry {
  text: string;
  /** The parts it names that are in the view on screen. */
  parts: string[];
  point: number | null;
}

export type NumberedBlock = { kind: 'p'; entry: ReplyEntry } | { kind: 'ul' | 'ol'; entries: ReplyEntry[] };

/** One pinned point: its number, and the parts on the canvas it is about. */
export interface ReplyPoint {
  point: number;
  parts: string[];
}

/**
 * The reply's blocks, each paragraph and bullet that names a part of the view numbered in reading
 * order: the bubble shows the numbers and the canvas pins them onto the parts, from this one count.
 * An id the view doesn't have (another view's, or one the agent got wrong) points at nothing.
 */
export function numberedBlocks(blocks: ReplyBlock[], known: (id: string) => boolean): NumberedBlock[] {
  let next = 0;
  const entry = (text: string): ReplyEntry => {
    const parts = partsIn(text).filter(known);
    return { text, parts, point: parts.length ? (next += 1) : null };
  };
  return blocks.map((block) => (block.kind === 'p' ? { kind: 'p', entry: entry(block.text) } : { kind: block.kind, entries: block.items.map(entry) }));
}

export function replyPoints(blocks: NumberedBlock[]): ReplyPoint[] {
  return blocks
    .flatMap((block) => (block.kind === 'p' ? [block.entry] : block.entries))
    .flatMap((entry) => (entry.point === null ? [] : [{ point: entry.point, parts: entry.parts }]));
}

/** "640", "4.8k", "48k", "1.2M": a count read at a glance, not exactly. */
export function tokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  // Rounded first, so 999,999 reads as "1M", never "1000k".
  if (Math.round(count / 1000) < 1000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * What a turn really added: everything it read and wrote, less what it read again from the cache. A
 * turn is many model calls, one per step, and each resends the whole context (the brief, the tools,
 * the diagram, the conversation); the cache serves that repeat at a discount (about a tenth of the price
 * with Claude), so a
 * total that counts it reads as many times what the turn cost.
 */
export function newTokens(usage: Usage): number {
  return Math.max(0, usage.input + usage.output - usage.cached);
}


/** One event folded into its turn. Pure: the same turn and event always give the same result. */
export function applyRunEvent(turn: Turn, event: RunEvent): Turn {
  if (turn.stop) return turn;
  switch (event.type) {
    case 'started':
      return turn;
    case 'message-chunk':
      return { ...turn, reply: turn.reply + event.text };
    case 'tool-call':
      if (turn.steps.some((step) => step.id === event.id)) return turn;
      return { ...turn, steps: [...turn.steps, { id: event.id, tool: event.tool, status: event.status, error: null }] };
    case 'tool-call-update':
      return {
        ...turn,
        steps: turn.steps.map((step) => (step.id === event.id ? { ...step, status: event.status, error: event.error } : step)),
      };
    case 'stopped':
      return {
        ...turn,
        stop: event.reason,
        summary: event.summary,
        costMicroUsd: event.costMicroUsd,
        usage: event.usage,
        // A step left open when the run ended didn't finish.
        steps: turn.steps.map((step) => (step.status === 'in-progress' ? { ...step, status: 'failed' as const } : step)),
      };
  }
}

export type ReplyBlock = { kind: 'p'; text: string } | { kind: 'ul' | 'ol'; items: string[] };

/**
 * A reply split into paragraphs and lists, the way an agent writes advice: a blank line ends a
 * paragraph, `-`, `*` or `•` starts a bullet, `1.` a numbered item, and a line under an item that
 * starts with neither carries it on.
 */
export function replyBlocks(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    const last = blocks.at(-1);
    if (!line) {
      flush();
    } else if (item) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      if (last && last.kind === kind && paragraph.length === 0) last.items.push(item[1]!);
      else blocks.push({ kind, items: [item[1]!] });
    } else if (last && last.kind !== 'p' && paragraph.length === 0 && /^\s/.test(raw)) {
      last.items[last.items.length - 1] += ` ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** The reply to show: what streamed in, or the agent's own summary when nothing did. */
export function replyOf(turn: Turn): string {
  return turn.reply.trim() || turn.summary?.trim() || '';
}

/** Words for a turn that ended without doing what was asked, or null. */
export function stopMessage(stop: StopReason | null): string | null {
  switch (stop?.kind) {
    case 'cancelled':
      return 'Stopped.';
    case 'max-turns':
      return 'The agent ran out of steps before it finished. Ask it to carry on, or narrow the request.';
    case 'refusal':
      return 'The agent declined this request.';
    case 'failed':
      return stop.message;
    default:
      return null;
  }
}

type Listener = () => void;

let conversations = new Map<string, Conversation>();
/** Which diagram each run belongs to. */
let runs = new Map<string, string>();
const listeners = new Set<Listener>();

function changed(): void {
  conversations = new Map(conversations);
  for (const listener of listeners) listener();
}

function update(runId: string, change: (turn: Turn) => Turn): void {
  const diagramId = runs.get(runId);
  const conversation = diagramId === undefined ? undefined : conversations.get(diagramId);
  if (!conversation || diagramId === undefined) return;
  const turns = conversation.turns.map((turn) => (turn.runId === runId ? change(turn) : turn));
  if (turns.every((turn, i) => turn === conversation.turns[i])) return;
  conversations.set(diagramId, { ...conversation, turns });
  changed();
}

export const companion = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },

  /** Every conversation by diagram id. A new map after every change, so it can be compared by identity. */
  snapshot(): ReadonlyMap<string, Conversation> {
    return conversations;
  },

  /** The person sent a prompt: a new turn, working until it stops. */
  begin(diagramId: string, runId: string, prompt: string, about: string | null): void {
    const conversation = conversations.get(diagramId) ?? { diagramId, turns: [] };
    const turns = [...conversation.turns, newTurn(runId, prompt, about)];
    // What a dropped turn used still counts: the total is the conversation's, not the kept turns'.
    const dropped = turns.slice(0, Math.max(0, turns.length - KEEP_TURNS));
    const earlier = dropped.reduce<Spent | null>(add, conversation.earlier ?? null);
    for (const turn of dropped) runs.delete(turn.runId);
    conversations.set(diagramId, { ...conversation, turns: turns.slice(-KEEP_TURNS), ...(earlier ? { earlier } : {}) });
    runs.set(runId, diagramId);
    changed();
  },

  apply(runId: string, event: RunEvent): void {
    update(runId, (turn) => applyRunEvent(turn, event));
  },

  /** The shell refused to start the run: it ends here, with the shell's reason. */
  fail(runId: string, message: string): void {
    update(runId, (turn) => applyRunEvent(turn, { type: 'stopped', reason: { kind: 'failed', message }, summary: null, costMicroUsd: null, usage: null }));
  },

  /** The turn submitted `proposalId`, waiting for review; null once it is resolved. */
  setProposal(runId: string, proposalId: string | null): void {
    update(runId, (turn) => (turn.proposalId === proposalId ? turn : { ...turn, proposalId }));
  },

  /** The person accepted or rejected the turn's proposal: it is no longer waiting. */
  resolve(runId: string, outcome: 'accepted' | 'rejected'): void {
    update(runId, (turn) => (turn.outcome === outcome && turn.proposalId === null ? turn : { ...turn, proposalId: null, outcome }));
  },

  diagramOf(runId: string): string | undefined {
    return runs.get(runId);
  },

  /** The run still working on `diagramId`, if any. */
  running(diagramId: string): Turn | null {
    return conversations.get(diagramId)?.turns.find((turn) => turn.stop === null) ?? null;
  },

  /** Runs a reloaded page found still going: their turns, rebuilt from what they have said. */
  restore(snapshots: RunSnapshot[]): void {
    if (snapshots.length === 0) return;
    for (const snapshot of snapshots) {
      if (runs.has(snapshot.runId)) continue;
      const turn = snapshot.events.reduce(applyRunEvent, newTurn(snapshot.runId, snapshot.prompt, null));
      const conversation = conversations.get(snapshot.diagramId) ?? { diagramId: snapshot.diagramId, turns: [] };
      conversations.set(snapshot.diagramId, { ...conversation, turns: [...conversation.turns, turn] });
      runs.set(snapshot.runId, snapshot.diagramId);
    }
    changed();
  },

  /** A new conversation on `diagramId`: the old turns go. A run still working keeps its turn. */
  clear(diagramId: string): void {
    const conversation = conversations.get(diagramId);
    if (!conversation) return;
    const working = conversation.turns.filter((turn) => turn.stop === null);
    for (const turn of conversation.turns) if (turn.stop !== null) runs.delete(turn.runId);
    if (working.length) conversations.set(diagramId, { ...conversation, turns: working });
    else conversations.delete(diagramId);
    changed();
  },

  /** Test seam. */
  __reset(): void {
    conversations = new Map();
    runs = new Map();
    listeners.clear();
  },
};
