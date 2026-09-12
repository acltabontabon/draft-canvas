/**
 * The starter catalog on demand. It is pure data, most of it only ever read by an empty home screen
 * or the moment a starter is created — so it arrives as its own chunk rather than with every visit
 * (the offline Service Worker precaches it either way). Resolves to the whole `starters` module.
 */
export type StartersModule = typeof import('./index');

let loaded: StartersModule | null = null;
let pending: Promise<StartersModule> | null = null;

export function loadStarters(): Promise<StartersModule> {
  pending ??= import('./index').then((module) => (loaded = module));
  return pending;
}

/** The module if it has already arrived, for a first render that needn't wait a tick. */
export function loadedStarters(): StartersModule | null {
  return loaded;
}
