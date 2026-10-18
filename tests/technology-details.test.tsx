import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TechnologyDetails } from '../src/canvas/TechnologyDetails';
import { createNode } from '../src/document/factory';

describe('technology detail disclosure', () => {
  it('shows the complete value on click or keyboard activation and dismisses on Escape or blur', () => {
    const node = createNode({ type: 'database', x: 0, y: 0, technology: 'PostgreSQL 16.2' });
    render(<TechnologyDetails node={node} />);
    const button = screen.getByRole('button', { name: 'Technology: PostgreSQL 16.2' });
    const detail = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(detail).not.toBeVisible();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(detail).toBeVisible();
    expect(detail).toHaveTextContent('PostgreSQL 16.2');
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(detail).not.toBeVisible();
    fireEvent.click(button);
    fireEvent.blur(button);
    expect(detail).not.toBeVisible();
  });

  it('also exposes full details for a custom technology using the generic mark', () => {
    render(<TechnologyDetails node={createNode({ type: 'service', x: 0, y: 0, technology: 'Internal engine' })} />);
    expect(screen.getByRole('button', { name: 'Technology: Internal engine' })).toBeVisible();
  });

  it('does not add an empty control when technology is cleared', () => {
    render(<TechnologyDetails node={createNode({ type: 'service', x: 0, y: 0 })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
