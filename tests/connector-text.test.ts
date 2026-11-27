import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LABEL_STEP_GAP, LABEL_STEP_SIZE, LABEL_STEP_TEXT, labelChipSize } from '../src/edges/labelLayout';
import { FONTS, TEXT_SIZES } from '../src/render/text/fonts';

/**
 * A connector's typed label, its relationship caption and its reply label are one quiet style. The
 * canvas draws the label as a CSS chip and the caption as SVG text, and the exporter lays both out
 * with `FONTS`, so the numbers live in three places — this is what stops them drifting apart.
 */

const css = readFileSync(resolve(process.cwd(), 'src/styles/canvas.css'), 'utf8');

/** A rule's declaration block, by exact selector. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const declaration = (block: string, property: string) => new RegExp(`(?:^|[\\s;{])${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();

describe('connector text', () => {
  it('sets a label and a relationship caption in the same font', () => {
    expect(FONTS.edgeLabel).toEqual(FONTS.connectorCaption);
    expect(TEXT_SIZES.edgeLabel).toBe(TEXT_SIZES.connectorCaption);
  });

  it('draws the canvas label chip at that size and in the caption\'s tone', () => {
    const label = rule('.dc-edge-label');
    expect(declaration(label, 'font-size')).toBe(`${TEXT_SIZES.edgeLabel}px`);
    expect(declaration(label, 'font-weight')).toBe(String(FONTS.edgeLabel.weight));
    // The caption is filled with `theme.edgeText` (`--dc-edge-text`); the label matches it.
    expect(declaration(label, 'color')).toBe('var(--dc-edge-text)');
  });

  it('draws the reply label at that size too', () => {
    expect(declaration(rule('.dc-edge-response-label'), 'font-size')).toBe(`${TEXT_SIZES.edgeLabel}px`);
  });

  it('draws a recovery action\'s name and operation in the label\'s tone, as the export fills them', () => {
    expect(declaration(rule('.dc-edge-recovery-name'), 'color')).toBe('var(--dc-edge-text)');
    expect(declaration(rule('.dc-edge-recovery-operation'), 'color')).toBe('var(--dc-edge-text)');
  });

  it('carries a numbered label\'s step at the size and gap the export lays its chip out with', () => {
    const step = rule('.dc-edge-label-step');
    expect(declaration(step, 'width')).toBe(`${LABEL_STEP_SIZE}px`);
    expect(declaration(step, 'height')).toBe(`${LABEL_STEP_SIZE}px`);
    expect(declaration(step, 'font-size')).toBe(`${LABEL_STEP_TEXT}px`);
    expect(declaration(rule('.dc-edge-label'), 'gap')).toBe(`${LABEL_STEP_GAP}px`);
  });

  it('measures a numbered label chip the way it is drawn: its badge box, the gap, then the words', () => {
    const words = { width: 60, height: 14 };
    expect(labelChipSize(words, true)).toEqual({ width: 60 + LABEL_STEP_SIZE + LABEL_STEP_GAP + 12, height: LABEL_STEP_SIZE + 6 });
    expect(labelChipSize(words, false)).toEqual({ width: 72, height: 20 });
  });
});
