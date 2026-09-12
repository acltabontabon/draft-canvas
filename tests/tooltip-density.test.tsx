import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipGroup } from '../src/ui/common/Tooltip';
import type { PrimitiveTooltipContent } from '../src/canvas/presets';

/**
 * One tooltip surface, two densities. A conventional action (no `description`) must not be given
 * a paragraph it doesn't need, and must not fall back to a browser-native `title` either — it
 * gets the same card, smaller. These assert the density contract; the shared chrome is CSS.
 */

function mount(content: PrimitiveTooltipContent) {
  render(
    <TooltipGroup>
      <Tooltip content={content}>
        {(tip) => (
          <button type="button" {...tip}>
            {content.title}
          </button>
        )}
      </Tooltip>
    </TooltipGroup>,
  );
  // Focus shows immediately, so these need no timer control.
  fireEvent.focus(screen.getByRole('button', { name: content.title }));
  return screen.getByRole('tooltip');
}

describe('Tooltip densities', () => {
  it('renders the compact density — title and keys only — when there is no description', () => {
    const tooltip = mount({ title: 'Undo', shortcut: '⌘ Z' });

    expect(tooltip.dataset.density).toBe('compact');
    expect(tooltip.querySelector('.dc-tooltip-description')).toBeNull();
    expect(tooltip.querySelector('.dc-tooltip-hint')).toBeNull();
    expect(tooltip.textContent).toContain('Undo');
  });

  it('renders the rich density when a description explains the concept', () => {
    const tooltip = mount({
      title: 'Flows',
      description: 'A named path through the architecture.',
      usageHint: 'Use one to sequence a request across services.',
      shortcut: 'F',
    });

    expect(tooltip.dataset.density).toBe('rich');
    expect(tooltip.querySelector('.dc-tooltip-description')?.textContent).toContain(
      'A named path through the architecture.',
    );
    expect(tooltip.querySelector('.dc-tooltip-hint')?.textContent).toContain('sequence a request');
  });

  it('renders one cap per shortcut token, so a chord is never a single wide chip', () => {
    const tooltip = mount({ title: 'Redo', shortcut: '⌘ Shift Z' });

    expect([...tooltip.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual([
      '⌘',
      'Shift',
      'Z',
    ]);
  });

  it('names the trigger via aria-describedby at either density', () => {
    const tooltip = mount({ title: 'Export', shortcut: '⌘ E' });
    expect(screen.getByRole('button', { name: 'Export' }).getAttribute('aria-describedby')).toBe(
      tooltip.id,
    );
  });
});
