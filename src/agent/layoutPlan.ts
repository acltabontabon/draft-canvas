/**
 * What the editor's Arrange and Tidy up work out before showing a preview, as plain functions of
 * plain data: a room in, what to show out. Nothing here touches the editor, the store or the DOM, so
 * `jobs.ts` can run it on the worker thread (`offThread.ts`) and the page stays free while a large
 * diagram is laid out — or, where a worker can't measure text, on the page after one yield.
 *
 * Both are bounded by a deterministic work budget (`route.ts`'s `withBudget`): what is repaired, and
 * whether the other reading direction is worked out, depends on how much work was spent and never on
 * how fast the machine is, so the same diagram gives the same preview anywhere. A result that stopped
 * on the budget says so (`partial`); applying it and asking again continues from where it left off.
 */

import type { DraftDocument } from '../document/types';
import { visibleEdges } from '../document/compensation';
import type { ArrangeFix } from '../lib/arrangeFixes';
import { arrangeView, readingDirectionOf } from './arrange';
import { Problems } from './errors';
import { measureContext } from './place';
import { proportionFindings, resolvedBy } from './proportion';
import { pastDeadline, withBudget } from './route';
import { tidyView } from './tidy';

export type PlanDirection = 'right' | 'down';

/** What a layout skill asks of an Arrange beyond its defaults. */
export interface ArrangePreset {
  direction?: PlanDirection;
  spacing?: 'compact' | 'comfortable' | 'spacious';
  /** A flow's id: its steps laid out in one straight line, the rest around it. */
  primaryFlow?: string;
}

/**
 * The work budget of one Arrange: units of drawing (`route.ts`'s `charge`, one connector drawn is one),
 * not time. Chosen so that a 40-shape diagram gets both reading directions in about a second on a
 * laptop and a 100-shape one is arranged in a few seconds, which is what the 1.5 s of repairs it
 * replaced gave — the same on every machine now, and measured by `tests/performance.test.ts`.
 */
export const ARRANGE_WORK_UNITS = 12_000;
/** The work budget of one Tidy up: a base, and more for every connector, since each repair redraws them all. */
export const TIDY_WORK_UNITS = 12_000;
export const TIDY_WORK_PER_CONNECTOR = 60;
/**
 * The wall-clock net behind both budgets: only a machine so slow that the budget would take this long
 * ever meets it, and what it stops is flagged `partial` like the budget. Below the worker's hard limit
 * (`offThread.ts`), so a runaway is stopped here, with a result, rather than killed without one.
 */
export const LAYOUT_BACKSTOP_MS = 40_000;

export interface ArrangePlan {
  /** The room arranged, by reading direction. A selection, which has to read the way the rest of the
   *  view does, and a direction a skill asked for, have only that one. */
  options: Partial<Record<PlanDirection, DraftDocument>>;
  /** The direction to show first: the suggested one. */
  direction: PlanDirection;
  /** What the layout recommends: the way the room reads now, unless the other reads clearly better
   *  or fits a screen clearly better. */
  suggested: PlanDirection;
  /** The way the room reads now. */
  current: PlanDirection;
  scoped: boolean;
  /** What each arrangement fixes that reads badly now (`proportion.ts`). */
  fixes: Partial<Record<PlanDirection, ArrangeFix[]>>;
  /** The work budget was spent before every repair and alternative was tried. */
  partial: boolean;
  /** The other reading direction was not worked out because the budget was spent on this one. */
  alternativeSkipped: boolean;
  /** Units of work spent (`route.ts`'s `charge`): what a test or a benchmark holds to a bound. */
  used: number;
}

export type ArrangePlanResult =
  | { kind: 'plan'; plan: ArrangePlan }
  /** Arranging moves nothing (or only the way the layout recommends against). */
  | { kind: 'unchanged' }
  /** A selection can't be put back without running into its surroundings. */
  | { kind: 'no-room' };

export interface TidyPlan {
  /** The room after tidying. */
  view: DraftDocument;
  moved: number;
  reattached: number;
  scoped: boolean;
  /** The work budget was spent before every repair was tried. */
  partial: boolean;
  /** Units of work spent. */
  used: number;
}

