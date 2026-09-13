import { useEffect } from 'react';
import { displayNameFor } from '../../document/factory';
import { isActivatableTarget, isEditableTarget } from '../../lib/isEditableTarget';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { describePresentationSubject, resolvePresentationSubject } from '../../presentation/presentationAttachments';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { tokenizeCode } from '../../render/code/highlight';
import { CODE_THEMES, colorForScope } from '../../render/code/theme';
import { useTheme } from '../theme/useTheme';
import type { FlowPlaybackController } from '../../presentation/useFlowPlayback';
import { Button } from '../common/Button';

/**
 * Presentation Mode's control. Present while playing a flow, and the only
 * chrome visible in presentation mode — the canvas itself carries the story.
 */
export function FlowBar({ playback }: { playback: FlowPlaybackController }) {
  // Only while presenting — the bar isn't shown otherwise, so it needn't follow every edit.
  const document = useEditorStore((state) => (playback.active ? state.document : null));
  const mode = useEditorStore((state) => state.mode);
  const reveal = useUiStore((state) => (playback.active ? state.presentationReveal : null));
  const setMode = useEditorStore((state) => state.setMode);

  useEffect(() => {
    if (!playback.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // No editable surface is actually reachable while presenting today, but every other
      // shortcut listener in the app guards against one the same way (`EditorScreen.tsx`) — kept
      // consistent here as defense-in-depth for whatever's added next.
      if (isEditableTarget(event.target)) return;
      // Escape is deliberately NOT handled here — `EditorScreen.tsx`'s own central Escape
      // cascade already stops playback (and exits present mode) whenever `playback.active` is
      // true, which covers `picking` too (a `flowId === null` sub-state of `active`, not a
      // separate one). A second listener here used to race it; one owner is enough.
      if (playback.picking) return;
      // Space on a focused bar button (Previous, Exit…) is that button's click, not "next".
      if (event.key === ' ' && isActivatableTarget(event.target)) return;
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        playback.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        playback.previous();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [playback]);

  // A presenter's reveal (a chip or badge clicked while presenting — see `presentationReveal`) is
  // scoped to the step it was made on, and to the presentation itself: stepping, starting or
  // stopping a flow, or leaving presentation all let it go, so nothing stray resurfaces later.
  useEffect(() => {
    useUiStore.getState().setPresentationReveal(null);
  }, [playback.step, playback.flow?.id, playback.active, mode]);

  if (!playback.active) return null;

  if (playback.picking) {
    return (
      <div className="dc-explain dc-flow-picker" role="region" aria-label="Choose a flow">
        <div className="dc-explain-bar">
          <span className="dc-explain-count">Present which flow?</span>
          <span className="dc-inspector-divider" />
          {playback.flows.map((flow) => (
            <Button key={flow.id} variant="ghost" onClick={() => playback.pickFlow(flow.id)}>
              {flow.title}
            </Button>
          ))}
          <span className="dc-inspector-divider" />
          <Button
            variant="quiet"
            onClick={() => {
              playback.stop();
              if (mode === 'present') setMode('edit');
            }}
          >
            Exit
          </Button>
        </div>
      </div>
    );
  }

  if (!playback.current || !playback.flow || !document) return null;

  const nodes = nodeIndex(document.nodes);
  const primary = playback.current.edge;
  const source = primary ? nodes.get(primary.source) : undefined;
  const target = primary ? nodes.get(primary.target) : undefined;
  const details = primary?.details;
  const caption = playback.current.caption || primary?.label;
  const condition = primary?.condition;
  // What the step's callout shows (`PresentationCalloutLayer`), folded into the one announcement.
  const spoken = resolvePresentationSubject({
    flowId: playback.flow.id,
    steps: playback.steps,
    step: playback.step,
    nodesById: nodes,
    edgesById: edgeIndex(document.edges),
    reveal,
  });

  return (
    <div className="dc-explain" role="region" aria-label="Flow playback">
      {details && <DetailPanel language={details.language} code={details.code} />}

      {/* The bar changes in place as the presenter steps, which a screen reader wouldn't notice. */}
      <span className="dc-sr-only" role="status">
        {`Step ${playback.step} of ${playback.steps.length}: ${
          primary
            ? `${source ? displayNameFor(source) : 'Untitled'} to ${target ? displayNameFor(target) : 'Untitled'}`
            : playback.current.extraNodes.map((n) => displayNameFor(n)).join(', ')
        }${caption ? `. ${caption}` : ''}${spoken ? `. ${describePresentationSubject(spoken)}` : ''}`}
      </span>
      <div className="dc-explain-bar">
        <span className="dc-explain-flow-title">{playback.flow.title}</span>
        <span className="dc-explain-count">
          Step {playback.step} / {playback.steps.length}
        </span>
        <span className="dc-flow-dots" aria-hidden="true">
          {playback.steps.map((step) => (
            <span
              key={step.step}
              className="dc-flow-dot"
              data-filled={step.step <= playback.step ? 'true' : undefined}
            />
          ))}
        </span>
        {primary ? (
          <span className="dc-explain-flow">
            <strong>{source ? displayNameFor(source) : 'Untitled'}</strong>
            <span className="dc-explain-arrow" aria-hidden="true">
              →
            </span>
            <strong>{target ? displayNameFor(target) : 'Untitled'}</strong>
          </span>
        ) : (
          playback.current.extraNodes.length > 0 && (
            <span className="dc-explain-flow">
              <strong>
                {playback.current.extraNodes.map((n) => displayNameFor(n)).join(', ')}
              </strong>
            </span>
          )
        )}
        {caption && (
          <span className="dc-explain-caption" title={caption}>
            {caption}
          </span>
        )}
        {condition && <span className="dc-explain-condition">[{condition}]</span>}
        <span className="dc-inspector-divider" />
        <Button
          icon="back"
          variant="quiet"
          aria-label="Previous step"
          disabled={playback.step <= 1}
          onClick={playback.previous}
        />
        <Button
          icon="forward"
          variant="quiet"
          aria-label="Next step"
          disabled={playback.step >= playback.steps.length}
          onClick={playback.next}
        />
        <Button
          variant="quiet"
          onClick={() => {
            playback.stop();
            if (mode === 'present') setMode('edit');
          }}
        >
          Exit
        </Button>
      </div>
    </div>
  );
}

/**
 * Expandable technical detail attached to a connection — a payload, a header
 * block, an error. It stays out of the canvas so the diagram remains readable,
 * and appears only for the step being explained.
 */
function DetailPanel({ language, code }: { language: Parameters<typeof tokenizeCode>[1]; code: string }) {
  const { name } = useTheme();
  const theme = CODE_THEMES[name];
  const lines = tokenizeCode(code, language);

  return (
    <div className="dc-explain-detail">
      <pre>
        <code>
          {lines.map((line, index) => (
            <span className="dc-code-line" key={index}>
              {line.length === 0 ? (
                '\n'
              ) : (
                <>
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: colorForScope(theme, token.scope) }}>
                      {token.text}
                    </span>
                  ))}
                  {'\n'}
                </>
              )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
