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
 * One release's user-facing notes: its summary and the few highlights worth telling someone using
 * the app. From 1.10.0 these are read out of CHANGELOG.md (see CONTRIBUTING.md's "Release notes");
 * a release that marked no highlights simply has no entry.
 */
export interface ProductRelease {
  version: string;
  /** ISO date it shipped. Omitted for a version whose changelog section isn't dated yet, so nothing
   *  here implies it has happened. */
  date?: string;
  summary?: string;
  highlights: ProductReleaseHighlight[];
  /** Its full section of CHANGELOG.md, pinned to the release's own tag. */
  changelogUrl?: string;
}
