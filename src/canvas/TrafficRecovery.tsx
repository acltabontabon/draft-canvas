import { useMemo, useState } from 'react';
import type { DraftNode } from '../document/types';
import { displayNameFor } from '../document/factory';
import { familyOf } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import { useEditorStore } from '../store/editorStore';
import type { TrafficAnalysis } from '../traffic';
import { MAX_REPLAY_MESSAGES, recoveryWork, type recoveryPlan } from '../traffic/recovery';

/** A deliberately local what-if: neither the pending count nor exploring recovery edits a file. */
export function TrafficRecovery({ analysis, nodes, plan, width, onExplore }: {
  analysis: TrafficAnalysis;
  nodes: readonly DraftNode[];
  plan: NonNullable<ReturnType<typeof recoveryPlan>>;
  width: number;
  onExplore: (count: number | null) => void;
}) {
  const [pending, setPending] = useState('1');
  const count = /^\d+$/.test(pending) ? Number(pending) : NaN;
  const result = useMemo(() => recoveryWork(analysis, plan, count), [analysis, plan, count]);
  const text = (value: string) => layoutText(value, {
    font: { stack: 'sans', size: 12, weight: 400 }, maxWidth: width - 16, lineHeight: 18,
  }).lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line.text}{' '}</span>);
  const name = (id: string) => {
    const node = nodes.find((item) => item.id === id);
    return node ? displayNameFor(node) : 'Untitled';
  };
  return (
    <details className="dc-traffic-work dc-traffic-recovery" onToggle={(event) => { if (event.currentTarget.open && plan.kind === 'replay') onExplore(count); }}>
      <summary style={{ fontFamily: familyOf('hand') }}>Recovery work</summary>
      <div className="dc-traffic-work-paper">
        {plan.kind === 'replay' && !plan.missing && (
          <label className="dc-traffic-replay-count">
            Messages to replay
            <input aria-label="Messages to replay" inputMode="numeric" value={pending} onChange={(event) => { setPending(event.target.value); onExplore(/^\d+$/.test(event.target.value) ? Number(event.target.value) : null); }}
              onBlur={() => { if (pending === '') { setPending('1'); onExplore(1); } }} aria-invalid={!result || undefined} />
          </label>
        )}
        {count !== 0 && <p>{text(plan.kind === 'replay' ? 'If each message is replayed once. Totals, not a rate.' : 'For one compensation attempt. Which actions apply depends on what completed before failure.')}</p>}
        {!result ? <p role="alert">{text(`Enter a whole number from 0 to ${MAX_REPLAY_MESSAGES.toLocaleString('en-US')}.`)}</p> : (
          <ul aria-label="Recovery totals" aria-live="polite">
            {result.items.map((item) => <li key={item}>{text(item)}</li>)}
          </ul>
        )}
        {plan.missing ? <p>{text('Draw a consumer or replay route out of this DLQ to follow its work.')}</p> : count !== 0 && (
          <>
            <p>{text(`Starts with ${plan.targets.slice(0, 3).map(name).join(', ')}${plan.targets.length > 3 ? ` +${plan.targets.length - 3} more` : ''}.`)}</p>
            <p>{text('Drain time unknown. Retries and new failures may add more work.')}</p>
            {result?.uncertain && !result.unknown && <p>{text('Unknown branch shares stay ranges; their peaks may not happen together.')}</p>}
          </>
        )}
        {count !== 0 && plan.shared.length > 0 && (
          <div className="dc-traffic-recovery-shared">
            <p>{text('Also used by normal work')}</p>
            {plan.shared.slice(0, 3).map((id) => (
              <button key={id} type="button" onClick={() => useEditorStore.getState().setSelection({ nodes: [id], edges: [] })}>{text(name(id))}</button>
            ))}
            {plan.shared.length > 3 && <p>+ {plan.shared.length - 3} more</p>}
          </div>
        )}
      </div>
    </details>
  );
}
