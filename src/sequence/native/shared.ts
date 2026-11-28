/**
 * What writing a native sequence as text and reading it back share (`mermaid.ts`,
 * `agent/sequences.ts`): the identifiers participants are written under, and the running account of
 * who is working — which Mermaid keeps strictly top to bottom.
 */
import { categoryOf } from '../../document/connectorSemantics';
import type { DraftSequence, SeqParticipant } from '../../document/types';
import { aliasFor } from '../alias';
import type { ParticipantKind } from '../types';

/** The declaration keyword family a participant is written with: the same coarse four a Flow's reading uses (`types.ts`). */
export function participantKindOf(participant: SeqParticipant): ParticipantKind {
  switch (categoryOf(participant)) {
    case 'actor':
    case 'agent':
    case 'device':
      return 'actor';
    case 'database':
    case 'cache':
    case 'fileSystem':
    case 'objectStorage':
    case 'searchIndex':
      return 'database';
    case 'queue':
    case 'topic':
    case 'stream':
    case 'deadLetter':
      return 'queue';
    default:
      return 'participant';
  }
}

/** A readable identifier for every participant: `CheckoutApi`, `CheckoutApi2` for a second of the same name. */
export function aliasesOf(sequence: DraftSequence): Map<string, string> {
  const taken = new Set<string>();
  const aliases = new Map<string, string>();
  sequence.participants.forEach((participant, index) => {
    const alias = aliasFor(participant.name, `P${index + 1}`, taken);
    taken.add(alias);
    aliases.set(participant.id, alias);
  });
  return aliases;
}

/**
 * The participants a `create` message brings into being, by the message that does it: they are
 * declared there, not at the top. Only where the text names them first: Mermaid refuses to
 * create a participant already there, and one that takes part above its create message (which
 * `check.ts` flags and allows) made the whole Mermaid text fail to parse. Such a one is declared at
 * the top, and its create message is written as any other.
 */
export function createdBy(sequence: DraftSequence): Map<string, string> {
  const made = new Map<string, string>();
  /** Who the text has named so far, top to bottom — what each item writes. */
  const named = new Set<string>();
  const everyone = sequence.participants.map((participant) => participant.id);
  const visit = (items: DraftSequence['items']) => {
    for (const item of items) {
      if (item.t === 'message') {
        if (item.kind === 'create' && item.from !== item.to && !named.has(item.to)) made.set(item.id, item.to);
        named.add(item.from).add(item.to);
      } else if (item.t === 'note') {
        // Over its first and last participant, or beside its first.
        named.add(item.over[0]!).add(item.side ? item.over[0]! : item.over[item.over.length - 1]!);
      } else if (item.operator === 'ref') {
        // A reference covering nobody in particular covers everyone.
        for (const id of item.covers?.length ? item.covers : everyone) named.add(id);
      } else {
        for (const branch of item.operands) visit(branch.items);
      }
    }
  };
  visit(sequence.items);
  return made;
}

/**
 * Who is working, counted the way Mermaid counts it: straight down the text, with no
 * idea that the branches of an `alt` are alternatives. A sequence may end the same piece of work in
 * each branch — which is right, and which Mermaid refuses as "ending work that is not running".
 * So an end is only written where its count has something to end; the picture then renders, with
 * the bar closed at the first place it is ended.
 */
export class Working {
  private readonly counts = new Map<string, number>();
  start(participantId: string): void {
    this.counts.set(participantId, (this.counts.get(participantId) ?? 0) + 1);
  }
  /** True when there was work to end, and so the end may be written. */
  end(participantId: string): boolean {
    const running = this.counts.get(participantId) ?? 0;
    if (running === 0) return false;
    this.counts.set(participantId, running - 1);
    return true;
  }
  /** A destroyed participant has nothing running. */
  clear(participantId: string): void {
    this.counts.delete(participantId);
  }
}
