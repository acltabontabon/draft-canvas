import { categoryOf } from '../document/connectorSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { classifyConnector, isBaselineClass } from './classify';
import type { TrafficGroup, TrafficRole } from './types';

/** The traffic role is deliberately derived from the document vocabulary, never from labels. */
export function trafficRoleOf(node: DraftNode): TrafficRole {
  if (node.type === 'database' && node.databaseKind === 'table') return 'excluded';

  switch (categoryOf(node)) {
    case 'service':
    case 'external':
    case 'worker':
    case 'scheduler':
    case 'gateway':
      return 'compute';
    case 'queue':
    case 'topic':
    case 'stream':
    case 'deadLetter':
      return 'messaging';
    case 'database':
    case 'cache':
    case 'fileSystem':
    case 'objectStorage':
    case 'searchIndex':
      return 'data';
    case 'actor':
    case 'agent':
    case 'device':
      return 'origin';
    case 'junction':
      return 'junction';
    default:
      return 'excluded';
  }
}

export function trafficGroupOf(node: DraftNode): TrafficGroup | undefined {
  switch (trafficRoleOf(node)) {
    case 'compute':
      return 'services';
    case 'messaging':
      return 'messaging';
    case 'data':
      return 'data';
    default:
      return undefined;
  }
}

function isRuntime(node: DraftNode | undefined): boolean {
  const role = node === undefined ? 'excluded' : trafficRoleOf(node);
  return role === 'compute' || role === 'messaging' || role === 'data' || role === 'origin';
}

/**
 * A cheap hint for the UI — whether the status bar offers Traffic at all. The analysis
 * (`graph.ts`) stays authoritative; this answers from the first runtime connector it meets, and
 * walks Junction chains (within a bound) only when every runtime connector runs into one.
 */
export function mayHaveTraffic(nodes: ReadonlyMap<string, DraftNode>, edges: readonly DraftEdge[]): boolean {
  // Asked on every store update while the status bar shows, a drag frame included: the common
  // answer is found on the first runtime connector without allocating anything.
  let legs: DraftEdge[] | undefined;
  for (const edge of edges) {
    if (!edge.directed) continue;
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target || !isRuntime(source)) continue;
    if (isRuntime(target)) {
      if (isBaselineClass(classifyConnector(edge, source, target).class) || edge.semantic === 'compensates' || edge.semantic === 'deadLetters') return true;
    } else if (trafficRoleOf(target) === 'junction') {
      (legs ??= []).push(edge);
    }
  }
  if (!legs) return false;
  // Only a diagram whose runtime connectors all run into Junctions gets here: follow the chains,
  // within a bound, and read the first and last leg of each route as the analysis would.
  const outgoing = new Map<string, DraftEdge[]>();
  for (const edge of edges) {
    if (!edge.directed || !nodes.has(edge.source)) continue;
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }
  let budget = HINT_STEPS;
  for (const leg of legs) {
    const source = nodes.get(leg.source)!;
    const seen = new Set([leg.target]);
    const pending = [leg.target];
    for (let head = 0; head < pending.length; head += 1) {
      for (const next of outgoing.get(pending[head]!) ?? []) {
        if ((budget -= 1) < 0) return false;
        const target = nodes.get(next.target);
        if (!target) continue;
        if (trafficRoleOf(target) === 'junction') {
          if (!seen.has(target.id)) {
            seen.add(target.id);
            pending.push(target.id);
          }
        } else if (
          isRuntime(target) &&
          isBaselineClass(classifyConnector(leg, source, target).class) &&
          isBaselineClass(classifyConnector(next, source, target).class)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/** How far the hint follows Junctions before saying no — the analysis has its own, larger bound. */
const HINT_STEPS = 20_000;
