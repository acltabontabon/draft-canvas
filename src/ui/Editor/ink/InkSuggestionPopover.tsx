import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { pathKey } from '../../../depth/tree';
import { INK_CHOICE_LABEL, type InkShapeChoice } from '../../../ink/choices';
import { clamp } from '../../../lib/math';
import { useEditorStore } from '../../../store/editorStore';
import { useUiStore } from '../../../store/uiStore';
import { ToolGlyph } from '../toolbar/ToolGlyph';
import { chooseSuggestion, keepAsSketch } from '../../../canvas/inkSession';
import { useOverlayPosition } from '../../../canvas/useOverlayPosition';

const GAP = 10;
const EDGE = 8;

/** Each choice drawn as the toolbar draws it — the shape itself, small. */
const GLYPH: Record<InkShapeChoice, string> = {
  component: 'component',
  service: 'service',
  boundary: 'boundary',
  note: 'note',
  database: 'database',
  queue: 'queue',
  actor: 'actor',
  junction: 'ellipse',
};

/**
 * Smart Ink's offer for the drawing just made: a small strip of the elements it could be, beside it.
 *
 * Never modal and never in the way. It does not take focus — a stylus keeps drawing, and the next
 * stroke simply accepts what is shown. Its keys work wherever focus is: ←/→ (or a number) switch to
 * another choice in place, Enter accepts and starts naming the shape, Escape puts the drawing back as
 * it was drawn. It sits below the shape, or above when there is no room below, and never over it.
 */
export function InkSuggestionPopover() {
  const suggestion = useUiStore((state) => state.inkSuggestion);
  const room = useEditorStore((state) => pathKey(state.path));
  const node = useEditorStore((state) => (suggestion?.nodeId ? state.document.nodes.find((n) => n.id === suggestion.nodeId) : undefined));
  const presenting = useEditorStore((state) => state.mode === 'present');
  const panelRef = useRef<HTMLDivElement>(null);

  // Its drawing is gone (undone, deleted, another room, another canvas): nothing left to offer.
  const stale = suggestion !== null && (suggestion.room !== room || presenting || (suggestion.mode === 'converted' && !node));
  useEffect(() => {
    if (stale) useUiStore.getState().setInkSuggestion(null);
  }, [stale]);

  const box = suggestion ? (node ? { x: node.x, y: node.y, width: node.width, height: node.height } : suggestion.drawn) : null;
  const { target } = useOverlayPosition<'below' | 'above'>(panelRef, 'below', (frame, current) => {
    if (!box) return null;
    const { width, height } = frame.size;
    const bottom = frame.flowToScreenPosition({ x: box.x + box.width / 2, y: box.y + box.height });
    const top = frame.flowToScreenPosition({ x: box.x + box.width / 2, y: box.y });
    const fitsBelow = bottom.y + GAP + height <= frame.root.bottom - EDGE - 32;
    const fitsAbove = top.y - GAP - height >= frame.root.top + EDGE + 48;
    const placement = current === 'below' ? (fitsBelow || !fitsAbove ? 'below' : 'above') : fitsAbove || !fitsBelow ? 'above' : 'below';
    const anchor = placement === 'below' ? { x: bottom.x, y: bottom.y + GAP } : { x: top.x, y: top.y - GAP - height };
    const local = frame.screenToOverlay(anchor);
    const x = clamp(local.x - width / 2, EDGE, Math.max(EDGE, frame.root.width - width - EDGE));
    const y = clamp(local.y, EDGE, Math.max(EDGE, frame.root.height - height - EDGE));
    return { placement, transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` };
  });

  const open = suggestion !== null && !stale;
  const token = suggestion?.token;
  useEffect(() => {
    if (!open || token === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
      if (editable || event.metaKey || event.ctrlKey || event.altKey) return;
      const current = useUiStore.getState().inkSuggestion;
      if (!current) return;
      const count = current.choices.length;
      const at = current.chosen;
      let handled = true;
      if (event.key === 'Escape') keepAsSketch();
      else if (event.key === 'Enter') {
        useUiStore.getState().setInkSuggestion(null);
        if (current.mode === 'converted' && current.nodeId) useUiStore.getState().requestEdit(current.nodeId);
        else if (current.mode === 'offer') {
          chooseSuggestion(0);
          useUiStore.getState().setInkSuggestion(null);
        }
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') chooseSuggestion((Math.max(at, -1) + 1) % count);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') chooseSuggestion((at <= 0 ? count : at) - 1);
      else if (/^[1-9]$/.test(event.key) && Number(event.key) <= count) chooseSuggestion(Number(event.key) - 1);
      else handled = false;
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // A press anywhere but here accepts what is shown and puts the strip away.
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) useUiStore.getState().setInkSuggestion(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown, true), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.clearTimeout(id);
    };
  }, [open, token]);

  if (!open || !suggestion || !target) return null;
  const converted = suggestion.mode === 'converted';
  const chosen = converted ? suggestion.choices[suggestion.chosen] : undefined;
  const holds = suggestion.encloses.length;
  return createPortal(
    <div
      ref={panelRef}
      className="dc-ink-suggestion"
      role="toolbar"
      aria-label={converted ? 'Smart Ink: change what the drawing became' : 'Smart Ink: make the drawing a shape'}
      data-mode={suggestion.mode}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {!converted && <span className="dc-ink-suggestion-lead">Make it</span>}
      {suggestion.choices.map((choice, index) => (
        <button
          key={choice}
          type="button"
          className="dc-ink-choice"
          aria-pressed={converted ? index === suggestion.chosen : undefined}
          data-active={converted && index === suggestion.chosen ? 'true' : undefined}
          data-recommended={index === 0 ? 'true' : undefined}
          title={index === 0 ? `${INK_CHOICE_LABEL[choice]} — suggested` : INK_CHOICE_LABEL[choice]}
          onClick={() => {
            chooseSuggestion(index);
            if (!converted) useUiStore.getState().setInkSuggestion(null);
          }}
        >
          <ToolGlyph id={GLYPH[choice]} />
          <span>{INK_CHOICE_LABEL[choice]}</span>
          {choice === 'boundary' && holds > 0 && <span className="dc-ink-choice-count">{holds}</span>}
        </button>
      ))}
      <span className="dc-ink-sep" aria-hidden="true" />
      <button type="button" className="dc-ink-choice dc-ink-keep" title="Keep the drawing as ink (Esc)" onClick={keepAsSketch}>
        <ToolGlyph id="pencil" />
        <span>{converted ? 'Keep sketch' : 'Dismiss'}</span>
      </button>
      <span className="dc-sr-only" aria-live="polite">
        {converted && chosen
          ? `Drawn as ${INK_CHOICE_LABEL[chosen]}${holds > 0 && chosen === 'boundary' ? ` around ${holds} shapes` : ''}. Arrow keys change it, Enter names it, Escape keeps the sketch.`
          : 'This sketch could be a shape. Arrow keys choose one, Escape dismisses.'}
      </span>
    </div>,
    target,
  );
}
