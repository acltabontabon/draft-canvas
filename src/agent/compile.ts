/**
 * `create_diagram`, from a checked request to the text of a new `.draftcanvas` file.
 *
 * Nothing is written here — the desktop shell writes the file, under the id it minted for the
 * request — so a request that fails anywhere in this module leaves nothing behind.
 */

import { createAction } from '../document/actions';
import { createDocument } from '../document/factory';
import type { DraftDocument } from '../document/types';
import { levelAdvisories } from '../depth/c4';
import { walkGraphs } from '../depth/tree';
import { deserializeDocument, serializeDocument } from '../export/project';
import { AgentError } from './errors';
import { readCreate, type CreateSpec, type LayoutSpec } from './input';
import { measureContext, placeRoom, type PlacedRoom } from './place';
import { silent, type Report } from './progress';
import { checkQuality, scoreOf, type QualityIssue } from './quality';
import { pastDeadline, withDeadline } from './route';
import { buildFromStarter } from './starter';

export interface Composed {
  text: string;
  title: string;
  receipt: Record<string, unknown>;
}

/** Spacing tried in turn when a layout isn't readable: the request's own, then roomier. */
const REPAIR_LADDER: LayoutSpec['spacing'][] = ['comfortable', 'spacious'];

export interface ComposeOptions {
  /** A `performance.now()` time to stop repairing by (see `withDeadline`). */
  deadline?: number;
  /** Told each stage, and each whole candidate arrangement as it is judged (see `progress.ts`). */
  report?: Report;
}

export function compose(raw: unknown, diagramId: string, options: ComposeOptions = {}): Composed {
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  return withDeadline(deadline, () => composeWithin(raw, diagramId, options.report ?? silent));
}

function composeWithin(raw: unknown, diagramId: string, report: Report): Composed {
  report('preparing');
  const spec = readCreate(raw);
  const ctx = measureContext();
  // Bounded repair: roomier spacing first; then, only when the caller left the reading direction to
  // us, the other one. A first readable result wins; with none, the least bad one is what a degraded
  // request gets.
  const spacings = [spec.layout.spacing, ...REPAIR_LADDER.filter((s) => s !== spec.layout.spacing)];
  // Each arrangement is tried with straight connectors first (see `LayoutInput.ties`), and balanced
  // only if that can't be made readable.
  const attempts: LayoutSpec[] = spacings.map((spacing) => ({ ...spec.layout, spacing }));
  if (!spec.layout.directionChosen) {
    const other = spec.layout.direction === 'right' ? 'down' : 'right';
    attempts.push(...REPAIR_LADDER.map((spacing) => ({ ...spec.layout, direction: other, spacing }) as LayoutSpec));
  }
  attempts.push(...attempts.map((layout) => ({ ...layout, ties: 'balance' as const })));
  // The best candidate so far is kept, so running out of attempts (or time) never trades a readable
  // arrangement for a worse last one; among unreadable ones, the one that hides the least wins.
  let best: { placed: PlacedRoom; issues: QualityIssue[]; layout: LayoutSpec; score: number } | undefined;
  let outOfTime = false;
  let tried = 0;
  for (const layout of attempts) {
    // Another attempt only while there is time for it; the first always runs.
    if (best && pastDeadline()) {
      outOfTime = true;
      break;
    }
    tried += 1;
    report(tried === 1 ? 'arranging' : 'repairing');
    const candidate = spec.starter ? buildFromStarter(spec, layout, ctx) : placeRoom(spec, layout, ctx);
    // Complete — every shape placed, every connector anchored — so a preview can show it as it is.
    // (Once repairing, it stays "repairing": the stage says where the request is, not each step.)
    report(tried === 1 ? 'routing' : 'repairing', { nodes: candidate.nodes, edges: candidate.edges, flows: candidate.flows });
    const found = qualityOfEveryRoom(candidate, ctx);
    const score = scoreOf({ errors: found, warnings: [] });
    if (!best || score < best.score) best = { placed: candidate, issues: found, layout, score };
    if (found.length === 0) break;
  }
  const repaired = tried - 1;
  if (!best) throw new AgentError('INTERNAL', 'Nothing was laid out.');
  const { placed, issues, layout: used } = best;
  report('finishing', { nodes: placed.nodes, edges: placed.edges, flows: placed.flows });
  if (issues.length > 0 && !spec.layout.allowDegraded) {
    const why = outOfTime || pastDeadline() ? ' (it ran out of time before every repair could be tried)' : '';
    throw new AgentError('LAYOUT_FAILED', `The arranged diagram still has ${issues.length} readability problem(s) after ${repaired} repair attempt(s)${why}.`, {
      hint: 'Try layout.direction "down", fewer relationships per element, shorter labels — or pass layout.allowDegraded: true to accept it and tidy by hand.',
      details: { problems: issues.slice(0, 20).map((i) => i.message) },
    });
  }

  const document = assemble(spec, placed, diagramId);
  const text = gate(document);
  const counts = countAll(document);
  return {
    text,
    title: spec.title,
    receipt: {
      created: counts,
      layout: { direction: used.direction, spacing: used.spacing },
      ...(issues.length ? { degraded: true } : {}),
      quality: { errors: issues.length, ...(issues.length ? { problems: issues.slice(0, 10).map((i) => i.message) } : {}) },
      ...(placed.advisories.length || levelAdvisories(document.nodes, document.level).length
        ? { advisories: [...levelAdvisories(document.nodes, document.level), ...placed.advisories].slice(0, 10) }
        : {}),
    },
  };
}

