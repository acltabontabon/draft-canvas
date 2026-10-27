import { familyOf } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import { Panel, useStore } from '@xyflow/react';
import { useId, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { trafficOf } from '../store/traffic';
import { DEFAULT_TRAFFIC_RATE } from '../traffic/scenario';

/** A ready-to-use example, kept outside the zooming drawing so its controls remain readable. */
export function TrafficScenario() {
  const analysis = useEditorStore(trafficOf);
  const [expanded, setExpanded] = useState(false);
  const helpId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const canvasWidth = useStore((state) => state.width);
  const help = useMemo(() => {
    const width = Math.max(160, Math.min(400, canvasWidth - 24) - 26);
    const lines = (text: string, maxWidth: number, hand = false) => layoutText(text, {
      font: { stack: hand ? 'hand' : 'sans', size: hand ? 17 : 12, weight: hand ? 700 : 400 },
      maxWidth, lineHeight: hand ? 22 : 18,
    }).lines.map((line) => line.text);
    return {
      notes: [
        ['Start with an example', 'Each entry starts at 1,000 arrivals a minute. These are example numbers, not live measurements.'],
        ['Follow one arrival', 'Each drawn call happens once per arrival. Select a shape to see where its work comes from.'],
        ['Leave room for the unknown', 'Ranges mean a branch may be taken. Their highest values may not happen together. Loops have no estimate.'],
      ].map(([title, body]) => ({ title: lines(title!, width - 36, true), body: lines(body!, width - 36) })),
      footer: lines('Retries, failure paths and background work are left out. Traffic does not predict response times or set performance targets.', width),
    };
  }, [canvasWidth]);
  if (!analysis || analysis.status !== 'ok') return null;
  const rate = DEFAULT_TRAFFIC_RATE.toLocaleString('en-US');
  return (
    <Panel position="bottom-center" className="dc-traffic-scenario nodrag nopan nowheel" aria-label="Traffic scenario" data-dc-keyboard-region="" data-expanded={expanded || undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        trigger.current?.focus();
      }}
    >
      <div className="dc-traffic-scenario-row">
        <div>
          <span className="dc-traffic-scenario-caption">Illustrative traffic</span>
          <strong role="status">{rate} starts/min per entry</strong>
        </div>
        <button ref={trigger} type="button" aria-expanded={expanded} aria-controls={helpId} onClick={() => setExpanded(!expanded)}>
          How to read this <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
        </button>
      </div>
      <p className="dc-traffic-scenario-prompt">Select a shape. Follow the work.</p>
      {expanded && (
        <div id={helpId} className="dc-traffic-scenario-help" role="region" aria-label="Traffic reading guide" tabIndex={0}>
          <ol>
            {help.notes.map((note, index) => (
              <li key={index}>
                <span className="dc-traffic-guide-number" aria-hidden="true" style={{ fontFamily: familyOf('hand') }}>{index + 1}</span>
                <div>
                  <h3 style={{ fontFamily: familyOf('hand') }}>{note.title.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</h3>
                  <p>{note.body.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="dc-traffic-guide-footer">{help.footer.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</p>
        </div>
      )}
    </Panel>
  );
}
