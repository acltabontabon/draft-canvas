import type { CommandOption } from './types';

/**
 * A small, dependency-free fuzzy matcher — the whole of what `⌘K` needs. Every query character
 * must appear in order; what varies is how much each hit is worth. Word starts and runs of
 * consecutive characters score high, so "db" lands on **D**ata **B**ase-ish keywords and "conn"
 * lands on **Conn**ect before anything that merely contains those letters somewhere. Deliberately
 * not a library: `tests/privacy.test.ts` keeps the dependency list short on purpose, and a
 * command list of a few dozen entries never needs more than this.
 */
export interface FuzzyMatch {
  score: number;
  /** Indices into the matched text, for highlighting. */
  indices: number[];
}

const WORD_START = 3;
const CONSECUTIVE = 2;
const PLAIN = 1;
/**
 * Typing the start of a name is the strongest signal a query carries — "spot" means Spotlight,
 * "data sto" means the node called Data Store — so a prefix hit outweighs both a keyword hit and
 * the largest frequency nudge history can add (see `history.ts`).
 */
const PREFIX_BONUS = 4;
const GAP_PENALTY = 0.5;
const MAX_GAP_PENALTY = 3;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1]!;
  return prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '…' || prev === '.';
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let prev = -1;

  for (const char of q) {
    if (char === ' ') continue;
    // Best candidate, in order: continue the current run; a fresh word start; anything.
    let at = -1;
    if (prev >= 0 && t[prev + 1] === char) {
      at = prev + 1;
      score += CONSECUTIVE + (isWordStart(t, at) ? WORD_START : 0);
    } else {
      let wordStart = -1;
      for (let i = cursor; i < t.length; i += 1) {
        if (t[i] === char && isWordStart(t, i)) {
          wordStart = i;
          break;
        }
      }
      if (wordStart >= 0) {
        at = wordStart;
        score += WORD_START;
      } else {
        at = t.indexOf(char, cursor);
        if (at < 0) return null;
        score += PLAIN;
      }
      if (prev >= 0) score -= Math.min(MAX_GAP_PENALTY, (at - prev - 1) * GAP_PENALTY);
    }
    indices.push(at);
    prev = at;
    cursor = at + 1;
  }

  if (indices.length === 0) return { score: 0, indices };
  if (indices[0] === 0) score += PREFIX_BONUS;
  // A shorter candidate wins a tie: "Add Note" over "Add Note to connector".
  score -= t.length * 0.01;
  return { score, indices };
}

export interface RankedEntry<T extends CommandOption> {
  entry: T;
  score: number;
  /** Highlight positions in `entry.title` — empty when the hit came from a keyword. */
  indices: number[];
}

/** A keyword hit is a good hit, but a title hit should win a tie. */
const KEYWORD_PENALTY = 2;

function scoreEntry<T extends CommandOption>(query: string, entry: T): RankedEntry<T> | null {
  const title = fuzzyMatch(query, entry.title);
  let best: RankedEntry<T> | null = title ? { entry, score: title.score, indices: title.indices } : null;
  for (const keyword of entry.keywords ?? []) {
    const match = fuzzyMatch(query, keyword);
    if (!match) continue;
    const score = match.score - KEYWORD_PENALTY;
    if (!best || score > best.score) best = { entry, score, indices: [] };
  }
  return best;
}

/**
 * Orders `entries` for a query. An empty query keeps the caller's order (the registry's grouped
 * order) and matches everything; otherwise entries that don't match are dropped and the rest are
 * sorted by score, stable, so registry order still breaks ties.
 */
export function rank<T extends CommandOption>(
  query: string,
  entries: T[],
  bonus: (entry: T) => number = () => 0,
): RankedEntry<T>[] {
  if (!query.trim()) return entries.map((entry) => ({ entry, score: 0, indices: [] }));
  const ranked: RankedEntry<T>[] = [];
  for (const entry of entries) {
    const scored = scoreEntry(query, entry);
    if (scored) ranked.push({ ...scored, score: scored.score + bonus(entry) });
  }
  return ranked.sort((a, b) => b.score - a.score);
}
