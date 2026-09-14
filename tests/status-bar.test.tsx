import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { useEditorStore } from '../src/store/editorStore';
import { StatusBar } from '../src/ui/Editor/StatusBar';

function mount(presenting: boolean, onResolveConflict = vi.fn()) {
  return render(
    <ReactFlowProvider>
      <StatusBar durable presenting={presenting} onResolveConflict={onResolveConflict} />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
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
    // rest of the bar (element counts, zoom controls) stays out of the presentation chrome.
    useEditorStore.setState({ save: { status: 'error', conflict: 'changed' } });
    mount(true);
    expect(screen.getByText('Keep mine')).toBeInTheDocument();
    expect(screen.getByText('Load the other tab’s')).toBeInTheDocument();
    expect(screen.queryByText(/connectors/)).toBeNull();
  });

  it('labels a deleted-canvas conflict distinctly from a changed one', () => {
    useEditorStore.setState({ save: { status: 'error', conflict: 'deleted' } });
    mount(true);
    expect(screen.getByText('Keep this canvas')).toBeInTheDocument();
    expect(screen.getByText('Close it')).toBeInTheDocument();
  });
});

describe('StatusBar while editing', () => {
  it('shows the full bar, including a conflict, when not presenting', () => {
    useEditorStore.setState({ save: { status: 'error', conflict: 'deleted' } });
    mount(false);
    expect(screen.getByText('Keep this canvas')).toBeInTheDocument();
    expect(screen.getByText(/connectors/)).toBeInTheDocument();
  });

  it('shows the zoom as a whole percentage that fits to view', () => {
    mount(false);
    expect(screen.getByRole('button', { name: '100%, fit to view' })).toHaveTextContent('100%');
  });
});
