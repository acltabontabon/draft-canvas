/**
 * Capturing an action: the key it is on, and what it remembers about where you were.
 *
 * Pure, so the rule can be tested without a store, a canvas or a presentation running — and so
 * the one sentence that decides an action's architecture context lives somewhere a person can
 * read it whole.
 */

import type { DraftAction } from '../document/types';

/**
 * The bare key that opens the capture line.
 *
 * `A` is Actor and `T` is Text, so this follows the precedent the shape keys already set when the
 * first letter was taken: Component is on `M`, from co*M*ponent, and this is on `I`, from
 * act*I*on. It is also the one bare key present mode lets through besides Escape — see
 * `EditorScreen`'s keyboard handler, where capturing mid-walkthrough is the whole point.
 */
export const CAPTURE_ACTION_KEY = 'I';

/** Everything the anchor rule looks at. Deliberately plain data, not a store. */
export interface CaptureSource {
  presenting: boolean;
  selection: { nodes: readonly string[]; edges: readonly string[] };
  /** The connector the current presentation step is about, when a flow is playing. */
  stepEdgeId?: string | undefined;
  /** The node a "frame" step spotlights, when the step has no connector of its own. */
  stepNodeId?: string | undefined;
}

/**
 * What the action about to be captured should remember, or nothing.
 *
 * Two rules, and no guessing between them:
 *
 * - **While presenting**, it is whatever the step is about. Presentation already works this out
 *   to decide which attachment speaks (`presentation/presentationAttachments.ts`), and it is the
 *   same answer: the step's connector, or the shape a frame step is holding up. Selection is
 *   forcibly empty in present mode, so there is nothing else it could mean.
 * - **While editing**, it is the single selected element. Two or more selected produces nothing
 *   at all: an action can only have come from one place, and picking one of several would be a
 *   guess that reads as a bug the first time it picks the wrong one.
 *
 * Nothing selected is the ordinary case — most actions belong to the whole canvas.
 */
export function captureAnchorFor(source: CaptureSource): DraftAction['anchor'] | undefined {
  if (source.presenting) {
    if (source.stepEdgeId) return { kind: 'edge', id: source.stepEdgeId };
    if (source.stepNodeId) return { kind: 'node', id: source.stepNodeId };
    return undefined;
  }
  const { nodes, edges } = source.selection;
  if (nodes.length === 1 && edges.length === 0) return { kind: 'node', id: nodes[0]! };
  if (edges.length === 1 && nodes.length === 0) return { kind: 'edge', id: edges[0]! };
  return undefined;
}
