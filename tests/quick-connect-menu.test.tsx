import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const preferences = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { QuickConnectMenu } from '../src/canvas/QuickConnectMenu';
import { quickConnectItems } from '../src/canvas/quickConnectItems';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';

/**
 * The picker's keyboard: arrows, Home and End move the highlight, Enter and Tab take the highlighted
 * row, and Shift+Tab — the way back — never chooses.
 */
function mount() {
  const doc = addNodes(createDocument('Picker'), [createNode({ id: 'g', type: 'service', serviceKind: 'gateway', x: 0, y: 0 })]);
  const items = quickConnectItems(doc, { source: 'g', flowPosition: { x: 0, y: 0 }, screenPosition: { x: 300, y: 300 } });
  const onSelect = vi.fn();
  const onHighlight = vi.fn();
  const rendered = render(
    <QuickConnectMenu screenPosition={{ x: 300, y: 300 }} items={items} onSelect={onSelect} onHighlight={onHighlight} onDismiss={vi.fn()} />,
  );
  const press = (key: string, init: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(window, { key, ...init }));
  const highlighted = () => rendered.container.querySelector('[data-highlighted="true"]')?.textContent;
  return { items, onSelect, press, highlighted, rendered };
}

describe('QuickConnectMenu keyboard', () => {
  it('Home and End go to the first and last row', () => {
    const { items, press, highlighted } = mount();
    expect(items.length).toBeGreaterThan(3);
    press('End');
    expect(highlighted()).toBe(items.at(-1)!.label);
    press('Home');
    expect(highlighted()).toBe(items[0]!.label);
  });

  it('Tab takes the highlighted row, as Enter does', () => {
    const { items, onSelect, press } = mount();
    press('ArrowDown');
    press('Tab');
    expect(onSelect).toHaveBeenLastCalledWith(items[1]);
    press('Enter');
    expect(onSelect).toHaveBeenLastCalledWith(items[1]);
  });

  it('Shift+Tab steps the highlight back and chooses nothing', () => {
    const { items, onSelect, press, highlighted } = mount();
    press('ArrowDown');
    press('ArrowDown');
    press('Tab', { shiftKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(highlighted()).toBe(items[1]!.label);
    press('Tab', { shiftKey: true });
    press('Tab', { shiftKey: true });
    expect(highlighted()).toBe(items.at(-1)!.label); // wraps, like the arrows
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is named for what it says: “Add to canvas”, with Esc written as the key is', () => {
    const { rendered } = mount();
    expect(rendered.getByRole('menu', { name: 'Add to canvas' })).toBeTruthy();
    expect(rendered.container.querySelector('.dc-quick-connect-heading kbd')?.textContent).toBe('Esc');
  });
});
