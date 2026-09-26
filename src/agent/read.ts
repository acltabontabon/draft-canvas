/**
 * `read_diagram`: one view of a diagram as meaning, not geometry — elements with their type, name,
 * C4 detail and derived C4 classification, boundaries, relationships, flows, notes and actions.
 *
 * Bounded by default: one room (a view), a page of elements, a byte ceiling. Nested views appear as
 * references (their owner, level and size) to read next, never expanded wholesale. A partial answer
 * says so, names what lies across its edge, and hands back a cursor tied to the revision it was
 * read at — so a page read after someone else's edit is refused rather than silently mismatched.
 *
 * Everything returned is the person's text, untrusted: agents are told so in the server's
 * instructions, and nothing here ever phrases document content as an instruction.
 */

import { continuationsFor } from '../continuation';
import { classify } from '../depth/c4';
import { effectiveLevel } from '../depth/level';
import { hasInside, resolvePath, viewOf, type DepthPath } from '../depth/tree';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { categoryOf } from '../document/connectorSemantics';
import type { Attachment, DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { AgentError } from './errors';
import { groupKindOf, typeWordOf } from './vocabulary';

export const READ_LIMITS = {
  elementsPerPage: 200,
  relationshipsPerPage: 400,
  flows: 20,
  bytes: 96 * 1024,
  noteText: 400,
  suggestionsPerElement: 5,
  suggestionElements: 20,
} as const;

const INCLUDES = ['geometry', 'attachments', 'suggestions'] as const;
type Include = (typeof INCLUDES)[number];

export interface ReadArgs {
  view?: { inside?: unknown };
  focus?: { nodes?: unknown; group?: unknown; flow?: unknown };
  include?: unknown;
  cursor?: unknown;
}

export function viewPathOf(file: DraftDocument, view: unknown): DepthPath {
  if (view === undefined || view === null) return [];
  const inside = (view as { inside?: unknown }).inside;
  if (inside === undefined) return [];
  if (!Array.isArray(inside) || inside.some((id) => typeof id !== 'string') || inside.length > 3) {
    throw new AgentError('INVALID_INPUT', 'view.inside must be the path of element ids to the view, outermost first (at most 3).', { path: '/view/inside' });
  }
  const path = inside as string[];
  const resolved = resolvePath(file, path);
  if (resolved.length !== path.length) {
    throw new AgentError('NOT_FOUND', `No inside view at ${path.join(' ▸ ')}.`, {
      path: '/view/inside',
      hint: 'Read the outer view first: an element with an inside view lists it under "inside".',
    });
  }
  return path;
}

function truncated(text: string, max: number): { text: string; truncated?: true } {
  const chars = [...text];
  return chars.length > max ? { text: `${chars.slice(0, max).join('')}…`, truncated: true } : { text };
}

export function readDiagram(file: DraftDocument, args: ReadArgs, revision: string, diagramId: string): Record<string, unknown> {
  const path = viewPathOf(file, args.view);
  const view = path.length ? viewOf(file, path) : file;
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');
  const includes = new Set<Include>(
    Array.isArray(args.include) ? (args.include as unknown[]).filter((i): i is Include => (INCLUDES as readonly unknown[]).includes(i)) : [],
  );
  const level = effectiveLevel(file, path);
  const ownLevel = view.level;
  const owner = path.length ? findOwner(file, path) : undefined;
  const byId = new Map(view.nodes.map((n) => [n.id, n]));

  // What the caller scoped the read to.
  let scope: Set<string> | undefined;
  const focus = args.focus;
  if (focus) {
    scope = new Set<string>();
    if (Array.isArray(focus.nodes)) for (const id of focus.nodes) if (typeof id === 'string' && byId.has(id)) scope.add(id);
    if (typeof focus.group === 'string') {
      if (!byId.has(focus.group)) throw new AgentError('NOT_FOUND', `No group "${focus.group}" in this view.`, { path: '/focus/group' });
      scope.add(focus.group);
      for (const node of view.nodes) if (ancestorsOf(node, byId).has(focus.group)) scope.add(node.id);
    }
    if (typeof focus.flow === 'string') {
      const flow = view.flows.find((f) => f.id === focus.flow);
      if (!flow) throw new AgentError('NOT_FOUND', `No flow "${focus.flow}" in this view.`, { path: '/focus/flow' });
      const edges = new Map(view.edges.map((e) => [e.id, e]));
      for (const step of flow.steps) {
        const edge = step.edgeId ? edges.get(step.edgeId) : undefined;
        if (edge) {
          scope.add(edge.source);
          scope.add(edge.target);
        }
        for (const id of step.extraNodeIds ?? []) scope.add(id);
      }
    }
  }

  const all = view.nodes.filter((n) => !scope || scope.has(n.id));
  const offset = cursorOffset(args.cursor, revision, path);
  let pageSize: number = READ_LIMITS.elementsPerPage;
  let result: Record<string, unknown> = {};
  // The byte ceiling is met by reading fewer elements, never by cutting a field short.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const page = all.slice(offset, offset + pageSize);
    result = project(file, view, page, all, path, level, ownLevel, owner, includes, revision, diagramId, offset, scope !== undefined);
    if (JSON.stringify(result).length <= READ_LIMITS.bytes || pageSize <= 10) break;
    pageSize = Math.max(10, Math.floor(pageSize / 2));
  }
  return result;
}

