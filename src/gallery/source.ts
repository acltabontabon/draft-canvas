/**
 * Where the starters gallery lives. One public repository, read over HTTPS from GitHub's raw file
 * host — the only origin `remote.ts` may reach, and the only one the Content-Security-Policy adds
 * for it. Nothing is ever sent there but the request for a file.
 */

export const GALLERY_REPOSITORY = 'acltabontabon/draft-canvas-starters';

/** The browsable repository, for "View on GitHub" and a starter's "View source". */
export const GALLERY_PAGE = `https://github.com/${GALLERY_REPOSITORY}`;

/** Files are read from the default branch: a starter changed there reaches every app on refresh. */
export const GALLERY_ORIGIN = 'https://raw.githubusercontent.com';
export const GALLERY_BASE = `${GALLERY_ORIGIN}/${GALLERY_REPOSITORY}/main/`;

/** The highest `catalog.json` schema this app reads; a newer one asks for an app update. */
export const GALLERY_SCHEMA = 1;

export const MAX_CATALOG_BYTES = 64 * 1024;
export const MAX_STARTER_BYTES = 512 * 1024;
export const MAX_STARTERS = 200;

/** A gallery older than this is refreshed when it is next opened, if loading is on. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long one request may take before it counts as unreachable. */
export const REQUEST_TIMEOUT_MS = 15_000;
