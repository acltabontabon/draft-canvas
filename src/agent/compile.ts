/**
 * `create_diagram`, from a checked request to the text of a new `.draftcanvas` file.
 *
 * Nothing is written here — the desktop shell writes the file, under the id it minted for the
 * request — so a request that fails anywhere in this module leaves nothing behind.
 */

import { createAction } from '../document/actions';
import { createDocument } from '../document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { levelAdvisories } from '../depth/c4';
import { walkGraphs } from '../depth/tree';
import { deserializeDocument, serializeDocument } from '../export/project';
import { AgentError } from './errors';
import { readCreate, type CreateSpec, type LayoutSpec } from './input';
import { measureContext, placeRoom, type PlacedRoom } from './place';
import { silent, type Report } from './progress';
import { checkFit, isBetterCandidate, isCleanCandidate, checkQuality, renderedBoundsOf, smallestFontPresent, type FitReport, type QualityIssue, type QualityReport } from './quality';
import { pastDeadline, withDeadline } from './route';
import { buildFromStarter } from './starter';
import { legibilityCost, legibilityOf, type Legibility } from './legibility';
import { adviceFor } from './advice';
import { routingPlan } from '../edges/bundles';

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
  // A brand-new diagram has nothing manual to preserve, so peer sizing defaults on unless the
  // request explicitly turned it off.
  const layout0: LayoutSpec = { ...spec.layout, normalizePeerSizes: spec.layout.normalizePeerSizes ?? true };
  // Bounded repair: roomier spacing first; then, only when the caller left the reading direction to
  // us, the other one. A first readable result wins; with none, the least bad one is what a degraded
  // request gets.
  const spacings = [layout0.spacing, ...REPAIR_LADDER.filter((s) => s !== layout0.spacing)];
  // Each arrangement is tried with straight connectors first (see `LayoutInput.ties`), and balanced
  // only if that can't be made readable.
  const attempts: LayoutSpec[] = spacings.map((spacing) => ({ ...layout0, spacing }));
  if (!layout0.directionChosen) {
    const other = layout0.direction === 'right' ? 'down' : 'right';
    attempts.push(...REPAIR_LADDER.map((spacing) => ({ ...layout0, direction: other, spacing }) as LayoutSpec));
  }
  attempts.push(...attempts.map((layout) => ({ ...layout, ties: 'balance' as const })));
  // The best candidate so far is kept, so running out of attempts (or time) never trades a readable
  // arrangement for a worse last one; among unreadable ones, the one that hides the least wins. A
  // candidate with fewer errors always outranks one with more, however many jogs either has —
  // `isBetterReport` decides that, not a summed score (see its doc comment).
  let best: Candidate | undefined;
  let outOfTime = false;
  let tried = 0;
  // Which note is about which element: a note's subject isn't stored in the file, only used to place it.
  const about = new Map(spec.notes.flatMap((n) => (n.near ? [[n.id, n.near] as const] : [])));
  const judge = (layout: LayoutSpec): Candidate => {
    tried += 1;
    report(tried === 1 ? 'arranging' : 'repairing');
    const candidate = spec.starter ? buildFromStarter(spec, layout, ctx) : placeRoom(spec, layout, ctx);
    // Complete — every shape placed, every connector anchored — so a preview can show it as it is.
    // (Once repairing, it stays "repairing": the stage says where the request is, not each step.)
    report(tried === 1 ? 'routing' : 'repairing', { nodes: candidate.nodes, edges: candidate.edges, flows: candidate.flows });
    const found = qualityOfEveryRoom(candidate, ctx);
    // Only measured against a viewport the request actually gave — otherwise this candidate always
    // "fits", so a request with no `layout.viewport` compares and stops exactly as it always has.
    const fit = layout.viewport ? checkFit(renderedBoundsOf(candidate.nodes, candidate.edges, ctx), smallestFontPresent(candidate.nodes, candidate.edges), layout.viewport) : undefined;
    return { placed: candidate, found, fit, layout, legibility: legibilityOf(candidate.nodes, candidate.edges, about) };
  };
  const keep = (candidate: Candidate) => {
    if (!best || isBetterArrangement(candidate, best, layout0.direction)) best = candidate;
  };
  for (const layout of attempts) {
    // Another attempt only while there is time for it; the first always runs.
    if (best && pastDeadline()) {
      outOfTime = true;
      break;
    }
    const candidate = judge(layout);
    keep(candidate);
    // A shared trunk for labelled connectors can lose — three branches' captions no longer fitting
    // their gap — so the same arrangement without one is judged beside it, and the better kept.
    const alone = hasLabelledTrunk(candidate.placed) && !pastDeadline() ? judge({ ...layout, fans: 'unlabelled' }) : undefined;
    if (alone) keep(alone);
    if (isCleanCandidate({ report: candidate.found, fit: candidate.fit }) || (alone && isCleanCandidate({ report: alone.found, fit: alone.fit }))) break;
  }
  // Readable is not the same as legible: a clean arrangement can still send connectors the width of
  // the canvas. When the reading direction was left to us and a clean result came early, the other
  // direction is laid out too, and kept only when it reads clearly better (`isBetterArrangement`).
  if (best && !layout0.directionChosen && !spec.starter && !pastDeadline() && !attempts.slice(0, tried).some((a) => a.direction !== layout0.direction)) {
    const found = best as Candidate;
    const other = attempts.find((a) => a.direction !== found.layout.direction && a.spacing === found.layout.spacing && a.ties === found.layout.ties);
    if (other) keep(judge(other));
  }
  const repaired = tried - 1;
  if (!best) throw new AgentError('INTERNAL', 'Nothing was laid out.');
  const { placed, found, fit, layout: used, legibility } = best as Candidate;
  const issues = found.errors;
  report('finishing', { nodes: placed.nodes, edges: placed.edges, flows: placed.flows });
  if (issues.length > 0 && !spec.layout.allowDegraded) {
    const why = outOfTime || pastDeadline() ? ' (it ran out of time before every repair could be tried)' : '';
    throw new AgentError('LAYOUT_FAILED', `The arranged diagram still has ${issues.length} readability problem(s) after ${repaired} repair attempt(s)${why}.`, {
      hint: 'Try layout.direction "down", fewer relationships per element, shorter labels — or pass layout.allowDegraded: true to accept it and tidy by hand.',
      details: { problems: issues.slice(0, 20).map((i) => i.message) },
    });
  }
  if (fit && !fit.readable && !spec.layout.allowDegraded) {
    throw new AgentError('LAYOUT_FAILED', `The arranged diagram's smallest text would render at about ${fit.effectiveFontPx.toFixed(1)}px in a ${used.viewport![0]}×${used.viewport![1]} frame — too small to read.`, {
      hint: 'Shorten labels/descriptions, split the diagram, use a larger viewport, or pass layout.allowDegraded: true to accept it as is.',
      details: { fit },
    });
  }

  const document = assemble(spec, placed, diagramId);
  // What the request itself could change for a clearer diagram comes first: it is the advice the agent
  // can act on in this same turn (see `advice.ts`).
  const advice = [...(spec.starter ? [] : adviceFor(spec, legibility, used.primaryFlow)), ...levelAdvisories(document.nodes, document.level), ...placed.advisories];
  const text = gate(document);
  const counts = countAll(document);
  return {
    text,
    title: spec.title,
    receipt: {
      created: counts,
      layout: { direction: used.direction, spacing: used.spacing },
      ...(issues.length || (fit && !fit.readable) ? { degraded: true } : {}),
      quality: qualityReceipt('whole-diagram', found),
      legibility: legibilityReceipt(legibility),
      ...(fit ? { fit } : {}),
      ...(advice.length
        ? { advisories: advice.slice(0, 10) }
        : {}),
    },
  };
}

