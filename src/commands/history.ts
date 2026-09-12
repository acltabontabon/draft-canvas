import { readPreference, removePreference, writePreference } from '../lib/preferences';

/**
 * Phase 8.4 — a small, local memory of which commands get used. Two things come out of it: the
 * "Recent" group at the top of an empty palette (so ⌘K → Enter repeats the last command), and a
 * gentle ranking nudge for a query, so "Add Service, Add Service, Connect, Connect" during a
 * rapid sketch rises toward the top without ever beating a clearly better text match.
 *
 * Stored through `preferences.ts` like every other small UI fact — one key per recent slot and
 * one per counter, never a joined list, because that file caps each value at 64 characters and
 * silently drops anything longer. Command ids are short by construction; this stays well clear.
 * Never synced, never per-document: the same few keys for the whole browser profile.
 */

export const RECENT_LIMIT = 8;
const COUNT_CAP = 9999;
/** Anything longer isn't a command id we'd want to persist — it's a bug, and `writePreference` would drop it anyway. */
const MAX_ID_LENGTH = 48;
const RECENT_KEY = (slot: number) => `command-recent.${slot}`;
const COUNT_KEY = (id: string) => `command-use.${id}`;

/** The most recently run command ids, newest first. */
export function recentIds(): string[] {
  const ids: string[] = [];
  for (let slot = 0; slot < RECENT_LIMIT; slot += 1) {
    const id = readPreference(RECENT_KEY(slot));
    if (id) ids.push(id);
  }
  return ids;
}

/** How many times `id` has run on this device. */
export function usageCount(id: string): number {
  const raw = readPreference(COUNT_KEY(id));
  const count = raw ? Number(raw) : 0;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** Records one run of `id`: moves it to the front of the recents and bumps its counter. */
export function recordUse(id: string): void {
  if (!id || id.length > MAX_ID_LENGTH) return;
  const next = [id, ...recentIds().filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
  next.forEach((entry, slot) => writePreference(RECENT_KEY(slot), entry));
  for (let slot = next.length; slot < RECENT_LIMIT; slot += 1) removePreference(RECENT_KEY(slot));
  writePreference(COUNT_KEY(id), String(Math.min(COUNT_CAP, usageCount(id) + 1)));
}

/**
 * The ranking nudge for a typed query. Logarithmic and capped on purpose: a handful of uses is
 * enough to break a tie between "Add Service" and "Add Actor" for `a`, and no number of uses ever
 * reaches `fuzzy.ts`'s prefix bonus — a command you use constantly still loses to the thing whose
 * name you just typed the start of.
 */
const FREQUENCY_BONUS_CAP = 2.5;

export function frequencyBonus(id: string): number {
  return Math.min(FREQUENCY_BONUS_CAP, Math.log2(1 + usageCount(id)));
}
