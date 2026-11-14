/**
 * What the two native emitters share: the identifiers participants are written under, and the
 * running account of who is working — which both formats keep strictly top to bottom.
 */
import { categoryOf } from '../../document/connectorSemantics';
import type { DraftSequence, SeqParticipant } from '../../document/types';
import { aliasFor } from '../alias';
import type { ParticipantKind } from '../types';

/** The declaration keyword family a participant is written with: the same coarse four the Flow export uses. */
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

/** The participants a `create` message brings into being, by the message that does it: they are declared there, not at the top. */
export function createdBy(sequence: DraftSequence): Map<string, string> {
  const made = new Map<string, string>();
  const claimed = new Set<string>();
  const visit = (items: DraftSequence['items']) => {
    for (const item of items) {
      if (item.t === 'message') {
        if (item.kind === 'create' && item.from !== item.to && !claimed.has(item.to)) {
          claimed.add(item.to);
          made.set(item.id, item.to);
        }
      } else if (item.t === 'fragment') for (const branch of item.operands) visit(branch.items);
    }
  };
  visit(sequence.items);
  return made;
}

/**
 * Who is working, counted the way Mermaid and PlantUML count it: straight down the text, with no
 * idea that the branches of an `alt` are alternatives. A sequence may end the same piece of work in
 * each branch — which is right, and which both formats refuse as "ending work that is not running".
 * So an end is only written where their count has something to end; the picture then renders, with
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
