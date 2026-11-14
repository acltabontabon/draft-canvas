/**
 * Everything that can be done to a sequence, as pure functions over `DraftSequence`.
 *
 * Each returns the sequence it was given when nothing would change, and otherwise a new one that
 * shares every part it did not touch — the history compares by identity (`HistoryStack.ts`), so an
 * operation that rebuilt untouched messages would turn every edit into "everything changed".
 *
 * These keep the structure sound (no message to a participant that is gone, no fragment inside
 * itself, nothing past `LIMITS`). Whether the result makes sense as behaviour — a reply before its
 * call — is `sequence/check.ts`'s to say, and never a reason to refuse or quietly rewrite an edit.
 */
import { createId } from './ids';
import { LIMITS } from './limits';
import { cleanText } from './sanitize';
import {
  countItems,
  findItem,
  findOperand,
  heightOf,
  isBranching,
  itemsAt,
  type SeqSlot,
} from './sequenceModel';
import type {
  Accent,
  DraftDocument,
  DraftNode,
  DraftSequence,
  SeqFragment,
  SeqGroup,
  SeqItem,
  SeqMessage,
  SeqMessageKind,
  SeqNote,
  SeqOperand,
  SeqOperator,
  SeqParticipant,
} from './types';
import { normalizeParticipant } from './validateSequence';

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/** Applies `recipe` to one sequence node's content. The same document back when nothing changed. */
export function updateSequence(
  doc: DraftDocument,
  nodeId: string,
  recipe: (sequence: DraftSequence, node: DraftNode) => DraftSequence,
): DraftDocument {
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (node.id !== nodeId || node.type !== 'sequence') return node;
    const before = node.sequence ?? { participants: [], items: [] };
    const after = recipe(before, node);
    if (after === before) return node;
    changed = true;
    return { ...node, sequence: after };
  });
  return changed ? { ...doc, nodes } : doc;
}

/**
 * What `rewrite` may answer for an item: `undefined` to leave it and look inside it, the item
 * itself to leave it and not look inside, another item or several to put in its place, `null` to
 * take it out.
 */
type Rewrite = (item: SeqItem) => SeqItem | readonly SeqItem[] | null | undefined;

function rewriteInside(item: SeqItem, rewrite: Rewrite): SeqItem {
  if (item.t !== 'fragment') return item;
  let operands: SeqOperand[] | null = null;
  item.operands.forEach((branch, index) => {
    const items = rewriteItems(branch.items, rewrite);
    if (items === branch.items) return;
    operands ??= item.operands.slice();
    operands[index] = { ...branch, items };
  });
  return operands ? { ...item, operands } : item;
}

function rewriteItems(items: readonly SeqItem[], rewrite: Rewrite): SeqItem[] {
  let out: SeqItem[] | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const answer = rewrite(item);
    const next = answer === undefined ? rewriteInside(item, rewrite) : answer;
    if (next !== item) out ??= items.slice(0, index);
    if (!out) continue;
    if (next === null) continue;
    if (Array.isArray(next)) out.push(...(next as readonly SeqItem[]));
    else out.push(next as SeqItem);
  }
  return out ?? (items as SeqItem[]);
}

function withItems(sequence: DraftSequence, items: SeqItem[]): DraftSequence {
  return items === sequence.items ? sequence : { ...sequence, items };
}

function rewrite(sequence: DraftSequence, fn: Rewrite): DraftSequence {
  return withItems(sequence, rewriteItems(sequence.items, fn));
}

/** Edits the list a slot points into: the top level, or one branch. */
function editList(
  sequence: DraftSequence,
  operandId: string | null,
  edit: (items: readonly SeqItem[]) => readonly SeqItem[],
): DraftSequence {
  if (operandId === null) return withItems(sequence, edit(sequence.items) as SeqItem[]);
  return rewrite(sequence, (item) => {
    if (item.t !== 'fragment') return item;
    const index = item.operands.findIndex((branch) => branch.id === operandId);
    if (index < 0) return undefined;
    const branch = item.operands[index]!;
    const items = edit(branch.items);
    if (items === branch.items) return item;
    const operands = item.operands.slice();
    operands[index] = { ...branch, items: items as SeqItem[] };
    return { ...item, operands };
  });
}

/** How many fragments surround whatever sits in this list, or null when the branch is gone. */
function depthAt(sequence: DraftSequence, operandId: string | null): number | null {
  if (operandId === null) return 0;
  return findOperand(sequence, operandId)?.depth ?? null;
}

