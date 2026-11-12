import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { libraryShapeOf } from '../src/document/shape';
import type { GalleryStarter } from '../src/gallery';
import { useGalleryStore } from '../src/store/galleryStore';
import { useUiStore } from '../src/store/uiStore';
import { ARCHITECTURE_STARTERS, PRIMARY_STARTERS, buildStarter } from './fixtures/starters-v1';
import { EmptyState } from '../src/ui/Editor/EmptyState';
import { useEditorStore } from '../src/store/editorStore';

/**
 * The blank canvas is the one place a starter is offered without being searched for, so the bar is
 * that it stays out of the way: it offers a curated few rather than the catalogue, it disappears
 * the moment anything exists, it never appears while presenting, and every part of it is reachable
 * from the keyboard for anyone who doesn't use a mouse.
 */

/** The downloaded gallery, as the store holds it: every starter, five of them featured. */
const GALLERY: GalleryStarter[] = ARCHITECTURE_STARTERS.map((starter, order) => {
  const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
  return {
    id: starter.id,
    name: starter.name,
    category: starter.category,
    summary: starter.description,
    aliases: [],
    tags: [],
    useWhen: [],
    watchOutFor: [],
    featured: PRIMARY_STARTERS.includes(starter),
    order,
    path: `starters/x/${starter.id}/${starter.id}.draftcanvas`,
    sha256: String(order).padStart(64, '0'),
    bytes: 1,
    formatVersion: 1,
    updated: '2026-11-12',
    availability: 'ready',
    shape: libraryShapeOf(nodes, edges),
  };
});

beforeEach(() => {
  useEditorStore.setState({ document: createDocument('Empty'), mode: 'edit' });
  useGalleryStore.setState({ enabled: true, snapshot: { starters: GALLERY, fetchedAt: Date.now() }, failure: null, status: 'idle', dialog: { open: false } });
});

const renderEmpty = (onAddStarter = vi.fn()) => ({
  onAddStarter,
  ...render(<EmptyState onAddStarter={onAddStarter} />),
});

const firstFeatured = PRIMARY_STARTERS[0]!;

describe('EmptyState', () => {
  it('offers a curated few starters, not the catalogue', () => {
    renderEmpty();
    const group = screen.getByRole('group', { name: 'Suggested starters' });
    expect(within(group).getAllByRole('button')).toHaveLength(PRIMARY_STARTERS.length);
    for (const starter of PRIMARY_STARTERS) {
      expect(within(group).getByRole('button', { name: `Start from ${starter.name}` })).toBeInTheDocument();
    }
    // The point of curating: the rest are reachable, but not offered here.
    const withheld = ARCHITECTURE_STARTERS.filter((s) => !PRIMARY_STARTERS.includes(s));
    expect(withheld.length).toBeGreaterThan(0);
    for (const starter of withheld) {
      expect(screen.queryByRole('button', { name: `Start from ${starter.name}` })).not.toBeInTheDocument();
    }
  });

  it('inserts the starter it draws', async () => {
    const { onAddStarter } = renderEmpty();
    await userEvent.click(screen.getByRole('button', { name: `Start from ${firstFeatured.name}` }));
    expect(onAddStarter).toHaveBeenCalledWith(firstFeatured.id);
  });

  it('is reachable without a mouse, starters first', async () => {
    const { onAddStarter } = renderEmpty();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: `Start from ${firstFeatured.name}` })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onAddStarter).toHaveBeenCalledWith(firstFeatured.id);
  });

  it('vanishes as soon as the canvas has anything on it', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderEmpty();
      const name = `Start from ${firstFeatured.name}`;
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
      act(() => {
        useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
      });
      rerender(<EmptyState onAddStarter={vi.fn()} />);
      // It lingers for one fade — but stops taking clicks on the very render content appeared.
      expect(document.querySelector('.dc-empty')).toHaveAttribute('data-leaving', 'true');
      act(() => void vi.runAllTimers());
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('before the gallery is loaded, offers it in one card and nothing else', async () => {
    useGalleryStore.setState({ enabled: false, snapshot: null });
    const { onAddStarter } = renderEmpty();
    expect(screen.queryByRole('group', { name: 'Suggested starters' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Browse the starters gallery/ }));
    expect(useGalleryStore.getState().dialog.open).toBe(true);
    expect(onAddStarter).not.toHaveBeenCalled();
  });

  it('offers the bundled example whether or not the gallery is loaded', async () => {
    useGalleryStore.setState({ enabled: false, snapshot: null });
    useUiStore.setState({ newCanvasRequest: null });
    renderEmpty();
    await userEvent.click(screen.getByRole('button', { name: 'Try an example' }));
    expect(useUiStore.getState().newCanvasRequest).toEqual({ kind: 'example' });
  });

  it('stays away during a presentation', () => {
    useEditorStore.setState({ mode: 'present' });
    renderEmpty();
    expect(screen.queryByRole('group', { name: 'Suggested starters' })).not.toBeInTheDocument();
  });

  it('keeps the surrounding copy decorative, so nothing but the controls is announced', () => {
    const { container } = renderEmpty();
    const paragraphs = [...container.querySelectorAll('p')];
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const paragraph of paragraphs) {
      expect(paragraph.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });
});
