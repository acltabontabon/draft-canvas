/**
 * Intent Continuation — architecture autocomplete: the deterministic next moves Draft Canvas is
 * willing to offer for what the user has already drawn. Not a recommender, not AI. The pieces:
 *
 * - `context.ts` — one node's neighborhood (plus the connectors leaving its neighbors).
 * - `rules.ts` / `families.ts` — authored candidates: one node, or a short chain (`defineChain`).
 * - `role.ts` — what an anchor is evidently doing, from what points at it; reorders its own
 *   alternatives without ever adding or removing one.
 * - `existing.ts` — candidates that connect to a suitable node already drawn nearby.
 * - `engine.ts` — generate → matrix validity → suppression → derived confidence → `rank.ts`.
 *   The capability matrix, never a rule, decides what is technically allowed.
 * - `materialize.ts` (+ `naming.ts`) — one candidate as real, positioned elements, so the preview
 *   and the accepted result are the same objects.
 *
 * Silence is the default outcome: only high confidence shows unprompted; the rest waits to be
 * asked for. This module never learns what a ghost is, or how alternatives are cycled — see
 * `canvas/`. Layering matches the rest of the app: `document/`, `edges/routing`, `edges/clearance`
 * and `render/text` only, nothing from `store/` or `canvas/`. See `docs/reference/architecture.md`.
 */

export { neighborhoodOf } from './context';
export { ROLE_PREFERENCE, anchorRole } from './role';
export type { AnchorRole } from './role';
export { continuationSets, continuationsFor } from './engine';
export { dismissalKey } from './dismissal';
export { gapForCaption, horizontalAnchorsFor, materialize } from './materialize';
export { RULES } from './rules';
export type {
  Continuation,
  ContinuationConfidence,
  ContinuationRule,
  ContinuationTier,
  ContinuationTrigger,
  DismissalKey,
  Fragment,
  FragmentEdgeSpec,
  FragmentExistingRef,
  FragmentNodeSpec,
  MaterializedContinuation,
  Neighborhood,
} from './types';
