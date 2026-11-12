/**
 * The starters gallery: ready-made diagrams kept in a public repository
 * (github.com/acltabontabon/draft-canvas-starters) instead of in the app, so they improve without a
 * release. Off until the person chooses to load it; then read from GitHub, kept in IndexedDB, and
 * refreshed on request or when a day old. Imports only `document/`, like `starters/`.
 */

export { GALLERY_CATEGORIES, matchesQuery, type GalleryCategory, type GalleryEntry } from './catalog';
export { canvasFromFile, canvasFromStarter } from './canvas';
export { EXAMPLE_TITLE, exampleCanvas, exampleFileDocument } from './example';
export { clearGalleryCache, readDismissed, writeDismissed } from './cache';
export { GALLERY_PAGE, STALE_AFTER_MS } from './source';
export {
  GalleryRefreshError,
  loadGallery,
  markStarterSeen,
  refreshGallery,
  starterFile,
  type GalleryAvailability,
  type GalleryMark,
  type GallerySnapshot,
  type GalleryStarter,
  type RefreshFailure,
} from './sync';
