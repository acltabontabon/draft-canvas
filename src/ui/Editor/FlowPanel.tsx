import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { displayNameFor } from '../../document/factory';
import { flowIsPlayable } from '../../document/flow';
import type { DraftFlow, DraftFlowStep } from '../../document/types';
import { isEditableTarget } from '../../lib/isEditableTarget';
import { documentWithLiveViewport, useEditorStore } from '../../store/editorStore';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { useUiStore } from '../../store/uiStore';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import { Button } from '../common/Button';

/**
 * The one surface for flows — a small story navigator, not a management dialog. Every row is a
 * flow; clicking one makes it the *active* flow (`selectedFlowId`: lens, step badges, and what a
 * connector's "Add to …" chip appends to). "Diagram" is a real first row, not an absence:
 * choosing it is how you leave a flow's lens. Names are edited in place (double-click, the
 * pencil, or F2), and a brand-new flow opens straight into its name field — naming is part of
 * creating, never a separate errand. Present, rename and delete stay out of the way until a row
 * is hovered or focused; the active row keeps its Present button showing, so the primary action
 * for "the flow I'm working on" is always one click. Expanding a row reveals its ordered steps.
 *
 * Keyboard: rows are focusable. Enter/Space selects, F2 renames, Delete/Backspace deletes,
 * ↑/↓ move between rows, Escape closes the panel. Handled here in React (not on `window`) and
 * stopped, so `EditorScreen`'s canvas shortcuts never see a key this panel consumed — but
 * unhandled keys fall through exactly as they would from any focused toolbar button.
 */
