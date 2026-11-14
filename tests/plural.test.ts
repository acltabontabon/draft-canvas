import { describe, expect, it } from 'vitest';
import { count, selectionCount } from '../src/lib/plural';

describe('count', () => {
  it('pluralises the regular nouns the interface counts', () => {
    expect(count(1, 'step')).toBe('1 step');
    expect(count(0, 'step')).toBe('0 steps');
    expect(count(3, 'connector')).toBe('3 connectors');
  });
});

describe('selectionCount', () => {
  it('says shapes or connectors when the selection is only one of them', () => {
    expect(selectionCount(1, 0)).toBe('1 shape');
    expect(selectionCount(3, 0)).toBe('3 shapes');
    expect(selectionCount(0, 2)).toBe('2 connectors');
  });

  it('falls back to the umbrella word for a mix, which neither noun covers', () => {
    expect(selectionCount(2, 1)).toBe('3 elements');
    expect(selectionCount(1, 1)).toBe('2 elements');
  });
});