const clampIndex = (index: number, length: number): number => Math.max(0, Math.min(length, Math.round(index)));

const oneLine = (value: string, max: number): string => cleanText(value, max).replace(/\s+/g, ' ').trim();

function patched<T extends object>(base: T, patch: Partial<T>): T {
  const next = { ...base, ...patch };
  let same = true;
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] === undefined) delete next[key];
    if (next[key] !== base[key]) same = false;
  }
  return same ? base : next;
}

/** A reply whose call has gone answers nothing in particular. */
function dropLostReplies(sequence: DraftSequence): DraftSequence {
  const calls = new Set<string>();
  const collect = (items: readonly SeqItem[]) => {
    for (const item of items) {
      if (item.t === 'message') calls.add(item.id);
      else if (item.t === 'fragment') for (const branch of item.operands) collect(branch.items);
    }
  };
  collect(sequence.items);
  return rewrite(sequence, (item) => {
    if (item.t !== 'message') return undefined;
    if (item.replyTo === undefined || calls.has(item.replyTo)) return item;
    const { replyTo: _lost, ...rest } = item;
    return rest;
  });
}

// ---------------------------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------------------------

/**
 * Groups as they can be drawn: every member real, in one group only, and beside the group's other
 * members. A member left stranded by a move simply leaves the group.
 */
function settleGroups(sequence: DraftSequence): DraftSequence {
  if (!sequence.groups) return sequence;
  const order = new Map(sequence.participants.map((participant, index) => [participant.id, index]));
  const taken = new Set<string>();
  let changed = false;
  const groups: SeqGroup[] = [];
  for (const group of sequence.groups) {
    const members = group.participantIds
      .filter((id, index, all) => order.has(id) && !taken.has(id) && all.indexOf(id) === index)
      .sort((a, b) => order.get(a)! - order.get(b)!);
    const run: string[] = [];
    for (const id of members) {
      if (run.length > 0 && order.get(id)! !== order.get(run[run.length - 1]!)! + 1) break;
      run.push(id);
    }
    for (const id of run) taken.add(id);
    const same = run.length === group.participantIds.length && run.every((id, index) => id === group.participantIds[index]);
    if (!same) changed = true;
    if (run.length === 0) continue;
    groups.push(same ? group : { ...group, participantIds: run });
  }
  if (!changed) return sequence;
  const { groups: _old, ...rest } = sequence;
  return groups.length > 0 ? { ...rest, groups } : rest;
}

/** The group both neighbours of a gap belong to: standing in that gap means standing in the group. */
function groupAround(sequence: DraftSequence, participants: readonly SeqParticipant[], index: number): SeqGroup | undefined {
  const left = participants[index - 1]?.id;
  const right = participants[index + 1]?.id;
  if (!left || !right) return undefined;
  return sequence.groups?.find((group) => group.participantIds.includes(left) && group.participantIds.includes(right));
}

function joinGroup(sequence: DraftSequence, groupId: string, participantId: string): DraftSequence {
  const order = new Map(sequence.participants.map((participant, index) => [participant.id, index]));
  const groups = sequence.groups?.map((group) => {
    if (group.id !== groupId) {
      return group.participantIds.includes(participantId)
        ? { ...group, participantIds: group.participantIds.filter((id) => id !== participantId) }
        : group;
    }
    if (group.participantIds.includes(participantId)) return group;
    return { ...group, participantIds: [...group.participantIds, participantId].sort((a, b) => order.get(a)! - order.get(b)!) };
  });
  return settleGroups({ ...sequence, groups });
}

/**
 * Adds a lifeline at `index` (the end by default). Dropped between two members of a group, it joins
 * them. Refused when its id is taken or the sequence is full.
 */
export function addParticipant(sequence: DraftSequence, participant: SeqParticipant, index?: number): DraftSequence {
  if (sequence.participants.length >= LIMITS.maxSequenceParticipants) return sequence;
  if (sequence.participants.some((existing) => existing.id === participant.id)) return sequence;
  const clean = normalizeParticipant(participant, participant.id);
  if (!clean) return sequence;
  const at = clampIndex(index ?? sequence.participants.length, sequence.participants.length);
  const participants = [...sequence.participants.slice(0, at), clean, ...sequence.participants.slice(at)];
  const next = { ...sequence, participants };
  const around = groupAround(next, participants, at);
  return around ? joinGroup(next, around.id, clean.id) : next;
}

