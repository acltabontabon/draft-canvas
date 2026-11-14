/**
 * Tidy up: the gentle cleanup. What the editor reaches for after a few shapes were added or moved,
 * when the picture is nearly right and should stay recognisably the one that was drawn.
 *
 * Arrange (`arrange.ts`) lays a view out again from nothing, so one new service can move every shape
 * on the canvas. This keeps every shape where it was put and fixes only what reads as untidy:
 *
 * - a connector *drawn* with a small kink (a step of a few pixels, the router could not hide) is
 *   straightened by nudging one of its shapes, never further than `STRAIGHTEN_LIMIT`
 *   (`edges/straighten.ts`); one the router already draws straight is left as it is;
 * - a connector whose line is drawn through a shape, or across a boundary neither of its ends is
 *   in, is re-attached to sides that clear it (`repairAnchors`), and only when the whole drawing is
 *   no worse for it. A caption that sits badly is not a reason to re-attach:
 *   moving a line's ends to make room for its words trades a tidy route for a detour.
 *
 * Hand-drawn bends, sizes, boundaries and everything outside `scope` are left alone. With a scope
 * (the selection) only those shapes may move and only connectors touching them are re-attached, so
 * tidying one neighbourhood never disturbs another.
 *
 * Pure: a view in, a view out, nothing committed. The editor shows the result as a preview first.
 */
import type { DraftDocument, DraftEdge } from '../document/types';
import { straightenConnectors } from '../edges/straighten';
import type { DescribeContext } from '../nodes/describe';
import { captionSizer } from './place';
import { repairAnchors, routeProblem } from './route';

export interface Tidied {
  /** The view after tidying: `view` itself when there was nothing to do. */
  view: DraftDocument;
  /** Shapes nudged to straighten a connector. */
  moved: string[];
  /** Connectors re-attached to clear a shape or a boundary their line ran through. */
  reattached: string[];
}

const sameAnchor = (a: DraftEdge['sourceAnchor'], b: DraftEdge['sourceAnchor']) =>
  a === b || (Boolean(a) && Boolean(b) && a!.side === b!.side && a!.offset === b!.offset);

export function tidyView(view: DraftDocument, scope: ReadonlySet<string> | undefined, ctx: DescribeContext): Tidied {
  const straightened = straightenConnectors(view, scope);
  const was = new Map(view.nodes.map((node) => [node.id, node]));
  const moved = straightened === view
    ? []
    : straightened.nodes.filter((node) => { const old = was.get(node.id); return old && (old.x !== node.x || old.y !== node.y); }).map((node) => node.id);

  // `repairAnchors` re-anchors in place, so it works on copies; an edge it leaves alone keeps its
  // own object, and with it its place in history and its cached route.
  const caption = captionSizer(straightened.nodes, ctx);
  const inScope = (edge: DraftEdge) => !scope || scope.has(edge.source) || scope.has(edge.target);
  // Asked without a caption: with one, a caption over a shape is reported first and hides a line
  // through a shape behind it.
  // One lookup for every connector: a map rebuilt per connector was most of what this check cost.
  const byId = new Map(straightened.nodes.map((node) => [node.id, node]));
  const broken = (edge: DraftEdge) => routeProblem(edge, straightened.nodes, straightened.edges, undefined, undefined, byId) !== undefined;
  const copies = new Map(straightened.edges.filter((edge) => inScope(edge) && broken(edge)).map((edge) => [edge.id, { ...edge }]));
  const drawn = straightened.edges.map((edge) => copies.get(edge.id) ?? edge);
  if (copies.size > 0) repairAnchors([...copies.values()], straightened.nodes, caption, drawn);
  const reattached = straightened.edges
    .filter((edge) => {
      const copy = copies.get(edge.id);
      return copy && !(sameAnchor(copy.sourceAnchor, edge.sourceAnchor) && sameAnchor(copy.targetAnchor, edge.targetAnchor));
    })
    .map((edge) => edge.id);
  if (reattached.length === 0) return { view: straightened, moved, reattached };
  const changed = new Set(reattached);
  return {
    view: { ...straightened, edges: straightened.edges.map((edge) => (changed.has(edge.id) ? copies.get(edge.id)! : edge)) },
    moved,
    reattached,
  };
}
