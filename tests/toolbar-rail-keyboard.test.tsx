import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { ALL_PRESETS } from '../src/canvas/presets';
import { Toolbar } from '../src/ui/Editor/Toolbar';

/**
 * The create rail is one tab stop with arrow-key travel, per the ARIA toolbar pattern — eleven
 * separate stops made getting past the toolbar by keyboard a chore.
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

const rail = () => screen.getByRole('toolbar', { name: 'Create' });
const segments = () => [...rail().querySelectorAll('button')];

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({ armed: null, learnModeActive: false });
});

describe('create rail keyboard travel', () => {
  it('keeps exactly one segment in the tab order', () => {
    renderToolbar();
    expect(segments().filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it('parks the tab stop on the tool actually in hand', () => {
    useUiStore.setState({ armed: ALL_PRESETS.find((preset) => preset.id === 'queue') });
    renderToolbar();

    const stop = segments().find((b) => b.tabIndex === 0);
    expect(stop).toHaveAccessibleName('Queue');
    expect(stop).toHaveAttribute('aria-pressed', 'true');
  });

  it('moves focus along the rail with arrows, and jumps with Home/End', () => {
    renderToolbar();
    const items = segments();
    items[0]!.focus();

    fireEvent.keyDown(rail(), { key: 'ArrowRight' });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(rail(), { key: 'End' });
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(rail(), { key: 'Home' });
    expect(items[0]).toHaveFocus();
  });

  it('does not run off either end', () => {
    renderToolbar();
    const items = segments();
    items[0]!.focus();
    fireEvent.keyDown(rail(), { key: 'ArrowLeft' });
    expect(items[0]).toHaveFocus();
  });

  it('arrowing the rail never reaches the editor, which would nudge the diagram', () => {
    // `EditorScreen` listens on `window` and only skips editable targets — a focused button is
    // not one — so a rail that let arrows through would silently move the user's selection.
    const editor = vi.fn();
    window.addEventListener('keydown', editor);
    try {
      renderToolbar();
      segments()[0]!.focus();
      fireEvent.keyDown(rail(), { key: 'ArrowRight' });
      expect(editor).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', editor);
    }
  });

  it('still lets Escape through, which clears the armed tool', () => {
    const escapes = vi.fn();
    window.addEventListener('keydown', escapes);
    try {
      renderToolbar();
      segments()[0]!.focus();
      fireEvent.keyDown(rail(), { key: 'Escape' });
      expect(escapes).toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', escapes);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
