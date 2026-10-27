import { useTrafficReplay } from './TrafficReplayContext';
import { layoutText } from '../render/text/layout';
import { Panel, useStore } from '@xyflow/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { trafficOf } from '../store/traffic';
import { DEFAULT_TRAFFIC_RATE } from '../traffic/scenario';

/** A ready-to-use example, kept outside the zooming drawing so its controls remain readable. */
export function TrafficScenario() {
  const analysis = useEditorStore(trafficOf);
  const { replay, clearReplay } = useTrafficReplay();
  const hasReplay = !!analysis && replay?.analysis === analysis;
  const [expanded, setExpanded] = useState(false);
  const helpId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const canvasWidth = useStore((state) => state.width);
  const help = useMemo(() => [
    'Example only: 1,000 starts/min at each entry, not live measurements.',
    'Each drawn call runs once per arrival.',
    'Ranges show unknown shares; their peaks may not happen together. Loops have no rate estimate.',
    'Retries, failure paths and background work are excluded. No latency or capacity predictions.',
  ].map((text) => layoutText(text, {
    font: { stack: 'sans', size: 12, weight: 400 },
    maxWidth: Math.max(120, Math.min(320, canvasWidth - 32) - 36), lineHeight: 18,
  }).lines.map((line) => line.text)), [canvasWidth]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [expanded]);
  if (!analysis || (analysis.status !== 'ok' && !hasReplay)) return null;
  const rate = DEFAULT_TRAFFIC_RATE.toLocaleString('en-US');
  return (
    <Panel ref={root} position="bottom-left" className="dc-traffic-scenario nodrag nopan nowheel" aria-label="Traffic scenario" data-dc-keyboard-region="" data-expanded={expanded || undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        trigger.current?.focus();
      }}
    >
      <div className="dc-traffic-scenario-row">
        <span className="dc-traffic-scenario-rate">{analysis.status === 'ok' ? `Example · ${rate} starts/min per entry` : 'Recovery example'}</span>
        {hasReplay && <button type="button" onClick={() => {
          clearReplay();
          trigger.current?.focus();
        }}>Clear replay</button>}
        <button ref={trigger} type="button" aria-expanded={expanded} aria-controls={helpId} onClick={() => setExpanded(!expanded)}>
          How to read this
        </button>
      </div>
      {expanded && (
        <div id={helpId} className="dc-traffic-scenario-help" role="region" aria-label="Traffic reading guide" tabIndex={0}>
          {help.map((lines, index) => <p key={index}>{lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}{index < lines.length - 1 ? ' ' : ''}</span>)}</p>)}
        </div>
      )}
    </Panel>
  );
}
