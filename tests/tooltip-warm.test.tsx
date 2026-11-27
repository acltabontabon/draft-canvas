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
  it('keeps default action tooltips dismissible by pointer press', () => {
    vi.useFakeTimers();
    const { a } = mountPair();
    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    expect(screen.getByRole('tooltip')).toHaveTextContent('A');
    fireEvent.pointerDown(a);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

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

  it('opens again on a later hover once its own hide delay has run out', () => {
    vi.useFakeTimers();
    const { a } = mountPair();

    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    fireEvent.mouseLeave(a);
    advance(150);
    expect(screen.queryByRole('tooltip')).toBeNull();

    // The spent hide timer once stayed recorded as pending, so this hover only "cancelled" it.
    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    expect(screen.getByRole('tooltip')).toHaveTextContent('A');
  });

  it('opens again when re-hovered right after a sibling closed it', () => {
    vi.useFakeTimers();
    const { a, b } = mountPair();

    fireEvent.mouseEnter(a);
    advance(COLD_DELAY);
    fireEvent.mouseLeave(a);
    fireEvent.mouseEnter(b);
    advance(WARM_DELAY);
    expect(screen.getByRole('tooltip')).toHaveTextContent('B');

    // Back to A while its hide delay (closed early by B) would still have been pending.
    fireEvent.mouseLeave(b);
    fireEvent.mouseEnter(a);
    advance(WARM_DELAY);
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('A');
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

describe('Tooltip dismissal', () => {
  it('closes a tooltip shown by hover on Escape wherever focus is, and leaves the key to the page', () => {
    // WCAG 1.4.13: dismissible without moving the pointer or focus. Escape used to be heard only on
    // the trigger, so a tooltip the pointer rested on stayed over the canvas while focus was there.
    vi.useFakeTimers();
    const { a } = mountPair();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    const reachedPage = vi.fn();
    window.addEventListener('keydown', reachedPage);
    try {
      fireEvent.mouseEnter(a);
      advance(COLD_DELAY);
      expect(screen.getByRole('tooltip')).toHaveTextContent('A');
      fireEvent.keyDown(elsewhere, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      // Not claimed: the editor's own Escape (putting a tool down, say) still runs.
      expect(reachedPage).toHaveBeenCalledTimes(1);
      expect(reachedPage.mock.calls[0]![0].defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener('keydown', reachedPage);
      elsewhere.remove();
    }
  });
});
