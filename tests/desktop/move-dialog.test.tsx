import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopError } from '../../src/desktop/api';
import type { ProjectState } from '../../src/desktop/store';
import { nextFreeName } from '../../src/desktop/ui/fileTargets';
import { MoveToProjectDialog } from '../../src/desktop/ui/MoveToProjectDialog';

/** "Move to Project…": one click moves; the project it is in can't be chosen; a taken name asks. */

const project = (name: string, files: string[] = []): ProjectState => ({
  info: { handle: `p_${name}`, name, displayPath: `~/work/${name}` },
  status: 'ready',
  files: files.map((relPath) => ({ relPath, name: relPath.replace(/^.*\//, '').replace(/\.draftcanvas$/, ''), mtimeMs: 0, size: 1 })),
  truncatedDirs: [],
});

const PROJECTS = [project('payments', ['checkout.draftcanvas']), project('billing', ['checkout.draftcanvas', 'checkout 2.draftcanvas'])];

function open(onMove: (project: string, keepBoth: boolean) => Promise<unknown>, onClose = vi.fn()) {
  render(<MoveToProjectDialog name="checkout" fromPath="~/work/payments/checkout.draftcanvas" projects={PROJECTS} onMove={onMove} onAddProject={vi.fn()} onClose={onClose} />);
  return { onClose };
}

afterEach(cleanup);

describe('Move to Project', () => {
  it('marks the project the file is in now, and moves on one click elsewhere', async () => {
    const onMove = vi.fn(async () => {});
    const { onClose } = open(onMove);

    const here = screen.getByRole('button', { name: /payments/ });
    expect(here).toBeDisabled();
    expect(here.textContent).toContain('Here now');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /billing/ })));
    expect(onMove).toHaveBeenCalledWith('p_billing', false);
    expect(onClose).toHaveBeenCalled();
  });

  it('a taken name stops and asks, and Keep both moves under the next free name', async () => {
    const onMove = vi.fn(async (_project: string, keepBoth: boolean) => {
      if (!keepBoth) throw new DesktopError('AlreadyExists', 'A file named checkout.draftcanvas already exists there.');
    });
    const { onClose } = open(onMove);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /billing/ })));
    expect(screen.getByRole('alert').textContent).toContain('already has a diagram called “checkout”');
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep both as “checkout 3”' })));
    expect(onMove).toHaveBeenLastCalledWith('p_billing', true);
    expect(onClose).toHaveBeenCalled();
  });

  it('Don’t move leaves the file where it is', async () => {
    const onMove = vi.fn(async () => {
      throw new DesktopError('AlreadyExists', 'Taken.');
    });
    const { onClose } = open(onMove);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /billing/ })));
    fireEvent.click(screen.getByRole('button', { name: 'Don’t move' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('previews Keep both from the top folder only, ignoring case', () => {
    expect(nextFreeName('Checkout', project('x', ['checkout 2.draftcanvas', 'flows/Checkout 3.draftcanvas']))).toBe('Checkout 3');
  });
});
