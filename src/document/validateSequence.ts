/**
 * A sequence read from somewhere it cannot be trusted: a file, the clipboard, another person's
 * edit. Like the rest of the importer it repairs rather than refuses — a message to a participant
 * that is not there is dropped, a fragment nested too deep is opened out and its messages kept —
 * and it never reads more than `LIMITS` allows, whatever it is handed.
 */
import { parseAttachments } from './validateAttachments';
import { createId } from './ids';
import { LIMITS } from './limits';
import { cleanText } from './sanitize';
import { isBranching } from './sequenceModel';
import {
  ACCENTS,
  ACTOR_KINDS,
  C4_TEXT_TYPES,
  COMPONENT_KINDS,
  DATABASE_KINDS,
  DELIVERY_ROLES,
  QUEUE_KINDS,
  SEQ_MESSAGE_KINDS,
  SEQ_NOTE_SIDES,
  SEQ_OPERATORS,
  SERVICE_KINDS,
  type Accent,
  type DraftSequence,
  type SeqFragment,
  type SeqGroup,
  type SeqItem,
  type SeqMessage,
  type SeqMessageKind,
  type SeqNote,
  type SeqNoteSide,
  type SeqOperand,
  type SeqOperator,
  type SeqParticipant,
  type SeqParticipantType,
} from './types';
import { isRecord } from '../lib/isRecord';

export interface NormalizedSequence {
  sequence: DraftSequence;
  /** Messages, notes, fragments, participants and groups that could not be kept. */
  dropped: number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

const words = (value: unknown, max: number): string => (typeof value === 'string' ? cleanText(value, max) : '');

/** One line: a name or a guard never holds a line break. */
const line = (value: unknown, max: number): string => words(value, max).replace(/\s+/g, ' ').trim();

function idOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.maxIdLength) return null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return trimmed;
}

export function normalizeParticipant(raw: unknown, id: string): SeqParticipant | null {
  if (!isRecord(raw)) return null;
  const type = oneOf<SeqParticipantType>(raw.type, C4_TEXT_TYPES) ?? 'service';
  const participant: SeqParticipant = { id, name: line(raw.name, LIMITS.maxSequenceNameLength), type };
  if (type === 'service') participant.serviceKind = oneOf(raw.serviceKind, SERVICE_KINDS) ?? 'generic';
  if (type === 'database') participant.databaseKind = oneOf(raw.databaseKind, DATABASE_KINDS) ?? 'generic';
  if (type === 'queue') {
    participant.queueKind = oneOf(raw.queueKind, QUEUE_KINDS) ?? 'queue';
    const role = oneOf(raw.deliveryRole, DELIVERY_ROLES);
    if (role) participant.deliveryRole = role;
  }
  if (type === 'actor') participant.actorKind = oneOf(raw.actorKind, ACTOR_KINDS) ?? 'human';
  if (type === 'component') participant.componentKind = oneOf(raw.componentKind, COMPONENT_KINDS) ?? 'generic';
  const technology = line(raw.technology, LIMITS.maxTechnologyLength);
  if (technology) participant.technology = technology;
  if (technology && raw.kindOrigin === 'technology' && (type === 'service' || type === 'database' || type === 'queue')) {
    participant.kindOrigin = 'technology';
  }
  const accent = oneOf<Accent>(raw.accent, ACCENTS);
  if (accent) participant.accent = accent;
  const ref = idOf(raw.ref);
  if (ref) participant.ref = ref;
  return participant;
}

interface Reading {
  participants: ReadonlySet<string>;
  /** Every id handed out so far, so no two things in one sequence share one. */
  seen: Set<string>;
  /** Items kept so far, against `maxSequenceItems`. */
  kept: number;
  dropped: number;
}

function freshId(raw: unknown, prefix: string, reading: Reading): string {
  let id = idOf(raw);
  if (!id || reading.seen.has(id)) id = createId(prefix);
  reading.seen.add(id);
  return id;
}

