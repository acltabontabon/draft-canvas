import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The suggestion pill is placed by an inline `transform` and drawn in flow space, which two
 * stylesheet rules have to leave alone. Playwright (`e2e/intent-continuation.spec.ts`) checks the
 * result in a browser; this is the part of it that a stylesheet edit can break without one.
 */
const css = readFileSync(resolve(process.cwd(), 'src/styles/canvas.css'), 'utf8');

/** The body of `@keyframes name { … }`, braces and all. */
function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  if (start === -1) throw new Error(`no keyframes ${name}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unterminated keyframes ${name}`);
}

/** The declaration block of the first rule whose selector is exactly `selector` (indented or not). */
function block(selector: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.[\]()]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1]!;
}

describe('the suggestion pill’s styles', () => {
  it('fades in on opacity alone: a running `transform` animation would replace the inline position', () => {
    expect(keyframes('dc-ghost-pill-in')).not.toMatch(/transform/);
    expect(keyframes('dc-ghost-pill-in')).toMatch(/opacity/);
    // `dc-attachment-card-in` animates `transform`; it is the ghost body's, and must never be the pill's.
    const pills = [...css.matchAll(/\.dc-ghost-pill(?:-main)? \{([^}]*)\}/g)].map((m) => m[1]!).filter((body) => /animation:/.test(body));
    expect(pills.length).toBeGreaterThan(0);
    for (const body of pills) expect(body).not.toMatch(/dc-attachment-card-in/);
  });

  it('is scaled by the inverse of the zoom, clamped at both ends', () => {
    expect(block('.dc-ghost-pill')).toMatch(/--dc-ghost-pill-scale:\s*clamp\([\d.]+,\s*calc\(1 \/ var\(--dc-zoom, 1\)\),\s*[\d.]+\)/);
  });

  it('shows its dismiss button, and hides the Tab hint, on a coarse pointer only', () => {
    expect(block('.dc-ghost-pill .dc-ghost-pill-dismiss')).toMatch(/display:\s*none/);
    const coarse = css.slice(css.indexOf('@media (pointer: coarse) {\n  .dc-ghost-pill kbd'));
    expect(coarse.slice(0, 600)).toMatch(/\.dc-ghost-pill kbd \{\s*display: none;/);
    expect(coarse.slice(0, 600)).toMatch(/\.dc-ghost-pill \.dc-ghost-pill-dismiss \{\s*display: inline-flex;/);
  });
});
