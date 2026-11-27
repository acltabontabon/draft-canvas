import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentStyle } from '../src/document/style';

/**
 * A starter's preview is drawn by the exporter in the style the starter will land in: the canvas's
 * own when "Add to canvas" is what the dialog offers first, the style a new diagram is given when it
 * is "Open as new diagram". It was once always built-in Clean, whatever either would be.
 */
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));
vi.mock('../src/export/image', () => ({ renderSvgText: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') }));
vi.mock('../src/gallery', async (importOriginal) => {
  const { createDocument, createNode } = await import('../src/document/factory');
  // A starter that carries a style of its own: it is never kept, by either way in.
  const file = { ...createDocument('Saga'), nodes: [createNode({ id: 'orders', type: 'service', x: 0, y: 0, text: 'Orders' })], style: { v: 1, hand: { base: 'sketch' } } };
  return { ...(await importOriginal<typeof import('../src/gallery')>()), starterFile: vi.fn(async () => file) };
});

const { createDocument, createNode } = await import('../src/document/factory');
const { renderSvgText } = await import('../src/export/image');
const { schemesForCanvas } = await import('../src/render/style/palettes');
const { resolveStyle } = await import('../src/render/style/resolve');
const { useEditorStore } = await import('../src/store/editorStore');
const { useGalleryStore } = await import('../src/store/galleryStore');
const { useStyleStore } = await import('../src/store/styleStore');
const { useUiStore } = await import('../src/store/uiStore');
const { StartersDialog } = await import('../src/ui/Gallery/StartersDialog');
const { PersonalityProvider } = await import('../src/ui/personality/PersonalityProvider');
const { ThemeProvider } = await import('../src/ui/theme/ThemeProvider');

// jsdom has no object URLs; the preview only hands one to an image.
URL.createObjectURL = () => 'blob:preview';
URL.revokeObjectURL = () => {};

const MINE: DocumentStyle = { v: 1, name: 'Midnight', hand: { base: 'draft' }, schemes: schemesForCanvas('#10162b') };
const THEIRS: DocumentStyle = { v: 1, name: 'Paper', hand: { base: 'clean' }, general: { weight: 'bold' } };

const starter = {
  id: 'saga', name: 'Saga', category: 'pattern' as const, summary: 'Steps that undo themselves.', aliases: [], tags: [], useWhen: [], watchOutFor: [],
  featured: false, order: 1, path: 'starters/patterns/saga.draftcanvas', sha256: 'a'.repeat(64), bytes: 100, formatVersion: 1, updated: '2026-11-01', availability: 'ready' as const,
};

function open(canvas: { empty: boolean }) {
  const nodes = canvas.empty ? [] : [createNode({ id: 'drawn', type: 'service', x: 0, y: 0, text: 'Billing' })];
  useEditorStore.setState({ document: { ...createDocument('Open'), nodes, style: THEIRS }, path: [], outer: null, selection: { nodes: [], edges: [] } });
  useGalleryStore.setState({ enabled: true, snapshot: { starters: [starter], styles: [], fetchedAt: Date.now() }, dialog: { open: true, focus: starter.id } });
  return render(
    <ThemeProvider>
      <PersonalityProvider>
        <StartersDialog onAdd={() => {}} />
      </PersonalityProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  prefs.clear();
  vi.mocked(renderSvgText).mockClear();
  useUiStore.setState({ readOnly: undefined });
  useStyleStore.setState({ profiles: [{ id: 'pmidnight01', name: 'Midnight', style: MINE, updatedAt: 0 }], activeId: 'pmidnight01' });
});

describe('a starter’s preview', () => {
  it('is drawn in the style a new diagram is given when it opens as one', async () => {
    const { container } = open({ empty: false });
    await waitFor(() => expect(renderSvgText).toHaveBeenCalled());
    expect(vi.mocked(renderSvgText).mock.lastCall![1]).toMatchObject({ style: resolveStyle(MINE) });
    // On that style's own canvas, so a dark style's pale words are not drawn on the dialog's paper.
    await waitFor(() => expect((container.ownerDocument.querySelector('.dc-starters-preview') as HTMLElement).style.backgroundColor).toBe('rgb(16, 22, 43)'));
  });

  it('is drawn in the canvas’s own style when it is added to it', async () => {
    const { container } = open({ empty: true });
    await waitFor(() => expect(renderSvgText).toHaveBeenCalled());
    expect(vi.mocked(renderSvgText).mock.lastCall![1]).toMatchObject({ style: resolveStyle(THEIRS) });
    // A style with no colours of its own is drawn on the dialog's own paper, as before.
    expect((container.ownerDocument.querySelector('.dc-starters-preview') as HTMLElement).style.backgroundColor).toBe('');
  });
});
