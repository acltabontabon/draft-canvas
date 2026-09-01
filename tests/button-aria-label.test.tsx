import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/ui/common/Button';

/**
 * Icon-only toolbar buttons (Undo, Redo, Present, ...) relied on `title` alone, which many
 * screen-reader configurations don't fall back to — `Button` now synthesizes `aria-label` from
 * `title` for any button with no visible text children, without touching any call site.
 */
describe('Button aria-label', () => {
  it('synthesizes aria-label from title for an icon-only button', () => {
    render(<Button icon="undo" title="Undo (Cmd+Z)" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Undo (Cmd+Z)' })).toBeInTheDocument();
  });

  it('leaves an explicit aria-label alone', () => {
    render(<Button title="Toggle theme" aria-label="Toggle theme" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
  });

  it('does not synthesize an aria-label when the button already has visible text', () => {
    render(
      <Button title="Select (Esc)" onClick={() => {}}>
        Select
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-label')).toBeNull();
  });
});
