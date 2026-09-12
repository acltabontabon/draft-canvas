import type { GifSpeed } from '../../export';

interface AnimatedPanelProps {
  flows: { id: string; title: string }[];
  flowId: string;
  onFlowChange: (id: string) => void;
  speed: GifSpeed;
  onSpeedChange: (speed: GifSpeed) => void;
  loop: boolean;
  onLoopChange: (loop: boolean) => void;
}

export function ExportAnimatedPanel({
  flows,
  flowId,
  onFlowChange,
  speed,
  onSpeedChange,
  loop,
  onLoopChange,
}: AnimatedPanelProps) {
  if (flows.length === 0) {
    return (
      <div className="dc-export-panel">
        <p className="dc-export-panel-description">Add a Flow to enable this export.</p>
      </div>
    );
  }

  return (
    <div className="dc-export-panel">
      <div className="dc-export-row">
        {flows.length > 1 && (
          <label className="dc-export-field">
            <span>Flow</span>
            <select className="dc-select" value={flowId} onChange={(event) => onFlowChange(event.target.value)}>
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="dc-export-field">
          <span>Speed</span>
          <select
            className="dc-select"
            value={speed}
            onChange={(event) => onSpeedChange(event.target.value as GifSpeed)}
          >
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </label>
      </div>

      <label className="dc-check">
        <input type="checkbox" checked={loop} onChange={(event) => onLoopChange(event.target.checked)} />
        <span>Loop continuously</span>
      </label>

      <p className="dc-export-panel-description">
        GIF walkthrough of the Flow's steps — camera moves, connectors pulse.
      </p>
    </div>
  );
}