function findOwner(file: DraftDocument, path: DepthPath): DraftNode | undefined {
  let nodes = file.nodes;
  let owner: DraftNode | undefined;
  for (const id of path) {
    owner = nodes.find((n) => n.id === id);
    nodes = owner?.inside?.nodes ?? [];
  }
  return owner;
}

function ancestorsOf(node: DraftNode, byId: Map<string, DraftNode>): Set<string> {
  const out = new Set<string>();
  let at = node.parentId;
  while (at && !out.has(at)) {
    out.add(at);
    at = byId.get(at)?.parentId;
  }
  return out;
}

function cursorOffset(cursor: unknown, revision: string, path: DepthPath): number {
  if (cursor === undefined || cursor === null) return 0;
  if (typeof cursor !== 'string') throw new AgentError('INVALID_INPUT', 'cursor must be the string a previous read returned.', { path: '/cursor' });
  const match = /^c1\|(.+)\|(.*)\|(\d+)$/.exec(cursor);
  if (!match) throw new AgentError('INVALID_INPUT', 'That cursor is not one this diagram gave out.', { path: '/cursor' });
  if (match[1] !== revision || match[2] !== path.join('/')) {
    throw new AgentError('CURSOR_STALE', 'The diagram changed since that page was read.', {
      hint: 'Read again from the start (no cursor) to see the current revision.',
      details: { revision },
    });
  }
  return Number(match[3]);
}