/**
 * Changes who a participant is. Goes through the same reading a file does, so a new `type` drops
 * the old type's kind and takes its own default, and text is held to the same limits.
 */
export function updateParticipant(
  sequence: DraftSequence,
  id: string,
  patch: Partial<Omit<SeqParticipant, 'id'>>,
): DraftSequence {
  const index = sequence.participants.findIndex((participant) => participant.id === id);
  if (index < 0) return sequence;
  const current = sequence.participants[index]!;
  const merged: Record<string, unknown> = { ...current, ...patch };
  const next = normalizeParticipant(merged, id);
  if (!next) return sequence;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]) as Set<keyof SeqParticipant>;
  let same = true;
  for (const key of keys) if (current[key] !== next[key]) same = false;
  if (same) return sequence;
  const participants = sequence.participants.slice();
  participants[index] = next;
  return { ...sequence, participants };
}

/**
 * Takes a lifeline away, with the messages to and from it: a message with one end missing says
 * nothing. A note that sat over others too stays over them; fragments stay, emptier.
 */
export function removeParticipant(sequence: DraftSequence, id: string): DraftSequence {
  if (!sequence.participants.some((participant) => participant.id === id)) return sequence;
  const participants = sequence.participants.filter((participant) => participant.id !== id);
  const items = rewriteItems(sequence.items, (item) => {
    if (item.t === 'message') return item.from === id || item.to === id ? null : item;
    if (item.t === 'note') {
      if (!item.over.includes(id)) return item;
      const over = item.over.filter((other) => other !== id);
      return over.length > 0 ? { ...item, over } : null;
    }
    if (!item.covers?.includes(id)) return undefined;
    const covers = item.covers.filter((other) => other !== id);
    // Only a `ref` covers participants by name, and it holds nothing to look inside.
    const { covers: _old, ...rest } = item;
    return covers.length > 0 ? { ...rest, covers } : rest;
  });
  return dropLostReplies(settleGroups({ ...sequence, participants, items }));
}

/**
 * Moves a lifeline to stand at `toIndex` in the finished order. Between two members of a group it
 * joins them; still beside its own group it stays in it; anywhere else it leaves.
 */
export function moveParticipant(sequence: DraftSequence, id: string, toIndex: number): DraftSequence {
  const from = sequence.participants.findIndex((participant) => participant.id === id);
  if (from < 0) return sequence;
  const to = Math.max(0, Math.min(sequence.participants.length - 1, Math.round(toIndex)));
  if (to === from) return sequence;
  const participants = sequence.participants.slice();
  const [moved] = participants.splice(from, 1);
  participants.splice(to, 0, moved!);
  const next = { ...sequence, participants };
  const around = groupAround(next, participants, to);
  if (around) return joinGroup(next, around.id, id);
  const own = sequence.groups?.find((group) => group.participantIds.includes(id));
  if (!own) return settleGroups(next);
  const beside = [participants[to - 1]?.id, participants[to + 1]?.id].some(
    (neighbour) => neighbour !== undefined && own.participantIds.includes(neighbour),
  );
  if (beside) return settleGroups(next);
  // No longer beside its group: it leaves, and the rest close ranks.
  const groups = sequence.groups!.map((group) =>
    group.id === own.id ? { ...group, participantIds: group.participantIds.filter((member) => member !== id) } : group,
  );
  return settleGroups({ ...next, groups });
}

/**
 * Draws these participants together under a name. They are moved to stand side by side, where the
 * first of them stood, and leave whatever group they were in. Looks only — see `SeqGroup`.
 */
