/**
 * Canvas -> SequenceModel — the one pure transform from Draft Canvas's live document into the
 * renderer-agnostic sequence representation. No React, no Mermaid/PlantUML syntax, no canvas
 * rendering. Aggregates every *playable* Flow into one coherent diagram (see
 * `docs/ARCHITECTURE.md`) — Mermaid (`mermaid.ts`) and PlantUML (`plantuml.ts`) are both
 * independent, pure consumers of this same result.
 */
import { categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { flowIsPlayable } from '../document/flow';
import type { Attachment, DraftDocument, DraftFlow, DraftFlowStep, DraftNode } from '../document/types';
import { aliasFor } from './alias';
import {
  buildHopList,
  groupChains,
  nameForEndpoint,
  pickRepresentativeEdge,
  resolveChainEndpoints,
  type MessageChain,
  type ResolvedEndpoint,
} from './flatten';
import { interactionKindFor, resolveMessageLabel, resolveResponseLabel } from './label';
import { isStructural } from './structural';
import type {
  InteractionKind,
  ParticipantKind,
  SequenceElement,
  SequenceGroup,
  SequenceMessage,
  SequenceModel,
  SequenceNote,
  SequenceParticipant,
} from './types';

function participantKindFor(category: NodeCategory): ParticipantKind {
  switch (category) {
    case 'actor':
      return 'actor';
    case 'database':
    case 'cache':
    case 'fileSystem':
    case 'objectStorage':
    case 'searchIndex':
      return 'database';
    case 'queue':
    case 'topic':
    case 'deadLetter':
      return 'queue';
    default:
      return 'participant';
  }
}

interface ParticipantRegistry {
  /** Resolves an endpoint to its participant, minting a new one (in first-appearance order,
   *  across every flow — every flow shares one registry instance, see `buildSequenceModel`) the
   *  first time a given resolved node id is seen. This single-instance-across-flows behavior is
   *  the entire mechanism behind "Payment Service" being one participant whether it appears in
   *  Happy Path or Compensation. */
  resolve: (endpoint: ResolvedEndpoint) => SequenceParticipant;
  /** An existing participant for a plain node id, if one has already been minted — never mints.
   *  Lets a standalone annotation anchor to a node already introduced as a message endpoint,
   *  without ever fabricating a participant just to attach a note. */
  find: (nodeId: string) => SequenceParticipant | undefined;
  /** Every participant seen so far, with duplicate display labels disambiguated by a cosmetic
   *  " (2)"/" (3)" suffix and a collision-safe `alias` assigned to each. */
  list: () => SequenceParticipant[];
}

/** Assigns stable machine ids to participants in first-appearance order and — once the whole
 *  walk is done — a human-readable, collision-safe `alias` (see `alias.ts`) derived from each
 *  participant's final, disambiguated label. */
function createParticipantRegistry(doc: DraftDocument): ParticipantRegistry {
  const byNodeId = new Map<string, SequenceParticipant>();
  const order: SequenceParticipant[] = [];

  function mint(nodeId: string, isJunctionFallback: boolean): SequenceParticipant {
    const node = doc.nodes.find((n) => n.id === nodeId);
    const category: NodeCategory = node ? categoryOf(node) : 'generic';
    const participant: SequenceParticipant = {
      id: `P${order.length + 1}`,
      alias: '', // assigned in list(), after label disambiguation
      label: nameForEndpoint(doc, { nodeId, isJunctionFallback }),
      category,
      kind: participantKindFor(category),
      sourceNodeId: nodeId,
      ...(isJunctionFallback ? { isJunctionFallback: true } : {}),
    };
    byNodeId.set(nodeId, participant);
    order.push(participant);
    return participant;
  }

  return {
    resolve(endpoint) {
      return byNodeId.get(endpoint.nodeId) ?? mint(endpoint.nodeId, endpoint.isJunctionFallback);
    },
    find(nodeId) {
      return byNodeId.get(nodeId);
    },
    list() {
      const counts = new Map<string, number>();
      for (const p of order) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
      const seen = new Map<string, number>();
      const labeled = order.map((p) => {
        if ((counts.get(p.label) ?? 1) <= 1) return p;
        const occurrence = (seen.get(p.label) ?? 0) + 1;
        seen.set(p.label, occurrence);
        return occurrence === 1 ? p : { ...p, label: `${p.label} (${occurrence})` };
      });
      const takenAliases = new Set<string>();
      return labeled.map((p) => {
        const alias = aliasFor(p.label, p.id, takenAliases);
        takenAliases.add(alias);
        return { ...p, alias };
      });
    },
  };
}

/** One flow's own annotation source: a standalone `note`/`code` node's text/code, keyed by
 *  which optional native prefix (if any) and language it carries. */
function annotationKind(node: DraftNode): 'note' | 'code' | undefined {
  if (node.type === 'note') return 'note';
  if (node.type === 'code') return 'code';
  return undefined; // 'text' nodes (and anything else) are never treated as sequence annotations
}

/** An `Attachment` folded onto a node or edge, turned into a `SequenceNote` anchored to
 *  `participantIds` — never a message, never a participant. Plain Text attachments carry no
 *  behavioral or annotative meaning here and are skipped, same as a standalone Text node. */
function noteFromAttachment(
  attachment: Attachment,
  participantIds: [string] | [string, string],
  sourceFlowId: string,
  sourceEdgeId?: string,
): Omit<SequenceNote, 'order'> | undefined {
  if (attachment.type === 'text') return undefined;
  const isCode = attachment.type === 'code';
  const text = isCode ? (attachment.code ?? '') : (attachment.text ?? '');
  if (!text.trim()) return undefined;
  const note: Omit<SequenceNote, 'order'> = {
    kind: 'note',
    participantIds,
    text,
    sourceFlowId,
    sourceAttachmentId: attachment.id,
  };
  if (sourceEdgeId) note.sourceEdgeId = sourceEdgeId;
  if (isCode) note.language = attachment.language;
  else note.noteKind = attachment.noteKind ?? 'note';
  return note;
}

/**
 * A standalone note/code step's anchor: the step's own message if it has one; otherwise the
 * first other `extraNodeIds` entry that already resolves to an EXISTING participant (never
 * mints one) — a two-participant span from the first and last such entries when there's more
 * than one, or a single-participant anchor otherwise. `undefined` when nothing in the step
 * resolves to a real participant — the note is then simply dropped rather than fabricating an
 * anchor for it.
 */
function anchorForStep(
  step: DraftFlowStep,
  messageByStepId: Map<string, SequenceMessage>,
  registry: ParticipantRegistry,
): [string] | [string, string] | undefined {
  const message = messageByStepId.get(step.id);
  if (message) return message.from === message.to ? [message.from] : [message.from, message.to];
  const others = (step.extraNodeIds ?? [])
    .map((id) => registry.find(id))
    .filter((p): p is SequenceParticipant => p !== undefined);
  if (others.length === 0) return undefined;
  const ids = [...new Set(others.map((p) => p.id))];
  return ids.length === 1 ? [ids[0]!] : [ids[0]!, ids[ids.length - 1]!];
}

/**
 * One flow's contribution: interleaves messages (in chain order), the notes/questions/code they
 * carry, and standalone `extraNodeIds` annotations, all in the flow's own step order — even
 * though a single chain can span more than one step (junction crossings) and a single step can
 * dispatch more than one chain (unmerged `extraEdgeIds`). Returns `undefined` (never an empty
 * shell) when the flow produces nothing to show.
 */
function buildFlowGroup(
  doc: DraftDocument,
  flow: DraftFlow,
  registry: ParticipantRegistry,
  introduced: Set<string>,
  nextOrder: () => number,
): SequenceGroup | undefined {
  const chains = groupChains(doc, buildHopList(doc, flow));

  // Keyed by a chain's FIRST step — not every step it spans — so the outer walk below dispatches
  // each chain exactly once, at the earliest point it can fire, in the same order `chains` itself
  // was built (hop order). More than one chain can share a first step (unmerged `extraEdgeIds`
  // hops on one step, none of them junction-adjacent) — both fire, in chain order.
  const stepIdToChainIndices = new Map<string, number[]>();
  chains.forEach((chain: MessageChain, i) => {
    const firstStepId = chain.stepIds[0];
    if (firstStepId === undefined) return;
    const list = stepIdToChainIndices.get(firstStepId);
    if (list) list.push(i);
    else stepIdToChainIndices.set(firstStepId, [i]);
  });

  const children: SequenceElement[] = [];
  const messageByStepId = new Map<string, SequenceMessage>();
  const emitted = new Set<number>();

  function emitNodeAttachmentNotes(participant: SequenceParticipant) {
    if (introduced.has(participant.id)) return;
    introduced.add(participant.id);
    const node = doc.nodes.find((n) => n.id === participant.sourceNodeId);
    for (const attachment of node?.attachments ?? []) {
      const note = noteFromAttachment(attachment, [participant.id], flow.id);
      if (note) children.push({ ...note, order: nextOrder() });
    }
  }

  function emitChain(index: number) {
    if (emitted.has(index)) return;
    emitted.add(index);
    const chain = chains[index]!;
    const rep = pickRepresentativeEdge(chain.edges);
    // Structural relationships (dependsOn, implementedBy) describe a static architectural fact,
    // not a runtime event — no message, and no participant minted from this chain alone.
    if (isStructural(rep)) return;

    const { source, target } = resolveChainEndpoints(doc, chain);
    const from = registry.resolve(source);
    const to = registry.resolve(target);

    emitNodeAttachmentNotes(from);
    emitNodeAttachmentNotes(to);

    const interaction: InteractionKind = interactionKindFor(rep);
    const label = resolveMessageLabel(rep, from.category, to.category, interaction);
    const sourceEdgeIds = chain.edges.map((e) => e.id);
    const message: SequenceMessage = {
      kind: 'message',
      order: nextOrder(),
      from: from.id,
      to: to.id,
      label,
      interaction,
      accent: flow.accent,
      sourceFlowId: flow.id,
      sourceEdgeIds,
      sourceStepIds: chain.stepIds,
    };
    children.push(message);
    for (const stepId of chain.stepIds) messageByStepId.set(stepId, message);

    const participantIds: [string] | [string, string] = from.id === to.id ? [from.id] : [from.id, to.id];
    for (const attachment of rep.attachments ?? []) {
      const note = noteFromAttachment(attachment, participantIds, flow.id, rep.id);
      if (note) children.push({ ...note, order: nextOrder() });
    }

    if (rep.hasResponse) {
      children.push({
        kind: 'message',
        order: nextOrder(),
        from: to.id,
        to: from.id,
        label: resolveResponseLabel(rep.response),
        interaction: 'response',
        isResponse: true,
        accent: flow.accent,
        sourceFlowId: flow.id,
        sourceEdgeIds,
        sourceStepIds: chain.stepIds,
      });
    }
  }

  for (const step of flow.steps) {
    for (const chainIndex of stepIdToChainIndices.get(step.id) ?? []) emitChain(chainIndex);

    for (const nodeId of step.extraNodeIds ?? []) {
      const node = doc.nodes.find((n) => n.id === nodeId);
      const kind = node && annotationKind(node);
      if (!node || !kind) continue;
      const anchor = anchorForStep(step, messageByStepId, registry);
      if (!anchor) continue; // never fabricate a participant just to anchor a note
      const text = kind === 'note' ? (node.text ?? '') : (node.code ?? '');
      if (!text.trim()) continue;
      const note: SequenceNote = {
        kind: 'note',
        order: nextOrder(),
        participantIds: anchor,
        text,
        sourceFlowId: flow.id,
        sourceNodeId: node.id,
      };
      if (kind === 'note') note.noteKind = node.noteKind ?? 'note';
      else note.language = node.language;
      children.push(note);
    }
  }

  if (children.length === 0) return undefined;
  return { kind: 'group', id: flow.id, label: flow.title, sourceFlowId: flow.id, children };
}

export function buildSequenceModel(doc: DraftDocument): SequenceModel {
  const registry = createParticipantRegistry(doc);
  const introduced = new Set<string>();
  let orderCounter = 0;
  const nextOrder = () => orderCounter++;

  const groups: SequenceGroup[] = [];
  for (const flow of doc.flows.filter((f) => flowIsPlayable(doc, f))) {
    const group = buildFlowGroup(doc, flow, registry, introduced, nextOrder);
    if (group) groups.push(group);
  }

  return { title: doc.metadata.title, participants: registry.list(), elements: groups };
}
