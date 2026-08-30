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
                    const edge = edges.get(step.edgeId);
                    if (!edge) return null;
                    const source = nodes.get(edge.source);
                    const target = nodes.get(edge.target);
                    return (
                      <li key={step.id} className="dc-flow-step-row">
                        <span className="dc-flow-step-index">{index + 1}</span>
                        <span
                          className="dc-flow-step-label"
                          onClick={() =>
                            store.getState().setSelection({ nodes: [], edges: [edge.id] })
                          }
                        >
                          {source?.text || 'Untitled'} → {target?.text || 'Untitled'}
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