export function groupParticipants(
  sequence: DraftSequence,
  participantIds: readonly string[],
  group: { id: string; name?: string; accent?: Accent },
): DraftSequence {
  const chosen = sequence.participants.filter((participant) => participantIds.includes(participant.id));
  if (chosen.length === 0) return sequence;
  if ((sequence.groups?.length ?? 0) >= LIMITS.maxSequenceGroups) return sequence;
  if (sequence.groups?.some((existing) => existing.id === group.id)) return sequence;
  const chosenIds = new Set(chosen.map((participant) => participant.id));
  const rest = sequence.participants.filter((participant) => !chosenIds.has(participant.id));
  const groupsWithout = (sequence.groups ?? [])
    .map((existing) =>
      existing.participantIds.some((id) => chosenIds.has(id))
        ? { ...existing, participantIds: existing.participantIds.filter((id) => !chosenIds.has(id)) }
        : existing,
    )
    .filter((existing) => existing.participantIds.length > 0);
  // Where the first of them stood, counted among those staying put — moved along if that would
  // split a group the chosen ones are not part of.
  let at = sequence.participants.slice(0, sequence.participants.indexOf(chosen[0]!)).filter((participant) => !chosenIds.has(participant.id)).length;
  const sameGroup = (a?: SeqParticipant, b?: SeqParticipant) =>
    !!a && !!b && groupsWithout.some((existing) => existing.participantIds.includes(a.id) && existing.participantIds.includes(b.id));
  while (sameGroup(rest[at - 1], rest[at])) at += 1;
  const participants = [...rest.slice(0, at), ...chosen, ...rest.slice(at)];
  const created: SeqGroup = {
    id: group.id,
    name: oneLine(group.name ?? '', LIMITS.maxSequenceNameLength),
    participantIds: chosen.map((participant) => participant.id),
  };
  if (group.accent) created.accent = group.accent;
  const same = participants.every((participant, index) => participant === sequence.participants[index]);
  return settleGroups({ ...sequence, participants: same ? sequence.participants : participants, groups: [...groupsWithout, created] });
}

export function updateGroup(sequence: DraftSequence, groupId: string, patch: { name?: string; accent?: Accent | undefined }): DraftSequence {
  if (!sequence.groups?.some((group) => group.id === groupId)) return sequence;
  let changed = false;
  const groups = sequence.groups.map((group) => {
    if (group.id !== groupId) return group;
    const clean: Partial<SeqGroup> = { ...patch };
    if (patch.name !== undefined) clean.name = oneLine(patch.name, LIMITS.maxSequenceNameLength);
    const next = patched(group, clean);
    if (next !== group) changed = true;
    return next;
  });
  return changed ? { ...sequence, groups } : sequence;
}

/**
 * Takes one participant out of its group, to stand just outside whichever end of it is nearer.
 * (Dragging cannot always do this: a group that reaches the edge of the sequence has no outside on
 * that side to drag to.)
 */
export function leaveGroup(sequence: DraftSequence, participantId: string): DraftSequence {
  const group = sequence.groups?.find((candidate) => candidate.participantIds.includes(participantId));
  if (!group) return sequence;
  const order = sequence.participants.map((participant) => participant.id);
  const at = order.indexOf(participantId);
  const members = group.participantIds.map((id) => order.indexOf(id));
  const first = Math.min(...members);
  const last = Math.max(...members);
  const participants = sequence.participants.slice();
  const [moved] = participants.splice(at, 1);
  participants.splice(at - first <= last - at ? first : last, 0, moved!);
  const same = participants.every((participant, index) => participant === sequence.participants[index]);
  const groups = sequence.groups!.map((candidate) =>
    candidate.id === group.id ? { ...candidate, participantIds: candidate.participantIds.filter((id) => id !== participantId) } : candidate,
  );
  return settleGroups({ ...sequence, participants: same ? sequence.participants : participants, groups });
}

/** Stops drawing a group. Its participants stay exactly where they are. */
export function ungroupParticipants(sequence: DraftSequence, groupId: string): DraftSequence {
  if (!sequence.groups?.some((group) => group.id === groupId)) return sequence;
  const groups = sequence.groups.filter((group) => group.id !== groupId);
  const { groups: _old, ...rest } = sequence;
  return groups.length > 0 ? { ...rest, groups } : rest;
}

// ---------------------------------------------------------------------------------------------
// Making items
// ---------------------------------------------------------------------------------------------

/**
 * A new message with the settings its kind starts with: a call starts work at its receiver, a reply
 * ends its sender's. They are written here, once, and are the user's from then on.
 */
export function createMessage(input: {
  from: string;
  to: string;
  kind?: SeqMessageKind;
  label?: string;
  replyTo?: string;
  id?: string;
}): SeqMessage {
  const kind = input.kind ?? 'sync';
  const message: SeqMessage = {
    id: input.id ?? createId('sm'),
    t: 'message',
    from: input.from,
    to: input.to,
    kind,
    label: cleanText(input.label ?? '', LIMITS.maxLabelLength),
  };
  if (kind === 'sync') message.activate = true;
  if (kind === 'reply') {
    message.deactivate = true;
    if (input.replyTo) message.replyTo = input.replyTo;
  }
  return message;
}

