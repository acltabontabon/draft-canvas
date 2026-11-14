/**
 * What Draft Canvas can offer about a message from what it already knows about its ends.
 *
 * Sequence messages use the canvas's relationship table for editable default captions and kind
 * suggestions. Specific endpoints, events and responses come from what people write.
 */
import { categoryOf, defaultsToResponse, inferRelationship, type NodeCategory } from '../document/connectorSemantics';
import { relationLabel } from '../document/edgeSemantics';
import { messagesOf, slotOf, type SeqSlot } from '../document/sequenceModel';
import type { DraftEdge, DraftSequence, SeqMessage, SeqMessageKind, SeqParticipant } from '../document/types';
import { executionsOf } from './executions';

const participantOf = (sequence: DraftSequence, id: string): SeqParticipant | undefined => sequence.participants.find((participant) => participant.id === id);

/** The same editable caption a connector between these shapes would start with. */
export function defaultMessageLabel(sequence: DraftSequence, message: Pick<SeqMessage, 'from' | 'to'> & Partial<Pick<SeqMessage, 'kind'>>): string {
  if (message.from === message.to || message.kind === 'reply' || message.kind === 'create' || message.kind === 'destroy') return '';
  const from = participantOf(sequence, message.from);
  const to = participantOf(sequence, message.to);
  if (!from || !to) return '';
  const semantic = inferRelationship(from, to)?.semantic;
  return semantic ? relationLabel(semantic, categoryOf(from), categoryOf(to)) : '';
}

/** How a category is spoken of in a reason: the word a person would use for that end. */
const CATEGORY_WORDS: Partial<Record<NodeCategory, string>> = {
  queue: 'a queue',
  topic: 'a topic',
  stream: 'a stream',
  deadLetter: 'a dead-letter queue',
};

/**
 * A different kind this message would usually be, with why — or null when there is nothing to
 * suggest. Only ever for a plain call nobody has chosen the kind of.
 */
export function suggestedKind(sequence: DraftSequence, message: SeqMessage): { kind: SeqMessageKind; reason: string } | null {
  if (message.kind !== 'sync' || message.kindOrigin === 'explicit' || message.from === message.to) return null;
  const from = participantOf(sequence, message.from);
  const to = participantOf(sequence, message.to);
  if (!from || !to) return null;
  // What the canvas would draw between two such shapes: dashed for a message sent and not waited
  // for, or an event published — either way, not a call.
  const usual = inferRelationship(from, to);
  if (!(usual?.async || usual?.kind === 'async' || usual?.kind === 'event')) return null;
  const sender = CATEGORY_WORDS[categoryOf(from)];
  const receiver = CATEGORY_WORDS[categoryOf(to)];
  const name = (participant: SeqParticipant) => participant.name.trim() || 'This participant';
  const reason = receiver
    ? `${name(to)} is ${receiver}: whoever sends to it does not usually wait.`
    : sender
      ? `${name(from)} is ${sender}: what it delivers is not usually waited for.`
      : 'Between these two, a message is not usually waited for.';
  return { kind: 'async', reason };
}

/**
 * Words a message between these two could start from — only ever words somebody already wrote:
 * the labels of connectors drawn between the shapes the two stand for (and, the other way round, a
 * connector's reply), then what has already been said between them in this sequence. Nothing is
 * made up: no endpoint, no event name, not even a generic verb. With nothing written down, nothing
 * is offered.
 */
export function labelSuggestions(
  sequence: DraftSequence,
  message: Pick<SeqMessage, 'from' | 'to'> & Partial<Pick<SeqMessage, 'id'>>,
  edges: readonly Pick<DraftEdge, 'source' | 'target' | 'label' | 'response'>[],
): string[] {
  const from = participantOf(sequence, message.from);
  const to = participantOf(sequence, message.to);
  if (!from || !to) return [];
  const out: string[] = [];
  const add = (text: string | undefined) => {
    const clean = text?.replace(/\s+/g, ' ').trim();
    if (clean && !out.some((existing) => existing.toLowerCase() === clean.toLowerCase())) out.push(clean);
  };
  if (from.ref && to.ref) {
    for (const edge of edges) {
      if (edge.source === from.ref && edge.target === to.ref) add(edge.label);
      // The other way round, a connector's reply is what comes back along it.
      if (edge.source === to.ref && edge.target === from.ref) add(edge.response);
    }
  }
  for (const other of messagesOf(sequence)) {
    if (other.id !== message.id && other.from === message.from && other.to === message.to) add(other.label);
  }
  return out.slice(0, 5);
}

