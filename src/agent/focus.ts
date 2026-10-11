import type { DraftDocument } from '../document/types';
import { descendantsOf } from '../document/operations';
import { AgentError } from './errors';

export function renderFocus(view: DraftDocument, raw: unknown): ReadonlySet<string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentError('INVALID_INPUT', 'focus must be an object.');
  const focus = raw as { nodes?: unknown; group?: unknown; flow?: unknown; neighbors?: unknown };
  if (Object.keys(focus).some((key) => !['nodes', 'group', 'flow', 'neighbors'].includes(key))) throw new AgentError('INVALID_INPUT', 'Unknown render focus field.');
  const modes = [focus.nodes, focus.group, focus.flow].filter((value) => value !== undefined);
  if (modes.length !== 1) throw new AgentError('INVALID_INPUT', 'Choose exactly one focus: nodes, group or flow.');
  const ids = new Set<string>();
  if (focus.nodes !== undefined) {
    if (!Array.isArray(focus.nodes) || !focus.nodes.length || focus.nodes.length > 200 || focus.nodes.some((id) => typeof id !== 'string' || !view.nodes.some((n) => n.id === id))) throw new AgentError('INVALID_REFERENCE', 'focus.nodes must name shapes in this view.');
    for (const id of focus.nodes) ids.add(id);
  }
  if (focus.group !== undefined) {
    if (typeof focus.group !== 'string' || !view.nodes.some((n) => n.id === focus.group && n.type === 'group')) throw new AgentError('INVALID_REFERENCE', 'focus.group must name a boundary in this view.');
    ids.add(focus.group);
    for (const id of descendantsOf(view, focus.group)) ids.add(id);
  }
  if (focus.flow !== undefined) {
    const flow = view.flows.find((f) => f.id === focus.flow);
    if (!flow) throw new AgentError('INVALID_REFERENCE', 'focus.flow must name a flow in this view.');
    for (const step of flow.steps) {
      for (const edge of view.edges) if (edge.id === step.edgeId || step.extraEdgeIds?.includes(edge.id)) { ids.add(edge.source); ids.add(edge.target); }
      for (const id of step.extraNodeIds ?? []) ids.add(id);
    }
  }
  if (focus.neighbors !== undefined && typeof focus.neighbors !== 'boolean') throw new AgentError('INVALID_INPUT', 'focus.neighbors must be a boolean.');
  if (focus.neighbors) for (const edge of view.edges.filter((e) => ids.has(e.source) || ids.has(e.target))) { ids.add(edge.source); ids.add(edge.target); }
  if (!ids.size) throw new AgentError('NOT_FOUND', 'There are no shapes in this focus.');
  return ids;
}
