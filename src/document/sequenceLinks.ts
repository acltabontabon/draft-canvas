/**
 * A participant that stands for a shape on the canvas.
 *
 * The two are one thing in two places. What makes them the same thing is identity — the name, what
 * kind of thing it is, what it is built with, its colour — and that is what is kept in step, in
 * whichever of the two it was changed. Where the shape sits, what it is connected to and what is
 * inside it are the architecture's business and never the sequence's.
 */
import { displayNameFor } from './factory';
import { C4_TEXT_TYPES, type DraftNode, type SeqParticipant, type SeqParticipantType } from './types';

/** Whether a shape is one a participant can stand for: a piece of architecture. */
export function isLinkable(node: Pick<DraftNode, 'type'>): node is DraftNode & { type: SeqParticipantType } {
  return (C4_TEXT_TYPES as readonly string[]).includes(node.type);
}

/** What a shape is, as a participant carries it. */
export function identityOf(node: DraftNode & { type: SeqParticipantType }): Omit<SeqParticipant, 'id' | 'ref'> {
  const identity: Omit<SeqParticipant, 'id' | 'ref'> = { name: displayNameFor(node).replace(/\s+/g, ' ').trim(), type: node.type };
  if (node.type === 'service') identity.serviceKind = node.serviceKind ?? 'generic';
  if (node.type === 'database') identity.databaseKind = node.databaseKind ?? 'generic';
  if (node.type === 'queue') {
    identity.queueKind = node.queueKind ?? 'queue';
    if (node.deliveryRole) identity.deliveryRole = node.deliveryRole;
  }
  if (node.type === 'actor') identity.actorKind = node.actorKind ?? 'human';
  if (node.type === 'component') identity.componentKind = node.componentKind ?? 'generic';
  if (node.technology) identity.technology = node.technology;
  if (node.technology && node.kindOrigin) identity.kindOrigin = node.kindOrigin;
  if (node.accent) identity.accent = node.accent;
  return identity;
}

/** The participant that stands for `node`, linked to it. */
export function participantFromNode(node: DraftNode & { type: SeqParticipantType }, id: string): SeqParticipant {
  return { id, ...identityOf(node), ref: node.id };
}
