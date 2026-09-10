import { MOD_SYMBOL } from '../../lib/platform';
import { ARCHITECTURE_STARTERS, STARTER_CATEGORIES, type StarterId } from '../../starters';
import { useEditorStore } from '../../store/editorStore';

interface EmptyStateProps {
  /** Runs the palette's own starter command — see `EditorScreen`. */
  onInsertStarter: (id: StarterId) => void;
}

/**
 * A blank canvas should suggest the first move without lecturing. One line, one hint, no tour, no
 * dismissible cards.
 *
 * The starters are the one interactive thing here, and they stay deliberately plain text: an
 * architecture is two words and a click away, but nothing about it reads as a template gallery.
 * They sit in two labelled groups — the same *Architectures* / *Patterns* split ⌘K shows — each
 * label centred above its own wrapped cluster, so the whole empty state hangs off one centre line
 * and tapers: title, hint, shortcuts, starters. Nine names on one line, or a label in a left
 * gutter, both pull that composition off-centre; `styles/canvas.css` has the long version.
 *
 * ⌘K is taught once, in the shortcut row above. It used to repeat as a trailing "or ⌘K" after the
 * starters, from when they were a single row for it to trail.
 *
 * The surrounding copy keeps its `aria-hidden` (it is decorative, and always was) while the
 * buttons don't — focusable content inside an `aria-hidden` subtree is unreachable, so the
 * attribute moved down onto the parts that are genuinely decoration. Each group's label is
 * decoration too: the group's own accessible name carries it.
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
      <div className="dc-empty-starters" role="group" aria-label="Starters">
        {STARTER_CATEGORIES.map((category) => (
          <div key={category.id} className="dc-empty-starter-row" role="group" aria-label={category.label}>
            <span className="dc-empty-starter-label" aria-hidden="true">
              {category.label}
            </span>
            <span className="dc-empty-starter-buttons">
              {ARCHITECTURE_STARTERS.filter((starter) => starter.category === category.id).map((starter) => (
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
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
