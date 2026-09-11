/**
 * One curated line about a single capability — a product highlight, not a changelog bullet.
 * `description` is optional so a small patch release can list a few compact, title-only fixes
 * instead of forcing marketing-length prose onto something that doesn't warrant it.
 */
export interface ProductReleaseHighlight {
  title: string;
  description?: string;
}

/**
 * One release's curated, user-facing notes. Deliberately separate from CHANGELOG.md (see
 * CONTRIBUTING.md's "Release workflow") — a release with nothing worth telling a user simply has
 * no entry here.
 */
export interface ProductRelease {
  version: string;
  /** ISO date it actually shipped. Omitted for a release prepared ahead of time — see
   *  `productReleases.ts` — so nothing here implies it has happened yet. */
  date?: string;
  summary?: string;
  highlights: ProductReleaseHighlight[];
}
