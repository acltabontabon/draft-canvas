import { describe, expect, it, vi } from 'vitest';
import { isStaleChunkError, loadFailureNotice } from '../src/lib/staleChunk';

vi.mock('../src/storage/autosave', () => ({ flushAllAutosaves: () => Promise.resolve(true) }));

/**
 * A panel that won't open has two quite different causes, and only one of them has a cure the
 * person can apply. A deploy removes the previous build's content-hashed chunks, so a page left
 * open across one asks for a file that is now a 404 — and `retryableLazy` cannot help, because
 * trying the same dead URL again is all it can do. Reloading is the only fix, and a webview that
 * is deliberately kept alive (Draft Canvas for VS Code) never reloads on its own.
 */
describe('isStaleChunkError', () => {
  it('recognises how each engine words a dynamic import that did not arrive', () => {
    // Chrome and Vite, Safari, Firefox, and bundler runtimes, in that order.
    for (const message of [
      'Failed to fetch dynamically imported module: https://example.test/assets/AboutDialog-abc123.js',
      'Importing a module script failed.',
      'error loading dynamically imported module',
      'ChunkLoadError: Loading chunk 42 failed.',
    ]) {
      expect(isStaleChunkError(new Error(message))).toBe(true);
    }
  });

  it('does not claim a component that threw while rendering', () => {
    // `PanelBoundary` catches both, so mistaking one for the other would offer a reload that
    // cannot possibly help — and send someone round a loop on a real bug.
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isStaleChunkError(new Error('Network request failed'))).toBe(false);
    expect(isStaleChunkError('something else entirely')).toBe(false);
  });
});

describe('loadFailureNotice', () => {
  it('offers the reload only a stale page can use', () => {
    const stale = loadFailureNotice(new Error('Failed to fetch dynamically imported module: x.js'), 'offline copy');
    expect(stale.message).toContain('updated');
    expect(stale.action?.label).toBe('Reload');
  });

  it('keeps the caller’s own wording, and no action, for anything else', () => {
    const other = loadFailureNotice(new Error('boom'), 'About couldn’t open. Check your connection and try again.');
    expect(other.message).toBe('About couldn’t open. Check your connection and try again.');
    expect(other.action).toBeUndefined();
  });
});