export function FlowPanel({ playback }: { playback: FlowPlaybackController }) {
  const open = useUiStore((state) => state.flowPanelOpen);
  const setOpen = useUiStore((state) => state.setFlowPanelOpen);
  const renameRequestId = useUiStore((state) => state.flowRenameRequestId);
  // Only while open: a closed panel has no reason to re-render on every drag frame.
  const document = useEditorStore((state) => (open ? state.document : null));
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const setSelectedFlowId = useEditorStore((state) => state.setSelectedFlowId);
  const selection = useEditorStore((state) => (open ? state.selection : null));
  const store = useEditorStore;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [toolsStepId, setToolsStepId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // A "new flow" made elsewhere (palette, a connector's chip) asks to be named here. One-shot:
  // consumed and cleared at once, so it can't re-fire on a remount — see `flowRenameRequestId`.
  useEffect(() => {
    if (!renameRequestId) return;
    useUiStore.getState().requestFlowRename(null);
    // oxlint-disable-next-line set-state-in-effect -- one-shot external command, see comment above.
    setRenamingId(renameRequestId);
    setExpandedId(renameRequestId);
  }, [renameRequestId]);

  // A keyboard user who opened the panel via the bare `F` shortcut otherwise has no idea how many
  // Tabs away it is — give it real focus the moment it appears. Skipped when this open is for a
  // fresh rename (a flow just created elsewhere): the rename `<input>`'s own `autoFocus` owns that
  // case instead, and stealing focus back to a row here would fight it.
  useEffect(() => {
    // `renameRequestId` alone isn't enough: it's a one-shot signal, cleared by the effect above on
    // the render right after this one fires, which would make *this* effect re-run on that very
    // next render and see it as falsy again — stealing focus back from the rename input its own
    // `autoFocus` had just placed it in. `renamingId` (the persistent local state that request
    // becomes) covers every render after the first; `renameRequestId` itself covers that first one,
    // before `renamingId` has had a chance to catch up.
    if (!open || renameRequestId || renamingId) return;
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.dc-flow-row') ?? []);
    // No flows yet: the panel shows its own empty state (prose + a "New flow" button) instead of
    // any `.dc-flow-row` at all — focus that button instead, so opening the panel this way is
    // never a dead end for a keyboard user with nothing to navigate to yet.
    const target = rows.length > 0 ? (rows.find((row) => row.dataset.selected === 'true') ?? rows[0]) : rootRef.current?.querySelector<HTMLElement>('.dc-flow-panel-empty button');
    target?.focus();
  }, [open, renameRequestId, renamingId]);

  if (!open || !document || !selection) return null;

  const nodes = nodeIndex(document.nodes);
  const edges = edgeIndex(document.edges);
  // A rename in progress on a flow that has since gone (undo) simply ends.
  const renaming = renamingId && document.flows.some((flow) => flow.id === renamingId) ? renamingId : null;

  const beginRename = (flowId: string) => {
    setSelectedFlowId(flowId);
    setExpandedId(flowId);
    setRenamingId(flowId);
  };

  const createNewFlow = () => {
    const id = store.getState().createFlow();
    if (!id) return;
    beginRename(id);
  };

  const present = (flow: DraftFlow) => {
    store.getState().setMode('present');
    playback.pickFlow(flow.id);
  };

  // Closing from inside the panel hands focus back to the toggle that opens it, rather than
  // dropping it to <body> when the panel unmounts.
  const closePanel = () => {
    const hadFocus = rootRef.current?.contains(window.document.activeElement) ?? false;
    setOpen(false);
    if (hadFocus) window.document.querySelector<HTMLElement>('.dc-flow-toggle')?.focus();
  };

  const rowElements = () =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.dc-flow-row') ?? []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (isEditableTarget(target)) return; // the rename field owns its own keys
    const row = target.closest<HTMLElement>('.dc-flow-row');
    const flowId = row?.dataset.flowId || null;
    const flow = flowId ? document.flows.find((f) => f.id === flowId) : undefined;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'Escape':
        consume();
        closePanel();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!row) return;
        const rows = rowElements();
        const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (!next) return;
        consume();
        next.focus();
        return;
      }
      case 'Enter':
      case ' ':
        // Only for the row itself — a focused button inside it activates on its own.
        if (!row || target !== row) return;
        consume();
        setSelectedFlowId(flowId);
        return;
      // The expand chevron is deliberately out of the Tab order, so its row answers for it — the
      // same Right-opens / Left-closes a disclosure tree uses.
      case 'ArrowRight':
      case 'ArrowLeft':
        if (!flow || target !== row) return;
        consume();
        setExpandedId(event.key === 'ArrowRight' ? flow.id : null);
        return;
      case 'F2':
        if (!flow) return;
        consume();
        beginRename(flow.id);
        return;
      case 'Delete':
      case 'Backspace':
        if (!flow) return;
        consume();
        store.getState().deleteFlow(flow.id);
        return;
      default:
        return;
    }
  };

  return (
    <div className="dc-flow-panel" role="region" aria-label="Flows" ref={rootRef} onKeyDown={onKeyDown}>
      <header className="dc-flow-panel-header">
        <strong>Flows</strong>
        {document.flows.length > 0 && (
          <Button variant="quiet" icon="plus" aria-label="New flow" title="New flow" onClick={createNewFlow} />
        )}
        <Button variant="quiet" icon="close" aria-label="Close" title="Close (Esc)" onClick={closePanel} />
      </header>

      {document.flows.length === 0 ? (
        <div className="dc-flow-panel-empty">
          <p>
            <strong>Tell a story through your diagram.</strong>
          </p>
          <p>
            A flow is an ordered path across connectors you've already drawn — a request, a payment, an
            event. Present it and each step lights up while the rest of the canvas quiets down.
          </p>
          <Button variant="solid" icon="plus" onClick={createNewFlow}>
            New flow
          </Button>
        </div>
      ) : (
        <ul className="dc-flow-list">
          <li
            className="dc-flow-row dc-flow-diagram"
            data-flow-id=""
            data-selected={selectedFlowId === null ? 'true' : undefined}
            aria-current={selectedFlowId === null ? 'true' : undefined}
            tabIndex={0}
          >
            <div className="dc-flow-item-head" onClick={() => setSelectedFlowId(null)}>
              <span className="dc-flow-expand-spacer" aria-hidden="true" />
              <button type="button" className="dc-flow-title" tabIndex={-1}>
                Diagram
              </button>
              <span className="dc-muted dc-flow-step-count">everything</span>
            </div>
          </li>
          {document.flows.map((flow) => {
            const expanded = expandedId === flow.id;
            const selected = selectedFlowId === flow.id;
            const playable = flowIsPlayable(document, flow);
            const count = flow.steps.length;
            return (
              <li
                key={flow.id}
                className="dc-flow-row dc-flow-item"
                data-flow-id={flow.id}
                data-selected={selected ? 'true' : undefined}
                aria-current={selected ? 'true' : undefined}
                aria-expanded={expanded}
                tabIndex={0}
              >
                <div className="dc-flow-item-head" onClick={() => setSelectedFlowId(flow.id)}>
                  <button
                    type="button"
                    className="dc-flow-expand"
                    tabIndex={-1}
                    aria-label={expanded ? 'Collapse' : 'Expand'}
                    aria-expanded={expanded}
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedId(expanded ? null : flow.id);
                    }}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                  {renaming === flow.id ? (
                    <FlowTitleInput
                      flow={flow}
                      onDone={(title) => {
                        if (title !== null) store.getState().renameFlow(flow.id, title);
                        setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="dc-flow-title"
                      tabIndex={-1}
                      // The title truncates, so the tooltip leads with the whole name.
                      title={`${flow.title} — double-click to rename`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedFlowId(flow.id);
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        beginRename(flow.id);
                      }}
                    >
                      {flow.title}
                    </button>
                  )}
                  <span className="dc-muted dc-flow-step-count">
                    {count === 0 ? 'no steps' : `${count} step${count === 1 ? '' : 's'}`}
                  </span>
                  <span className="dc-flow-item-actions">
                    <Button
                      variant="quiet"
                      icon="pencil"
                      aria-label={`Rename ${flow.title}`}
                      title="Rename (F2)"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRename(flow.id);
                      }}
                    />
                    <Button
                      variant="quiet"
                      icon="play"
                      className="dc-flow-present"
                      aria-label={`Present ${flow.title}`}
                      title={playable ? `Present ${flow.title}` : 'Add a step first'}
                      disabled={!playable}
                      onClick={(event) => {
                        event.stopPropagation();
                        present(flow);
                      }}
                    />
                    <Button
                      variant="quiet"
                      icon="trash"
                      aria-label={`Delete ${flow.title}`}
                      title="Delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        store.getState().deleteFlow(flow.id);
                      }}
                    />
                  </span>
                </div>

                {expanded && (
                  <ol className="dc-flow-steps">
                    {flow.steps.map((step, index) => (
                      <StepRow
                        key={step.id}
                        flow={flow}
                        step={step}
                        index={index}
                        nodes={nodes}
                        edges={edges}
                        toolsOpen={toolsStepId === step.id}
                        onToggleTools={() => setToolsStepId(toolsStepId === step.id ? null : step.id)}
                        canAddSelection={selection.nodes.length > 0 || selection.edges.length > 0}
                        addSelection={() => {
                          for (const nodeId of selection.nodes) {
                            store.getState().addFlowStepExtraNode(flow.id, step.id, nodeId);
                          }
                          for (const edgeId of selection.edges) {
                            store.getState().addFlowStepExtraEdge(flow.id, step.id, edgeId);
                          }
                        }}
                      />
                    ))}
                    {flow.steps.length === 0 && (
                      <li className="dc-flow-steps-empty">
                        No steps yet — select a connector on the canvas, then click{' '}
                        <strong>Add to {flow.title}</strong> in its popover.
                      </li>
                    )}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The in-place name field. Enter or leaving the field commits; Escape keeps the old name. The
 * cancel is tracked in a ref rather than state because `blur()` fires synchronously from the
 * Escape handler, before any re-render could carry a flag across.
 */
function FlowTitleInput({ flow, onDone }: { flow: DraftFlow; onDone: (title: string | null) => void }) {
  const cancelled = useRef(false);
  return (
    <input
      autoFocus
      className="dc-flow-title-input"
      aria-label="Flow name"
      defaultValue={flow.title}
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => onDone(cancelled.current ? null : event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

function StepRow({
  flow,
  step,
  index,
  nodes,
  edges,
  toolsOpen,
  onToggleTools,
  canAddSelection,
  addSelection,
}: {
  flow: DraftFlow;
  step: DraftFlowStep;
  index: number;
  nodes: ReturnType<typeof nodeIndex>;
  edges: ReturnType<typeof edgeIndex>;
  toolsOpen: boolean;
  onToggleTools: () => void;
  canAddSelection: boolean;
  addSelection: () => void;
}) {
  const store = useEditorStore;
  const edge = step.edgeId ? edges.get(step.edgeId) : undefined;
  if (step.edgeId && !edge) return null; // dangling — pruned on next edit, not shown meanwhile
  const source = edge ? nodes.get(edge.source) : undefined;
  const target = edge ? nodes.get(edge.target) : undefined;
  const extraNodes = (step.extraNodeIds ?? [])
    .map((id) => nodes.get(id))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));
  const extraEdges = (step.extraEdgeIds ?? [])
    .map((id) => edges.get(id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
  const detail = step.caption?.trim() || edge?.label?.trim();
  const hasExtras = extraNodes.length > 0 || extraEdges.length > 0 || step.viewport !== undefined;

  return (
    <li className="dc-flow-step-row-group">
      <div className="dc-flow-step-row">
        <span className="dc-flow-step-index">{index + 1}</span>
        <button
          type="button"
          className="dc-flow-step-label"
          title={
            edge
              ? `${source ? displayNameFor(source) : 'Untitled'} → ${target ? displayNameFor(target) : 'Untitled'}${detail ? ` · ${detail}` : ''} — select this connector`
              : detail
          }
          onClick={() => (edge ? store.getState().setSelection({ nodes: [], edges: [edge.id] }) : undefined)}
        >
          {edge ? (
            <>
              {source ? displayNameFor(source) : 'Untitled'}
              {' '}
              <span className="dc-flow-step-arrow">→</span>
              {' '}
              {target ? displayNameFor(target) : 'Untitled'}
            </>
          ) : extraNodes.length > 0 ? (
            extraNodes.map((n) => displayNameFor(n)).join(', ')
          ) : step.viewport ? (
            'Pinned view'
          ) : (
            'Empty step'
          )}
          {detail && (
            <>
              {' '}
              <em className="dc-flow-step-caption">{detail}</em>
            </>
          )}
        </button>
        <span className="dc-flow-step-actions">
          <Button
            icon="back"
            variant="quiet"
            aria-label="Move earlier"
            disabled={index === 0}
            onClick={() => store.getState().moveFlowStep(flow.id, step.id, -1)}
          />
          <Button
            icon="forward"
            variant="quiet"
            aria-label="Move later"
            disabled={index === flow.steps.length - 1}
            onClick={() => store.getState().moveFlowStep(flow.id, step.id, 1)}
          />
          <Button
            icon="more"
            variant="quiet"
            active={toolsOpen}
            aria-label="More for this step"
            title="Spotlight extra shapes, or pin the camera for this step"
            onClick={onToggleTools}
          />
          <Button
            icon="close"
            variant="quiet"
            aria-label="Remove step"
            onClick={() => store.getState().removeFlowStep(flow.id, step.id)}
          />
        </span>
      </div>

      {hasExtras && (
        <div className="dc-flow-step-extras">
          {extraNodes.map((node) => (
            <span key={node.id} className="dc-flow-step-chip">
              <span className="dc-flow-step-chip-label" title={displayNameFor(node)}>
                {displayNameFor(node)}
              </span>
              <Button
                icon="close"
                variant="quiet"
                aria-label={`Remove ${displayNameFor(node)} from step`}
                onClick={() => store.getState().removeFlowStepExtraNode(flow.id, step.id, node.id)}
              />
            </span>
          ))}
          {extraEdges.map((extraEdge) => {
            const extraSource = nodes.get(extraEdge.source);
            const extraTarget = nodes.get(extraEdge.target);
            return (
              <span key={extraEdge.id} className="dc-flow-step-chip">
                <span className="dc-flow-step-chip-label">
                  {extraSource ? displayNameFor(extraSource) : 'Untitled'} →{' '}
                  {extraTarget ? displayNameFor(extraTarget) : 'Untitled'}
                </span>
                <Button
                  icon="close"
                  variant="quiet"
                  aria-label="Remove connector from step"
                  onClick={() => store.getState().removeFlowStepExtraEdge(flow.id, step.id, extraEdge.id)}
                />
              </span>
            );
          })}
          {step.viewport && (
            <span className="dc-flow-step-chip">
              <span className="dc-flow-step-chip-label">Pinned view</span>
              <Button
                icon="close"
                variant="quiet"
                aria-label="Clear this step's saved view"
                onClick={() => store.getState().setFlowStepViewport(flow.id, step.id, null)}
              />
            </span>
          )}
        </div>
      )}

      {toolsOpen && (
        <div className="dc-flow-step-tools">
          {/* No aria-label: the visible words are the name, so speech control users can say them. */}
          <Button
            variant="quiet"
            title="Spotlight whatever is selected on the canvas during this step"
            disabled={!canAddSelection}
            onClick={addSelection}
          >
            + Selection
          </Button>
          <Button
            variant="quiet"
            title="Present this step from exactly the current camera position"
            onClick={() => store.getState().setFlowStepViewport(flow.id, step.id, documentWithLiveViewport(store.getState()).viewport)}
          >
            {step.viewport ? 'Update pinned view' : 'Pin view'}
          </Button>
        </div>
      )}
    </li>
  );
}