/** The reply to a call: back the way it came, ending the work the call started. */
export function createReply(call: SeqMessage, label = ''): SeqMessage {
  const reply = createMessage({ from: call.to, to: call.from, kind: 'reply', label, replyTo: call.id });
  if (!call.activate) delete reply.deactivate;
  return reply;
}

export function createNote(input: { over: readonly string[]; text?: string; side?: SeqNote['side']; id?: string }): SeqNote {
  const note: SeqNote = {
    id: input.id ?? createId('sn'),
    t: 'note',
    text: cleanText(input.text ?? '', LIMITS.maxSequenceNoteLength),
    over: [...input.over],
  };
  if (input.side) note.side = input.side;
  return note;
}

export function createFragment(input: {
  operator: SeqOperator;
  items?: readonly SeqItem[];
  guard?: string;
  label?: string;
  covers?: readonly string[];
  id?: string;
}): SeqFragment {
  const fragment: SeqFragment = { id: input.id ?? createId('sf'), t: 'fragment', operator: input.operator, operands: [] };
  if (input.operator === 'ref') {
    const label = oneLine(input.label ?? '', LIMITS.maxLabelLength);
    if (label) fragment.label = label;
    if (input.covers?.length) fragment.covers = [...input.covers];
    return fragment;
  }
  const operand: SeqOperand = { id: createId('so'), items: [...(input.items ?? [])] };
  const guard = oneLine(input.guard ?? '', LIMITS.maxConditionLength);
  if (guard) operand.guard = guard;
  fragment.operands = [operand];
  return fragment;
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

function referencesKnown(sequence: DraftSequence, item: SeqItem): boolean {
  const known = new Set(sequence.participants.map((participant) => participant.id));
  let ok = true;
  const visit = (current: SeqItem) => {
    if (current.t === 'message') ok &&= known.has(current.from) && known.has(current.to);
    else if (current.t === 'note') ok &&= current.over.length > 0 && current.over.every((id) => known.has(id));
    else {
      ok &&= (current.covers ?? []).every((id) => known.has(id));
      for (const branch of current.operands) branch.items.forEach(visit);
    }
  };
  visit(item);
  return ok;
}

/** Whether `item` may go into the list at `operandId` without breaking a limit. */
function fits(sequence: DraftSequence, item: SeqItem, operandId: string | null, alreadyCounted = false): boolean {
  const depth = depthAt(sequence, operandId);
  if (depth === null) return false;
  if (depth + heightOf(item) > LIMITS.maxSequenceDepth) return false;
  if (!alreadyCounted && countItems(sequence.items) + countItems([item]) > LIMITS.maxSequenceItems) return false;
  return true;
}

/** Puts an item at a slot. Refused when it names a participant that is not there, or will not fit. */
export function insertItem(sequence: DraftSequence, item: SeqItem, slot: SeqSlot): DraftSequence {
  if (findItem(sequence, item.id)) return sequence;
  if (!referencesKnown(sequence, item) || !fits(sequence, item, slot.operandId)) return sequence;
  return editList(sequence, slot.operandId, (items) => {
    const at = clampIndex(slot.index, items.length);
    return [...items.slice(0, at), item, ...items.slice(at)];
  });
}

export type MessagePatch = Partial<Pick<SeqMessage, 'from' | 'to' | 'label' | 'replyTo' | 'activate' | 'deactivate' | 'kindOrigin'>>;

export function updateMessage(sequence: DraftSequence, id: string, patch: MessagePatch): DraftSequence {
  const known = new Set(sequence.participants.map((participant) => participant.id));
  if ((patch.from !== undefined && !known.has(patch.from)) || (patch.to !== undefined && !known.has(patch.to))) return sequence;
  const clean: MessagePatch = { ...patch };
  if (patch.label !== undefined) clean.label = cleanText(patch.label, LIMITS.maxLabelLength);
  if (patch.activate !== undefined && patch.activate !== true) clean.activate = undefined;
  if (patch.deactivate !== undefined && patch.deactivate !== true) clean.deactivate = undefined;
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'message') return item;
    return patched<SeqMessage>(item, clean);
  });
}

/**
 * Makes a message a different kind, by someone's choice. It takes that kind's own starting
 * settings: a call starts work, a reply ends it, and anything that is not a reply answers nothing.
 */
