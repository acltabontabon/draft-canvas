import { continuationsFor, materialize, type Continuation, type FragmentNodeSpec } from '../continuation';
import { defaultSizeFor } from '../document/factory';
import type { DraftDocument } from '../document/types';
import type { ContinuationOffer, QuickConnectState } from '../store/uiStore';
import { QUICK_CONNECT_PRESETS, type Preset } from './presets';

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
export function quickConnectItems(doc: DraftDocument, state: QuickConnectState): QuickConnectItem[] {
  const suggestions: QuickConnectItem[] = state.source
    ? continuationsFor(doc, state.source, 'drop').map((continuation) => ({
        kind: 'continuation',
        id: continuation.ruleId,
        label: continuation.label,
        continuation,
        node: continuation.fragment.nodes[0]!,
      }))
    : [];
  const presets: QuickConnectItem[] = QUICK_CONNECT_PRESETS.filter(
    (preset) => !suggestions.some((s) => representsPreset(s.node, preset)),
  ).map((preset) => ({
    kind: 'preset',
    id: `preset:${preset.id}`,
    label: preset.label,
    preset,
    node: { key: 'n', type: preset.type, text: preset.text, accent: preset.accent },
  }));
  return [...suggestions, ...presets];
}

/** A suggested plain Queue *is* the Queue preset; a suggested Worker is not the Service preset. */
function representsPreset(spec: FragmentNodeSpec, preset: Preset): boolean {
  if (spec.type !== preset.type || spec.deliveryRole !== undefined) return false;
  return spec.type !== 'service' || spec.serviceKind !== 'worker';
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
          ruleId: item.id,
          tier: 'secondary',
          label: item.label,
          reason: '',
          fragment: { nodes: [item.node], edges: [{ from: 'anchor', to: item.node.key }] },
          anchorId: state.source,
          neighborhoodKey: '',
        };
  const offer = materialize(doc, continuation, { at });
  return offer ? { ...offer, trigger: 'drop' } : undefined;
}