export type TidyPlanResult =
  | { kind: 'plan'; plan: TidyPlan }
  /** Nothing to tidy. `reads` is what reads badly all the same (`proportion.ts`) — a whole room only,
   *  since the findings are about the whole view — which laying it out again may fix. */
  | { kind: 'unchanged'; partial: boolean; reads: ArrangeFix[]; used: number };

/** `view` with every node, connector and field that came back equal to `base`'s replaced by `base`'s
 *  own object — a result from another thread is a copy, and the editor keeps what didn't change by
 *  identity (its selectors, its history and its memoised routes all rely on that). `base` itself
 *  when nothing differs at all. */
export function reuseOf(base: DraftDocument, view: DraftDocument): DraftDocument {
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const reuse = <T extends { id: string }>(was: readonly T[], now: readonly T[]): readonly T[] => {
    const byId = new Map(was.map((item) => [item.id, item]));
    const kept = now.map((item) => {
      const old = byId.get(item.id);
      return old && same(old, item) ? old : item;
    });
    return kept.length === was.length && kept.every((item, index) => item === was[index]) ? was : kept;
  };
  const next: Record<string, unknown> = { ...view, nodes: reuse(base.nodes, view.nodes), edges: reuse(base.edges, view.edges) };
  for (const key of Object.keys(next)) {
    if (key === 'nodes' || key === 'edges') continue;
    const old = (base as unknown as Record<string, unknown>)[key];
    if (same(old, next[key])) next[key] = old;
  }
  const out = next as unknown as DraftDocument;
  const keys = new Set([...Object.keys(base), ...Object.keys(out)]);
  for (const key of keys) {
    if ((base as unknown as Record<string, unknown>)[key] !== (out as unknown as Record<string, unknown>)[key]) return out;
  }
  return base;
}

/**
 * Works out what Arrange would do to `doc` — the whole room, or `selection` (shape ids) — and applies
 * none of it. `preset` is a layout skill's ask: a direction kept as asked, a spacing, a flow to lay out
 * straight.
 */
