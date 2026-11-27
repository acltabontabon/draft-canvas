/**
 * Sequences, as an agent writes and reads them.
 *
 * A sequence is behaviour over time — who says what to whom, in what order, under which condition —
 * and there is already a language for exactly that which every agent writes fluently: a Mermaid
 * `sequenceDiagram`. So that is how one is sent and how one is read back, rather than a second,
 * parallel schema of participants, messages and fragments that would say the same things less well.
 * The text is parsed into the app's own model (`import/mermaid/sequence.ts`); nothing is kept as
 * text, and nothing in it places anything: the sequence lays itself out.
 *
 * What Mermaid cannot say is that a participant *is* a shape in the architecture. `links` says it:
 * the participant's id in the text, and the element it stands for. A participant written under an
 * element's own id is linked without being listed. A linked participant takes the element's name,
 * kind and technology, and follows it from then on, as one dropped in by hand does.
 */
import { createNode } from '../document/factory';
import { messagesOf, sequenceOf } from '../document/sequenceModel';
import { isLinkable, participantFromNode } from '../document/sequenceLinks';
import type { DraftNode, DraftSequence, SeqGroup, SeqItem, SeqMessage, SeqNote, SeqOperand } from '../document/types';
import { normalizeSequence } from '../document/validateSequence';
import { parseMermaidSequence, UNTITLED_SEQUENCE } from '../import/mermaid/sequence';
import type { DescribeContext } from '../nodes/describe';
import { fitSequenceNode } from '../nodes/sequenceFit';
import { sequenceToMermaid } from '../sequence/native/mermaid';
import { aliasesOf } from '../sequence/native/shared';
import type { Reader } from './input';

type Json = Record<string, unknown>;

/** What one request may say in sequences. Published with the other limits. */
export const SEQUENCE_LIMITS = {
  sequencesPerRequest: 8,
  sequenceSourceLength: 20_000,
  sequenceTitleLength: 120,
} as const;

/** How much of a sequence's text a read carries before it is left out (ask with `fullText`). */
export const SEQUENCE_READ_LIMIT = 6_000;

export interface SequenceSpec {
  id: string;
  title: string;
  sequence: DraftSequence;
  /** By participant id, the element it stands for. */
  links: Map<string, string>;
  /** What the text asked for that a sequence here does not draw. Reported, never dropped in silence. */
  unsupported: string[];
}

/**
 * Reads `mermaid` (and `links`) into a sequence. `elementIds` are the elements a participant may
 * stand for; `kept` are the links a sequence being replaced already had, by the id each linked
 * participant is written under when it is read — so text read, edited and sent back keeps them.
 */