function project(
  file: DraftDocument,
  view: DraftDocument,
  page: DraftNode[],
  all: DraftNode[],
  path: DepthPath,
  level: ReturnType<typeof effectiveLevel>,
  ownLevel: DraftDocument['level'],
  owner: DraftNode | undefined,
  includes: Set<Include>,
  revision: string,
  diagramId: string,
  offset: number,
  focused: boolean,
): Record<string, unknown> {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const inPage = new Set(page.map((n) => n.id));
  const elements: unknown[] = [];
  const groups: unknown[] = [];
  const notes: unknown[] = [];
  for (const node of page) {
    const geometry = includes.has('geometry') ? { geometry: { x: node.x, y: node.y, width: node.width, height: node.height } } : {};
    const group = node.parentId ? { group: node.parentId } : {};
    if (node.type === 'group') {
      groups.push({ id: node.id, label: node.text ?? '', kind: groupKindOf(node.boundaryPreset), ...(node.parentId ? { parent: node.parentId } : {}), ...geometry });
      continue;
    }
    if (node.type === 'note' || node.type === 'text' || node.type === 'code') {
      const body = node.type === 'code' ? truncated(node.code ?? '', READ_LIMITS.noteText) : truncated(node.text ?? '', READ_LIMITS.noteText);
      // A free note records no link to anything; `nearest` is only where it sits, said as such.
      const nearest = node.parentId ? undefined : nearestElement(node, view.nodes);
      notes.push({
        id: node.id,
        kind: node.type === 'note' ? (node.noteKind ?? 'note') : node.type === 'code' ? 'code' : 'label',
        ...(node.type === 'code' ? { language: node.language, code: body.text } : { text: body.text }),
        ...(body.truncated ? { truncated: true } : {}),
        ...group,
        ...(nearest ? { nearest } : {}),
        ...geometry,
      });
      continue;
    }
    const systemBoundary = [...ancestorsOf(node, byId)].map((id) => byId.get(id)).find((g) => g?.boundaryPreset === 'system');
    const c4 = classify(node, { level, ...(owner ? { insideOwner: owner } : {}), ...(systemBoundary ? { systemBoundary } : {}) });
    const inside = hasInside(node) && node.inside
      ? { inside: { level: node.inside.level ?? null, elements: node.inside.nodes.length, relationships: node.inside.edges.length } }
      : {};
    // In full when asked for, or when the read is focused on a few elements (their notes are part of
    // what the agent is about to edit); a count otherwise.
    const attachments = node.attachments?.length
      ? includes.has('attachments') || focused
        ? { attachments: node.attachments.map(attachmentOf) }
        : { attachmentCount: node.attachments.length }
      : {};
    elements.push({
      id: node.id,
      type: typeWordOf(node),
      label: node.text ?? '',
      ...(node.description ? { description: node.description } : {}),
      ...(node.technology ? { technology: node.technology } : {}),
      ...group,
      ...(c4 ? { c4 } : {}),
      ...inside,
      ...attachments,
      ...geometry,
    });
  }

  // Relationships touching the page; an end outside it is described enough to be unambiguous.
  const relationships: unknown[] = [];
  const outside = new Map<string, unknown>();
  for (const edge of view.edges) {
    const s = inPage.has(edge.source);
    const t = inPage.has(edge.target);
    if (!s && !t) continue;
    if (relationships.length >= 400) break;
    relationships.push(relationshipOf(edge, byId, includes.has('attachments') || focused));
    for (const [end, here] of [[edge.source, s], [edge.target, t]] as const) {
      if (here) continue;
      const node = byId.get(end);
      if (node) outside.set(end, { id: end, type: typeWordOf(node), label: node.text ?? '' });
    }
  }

  const suggestions: Record<string, string[]> = {};
  if (includes.has('suggestions')) {
    for (const node of page.slice(0, READ_LIMITS.suggestionElements)) {
      try {
        const offers = continuationsFor(view, node.id, 'invoke', { ...(level ? { level } : {}) });
        if (offers.length) suggestions[node.id] = offers.slice(0, READ_LIMITS.suggestionsPerElement).map((o) => o.actionLabel);
      } catch {
        // Suggestions are a courtesy; a rule that can't read an unusual view says nothing.
      }
    }
  }

  const complete = offset + page.length >= all.length;
  const partial = focused || !complete || offset > 0;
  const result: Record<string, unknown> = {
    diagramId,
    title: file.metadata.title,
    revision,
    view: {
      path: [...path],
      ...(owner ? { owner: { id: owner.id, label: owner.text ?? '', type: typeWordOf(owner) } } : {}),
      level: level ?? null,
      ...(level && ownLevel === undefined ? { levelInherited: true } : {}),
      insideViews: view.nodes.filter((n) => hasInside(n)).map((n) => n.id),
    },
    elements,
    relationships,
    ...(groups.length ? { groups } : {}),
    ...(notes.length ? { notes } : {}),
    flows: view.flows.slice(0, READ_LIMITS.flows).map((f) => ({
      id: f.id,
      title: f.title,
      // As update_diagram takes them back: a relationship id, {relationship, caption}, or a frame step.
      steps: f.steps.map((s) => (!s.edgeId ? { frame: s.id } : s.caption ? { relationship: s.edgeId, caption: s.caption } : s.edgeId)),
    })),
    ...(path.length === 0 && file.actions.length
      ? { actions: file.actions.map((a) => ({ id: a.id, text: a.text, ...(a.done ? { done: true } : {}), ...(a.anchor ? { about: a.anchor.id } : {}) })) }
      : {}),
    // What the people have not settled yet — every point at the root, and in a nested view the ones
    // about something in it. Read as data an agent may act on when asked; nothing here is a request.
    ...(() => {
      const here = new Set([...view.nodes.map((n) => n.id), ...view.edges.map((e) => e.id)]);
      const points = (file.openPoints ?? []).filter((p) => path.length === 0 || p.targets.some((t) => here.has(t.id)));
      return points.length
        ? {
            openPoints: points.map((p) => ({
              id: p.id,
              kind: p.kind,
              ...(p.context ? { context: p.context } : {}),
              about: p.targets.map((t) => t.id),
              ...(p.resolved ? { resolved: true } : {}),
              ...(p.resolution ? { resolution: p.resolution } : {}),
            })),
          }
        : {};
    })(),
    ...(Object.keys(suggestions).length ? { suggestions } : {}),
    ...(outside.size ? { outsideEndpoints: [...outside.values()] } : {}),
  };
  if (partial) {
    result.partial = true;
    result.counts = { elements: view.nodes.length, relationships: view.edges.length };
  }
  if (!complete) result.cursor = `c1|${revision}|${path.join('/')}|${offset + page.length}`;
  return result;
}

