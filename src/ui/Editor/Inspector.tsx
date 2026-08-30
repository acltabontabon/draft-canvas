import {
  BOUNDARY_PRESETS,
  CODE_LANGUAGES,
  ACCENTS,
  DATABASE_KINDS,
  EDGE_SEMANTICS,
  NOTE_KINDS,
  QUEUE_KINDS,
  SERVICE_KINDS,
} from '../../document/types';
import type {
  Accent,
  BoundaryPreset,
  CodeLanguage,
  DatabaseKind,
  EdgeSemantic,
  NoteKind,
  QueueKind,
  ServiceKind,
} from '../../document/types';
import type { AlignEdge } from '../../document/operations';
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

const BOUNDARY_PRESET_OPTION_LABELS: Record<BoundaryPreset, string> = {
  boundary: 'Boundary',
  system: 'System',
  domain: 'Domain',
  network: 'Network',
  deployment: 'Deployment',
  group: 'Group',
};

const SERVICE_KIND_OPTION_LABELS: Record<ServiceKind, string> = {
  generic: 'Generic',
  api: 'API',
  worker: 'Worker',
  external: 'External',
};

const DATABASE_KIND_OPTION_LABELS: Record<DatabaseKind, string> = {
  generic: 'Generic',
  sql: 'SQL',
  nosql: 'NoSQL',
  cache: 'Cache',
};

const QUEUE_KIND_OPTION_LABELS: Record<QueueKind, string> = {
  queue: 'Queue',
  topic: 'Topic',
  stream: 'Stream',
};

const EDGE_SEMANTIC_LABELS: Record<EdgeSemantic, string> = {
  http: 'HTTP',
  event: 'Event',
  command: 'Command',
  query: 'Query',
  reads: 'Reads',
  writes: 'Writes',
  publishes: 'Publishes',
  consumes: 'Consumes',
  calls: 'Calls',
  dependsOn: 'Depends on',
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

      {onlyNode?.type === 'service' && (
        <>
          <span className="dc-inspector-divider" />
          <select
            className="dc-select"
            aria-label="Service type"
            value={onlyNode.serviceKind ?? 'generic'}
            onChange={(event) =>
              store
                .getState()
                .updateNodeById(
                  onlyNode.id,
                  { serviceKind: event.target.value as ServiceKind },
                  'Change service type',
                )
            }
          >
            {SERVICE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {SERVICE_KIND_OPTION_LABELS[kind]}
              </option>
            ))}
          </select>
        </>
      )}

      {onlyNode?.type === 'database' && (
        <>
          <span className="dc-inspector-divider" />
          <select
            className="dc-select"
            aria-label="Database type"
            value={onlyNode.databaseKind ?? 'generic'}
            onChange={(event) =>
              store
                .getState()
                .updateNodeById(
                  onlyNode.id,
                  { databaseKind: event.target.value as DatabaseKind },
                  'Change database type',
                )
            }
          >
            {DATABASE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {DATABASE_KIND_OPTION_LABELS[kind]}
              </option>
            ))}
          </select>
        </>
      )}

      {onlyNode?.type === 'queue' && (
        <>
          <span className="dc-inspector-divider" />
          <select
            className="dc-select"
            aria-label="Queue type"
            value={onlyNode.queueKind ?? 'queue'}
            onChange={(event) =>
              store
                .getState()
                .updateNodeById(
                  onlyNode.id,
                  { queueKind: event.target.value as QueueKind },
                  'Change queue type',
                )
            }
          >
            {QUEUE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {QUEUE_KIND_OPTION_LABELS[kind]}
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
          <select
            className="dc-select"
            aria-label="Connection type"
            value={onlyEdge.semantic ?? ''}
            onChange={(event) =>
              store
                .getState()
                .setEdgeSemantic(onlyEdge.id, (event.target.value || undefined) as EdgeSemantic | undefined)
            }
          >
            <option value="">No type</option>
            {EDGE_SEMANTICS.map((semantic) => (
              <option key={semantic} value={semantic}>
                {EDGE_SEMANTIC_LABELS[semantic]}
              </option>
            ))}
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
