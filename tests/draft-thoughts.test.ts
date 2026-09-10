import { describe, expect, it } from 'vitest';
import { DRAFT_THOUGHTS, thoughtForDay } from '../src/ui/Library/draftThoughts';

/**
 * The foot of the home screen carries one line of the product's opinion.
 * It must hold still while someone reads it (picked by day, not render),
 * and it must fit on one line at the width the footer gives it.
 */
describe('draft thoughts', () => {
  it('picks the same thought all day and a different one tomorrow', () => {
    const morning = new Date(Date.UTC(2026, 8, 10, 8));
    const evening = new Date(Date.UTC(2026, 8, 10, 22));
    const tomorrow = new Date(Date.UTC(2026, 8, 11, 8));
    expect(thoughtForDay(morning)).toBe(thoughtForDay(evening));
    expect(thoughtForDay(tomorrow)).not.toBe(thoughtForDay(morning));
  });

  it('cycles through every thought over consecutive days', () => {
    const seen = new Set<string>();
    for (let day = 0; day < DRAFT_THOUGHTS.length; day += 1) {
      seen.add(thoughtForDay(new Date(Date.UTC(2026, 0, 1 + day, 12))));
    }
    expect(seen.size).toBe(DRAFT_THOUGHTS.length);
  });

  it('keeps every line short, distinct, and a full sentence', () => {
    expect(new Set(DRAFT_THOUGHTS).size).toBe(DRAFT_THOUGHTS.length);
    for (const thought of DRAFT_THOUGHTS) {
      expect(thought.length).toBeLessThanOrEqual(90);
      expect(thought.endsWith('.')).toBe(true);
    }
  });
});