function knownParticipants(raw: unknown, reading: Reading): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw.slice(0, LIMITS.maxSequenceParticipants * 2)) {
    if (typeof entry === 'string' && reading.participants.has(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function readMessage(raw: Record<string, unknown>, reading: Reading): SeqMessage | null {
  const from = typeof raw.from === 'string' ? raw.from : '';
  const to = typeof raw.to === 'string' ? raw.to : '';
  if (!reading.participants.has(from) || !reading.participants.has(to)) return null;
  const kind = oneOf<SeqMessageKind>(raw.kind, SEQ_MESSAGE_KINDS) ?? 'sync';
  const message: SeqMessage = {
    id: freshId(raw.id, 'sm', reading),
    t: 'message',
    from,
    to,
    kind,
    label: words(raw.label, LIMITS.maxLabelLength),
  };
  if (Array.isArray(raw.attachments)) {
    const { attachments, dropped, truncated } = parseAttachments(raw.attachments, LIMITS.maxAttachmentsPerEdge);
    if (attachments.length) message.attachments = attachments;
    reading.dropped += dropped + truncated;
  }
  // Checked against the finished list afterwards: the call may come later in the file than its reply.
  if (kind === 'reply' && typeof raw.replyTo === 'string') message.replyTo = raw.replyTo;
  if (raw.activate === true) message.activate = true;
  if (raw.deactivate === true) message.deactivate = true;
  if (raw.kindOrigin === 'explicit') message.kindOrigin = 'explicit';
  return message;
}

function readNote(raw: Record<string, unknown>, reading: Reading): SeqNote | null {
  const over = knownParticipants(raw.over, reading);
  if (over.length === 0) return null;
  const note: SeqNote = {
    id: freshId(raw.id, 'sn', reading),
    t: 'note',
    text: words(raw.text, LIMITS.maxSequenceNoteLength),
    over,
  };
  const side = oneOf<SeqNoteSide>(raw.side, SEQ_NOTE_SIDES);
  if (side) note.side = side;
  return note;
}

/**
 * A fragment, or — past the depth limit — the items it held, so that opening a file nested too deep
 * loses the frames and never the messages.
 */
function readFragment(raw: Record<string, unknown>, reading: Reading, depth: number): SeqItem[] {
  const operator = oneOf<SeqOperator>(raw.operator, SEQ_OPERATORS) ?? 'opt';
  const rawOperands = Array.isArray(raw.operands) ? raw.operands.filter(isRecord) : [];

  if (depth >= LIMITS.maxSequenceDepth) {
    reading.dropped += 1;
    return rawOperands.flatMap((branch) => readItems(branch.items, reading, depth));
  }

  const fragment: SeqFragment = { id: freshId(raw.id, 'sf', reading), t: 'fragment', operator, operands: [] };
  reading.kept += 1;

  if (operator === 'ref') {
    const label = line(raw.label, LIMITS.maxLabelLength);
    if (label) fragment.label = label;
    const covers = knownParticipants(raw.covers, reading);
    if (covers.length > 0) fragment.covers = covers;
    return [fragment];
  }

  const operands: SeqOperand[] = [];
  for (const branch of rawOperands.slice(0, LIMITS.maxSequenceOperands)) {
    const operand: SeqOperand = { id: freshId(branch.id, 'so', reading), items: readItems(branch.items, reading, depth + 1) };
    const guard = line(branch.guard, LIMITS.maxConditionLength);
    if (guard) operand.guard = guard;
    operands.push(operand);
  }
  if (operands.length === 0) operands.push({ id: freshId(undefined, 'so', reading), items: [] });
  if (!isBranching(operator) && operands.length > 1) {
    // One branch only: the others' messages move into it rather than vanish.
    const [first, ...rest] = operands;
    first!.items = [...first!.items, ...rest.flatMap((branch) => branch.items)];
    operands.length = 1;
  }
  fragment.operands = operands;
  return [fragment];
}

function readItems(raw: unknown, reading: Reading, depth: number): SeqItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SeqItem[] = [];
  for (const entry of raw) {
    if (reading.kept >= LIMITS.maxSequenceItems) {
      reading.dropped += 1;
      continue;
    }
    if (!isRecord(entry)) {
      reading.dropped += 1;
      continue;
    }
    if (entry.t === 'fragment') {
      items.push(...readFragment(entry, reading, depth));
      continue;
    }
    const item = entry.t === 'message' ? readMessage(entry, reading) : entry.t === 'note' ? readNote(entry, reading) : null;
    if (!item) {
      reading.dropped += 1;
      continue;
    }
    reading.kept += 1;
    items.push(item);
  }
  return items;
}

/** Replies whose call is not in the sequence answer nothing in particular. */
function dropLostReplies(items: SeqItem[], messageIds: ReadonlySet<string>): void {
  for (const item of items) {
    if (item.t === 'message') {
      if (item.replyTo !== undefined && (!messageIds.has(item.replyTo) || item.replyTo === item.id)) delete item.replyTo;
    } else if (item.t === 'fragment') {
      for (const branch of item.operands) dropLostReplies(branch.items, messageIds);
    }
  }
}

function collectMessageIds(items: readonly SeqItem[], into: Set<string>): void {
  for (const item of items) {
    if (item.t === 'message') into.add(item.id);
    else if (item.t === 'fragment') for (const branch of item.operands) collectMessageIds(branch.items, into);
  }
}

/**
 * Groups as the drawing needs them: each member a real participant, in no other group, and standing
 * next to the group's other members. A member that is not is left out of the group, not moved.
 */
export function normalizeGroups(raw: unknown, participants: readonly SeqParticipant[], seen: Set<string>): { groups: SeqGroup[]; dropped: number } {
  const groups: SeqGroup[] = [];
  let dropped = 0;
  if (!Array.isArray(raw)) return { groups, dropped };
  const order = new Map(participants.map((participant, index) => [participant.id, index]));
  const taken = new Set<string>();
  for (const entry of raw.slice(0, LIMITS.maxSequenceGroups * 2)) {
    if (!isRecord(entry) || groups.length >= LIMITS.maxSequenceGroups) {
      dropped += 1;
      continue;
    }
    const members = (Array.isArray(entry.participantIds) ? entry.participantIds : [])
      .filter((id): id is string => typeof id === 'string' && order.has(id) && !taken.has(id))
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort((a, b) => order.get(a)! - order.get(b)!);
    // The run that starts at the first member; anything after a gap is no longer beside it.
    const run: string[] = [];
    for (const id of members) {
      if (run.length > 0 && order.get(id)! !== order.get(run[run.length - 1]!)! + 1) break;
      run.push(id);
    }
    if (run.length === 0) {
      dropped += 1;
      continue;
    }
    let id = idOf(entry.id);
    if (!id || seen.has(id)) id = createId('sg');
    seen.add(id);
    for (const member of run) taken.add(member);
    const group: SeqGroup = { id, name: line(entry.name, LIMITS.maxSequenceNameLength), participantIds: run };
    const accent = oneOf<Accent>(entry.accent, ACCENTS);
    if (accent) group.accent = accent;
    groups.push(group);
  }
  return { groups, dropped };
}

export function normalizeSequence(raw: unknown): NormalizedSequence {
  const ids = new Set<string>();
  const reading: Reading = { participants: ids, seen: new Set(), kept: 0, dropped: 0 };
  const source = isRecord(raw) ? raw : {};

  const participants: SeqParticipant[] = [];
  for (const entry of Array.isArray(source.participants) ? source.participants : []) {
    if (participants.length >= LIMITS.maxSequenceParticipants || !isRecord(entry)) {
      reading.dropped += 1;
      continue;
    }
    // A participant's id is what its messages point at, so a missing or repeated one cannot be
    // given a new id the way a message's can: the second claimant is dropped with what names it.
    const id = idOf(entry.id);
    if (!id || ids.has(id)) {
      reading.dropped += 1;
      continue;
    }
    const participant = normalizeParticipant(entry, id);
    if (!participant) continue;
    ids.add(id);
    reading.seen.add(id);
    participants.push(participant);
  }

  const items = readItems(source.items, reading, 0);
  const messageIds = new Set<string>();
  collectMessageIds(items, messageIds);
  dropLostReplies(items, messageIds);

  const sequence: DraftSequence = { participants, items };
  const grouped = normalizeGroups(source.groups, participants, reading.seen);
  if (grouped.groups.length > 0) sequence.groups = grouped.groups;
  if (source.numberMessages === false) sequence.numberMessages = false;
  return { sequence, dropped: reading.dropped + grouped.dropped };
}
