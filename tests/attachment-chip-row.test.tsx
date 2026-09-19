import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentChipRow } from '../src/canvas/AttachmentPresentation';
import { ThemeProvider } from '../src/ui/theme/ThemeProvider';
import type { Attachment } from '../src/document/types';

/**
 * A connector's chip row rests compact when it carries more than one attachment: four spelled-out
 * chips span most of a connector's length, so they fall back to their colour dots and name
 * themselves when the connector is reached for. The collapse itself is CSS
 * (`.dc-attachment-chip-row[data-compact]`); what is pinned here is *when* the row asks for it.
 */

const note = (id: string): Attachment => ({ id, type: 'note', text: 'x', noteKind: 'note' });

const actions = { update: vi.fn(), remove: vi.fn(), detach: vi.fn(), reorder: vi.fn() };

function renderRow(hostKind: 'node' | 'edge', attachments: Attachment[], revealed?: boolean) {
  render(
    <ThemeProvider>
      <AttachmentChipRow
        hostKind={hostKind}
        hostId="h1"
        attachments={attachments}
        cardSide="above"
        editable
        actions={actions}
        revealed={revealed}
      />
    </ThemeProvider>,
  );
  return document.querySelector('.dc-attachment-chip-row')!;
}

describe('AttachmentChipRow compaction', () => {
  it('compacts a connector carrying more than one attachment', () => {
    expect(renderRow('edge', [note('a'), note('b')])).toHaveAttribute('data-compact', 'true');
  });

  it('leaves a connector with a single attachment spelled out', () => {
    expect(renderRow('edge', [note('a')])).not.toHaveAttribute('data-compact');
  });

  it('never compacts a node, whose chips live in a popover panel with room for them', () => {
    expect(renderRow('node', [note('a'), note('b'), note('c')])).not.toHaveAttribute('data-compact');
  });

  it('marks the row revealed when its connector is being reached for', () => {
    expect(renderRow('edge', [note('a'), note('b')], true)).toHaveAttribute('data-revealed', 'true');
  });

  it('keeps every chip a separate, individually reachable control while compact', () => {
    renderRow('edge', [note('a'), note('b'), note('c')]);
    // Compaction hides the label visually, never structurally — each chip keeps its own accessible
    // name, so nothing about it is lost to a screen reader or to keyboard navigation.
    expect(screen.getAllByRole('button', { name: 'View attached note' })).toHaveLength(3);
  });
});

describe('AttachmentChip detach', () => {
  it('commits text typed in the card before detaching, so the new node carries it', () => {
    actions.update.mockClear();
    actions.detach.mockClear();
    renderRow('edge', [note('a')]);

    fireEvent.click(screen.getByRole('button', { name: 'View attached note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit attached detail' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Attached note' }), { target: { value: 'typed just now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Detach onto the canvas' }));

    expect(actions.update).toHaveBeenCalledWith('a', { text: 'typed just now' });
    expect(actions.detach).toHaveBeenCalledWith('a');
    expect(actions.update.mock.invocationCallOrder[0]!).toBeLessThan(actions.detach.mock.invocationCallOrder[0]!);
  });
});
