import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
    // The caption is filled with `theme.textFaint` (`--dc-text-faint`); the label matches it.
    expect(declaration(label, 'color')).toBe('var(--dc-text-faint)');
  });

  it('draws the reply label at that size too', () => {
    expect(declaration(rule('.dc-edge-response-label'), 'font-size')).toBe(`${TEXT_SIZES.edgeLabel}px`);
  });
});
