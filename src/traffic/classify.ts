import { capabilityFor, categoryOf, type NodeCategory } from '../document/connectorSemantics';
import { MESSAGING_CATEGORIES, STORE_CATEGORIES } from '../document/edgeSemantics';
import type { DraftEdge, DraftNode, EdgeSemantic } from '../document/types';
import type { TrafficClass, UncertaintyReason, WorkloadKind } from './types';

export interface ClassifiedTraffic {
  from: string;
  to: string;
  class: TrafficClass;
  workload?: WorkloadKind;
  certainty: 'definite' | 'possible';
  uncertainty?: UncertaintyReason;
  sync: boolean;
  inferred: boolean;
}

const BASELINE_CLASSES = new Set<TrafficClass>(['request', 'data', 'publish', 'deliver']);

export function isBaselineClass(value: TrafficClass): boolean {
  return BASELINE_CLASSES.has(value);
}

function isCompute(category: NodeCategory): boolean {
  return category === 'service' || category === 'external' || category === 'worker' || category === 'scheduler' || category === 'gateway';
}

function isOrigin(category: NodeCategory): boolean {
  return category === 'actor' || category === 'agent' || category === 'device';
}

function isMessaging(category: NodeCategory): boolean {
  return MESSAGING_CATEGORIES.has(category);
}

function isStore(category: NodeCategory): boolean {
  return STORE_CATEGORIES.has(category);
}

function isRuntimeCategory(category: NodeCategory): boolean {
  return isCompute(category) || isOrigin(category) || isMessaging(category) || isStore(category);
}

function workloadFor(value: TrafficClass): WorkloadKind | undefined {
  if (value === 'request') return 'request';
  if (value === 'publish' || value === 'deliver') return 'message';
  if (value === 'data') return 'data';
  return undefined;
}

function semanticClass(semantic: EdgeSemantic, source: NodeCategory, target: NodeCategory): { from: 'source' | 'target'; to: 'source' | 'target'; class: TrafficClass } {
  const sourceIsStore = isStore(source);
  const targetIsStore = isStore(target);
  const sourceIsMessaging = isMessaging(source);
  const targetIsMessaging = isMessaging(target);
  const sourceIsOrigin = isOrigin(source);
  const targetIsOrigin = isOrigin(target);

  if (targetIsOrigin) return { from: 'source', to: 'target', class: 'participant' };

  switch (semantic) {
    case 'http':
    case 'grpc':
    case 'calls':
    case 'routes':
    case 'triggers':
      return { from: 'source', to: 'target', class: isCompute(target) ? 'request' : 'unknown' };
    case 'command':
    case 'query':
    case 'event':
      if (semantic === 'query' && (sourceIsStore || targetIsStore)) {
        if (sourceIsStore && targetIsStore) return { from: 'source', to: 'target', class: 'background' };
        return sourceIsStore
          ? { from: 'target', to: 'source', class: 'data' }
          : { from: 'source', to: 'target', class: 'data' };
      }
      if (targetIsMessaging && !sourceIsMessaging) return { from: 'source', to: 'target', class: 'publish' };
      if (sourceIsMessaging && !targetIsMessaging) return { from: 'source', to: 'target', class: 'deliver' };
      if (isCompute(target)) return { from: 'source', to: 'target', class: 'request' };
      if (sourceIsOrigin && isCompute(target)) return { from: 'source', to: 'target', class: 'request' };
      return { from: 'source', to: 'target', class: 'unknown' };
    case 'reads':
    case 'writes':
    case 'readsWrites':
    case 'searches':
    case 'indexes':
    case 'invalidates':
    case 'watches':
      if (sourceIsStore && targetIsStore) return { from: 'source', to: 'target', class: 'background' };
      if (sourceIsStore) return { from: 'target', to: 'source', class: 'data' };
      if (targetIsStore) return { from: 'source', to: 'target', class: 'data' };
      return { from: 'source', to: 'target', class: 'unknown' };
    case 'ingests':
      if (sourceIsMessaging && targetIsStore) return { from: 'source', to: 'target', class: 'data' };
      return { from: 'source', to: 'target', class: 'background' };
    case 'publishes':
      if (targetIsMessaging && !sourceIsMessaging && isRuntimeCategory(source)) {
        return { from: 'source', to: 'target', class: 'publish' };
      }
      return { from: 'source', to: 'target', class: 'unknown' };
    case 'consumes':
      if (sourceIsMessaging && !targetIsMessaging) return { from: 'source', to: 'target', class: 'deliver' };
      if (targetIsMessaging && !sourceIsMessaging) return { from: 'target', to: 'source', class: 'deliver' };
      return { from: 'source', to: 'target', class: 'unknown' };
    case 'deliversTo':
    case 'fansOut':
      // Messaging to messaging is the common case here, not an edge case: a topic fanning out to a
      // queue per subscriber (SNS → SQS) is how most fan-outs are drawn.
      return sourceIsMessaging
        ? { from: 'source', to: 'target', class: 'deliver' }
        : { from: 'source', to: 'target', class: 'unknown' };
    case 'replicates':
    case 'cdc':
    case 'syncs':
    case 'transforms':
      return { from: 'source', to: 'target', class: 'background' };
    case 'deadLetters':
    case 'compensates':
      return { from: 'source', to: 'target', class: 'failure' };
    case 'dependsOn':
    case 'uses':
    case 'implements':
    case 'implementedBy':
      return { from: 'source', to: 'target', class: 'structural' };
    case 'asks':
    case 'delegates':
    case 'escalates':
    case 'notifies':
      return { from: 'source', to: 'target', class: 'participant' };
    default: {
      const exhaustive: never = semantic;
      return exhaustive;
    }
  }
}

