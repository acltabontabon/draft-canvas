/**
 * Which connector a pointer is on — the one question clicking and hovering a connector both ask.
 *
 * The DOM alone answered it badly. Every connector draws a wide invisible hit path, but two other
 * things sat in front of it: a node's connection handles, each with an invisible hit ring pushed
 * *outward* off the node — exactly where connectors arrive, so the last stretch of every arrow and
 * the whole of a short one clicked a handle instead — and the hit paths of neighbouring connectors,
 * where the one painted last won however far it was from the pointer. Only the HTML label chip was
 * reliably clickable, because it sits in its own layer above everything.
 *
 * So the stack at the point (`elementsFromPoint`, which the browser answers with its own geometry)
 * is read top down: canvas chrome and node bodies still win, a handle ring outside its node's body
 * is looked through, and among every connector whose hit path is there, the nearest route wins
 * (`edges/nearest.ts`, the same measure drag-to-attach uses). Routes the pointer is equally close to
 * — a shared trunk, where several connectors draw the very same segment — come back together as
 * `tied`, in paint order, so a click can step through them.
 *
 * Nothing here scans the graph: the browser has already narrowed the question to the handful of
 * elements under one point, and only those connectors' own routes are measured.
 */
import { distanceToPath, type Point } from '../edges/nearest';

export type EdgeHitPart =
  /** The line itself, its arrowhead, or something drawn on it (a caption, a glyph). */
  | 'line'
  /** Its label chip, step badge, condition or reply label: clicking one selects the connector. */
  | 'label'
  /** One of its own controls (an attachment chip, an endpoint handle): hovered, never clicked through. */
  | 'control';

export interface EdgePick {
  id: string;
  part: EdgeHitPart;
  /** The connectors as close as `id` — `id` first, then the rest in paint order. At least `[id]`. */
  tied: string[];
  /** Set when `part` is `'label'` on a label several connectors share (see `labelGroups.ts`). */
  group?: string[];
}

/** Routes closer together than this, on screen, count as the same place: nobody can aim between them. */
const TIE_PX = 1;

const EDGE_SELECTOR = '.react-flow__edge[data-id]';
const OVERLAY_SELECTOR = '[data-edge-overlay]';
/** Canvas surfaces with nothing of their own to click: looked through, never a reason to stop. */
const BACKDROP_SELECTOR = '.react-flow__pane, .react-flow__renderer, .react-flow__viewport, .react-flow__edges, .react-flow__edgelabel-renderer, .react-flow__nodes, .react-flow__background';

function insideRect(clientX: number, clientY: number, element: Element): boolean {
  const box = element.getBoundingClientRect();
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
}

/**
 * A node's element the pointer may look through to a connector underneath: a connection handle's
 * hit ring where it reaches past the node's own body, and a boundary's empty interior (a selected
 * boundary is lifted above the connectors inside it, which otherwise made every one of them
 * unclickable). Anything else of a node — its body, a resize grip, a boundary's title — is the node's.
 */
function seeThrough(element: Element, clientX: number, clientY: number): boolean {
  const node = element.closest('.react-flow__node');
  if (!node) return false;
  if (element.closest('.react-flow__handle')) return !insideRect(clientX, clientY, node);
  const body = node.querySelector('.dc-node');
  if (body?.getAttribute('data-type') !== 'group') return false;
  if (element.closest('button, input, textarea, [contenteditable="true"], .react-flow__resize-control')) return false;
  return element === node || element === body || element instanceof SVGElement;
}

/** How far `aim` is from any of a connector's hit paths (a request/response connector has two). */
function distanceTo(edge: Element, aim: Point): number | null {
  let best: number | null = null;
  for (const path of edge.querySelectorAll('.dc-edge-hit')) {
    const d = path.getAttribute('d');
    const distance = d ? distanceToPath(aim, d) : null;
    if (distance !== null && (best === null || distance < best)) best = distance;
  }
  return best;
}

function overlayPick(overlay: Element, element: Element): EdgePick | null {
  const id = overlay.getAttribute('data-edge-overlay');
  if (!id) return null;
  const label = element.closest('.dc-edge-label, .dc-edge-step, .dc-edge-meta, .dc-edge-response-label');
  if (!label) return { id, part: 'control', tied: [id] };
  const members = label.getAttribute('data-label-group');
  const group = members ? members.split(' ').filter(Boolean) : undefined;
  return { id, part: 'label', tied: [id], ...(group && group.length > 1 ? { group } : {}) };
}

/**
 * The connector at a screen point, or `null` when the point is on something else — a node, a panel,
 * a popover, an empty stretch of canvas.
 *
 * @param aim The same point in flow coordinates, the space every route's `d` is written in.
 * @param zoom The canvas zoom, so "equally close" means the same thing on screen at every zoom.
 */
export function pickEdgeAt(clientX: number, clientY: number, aim: Point, zoom: number): EdgePick | null {
  const stack = document.elementsFromPoint(clientX, clientY);
  const top = stack[0];
  // A panel, toolbar or popover over the canvas: whatever it covers can't be seen or aimed at.
  if (!top || !top.closest('.react-flow') || top.closest('[class*="dc-popover"], .dc-context-menu')) return null;

  const candidates: { id: string; distance: number; order: number }[] = [];
  const seen = new Set<string>();
  for (const element of stack) {
    const overlay = element.closest(OVERLAY_SELECTOR);
    if (overlay) {
      // A connector's own chip above the lines: it names its connector outright. Below a line that
      // is already under the pointer, it is only something that line runs across.
      if (candidates.length > 0) break;
      return overlayPick(overlay, element);
    }
    const edge = element.closest(EDGE_SELECTOR);
    if (edge) {
      const id = edge.getAttribute('data-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Drawn on the line — a caption, a glyph — rather than the hit path around it: that connector.
      if (!element.classList.contains('dc-edge-hit') && candidates.length === 0 && element.closest('.dc-edge-caption, .dc-edge-glyph')) {
        return { id, part: 'line', tied: [id] };
      }
      const distance = distanceTo(edge, aim);
      candidates.push({ id, distance: distance ?? Number.POSITIVE_INFINITY, order: candidates.length });
      continue;
    }
    if (seeThrough(element, clientX, clientY) || element.matches(BACKDROP_SELECTOR)) continue;
    // A node's body, or anything else that is its own thing to click: it is in front of whatever
    // connector runs beneath it, and it wins.
    break;
  }
  if (candidates.length === 0) return null;

  const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
  const tolerance = TIE_PX / Math.max(zoom, 0.01);
  const tied = candidates
    .filter((candidate) => candidate.distance - nearest <= tolerance || (!Number.isFinite(nearest) && candidate.order === 0))
    .sort((a, b) => a.order - b.order)
    .map((candidate) => candidate.id);
  return { id: tied[0]!, part: 'line', tied };
}

/**
 * The connector a click selects, given what is under the pointer and what is selected already.
 * A second click on a spot several connectors share steps to the next of them, so each stays
 * reachable without a modifier; any other click takes the nearest (or the label's own connector).
 */
export function edgeToSelect(pick: EdgePick, selectedEdges: readonly string[]): string {
  const choices = pick.group ?? pick.tied;
  if (choices.length < 2 || selectedEdges.length !== 1) return pick.group ? choices[0]! : pick.id;
  const at = choices.indexOf(selectedEdges[0]!);
  return at < 0 ? (pick.group ? choices[0]! : pick.id) : choices[(at + 1) % choices.length]!;
}
