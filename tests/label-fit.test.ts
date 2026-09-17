import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import type { DraftNode } from '../src/document/types';
import { describeContext, describeNode } from '../src/nodes/describe';
import type { TextShape } from '../src/render/displayList';
import { FONTS, TEXT_SIZES } from '../src/render/text/fonts';
import { fitLabel } from '../src/render/text/layout';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { LIGHT } from '../src/render/theme/tokens';

/**
 * Draft Canvas's graceful label-fitting hierarchy: wrap first, shrink the font only when wrapping
 * alone isn't enough, and fall back to an ellipsis only when even the minimum size doesn't fit.
 * These tests exercise the shared `fitLabel` primitive directly, and the shape-level wiring
 * (`describeNode`) for the node types whose primary label goes through it.
 */

const measurer = new StaticTextMeasurer();
const clean = describeContext(LIGHT, 'clean');

function labelShape(node: DraftNode): TextShape {
  const labels = describeNode(node, clean).shapes.filter(
    (s): s is TextShape => s.t === 'text' && s.role === 'label',
  );
  expect(labels).toHaveLength(1);
  return labels[0]!;
}

describe('fitLabel', () => {
  const base = {
    font: FONTS.nodeLabel,
    minFontSize: TEXT_SIZES.nodeLabelMin,
    lineHeightRatio: 1.35,
    measurer,
  };

  it('keeps the preferred size for a short label', () => {
    const { font, layout } = fitLabel('Auth', { ...base, maxWidth: 200, maxHeight: 100 });
    expect(font.size).toBe(FONTS.nodeLabel.size);
    expect(layout.lines).toHaveLength(1);
    expect(layout.truncated).toBe(false);
  });

  it('wraps at the preferred size before ever shrinking', () => {
    const { font, layout } = fitLabel('Customer Profile Service', {
      ...base,
      maxWidth: 110,
      maxHeight: 100,
    });
    expect(font.size).toBe(FONTS.nodeLabel.size);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.truncated).toBe(false);
  });

  it('shrinks only once wrapping within the available height is not enough', () => {
    // A long, unbroken identifier: wrapping can only break it by width, so a tight two-line box
    // isolates the shrink step from wrapping — this text can't be helped by breaking it onto
    // more of the same-size lines because there is no room for more lines, only smaller ones.
    const longWord = 'CustomerContextAggregationServiceForBillingPlatform'; // 53 chars, no spaces
    const roomy = fitLabel(longWord, { ...base, maxWidth: 400, maxHeight: 40 });
    expect(roomy.font.size).toBe(FONTS.nodeLabel.size);

    const cramped = fitLabel(longWord, { ...base, maxWidth: 90, maxHeight: 40 });
    expect(cramped.font.size).toBeLessThan(FONTS.nodeLabel.size);
    expect(cramped.font.size).toBeGreaterThanOrEqual(TEXT_SIZES.nodeLabelMin);
  });

  it('never shrinks below the minimum, and falls back to ellipsis only there', () => {
    const extreme = 'A'.repeat(200);
    const { font, layout } = fitLabel(extreme, { ...base, maxWidth: 110, maxHeight: 40 });
    expect(font.size).toBe(TEXT_SIZES.nodeLabelMin);
    expect(layout.truncated).toBe(true);
    expect(layout.lines.at(-1)?.text.endsWith('…')).toBe(true);
  });

  it('preserves an explicit line break instead of re-wrapping across it', () => {
    const { layout } = fitLabel('Customer Profile\nDatabase', { ...base, maxWidth: 300, maxHeight: 100 });
    expect(layout.lines.map((l) => l.text)).toEqual(['Customer Profile', 'Database']);
  });

  it.each(['', ' ', 'x', 'a-very-long-url.example.com/path/segment', 'snake_case_identifier', 'CamelCaseIdentifier'])(
    'resolves without throwing for edge-case text %j',
    (text) => {
      expect(() => fitLabel(text, { ...base, maxWidth: 80, maxHeight: 30 })).not.toThrow();
    },
  );
});

describe('shape labels render through the same graceful hierarchy', () => {
  const longName = 'Credit Card Account Provisioning Service';

  it('a Database cylinder wraps a long name instead of immediately ellipsizing it (the reported bug)', () => {
    const node = createNode({ type: 'database', x: 0, y: 0, width: 160, height: 110, text: longName });
    const label = labelShape(node);
    // Before this change, the cylinder's name line was hard-capped at one line and would have
    // ellipsized here. It must not any more: either it fits by wrapping, or by wrapping *and*
    // shrinking — never a same-size, one-line cut of a name this size box can clearly hold more of.
    expect(label.layout.lines.length).toBeGreaterThan(1);
    // The full name is still on the node itself, regardless of how it's drawn.
    expect(node.text).toBe(longName);
  });

  it('a Queue name wraps rather than truncating on one line', () => {
    const node = createNode({ type: 'queue', x: 0, y: 0, width: 160, height: 110, text: longName });
    const label = labelShape(node);
    expect(label.layout.lines.length).toBeGreaterThan(1);
    expect(node.text).toBe(longName);
  });

  it('an Actor label wraps and, if needed, shrinks before ellipsizing', () => {
    const node = createNode({ type: 'actor', x: 0, y: 0, width: 120, height: 90, text: longName });
    const label = labelShape(node);
    expect(label.font.size).toBeLessThanOrEqual(FONTS.nodeLabel.size);
    expect(label.font.size).toBeGreaterThanOrEqual(TEXT_SIZES.nodeLabelMin);
    expect(node.text).toBe(longName);
  });

  it('a Group/Boundary title shrinks but never wraps to a second line', () => {
    const node = createNode({ type: 'group', x: 0, y: 0, width: 130, height: 80, text: longName });
    const label = labelShape(node);
    expect(label.layout.lines).toHaveLength(1);
    expect(label.font.size).toBeLessThanOrEqual(FONTS.groupTitle.size);
    expect(label.font.size).toBeGreaterThanOrEqual(TEXT_SIZES.groupTitleMin);
    expect(node.text).toBe(longName);
  });

  it('resizing a shrunk node larger lets the label climb back toward the preferred size', () => {
    const small = createNode({ type: 'service', x: 0, y: 0, width: 90, height: 40, text: longName });
    const shrunk = labelShape(small);
    expect(shrunk.font.size).toBeLessThan(FONTS.nodeLabel.size);

    // Same node, same text — only the box grew. Nothing about the fit is persisted on the node.
    const grown: DraftNode = { ...small, width: 320, height: 160 };
    const restored = labelShape(grown);
    expect(restored.font.size).toBe(FONTS.nodeLabel.size);
    expect(restored.layout.truncated).toBe(false);
  });

  it('a short label is completely unaffected — same size, one line, as before this feature', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, width: 160, height: 60, text: 'Auth' });
    const label = labelShape(node);
    expect(label.font.size).toBe(FONTS.nodeLabel.size);
    expect(label.layout.lines).toHaveLength(1);
    expect(label.layout.truncated).toBe(false);
  });
});