export function readSequenceSource(
  r: Reader,
  item: Json,
  at: string,
  elementIds: ReadonlySet<string>,
  current?: DraftSequence,
): Omit<SequenceSpec, 'id' | 'title'> & { title: string | undefined } | undefined {
  const source = r.text(item.mermaid, `${at}/mermaid`, SEQUENCE_LIMITS.sequenceSourceLength, { required: true, code: true });
  if (source === undefined) return undefined;
  const kept = current ? linksOf(current) : undefined;
  const ids = current ? new Map([...aliasesOf(current)].map(([id, alias]) => [alias, id])) : undefined;
  const parsed = parseMermaidSequence(source, ids);
  if (!parsed.ok) {
    r.problems.add('INVALID_INPUT', `${at}/mermaid`, `${parsed.error} Send a Mermaid sequenceDiagram: participants, then messages such as "client->>api: GET /orders".`);
    return undefined;
  }
  const byWritten = new Map([...parsed.written].map(([participant, name]) => [name, participant]));
  const links = new Map<string, string>();
  const standing = new Set<string>();
  const link = (name: string, element: string, path?: string): void => {
    const participant = byWritten.get(name);
    if (!participant) {
      if (path) r.problems.add('INVALID_REFERENCE', path, `no participant "${name}" in the sequence; links are keyed by a participant's id in the Mermaid text`);
      return;
    }
    if (!elementIds.has(element)) {
      if (path) r.problems.add('INVALID_REFERENCE', path, `no element "${element}" in this view`);
      return;
    }
    if (links.has(participant)) return;
    if (standing.has(element)) {
      if (path) r.problems.add('INVALID_INPUT', path, `"${element}" already stands in this sequence; one participant per element`);
      return;
    }
    links.set(participant, element);
    standing.add(element);
  };
  if (item.links !== undefined && item.links !== null) {
    const given = r.object(item.links, `${at}/links`);
    for (const [name, element] of Object.entries(given ?? {})) {
      if (typeof element !== 'string') r.problems.add('INVALID_INPUT', `${at}/links/${name}`, 'must be an element id');
      else link(name, element, `${at}/links/${name}`);
    }
  }
  // Said without being listed: a participant written under an element's own id, and (on an update)
  // one that was linked before and is still written under the same id.
  for (const name of byWritten.keys()) {
    if (elementIds.has(name)) link(name, name);
    const before = kept?.get(name);
    if (before) link(name, before);
  }
  return { title: parsed.title === UNTITLED_SEQUENCE ? undefined : parsed.title, sequence: parsed.sequence, links, unsupported: parsed.unsupported };
}

/**
 * `next`, the sequence an agent's text reads as, with what that text has no words for kept from
 * `node`'s sequence, which it replaces.
 *
 * Mermaid can't say what a participant is beyond "actor" or not, what it is built with or its
 * colour; nor a group's colour, a reference to another interaction (a read writes it as a note), a
 * blank label (written as a word: Mermaid needs one), which call a reply answers when that isn't the
 * latest one, or any id. Text that was read and sent back changed none of that, and an agent adding
 * one message used to turn every Data Store and Queue into a plain Service, drop technologies and
 * colours, make references notes and write "Message" into blank replies, all in silence.
 *
 * So the text the read gave (`sequenceToMermaid`, as `sequenceRead` writes it) is read again, and
 * wherever the agent's text still says what that text said (a participant under the same id and the
 * same keyword, a message, note, branch or group left as it was) the sequence keeps what it held;
 * what the agent changed is the agent's. Items are matched branch by branch on a weighted longest
 * common subsequence, so a message added or taken out doesn't shift what the rest is matched with.
 */
export function keepUnwritten(node: DraftNode, next: DraftSequence): DraftSequence {
  const current = sequenceOf(node);
  const ids = new Map([...aliasesOf(current)].map(([id, alias]) => [alias, id]));
  const reread = parseMermaidSequence(sequenceToMermaid(node), ids);
  if (!reread.ok) return next;
  const base = reread.sequence;
  const merge: Merge = { traced: new Map(), tracedIds: new Map(), kept: new Map(), replies: new Map() };
  trace(current.items, base.items, merge);
  const items = mergeItems(next.items, base.items, merge);
  settleReplies(items, merge);
  const was = new Map(current.participants.map((participant) => [participant.id, participant]));
  const said = new Map(base.participants.map((participant) => [participant.id, participant]));
  const participants = next.participants.map((participant) => {
    const before = was.get(participant.id);
    const then = said.get(participant.id);
    if (!before || !then) return participant;
    const name = participant.name === then.name ? before.name : participant.name;
    // All the text says of what a participant is: an actor or not. While that holds, it is what it was.
    if ((participant.type === 'actor') !== (then.type === 'actor')) return { ...participant, name, ...(before.ref ? { ref: before.ref } : {}) };
    return { ...before, name };
  });
  const groups = groupsKept(current.groups ?? [], base.groups ?? [], next.groups);
  return normalizeSequence({ ...next, participants, items, ...(groups ? { groups } : {}) }).sequence;
}

