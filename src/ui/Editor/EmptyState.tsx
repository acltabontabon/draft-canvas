import { MOD_SYMBOL } from '../../lib/platform';
import { ARCHITECTURE_STARTERS, type StarterId } from '../../starters';
import { useEditorStore } from '../../store/editorStore';

interface EmptyStateProps {
  /** Runs the palette's own starter command — see `EditorScreen`. */
  onInsertStarter: (id: StarterId) => void;
}

/**
 * A blank canvas should suggest the first move without lecturing. One line, one hint, no tour, no
 * dismissible cards.
 *
 * The starter row is the one interactive thing here, and it stays deliberately plain text: an
 * architecture is two words and a click away, but nothing about it reads as a template gallery.
 * That is why the surrounding copy keeps its `aria-hidden` (it is decorative, and always was) while
 * the buttons don't — focusable content inside an `aria-hidden` subtree is unreachable, so the
 * attribute moved down onto the parts that are genuinely decoration.
 */
export function EmptyState({ onInsertStarter }: EmptyStateProps) {
  const isEmpty = useEditorStore((state) => state.document.nodes.length === 0);
  const mode = useEditorStore((state) => state.mode);

  if (!isEmpty || mode !== 'edit') return null;

  return (
    <div className="dc-empty">
      <p className="dc-empty-title" aria-hidden="true">
        Double-click anywhere to start.
      </p>
      <p className="dc-empty-hint" aria-hidden="true">
        Add shapes, connect ideas, drop in code, explain the flow.
      </p>
      <p className="dc-empty-keys" aria-hidden="true">
        <kbd>N</kbd> note <span className="dc-dot" /> <kbd>C</kbd> code <span className="dc-dot" />{' '}
        <kbd>S</kbd> service <span className="dc-dot" /> <kbd>{MOD_SYMBOL}K</kbd> commands{' '}
        <span className="dc-dot" /> <kbd>?</kbd> all shortcuts
      </p>
      <div className="dc-empty-starters" role="group" aria-label="Architecture starters">
        {ARCHITECTURE_STARTERS.map((starter) => (
          <button
            key={starter.id}
            type="button"
            className="dc-empty-starter"
            title={starter.description}
            onClick={() => onInsertStarter(starter.id)}
          >
            {starter.name}
          </button>
        ))}
        <span className="dc-empty-starters-tail" aria-hidden="true">
          or <kbd>{MOD_SYMBOL}K</kbd>
        </span>
      </div>
    </div>
  );
}
