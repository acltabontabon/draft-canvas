import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { ARCHITECTURE_STARTERS } from '../src/starters';
import { EmptyState } from '../src/ui/Editor/EmptyState';
import { useEditorStore } from '../src/store/editorStore';

/**
 * The blank canvas is the one place a starter is offered without being searched for, so the bar is
 * that it stays out of the way: it disappears the moment anything exists, it never appears while
 * presenting, and it is reachable from the keyboard for anyone who doesn't use a mouse.
 */

beforeEach(() => {
  useEditorStore.setState({ document: createDocument('Empty'), mode: 'edit' });
});

const renderEmpty = (onInsertStarter = vi.fn()) => ({
  onInsertStarter,
  ...render(<EmptyState onInsertStarter={onInsertStarter} />),
});

describe('EmptyState', () => {
  it('offers every starter as a plain button, grouped and labelled for a screen reader', () => {
    renderEmpty();
    const group = screen.getByRole('group', { name: 'Starters' });
    expect(group).toBeInTheDocument();
    for (const starter of ARCHITECTURE_STARTERS) {
      expect(screen.getByRole('button', { name: starter.name })).toBeInTheDocument();
    }
    // One row per category, the same split the palette shows, each named for a screen reader.
    const architectures = within(screen.getByRole('group', { name: 'Architectures' })).getAllByRole('button');
    const patterns = within(screen.getByRole('group', { name: 'Patterns' })).getAllByRole('button');
    expect(architectures.map((b) => b.textContent)).toEqual(
      ARCHITECTURE_STARTERS.filter((s) => s.category === 'architecture').map((s) => s.name),
    );
    expect(patterns.map((b) => b.textContent)).toEqual(['Saga (Orchestration)', 'Transactional Outbox']);
  });

  it('inserts the starter it names', async () => {
    const { onInsertStarter } = renderEmpty();
    await userEvent.click(screen.getByRole('button', { name: 'Microservices' }));
    expect(onInsertStarter).toHaveBeenCalledWith('microservices');
  });

  it('is reachable without a mouse', async () => {
    const { onInsertStarter } = renderEmpty();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Monolith' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onInsertStarter).toHaveBeenCalledWith('monolith');
  });

  it('vanishes as soon as the canvas has anything on it', () => {
    const { rerender } = renderEmpty();
    expect(screen.getByRole('button', { name: 'Monolith' })).toBeInTheDocument();
    useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    rerender(<EmptyState onInsertStarter={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Monolith' })).not.toBeInTheDocument();
  });

  it('stays away during a presentation', () => {
    useEditorStore.setState({ mode: 'present' });
    renderEmpty();
    expect(screen.queryByRole('group', { name: 'Starters' })).not.toBeInTheDocument();
  });

  it('keeps the surrounding copy decorative, so nothing but the buttons is announced', () => {
    const { container } = renderEmpty();
    for (const paragraph of container.querySelectorAll('p')) {
      expect(paragraph).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