interface Merge {
  /** What each item of the reread text was read from: the item of the current sequence. */
  traced: Map<SeqItem, SeqItem>;
  /** The same for messages, by id: a reply in the reread text names its call by the reread id. */
  tracedIds: Map<string, string>;
  /** The id each message of the agent's text keeps. */
  kept: Map<string, string>;
  /** Replies matched with one that was there, with the two they were matched through. */
  replies: Map<SeqMessage, { said: SeqMessage; read: SeqMessage; was: SeqMessage }>;
}

/** The reread text against the sequence it was written from: one item each, in the same order. */
function trace(current: readonly SeqItem[], base: readonly SeqItem[], merge: Merge): void {
  if (current.length !== base.length) return;
  current.forEach((item, index) => {
    const read = base[index]!;
    // A reference is written as a note: the one thing whose kind the text changes.
    if (item.t === 'fragment' && item.operator === 'ref') {
      if (read.t === 'note') merge.traced.set(read, item);
      return;
    }
    if (item.t !== read.t) return;
    merge.traced.set(read, item);
    if (item.t === 'message') merge.tracedIds.set(read.id, item.id);
    if (item.t === 'fragment' && read.t === 'fragment' && item.operands.length === read.operands.length) {
      item.operands.forEach((operand, k) => trace(operand.items, read.operands[k]!.items, merge));
    }
  });
}

/** What makes two items one item edited (`loose`), and one item as it was (`exact`). */
function keysOf(item: SeqItem): { loose: string; exact: string } {
  if (item.t === 'message') {
    const loose = `m\u0000${item.from}\u0000${item.to}`;
    return { loose, exact: `${loose}\u0000${item.kind}\u0000${item.label}\u0000${item.activate ? 1 : 0}${item.deactivate ? 1 : 0}` };
  }
  if (item.t === 'note') return { loose: 'n', exact: `n\u0000${item.over.join('\u0000')}\u0000${item.side ?? ''}\u0000${item.text}` };
  return { loose: 'f', exact: `f\u0000${item.operator}\u0000${item.operands.map((operand) => operand.guard ?? '').join('\u0000')}` };
}

