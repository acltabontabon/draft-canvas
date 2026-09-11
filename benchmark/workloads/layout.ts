/**
 * Deterministic grid tiling for the benchmark's synthetic diagrams — placement only, reusing the
 * same spacing vocabulary (`GUTTER`/`BAND`) the hand-authored starters compose with, so a
 * benchmark workload's tiles read as ordinary starter geometry rather than an invented layout.
 */

import { GUTTER, BAND } from '../../src/starters/compose';
import { starterById, starterSize } from '../../src/starters';
import { TILE_ORDER } from './index';

/**
 * The cell size is derived, not hardcoded: measure `starterSize()` for every starter `TILE_ORDER`
 * cycles through once at module load, and pad the largest by a generous multiple of `GUTTER`/
 * `BAND` — so the layout keeps working with no manual tuning if a starter's own geometry changes
 * later.
 */
const TILE_SIZES = TILE_ORDER.map((id) => {
  const starter = starterById(id);
  return starter ? starterSize(starter) : { width: 0, height: 0 };
});

const CELL_WIDTH = Math.max(...TILE_SIZES.map((size) => size.width)) + GUTTER * 6;
const CELL_HEIGHT = Math.max(...TILE_SIZES.map((size) => size.height)) + BAND * 4;

export function nextTileOrigin(
  index: number,
  _tileSize: { width: number; height: number },
  rowCapacity: number,
): { x: number; y: number } {
  // Cell size is derived from the whole TILE_ORDER set above, not the one tile being placed —
  // `_tileSize` is accepted for signature symmetry with a per-tile-size layout but unused here.
  return {
    x: (index % rowCapacity) * CELL_WIDTH,
    y: Math.floor(index / rowCapacity) * CELL_HEIGHT,
  };
}
