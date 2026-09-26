/**
 * Open points — what the discussion has not settled yet, attached to the architecture it concerns.
 *
 * The same shape as `actions.ts`: pure functions over a `DraftDocument`, each returning a new
 * document that reuses everything it didn't touch, and the *same* document when it changed nothing
 * so the store's no-op guard keeps working. Nothing here knows about React, the store, or how a
 * marker is drawn.
 *
 * Root-only, like actions: a document handed to these functions while the editor is inside a room
 * is the room's view, which carries the root's `openPoints` by way of `depth/tree.ts`'s `viewOf` —
 * and `embed` carries it back out again. So a point can be raised at any depth, and can concern
 * shapes in several rooms at once, without anything here knowing what depth is.
 */

import { createId } from './ids';
import { LIMITS } from './limits';
import type { DraftDocument, OpenPoint, OpenPointKind, OpenPointTarget } from './types';

/** The id prefix open points use, kept here so `validate.ts` and the operations agree. */
export const OPEN_POINT_ID_PREFIX = 'op';

const NO_POINTS: readonly OpenPoint[] = Object.freeze([]);
const NO_INDEX: ReadonlyMap<string, readonly OpenPoint[]> = new Map();

/** How each kind is named on screen and in exports. One table, so nothing spells them differently. */
export const OPEN_POINT_LABELS: Record<OpenPointKind, string> = {
  tentative: 'Tentative',
  awaiting: 'Awaiting input',
  parked: 'Parked',
};

/** One line saying what each kind means — the hover preview's and the kind picker's own words. */
export const OPEN_POINT_HINTS: Record<OpenPointKind, string> = {
  tentative: 'A working assumption — not settled yet',
  awaiting: 'Someone still has to answer, review or agree',
  parked: 'Deliberately put off for now',
};

function withOpenPoints(doc: DraftDocument, openPoints: OpenPoint[]): DraftDocument {
  return openPoints === doc.openPoints ? doc : { ...doc, openPoints };
}

/**
 * What a point's context (or resolution) becomes once committed. Multi-line on purpose — "Rough
 * estimate: a few days. Depends on the interface decision." is two sentences somebody may well put
 * on two lines — but trimmed of control characters, runs of blank lines and trailing space, and
 * capped rather than refused.
 */
export function normalizeOpenPointText(raw: string): string {
  return (
    raw
      // oxlint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, LIMITS.maxOpenPointContextLength)
      .trim()
  );
}

function sameTarget(a: OpenPointTarget, b: OpenPointTarget): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** `targets` with duplicates dropped and the cap applied, as fresh objects the caller may keep. */
export function normalizeTargets(targets: readonly OpenPointTarget[]): OpenPointTarget[] {
  const out: OpenPointTarget[] = [];
  for (const target of targets) {
    if (out.some((existing) => sameTarget(existing, target))) continue;
    out.push({ kind: target.kind, id: target.id });
    if (out.length >= LIMITS.maxOpenPointTargets) break;
  }
  return out;
}

/** `null` when there is nothing to attach it to — a point about nothing is not a point. */
export function createOpenPoint(kind: OpenPointKind, targets: readonly OpenPointTarget[], context?: string): OpenPoint | null {
  const normalizedTargets = normalizeTargets(targets);
  if (normalizedTargets.length === 0) return null;
  const point: OpenPoint = { id: createId(OPEN_POINT_ID_PREFIX), kind, targets: normalizedTargets };
  const text = context === undefined ? '' : normalizeOpenPointText(context);
  if (text) point.context = text;
  return point;
}

/**
 * A document's points, tolerating a hand-built one without the field: a test fixture, or a view
 * assembled before this field existed, must read as "no points" rather than crash a selector.
 */
export function pointsOf(doc: Partial<Pick<DraftDocument, 'openPoints'>>): readonly OpenPoint[] {
  return doc.openPoints ?? NO_POINTS;
}

export function findOpenPoint(doc: DraftDocument, pointId: string): OpenPoint | undefined {
  return pointsOf(doc).find((point) => point.id === pointId);
}

/** Still open, in the order they were raised. */
export function unresolvedOpenPoints(doc: Partial<Pick<DraftDocument, 'openPoints'>>): OpenPoint[] {
  return pointsOf(doc).filter((point) => !point.resolved);
}

