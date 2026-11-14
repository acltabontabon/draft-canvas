import { ReactFlowProvider } from '@xyflow/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { useEditorStore } from '../src/store/editorStore';
import { StatusBar, type SaveFailureActions } from '../src/ui/Editor/StatusBar';
import { saveFailureMessage } from '../src/storage/saveFailure';
import { useUiStore } from '../src/store/uiStore';

// The UI store reads device preferences when it is created; never the real storage, so no test here
// can leave something behind for another to read.
const preferences = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

function mount(presenting: boolean, onResolveConflict = vi.fn(), onSaveFailure?: SaveFailureActions) {
  return render(
    <ReactFlowProvider>
      <StatusBar durable presenting={presenting} onResolveConflict={onResolveConflict} onSaveFailure={onSaveFailure} />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  preferences.clear();
  useEditorStore.setState({ document: createDocument('Presenting'), save: { status: 'idle' } });
});

describe('StatusBar while presenting', () => {
  it('renders nothing when there is no conflict', () => {
    const { container } = mount(true);
    expect(container).toBeEmptyDOMElement();
  });

  it('still surfaces a cross-tab conflict, so it is not invisible until the presenter exits', () => {
    // A conflict (another tab changed or deleted this canvas) must stay resolvable even while
    // presenting — see EditorScreen.tsx / StatusBar.tsx. Only the conflict choice is shown; the
    // rest of the bar (save status, zoom controls) stays out of the presentation chrome.
    useEditorStore.setState({ save: { status: 'error', conflict: 'changed' } });
    mount(true);
    expect(screen.getByText('Keep mine')).toBeInTheDocument();
    expect(screen.getByText('Load the other tab’s')).toBeInTheDocument();
    expect(screen.queryByText(/connectors/)).toBeNull();
  });

  it('labels a deleted-diagram conflict distinctly from a changed one', () => {
    useEditorStore.setState({ save: { status: 'error', conflict: 'deleted' } });
    mount(true);
    expect(screen.getByText('Keep this diagram')).toBeInTheDocument();
    expect(screen.getByText('Close it')).toBeInTheDocument();
  });
});

describe('StatusBar while editing', () => {
  it('shows the full bar, including a conflict, when not presenting', () => {
    useEditorStore.setState({ save: { status: 'error', conflict: 'deleted' } });
    mount(false);
    expect(screen.getByText('Keep this diagram')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '100%, fit to view' })).toBeInTheDocument();
    expect(screen.queryByText(/connectors/)).toBeNull();
  });

  it('shows the zoom as a whole percentage that fits to view', () => {
    mount(false);
    expect(screen.getByRole('button', { name: '100%, fit to view' })).toHaveTextContent('100%');
  });
});

describe('StatusBar after a save failed', () => {
  const actions = () => ({ retry: vi.fn(), exportCopy: vi.fn(), leave: vi.fn() });
  const failed = (failure: 'full' | 'closed' | 'other') =>
    useEditorStore.setState({ save: { status: 'error', failure, message: saveFailureMessage(failure) } });

  it('offers Retry, Export and Leave without saving, and says why in plain words', () => {
    failed('full');
    const choices = actions();
    mount(false, vi.fn(), choices);
    expect(screen.getByText('Storage full — not saved')).toBeInTheDocument();
    // Once for the eye (the hint beside the actions), once for a screen reader.
    expect(screen.getAllByText(/Export it, then free space by deleting diagrams in the Library/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(choices.retry).toHaveBeenCalledTimes(1);
    expect(choices.exportCopy).toHaveBeenCalledTimes(1);
    expect(choices.leave).not.toHaveBeenCalled();
  });

  it('asks before giving the changes up, and Keep editing backs out', () => {
    failed('other');
    const choices = actions();
    mount(false, vi.fn(), choices);
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(choices.leave).not.toHaveBeenCalled();
    expect(screen.getByText('Changes since the last save will be lost.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(choices.leave).toHaveBeenCalledTimes(1);
  });

  it('leaves Retry out when the connection to storage is gone: nothing here can write again', () => {
    failed('closed');
    mount(false, vi.fn(), actions());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('Storage disconnected — not saved')).toBeInTheDocument();
  });

  it('is announced in full to a screen reader', () => {
    failed('full');
    mount(false, vi.fn(), actions());
    expect(screen.getByRole('status')).toHaveTextContent(saveFailureMessage('full'));
  });

  it('is still shown while presenting, with the way out', () => {
    failed('full');
    const choices = actions();
    mount(true, vi.fn(), choices);
    expect(screen.getByText('Storage full — not saved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(choices.exportCopy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '100%, fit to view' })).toBeNull();
  });

  it('shows nothing extra while presenting when nothing failed, and does not replace a conflict choice', () => {
    const { container, unmount } = mount(true, vi.fn(), actions());
    expect(container).toBeEmptyDOMElement();
    unmount();
    useEditorStore.setState({ save: { status: 'error', conflict: 'changed', message: 'This diagram was changed in another tab.' } });
    mount(true, vi.fn(), actions());
    expect(screen.getByText('Keep mine')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('StatusBar controls say what they do', () => {
  it('names the zoom buttons through the shared tooltip, with the keys that are really bound', () => {
    mount(false);
    const describedBy = (name: string) => {
      const button = screen.getByRole('button', { name });
      // Not the native title: it cannot carry a key, and it appeared on its own after a delay.
      expect(button).not.toHaveAttribute('title');
      fireEvent.focus(button);
      return document.getElementById(button.getAttribute('aria-describedby')!)?.textContent ?? '';
    };
    expect(describedBy('Zoom in')).toMatch(/Shortcut .*\+/);
    expect(describedBy('Zoom out')).toMatch(/Shortcut .*[−-]/);
    expect(describedBy('100%, fit to view')).toMatch(/Shortcut .*1/);
  });

  it('says why Undo and Redo are off while a flow is traced or the copy is read-only', () => {
    useUiStore.setState({ flowTrace: { flowId: null } as never, readOnly: null });
    const { unmount } = mount(false);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAttribute('title', 'Finish or cancel tracing the flow first.');
    unmount();
    useUiStore.setState({ flowTrace: null, readOnly: { sharedTitle: 'Shared' } as never });
    mount(false);
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveAttribute('title', 'This diagram is read-only.');
    useUiStore.setState({ readOnly: null });
  });
});
