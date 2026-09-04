import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rank } from '../src/commands/fuzzy';
import type { CommandOption } from '../src/commands/types';

// Node's own experimental `globalThis.localStorage` shadows jsdom's in this environment — the
// same in-memory fake `tests/personality-preference.test.tsx` uses stands in for
// `lib/preferences.ts`, including its 64-character cap, so the history's own key scheme is what
// gets exercised.
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => {
    if (value.length > 64) return;
    prefs.set(key, value);
  },
  removePreference: (key: string) => void prefs.delete(key),
}));

const { RECENT_LIMIT, frequencyBonus, recentIds, recordUse, usageCount } = await import('../src/commands/history');

const noop = () => {};

describe('command history', () => {
  beforeEach(() => prefs.clear());

  it('starts empty', () => {
    expect(recentIds()).toEqual([]);
    expect(usageCount('add-service')).toBe(0);
    expect(frequencyBonus('add-service')).toBe(0);
  });

  it('keeps the newest first, dedupes, and never grows past the limit', () => {
    recordUse('add-service');
    recordUse('connect-to');
    recordUse('add-service');
    expect(recentIds()).toEqual(['add-service', 'connect-to']);
    for (let i = 0; i < RECENT_LIMIT + 3; i += 1) recordUse(`cmd-${i}`);
    const ids = recentIds();
    expect(ids).toHaveLength(RECENT_LIMIT);
    expect(ids[0]).toBe(`cmd-${RECENT_LIMIT + 2}`);
    expect(ids).not.toContain('add-service');
  });

  it('counts uses per command', () => {
    recordUse('add-service');
    recordUse('add-service');
    recordUse('connect-to');
    expect(usageCount('add-service')).toBe(2);
    expect(usageCount('connect-to')).toBe(1);
    expect(frequencyBonus('add-service')).toBeGreaterThan(frequencyBonus('connect-to'));
  });

  it('only ever writes short values, well inside the preferences cap', () => {
    for (let i = 0; i < 12; i += 1) recordUse(`edge-reconnect-target-${i}`);
    for (const [key, value] of prefs) {
      expect(key.startsWith('command-')).toBe(true);
      expect(value.length).toBeLessThanOrEqual(64);
    }
    recordUse('x'.repeat(80)); // an absurd id is ignored rather than truncated
    expect(recentIds()).not.toContain('x'.repeat(80));
  });

  it('nudges a frequently used command on a tie, but never past a clearly better match', () => {
    const catalog: CommandOption[] = [
      { id: 'add-actor', title: 'Add Actor', run: noop },
      { id: 'add-service', title: 'Add Service', run: noop },
      { id: 'spotlight', title: 'Spotlight selection', run: noop },
    ];
    const order = (query: string) =>
      rank(query, catalog, (entry) => frequencyBonus(entry.id)).map((row) => row.entry.title);

    expect(order('add')).toEqual(['Add Actor', 'Add Service']);
    for (let i = 0; i < 6; i += 1) recordUse('add-service');
    expect(order('add')[0]).toBe('Add Service');
    // "spot" is an exact prefix of Spotlight; 200 uses of Add Service must not beat it.
    for (let i = 0; i < 200; i += 1) recordUse('add-service');
    expect(order('spot')[0]).toBe('Spotlight selection');
    // Nor may any amount of use beat a prefix hit on the same query: "ser" means Service by name.
    const named: CommandOption[] = [
      { id: 'add-service', title: 'Add Service', run: noop },
      { id: 'jump-node:1', title: 'Service', run: noop },
    ];
    const named_order = rank('ser', named, (entry) => (entry.id.startsWith('jump-') ? -1 : frequencyBonus(entry.id)));
    expect(named_order[0]!.entry.title).toBe('Service');
  });
});
