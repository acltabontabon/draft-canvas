import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../src/ui/Editor/Toolbar';
import { ALL_PRESETS, SELECT_TOOLTIP, tooltipContentFor } from '../src/canvas/presets';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * Every toolbar primitive teaches its own architectural semantics on hover/focus instead of just
 * repeating its label — see `src/canvas/presets.ts`'s `description`/`usageHint` fields and
 * `ui/common/Tooltip.tsx`. These tests read expected copy from that same canonical source (never
 * a hardcoded duplicate string) so the tooltip can never silently drift from it.
 */

function renderToolbar() {
  render(
    <Toolbar
      title="Untitled canvas"
      onTitleChange={() => {}}
      onBack={() => {}}
      onFit={() => {}}
      onPresent={() => {}}
      onExport={() => {}}
    />,
  );
}

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  // The default — proves tooltips aren't gated behind Learn Mode (a separate, opt-in system).
  useUiStore.setState({ armed: null, learnModeActive: false });
});

const ALL_TOOLTIPS = [SELECT_TOOLTIP, ...ALL_PRESETS.map(tooltipContentFor)];

describe('Toolbar primitive tooltips', () => {
  it('shows every primitive tooltip on hover (after the delay), sourced from the canonical copy', () => {
    vi.useFakeTimers();
    try {
      renderToolbar();
      for (const content of ALL_TOOLTIPS) {
        const button = screen.getByRole('button', { name: content.title });

        fireEvent.mouseEnter(button);
        expect(screen.queryByRole('tooltip')).toBeNull();

        act(() => {
          vi.advanceTimersByTime(400);
        });

        const tooltip = screen.getByRole('tooltip');
        expect(tooltip.textContent).toContain(content.title);
        expect(tooltip.textContent).toContain(content.description);
        if (content.usageHint) expect(tooltip.textContent).toContain(content.usageHint);
        if (content.shortcut) expect(tooltip.textContent).toContain(content.shortcut);
        expect(button.getAttribute('aria-describedby')).toBe(tooltip.id);

        fireEvent.mouseLeave(button);
        act(() => {
          vi.advanceTimersByTime(150);
        });
        expect(screen.queryByRole('tooltip')).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show a tooltip before the hover delay elapses (no spam while the pointer travels)', () => {
    vi.useFakeTimers();
    try {
      renderToolbar();
      const button = screen.getByRole('button', { name: 'Service' });
      fireEvent.mouseEnter(button);
      act(() => {
        vi.advanceTimersByTime(399);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the tooltip immediately on keyboard focus, and Escape dismisses it', () => {
    renderToolbar();
    const button = screen.getByRole('button', { name: 'Queue' });

    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a primitive with no usage guidance (Text) renders title and description only', () => {
    renderToolbar();
    const button = screen.getByRole('button', { name: 'Text' });
    fireEvent.focus(button);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Plain canvas text');
    expect(tooltip.querySelector('.dc-tooltip-hint')).toBeNull();
  });

  it('clicking a preset button still arms it, unaffected by the tooltip', () => {
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    expect(useUiStore.getState().armed?.id).toBe('service');
  });

  it('clicking Select still clears the armed tool', () => {
    useUiStore.setState({ armed: ALL_PRESETS.find((preset) => preset.id === 'service') });
    renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(useUiStore.getState().armed).toBeNull();
  });
});