export function resolvedOpenPoints(doc: Partial<Pick<DraftDocument, 'openPoints'>>): OpenPoint[] {
  return pointsOf(doc).filter((point) => point.resolved);
}

/** Whether a point is attached to this element. */
export function pointConcerns(point: OpenPoint, target: OpenPointTarget): boolean {
  return point.targets.some((entry) => sameTarget(entry, target));
}

/** Every point (open or resolved) attached to one element, in the order they were raised. */
export function openPointsFor(doc: Partial<Pick<DraftDocument, 'openPoints'>>, target: OpenPointTarget): OpenPoint[] {
  return pointsOf(doc).filter((point) => pointConcerns(point, target));
}

/**
 * The unresolved points of a document, indexed by the element they concern — what every marker
 * reads. Cached on the `openPoints` array's identity, so the (elements × store updates) selectors a
 * canvas runs never rebuild it, and a document with no points costs a `WeakMap` miss and nothing else.
 */
const unresolvedIndexCache = new WeakMap<readonly OpenPoint[], ReadonlyMap<string, readonly OpenPoint[]>>();

function targetKey(target: OpenPointTarget): string {
  return `${target.kind}:${target.id}`;
}

export function unresolvedIndex(openPoints: readonly OpenPoint[] | undefined): ReadonlyMap<string, readonly OpenPoint[]> {
  if (!openPoints) return NO_INDEX;
  const cached = unresolvedIndexCache.get(openPoints);
  if (cached) return cached;
  const index = new Map<string, OpenPoint[]>();
  for (const point of openPoints) {
    if (point.resolved) continue;
    for (const target of point.targets) {
      const key = targetKey(target);
      const list = index.get(key);
      if (list) list.push(point);
      else index.set(key, [point]);
    }
  }
  unresolvedIndexCache.set(openPoints, index);
  return index;
}

/** The unresolved points attached to this element — identity-stable for an unchanged document. */
export function unresolvedOpenPointsFor(openPoints: readonly OpenPoint[] | undefined, target: OpenPointTarget): readonly OpenPoint[] {
  return unresolvedIndex(openPoints).get(targetKey(target)) ?? NO_POINTS;
}

/**
 * Appends a point. Refuses past `LIMITS.maxOpenPoints` rather than dropping the oldest — losing
 * something somebody flagged as unsettled, silently, to make room for something else they flagged
 * is the one behaviour this list must never have.
 */
export function addOpenPoint(doc: DraftDocument, point: OpenPoint): DraftDocument {
  if (doc.openPoints.length >= LIMITS.maxOpenPoints) return doc;
  return withOpenPoints(doc, [...doc.openPoints, point]);
}

function mapPoint(doc: DraftDocument, pointId: string, fn: (point: OpenPoint) => OpenPoint): DraftDocument {
  let changed = false;
  const openPoints = doc.openPoints.map((point) => {
    if (point.id !== pointId) return point;
    const next = fn(point);
    if (next === point) return point;
    changed = true;
    return next;
  });
  return changed ? withOpenPoints(doc, openPoints) : doc;
}

export function setOpenPointKind(doc: DraftDocument, pointId: string, kind: OpenPointKind): DraftDocument {
  return mapPoint(doc, pointId, (point) => (point.kind === kind ? point : { ...point, kind }));
}

/** An edit down to nothing clears the field rather than leaving an empty string in the file. */
export function setOpenPointContext(doc: DraftDocument, pointId: string, context: string): DraftDocument {
  const text = normalizeOpenPointText(context);
  return mapPoint(doc, pointId, (point) => {
    if ((point.context ?? '') === text) return point;
    const next = { ...point };
    if (text) next.context = text;
    else delete next.context;
    return next;
  });
}

/**
 * Marks a point settled, optionally with how. Resolving changes nothing about the shapes it was
 * attached to — it only says the discussion moved on — and keeps the point, so the context is
 * still there to read next time (see `reopenOpenPoint`).
 */
export function resolveOpenPoint(doc: DraftDocument, pointId: string, resolution?: string): DraftDocument {
  const text = resolution === undefined ? undefined : normalizeOpenPointText(resolution);
  return mapPoint(doc, pointId, (point) => {
    const resolutionChanged = text !== undefined && (point.resolution ?? '') !== text;
    if (point.resolved && !resolutionChanged) return point;
    const next: OpenPoint = { ...point, resolved: true };
    if (text !== undefined) {
      if (text) next.resolution = text;
      else delete next.resolution;
    }
    return next;
  });
}

