import { useCallback, useEffect, useState } from 'react';
import { readPreference, writePreference } from '../lib/preferences';
import { PRODUCT } from '../product';
import { NEW_FEATURES } from './newFeatures';

const LAST_SEEN_KEY = 'last-seen-version';

/**
 * A simple, "good enough for this project's sequential `alpha.N` releases" ordering — not a full
 * semver comparator. Splits on `.`/`-` and compares part by part, numerically where both sides
 * are numeric. Good enough to tell `0.1.0-alpha.3` apart from `0.1.0-alpha.4`; not a guarantee for
 * every possible prerelease-vs-release edge case, which this small internal catalog never needs.
 */
function isOlderVersion(a: string, b: string): boolean {
  const partsOf = (v: string) => v.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const partsA = partsOf(a);
  const partsB = partsOf(b);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === y) continue;
    if (x === undefined) return true;
    if (y === undefined) return false;
    if (typeof x === 'number' && typeof y === 'number') return x < y;
    return String(x) < String(y);
  }
  return false;
}

/**
 * Phase 7.3 — a small "New" indicator for a capability too minor to earn its own coachmark. A
 * brand-new install (no stored `last-seen-version` at all) has no "old" baseline to compare
 * against, so nothing is ever new on a first run — only a returning device, whose last-seen
 * version predates the catalog entry's `sinceVersion`, sees the dot. Every mount refreshes the
 * stored version to the current one, so the comparison is only ever against what this device had
 * *before* the current session.
 */
export function useIsNewFeature(id: string): { isNew: boolean; retire: () => void } {
  const [baseline] = useState(() => readPreference(LAST_SEEN_KEY));
  const [dismissed, setDismissed] = useState(() => readPreference(`feature-seen.${id}`) === '1');

  useEffect(() => {
    writePreference(LAST_SEEN_KEY, PRODUCT.version);
    // Runs once per mount, deliberately: this is "what version did this device last have open
    // *before now*," not something that should chase `PRODUCT.version` again mid-session.
  }, []);

  const feature = NEW_FEATURES.find((f) => f.id === id);
  const isNew = Boolean(feature && baseline !== null && isOlderVersion(baseline, feature.sinceVersion) && !dismissed);

  const retire = useCallback(() => {
    writePreference(`feature-seen.${id}`, '1');
    setDismissed(true);
  }, [id]);

  return { isNew, retire };
}
