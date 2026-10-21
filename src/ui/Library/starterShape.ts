import { libraryShapeOf } from '../../document/shape';
import { buildStarter } from '../../starters/build';
import type { ArchitectureStarter, StarterId } from '../../starters/types';
import { glyphShapeOf, type StarterShape } from './starterShapes';

// Apart from `starterShapes.ts` because only a starter tile builds a starter: the Library's own
// previews draw saved fingerprints through `glyphShapeOf`, and importing the starter builder there
// put it on the first page load.

const cache = new Map<StarterId, StarterShape>();

/**
 * A starter's topology, derived from the starter itself — the same `buildStarter` a click on it
 * runs, reduced by the same `libraryShapeOf` every saved canvas's fingerprint goes through. No
 * second, hand-maintained drawing of any architecture exists: change a starter in the catalog and
 * its tile on the home screen changes with it. Built once per starter, on first use.
 */
export function starterShape(starter: ArchitectureStarter): StarterShape {
  const cached = cache.get(starter.id);
  if (cached) return cached;
  const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
  const result = glyphShapeOf(libraryShapeOf(nodes, edges));
  cache.set(starter.id, result);
  return result;
}
