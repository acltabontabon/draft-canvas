import { layoutText } from '../render/text/layout';
import { Panel, useStore } from '@xyflow/react';
import { useMemo, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { trafficOf } from '../store/traffic';
import { DEFAULT_TRAFFIC_RATE } from '../traffic/scenario';

/** A ready-to-use example, kept outside the zooming drawing so its controls remain readable. */
export function TrafficScenario() {
  const analysis = useEditorStore(trafficOf);
  const [expanded, setExpanded] = useState(false);
  const canvasWidth = useStore((state) => state.width);
  const help = useMemo(() => [
    'A round example, not measured traffic or capacity. Each entry starts at the same rate.',
    'Each drawn call runs once per arrival. Unknown shares stay ranges; branch maxima need not occur together. Loops have no rate estimate.',
    'Retries, failure paths and background work are excluded. Select a shape to see its sources and the work caused by one arrival.',
  ].map((text) => layoutText(text, {
    font: { stack: 'sans', size: 12, weight: 400 }, maxWidth: Math.max(100, Math.min(390, canvasWidth - 80)), lineHeight: 18,
  }).lines.map((line) => line.text)), [canvasWidth]);
  if (!analysis || analysis.status !== 'ok') return null;
  const rate = DEFAULT_TRAFFIC_RATE.toLocaleString('en-US');
  return (
    <Panel position="bottom-center" className="dc-traffic-scenario nodrag nopan nowheel" aria-label="Traffic scenario" data-dc-keyboard-region="">
      <div className="dc-traffic-scenario-row">
        <div>
          <span className="dc-traffic-scenario-caption">Illustrative traffic</span>
          <strong role="status">{rate} starts/min per entry</strong>
        </div>
        <button type="button" aria-expanded={expanded} aria-label="Traffic assumptions" onClick={() => setExpanded(!expanded)}>Assumptions</button>
      </div>
      <p className="dc-traffic-scenario-prompt">Select a shape. Follow the work.</p>
      {expanded && (
        <div className="dc-traffic-scenario-help">
          {help.map((lines, index) => <p key={index}>{lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</p>)}
        </div>
      )}
    </Panel>
  );
}
