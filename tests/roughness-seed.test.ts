import { describe, expect, it } from 'vitest';
import { createRng, jitter } from '../src/render/roughness/seed';

describe('roughness seed (deterministic jitter)', () => {
  it('never uses Math.random or wall-clock — same id always produces the same numbers', () => {
    const rngA = createRng('node-1');
    const rngB = createRng('node-1');
    expect(rngA()).toBe(rngB());
    expect(rngA()).toBe(rngB());
  });

  it('produces different sequences for different ids', () => {
    expect(createRng('a')()).not.toBe(createRng('b')());
  });

  it('jitter is bounded by amplitude', () => {
    for (let i = 0; i < 50; i += 1) {
      const value = jitter('n1', i, 3);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThanOrEqual(3);
    }
  });

  it('amplitude 0 always returns exactly 0', () => {
    expect(jitter('n1', 0, 0)).toBe(0);
    expect(jitter('anything', 99, 0)).toBe(0);
  });

  it('is deterministic across repeated calls with the same id and index', () => {
    expect(jitter('n1', 0, 3)).toBe(jitter('n1', 0, 3));
  });

  it('different ids at the same index produce different jitter', () => {
    expect(jitter('n1', 0, 3)).not.toBe(jitter('n2', 0, 3));
  });

  it('different indices for the same id produce independent jitter', () => {
    expect(jitter('n1', 0, 3)).not.toBe(jitter('n1', 1, 3));
  });
});
