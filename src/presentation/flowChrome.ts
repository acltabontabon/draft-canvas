/**
 * The pure half of Presentation Mode's chrome (`ui/Editor/FlowBar.tsx`): how the flow list is
 * ordered, and the route a flow's opening names. No React — testable on their own, and kept out
 * of the component file so it exports components alone.
 */
import { displayNameFor } from '../document/factory';
import type { DraftFlow, DraftNode } from '../document/types';
import type { FlowPlaybackStep } from './useFlowPlayback';

/** The shapes a flow passes through, in the order its connectors first reach them. */
export function routeOf(steps: readonly FlowPlaybackStep[], nodes: ReadonlyMap<string, DraftNode>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (id: string) => {
    if (seen.has(id)) return;
    const node = nodes.get(id);
    if (!node) return;
    seen.add(id);
    names.push(displayNameFor(node));
  };
  for (const step of steps) {
    for (const edge of step.edges) {
      add(edge.source);
      add(edge.target);
    }
    for (const node of step.extraNodes) add(node.id);
  }
  return names;
}

/** Groups a flow with its named variant(s) (e.g. a failure path) right after it, in the picker's
 *  existing order — nothing reordered otherwise, and a variant whose base isn't in this playable
 *  list (rare — the base itself would have to not be presentable) just falls back to its own row. */
export function orderedWithVariants(flows: readonly DraftFlow[]): { flow: DraftFlow; variant: boolean }[] {
  const byId = new Map(flows.map((f) => [f.id, f]));
  const placed = new Set<string>();
  const rows: { flow: DraftFlow; variant: boolean }[] = [];
  for (const flow of flows) {
    if (placed.has(flow.id)) continue;
    if (flow.variantOf && byId.has(flow.variantOf)) continue; // placed alongside its base below
    rows.push({ flow, variant: false });
    placed.add(flow.id);
    for (const candidate of flows) {
      if (candidate.variantOf === flow.id && !placed.has(candidate.id)) {
        rows.push({ flow: candidate, variant: true });
        placed.add(candidate.id);
      }
    }
  }
  return rows;
}
