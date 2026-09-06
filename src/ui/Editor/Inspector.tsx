import { BOUNDARY_PRESETS, CODE_LANGUAGES, ACCENTS, NOTE_KINDS } from '../../document/types';
import type {
  Accent,
  ActorKind,
  BoundaryPreset,
  CodeLanguage,
  ComponentKind,
  DatabaseKind,
  NoteKind,
  QueueKind,
  ServiceKind,
} from '../../document/types';
import type { AlignEdge } from '../../document/operations';
import { ACTOR_ICON_OPTIONS } from '../../canvas/actorOptions';
import { COMPONENT_ICON_OPTIONS } from '../../canvas/componentOptions';
import { DATABASE_ICON_OPTIONS } from '../../canvas/dataStoreOptions';
import { InspectorSelect } from '../../canvas/InspectorSelect';
import { QUEUE_ICON_OPTIONS } from '../../canvas/queueOptions';
import { SERVICE_ICON_OPTIONS } from '../../canvas/serviceOptions';
import { LANGUAGE_LABELS } from '../../render/code/highlight';
import { useEditorStore } from '../../store/editorStore';
import { nodeIndex, edgeIndex } from '../../store/selectors';
import { useThemeValue } from '../theme/useTheme';
import { Button } from '../common/Button';
import { NOTE_LABELS, BOUNDARY_PRESET_OPTION_LABELS } from './nodeKindLabels';

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

  const onlyNode = nodes.length === 1 ? nodes[0] : null;
  const multiple = nodes.length > 1;

  if (nodes.length === 0 && edges.length === 0) return null;
  // A single connector, selected alone, gets its own anchored control
  // (`EdgeInspectorPopover`) instead — this bottom-docked strip is
  // node-selection territory now. Any other combination (a node, multiple
  // edges, or a mix) still lands here exactly as before.
  if (nodes.length === 0 && edges.length === 1) return null;
  // A single element, selected alone, gets its own anchored control
  // (`ElementInspectorPopover`) instead of this bottom-docked strip — mirrors
  // the single-edge case above. Multi-selection and mixed selections still
  // land here exactly as before.
  if (nodes.length === 1 && edges.length === 0) return null;

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
        {nodes.length === 0 && edges.some((edge) => edge.accent !== undefined) && (
          <Button
            variant="ghost"
            title="Derive this connection's colour from its source node instead of a fixed one"
            onClick={() => {
              const state = store.getState();
              for (const edge of edges) state.updateEdgeById(edge.id, { accent: undefined }, 'Reset colour');
            }}
          >
            Auto
          </Button>
        )}
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

      {onlyNode?.type === 'service' && (
        <>
          <span className="dc-inspector-divider" />
          <InspectorSelect
            className="dc-inspector-toolbar-select"
            ariaLabel="Service type"
            value={onlyNode.serviceKind ?? 'generic'}
            options={SERVICE_ICON_OPTIONS}
            onChange={(value) =>
              store
                .getState()
                .updateNodeById(onlyNode.id, { serviceKind: value as ServiceKind }, 'Change service type')
            }
            preferredDirection="up"
            layout="grid"
          />
        </>
      )}

      {onlyNode?.type === 'database' && (
        <>
          <span className="dc-inspector-divider" />
          <InspectorSelect
            className="dc-inspector-toolbar-select"
            ariaLabel="Data Store type"
            value={onlyNode.databaseKind ?? 'generic'}
            options={DATABASE_ICON_OPTIONS}
            onChange={(value) =>
              store
                .getState()
                .updateNodeById(onlyNode.id, { databaseKind: value as DatabaseKind }, 'Change data store type')
            }
            preferredDirection="up"
            layout="grid"
          />
        </>
      )}

      {onlyNode?.type === 'queue' && (
        <>
          <span className="dc-inspector-divider" />
          <InspectorSelect
            className="dc-inspector-toolbar-select"
            ariaLabel="Queue type"
            value={onlyNode.queueKind ?? 'queue'}
            options={QUEUE_ICON_OPTIONS}
            onChange={(value) =>
              store.getState().updateNodeById(onlyNode.id, { queueKind: value as QueueKind }, 'Change queue type')
            }
            preferredDirection="up"
          />
        </>
      )}

      {onlyNode?.type === 'actor' && (
        <>
          <span className="dc-inspector-divider" />
          <InspectorSelect
            className="dc-inspector-toolbar-select"
            ariaLabel="Actor type"
            value={onlyNode.actorKind ?? 'human'}
            options={ACTOR_ICON_OPTIONS}
            onChange={(value) =>
              store.getState().updateNodeById(onlyNode.id, { actorKind: value as ActorKind }, 'Change actor type')
            }
            preferredDirection="up"
          />
        </>
      )}

      {onlyNode?.type === 'component' && (
        <>
          <span className="dc-inspector-divider" />
          <InspectorSelect
            className="dc-inspector-toolbar-select"
            ariaLabel="Component type"
            value={onlyNode.componentKind ?? 'generic'}
            options={COMPONENT_ICON_OPTIONS}
            onChange={(value) =>
              store
                .getState()
                .updateNodeById(onlyNode.id, { componentKind: value as ComponentKind }, 'Change component type')
            }
            preferredDirection="up"
          />
        </>
      )}

      {multiple && (
        <>
          <span className="dc-inspector-divider" />
          <select
            className="dc-select"
            aria-label="Align"
            defaultValue=""
            onChange={(event) => {
              if (!event.target.value) return;
              store.getState().align(event.target.value as AlignEdge);
              event.target.value = '';
            }}
          >
            <option value="" disabled>
              Align…
            </option>
            <option value="left">Left</option>
            <option value="centerX">Centre</option>
            <option value="right">Right</option>
            <option value="top">Top</option>
            <option value="centerY">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
          {nodes.length >= 3 && (
            <>
              <Button
                variant="quiet"
                title="Distribute evenly, left to right"
                onClick={() => store.getState().distribute('x')}
              >
                Distribute ↔
              </Button>
              <Button
                variant="quiet"
                title="Distribute evenly, top to bottom"
                onClick={() => store.getState().distribute('y')}
              >
                Distribute ↕
              </Button>
            </>
          )}
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
          <select
            className="dc-select"
            aria-label="Boundary preset"
            value={onlyNode.boundaryPreset ?? 'boundary'}
            onChange={(event) =>
              store
                .getState()
                .updateNodeById(
                  onlyNode.id,
                  { boundaryPreset: event.target.value as BoundaryPreset },
                  'Change boundary preset',
                )
            }
          >
            {BOUNDARY_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {BOUNDARY_PRESET_OPTION_LABELS[preset]}
              </option>
            ))}
          </select>
          <Button variant="quiet" onClick={() => store.getState().ungroupSelection()}>
            Ungroup
          </Button>
        </>
      )}

      <span className="dc-inspector-divider" />
      <Button
        variant="quiet"
        title="Fade everything else, to focus on this while explaining (Esc to exit)"
        onClick={() =>
          store.getState().enterFocus(
            nodes.map((node) => node.id),
            edges.map((edge) => edge.id),
          )
        }
      >
        Focus
      </Button>
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
