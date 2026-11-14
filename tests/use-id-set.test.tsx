import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useIdSet } from '../src/canvas/useIdSet';

/**
 * The set of selected ids keeps its identity for as long as the ids are the same: a new set
 * re-projects every shape on the canvas, and React Flow reports an unchanged selection as fresh
 * arrays (`onSelectionChange`).
 */
describe('useIdSet', () => {
  it('hands back the same set for the same array, and for a new array of the same ids', () => {
    const { result, rerender } = renderHook(({ ids }) => useIdSet(ids), { initialProps: { ids: ['a', 'b'] } });
    const first = result.current;
    rerender({ ids: ['a', 'b'] });
    expect(result.current).toBe(first);
    // Order is not membership.
    rerender({ ids: ['b', 'a'] });
    expect(result.current).toBe(first);
  });

  it('hands back a new set when a member changes, though the count stays', () => {
    const { result, rerender } = renderHook(({ ids }) => useIdSet(ids), { initialProps: { ids: ['a', 'b'] } });
    const first = result.current;
    rerender({ ids: ['a', 'c'] });
    expect(result.current).not.toBe(first);
    expect([...result.current].sort()).toEqual(['a', 'c']);
  });

  it('hands back a new set when the selection grows or shrinks', () => {
    const { result, rerender } = renderHook(({ ids }) => useIdSet(ids), { initialProps: { ids: ['a'] } });
    const one = result.current;
    rerender({ ids: ['a', 'b'] });
    expect(result.current).not.toBe(one);
    expect(result.current.size).toBe(2);
    rerender({ ids: ['a'] });
    expect([...result.current]).toEqual(['a']);
  });

  it('keeps one empty set for every empty selection', () => {
    const { result, rerender } = renderHook(({ ids }) => useIdSet(ids), { initialProps: { ids: [] as string[] } });
    const empty = result.current;
    rerender({ ids: [] });
    expect(result.current).toBe(empty);
    rerender({ ids: ['a'] });
    rerender({ ids: [] });
    expect(result.current).toBe(empty);
    expect(result.current.size).toBe(0);
  });
});
