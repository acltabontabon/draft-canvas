import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorSelect, type InspectorSelectOption } from '../src/canvas/InspectorSelect';

/**
 * Regression coverage for a width-coupling bug: the dropdown menu used to inherit its width from
 * the trigger's own (CSS-shrunk) box, so selecting a short option ("API") and reopening the menu
 * truncated longer sibling options ("External" → "Ex..."). The fix decouples the menu's width
 * from the trigger and measures the menu's own natural content width instead.
 *
 * jsdom doesn't run real CSS layout, so `getBoundingClientRect()` is mocked per element (keyed by
 * a `data-mock-rect` attribute set from the test) to stand in for what a real browser would
 * measure once `.dc-inspector-select-menu` is `width: max-content` — this exercises the
 * component's own measurement/clamp logic, not the CSS itself (covered separately by the
 * `element-inspector.spec.ts` e2e test, which runs a real layout engine).
 */

const SERVICE_OPTIONS: InspectorSelectOption[] = [
  { value: 'generic', label: 'Generic' },
  { value: 'api', label: 'API' },
  { value: 'worker', label: 'Worker' },
  { value: 'external', label: 'External' },
];

type Rect = { width: number; height: number; top: number; bottom: number; left: number; right: number };

let triggerRect: Rect;
let menuRect: Rect;

function rect(partial: Partial<Rect>): Rect {
  return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, ...partial };
}

beforeEach(() => {
  // Generous defaults: plenty of viewport room on every side, narrow trigger, wide menu — the
  // shape a real short-selected-value + long-options case would produce.
  triggerRect = rect({ left: 100, right: 140, top: 100, bottom: 120, width: 40, height: 20 });
  menuRect = rect({ left: 100, right: 340, top: 124, bottom: 200, width: 240, height: 76 });

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === 'BUTTON') return triggerRect as DOMRect;
    if (this.tagName === 'UL') return menuRect as DOMRect;
    return rect({}) as DOMRect;
  });
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 800);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSelect(value: string, options = SERVICE_OPTIONS) {
  const onChange = vi.fn();
  const utils = render(
    <InspectorSelect value={value} options={options} onChange={onChange} ariaLabel="Service type" />,
  );
  return { onChange, ...utils };
}

function openMenu() {
  act(() => {
    // Only one trigger is ever rendered per test — its accessible name varies (e.g. across the
    // "switching shapes" test) so it's queried generically rather than by a fixed label.
    fireEvent.click(screen.getByRole('button'));
  });
}

describe('InspectorSelect menu width', () => {
  it('a short selected value does not constrain the menu when there is ample room', () => {
    // Trigger is narrow (width 40, matching a short "API" label); the menu is wide (240, matching
    // the full option list). With a roomy viewport, the menu must not be clamped down to the
    // trigger's width.
    renderSelect('api');
    openMenu();

    const menu = screen.getByRole('listbox');
    expect(menu).toHaveAttribute('data-h-align', 'start');
    expect(menu.style.maxWidth).toBe('');
  });

  it('flips to right-aligned instead of clipping when the trigger sits near the right viewport edge', () => {
    triggerRect = rect({ left: 1100, right: 1140, top: 100, bottom: 120, width: 40, height: 20 });
    // Menu naturally wants to be wider than the remaining space to the right of the trigger, but
    // fits comfortably to its left.
    menuRect = rect({ left: 1100, right: 1340, top: 124, bottom: 200, width: 240, height: 76 });

    renderSelect('api');
    openMenu();

    const menu = screen.getByRole('listbox');
    expect(menu).toHaveAttribute('data-h-align', 'end');
    // Fits fully on the left side, so no forced maxWidth clamp is needed either.
    expect(menu.style.maxWidth).toBe('');
  });

  it('clamps maxWidth only when neither side has room for the menu at its natural width', () => {
    triggerRect = rect({ left: 600, right: 640, top: 100, bottom: 120, width: 40, height: 20 });
    // Wider than the entire 1200px viewport could offer on either side of the trigger.
    menuRect = rect({ left: 600, right: 2600, top: 124, bottom: 200, width: 2000, height: 76 });

    renderSelect('api');
    openMenu();

    const menu = screen.getByRole('listbox');
    expect(menu.style.maxWidth).not.toBe('');
  });

  it('re-measures against the current options on every open, so switching to a shape with different/longer options never reuses a stale width', () => {
    const { rerender } = renderSelect('api');
    openMenu();
    const firstMenu = screen.getByRole('listbox');
    expect(firstMenu).toHaveAttribute('data-h-align', 'start');
    expect(firstMenu.style.maxWidth).toBe('');

    // Close (simulating selection), then simulate switching to a different shape type: new
    // options, new current value, and a much longer natural menu width — as if a Boundary's
    // options (including "Deployment") replaced Service's.
    act(() => {
      fireEvent.keyDown(firstMenu, { key: 'Escape' });
    });

    const longOptions: InspectorSelectOption[] = [
      { value: 'boundary', label: 'Boundary' },
      { value: 'deployment', label: 'Deployment' },
    ];
    triggerRect = rect({ left: 1100, right: 1140, top: 100, bottom: 120, width: 40, height: 20 });
    menuRect = rect({ left: 1100, right: 1340, top: 124, bottom: 200, width: 240, height: 76 });

    rerender(
      <InspectorSelect
        value="deployment"
        options={longOptions}
        onChange={vi.fn()}
        ariaLabel="Boundary preset"
      />,
    );
    openMenu();

    const secondMenu = screen.getByRole('listbox');
    // The new measurement (right-edge trigger + wide menu) must be reflected fresh, not the
    // 'start'/unclamped result cached from the first shape's selector.
    expect(secondMenu).toHaveAttribute('data-h-align', 'end');
  });
});
