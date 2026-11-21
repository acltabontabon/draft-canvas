import { continuationsFor, materialize, type Continuation, type FragmentNodeSpec, type MaterializedContinuation } from '../continuation';
import { createEdge, defaultSizeFor } from '../document/factory';
import { addNodes, placeNear } from '../document/operations';
import { inferRelationshipThroughJunctions } from '../document/reinfer';
import type { DraftDocument, ViewLevel } from '../document/types';
import type { ContinuationOffer, QuickConnectState } from '../store/uiStore';
import { quickConnectPresets, type Preset } from '../lib/presets';

/**
 * One row of the Quick Connect picker. A `continuation` row is what Intent Continuation would
 * offer for the source node (see `src/continuation/`); a `preset` row is one of the picker's
 * standing choices. Both preview and create through the same `offerFor` path, so what the ghost
 * shows for a row is exactly what choosing it adds.
 */
export type QuickConnectItem =
  | { kind: 'continuation'; id: string; label: string; continuation: Continuation; node: FragmentNodeSpec }
  | { kind: 'preset'; id: string; label: string; preset: Preset; node: FragmentNodeSpec };

/**
 * The rows for a picker in this state: the engine's offers for the source first (already ordered,
 * best first), then the standing presets minus any a suggestion already stands in for. A picker
 * with no source (a double-click on empty canvas) is presets only — there is nothing to continue.
 *
 * Dismissals are deliberately not consulted here. Escape on a ghost means "stop offering this
 * unprompted"; a picker the user opened by dragging a connector out is a list they asked for, and
 * the best-fitting row still belongs at the top of it.
 */
export function quickConnectItems(
  doc: DraftDocument,
  state: QuickConnectState,
  recent?: readonly string[],
  /** What the view is showing, where that is known — orders the standing choices, never trims them. */
  level?: ViewLevel,
): QuickConnectItem[] {
  const suggestions: QuickConnectItem[] = state.source
    ? continuationsFor(doc, state.source, 'drop', { recent, level }).map((continuation) => ({
        kind: 'continuation',
        id: continuation.id,
        label: continuation.label,
        continuation,
        node: continuation.fragment.nodes[0]!,
      }))
    : [];
  const presets: QuickConnectItem[] = quickConnectPresets(level).filter(
    (preset) => !suggestions.some((s) => representsPreset(s, preset)),
  ).map((preset) => ({
    kind: 'preset',
    id: `preset:${preset.id}`,
    label: preset.label,
    preset,
    node: { key: 'n', type: preset.type, text: preset.text, accent: preset.accent },
  }));
  return [...suggestions, ...presets];
}

/**
 * Whether a suggestion *is* a preset's shape, so listing both would be the same row twice: a plain
 * Queue is the Queue preset. Strict about "plain" — any kind, role or name of its own makes it
 * another shape: a Worker, an API, a Topic, a dead-letter queue or a "Web App" is not what the
 * Service, Queue or Data Store row would draw, and the row must stay when only they are on offer. A
 * multi-node suggestion (Queue → Worker) stands in for no single preset.
 */
function representsPreset(item: QuickConnectItem, preset: Preset): boolean {
  const spec = item.node;
  if (item.kind === 'continuation' && item.continuation.fragment.nodes.length !== 1) return false;
  if (spec.type !== preset.type || spec.deliveryRole !== undefined) return false;
  if (spec.text !== undefined && spec.text !== preset.text) return false;
  return (
    (spec.serviceKind ?? 'generic') === 'generic' &&
    (spec.databaseKind ?? 'generic') === 'generic' &&
    (spec.queueKind ?? 'queue') === 'queue' &&
    spec.actorKind === undefined &&
    spec.componentKind === undefined
  );
}

/**
 * The elements choosing this row would add, positioned at the drop point (centred on where the
 * user let go). A preset row is wrapped as a one-node continuation so it flows through the same
 * `materialize` — and therefore the same matrix inference — as a suggested one. `undefined` only
 * when the source node has vanished under the open menu.
 */
export function offerFor(doc: DraftDocument, state: QuickConnectState, item: QuickConnectItem): ContinuationOffer | undefined {
  if (!state.source) return undefined;
  const size = defaultSizeFor(item.node.type);
  const at = state.center
    ? { x: state.center.x - size.width / 2, y: state.center.y - size.height / 2 }
    : state.flowPosition;
  const continuation: Continuation =
    item.kind === 'continuation'
      ? item.continuation
      : {
          id: item.id,
          ruleId: item.id,
          tier: 'secondary',
          confidence: 'medium',
          score: 0,
          label: item.label,
          actionLabel: `Add ${item.label}`,
          fragment: { nodes: [item.node], edges: [{ from: 'anchor', to: item.node.key }] },
          anchorId: state.source,
          neighborhoodKey: '',
        };
  // Asked for with `]`: beside the source, like any suggestion — and where that finds no room, the
  // nearest clear spot around it, never a fixed point that may already be taken.
  const source = state.asked ? doc.nodes.find((node) => node.id === state.source) : undefined;
  const offer = source
    ? (materialize(doc, continuation) ?? materialize(doc, continuation, { at: placeNear(doc, source, size) }))
    : // Dragged out by hand: its ends are automatic, like those of a connector dropped on a shape, so
      // the line the ghost shows is the line that is added and it keeps facing the shapes as they move.
      materialize(doc, continuation, { at, ends: 'automatic' });
  return offer ? { ...withFanIn(doc, state, offer), trigger: 'drop' } : undefined;
}

/**
 * The offer with a connector from every other shape the drag carried, to the same new shape the
 * dragged one reaches — what dropping on an existing shape does (`connectMany`), so the picker's
 * ghost shows every line the drag did and choosing a row adds them all in its one undo step (#177).
 * Each connector means what a single drag between that pair would have meant.
 */
function withFanIn(doc: DraftDocument, state: QuickConnectState, offer: MaterializedContinuation): MaterializedContinuation {
  if (!state.fanIn?.length) return offer;
  const targetId = offer.edges.find((edge) => edge.source === offer.anchorId)?.target;
  const target = offer.nodes.find((node) => node.id === targetId);
  if (!target) return offer;
  // Inference looks the new shape up by id, so it reads the document as it will be.
  const after = addNodes(doc, offer.nodes);
  const extra = [...new Set(state.fanIn)].flatMap((id) => {
    const source = id === offer.anchorId ? undefined : doc.nodes.find((node) => node.id === id);
    if (!source) return [];
    const relationship = inferRelationshipThroughJunctions(after, source, target);
    return [
      createEdge({
        source: source.id,
        target: target.id,
        kind: relationship?.kind,
        semantic: relationship?.semantic,
        async: relationship?.async,
        semanticsOrigin: relationship ? 'inferred' : undefined,
      }),
    ];
  });
  return extra.length > 0 ? { ...offer, edges: [...offer.edges, ...extra] } : offer;
}
