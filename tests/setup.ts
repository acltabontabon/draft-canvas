import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { StaticTextMeasurer, setMeasurer } from '../src/render/text/measure';
import { clearLayoutCache } from '../src/render/text/layout';
import { clearHighlightCache } from '../src/render/code/highlight';

/**
 * jsdom has no canvas, so text measurement would silently fall back at import
 * time and vary between runs. Pinning the deterministic measurer makes layout
 * assertions exact.
 */
setMeasurer(new StaticTextMeasurer());

beforeEach(() => {
  clearLayoutCache();
  clearHighlightCache();
});
