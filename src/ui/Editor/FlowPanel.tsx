import { useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { useUiStore } from '../../store/uiStore';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import { Button } from '../common/Button';

/**
 * The Flow drawer: create/rename/delete flows, see and reorder their steps,
 * and jump straight into presenting one. Deliberately small and dismissible —
 * the canvas, not this panel, is the diagram.
 */
export function FlowPanel({ playback }: { playback: FlowPlaybackController }) {
  const open = useUiStore((state) => state.flowPanelOpen);
  const setOpen = useUiStore((state) => state.setFlowPanelOpen);
  const document = useEditorStore((state) => state.document);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const setSelectedFlowId = useEditorStore((state) => state.setSelectedFlowId);
  const selection = useEditorStore((state) => state.selection);
  const store = useEditorStore;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!open) return null;

  const nodes = nodeIndex(document.nodes);
  const edges = edgeIndex(document.edges);

  return (
    <div className="dc-flow-panel" role="region" aria-label="Flows">
      <header className="dc-flow-panel-header">
        <strong>Flows</strong>
        <Button
          variant="quiet"
          icon="plus"
          aria-label="New flow"
          onClick={() => {
            const id = store.getState().createFlow();
            setSelectedFlowId(id);
            setExpandedId(id);
          }}
        />
        <Button variant="quiet" icon="close" aria-label="Close" onClick={() => setOpen(false)} />
      </header>

      {document.flows.length === 0 && (
        <p className="dc-muted dc-flow-panel-empty">
          No flows yet. Select a connector and add it to a new flow from the Inspector.
        </p>
      )}

      <ul className="dc-flow-list">
        {document.flows.map((flow) => {
          const expanded = expandedId === flow.id;
          return (
            <li
              key={flow.id}
              className="dc-flow-item"
              data-selected={selectedFlowId === flow.id ? 'true' : undefined}
            >
              <div className="dc-flow-item-head" onClick={() => setSelectedFlowId(flow.id)}>
                <button
                  type="button"
                  className="dc-flow-expand"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpandedId(expanded ? null : flow.id);
                  }}
                  aria-label={expanded ? 'Collapse' : 'Expand'}
                >
                  {expanded ? '▾' : '▸'}
                </button>
                <input
                  className="dc-flow-title-input"
                  defaultValue={flow.title}
                  onBlur={(event) => store.getState().renameFlow(flow.id, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
                <span className="dc-muted dc-flow-step-count">{flow.steps.length} steps</span>
                <Button
                  variant="quiet"
                  icon="play"
                  aria-label={`Present ${flow.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    store.getState().setMode('present');
                    playback.pickFlow(flow.id);
                  }}
                />
                <Button
                  variant="quiet"
                  icon="trash"
                  aria-label={`Delete ${flow.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    store.getState().deleteFlow(flow.id);
                  }}
                />
              </div>

              {expanded && (
                <ol className="dc-flow-steps">
                  {flow.steps.map((step, index) => {
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

                    const canAddSelection = selection.nodes.length > 0 || selection.edges.length > 0;

                    return (
                      <li key={step.id} className="dc-flow-step-row-group">
                        <div className="dc-flow-step-row">
                          <span className="dc-flow-step-index">{index + 1}</span>
                          <span
                            className="dc-flow-step-label"
                            onClick={() =>
                              edge
                                ? store.getState().setSelection({ nodes: [], edges: [edge.id] })
                                : undefined
                            }
                          >
                            {edge
                              ? `${source?.text || 'Untitled'} → ${target?.text || 'Untitled'}`
                              : extraNodes.length > 0
                                ? extraNodes.map((n) => n.text || 'Untitled').join(', ')
                                : step.viewport
                                  ? 'Custom view'
                                  : 'Empty step'}
                            {step.caption && <em className="dc-flow-step-caption"> — {step.caption}</em>}
                          </span>
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
                            icon="close"
                            variant="quiet"
                            aria-label="Remove step"
                            onClick={() => store.getState().removeFlowStep(flow.id, step.id)}
                          />
                        </div>

                        {(extraNodes.length > 0 || extraEdges.length > 0) && (
                          <div className="dc-flow-step-extras">
                            {extraNodes.map((node) => (
                              <span key={node.id} className="dc-flow-step-chip">
                                {node.text || 'Untitled'}
                                <Button
                                  icon="close"
                                  variant="quiet"
                                  aria-label={`Remove ${node.text || 'node'} from step`}
                                  onClick={() =>
                                    store.getState().removeFlowStepExtraNode(flow.id, step.id, node.id)
                                  }
                                />
                              </span>
                            ))}
                            {extraEdges.map((extraEdge) => (
                              <span key={extraEdge.id} className="dc-flow-step-chip">
                                {nodes.get(extraEdge.source)?.text || 'Untitled'} →{' '}
                                {nodes.get(extraEdge.target)?.text || 'Untitled'}
                                <Button
                                  icon="close"
                                  variant="quiet"
                                  aria-label="Remove connector from step"
                                  onClick={() =>
                                    store.getState().removeFlowStepExtraEdge(flow.id, step.id, extraEdge.id)
                                  }
                                />
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="dc-flow-step-tools">
                          <Button
                            variant="quiet"
                            aria-label="Add current selection to this step"
                            disabled={!canAddSelection}
                            onClick={() => {
                              for (const nodeId of selection.nodes) {
                                store.getState().addFlowStepExtraNode(flow.id, step.id, nodeId);
                              }
                              for (const edgeId of selection.edges) {
                                store.getState().addFlowStepExtraEdge(flow.id, step.id, edgeId);
                              }
                            }}
                          >
                            + Add selection
                          </Button>
                          <Button
                            variant="quiet"
                            aria-label="Save the current canvas view to this step"
                            onClick={() =>
                              store.getState().setFlowStepViewport(flow.id, step.id, document.viewport)
                            }
                          >
                            {step.viewport ? 'Update view' : 'Set view'}
                          </Button>
                          {step.viewport && (
                            <Button
                              variant="quiet"
                              aria-label="Clear this step's saved view"
                              onClick={() => store.getState().setFlowStepViewport(flow.id, step.id, null)}
                            >
                              Clear view
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {flow.steps.length === 0 && (
                    <li className="dc-muted dc-flow-panel-empty">
                      No steps yet — select a connector on the canvas and add it from the Inspector.
                    </li>
                  )}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