export function planArrange(doc: DraftDocument, ask: { selection?: readonly string[]; preset?: ArrangePreset } = {}): ArrangePlanResult {
  const scoped = ask.selection !== undefined;
  const preset = ask.preset ?? {};
  const reads = readingDirectionOf(doc);
  const ctx = measureContext();
  const bounded = withBudget({ work: ARRANGE_WORK_UNITS, backstopMs: LAYOUT_BACKSTOP_MS }, (): ArrangePlanResult => {
    // The same defaults the agent's `{op:"arrange"}` resolves to when it names nothing, both ways
    // round for the whole room. A selection keeps the view's direction: it has to read the way the
    // rest of the view still does.
    const layout = {
      direction: (preset.direction ?? reads) as PlanDirection,
      // A direction asked for is kept: the engine may not turn it on its side.
      ...(preset.direction ? { directionChosen: true } : {}),
      spacing: preset.spacing ?? ('comfortable' as const),
      ...(preset.spacing ? { spacingChosen: true } : {}),
      // A flow gone since it was offered is simply not followed.
      ...(preset.primaryFlow && doc.flows.some((flow) => flow.id === preset.primaryFlow) ? { primaryFlow: preset.primaryFlow } : {}),
      allowDegraded: false,
      normalizePeerSizes: false,
    };
    const arranged = arrangeView(
      doc,
      scoped
        ? { scope: { nodes: [...ask.selection!] }, keepOutsideFixed: true, connectors: 'tidy', move: true, layout: { ...layout, direction: reads, directionChosen: true } }
        : { connectors: 'tidy', move: true, ...(preset.direction ? {} : { bothDirections: true }), layout },
      ctx,
      new Problems(),
      '/arrange',
    );
    if (!arranged) return { kind: 'no-room' };
    // What reads badly now, and what of it each arrangement fixes (`agent/proportion.ts`).
    const found = proportionFindings(doc, ctx);
    const options: ArrangePlan['options'] = {};
    const fixes: ArrangePlan['fixes'] = {};
    for (const each of [arranged, arranged.alternative]) {
      if (!each || each.touched.size === 0 || sameLayout(each.view, doc)) continue;
      const direction = each.direction ?? reads;
      let view = each.view;
      let after = proportionFindings(view, ctx);
      // Comfortable spacing that leaves the whole room too small to read on a screen: the same
      // arrangement set tighter, kept when that draws it clearly larger. Within the one budget, and
      // never over a spacing the skill asked for.
      if (!scoped && !preset.spacing && after.some((finding) => finding.kind === 'sparse') && !pastDeadline()) {
        const tighter = arrangeView(
          doc,
          { connectors: 'tidy', move: true, layout: { ...layout, direction, directionChosen: true, spacing: 'compact' } },
          ctx,
          new Problems(),
          '/arrange',
        );
        if (tighter && tighter.touched.size > 0) {
          const tightened = proportionFindings(tighter.view, ctx);
          // Judged as a fix of the roomier one: larger on screen, and nothing else made worse.
          const gained = resolvedBy(after, tightened).some((finding) => finding.kind === 'sparse');
          const lost = resolvedBy(tightened, after).length > 0;
          if (gained && !lost) {
            view = tighter.view;
            after = tightened;
          }
        }
      }
      options[direction] = view;
      fixes[direction] = resolvedBy(found, after).map(({ kind, id }) => ({ kind, id }));
    }
    const suggested = arranged.direction ?? reads;
    // Already arranged the suggested way: nothing to show, even if the other way would differ —
    // offering only a turn the layout recommends against isn't a cleanup.
    if (!options[suggested]) return { kind: 'unchanged' };
    return {
      kind: 'plan',
      plan: { options, direction: suggested, suggested, current: reads, scoped, fixes, partial: false, alternativeSkipped: Boolean(arranged.alternativeSkipped), used: 0 },
    };
  });
  const result = bounded.value;
  return result.kind === 'plan' ? { kind: 'plan', plan: { ...result.plan, partial: bounded.partial, used: bounded.used } } : result;
}

/**
 * Works out what Tidy up would do to `doc`, or to the neighbourhood of `scope` (shape ids), and
 * applies none of it.
 */
export function planTidy(doc: DraftDocument, scope?: readonly string[]): TidyPlanResult {
  const edges = visibleEdges(doc.edges).length;
  const bounded = withBudget({ work: TIDY_WORK_UNITS + TIDY_WORK_PER_CONNECTOR * edges, backstopMs: LAYOUT_BACKSTOP_MS }, () =>
    tidyView(doc, scope ? new Set(scope) : undefined, measureContext()),
  );
  const tidied = bounded.value;
  if (tidied.view === doc) {
    const reads = scope || bounded.partial ? [] : proportionFindings(doc, measureContext()).map(({ kind, id }) => ({ kind, id }));
    return { kind: 'unchanged', partial: bounded.partial, reads, used: bounded.used };
  }
  return {
    kind: 'plan',
    plan: { view: tidied.view, moved: tidied.moved.length, reattached: tidied.reattached.length, scoped: Boolean(scope), partial: bounded.partial, used: bounded.used },
  };
}

/** Whether two arrangements put every shape and every connector's ends in the same place. */
function sameLayout(a: DraftDocument, b: DraftDocument): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  const nodes = new Map(b.nodes.map((n) => [n.id, n]));
  const edges = new Map(b.edges.map((e) => [e.id, e]));
  const anchor = (x?: DraftDocument['edges'][number]['sourceAnchor']) => (x ? `${x.side}:${x.offset}` : '');
  return a.nodes.every((n) => {
    const o = nodes.get(n.id);
    return o && o.x === n.x && o.y === n.y && o.width === n.width && o.height === n.height && o.parentId === n.parentId;
  }) && a.edges.every((e) => {
    const o = edges.get(e.id);
    return o && anchor(o.sourceAnchor) === anchor(e.sourceAnchor) && anchor(o.targetAnchor) === anchor(e.targetAnchor) && o.routeMode === e.routeMode && o.waypoints === e.waypoints;
  });
}