/** For each of `next`, the index of the item of `base` it is, or -1. */
function align(next: readonly SeqItem[], base: readonly SeqItem[]): number[] {
  const a = next.map(keysOf);
  const b = base.map(keysOf);
  const score = (i: number, j: number) => (a[i]!.exact === b[j]!.exact ? 2 : a[i]!.loose === b[j]!.loose ? 1 : 0);
  const width = base.length + 1;
  const best = new Uint32Array((next.length + 1) * width);
  for (let i = 1; i <= next.length; i += 1) {
    for (let j = 1; j <= base.length; j += 1) {
      const s = score(i - 1, j - 1);
      best[i * width + j] = Math.max(best[(i - 1) * width + j]!, best[i * width + j - 1]!, s ? best[(i - 1) * width + j - 1]! + s : 0);
    }
  }
  const pairs = new Array<number>(next.length).fill(-1);
  for (let i = next.length, j = base.length; i > 0 && j > 0; ) {
    const s = score(i - 1, j - 1);
    if (s && best[i * width + j] === best[(i - 1) * width + j - 1]! + s) {
      pairs[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (best[(i - 1) * width + j]! >= best[i * width + j - 1]!) i -= 1;
    else j -= 1;
  }
  return pairs;
}

function mergeItems(next: readonly SeqItem[], base: readonly SeqItem[], merge: Merge): SeqItem[] {
  const pairs = align(next, base);
  return next.map((item, index) => {
    const read = pairs[index]! >= 0 ? base[pairs[index]!] : undefined;
    const was = read && merge.traced.get(read);
    return read && was ? mergeItem(item, read, was, merge) : item;
  });
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((entry, index) => entry === b[index]);

/** `item`, from the agent's text, with each field it still says as `read` said it kept from `was`. */
function mergeItem(item: SeqItem, read: SeqItem, was: SeqItem, merge: Merge): SeqItem {
  if (item.t === 'message' && read.t === 'message' && was.t === 'message') {
    const kept: SeqMessage = { ...item, id: was.id, kind: item.kind === read.kind ? was.kind : item.kind, label: item.label === read.label ? was.label : item.label };
    for (const flag of ['activate', 'deactivate'] as const) {
      // Mermaid writes the end of work only where its own count has work to end (`Working`).
      if (Boolean(item[flag]) === Boolean(read[flag]) ? was[flag] : item[flag]) kept[flag] = true;
      else delete kept[flag];
    }
    if (kept.kind === was.kind && was.kindOrigin) kept.kindOrigin = was.kindOrigin;
    if (was.attachments?.length) kept.attachments = was.attachments;
    merge.kept.set(item.id, was.id);
    merge.replies.set(kept, { said: item, read, was });
    return kept;
  }
  if (item.t === 'note' && read.t === 'note') {
    const over = sameList(item.over, read.over);
    if (was.t === 'fragment') {
      if (item.text === read.text && over) return was;
      // Still a reference while the text keeps writing it as one; its words are its label.
      const label = /^ref:\s*([\s\S]*)$/.exec(item.text)?.[1];
      if (label === undefined) return item;
      const reference = { ...was, covers: over ? was.covers : [...item.over] };
      if (label.trim()) reference.label = label.trim();
      else delete reference.label;
      return reference;
    }
    if (was.t !== 'note') return item;
    const kept: SeqNote = { ...item, id: was.id, text: item.text === read.text ? was.text : item.text, over: over ? was.over : item.over };
    const side = item.side === read.side ? was.side : item.side;
    if (side) kept.side = side;
    else delete kept.side;
    return kept;
  }
  if (item.t === 'fragment' && read.t === 'fragment' && was.t === 'fragment') {
    return {
      ...item,
      id: was.id,
      operands: item.operands.map((operand, k): SeqOperand => {
        const then = read.operands[k];
        const before = was.operands[k];
        if (!then || !before) return operand;
        const kept: SeqOperand = { ...operand, id: before.id, items: mergeItems(operand.items, then.items, merge) };
        const guard = operand.guard === then.guard ? before.guard : operand.guard;
        if (guard) kept.guard = guard;
        else delete kept.guard;
        return kept;
      }),
    };
  }
  return item;
}

/**
 * Which call each reply answers, once every message has the id it keeps. A matched reply the text
 * still links as the read's text did answers what it answered; the text says nothing else about it.
 */
function settleReplies(items: readonly SeqItem[], merge: Merge): void {
  for (const item of items) {
    if (item.t === 'fragment') {
      for (const operand of item.operands) settleReplies(operand.items, merge);
      continue;
    }
    if (item.t !== 'message') continue;
    const matched = merge.replies.get(item);
    const said = matched ? matched.said.replyTo : item.replyTo;
    const text = said === undefined ? undefined : (merge.kept.get(said) ?? said);
    const reply = matched && text === (matched.read.replyTo === undefined ? undefined : merge.tracedIds.get(matched.read.replyTo)) ? matched.was.replyTo : text;
    if (reply !== undefined) item.replyTo = reply;
    else delete item.replyTo;
  }
}

/**
 * The agent's boxes, each the group it was when it holds the same participants (or, failing that,
 * reads the same name), with the group's id, colour and own name kept: a box has no colour in the text.
 */
function groupsKept(current: readonly SeqGroup[], base: readonly SeqGroup[], next: readonly SeqGroup[] | undefined): SeqGroup[] | undefined {
  if (!next?.length) return next ? [...next] : undefined;
  const members = (group: SeqGroup) => [...group.participantIds].sort().join('\u0000');
  const written = new Map(base.map((group) => [members(group), group]));
  const left = [...current];
  return next.map((group) => {
    let at = left.findIndex((candidate) => members(candidate) === members(group));
    if (at < 0) at = left.findIndex((candidate) => written.get(members(candidate))?.name === group.name);
    if (at < 0) return group;
    const before = left.splice(at, 1)[0]!;
    const kept: SeqGroup = { ...group, id: before.id, name: written.get(members(before))?.name === group.name ? before.name : group.name };
    if (before.accent) kept.accent = before.accent;
    return kept;
  });
}

/** The sequences of a room's request. */
export function readSequences(r: Reader, raw: unknown, path: string, taken: Set<string>, elementIds: ReadonlySet<string>, fields: readonly string[]): SequenceSpec[] {
  const out: SequenceSpec[] = [];
  r.array(raw, path, SEQUENCE_LIMITS.sequencesPerRequest).forEach((entry, index) => {
    const at = `${path}/${index}`;
    const item = r.object(entry, at, fields);
    if (!item) return;
    const id = r.newId(item.id, `${at}/id`, taken);
    const title = r.text(item.title, `${at}/title`, SEQUENCE_LIMITS.sequenceTitleLength, { singleLine: true });
    const read = readSequenceSource(r, item, at, elementIds);
    if (id && read) out.push({ id, title: title ?? read.title ?? 'Sequence', sequence: read.sequence, links: read.links, unsupported: read.unsupported });
  });
  return out;
}

/** `sequence` with each linked participant standing for its shape: the shape's name, kind and technology. */
export function linked(sequence: DraftSequence, links: ReadonlyMap<string, string>, shapes: ReadonlyMap<string, DraftNode>, id: string, advisories: string[]): DraftSequence {
  if (links.size === 0) return sequence;
  return {
    ...sequence,
    participants: sequence.participants.map((participant) => {
      const element = links.get(participant.id);
      const shape = element ? shapes.get(element) : undefined;
      if (!element) return participant;
      if (!shape || !isLinkable(shape)) {
        advisories.push(`Sequence "${id}": "${participant.name}" was not linked to "${element}" — a participant stands for a service, data store, queue, actor or component.`);
        return participant;
      }
      return participantFromNode(shape, participant.id);
    }),
  };
}

/** What the text asked for that was not drawn, said once per sequence. */
export function unsupportedAdvice(id: string, unsupported: readonly string[]): string[] {
  return unsupported.length ? [`Sequence "${id}" — not drawn: ${unsupported.slice(0, 6).join('; ')}${unsupported.length > 6 ? `; and ${unsupported.length - 6} more` : ''}.`] : [];
}

/** The node a sequence is on the canvas, at the size it needs. It is placed by whoever asked. */
export function sequenceNode(spec: SequenceSpec, shapes: ReadonlyMap<string, DraftNode>, ctx: DescribeContext, advisories: string[]): DraftNode {
  advisories.push(...unsupportedAdvice(spec.id, spec.unsupported));
  const node: DraftNode = { ...createNode({ id: spec.id, type: 'sequence', x: 0, y: 0, text: spec.title }), sequence: linked(spec.sequence, spec.links, shapes, spec.id, advisories) };
  return fitSequenceNode(undefined, node, ctx);
}

/** By the id each linked participant is written under in a read, the element it stands for. */
export function linksOf(sequence: DraftSequence): Map<string, string> {
  const alias = aliasesOf(sequence);
  return new Map(sequence.participants.flatMap((participant) => (participant.ref ? [[alias.get(participant.id) ?? participant.id, participant.ref] as const] : [])));
}

/** A sequence as a read reports it: the same text an update takes back. */
export function sequenceRead(node: DraftNode, full: boolean): Record<string, unknown> {
  const sequence = sequenceOf(node);
  const mermaid = sequenceToMermaid(node);
  const links = linksOf(sequence);
  return {
    id: node.id,
    title: node.text ?? '',
    participants: sequence.participants.length,
    messages: messagesOf(sequence).length,
    ...(full || mermaid.length <= SEQUENCE_READ_LIMIT ? { mermaid } : { truncated: true }),
    ...(links.size ? { links: Object.fromEntries(links) } : {}),
  };
}
