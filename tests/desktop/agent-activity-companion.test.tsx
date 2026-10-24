/**
 * Work an agent does for the companion shows in the companion's card, not a second time on the
 * status line an agent the person connected uses.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentActivity, SHOW_AFTER_MS } from '../../src/desktop/agentActivity';
import { companion } from '../../src/desktop/companion';
import { AgentActivity } from '../../src/desktop/ui/AgentActivity';
import { setDesktopController } from '../../src/desktop/useDesktop';

beforeEach(() => {
  vi.useFakeTimers();
  agentActivity.__reset();
  companion.__reset();
  setDesktopController({ cancelAgentRequest: vi.fn() } as never);
});

afterEach(() => {
  vi.useRealTimers();
  setDesktopController(null as never);
});

it('leaves a companion run’s work to its card and shows everyone else’s', () => {
  companion.begin('d_1', 'r1', 'Add a cache', null);
  render(<AgentActivity />);
  act(() => {
    agentActivity.begin({ id: 1, tool: 'update_diagram', title: 'Orders', target: 'open', path: [], run: 'r1' });
    agentActivity.begin({ id: 2, tool: 'update_diagram', title: 'Payments', target: 'open', path: [] });
    vi.advanceTimersByTime(SHOW_AFTER_MS + 10);
  });
  expect(screen.queryByText(/Orders/)).toBeNull();
  expect(screen.getByText(/Payments/)).toBeTruthy();
});