export interface NextMessage {
  from: string;
  to: string;
  kind: SeqMessageKind;
  replyTo?: string;
  slot: SeqSlot;
  /** A few words saying what it is: "Reply to Client". */
  title: string;
}

/**
 * What usually comes after a message, most likely first: its reply (when these two usually answer
 * each other, or it started work), the receiver calling on to the next participant, the receiver
 * doing something itself. Shown as a ghost; nothing is added until one is accepted.
 */
/** What a participant with nothing else selected would most likely do next: call a neighbour, or itself, at the end. */
export function nextFromParticipant(sequence: DraftSequence, participantId: string): NextMessage[] {
  const index = sequence.participants.findIndex((participant) => participant.id === participantId);
  const from = sequence.participants[index];
  if (!from) return [];
  const slot: SeqSlot = { operandId: null, index: sequence.items.length };
  const name = (participant: SeqParticipant) => participant.name.trim() || 'unnamed';
  const options: NextMessage[] = [];
  for (const other of [sequence.participants[index + 1], sequence.participants[index - 1]]) {
    if (other) options.push({ from: from.id, to: other.id, kind: 'sync', slot, title: `${name(from)} calls ${name(other)}` });
  }
  options.push({ from: from.id, to: from.id, kind: 'sync', slot, title: `${name(from)} does something itself` });
  return options;
}

/** The next messages on offer for whatever one thing is selected inside a sequence. */
export function nextFor(sequence: DraftSequence, focus: { kind: string; ids: readonly string[] }): NextMessage[] {
  if (focus.ids.length !== 1) return [];
  if (focus.kind === 'participant') return nextFromParticipant(sequence, focus.ids[0]!);
  if (focus.kind === 'item') return nextMessages(sequence, focus.ids[0]!);
  return [];
}

export function nextMessages(sequence: DraftSequence, messageId: string): NextMessage[] {
  const message = messagesOf(sequence).find((entry) => entry.id === messageId);
  const at = slotOf(sequence, messageId);
  if (!message || !at) return [];
  const slot: SeqSlot = { operandId: at.operandId, index: at.index + 1 };
  const from = participantOf(sequence, message.from);
  const to = participantOf(sequence, message.to);
  if (!from || !to) return [];
  const name = (participant: SeqParticipant) => participant.name.trim() || 'unnamed';
  const options: NextMessage[] = [];

  // After a reply, what is left to do is answer whoever is still waiting on its receiver: the call
  // that set the receiver working and has had no reply yet.
  if (message.kind === 'reply') {
    const waiting = executionsOf(sequence)
      .executions.filter((execution) => execution.participantId === message.to && execution.ends === 'after')
      .sort((a, b) => b.depth - a.depth)[0];
    const call = waiting ? messagesOf(sequence).find((entry) => entry.id === waiting.startId) : undefined;
    const caller = call ? participantOf(sequence, call.from) : undefined;
    if (call && caller && call.from !== call.to && !messagesOf(sequence).some((entry) => entry.replyTo === call.id)) {
      options.push({ from: call.to, to: call.from, kind: 'reply', replyTo: call.id, slot, title: `Reply to ${name(caller)}` });
    }
    return options;
  }

  const replied = messagesOf(sequence).some((entry) => entry.replyTo === message.id);
  const reply: NextMessage | null =
    message.kind === 'sync' && message.from !== message.to && !replied
      ? { from: message.to, to: message.from, kind: 'reply', replyTo: message.id, slot, title: `Reply to ${name(from)}` }
      : null;
  let onward: NextMessage | null = null;
  let itself: NextMessage | null = null;
  if (message.kind !== 'destroy') {
    const index = sequence.participants.findIndex((participant) => participant.id === to.id);
    const direction = index >= sequence.participants.findIndex((participant) => participant.id === from.id) ? 1 : -1;
    const next = sequence.participants[index + direction];
    if (next && next.id !== from.id && next.id !== to.id) {
      onward = { from: to.id, to: next.id, kind: 'sync', slot, title: `${name(to)} calls ${name(next)}` };
    }
    itself = { from: to.id, to: to.id, kind: 'sync', slot, title: `${name(to)} does something itself` };
  }
  // Two that usually answer each other, or a receiver with nobody further along to call: the reply
  // first. Otherwise the receiver calling on. Doing something itself is always the last of them.
  const replyFirst = defaultsToResponse(categoryOf(from), categoryOf(to)) || !onward;
  const ordered = replyFirst ? [reply, onward, itself] : [onward, reply, itself];
  for (const option of ordered) if (option) options.push(option);
  return options;
}
