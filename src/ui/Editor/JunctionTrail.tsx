import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { stepTrail, trailState } from '../../commands/junctions';
import type { CommandContext } from '../../commands/types';
import { nodeIndex } from '../../store/selectors';
import { junctionOf } from '../../junctions/groups';
import { EMPTY_TRAIL } from '../../junctions/trail';
import { fileOf, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Icon } from '../common/Icon';
import { Tooltip, TooltipGroup } from '../common/Tooltip';

/**
 * The way back from following a Junction, and forward again.
 *
 * It exists only while there is somewhere to go: nothing is added to the canvas until a Junction
 * has been followed, and Close forgets the trail and takes the bar with it. Each button says where
 * it leads. It stays through a presentation, where it is how a presenter returns to the story,
 * and steps back with the rest of the chrome when Appearance takes the editor over (`data-studio`).
 */
export function JunctionTrail({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const documentId = useEditorStore((state) => state.document.metadata.id);
  const trail = useUiStore((state) => state.junctionTrail);
  const presenting = useEditorStore((state) => state.mode === 'present');
  // A trail laid in another diagram is not this one's: it is dropped as soon as this one is on screen.
  useEffect(() => {
    if (trail.documentId !== null && trail.documentId !== documentId) useUiStore.getState().setJunctionTrail(EMPTY_TRAIL);
  }, [trail.documentId, documentId]);

  const { back, forward } = trailState({ editor: useEditorStore.getState(), ui: useUiStore.getState() });
  if (!back && !forward) return null;

  return (
    <nav className="dc-junction-trail" aria-label="Junction history" data-presenting={presenting ? 'true' : undefined}>
      <TooltipGroup>
        <Tooltip content={{ title: back ? `Back to ${back.label}` : 'Nothing to go back to', shortcut: 'Shift G' }}>
          {(tip) => (
            <button type="button" className="dc-junction-trail-step" {...tip} disabled={!back} aria-label={back ? `Go back to ${back.label}` : 'Go back'} onClick={() => void stepTrail(buildCommandContext(), -1)}>
              <Icon name="arrowLeft" size={14} />
              {back && <span className="dc-junction-trail-label">{back.label}</span>}
            </button>
          )}
        </Tooltip>
        <Tooltip content={{ title: forward ? `Forward to ${forward.label}` : 'Nothing to go forward to', shortcut: 'Alt G' }}>
          {(tip) => (
            <button type="button" className="dc-junction-trail-step" {...tip} disabled={!forward} aria-label={forward ? `Go forward to ${forward.label}` : 'Go forward'} onClick={() => void stepTrail(buildCommandContext(), 1)}>
              {/* With nowhere back to go, forward is the one way there is, and says where it leads. */}
              {forward && !back && <span className="dc-junction-trail-label">{forward.label}</span>}
              <Icon name="forward" size={14} />
            </button>
          )}
        </Tooltip>
        <Tooltip content={{ title: 'Forget where I have been' }}>
          {(tip) => (
            <button type="button" className="dc-junction-trail-close" {...tip} aria-label="Close junction history" onClick={() => useUiStore.getState().setJunctionTrail(EMPTY_TRAIL)}>
              <Icon name="close" size={12} />
            </button>
          )}
        </Tooltip>
      </TooltipGroup>
    </nav>
  );
}

/**
 * A counterpart in hand: says what the next click will do, and draws the Junction under the pointer
 * so where it will land is seen before it is put down. Written to the DOM directly — a pointer
 * move must not become a React render — and removed the moment the placing ends.
 */
export function JunctionPlacing() {
  const placing = useUiStore((state) => state.junctionPlacing);
  const document = useEditorStore((state) => state.document);
  const path = useEditorStore((state) => state.path);
  const outer = useEditorStore((state) => state.outer);
  const { getZoom } = useReactFlow();
  const ghostRef = useRef<HTMLSpanElement>(null);

  // Where the source is drawn, or anywhere else in the file: the user may have changed rooms.
  const source = placing ? (nodeIndex(document.nodes).get(placing.sourceId) ?? junctionOf(fileOf({ document, path, outer }), placing.sourceId)?.node) : undefined;

  // The Junction it was to be linked to is gone: there is nothing left to place.
  useEffect(() => {
    if (placing && !source) useUiStore.getState().setJunctionPlacing(null);
  }, [placing, source]);

  const size = source ? Math.max(source.width, source.height) : 0;
  useEffect(() => {
    if (!placing || !size) return;
    const onMove = (event: PointerEvent) => {
      const ghost = ghostRef.current;
      if (!ghost) return;
      const over = event.target instanceof Element && event.target.closest('.react-flow__pane, .react-flow__node') !== null;
      const drawn = size * getZoom();
      ghost.style.opacity = over ? '1' : '0';
      ghost.style.width = `${drawn}px`;
      ghost.style.height = `${drawn}px`;
      ghost.style.transform = `translate(${event.clientX - drawn / 2}px, ${event.clientY - drawn / 2}px)`;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [placing, size, getZoom]);

  if (!placing || !source) return null;
  const label = source.text?.trim();
  return (
    <>
      <div className="dc-junction-placing" role="status">
        <span className="dc-junction-placing-glyph" aria-hidden="true">
          {label?.slice(0, 3)}
        </span>
        <span>
          Click where {label ? <strong>{label}</strong> : 'this junction'} continues
        </span>
        <kbd>Esc</kbd>
      </div>
      <span ref={ghostRef} className="dc-junction-ghost" aria-hidden="true" />
    </>
  );
}
