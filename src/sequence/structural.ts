/**
 * Which connector semantics describe a static architectural fact rather than something that
 * happens at a point in time during a Flow — these must never become a `SequenceMessage`, per the
 * Sequence Diagram export's own product rule: structural relationships are not runtime behavior.
 * Deliberately small: every other `EdgeSemantic` (including `uses`, `compensates`)
 * describes a real runtime interaction. See `docs/reference/semantics.md`.
 */
import type { EdgeSemantic } from '../document/types';

const STRUCTURAL_SEMANTICS: ReadonlySet<EdgeSemantic> = new Set(['dependsOn', 'implementedBy', 'implements']);

export function isStructural(edge: { semantic?: EdgeSemantic }): boolean {
  return edge.semantic !== undefined && STRUCTURAL_SEMANTICS.has(edge.semantic);
}
