import { CODE_LANGUAGES, ACCENTS, NOTE_KINDS } from '../../document/types';
import type { Accent, CodeLanguage, NoteKind } from '../../document/types';
import { LANGUAGE_LABELS } from '../../render/code/highlight';
import { useEditorStore } from '../../store/editorStore';
import { nodeIndex, edgeIndex } from '../../store/selectors';
import { useThemeValue } from '../theme/useTheme';
import { Button } from '../common/Button';

const NOTE_LABELS: Record<NoteKind, string> = {
  note: 'Note',
  question: 'Question',
  warning: 'Warning',
  decision: 'Decision',
};

/**
 * A contextual strip that appears only when something is selected, and shows
 * only the controls that apply to it. It sits over the canvas rather than
 * taking a permanent column, because the canvas is the product.
 */
export function Inspector() {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const store = useEditorStore;
  const theme = useThemeValue();

  const nodes = selection.nodes
    .map((id) => nodeIndex(document.nodes).get(id))
    .filter((node) => node !== undefined);
  const edges = selection.edges
    .map((id) => edgeIndex(document.edges).get(id))
    .filter((edge) => edge !== undefined);

  if (nodes.length === 0 && edges.length === 0) return null;

  const onlyNode = nodes.length === 1 ? nodes[0] : null;
  const onlyEdge = edges.length === 1 ? edges[0] : null;
  const multiple = nodes.length > 1;

  const setAccent = (accent: Accent) => {
    const state = store.getState();
    for (const node of nodes) state.updateNodeById(node.id, { accent }, 'Recolour');
    for (const edge of edges) state.updateEdgeById(edge.id, { accent }, 'Recolour');
  };

  return (
    <div className="dc-inspector" role="toolbar" aria-label="Selection options">
      <span className="dc-inspector-label">
        {nodes.length > 0 && `${nodes.length} ${nodes.length === 1 ? 'element' : 'elements'}`}
        {nodes.length > 0 && edges.length > 0 && ' · '}
        {edges.length > 0 &&
          `${edges.length} ${edges.length === 1 ? 'connection' : 'connections'}`}
      </span>

      <span className="dc-inspector-divider" />

      <div className="dc-swatches">
        {ACCENTS.map((accent) => (
          <button
            key={accent}
            type="button"
            className="dc-swatch"
            title={accent}
            aria-label={`Colour ${accent}`}
            style={{ background: theme.accents[accent].chip }}
            onClick={() => setAccent(accent)}
          />
        ))}
      </div>

      {onlyNode?.type === 'note' && (
        <>
          <span className="dc-inspector-divider" />
          <select
            className="dc-select"
            aria-label="Note kind"
            value={onlyNode.noteKind ?? 'note'}
            onChange={(event) =>
              store
                .getState()
                .updateNodeById(
                  onlyNode.id,
                  { noteKind: event.target.value as NoteKind },
                  'Change note kind',
                )
            }
          >
            {NOTE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {NOTE_LABELS[kind]}
              </option>
            ))}
          </select>
        </>
      )}

      {onlyNode?.type === 'code' && (
        <>
          <span className="dc-inspector-divider" />
          <select
            className="dc-select"
            aria-label="Code language"
            value={onlyNode.language ?? 'plaintext'}
            onChange={(event) =>
              store
                .getState()
                .updateNodeById(
                  onlyNode.id,
                  { language: event.target.value as CodeLanguage },
                  'Change language',
                )
            }
          >
            {CODE_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_LABELS[language]}
              </option>
            ))}
          </select>
        </>
      )}

      {onlyEdge && (
        <>
          <span className="dc-inspector-divider" />
          <Button
            variant="ghost"
            active={onlyEdge.directed}
            title="Show an arrowhead"
            onClick={() =>
              store
                .getState()
                .updateEdgeById(onlyEdge.id, { directed: !onlyEdge.directed }, 'Change direction')
            }
          >
            Arrow
          </Button>
          <select
            className="dc-select"
            aria-label="Connector shape"
            value={onlyEdge.routing}
            onChange={(event) =>
              store.getState().updateEdgeById(
                onlyEdge.id,
                { routing: event.target.value as typeof onlyEdge.routing },
                'Change routing',
              )
            }
          >
            <option value="smoothstep">Stepped</option>
            <option value="bezier">Curved</option>
            <option value="straight">Straight</option>
          </select>
          <Button
            variant="ghost"
            active={typeof onlyEdge.sequence === 'number'}
            title="Include this connection in the walkthrough"
            onClick={() => store.getState().toggleEdgeSequence(onlyEdge.id)}
          >
            {typeof onlyEdge.sequence === 'number' ? `Step ${onlyEdge.sequence}` : 'Add step'}
          </Button>
          {typeof onlyEdge.sequence === 'number' && (
            <>
              <Button
                icon="back"
                variant="quiet"
                aria-label="Move step earlier"
                onClick={() => store.getState().moveEdgeInSequence(onlyEdge.id, -1)}
              />
              <Button
                icon="forward"
                variant="quiet"
                aria-label="Move step later"
                onClick={() => store.getState().moveEdgeInSequence(onlyEdge.id, 1)}
              />
            </>
          )}
        </>
      )}

      {multiple && (
        <>
          <span className="dc-inspector-divider" />
          <Button variant="quiet" title="Align left" onClick={() => store.getState().align('left')}>
            Left
          </Button>
          <Button
            variant="quiet"
            title="Align centres"
            onClick={() => store.getState().align('centerX')}
          >
            Centre
          </Button>
          <Button variant="quiet" title="Align top" onClick={() => store.getState().align('top')}>
            Top
          </Button>
          <Button
            variant="quiet"
            title="Space evenly across"
            onClick={() => store.getState().distribute('x')}
          >
            Distribute
          </Button>
          <Button
            variant="quiet"
            title="Enclose in a boundary"
            onClick={() => store.getState().groupSelection()}
          >
            Group
          </Button>
        </>
      )}

      {onlyNode?.type === 'group' && (
        <>
          <span className="dc-inspector-divider" />
          <Button variant="quiet" onClick={() => store.getState().ungroupSelection()}>
            Ungroup
          </Button>
        </>
      )}

      <span className="dc-inspector-divider" />
      <Button
        icon="trash"
        variant="quiet"
        aria-label="Delete selection"
        title="Delete (Backspace)"
        onClick={() => store.getState().deleteSelection()}
      />
    </div>
  );
}
