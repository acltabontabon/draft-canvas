import { readPreference, writePreference } from '../lib/preferences';
import { isVersionNewer } from '../lib/semver';
import { PRODUCT } from '../product';
import type { ProductRelease } from './types';

/*
 * What this device has acknowledged of the release notes — everything about them but the notes.
 * Kept apart from `productReleases.ts` so the Library's first paint (and `uiStore`) doesn't carry
 * every release's copy just to decide whether a dot is showing; that module re-exports all of this.
 */

/**
 * Whether there's a curated release newer than the last one this device acknowledged. `releases`
 * is expected to already be `applicableReleases`'s output (newest first) — an empty list (nothing
 * curated yet for this version) is never unread. An unparseable `lastSeen` degrades to "treat as
 * unseen" via `compareVersions`, rather than silently hiding a real release.
 */
export function hasUnreadRelease(lastSeen: string, releases: ProductRelease[]): boolean {
  const latest = releases[0];
  return latest !== undefined && isVersionNewer(latest.version, lastSeen);
}

const LAST_SEEN_RELEASE_PREFERENCE = 'last-seen-product-release';

/**
 * The version whose product release notes (About → What's New) this device has already
 * acknowledged. A stored value is trusted as-is; its absence means "never asked before" — which
 * covers both a brand-new install and an existing install meeting this feature for the first
 * time — and is resolved immediately to the *current* version, not left unset. That way nobody
 * ever sees every past release retroactively flagged unread; only an actual upgrade past this
 * point can produce a newer "latest" than what's stored. A preference store that isn't usable
 * right now (blocked storage, a test harness still wiring up) falls back to the same quiet
 * default: nothing unread.
 */
export function readLastSeenRelease(): string {
  try {
    const stored = readPreference(LAST_SEEN_RELEASE_PREFERENCE);
    if (stored !== null) return stored;
    writePreference(LAST_SEEN_RELEASE_PREFERENCE, PRODUCT.version);
    return PRODUCT.version;
  } catch {
    return PRODUCT.version;
  }
}

/** Records that this device has now seen the given version's release notes — defaults to the
 *  running app version, which is what About → What's New actually calls this with. */
export function markLastSeenRelease(version: string = PRODUCT.version): void {
  writePreference(LAST_SEEN_RELEASE_PREFERENCE, version);
}
