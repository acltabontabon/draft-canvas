import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from '../src/canvas/ContextMenu';
import type { ContextMenuEntry } from '../src/commands/contextMenu';
import type { Command } from '../src/commands/types';

/**
 * A row answers a click that began as a press inside the menu, or one that had no press at all (a
 * screen reader's or switch control's activation, which reports `detail: 0`). It does not answer the
 * click a long-press produces on lift: that press began on the canvas, and the menu opened under the
 * finger.
 */
function mount() {
  const command: Command = { id: 'duplicate', title: 'Duplicate', group: 'selection', run: vi.fn() };
  const entries: ContextMenuEntry[] = [{ type: 'command', command, label: 'Duplicate' }];
  const onSelect = vi.fn();
  render(<ContextMenu screenPosition={{ x: 200, y: 200 }} entries={entries} onSelect={onSelect} onDismiss={vi.fn()} />);
  return { command, onSelect, row: screen.getByRole('menuitem', { name: /Duplicate/ }) };
}

describe('ContextMenu clicks', () => {
  it('runs a row for a click that follows a press inside the menu', () => {
    const { command, onSelect, row } = mount();
    fireEvent.pointerDown(row);
    fireEvent.click(row, { detail: 1 });
    expect(onSelect).toHaveBeenCalledWith(command);
  });

  it('runs a row for a virtual click with no press at all — assistive technology activates this way', () => {
    const { command, onSelect, row } = mount();
    fireEvent.click(row); // detail 0, no pointerdown
    expect(onSelect).toHaveBeenCalledWith(command);
  });

  it('ignores the click a long-press produces when it lifts over a row it never pressed', () => {
    const { onSelect, row } = mount();
    // The finger went down on the canvas (outside the menu), so no pointerdown reached it; the lift
    // then synthesises a real click (detail 1) over whichever row sits there.
    fireEvent.click(row, { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
