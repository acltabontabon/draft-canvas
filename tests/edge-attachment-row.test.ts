/**
 * Where a connector's marks go: its attachment chips, then its open-point tab, in one row beyond its
 * words (`edges/connectorMarks.ts`) — never centred on the bare label point, where beside an upright
 * run the row lay across the line while the words sat to its side.
 */
import { describe, expect, it } from 'vitest';
import { attachmentRowBelowsSourceOrTarget } from '../src/canvas/edgeGeometry';
import { MARK_ROW_GAP, connectorMarkRow } from '../src/edges/connectorMarks';
import { ATTACHMENT_CHIP_HEIGHT } from '../src/edges/attachmentChips';
import { MARKER_GAP, MARKER_SIZE } from '../src/openPoints/marker';
import { LABEL_LINE_GAP } from '../src/edges/routing';

const far = { x: 0, y: 0, width: 100, height: 60 };
const other = { x: 600, y: 0, width: 100, height: 60 };
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('the inspector popover probe', () => {
  it('hangs above the line by default, clear of both ends', () => {
    expect(attachmentRowBelowsSourceOrTarget(350, 400, far, other)).toBe(false);
  });

  it('flips below when above would land in its own source or target', () => {
    expect(attachmentRowBelowsSourceOrTarget(50, 100, far, other)).toBe(true);
  });
});

describe('a connector mark row', () => {
  const source = { x: 0, y: 360, width: 160, height: 80 };
  const target = { x: 560, y: 360, width: 160, height: 80 };
  const point = { x: 360, y: 400 };

  it('has nothing to place without attachments or an open point', () => {
    expect(connectorMarkRow({ point, upright: false, side: 'top', attachmentsWidth: 0, openPoint: false, source, target })).toBeNull();
  });

  it('sits one gap above a label over a level run, centred on the words, chips then the tab', () => {
    const words = { x: 320, y: 376, width: 80, height: 19 };
    const row = connectorMarkRow({ point, upright: false, side: 'top', words, attachmentsWidth: 50, openPoint: true, source, target })!;
    expect(row.box.y + row.box.height).toBe(words.y - MARK_ROW_GAP);
    expect(row.box.x + row.box.width / 2).toBe(words.x + words.width / 2);
    expect(row.attachments!.box.x).toBe(row.box.x);
    expect(row.openPoint!.x - MARKER_SIZE / 2).toBe(row.attachments!.box.x + 50 + MARKER_GAP);
    // The chips are pinned at the tab, so a wider chip on screen grows away from it.
    expect(row.attachments!.anchor).toBe('end');
    expect(row.below).toBe(false);
    expect(overlaps(row.box, words)).toBe(false);
  });

  it('goes below a caption under its line, and below the condition chip under that', () => {
    const caption = { x: 340, y: 405, width: 40, height: 13 };
    const condition = { x: 335, y: 420, width: 50, height: 15 };
    const row = connectorMarkRow({ point, upright: false, side: 'top', words: caption, condition, attachmentsWidth: 50, openPoint: false, source, target })!;
    expect(row.box.y).toBe(condition.y + condition.height + MARK_ROW_GAP);
    expect(row.below).toBe(true);
  });

  it('stacks under the words beside an upright run, starting where they start, off the line', () => {
    const upright = { x: 400, y: 200 };
    const words = { x: 402, y: 190, width: 90, height: 19 };
    const row = connectorMarkRow({ point: upright, upright: true, side: 'right', words, attachmentsWidth: 50, openPoint: true, source, target })!;
    expect(row.box.x).toBe(upright.x + LABEL_LINE_GAP);
    expect(row.box.y).toBe(words.y + words.height + MARK_ROW_GAP);
    // Never across the line it belongs to.
    expect(row.box.x).toBeGreaterThan(upright.x);
    const left = connectorMarkRow({ point: upright, upright: true, side: 'left', words: { ...words, x: 300 }, attachmentsWidth: 50, openPoint: false, source, target })!;
    expect(left.box.x + left.box.width).toBe(upright.x - LABEL_LINE_GAP);
    expect(left.attachments!.anchor).toBe('end');
  });

  it('takes the place of words a connector does not have', () => {
    const row = connectorMarkRow({ point, upright: false, side: 'top', attachmentsWidth: 40, openPoint: false, source, target })!;
    expect(row.box.y + row.box.height).toBe(point.y - LABEL_LINE_GAP);
    expect(row.box.height).toBe(ATTACHMENT_CHIP_HEIGHT);
  });

  it('moves to the other side of the line rather than onto one of its own shapes', () => {
    // A short hop whose words sit right under the target's overhang.
    const low = { x: 200, y: 330, width: 160, height: 60 };
    const row = connectorMarkRow({ point: { x: 280, y: 400 }, upright: false, side: 'top', words: { x: 250, y: 376, width: 60, height: 19 }, attachmentsWidth: 50, openPoint: true, source: low, target })!;
    expect(overlaps(row.box, low)).toBe(false);
    expect(row.below).toBe(true);
  });
});
