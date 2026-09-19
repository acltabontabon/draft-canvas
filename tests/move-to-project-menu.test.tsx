import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MoveToProjectMenu } from '../src/ui/Library/MoveToProjectMenu';

const projects = [
  { id: 'p1', name: 'Payments Platform', createdAt: 1, updatedAt: 1 },
  { id: 'p2', name: 'Growth', createdAt: 2, updatedAt: 2 },
];

describe('MoveToProjectMenu keyboard navigation', () => {
  it('ArrowDown moves the highlight and Enter selects the highlighted project', () => {
    const onMove = vi.fn();
    render(<MoveToProjectMenu currentProjectId={undefined} projects={projects} onMove={onMove} onClose={() => {}} />);

    const menu = screen.getByRole('menu');
    // Unorganized starts highlighted since it's the current project.
    expect(menu).toHaveAttribute('aria-activedescendant', 'dc-move-menu-item-0');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(menu).toHaveAttribute('aria-activedescendant', 'dc-move-menu-item-1');

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onMove).toHaveBeenCalledWith('p1');
  });

  it('End jumps to the last row, Home back to the first', () => {
    render(<MoveToProjectMenu currentProjectId={undefined} projects={projects} onMove={() => {}} onClose={() => {}} />);
    const menu = screen.getByRole('menu');

    fireEvent.keyDown(window, { key: 'End' });
    expect(menu).toHaveAttribute('aria-activedescendant', 'dc-move-menu-item-2');

    fireEvent.keyDown(window, { key: 'Home' });
    expect(menu).toHaveAttribute('aria-activedescendant', 'dc-move-menu-item-0');
  });

  it('focuses the menu on open and restores focus to the trigger on close', () => {
    function Host() {
      return (
        <>
          <button type="button">Move to a project</button>
          <MoveToProjectMenu currentProjectId={undefined} projects={projects} onMove={() => {}} onClose={() => {}} />
        </>
      );
    }
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<Host />);
    expect(document.activeElement).toBe(screen.getByRole('menu'));

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('Tab closes the menu instead of leaving its window-level keys live over another control', () => {
    const onClose = vi.fn();
    const onMove = vi.fn();
    render(<MoveToProjectMenu currentProjectId={undefined} projects={projects} onMove={onMove} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Tab' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('Escape closes without selecting anything', () => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    render(<MoveToProjectMenu currentProjectId={undefined} projects={projects} onMove={onMove} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });
});
