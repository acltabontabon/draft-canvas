import { useState } from 'react';
import {
  BOUNDARY_PRESETS,
  CODE_LANGUAGES,
  ACCENTS,
  CONNECTOR_KINDS,
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
  ConnectorKind,
  DatabaseKind,
  DraftEdge,
  DraftNode,
  EdgeSemantic,
  NoteKind,
  QueueKind,
  ServiceKind,
} from '../../document/types';
import type { AlignEdge } from '../../document/operations';
import { stepIndexOf } from '../../document/flow';
import { capabilityFor, categoryOf, type ConnectionCapability } from '../../document/connectorSemantics';
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

const CONNECTOR_KIND_LABELS: Record<ConnectorKind, string> = {
  sync: 'Sync',
  async: 'Async',
  event: 'Event',
  callback: 'Callback',
  conditional: 'Conditional',
  retry: 'Retry',
  failure: 'Failure',
  fallback: 'Fallback',
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

  const onlyNode = nodes.length === 1 ? nodes[0] : null;
  const onlyEdge = edges.length === 1 ? edges[0] : null;
  const multiple = nodes.length > 1;

  if (nodes.length === 0 && edges.length === 0) return null;

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
        <EdgeControls
          key={onlyEdge.id}
          edge={onlyEdge}
          sourceNode={nodeIndex(document.nodes).get(onlyEdge.source)}
          targetNode={nodeIndex(document.nodes).get(onlyEdge.target)}
        />
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

/** A queue relationship's behaviour reads as an event carried asynchronously
 *  — spelling both out is more legible in a compact badge than the bare
 *  `ConnectorKind` label, without adding a second stored field for it. */
function behaviorBadgeLabel(kind: ConnectorKind): string {
  return kind === 'event' ? 'Event · Async' : CONNECTOR_KIND_LABELS[kind];
}

/**
 * The controls for a single selected connector — contextual on what it
 * actually connects (see `document/connectorSemantics.ts`'s capability
 * matrix), which is "the more Draft Canvas knows, the less UI it shows" in
 * practice:
 *
 * - The relation dropdown only lists options relevant to this node pairing,
 *   plus the edge's current value (even if unusual) and a "Show all…" escape
 *   hatch — never a hard restriction, since an existing or deliberately
 *   unusual choice must stay visible and editable.
 * - When behaviour is predetermined (a queue relation is always event-ish;
 *   a plain database read/write has no meaningful behaviour at all) and the
 *   edge's own `kind` doesn't disagree, the picker collapses to a small
 *   static badge — click it to expand back into the full picker.
 * - The condition field only appears once there's a real behaviour choice in
 *   play (contextually, or because the user expanded it), or one is already
 *   set — a plain database write has nowhere to hang a condition.
 *
 * A component of its own (not inline JSX in `Inspector`) specifically so its
 * two "reveal the advanced controls" toggles can live as ordinary `useState`
 * and reset for free via `key={edge.id}` at the call site, rather than a
 * manual effect keyed off the selection.
 */
function EdgeControls({
  edge,
  sourceNode,
  targetNode,
}: {
  edge: DraftEdge;
  sourceNode: DraftNode | undefined;
  targetNode: DraftNode | undefined;
}) {
  const store = useEditorStore;
  const [showAllRelations, setShowAllRelations] = useState(false);
  const [editingBehavior, setEditingBehavior] = useState(false);

  const capability: ConnectionCapability | undefined =
    sourceNode && targetNode ? capabilityFor(categoryOf(sourceNode), categoryOf(targetNode)) : undefined;

  const relationBase = capability && !showAllRelations ? capability.relations : EDGE_SEMANTICS;
  const relationOptions =
    edge.semantic && !relationBase.includes(edge.semantic) ? [...relationBase, edge.semantic] : relationBase;
  const canShowAllRelations =
    Boolean(capability) && !showAllRelations && capability!.relations.length < EDGE_SEMANTICS.length;

  const behaviorIsPredetermined = Boolean(capability) && capability!.behaviors.length === 0;
  const behaviorMatchesPolicy = !edge.kind || edge.kind === capability?.defaultBehavior;
  const showBehaviorPicker = !behaviorIsPredetermined || !behaviorMatchesPolicy || editingBehavior;
  const behaviorBase = capability && capability.behaviors.length > 0 ? capability.behaviors : CONNECTOR_KINDS;
  // The empty option below is already relabelled "Sync" when that's
  // contextually the implicit default — listing the real `sync` value too
  // would just be the same word twice, unless the edge already has it as an
  // explicit value, in which case dropping it would leave nothing selected.
  const hideSyncOption = behaviorBase.includes('sync') && edge.kind !== 'sync';
  const behaviorOptions = hideSyncOption ? behaviorBase.filter((kind) => kind !== 'sync') : behaviorBase;
  // Once behaviour is worth picking at all, a condition is too — a plain
  // database write has nowhere meaningful to hang one.
  const showCondition = showBehaviorPicker || Boolean(edge.condition);

  return (
    <>
      <span className="dc-inspector-divider" />
      <Button
        variant="ghost"
        active={edge.directed}
        title="Show an arrowhead"
        onClick={() => store.getState().updateEdgeById(edge.id, { directed: !edge.directed }, 'Change direction')}
      >
        Arrow
      </Button>
      <select
        className="dc-select"
        aria-label="Connector shape"
        value={edge.routing}
        onChange={(event) =>
          store
            .getState()
            .updateEdgeById(edge.id, { routing: event.target.value as typeof edge.routing }, 'Change routing')
        }
      >
        <option value="smoothstep">Stepped</option>
        <option value="bezier">Curved</option>
        <option value="straight">Straight</option>
      </select>
      <select
        className="dc-select"
        aria-label="Connection type"
        value={edge.semantic ?? ''}
        onChange={(event) => {
          if (event.target.value === '__more__') {
            setShowAllRelations(true);
            return;
          }
          store.getState().setEdgeSemantic(edge.id, (event.target.value || undefined) as EdgeSemantic | undefined);
        }}
      >
        <option value="">No type</option>
        {relationOptions.map((semantic) => (
          <option key={semantic} value={semantic}>
            {EDGE_SEMANTIC_LABELS[semantic]}
          </option>
        ))}
        {canShowAllRelations && <option value="__more__">Show all…</option>}
      </select>
      {showBehaviorPicker ? (
        <select
          className="dc-select"
          aria-label="Flow kind"
          title="Flow behaviour — a subtle visual treatment, not a label"
          value={edge.kind ?? ''}
          onChange={(event) =>
            store.getState().setEdgeKind(edge.id, (event.target.value || undefined) as ConnectorKind | undefined)
          }
        >
          <option value="">{capability?.behaviors.includes('sync') ? 'Sync' : 'No kind'}</option>
          {behaviorOptions.map((kind) => (
            <option key={kind} value={kind}>
              {CONNECTOR_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      ) : (
        capability?.defaultBehavior && (
          <button
            type="button"
            className="dc-kind-badge"
            title="Inferred from what this connects — click to change"
            onClick={() => setEditingBehavior(true)}
          >
            {behaviorBadgeLabel(capability.defaultBehavior)}
          </button>
        )
      )}
      {showCondition && (
        <input
          className="dc-input dc-input-condition"
          aria-label="Condition"
          placeholder="Condition…"
          defaultValue={edge.condition ?? ''}
          spellCheck={false}
          onBlur={(event) => store.getState().setEdgeCondition(edge.id, event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      )}
      <span className="dc-inspector-divider" />
      <EdgeFlowMembership edgeId={edge.id} />
    </>
  );
}

/**
 * A connector may belong to several flows at once, each with its own step
 * position — this renders one compact control per flow it's already in, plus
 * a select to add it to another (or a brand new one).
 */
function EdgeFlowMembership({ edgeId }: { edgeId: string }) {
  const flows = useEditorStore((state) => state.document.flows);
  const store = useEditorStore;
  const memberOf = flows.filter((flow) => stepIndexOf(flow, edgeId) !== undefined);
  const available = flows.filter((flow) => stepIndexOf(flow, edgeId) === undefined);

  return (
    <>
      {memberOf.map((flow) => {
        const position = stepIndexOf(flow, edgeId)!;
        const step = flow.steps.find((s) => s.edgeId === edgeId)!;
        return (
          <span className="dc-inspector-flow-chip" key={flow.id}>
            <input
              className="dc-inspector-flow-chip-input"
              aria-label={`Rename flow ${flow.title}`}
              defaultValue={flow.title}
              spellCheck={false}
              size={Math.max(4, flow.title.length)}
              onBlur={(event) => {
                const value = event.currentTarget.value;
                if (value.trim() && value !== flow.title) store.getState().renameFlow(flow.id, value);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  event.currentTarget.value = flow.title;
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="dc-inspector-flow-chip-step">· {position}</span>
            <Button
              icon="back"
              variant="quiet"
              aria-label={`Move earlier in ${flow.title}`}
              onClick={() => store.getState().moveFlowStep(flow.id, step.id, -1)}
            />
            <Button
              icon="forward"
              variant="quiet"
              aria-label={`Move later in ${flow.title}`}
              onClick={() => store.getState().moveFlowStep(flow.id, step.id, 1)}
            />
            <Button
              icon="close"
              variant="quiet"
              aria-label={`Remove from ${flow.title}`}
              onClick={() => store.getState().removeFlowStep(flow.id, step.id)}
            />
          </span>
        );
      })}
      <select
        className="dc-select"
        aria-label="Add to flow"
        defaultValue=""
        onChange={(event) => {
          const value = event.target.value;
          if (!value) return;
          const state = store.getState();
          const flowId = value === '__new__' ? state.createFlow() : value;
          state.addEdgeToFlow(flowId, edgeId);
          // Immediate visual feedback: this flow's step badges are now showing.
          state.setSelectedFlowId(flowId);
          event.target.value = '';
        }}
      >
        <option value="" disabled>
          Add to flow…
        </option>
        {available.map((flow) => (
          <option key={flow.id} value={flow.id}>
            {flow.title}
          </option>
        ))}
        <option value="__new__">New flow…</option>
      </select>
    </>
  );
}
