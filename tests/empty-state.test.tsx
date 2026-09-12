import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { ARCHITECTURE_STARTERS, FEATURED_STARTERS } from '../src/starters';
import { EmptyState } from '../src/ui/Editor/EmptyState';
import { useEditorStore } from '../src/store/editorStore';

/**
 * The blank canvas is the one place a starter is offered without being searched for, so the bar is
 * that it stays out of the way: it offers a curated few rather than the catalogue, it disappears
 * the moment anything exists, it never appears while presenting, and every part of it is reachable
 * from the keyboard for anyone who doesn't use a mouse.
 */

beforeEach(() => {
  useEditorStore.setState({ document: createDocument('Empty'), mode: 'edit' });
});

const renderEmpty = (onInsertStarter = vi.fn()) => ({
  onInsertStarter,
  ...render(<EmptyState onInsertStarter={onInsertStarter} />),
});

const firstFeatured = FEATURED_STARTERS[0]!;

describe('EmptyState', () => {
  it('offers a curated few starters, not the catalogue', () => {
    renderEmpty();
    const group = screen.getByRole('group', { name: 'Suggested starters' });
    expect(within(group).getAllByRole('button')).toHaveLength(FEATURED_STARTERS.length);
    for (const starter of FEATURED_STARTERS) {
      expect(within(group).getByRole('button', { name: `Start from ${starter.name}` })).toBeInTheDocument();
    }
    // The point of curating: the rest are reachable, but not offered here.
    const withheld = ARCHITECTURE_STARTERS.filter((s) => !FEATURED_STARTERS.includes(s));
    expect(withheld.length).toBeGreaterThan(0);
    for (const starter of withheld) {
      expect(screen.queryByRole('button', { name: `Start from ${starter.name}` })).not.toBeInTheDocument();
    }
  });

  it('inserts the starter it draws', async () => {
    const { onInsertStarter } = renderEmpty();
    await userEvent.click(screen.getByRole('button', { name: `Start from ${firstFeatured.name}` }));
    expect(onInsertStarter).toHaveBeenCalledWith(firstFeatured.id);
  });

  it('is reachable without a mouse, starters first', async () => {
    const { onInsertStarter } = renderEmpty();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: `Start from ${firstFeatured.name}` })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onInsertStarter).toHaveBeenCalledWith(firstFeatured.id);
  });

  it('opens the full shelf behind "Browse all starters", and inserts from it', async () => {
    const { onInsertStarter } = renderEmpty();
    await userEvent.click(screen.getByRole('button', { name: 'Browse all starters' }));
    const dialog = screen.getByRole('dialog');
    for (const starter of ARCHITECTURE_STARTERS) {
      expect(within(dialog).getByRole('button', { name: `Start from ${starter.name}` })).toBeInTheDocument();
    }
    // Something the blank canvas itself does not offer — the reason the link exists.
    const withheld = ARCHITECTURE_STARTERS.find((s) => !FEATURED_STARTERS.includes(s))!;
    await userEvent.click(within(dialog).getByRole('button', { name: `Start from ${withheld.name}` }));
    expect(onInsertStarter).toHaveBeenCalledWith(withheld.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
      rerender(<EmptyState onInsertStarter={vi.fn()} />);
      // It lingers for one fade — but stops taking clicks on the very render content appeared.
      expect(document.querySelector('.dc-empty')).toHaveAttribute('data-leaving', 'true');
      act(() => void vi.runAllTimers());
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays its arrival once, and not again when a canvas is emptied', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderEmpty();
      expect(document.querySelector('.dc-empty')).toHaveAttribute('data-intro', 'true');
      act(() => {
        useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
      });
      rerender(<EmptyState onInsertStarter={vi.fn()} />);
      act(() => void vi.runAllTimers());
      act(() => {
        useEditorStore.setState({ document: createDocument('Empty again') });
      });
      rerender(<EmptyState onInsertStarter={vi.fn()} />);
      expect(document.querySelector('.dc-empty')).not.toHaveAttribute('data-intro');
    } finally {
      vi.useRealTimers();
    }
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
