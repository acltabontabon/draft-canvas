import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { Toolbar } from '../src/ui/Editor/Toolbar';

/**
 * Four app-level utilities fold into `More` so the right edge stops reading as an icon train.
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
    learnModeActive: false,
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
    expect(screen.getByRole('menuitemcheckbox', { name: 'Learn Draft Canvas' })).toBeInTheDocument();
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

  it('reports Learn Mode as a checkable row rather than losing its on-state', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ learnModeActive: true });
    renderToolbar();
    await openMenu(user);

    expect(screen.getByRole('menuitemcheckbox', { name: 'Learn Draft Canvas' })).toBeChecked();
  });

  it('toggles Learn Mode from the row', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Learn Draft Canvas' }));

    expect(useUiStore.getState().learnModeActive).toBe(true);
  });

  it('is reachable by keyboard alone, and Escape returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await openMenu(user);

    // Real focus sits on the panel; `aria-activedescendant` names the current row.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(useUiStore.getState().shortcutsOpen).toBe(true);

    await openMenu(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^More/ })).toHaveFocus();
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