/** The shape every tool's receipt reports quality diagnostics in: capped lists plus true totals, so
 *  a caller can tell "10 of 14" from "all 10" — and a `'touched'` scope never reads as "the whole
 *  diagram is clean" when only part of it was actually checked. */
export function qualityReceipt(scope: 'whole-diagram' | 'touched', report: QualityReport) {
  const cap = 10;
  return {
    scope,
    errors: report.errors.length,
    errorsTruncated: report.errors.length > cap,
    ...(report.errors.length ? { problems: report.errors.slice(0, cap).map((i) => ({ kind: i.kind, ids: i.ids, message: i.message })) } : {}),
    warnings: report.warnings.length,
    warningsTruncated: report.warnings.length > cap,
    ...(report.warnings.length ? { warningProblems: report.warnings.slice(0, cap).map((i) => ({ kind: i.kind, ids: i.ids, message: i.message })) } : {}),
  };
}

interface Candidate {
  placed: PlacedRoom;
  found: QualityReport;
  fit?: FitReport;
  layout: LayoutSpec;
  legibility: Legibility;
}

/** The other reading direction wins only when it costs at most this fraction of the default one… */
const CLEARLY_BETTER = 0.8;
/** …and saves at least this much outright (about one crossing and a detour). */
const MIN_GAIN = 25;
/** A skewed connector, weighed against legibility: about one crossing. */
export const JOG_COST = 10;