export function setMessageKind(sequence: DraftSequence, id: string, kind: SeqMessageKind): DraftSequence {
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'message') return item;
    if (item.kind === kind) return item.kindOrigin === 'explicit' ? item : { ...item, kindOrigin: 'explicit' };
    const { activate: _a, deactivate: _d, replyTo, ...rest } = item;
    const next: SeqMessage = { ...rest, kind, kindOrigin: 'explicit' };
    if (kind === 'sync') next.activate = true;
    if (kind === 'reply') {
      next.deactivate = true;
      if (replyTo) next.replyTo = replyTo;
    }
    return next;
  });
}

/** Turns a message round: its sender becomes its receiver. */
export function reverseMessage(sequence: DraftSequence, id: string): DraftSequence {
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'message' || item.from === item.to) return item;
    return { ...item, from: item.to, to: item.from };
  });
}

export function updateNote(sequence: DraftSequence, id: string, patch: Partial<Pick<SeqNote, 'text' | 'over' | 'side'>>): DraftSequence {
  const known = new Set(sequence.participants.map((participant) => participant.id));
  const clean: Partial<SeqNote> = { ...patch };
  if (patch.text !== undefined) clean.text = cleanText(patch.text, LIMITS.maxSequenceNoteLength);
  if (patch.over !== undefined) {
    const over = patch.over.filter((participant, index, all) => known.has(participant) && all.indexOf(participant) === index);
    if (over.length === 0) return sequence;
    clean.over = over;
  }
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'note') return item;
    if (clean.over && clean.over.length === item.over.length && clean.over.every((value, index) => value === item.over[index])) {
      const { over: _same, ...rest } = clean;
      return patched(item, rest);
    }
    return patched(item, clean);
  });
}

/** A `ref` fragment's name and the participants it covers. */
export function updateReference(sequence: DraftSequence, id: string, patch: { label?: string; covers?: readonly string[] }): DraftSequence {
  const known = new Set(sequence.participants.map((participant) => participant.id));
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'fragment' || item.operator !== 'ref') return item;
    let next = item;
    if (patch.label !== undefined) {
      const label = oneLine(patch.label, LIMITS.maxLabelLength);
      next = patched(next, { label: label || undefined });
    }
    if (patch.covers !== undefined) {
      const covers = patch.covers.filter((participant, index, all) => known.has(participant) && all.indexOf(participant) === index);
      next = patched(next, { covers: covers.length > 0 ? covers : undefined });
    }
    return next;
  });
}

/**
 * Changes what a fragment means. Going to a kind with one branch, the other branches' messages move
 * into the first rather than vanish. Only an empty fragment can become a reference to elsewhere.
 */
export function setFragmentOperator(sequence: DraftSequence, id: string, operator: SeqOperator): DraftSequence {
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'fragment' || item.operator === operator) return item;
    if (operator === 'ref') {
      if (item.operands.some((branch) => branch.items.length > 0)) return item;
      return { id: item.id, t: 'fragment', operator, operands: [] };
    }
    if (item.operator === 'ref') {
      return { id: item.id, t: 'fragment', operator, operands: [{ id: createId('so'), items: [] }] };
    }
    if (isBranching(operator) || item.operands.length <= 1) return { ...item, operator };
    const [first, ...others] = item.operands;
    return { ...item, operator, operands: [{ ...first!, items: [...first!.items, ...others.flatMap((branch) => branch.items)] }] };
  });
}

/** A branch's condition. Empty clears it. */
export function setGuard(sequence: DraftSequence, operandId: string, guard: string): DraftSequence {
  const clean = oneLine(guard, LIMITS.maxConditionLength);
  return rewrite(sequence, (item) => {
    if (item.t !== 'fragment') return item;
    const index = item.operands.findIndex((branch) => branch.id === operandId);
    if (index < 0) return undefined;
    const branch = item.operands[index]!;
    const next = patched(branch, { guard: clean || undefined });
    if (next === branch) return item;
    const operands = item.operands.slice();
    operands[index] = next;
    return { ...item, operands };
  });
}

