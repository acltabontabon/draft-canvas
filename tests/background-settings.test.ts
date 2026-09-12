import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { parseDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';

const base = { format: DRAFT_FORMAT, version: CURRENT_VERSION };

function parse(payload: unknown) {
  return parseDocument(JSON.stringify(payload));
}

/**
 * Phase 5.1 — `DraftSettings.background` holds only presentation knobs; the
 * image bytes live in a separate IndexedDB store (see `storage.test.ts`).
 * This covers normalization: defaults, clamping, and rejecting an invalid
 * `fit` — the same repair-don't-reject discipline `grid`/`showSequence` use.
 */
describe('background settings normalization', () => {
  it('defaults to a disabled, clean background when the field is absent entirely', () => {
    const result = parse({ ...base, nodes: [], edges: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.settings.background).toEqual({
      enabled: false,
      fit: 'cover',
      dim: 0.55,
      blur: 0,
    });
    expect(result.repairs).toEqual([]);
  });

  it('preserves a fully-specified background verbatim', () => {
    const result = parse({
      ...base,
      nodes: [],
      edges: [],
      settings: {
        showSequence: true,
        grid: 'dots',
        background: { enabled: true, fit: 'tile', dim: 0.2, blur: 0.5, imageId: 'bg_1' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.settings.background).toEqual({
      enabled: true,
      fit: 'tile',
      dim: 0.2,
      blur: 0.5,
      imageId: 'bg_1',
    });
  });

  it('clamps an out-of-range dim or blur instead of rejecting the document', () => {
    const result = parse({
      ...base,
      nodes: [],
      edges: [],
      settings: { background: { enabled: true, dim: 4, blur: -1 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.settings.background.dim).toBe(1);
    expect(result.document.settings.background.blur).toBe(0);
  });

  it('falls back to "cover" for an invalid fit rather than coercing garbage through', () => {
    const result = parse({
      ...base,
      nodes: [],
      edges: [],
      settings: { background: { enabled: true, fit: 'not-a-real-fit' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.settings.background.fit).toBe('cover');
  });
});

describe('background image changes through the store', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({ document: createDocument('Background'), history: { past: [], future: [] }, revision: 0 });
  });

  it('undoing a replace brings back the previous image, and undoing a remove brings it back on', () => {
    const settings = () => useEditorStore.getState().document.settings.background;
    useEditorStore.getState().updateSettings({ background: { ...settings(), enabled: true, imageId: 'bg_a' } });
    useEditorStore.getState().updateSettings({ background: { ...settings(), enabled: true, imageId: 'bg_b' } });
    useEditorStore.getState().updateSettings({ background: { ...settings(), enabled: false } });

    useEditorStore.getState().undo();
    expect(settings()).toMatchObject({ enabled: true, imageId: 'bg_b' });
    useEditorStore.getState().undo();
    expect(settings()).toMatchObject({ enabled: true, imageId: 'bg_a' });
  });
});
