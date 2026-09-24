/**
 * Where a connector's attachment chip row hangs: above its label point unless that would land in one
 * of its own ends — and, whatever the ends say, below the line when the connector's label chip sits
 * above it (the row used to cover its own label).
 */
import { describe, expect, it } from 'vitest';
import { attachmentRowBelowsSourceOrTarget, captionSideOf } from '../src/canvas/edgeGeometry';
import type { DraftEdge } from '../src/document/types';

const far = { x: 0, y: 0, width: 100, height: 60 };
const other = { x: 600, y: 0, width: 100, height: 60 };
const edge = (extra: Partial<DraftEdge> = {}): DraftEdge => ({ id: 'e', source: 'a', target: 'b', routing: 'smoothstep', directed: true, ...extra }) as DraftEdge;

describe('attachment chip row side', () => {
  it('hangs above the line by default, clear of both ends', () => {
    expect(attachmentRowBelowsSourceOrTarget(350, 400, far, other)).toBe(false);
  });

  it('flips below when above would land in its own source or target', () => {
    expect(attachmentRowBelowsSourceOrTarget(50, 100, far, other)).toBe(true);
  });

  it('goes below the line when the connector\'s label is above it', () => {
    expect(attachmentRowBelowsSourceOrTarget(350, 400, far, other, 'top')).toBe(true);
    expect(attachmentRowBelowsSourceOrTarget(350, 400, far, other, 'bottom')).toBe(false);
  });

  it('counts a label chip, not a relationship caption (drawn below a horizontal line regardless)', () => {
    expect(captionSideOf(edge(), 'top')).toBeUndefined();
    expect(captionSideOf(edge({ label: 'Calls' }), 'top')).toBe('top');
    expect(captionSideOf(edge({ semantic: 'publishes' } as Partial<DraftEdge>), 'top')).toBeUndefined();
  });
});
