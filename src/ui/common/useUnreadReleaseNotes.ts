import { useEffect, useState } from 'react';
import { logDiagnostic } from '../../lib/diagnostics';
import { isVersionNewer } from '../../lib/semver';
import { PRODUCT } from '../../product';
import { hasUnreadRelease } from '../../releases/seen';
import type { ProductRelease } from '../../releases/types';
import { useUiStore } from '../../store/uiStore';

let loaded: ProductRelease[] | null = null;

/**
 * Whether there are release notes this device hasn't seen — for the Library's About dot, without
 * putting every release's copy in the Library's first chunk.
 *
 * Nothing can be unread unless the app has moved past the version last acknowledged, which is the
 * one time the notes are fetched (the About dialog shares that chunk). Until they arrive the dot is
 * simply not there yet — and offline, the Service Worker has them precached anyway.
 */
export function useUnreadReleaseNotes(): boolean {
  const lastSeen = useUiStore((state) => state.lastSeenProductRelease);
  const upgraded = isVersionNewer(PRODUCT.version, lastSeen);
  const [releases, setReleases] = useState(loaded);

  useEffect(() => {
    if (!upgraded || releases) return;
    let live = true;
    import('../../releases/productReleases')
      .then((module) => {
        loaded = module.applicableReleases(PRODUCT.version);
        if (live) setReleases(loaded);
      })
      .catch((error: unknown) => logDiagnostic(error, { operation: 'release-notes' }));
    return () => {
      live = false;
    };
  }, [upgraded, releases]);

  return upgraded && releases !== null && hasUnreadRelease(lastSeen, releases);
}
