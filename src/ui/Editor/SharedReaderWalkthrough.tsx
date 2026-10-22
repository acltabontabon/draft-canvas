import { useEffect, useId, useRef, useState } from 'react';
import type { DraftFlow } from '../../document/types';
import type { StepStory } from '../../presentation/flowChrome';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

/** Manual navigation stays below the canvas; the complete step list opens only when requested. */
export function SharedReaderWalkthrough({ flow, stories, playback, availableHeight, onJump, onNext, onPrevious }: {
  flow: DraftFlow; stories: StepStory[]; playback: FlowPlaybackController; availableHeight: number;
  onJump: (step: number) => void; onNext: () => void; onPrevious: () => void;
}) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const panelId = useId();
  const bar = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const story = playback.current ? stories[playback.step - 1] : undefined;
  const complete = playback.stage === 'closing';
  const closeSteps = () => { setStepsOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!stepsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as Node)) setStepsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Dismiss this nested selector before the reader handles Escape for attachments or Contents.
      event.preventDefault();
      event.stopImmediatePropagation();
      setStepsOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [stepsOpen]);

  return (
    <section className="dc-reader-narrative" aria-label="Flow walkthrough" ref={bar}>
      {stepsOpen && <section className="dc-reader-step-menu" id={panelId} aria-label="Walkthrough steps" style={{ maxHeight: Math.min(420, Math.max(80, availableHeight - 16)) }}>
        <header><h2>Walkthrough</h2><Button icon="close" variant="quiet" aria-label="Close steps" onClick={closeSteps} /></header>
        {playback.flows.length > 1 ? <label className="dc-field"><span>Flow</span><select value={flow.id} onChange={(event) => { playback.pickFlow(event.target.value); setStepsOpen(false); }}>{playback.flows.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label> : <p className="dc-reader-flow-title">{flow.title}</p>}
        <ol className="dc-reader-steps">{stories.map((entry, index) => <li key={index}><button type="button" aria-current={playback.current && playback.step === index + 1 ? 'step' : undefined} onClick={() => { onJump(index + 1); closeSteps(); }}><span className="dc-reader-step-number">{index + 1}</span><span>{entry.caption || entry.headline}</span></button></li>)}</ol>
      </section>}
      <div className="dc-reader-story" aria-live="polite"><h2>{story?.headline || (complete ? 'Walkthrough complete' : flow.title)}</h2><p>{story?.caption || (complete ? 'Start again or explore the diagram.' : 'Move through the steps at your own pace.')}</p></div>
      <div className="dc-reader-player">
        <Button className="dc-reader-step-trigger" ref={trigger} aria-label="Browse walkthrough steps" aria-expanded={stepsOpen} aria-controls={panelId} onClick={() => setStepsOpen(!stepsOpen)}><span className="dc-reader-position">{playback.current ? `${playback.step} / ${stories.length}` : complete ? `${stories.length} / ${stories.length}` : `${stories.length} ${stories.length === 1 ? 'step' : 'steps'}`}</span><Icon name={stepsOpen ? 'down' : 'up'} size={12} /></Button>
        <div><Button icon="back" title="Previous step (←)" disabled={!playback.active || playback.stage === 'opening'} onClick={() => { setStepsOpen(false); onPrevious(); }}>Back</Button><Button variant="solid" title="Next step (→)" onClick={() => { setStepsOpen(false); onNext(); }}>{complete ? 'Start again' : !playback.current ? 'Start walkthrough' : playback.step === stories.length ? 'Finish' : 'Next'}<Icon name="forward" size={13} /></Button></div>
      </div>
    </section>
  );
}
