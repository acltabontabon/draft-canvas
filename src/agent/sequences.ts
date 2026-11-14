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
import type { DraftNode, DraftSequence } from '../document/types';
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
