/**
 * Flow → SequenceModel — the one pure transform from a Draft Canvas Flow into the renderer-
 * agnostic sequence representation. No React, no Mermaid/PlantUML syntax, no canvas rendering.
 * Every output (the SVG preview, Mermaid, PlantUML) is an independent consumer of this result.
 */
import { categoryOf, type NodeCategory } from '../document/connectorSemantics';
import type { DraftDocument, DraftFlow } from '../document/types';
import {
  buildHopList,
  groupChains,
  nameForEndpoint,
  pickRepresentativeEdge,
  resolveChainEndpoints,
  type ResolvedEndpoint,
} from './flatten';
import { interactionKindFor, resolveMessageLabel, resolveResponseLabel } from './label';
import type { InteractionKind, ParticipantKind, SequenceMessage, SequenceModel, SequenceParticipant } from './types';

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
  /** Resolves an endpoint to its participant, minting a new one (in first-appearance order) the
   *  first time a given resolved node id is seen. */
  resolve: (endpoint: ResolvedEndpoint) => SequenceParticipant;
  /** Every participant seen so far, with duplicate display labels disambiguated by a cosmetic
   *  " (2)"/" (3)" suffix — ids and order are already unique, so this only ever changes `label`. */
  list: () => SequenceParticipant[];
}

/** Assigns stable machine aliases to participants in first-appearance order, deduplicating by
 *  resolved node id (a Junction-fallback's own id counts as one identity, same as any real node). */
function createParticipantRegistry(doc: DraftDocument): ParticipantRegistry {
  const byNodeId = new Map<string, SequenceParticipant>();
  const order: SequenceParticipant[] = [];

  return {
    resolve(endpoint) {
      const existing = byNodeId.get(endpoint.nodeId);
      if (existing) return existing;
      const node = doc.nodes.find((n) => n.id === endpoint.nodeId);
      const category: NodeCategory = node ? categoryOf(node) : 'generic';
      const participant: SequenceParticipant = {
        id: `P${order.length + 1}`,
        label: nameForEndpoint(doc, endpoint),
        category,
        kind: participantKindFor(category),
        sourceNodeId: endpoint.nodeId,
        ...(endpoint.isJunctionFallback ? { isJunctionFallback: true } : {}),
      };
      byNodeId.set(endpoint.nodeId, participant);
      order.push(participant);
      return participant;
    },
    list() {
      const counts = new Map<string, number>();
      for (const p of order) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
      const seen = new Map<string, number>();
      return order.map((p) => {
        if ((counts.get(p.label) ?? 1) <= 1) return p;
        const occurrence = (seen.get(p.label) ?? 0) + 1;
        seen.set(p.label, occurrence);
        return occurrence === 1 ? p : { ...p, label: `${p.label} (${occurrence})` };
      });
    },
  };
}

export function buildSequenceModel(doc: DraftDocument, flow: DraftFlow): SequenceModel {
  const chains = groupChains(doc, buildHopList(doc, flow));
  const registry = createParticipantRegistry(doc);
  const messages: SequenceMessage[] = [];

  for (const chain of chains) {
    const endpoints = resolveChainEndpoints(doc, chain);
    const from = registry.resolve(endpoints.source);
    const to = registry.resolve(endpoints.target);
    const edge = pickRepresentativeEdge(chain.edges);
    const interaction: InteractionKind = interactionKindFor(edge);
    const label = resolveMessageLabel(edge, from.category, to.category, interaction);
    const sourceEdgeIds = chain.edges.map((e) => e.id);

    messages.push({
      order: messages.length,
      from: from.id,
      to: to.id,
      label,
      interaction,
      accent: flow.accent,
      sourceEdgeIds,
      sourceStepIds: chain.stepIds,
    });

    if (edge.hasResponse) {
      messages.push({
        order: messages.length,
        from: to.id,
        to: from.id,
        label: resolveResponseLabel(edge.response),
        interaction: 'response',
        isResponse: true,
        accent: flow.accent,
        sourceEdgeIds,
        sourceStepIds: chain.stepIds,
      });
    }
  }

  return { flowId: flow.id, flowTitle: flow.title, participants: registry.list(), messages };
}