/** The resolution note alone, for editing it after the fact. Same clear-when-empty rule as context. */
export function setOpenPointResolution(doc: DraftDocument, pointId: string, resolution: string): DraftDocument {
  const text = normalizeOpenPointText(resolution);
  return mapPoint(doc, pointId, (point) => {
    if ((point.resolution ?? '') === text) return point;
    const next = { ...point };
    if (text) next.resolution = text;
    else delete next.resolution;
    return next;
  });
}

/** Back to open. The resolution note is kept: it is part of the history of the discussion. */
export function reopenOpenPoint(doc: DraftDocument, pointId: string): DraftDocument {
  return mapPoint(doc, pointId, (point) => {
    if (!point.resolved) return point;
    const { resolved: _dropped, ...rest } = point;
    return rest;
  });
}

export function removeOpenPoint(doc: DraftDocument, pointId: string): DraftDocument {
  const openPoints = doc.openPoints.filter((point) => point.id !== pointId);
  return openPoints.length === doc.openPoints.length ? doc : withOpenPoints(doc, openPoints);
}

/** Adds elements to what a point is about. Ignores ones already there; refuses none. */
export function addOpenPointTargets(doc: DraftDocument, pointId: string, targets: readonly OpenPointTarget[]): DraftDocument {
  return mapPoint(doc, pointId, (point) => {
    const merged = normalizeTargets([...point.targets, ...targets]);
    return merged.length === point.targets.length ? point : { ...point, targets: merged };
  });
}

/** Detaches one element from a point. Its last target goes with the point — see `pruneOpenPoints`. */
export function removeOpenPointTarget(doc: DraftDocument, pointId: string, target: OpenPointTarget): DraftDocument {
  const point = findOpenPoint(doc, pointId);
  if (!point || !pointConcerns(point, target)) return doc;
  const remaining = point.targets.filter((entry) => !sameTarget(entry, target));
  if (remaining.length === 0) return removeOpenPoint(doc, pointId);
  return mapPoint(doc, pointId, (current) => ({ ...current, targets: remaining }));
}

/**
 * Drops every attachment to an element that is gone, and every point left with nothing to be about.
 *
 * Called by `removeElements` in the same operation that deletes the elements, so the deletion and
 * the point going with it are one undo step — and undo restores both. A shared point whose other
 * targets survive stays on them, context and all: the question was about several things, and one
 * of them going does not answer it.
 */
export function pruneOpenPoints(doc: DraftDocument, removedNodeIds: ReadonlySet<string>, removedEdgeIds: ReadonlySet<string>): DraftDocument {
  if (removedNodeIds.size === 0 && removedEdgeIds.size === 0) return doc;
  if (pointsOf(doc).length === 0) return doc;
  let changed = false;
  const openPoints: OpenPoint[] = [];
  for (const point of doc.openPoints) {
    const kept = point.targets.filter((target) =>
      target.kind === 'node' ? !removedNodeIds.has(target.id) : !removedEdgeIds.has(target.id),
    );
    if (kept.length === point.targets.length) {
      openPoints.push(point);
      continue;
    }
    changed = true;
    if (kept.length > 0) openPoints.push({ ...point, targets: kept });
  }
  return changed ? withOpenPoints(doc, openPoints) : doc;
}

/**
 * Re-points a whole point at another element — what "insert a worker on this connector" needs when
 * the connector it was about is replaced by two. Nothing else moves an attachment; a point follows
 * an element's id, and ids never change under it.
 */
export function retargetOpenPoints(doc: DraftDocument, from: OpenPointTarget, to: OpenPointTarget): DraftDocument {
  let changed = false;
  const openPoints = doc.openPoints.map((point) => {
    if (!pointConcerns(point, from)) return point;
    changed = true;
    const targets = normalizeTargets(point.targets.map((target) => (sameTarget(target, from) ? to : target)));
    return { ...point, targets };
  });
  return changed ? withOpenPoints(doc, openPoints) : doc;
}

/** The kinds present among some points, in the order `OPEN_POINT_KINDS` lists them — for a key or a tooltip. */
export function kindsAmong(points: readonly OpenPoint[]): OpenPointKind[] {
  const present = new Set(points.map((point) => point.kind));
  return (['tentative', 'awaiting', 'parked'] as const).filter((kind) => present.has(kind));
}
