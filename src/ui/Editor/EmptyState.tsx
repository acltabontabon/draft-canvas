import { MOD_SYMBOL } from '../../lib/platform';
import { useEditorStore } from '../../store/editorStore';

/**
 * A blank canvas should suggest the first move without lecturing. One line, one
 * hint, no tour, no dismissible cards.
 */
export function EmptyState() {
  const isEmpty = useEditorStore((state) => state.document.nodes.length === 0);
  const mode = useEditorStore((state) => state.mode);

  if (!isEmpty || mode !== 'edit') return null;

  return (
    <div className="dc-empty" aria-hidden="true">
      <p className="dc-empty-title">Double-click anywhere to start.</p>
      <p className="dc-empty-hint">Add shapes, connect ideas, drop in code, explain the flow.</p>
      <p className="dc-empty-keys">
        <kbd>N</kbd> note <span className="dc-dot" /> <kbd>C</kbd> code <span className="dc-dot" />{' '}
        <kbd>S</kbd> service <span className="dc-dot" /> <kbd>{MOD_SYMBOL}K</kbd> commands{' '}
        <span className="dc-dot" /> <kbd>?</kbd> all shortcuts
      </p>
    </div>
  );
}
