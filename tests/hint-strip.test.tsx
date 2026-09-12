import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same in-memory fake `tests/hints.test.tsx` and `tests/personality-preference.test.tsx` use.
const store = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => store.get(key) ?? null,
  writePreference: (key: string, value: string) => void store.set(key, value),
}));

const { HintsProvider } = await import('../src/learning/HintsProvider');
const { HintStrip } = await import('../src/canvas/HintStrip');
const { HINT_COPY } = await import('../src/learning/hints');
const { useUiStore } = await import('../src/store/uiStore');

beforeEach(() => {
  store.clear();
  useUiStore.setState({ learnModeActive: false });
});

function renderHint() {
  return render(
    <HintsProvider>
      <HintStrip id="attachment-slot" learned={false} />
    </HintsProvider>,
  );
}

/**
 * Regression coverage for the bug where dismissing a hint while "Learn Draft Canvas" mode is on
 * appeared to do nothing — `HintStrip`'s render guard ignored the dismissal because Learn Mode
 * forces already-retired hints back into view. See `HintsProvider.tsx`'s `sessionDismissed` set.
 */
describe('HintStrip dismissal', () => {
  /**
   * Regression coverage for the bug where a fresh (never-seen, never-retired) hint kept showing
   * up on every selection regardless of the Learn Draft Canvas toggle — hints must only ever
   * surface while Learn Mode is explicitly on.
   */
  it('stays hidden without Learn Mode, even for a hint never seen before', () => {
    renderHint();
    expect(screen.queryByText(HINT_COPY['attachment-slot'])).not.toBeInTheDocument();
  });

  it('shows the current copy while Learn Mode is on, and hides after clicking dismiss', () => {
    useUiStore.setState({ learnModeActive: true });
    renderHint();
    expect(screen.getByText(HINT_COPY['attachment-slot'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss hint' }));

    expect(screen.queryByText(HINT_COPY['attachment-slot'])).not.toBeInTheDocument();
  });

  it('hides immediately after dismissal even while Learn Mode is active', () => {
    useUiStore.setState({ learnModeActive: true });
    renderHint();
    expect(screen.getByText(HINT_COPY['attachment-slot'])).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss hint' }));

    // This is the reported bug: Learn Mode's "resurface retired hints" guard used to win over an
    // explicit dismissal, so the strip stayed visible after clicking X.
    expect(screen.queryByText(HINT_COPY['attachment-slot'])).not.toBeInTheDocument();
  });

  it('shows a hint only under Learn Mode, whatever an older build persisted about it', () => {
    store.set('hint.attachment-slot', '1');

    const { rerender } = render(
      <HintsProvider>
        <HintStrip id="attachment-slot" learned={false} />
      </HintsProvider>,
    );
    expect(screen.queryByText(HINT_COPY['attachment-slot'])).not.toBeInTheDocument();

    useUiStore.setState({ learnModeActive: true });
    rerender(
      <HintsProvider>
        <HintStrip id="attachment-slot" learned={false} />
      </HintsProvider>,
    );
    expect(screen.getByText(HINT_COPY['attachment-slot'])).toBeInTheDocument();
  });
});
