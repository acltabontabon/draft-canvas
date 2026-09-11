/**
 * Intent Continuation — the deterministic "next move" Draft Canvas is willing to offer for what
 * the user has already drawn. Not a recommender, not AI: a short list of rules (`rules.ts`), a
 * one-hop graph context (`context.ts`), and a pipeline (`engine.ts`) in which the capability
 * matrix — never a rule — decides what is technically allowed. `materialize.ts` turns an offer
 * into real, positioned elements so the preview and the accepted result are the same objects.
 *
 * Silence is the default outcome. This module never learns what a ghost is; see `canvas/` for
 * how an offer is shown. Layering matches the rest of the app: `document/` and `render/text`
 * only, nothing from `store/` or `canvas/`. See `docs/ARCHITECTURE.md`.
 */

export { neighborhoodOf, resolvedNeighborCategory } from './context';
export { continuationsFor, dismissalKey } from './engine';
export { gapForCaption, horizontalAnchorsFor, materialize, type MaterializeOptions } from './materialize';
export { RULES, ruleById } from './rules';
export type {
  Continuation,
  ContinuationRule,
  ContinuationTier,
  ContinuationTrigger,
  DismissalKey,
  Fragment,
  FragmentEdgeSpec,
  FragmentNodeSpec,
  MaterializedContinuation,
  Neighborhood,
} from './types';