export function attachmentOf(a: Attachment) {
  return {
    id: a.id,
    kind: a.type,
    ...(a.type === 'code'
      ? { language: a.language, code: truncated(a.code ?? '', READ_LIMITS.noteText).text }
      : { ...(a.noteKind ? { noteKind: a.noteKind } : {}), text: truncated(a.text ?? '', READ_LIMITS.noteText).text }),
  };
}

/** The element a free note sits closest to (edge to edge), within a short reach — or none. */
export function nearestElement(note: DraftNode, nodes: readonly DraftNode[]): string | undefined {
  const REACH = 160;
  let best: { id: string; gap: number } | undefined;
  for (const n of nodes) {
    if (n.id === note.id || n.type === 'group' || n.type === 'note' || n.type === 'text' || n.type === 'code') continue;
    const dx = Math.max(0, n.x - (note.x + note.width), note.x - (n.x + n.width));
    const dy = Math.max(0, n.y - (note.y + note.height), note.y - (n.y + n.height));
    const gap = Math.hypot(dx, dy);
    if (gap <= REACH && (!best || gap < best.gap)) best = { id: n.id, gap };
  }
  return best?.id;
}

export function relationshipOf(edge: DraftEdge, byId: Map<string, DraftNode>, withAttachments = false) {
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  const caption =
    !edge.label && edge.semantic && source && target
      ? relationshipCaptionLabel(edge.semantic, { source: categoryOf(source), target: categoryOf(target) })
      : undefined;
  return {
    id: edge.id,
    from: edge.source,
    to: edge.target,
    ...(edge.label ? { label: edge.label } : {}),
    ...(caption ? { caption } : {}),
    ...(edge.semantic ? { semantic: edge.semantic } : {}),
    ...(edge.kind ? { kind: edge.kind } : {}),
    ...(edge.directed === false ? { directed: false } : {}),
    ...(edge.async ? { async: true } : {}),
    ...(edge.condition ? { condition: edge.condition } : {}),
    ...(edge.attachments?.length ? (withAttachments ? { attachments: edge.attachments.map(attachmentOf) } : { attachmentCount: edge.attachments.length }) : {}),
  };
}