/** Adds an empty branch to an `alt` or `par`, after `afterOperandId` or at the end. */
export function addOperand(sequence: DraftSequence, fragmentId: string, operand: { id: string; guard?: string }, afterOperandId?: string): DraftSequence {
  return rewrite(sequence, (item) => {
    if (item.id !== fragmentId) return undefined;
    if (item.t !== 'fragment' || !isBranching(item.operator)) return item;
    if (item.operands.length >= LIMITS.maxSequenceOperands) return item;
    const created: SeqOperand = { id: operand.id, items: [] };
    const guard = oneLine(operand.guard ?? '', LIMITS.maxConditionLength);
    if (guard) created.guard = guard;
    const after = afterOperandId ? item.operands.findIndex((branch) => branch.id === afterOperandId) : -1;
    const at = after < 0 ? item.operands.length : after + 1;
    return { ...item, operands: [...item.operands.slice(0, at), created, ...item.operands.slice(at)] };
  });
}

/**
 * Takes a branch away. Its messages go to the branch before it (after it, for the first) unless
 * `withContents` says to delete them too. A fragment's only branch stays.
 */
export function removeOperand(sequence: DraftSequence, operandId: string, withContents = false): DraftSequence {
  const next = rewrite(sequence, (item) => {
    if (item.t !== 'fragment') return item;
    const index = item.operands.findIndex((branch) => branch.id === operandId);
    if (index < 0) return undefined;
    if (item.operands.length <= 1) return item;
    const gone = item.operands[index]!;
    const operands = item.operands.filter((branch) => branch.id !== operandId);
    if (!withContents && gone.items.length > 0) {
      const heir = index > 0 ? index - 1 : 0;
      const target = operands[heir]!;
      operands[heir] = { ...target, items: index > 0 ? [...target.items, ...gone.items] : [...gone.items, ...target.items] };
    }
    return { ...item, operands };
  });
  return withContents ? dropLostReplies(next) : next;
}

/** Moves a branch to stand at `toIndex` among its fragment's branches. */
export function moveOperand(sequence: DraftSequence, operandId: string, toIndex: number): DraftSequence {
  return rewrite(sequence, (item) => {
    if (item.t !== 'fragment') return item;
    const from = item.operands.findIndex((branch) => branch.id === operandId);
    if (from < 0) return undefined;
    const to = Math.max(0, Math.min(item.operands.length - 1, Math.round(toIndex)));
    if (to === from) return item;
    const operands = item.operands.slice();
    const [moved] = operands.splice(from, 1);
    operands.splice(to, 0, moved!);
    return { ...item, operands };
  });
}

/** Deletes items, each with everything inside it. */
export function removeItems(sequence: DraftSequence, ids: readonly string[]): DraftSequence {
  if (ids.length === 0) return sequence;
  const gone = new Set(ids);
  return dropLostReplies(rewrite(sequence, (item) => (gone.has(item.id) ? null : undefined)));
}

/** Removes a fragment's frame and leaves what it held in its place, in order. */
export function unwrapFragment(sequence: DraftSequence, id: string): DraftSequence {
  return rewrite(sequence, (item) => {
    if (item.id !== id) return undefined;
    if (item.t !== 'fragment') return item;
    return item.operands.flatMap((branch) => branch.items);
  });
}

/**
 * Wraps items in a fragment. They must share a list; everything between the first and last of them
 * is taken too, since a fragment covers a stretch of the interaction, not a pick from it.
 */
export function wrapItems(
  sequence: DraftSequence,
  ids: readonly string[],
  fragment: { id: string; operator: Exclude<SeqOperator, 'ref'>; guard?: string },
): DraftSequence {
  if (ids.length === 0 || findItem(sequence, fragment.id)) return sequence;
  const places = ids.map((id) => findItem(sequence, id));
  if (places.some((place) => place === null)) return sequence;
  const operandId = places[0]!.at.operand?.id ?? null;
  if (places.some((place) => (place!.at.operand?.id ?? null) !== operandId)) return sequence;
  const list = itemsAt(sequence, operandId);
  const depth = depthAt(sequence, operandId);
  if (!list || depth === null) return sequence;
  const first = Math.min(...places.map((place) => place!.at.index));
  const last = Math.max(...places.map((place) => place!.at.index));
  const taken = list.slice(first, last + 1);
  if (depth + 1 + Math.max(0, ...taken.map(heightOf)) > LIMITS.maxSequenceDepth) return sequence;
  if (countItems(sequence.items) + 1 > LIMITS.maxSequenceItems) return sequence;
  const created = createFragment({ id: fragment.id, operator: fragment.operator, items: taken, guard: fragment.guard });
  return editList(sequence, operandId, (items) => [...items.slice(0, first), created, ...items.slice(last + 1)]);
}

