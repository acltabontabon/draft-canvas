import { useCallback, useEffect, useState } from 'react';
import { readPreference, writePreference } from '../lib/preferences';
import { compareVersions } from '../lib/semver';
import { PRODUCT } from '../product';
import { NEW_FEATURES } from './newFeatures';

const LAST_SEEN_KEY = 'last-seen-version';

/**
 * The version this device last had open *before this page load* — read once and remembered for the
 * whole session. A per-mount read would already see this session's own write: the toolbar remounts
 * every time a canvas opens, so the badge vanished on the second open without ever being dismissed.
 */
let sessionBaseline: string | null | undefined;

function baselineForSession(): string | null {
  if (sessionBaseline === undefined) sessionBaseline = readPreference(LAST_SEEN_KEY);
  return sessionBaseline;
}

/** Test seam: start a fresh "page load". */
export function __resetNewFeatureSessionForTests(): void {
  sessionBaseline = undefined;
}

/**
 * A small "New" indicator for a capability too minor to earn its own coachmark. A brand-new install
 * (no stored `last-seen-version` at all) has no "old" baseline to compare against, so nothing is
 * ever new on a first run — only a returning device, whose last-seen version predates the catalog
 * entry's `sinceVersion`, sees the dot. Mounting records the current version for the *next* page
 * load; this one keeps comparing against what the device had before it.
 */
export function useIsNewFeature(id: string): { isNew: boolean; retire: () => void } {
  const [baseline] = useState(baselineForSession);
  const [dismissed, setDismissed] = useState(() => readPreference(`feature-seen.${id}`) === '1');

  useEffect(() => {
    baselineForSession(); // captured before this session's own write can shadow it
    writePreference(LAST_SEEN_KEY, PRODUCT.version);
  }, []);

  const feature = NEW_FEATURES.find((f) => f.id === id);
  const isNew = Boolean(feature && baseline !== null && compareVersions(baseline, feature.sinceVersion) < 0 && !dismissed);

  const retire = useCallback(() => {
    writePreference(`feature-seen.${id}`, '1');
    setDismissed(true);
  }, [id]);

  return { isNew, retire };
}