/** Whether an arrangement in the other reading direction, costing `other` (`legibilityCost` plus
 *  jogs), reads clearly enough better than the preferred direction's `same` to be worth the flip —
 *  a diagram never turns over a few pixels of connector. Shared with `arrange`. */
export function clearlyBetterDirection(other: number, same: number): boolean {
  return other < same * CLEARLY_BETTER && same - other > MIN_GAIN;
}

/**
 * Whether `a` should be kept over `b`. Hidden content and fit decide first, exactly as
 * `isBetterCandidate` has them; only between equally readable arrangements does legibility (with
 * skewed connectors counted in) decide — and a change of reading direction from the default has to be
 * clearly better, so a diagram never flips over a few pixels of connector.
 */
function isBetterArrangement(a: Candidate, b: Candidate, preferred: LayoutSpec['direction']): boolean {
  const errorsOnly = (c: Candidate) => ({ report: { errors: c.found.errors, warnings: [] }, fit: c.fit });
  if (isBetterCandidate(errorsOnly(a), errorsOnly(b))) return true;
  if (isBetterCandidate(errorsOnly(b), errorsOnly(a))) return false;
  const cost = (c: Candidate) => legibilityCost(c.legibility) + c.found.warnings.length * JOG_COST;
  const [ca, cb] = [cost(a), cost(b)];
  if (a.layout.direction === b.layout.direction) return ca < cb;
  return a.layout.direction === preferred ? !clearlyBetterDirection(cb, ca) : clearlyBetterDirection(ca, cb);
}

/** Whether any labelled connector shares a Smart Routing trunk here (see `assignAnchors`'s labelled fan). */
export function hasLabelledTrunk(room: { nodes: readonly DraftNode[]; edges: readonly DraftEdge[] }): boolean {
  const plan = routingPlan(room.nodes, room.edges);
  return room.edges.some((e) => e.label && plan.spineFor(e.id));
}

/** What a receipt says about legibility: the counts, and which connectors or notes to look at. */
export function legibilityReceipt(l: Legibility) {
  return {
    crossings: l.crossings,
    ...(l.detours.length ? { detours: l.detours.slice(0, 10) } : {}),
    ...(l.throughBoundaries.length ? { throughBoundaries: l.throughBoundaries.slice(0, 10) } : {}),
    ...(l.farNotes.length ? { farNotes: l.farNotes.slice(0, 10) } : {}),
    fill: l.fill,
  };
}

function qualityOfEveryRoom(room: PlacedRoom, ctx: ReturnType<typeof measureContext>): QualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  const visit = (nodes: PlacedRoom['nodes'], edges: PlacedRoom['edges'], prefix: string) => {
    const found = checkQuality(nodes, edges, ctx);
    const tag = (i: QualityIssue) => (prefix ? { ...i, message: `${prefix}${i.message}` } : i);
    errors.push(...found.errors.map(tag));
    warnings.push(...found.warnings.map(tag));
    for (const node of nodes) {
      if (!node.inside) continue;
      visit(node.inside.nodes, node.inside.edges, `inside ${node.id}: `);
    }
  };
  visit(room.nodes, room.edges, '');
  return { errors, warnings };
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
