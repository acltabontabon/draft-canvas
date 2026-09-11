import { describe, expect, it } from 'vitest';
import { aliasFor } from '../src/sequence/alias';

describe('aliasFor', () => {
  it('produces a title-cased, no-space slug from a plain label', () => {
    expect(aliasFor('Payment Service', 'P1', new Set())).toBe('PaymentService');
  });

  it('preserves an all-caps word instead of mangling its casing', () => {
    expect(aliasFor('Order API', 'P1', new Set())).toBe('OrderAPI');
  });

  it('appends a number on collision, deterministically', () => {
    const taken = new Set(['PaymentService']);
    expect(aliasFor('Payment Service', 'P2', taken)).toBe('PaymentService2');
  });

  it('keeps incrementing past an already-taken numbered alias', () => {
    const taken = new Set(['PaymentService', 'PaymentService2']);
    expect(aliasFor('Payment Service', 'P3', taken)).toBe('PaymentService3');
  });

  it('falls back to the stable internal id when the label has no usable characters', () => {
    expect(aliasFor('!!!', 'P4', new Set())).toBe('P4');
    expect(aliasFor('', 'P5', new Set())).toBe('P5');
  });

  it('falls back to the internal id when the slug would start with a digit', () => {
    expect(aliasFor('123 Service', 'P6', new Set())).toBe('P6');
  });

  it('falls back to the internal id when the slug collides with a reserved keyword', () => {
    expect(aliasFor('participant', 'P7', new Set())).toBe('P7');
    expect(aliasFor('Group', 'P8', new Set())).toBe('P8');
    expect(aliasFor('loop', 'P9', new Set())).toBe('P9');
  });

  it('truncates a very long label to a bounded alias length', () => {
    const longLabel = 'A'.repeat(200);
    const alias = aliasFor(longLabel, 'P10', new Set());
    expect(alias.length).toBeLessThanOrEqual(40);
  });

  it('is deterministic for the same inputs', () => {
    expect(aliasFor('Payment Service', 'P1', new Set())).toBe(aliasFor('Payment Service', 'P1', new Set()));
  });
});
