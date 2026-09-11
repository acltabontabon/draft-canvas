import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same in-memory fake `tests/new-feature-badge.test.tsx` uses for the same module.
const store = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => store.get(key) ?? null,
  writePreference: (key: string, value: string) => void store.set(key, value),
}));

import { compareVersions, versionKind } from '../src/lib/semver';
import { PRODUCT } from '../src/product';
import {
  applicableReleases,
  groupReleasesByYear,
  hasUnreadRelease,
  markLastSeenRelease,
  readLastSeenRelease,
  type ProductRelease,
} from '../src/releases/productReleases';

const RELEASES: ProductRelease[] = [
  { version: '1.1.0', highlights: [{ title: 'A', description: 'a' }] },
  { version: '1.0.0', highlights: [{ title: 'B', description: 'b' }] },
  { version: '0.9.0', highlights: [{ title: 'C', description: 'c' }] },
];

describe('applicableReleases', () => {
  it('orders newest first regardless of input order', () => {
    const shuffled = [RELEASES[2]!, RELEASES[0]!, RELEASES[1]!];
    expect(applicableReleases('2.0.0', shuffled).map((r) => r.version)).toEqual(['1.1.0', '1.0.0', '0.9.0']);
  });

  it('excludes a release newer than the running app version — future metadata is never shown as installed', () => {
    expect(applicableReleases('1.0.0', RELEASES).map((r) => r.version)).toEqual(['1.0.0', '0.9.0']);
  });

  it('includes exactly the current version when nothing newer has shipped', () => {
    expect(applicableReleases('0.9.0', RELEASES).map((r) => r.version)).toEqual(['0.9.0']);
  });

  it('returns nothing when the running version predates every curated entry', () => {
    expect(applicableReleases('0.1.0', RELEASES)).toEqual([]);
  });

  it('the real PRODUCT_RELEASES catalog never presents 1.0.0 while running a pre-1.0 version', () => {
    const shown = applicableReleases('0.8.0');
    expect(shown.some((r) => r.version === '1.0.0')).toBe(false);
    expect(shown.some((r) => r.version === '0.8.0')).toBe(true);
  });

  it('the real PRODUCT_RELEASES catalog is strictly newest-first with no alpha/beta entries', () => {
    const versions = applicableReleases('0.8.0').map((r) => r.version);
    expect(versions[0]).toBe('0.8.0');
    expect(versions[versions.length - 1]).toBe('0.1.0');
    expect(versions.some((v) => v.includes('alpha') || v.includes('beta'))).toBe(false);
    for (let i = 1; i < versions.length; i += 1) {
      expect(compareVersions(versions[i - 1]!, versions[i]!)).toBeGreaterThan(0);
    }
  });
});

describe('hasUnreadRelease', () => {
  it('is false when there is nothing applicable yet', () => {
    expect(hasUnreadRelease('0.1.0', [])).toBe(false);
  });

  it('is true when the newest applicable release is newer than the last seen version', () => {
    const releases = applicableReleases('1.1.0', RELEASES);
    expect(hasUnreadRelease('1.0.0', releases)).toBe(true);
  });

  it('is false once the last seen version matches or exceeds the newest applicable release', () => {
    const releases = applicableReleases('1.1.0', RELEASES);
    expect(hasUnreadRelease('1.1.0', releases)).toBe(false);
    expect(hasUnreadRelease('2.0.0', releases)).toBe(false);
  });

  it('degrades a malformed stored value toward "unread" rather than hiding a real release', () => {
    const releases = applicableReleases('1.1.0', RELEASES);
    expect(hasUnreadRelease('not-a-version', releases)).toBe(true);
  });
});