function holdsOperand(item: SeqItem, operandId: string): boolean {
  if (item.t !== 'fragment') return false;
  return item.operands.some((branch) => branch.id === operandId || branch.items.some((child) => holdsOperand(child, operandId)));
}

/**
 * Moves an item, with everything inside it, to a slot. `slot.index` counts the list as it stands
 * before the move. Refused when the slot is inside the item itself or the result nests too deep.
 */
export function moveItem(sequence: DraftSequence, id: string, slot: SeqSlot): DraftSequence {
  const found = findItem(sequence, id);
  if (!found) return sequence;
  if (slot.operandId !== null && holdsOperand(found.item, slot.operandId)) return sequence;
  const target = itemsAt(sequence, slot.operandId);
  if (!target || !fits(sequence, found.item, slot.operandId, true)) return sequence;
  const fromOperand = found.at.operand?.id ?? null;
  let index = clampIndex(slot.index, target.length);
  if (fromOperand === slot.operandId) {
    if (index === found.at.index || index === found.at.index + 1) return sequence;
    if (index > found.at.index) index -= 1;
  }
  const without = rewrite(sequence, (item) => (item.id === id ? null : undefined));
  return editList(without, slot.operandId, (items) => [...items.slice(0, index), found.item, ...items.slice(index)]);
}

function cloneItem(item: SeqItem, ids: Map<string, string>): SeqItem {
  if (item.t === 'message') {
    const id = createId('sm');
    ids.set(item.id, id);
    return { ...item, id };
  }
  if (item.t === 'note') return { ...item, id: createId('sn'), over: [...item.over] };
  return {
    ...item,
    id: createId('sf'),
    ...(item.covers ? { covers: [...item.covers] } : {}),
    operands: item.operands.map((branch) => ({ ...branch, id: createId('so'), items: branch.items.map((child) => cloneItem(child, ids)) })),
  };
}

function repointReplies(item: SeqItem, ids: ReadonlyMap<string, string>): SeqItem {
  if (item.t === 'message') {
    const mapped = item.replyTo ? ids.get(item.replyTo) : undefined;
    return mapped ? { ...item, replyTo: mapped } : item;
  }
  if (item.t === 'note') return item;
  return { ...item, operands: item.operands.map((branch) => ({ ...branch, items: branch.items.map((child) => repointReplies(child, ids)) })) };
}

/**
 * A copy of an item directly after it, with new ids throughout. A reply copied along with its call
 * answers the copy; one copied alone still answers the original.
 */
export function duplicateItem(sequence: DraftSequence, id: string): { sequence: DraftSequence; id: string | null } {
  const found = findItem(sequence, id);
  if (!found) return { sequence, id: null };
  const ids = new Map<string, string>();
  const copy = repointReplies(cloneItem(found.item, ids), ids);
  const next = insertItem(sequence, copy, { operandId: found.at.operand?.id ?? null, index: found.at.index + 1 });
  return next === sequence ? { sequence, id: null } : { sequence: next, id: copy.id };
}

// ---------------------------------------------------------------------------------------------
// Links to shapes on the canvas
// ---------------------------------------------------------------------------------------------

/** Forgets links to shapes that are gone. The participants stay as they are. */
export function dropParticipantLinks(doc: DraftDocument, removedNodeIds: ReadonlySet<string>): DraftDocument {
  if (removedNodeIds.size === 0) return doc;
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (!node.sequence?.participants.some((participant) => participant.ref && removedNodeIds.has(participant.ref))) return node;
    changed = true;
    const participants = node.sequence.participants.map((participant) => {
      if (!participant.ref || !removedNodeIds.has(participant.ref)) return participant;
      const { ref: _gone, ...rest } = participant;
      return rest;
    });
    return { ...node, sequence: { ...node.sequence, participants } };
  });
  return changed ? { ...doc, nodes } : doc;
}

/** Re-points links at shapes that were given new ids — a paste, a copied room. */
export function repointParticipantLinks(node: DraftNode, renamed: ReadonlyMap<string, string>): DraftNode {
  if (!node.sequence?.participants.some((participant) => participant.ref && renamed.has(participant.ref))) return node;
  const participants = node.sequence.participants.map((participant) => {
    const mapped = participant.ref ? renamed.get(participant.ref) : undefined;
    return mapped ? { ...participant, ref: mapped } : participant;
  });
  return { ...node, sequence: { ...node.sequence, participants } };
}
