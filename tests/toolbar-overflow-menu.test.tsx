import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { Toolbar } from '../src/ui/Editor/Toolbar';

/**
 * Four app-level entries fold into `More` so the right edge stops reading as an icon train.
 * Folding is only acceptable if nothing becomes unreachable — these cover the part that is easy
 * to lose in a redesign: every item still runs its real handler, and the keyboard still gets
 * there without a pointer.
 */

function renderToolbar() {
  render(
    <Toolbar
      title="Untitled canvas"
      onTitleChange={() => {}}
      onBack={() => {}}
      onPresent={() => {}}
      onExport={() => {}}
    />,
  );
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /^More/ }));

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({
    armed: null,
    settingsOpen: false,
    shortcutsOpen: false,
    aboutOpen: false,
    updateReady: false,
  });
});

describe('toolbar overflow menu', () => {
  it('holds the four utilities that no longer need permanent space', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);

    expect(screen.getByRole('menuitem', { name: 'Canvas settings' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Documentation' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'About Draft Canvas' })).toBeInTheDocument();
  });

  it('still opens Canvas settings, the thing the old button did', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Canvas settings' }));

    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('opens the documentation in a new tab, as a link rather than a mode', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderToolbar();
    expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument();
    await openMenu(user);
    await user.click(screen.getByRole('menuitem', { name: 'Documentation' }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('/docs/'), '_blank', 'noopener');
    open.mockRestore();
  });

  it('is reachable by keyboard alone, and Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);

    // Real focus sits on the panel; `aria-activedescendant` names the current row. Opening puts
    // the first row (Canvas settings) under it, so Keyboard shortcuts — Canvas settings,
    // Documentation, then this — is two rows down.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(useUiStore.getState().shortcutsOpen).toBe(true);

    await openMenu(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^More/ })).toHaveFocus();
  });

  it('steps aside for ⌘K, so the palette does not open over a menu answering the same keys', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Meta>}k{/Meta}');

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the trigger is clicked again', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);
    expect(screen.getByRole('menu', { name: 'More' })).toBeInTheDocument();

    await openMenu(user);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
