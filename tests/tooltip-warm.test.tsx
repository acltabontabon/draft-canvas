import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipGroup } from '../src/ui/common/Tooltip';

/**
 * Crossing a dense bar, the first tooltip is a question ("what is this?") and every one after it
 * is the same question continued — so only the first should cost the full hover delay. The warmth
 * is scoped to a `TooltipGroup`, not to module state, which is what keeps a cold start cold in
 * the next test rather than inheriting whatever the previous one left behind.
 */

const COLD_DELAY = 400;
const WARM_DELAY = 80;

function mountPair() {
  render(
    <TooltipGroup>
      {['A', 'B'].map((title) => (
        <Tooltip key={title} content={{ title, shortcut: title }}>
          {(tip) => (
            <button type="button" {...tip}>
              {title}
            </button>
          )}
        </Tooltip>
      ))}
    </TooltipGroup>,
  );
  return {
    a: screen.getByRole('button', { name: 'A' }),
    b: screen.getByRole('button', { name: 'B' }),
  };
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('Tooltip warmth', () => {
  it('makes the first tooltip in a group wait the full delay', () => {
    vi.useFakeTimers();
    const { a } = mountPair();

    fireEvent.mouseEnter(a);
    advance(COLD_DELAY - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();

    advance(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('A');
  });

  it('shows a sibling almost at once while the group is warm', () => {
    vi.useFakeTimers();
    const { a, b } = mountPair();

    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    fireEvent.mouseLeave(a);
    advance(150);
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(b);
    advance(WARM_DELAY);
    expect(screen.getByRole('tooltip')).toHaveTextContent('B');
  });

  it('stays warm while a sibling is still open, so a fast traverse never re-waits', () => {
    vi.useFakeTimers();
    const { a, b } = mountPair();

    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    // The pointer moves on before A has finished its own hide delay — A is still up, so B must
    // read the group as warm rather than falling back to the cold delay.
    fireEvent.mouseLeave(a);
    fireEvent.mouseEnter(b);
    advance(WARM_DELAY);
    // Exactly one: A is dropped the instant B opens rather than lingering out its hide delay on
    // top of it.
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('B');
  });

  it('goes cold again once the group has been idle', () => {
    vi.useFakeTimers();
    const { a, b } = mountPair();

    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    fireEvent.mouseLeave(a);
    advance(150);

    // Long enough after the last close that the next hover is a fresh question.
    advance(500);
    fireEvent.mouseEnter(b);
    advance(WARM_DELAY);
    expect(screen.queryByRole('tooltip')).toBeNull();

    advance(COLD_DELAY - WARM_DELAY);
    expect(screen.getByRole('tooltip')).toHaveTextContent('B');
  });

  it('never warms a tooltip outside a group', () => {
    vi.useFakeTimers();
    render(
      <>
        <TooltipGroup>
          <Tooltip content={{ title: 'Grouped' }}>
            {(tip) => <button type="button" {...tip}>Grouped</button>}
          </Tooltip>
        </TooltipGroup>
        <Tooltip content={{ title: 'Lone' }}>
          {(tip) => <button type="button" {...tip}>Lone</button>}
        </Tooltip>
      </>,
    );

    const grouped = screen.getByRole('button', { name: 'Grouped' });
    fireEvent.mouseEnter(grouped);
    advance(COLD_DELAY);
    fireEvent.mouseLeave(grouped);
    advance(150);

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Lone' }));
    advance(WARM_DELAY);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