function qualityOfEveryRoom(room: PlacedRoom, ctx: ReturnType<typeof measureContext>): QualityIssue[] {
  const issues = [...checkQuality(room.nodes, room.edges, ctx).errors];
  const visit = (nodes: PlacedRoom['nodes']) => {
    for (const node of nodes) {
      if (!node.inside) continue;
      issues.push(...checkQuality(node.inside.nodes, node.inside.edges, ctx).errors.map((i) => ({ ...i, message: `inside ${node.id}: ${i.message}` })));
      visit(node.inside.nodes);
    }
  };
  visit(room.nodes);
  return issues;
}

function assemble(spec: CreateSpec, placed: PlacedRoom, diagramId: string): DraftDocument {
  const base = createDocument(spec.title);
  const document: DraftDocument = {
    ...base,
    metadata: { ...base.metadata, id: diagramId },
    nodes: placed.nodes,
    edges: placed.edges,
    flows: placed.flows,
    ...(spec.level ? { level: spec.level } : {}),
  };
  const actions = spec.actions.flatMap((a) => {
    const anchor = a.about ? anchorOf(document, a.about) : undefined;
    const action = createAction(a.text, anchor);
    if (!action) return [];
    if (a.id) action.id = a.id;
    if (a.done) action.done = true;
    return [action];
  });
  return { ...document, actions };
}

/** Where an action points: an element or a relationship, in whichever room it lives. */
export function anchorOf(document: DraftDocument, id: string): { kind: 'node' | 'edge'; id: string } | undefined {
  let found: { kind: 'node' | 'edge'; id: string } | undefined;
  walkGraphs(document, (graph) => {
    if (found) return;
    if (graph.nodes.some((n) => n.id === id)) found = { kind: 'node', id };
    else if (graph.edges.some((e) => e.id === id)) found = { kind: 'edge', id };
  });
  return found;
}

export function countAll(document: DraftDocument) {
  let elements = 0;
  let groups = 0;
  let notes = 0;
  let relationships = 0;
  let flows = 0;
  let views = 0;
  walkGraphs(document, (graph, path) => {
    if (path.length > 0) views += 1;
    for (const node of graph.nodes) {
      if (node.type === 'group') groups += 1;
      else if (node.type === 'note' || node.type === 'text' || node.type === 'code') notes += 1;
      else elements += 1;
    }
    relationships += graph.edges.length;
    flows += graph.flows.length;
  });
  return { elements, relationships, groups, flows, notes, insideViews: views, actions: document.actions.length };
}

/**
 * The last check before anything leaves: the document must survive being saved and opened again
 * exactly as it is. The importer repairs rather than rejects, so a document it would have to repair
 * is one this module built wrong — refused here, instead of being "fixed" silently on the next open.
 */
export function gate(document: DraftDocument): string {
  const text = serializeDocument(document);
  const parsed = deserializeDocument(text);
  if (!parsed.ok) throw new AgentError('INTERNAL', 'The composed diagram did not read back.');
  if (parsed.repairs.length > 0) {
    throw new AgentError('INTERNAL', 'The composed diagram would be altered on its next open.', { details: { repairs: parsed.repairs.slice(0, 5) } });
  }
  return text;
}