describe('readLastSeenRelease / markLastSeenRelease', () => {
  beforeEach(() => {
    store.clear();
  });

  it('a first-time read (no stored value) resolves to the current version, not "everything unseen"', () => {
    const seen = readLastSeenRelease();
    expect(seen).toBe(PRODUCT.version);
    // First read for a fresh install shows nothing unread for the current version's own notes.
    expect(hasUnreadRelease(seen, applicableReleases(PRODUCT.version))).toBe(false);
  });

  it('persists that first-time resolution so a later read agrees', () => {
    readLastSeenRelease();
    expect(store.get('last-seen-product-release')).toBe(PRODUCT.version);
  });

  it('an existing installation keeps its stored baseline', () => {
    store.set('last-seen-product-release', '0.1.0');
    expect(readLastSeenRelease()).toBe('0.1.0');
  });

  it('marking a release seen updates the stored preference, and it survives a later read ("reload")', () => {
    store.set('last-seen-product-release', '0.1.0');
    markLastSeenRelease('1.0.0');
    expect(readLastSeenRelease()).toBe('1.0.0');
  });

  it('marking with no argument defaults to the running app version', () => {
    markLastSeenRelease();
    expect(store.get('last-seen-product-release')).toBe(PRODUCT.version);
  });
});

/**
 * Scale check: Release History must stay a plain, dense index at 40+ releases spanning several
 * years — no accordion, no per-row body work, correct grouping and ordering regardless of size.
 * See `whats-new-view.test.tsx` for the corresponding "stays compact" assertions in the UI.
 */
describe('scaling to a long release history', () => {
  const LARGE: ProductRelease[] = [];
  for (let major = 0; major <= 2; major += 1) {
    for (let minor = 0; minor <= 7; minor += 1) {
      const month = String(1 + ((major * 8 + minor) % 12)).padStart(2, '0');
      LARGE.push({
        version: `${major}.${minor}.0`,
        date: `202${4 + major}-${month}-01`,
        highlights: [{ title: `Release ${major}.${minor}.0`, description: 'A synthetic fixture release.' }],
      });
    }
  }
  // 24 minor releases plus a couple of patches thrown in, unsorted on purpose.
  LARGE.push({ version: '1.3.1', date: '2025-05-02', highlights: [{ title: 'Fixed a synthetic bug.' }] });
  LARGE.push({ version: '2.0.1', date: '2026-01-02', highlights: [{ title: 'Fixed another synthetic bug.' }] });
  const SHUFFLED = [...LARGE].sort(() => Math.random() - 0.5);

  it('sorts 26 releases across 3 years correctly regardless of input order', () => {
    const shown = applicableReleases('2.7.0', SHUFFLED);
    expect(shown).toHaveLength(LARGE.length);
    for (let i = 1; i < shown.length; i += 1) {
      expect(compareVersions(shown[i - 1]!.version, shown[i]!.version)).toBeGreaterThan(0);
    }
  });

  it('still correctly excludes everything newer than the running version at scale', () => {
    const shown = applicableReleases('1.4.0', SHUFFLED);
    expect(shown.every((release) => compareVersions(release.version, '1.4.0') <= 0)).toBe(true);
    expect(shown.some((release) => release.version === '2.0.0')).toBe(false);
    expect(shown.some((release) => release.version === '1.4.0')).toBe(true);
  });

  it('groups a multi-year history by year, newest year first, with every release accounted for', () => {
    const sorted = applicableReleases('2.7.0', LARGE);
    const groups = groupReleasesByYear(sorted);
    expect(groups.length).toBeGreaterThan(1); // multiple distinct years — headings are warranted
    expect(groups.reduce((total, group) => total + group.releases.length, 0)).toBe(sorted.length);
    const years = groups.map((group) => group.year);
    expect(years).toEqual([...years].sort().reverse());
    // Every release in a group actually belongs to that year.
    for (const group of groups) {
      for (const release of group.releases) expect(release.date?.slice(0, 4)).toBe(group.year);
    }
  });

  it('derives major/minor/patch purely from the version number, with no stored field needed', () => {
    expect(versionKind('2.0.0')).toBe('major');
    expect(versionKind('2.1.0')).toBe('minor');
    expect(versionKind('2.1.3')).toBe('patch');
    expect(versionKind('0.8.0')).toBe('minor'); // pre-1.0: a 0.x.0 reads as this line's "big" release
  });
});
