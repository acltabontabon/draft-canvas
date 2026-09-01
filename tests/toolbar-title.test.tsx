import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../src/ui/Editor/Toolbar';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * Regression coverage for a bug where every space typed into the diagram title vanished (e.g.
 * "Space Seems To Work Here" became "SpaceSeemsToWorkHere"). Root cause: the title input was
 * fully store-controlled and wrote to the store (running `setTitle`'s `.trim()`) on every
 * keystroke, so a space was stripped the instant it became the trailing character — before the
 * next character arrived. The fix edits locally and commits (and thus trims) only on blur/Enter,
 * matching every other text field in the app.
 */
function renderToolbar(title: string, onTitleChange = vi.fn()) {
  render(
    <Toolbar
      title={title}
      onTitleChange={onTitleChange}
      onBack={() => {}}
      onFit={() => {}}
      onPresent={() => {}}
      onExport={() => {}}
    />,
  );
  return { onTitleChange, input: screen.getByLabelText('Diagram title') as HTMLInputElement };
}

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({ armed: null });
});

describe('Toolbar title editing', () => {
  it('keeps spaces visible while typing and does not commit until blur', () => {
    const { onTitleChange, input } = renderToolbar('Untitled canvas');

    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.change(input, { target: { value: 'A ' } });
    fireEvent.change(input, { target: { value: 'A B' } });
    fireEvent.change(input, { target: { value: 'A B ' } });
    fireEvent.change(input, { target: { value: 'A B C' } });

    expect(input.value).toBe('A B C');
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it('commits the typed value on blur', () => {
    const { onTitleChange, input } = renderToolbar('Untitled canvas');

    fireEvent.change(input, { target: { value: 'A B C' } });
    fireEvent.blur(input);

    expect(onTitleChange).toHaveBeenCalledWith('A B C');
  });

  it('commits on Enter', () => {
    const { onTitleChange, input } = renderToolbar('Untitled canvas');

    input.focus();
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onTitleChange).toHaveBeenCalledWith('New title');
  });

  it('reverts to the original title on Escape without committing', () => {
    const { onTitleChange, input } = renderToolbar('Original title');

    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('Original title');
    expect(onTitleChange).not.toHaveBeenCalledWith('Discard me');
  });
});
