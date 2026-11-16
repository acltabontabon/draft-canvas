import { useEditorStore } from '../../store/editorStore';
import { Button } from '../common/Button';

/**
 * A small, temporary state indicator shown only while Focus Mode is active —
 * not permanent chrome. Unlike `FlowBar`, this has no step controls: Focus
 * has no ordering, and must work in edit mode too, so it stays its own
 * lightweight element rather than a mode of the walkthrough bar.
 */
export function FocusIndicator() {
  const focus = useEditorStore((state) => state.focus);
  const exitFocus = useEditorStore((state) => state.exitFocus);

  if (!focus.active) return null;

  const parts: string[] = [];
  if (focus.nodeIds.length > 0) {
    parts.push(`${focus.nodeIds.length} ${focus.nodeIds.length === 1 ? 'shape' : 'shapes'}`);
  }
  if (focus.edgeIds.length > 0) {
    parts.push(`${focus.edgeIds.length} ${focus.edgeIds.length === 1 ? 'connector' : 'connectors'}`);
  }

  return (
    <div className="dc-focus-indicator" role="status">
      <span>Spotlight{parts.length > 0 ? ` · ${parts.join(', ')}` : ''}</span>
      <Button icon="close" variant="quiet" aria-label="Exit spotlight" title="Exit spotlight (Esc)" onClick={exitFocus} />
    </div>
  );
}
