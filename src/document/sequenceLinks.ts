/**
 * A participant that stands for a shape on the canvas.
 *
 * The two are one thing in two places. What makes them the same thing is identity — the name, what
 * kind of thing it is, what it is built with, its colour — and that is what is kept in step, in
 * whichever of the two it was changed. Where the shape sits, what it is connected to and what is
 * inside it are the architecture's business and never the sequence's.
 */
import { convertedNode, isConvertibleType } from './convert';
import { displayNameFor } from './factory';
import { C4_TEXT_TYPES, type DraftDocument, type DraftNode, type SeqParticipant, type SeqParticipantType } from './types';

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

/**
 * Whether a shape is part of a diagram, and so stays in it when it is dropped into a sequence: it
 * is connected to something, sits in a boundary, has a view inside it, carries a note or an open
 * point, is a step in a flow, or another sequence already has it standing in it. One that is none
 * of these is a shape on its own, and putting it into a sequence moves it there — leaving it behind
 * as well would be a copy nobody asked for.
 */
export function isPartOfDiagram(document: DraftDocument, node: DraftNode): boolean {
  if (node.parentId || node.inside || (node.attachments?.length ?? 0) > 0) return true;
  if (document.edges.some((edge) => edge.source === node.id || edge.target === node.id)) return true;
  if ((document.openPoints ?? []).some((point) => point.targets.some((target) => target.kind === 'node' && target.id === node.id))) return true;
  if ((document.flows ?? []).some((flow) => flow.steps.some((step) => step.extraNodeIds?.includes(node.id)))) return true;
  return document.nodes.some((other) => other.sequence?.participants.some((participant) => participant.ref === node.id));
}

/** The participant that stands for `node`, linked to it. */
export function participantFromNode(node: DraftNode & { type: SeqParticipantType }, id: string): SeqParticipant {
  return { id, ...identityOf(node), ref: node.id };
}

const sameIdentity = (a: Omit<SeqParticipant, 'id' | 'ref'>, b: Omit<SeqParticipant, 'id' | 'ref'>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof typeof a>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};

const identityIn = (participant: SeqParticipant): Omit<SeqParticipant, 'id' | 'ref'> => {
  const { id: _id, ref: _ref, ...identity } = participant;
  return identity;
};

/** Whether a linked participant no longer says what its shape does: an edit that did not come through the editor. */
export function hasDrifted(participant: SeqParticipant, shape: DraftNode | undefined): boolean {
  return !!shape && isLinkable(shape) && !sameIdentity(identityIn(participant), identityOf(shape));
}

const KIND_FIELDS = ['serviceKind', 'databaseKind', 'queueKind', 'deliveryRole', 'actorKind', 'componentKind'] as const;

/** `shape` saying what `participant` now says: its name, what it is and what it is built with. */
function shapeFrom(shape: DraftNode & { type: SeqParticipantType }, participant: SeqParticipant): DraftNode {
  const base: DraftNode = shape.type !== participant.type && isConvertibleType(shape.type) && isConvertibleType(participant.type) ? convertedNode(shape, participant.type) : shape;
  const next: DraftNode = { ...base };
  if (participant.name !== displayNameFor(base).replace(/\s+/g, ' ').trim()) {
    next.text = participant.name;
    next.textOrigin = 'explicit';
  }
  if (base.type === participant.type) {
    for (const field of KIND_FIELDS) {
      const value = participant[field];
      if (value !== undefined) (next as unknown as Record<string, unknown>)[field] = value;
    }
  }
  for (const field of ['technology', 'kindOrigin', 'accent'] as const) {
    const value = participant[field];
    if (value === undefined) delete next[field];
    else (next as unknown as Record<string, unknown>)[field] = value;
  }
  return next;
}

/**
 * Carries a change of identity across every link, after an edit, whichever side it was made on.
 *
 * A participant renamed or retyped in its sequence changes the shape it stands for; a shape changed
 * on the canvas changes every participant that stands for it, in every sequence in the view. Both
 * land in the same edit, so the two are never seen disagreeing and one undo takes back both. Where
 * one edit somehow changed both ends, the shape is believed.
 *
 * Answers the document and the shapes it changed (which may now need more room for a longer name).
 * The same document back, at no cost, when no sequence in the view links to anything — nearly always.
 */
export function syncLinks(before: DraftDocument, after: DraftDocument): { doc: DraftDocument; shapes: string[] } {
  const none = { doc: after, shapes: [] as string[] };
  if (after === before || after.nodes === before.nodes) return none;
  const linked = after.nodes.filter((node) => node.sequence?.participants.some((participant) => participant.ref));
  if (linked.length === 0) return none;
  const was = new Map(before.nodes.map((node) => [node.id, node]));
  const now = new Map(after.nodes.map((node) => [node.id, node]));

  // A participant changed in its sequence: its shape follows — unless the shape itself was changed too.
  const shapes = new Map<string, DraftNode>();
  for (const host of linked) {
    const previous = was.get(host.id)?.sequence;
    if (!previous || previous === host.sequence) continue;
    for (const participant of host.sequence!.participants) {
      if (!participant.ref) continue;
      const earlier = previous.participants.find((candidate) => candidate.id === participant.id);
      if (!earlier || earlier.ref !== participant.ref || sameIdentity(identityIn(earlier), identityIn(participant))) continue;
      const shape = now.get(participant.ref);
      if (!shape || !isLinkable(shape) || shape !== was.get(participant.ref)) continue;
      shapes.set(shape.id, shapeFrom(shape, participant));
    }
  }

  // A shape changed (on the canvas, or just above): everyone who stands for it follows.
  let changed = shapes.size > 0;
  const nodes = after.nodes.map((node) => {
    const shape = shapes.get(node.id);
    if (shape) return shape;
    if (!node.sequence?.participants.some((participant) => participant.ref)) return node;
    let participants: SeqParticipant[] | null = null;
    node.sequence.participants.forEach((participant, index) => {
      if (!participant.ref) return;
      const shapeNow = shapes.get(participant.ref) ?? now.get(participant.ref);
      const shapeWas = was.get(participant.ref);
      if (!shapeNow || !shapeWas || shapeNow === shapeWas || !isLinkable(shapeNow)) return;
      const identity = identityOf(shapeNow);
      // Only what this edit changed about the shape; an older disagreement is not this edit's to settle.
      if (isLinkable(shapeWas) && sameIdentity(identity, identityOf(shapeWas))) return;
      if (sameIdentity(identity, identityIn(participant))) return;
      participants ??= node.sequence!.participants.slice();
      participants[index] = { id: participant.id, ...identity, ref: participant.ref };
    });
    if (!participants) return node;
    changed = true;
    return { ...node, sequence: { ...node.sequence, participants } };
  });
  return changed ? { doc: { ...after, nodes }, shapes: [...shapes.keys()] } : none;
}
