import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { HelpMenu } from '../src/ui/Editor/HelpMenu';
import { Toolbar } from '../src/ui/Editor/Toolbar';

/**
 * The header's ⋯ is gone: help lives behind the "?" in the status bar, and what acts on the diagram
 * is a right-click on the canvas (`context-menu.test.ts`). Moving things is only acceptable if
 * nothing becomes unreachable — these cover the part that is easy to lose in a redesign: every item
 * still runs its real handler, and the keyboard still gets there without a pointer.
 */

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /^Help/ }));

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({
    armed: null,
    settingsOpen: false,
    shortcutsOpen: false,
    aboutOpen: false,
    commandPaletteOpen: false,
    updateReady: false,
  });
});

describe('the header', () => {
  it('holds no ⋯ and no undo or redo any more', () => {
    render(<Toolbar title="Untitled canvas" onTitleChange={() => {}} onBack={() => {}} onPresent={() => {}} onExport={() => {}} />);
    expect(screen.queryByRole('button', { name: /^More/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redo' })).not.toBeInTheDocument();
  });
});

describe('help menu', () => {
  it('holds the palette, the shortcut sheet, the guides and About', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await openMenu(user);

    for (const name of ['Commands', 'Keyboard shortcuts', 'Documentation', 'About Draft Canvas']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('opens the documentation in a new tab, as a link rather than a mode', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<HelpMenu />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Documentation' }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/docs/'), '_blank', 'noopener');
    open.mockRestore();
  });

  it('opens the command palette from its first row', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Commands' }));
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
  });

  it('is reachable by keyboard alone, and Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await openMenu(user);

    // Real focus sits on the panel; `aria-activedescendant` names the current row. Opening puts the
    // first row (Commands) under it, so Keyboard shortcuts is one row down.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(useUiStore.getState().shortcutsOpen).toBe(true);

    await openMenu(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Help/ })).toHaveFocus();
  });

  it('steps aside for ⌘K, so the palette does not open over a menu answering the same keys', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await openMenu(user);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the trigger is clicked again', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await openMenu(user);
    expect(screen.getByRole('menu', { name: 'Help' })).toBeInTheDocument();
    await openMenu(user);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