/** The behaviours that put a connector outside baseline traffic, and what they make it instead. */
export function behaviourClass(kind: DraftEdge['kind']): TrafficClass | undefined {
  if (kind === 'retry') return 'retry';
  if (kind === 'failure' || kind === 'fallback') return 'failure';
  if (kind === 'callback') return 'callback';
  return undefined;
}

function defaultSemantic(source: NodeCategory, target: NodeCategory): EdgeSemantic | undefined {
  return capabilityFor(source, target)?.defaultRelation;
}

/** Classify one connector while treating `source` and `target` as its concrete outer endpoints. */
export function classifyConnector(
  edge: Pick<DraftEdge, 'directed' | 'semantic' | 'kind' | 'condition' | 'async'>,
  source: DraftNode,
  target: DraftNode,
): ClassifiedTraffic {
  const sourceCategory = categoryOf(source);
  const targetCategory = categoryOf(target);
  const base = { from: source.id, to: target.id };
  if (!edge.directed) {
    return { ...base, class: 'association', certainty: 'definite', sync: false, inferred: false };
  }

  const semantic = edge.semantic ?? defaultSemantic(sourceCategory, targetCategory);
  const inferred = edge.semantic === undefined && semantic !== undefined;
  const classified = semantic === undefined ? { from: 'source' as const, to: 'target' as const, class: 'unknown' as const } : semanticClass(semantic, sourceCategory, targetCategory);
  // A behaviour only takes traffic out of the baseline; it never turns a structural or failure
  // relationship into a retry or callback that would then be reported as amplifying anything.
  const trafficClass = isBaselineClass(classified.class) ? behaviourClass(edge.kind) ?? classified.class : classified.class;

  const from = classified.from === 'source' ? source.id : target.id;
  const to = classified.to === 'source' ? source.id : target.id;
  const conditional = edge.kind === 'conditional' || edge.condition?.trim() !== undefined && edge.condition.trim() !== '';
  const certainty = conditional ? 'possible' : edge.semantic === 'publishes' && sourceCategory === 'objectStorage' ? 'possible' : 'definite';
  const uncertainty = conditional ? 'conditional' : edge.semantic === 'publishes' && sourceCategory === 'objectStorage' ? 'inferred-trigger' : undefined;
  const sync = (trafficClass === 'request' || trafficClass === 'data') && edge.async !== true && (edge.kind === undefined || edge.kind === 'sync');
  return { from, to, class: trafficClass, workload: workloadFor(trafficClass), certainty, uncertainty, sync, inferred };
}
