import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useStore } from '@xyflow/react';
import { displayNameFor } from '../document/factory';
import { OPEN_POINT_HINTS, OPEN_POINT_LABELS, normalizeOpenPointText, openPointsFor } from '../document/openPoints';
import { OPEN_POINT_KINDS, type DraftDocument, type OpenPoint, type OpenPointKind, type OpenPointTarget } from '../document/types';
import { isImeKeyEvent, overlayAboveCanvasIsOpen } from '../lib/isEditableTarget';
import { count } from '../lib/plural';
import { MARKER_SIZE } from '../openPoints/marker';
import { useEditorStore } from '../store/editorStore';
import { edgeIndex, nodeIndex, selectEdge, selectNode } from '../store/selectors';
import { useUiStore, type OpenPointPopoverState } from '../store/uiStore';
import { Button } from '../ui/common/Button';
import { Icon } from '../ui/common/Icon';
import { rightClearance } from './canvasFrame';
import { edgeLabelPoint, rectOfInternal } from './edgeGeometry';
import { OpenPointGlyph } from './OpenPointGlyph';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type Placement,
  type PlacementClearances,
  type PlacementRect,
} from './popoverPlacement';
import { useOverlayPosition } from './useOverlayPosition';
import { usePopoverKeyboard } from './usePopoverKeyboard';
import { useLastPresent, usePopoverPresence } from './usePopoverPresence';
import { useToolbarHeight } from './useToolbarHeight';

/** Must match `dc-popover-in`/`-out` in `canvas.css`. */
const POPOVER_EXIT_MS = 120;
/** Its own clearances, per house style (see `popoverPlacement.ts`): never shared with another popover's. */
const GAP = 12;
const TOP_CLEARANCE = 56;
const BOTTOM_CLEARANCE = 44;
const LEFT_CLEARANCE = 12;

/**
 * The one place an open point is raised, read, edited, resolved, reopened or removed.
 *
 * Anchored beside the element it is about (the same collision-aware placement every contextual
 * popover here uses), and deliberately small: opened to *raise* a point it leads with the three kinds
 * and applies the first one clicked — the marker is on the canvas before any words are typed — then
 * offers a place for a sentence of context. Opened from a marker it lists what is open here, each
 * with its kind, its words, Resolve and Delete, and folds the settled ones away underneath.
 * While presenting the same popover is read-only: a presenter can show what is open without any
 * editing surface appearing over the story.
 *
 * Enter in the context field commits and closes (Shift+Enter for a new line); Escape closes and
 * hands focus back to the marker it came from. Typing writes straight to the document, coalesced
 * into one undo step per point (`setOpenPointContext`), the way an action's text is.
 */
export function OpenPointPopover() {
  const popover = useUiStore((state) => state.openPointPopover);
  const anchorExists = useEditorStore((state) => {
    if (!popover) return false;
    return popover.anchor.kind === 'node'
      ? selectNode(state.document, popover.anchor.id) !== undefined
      : selectEdge(state.document, popover.anchor.id) !== undefined;
  });
  const measured = useStore((state) => {
    if (!popover) return false;
    if (popover.anchor.kind === 'node') return state.nodeLookup.has(popover.anchor.id);
    // A connector's position comes from its endpoints, which must both be measured.
    const edge = selectEdge(useEditorStore.getState().document, popover.anchor.id);
    return edge ? state.nodeLookup.has(edge.source) && state.nodeLookup.has(edge.target) : false;
  });
  const setOpenPointPopover = useUiStore((state) => state.setOpenPointPopover);

  // The element it was about is gone (deleted, undone, a reload): the popover has nothing to be
  // anchored to and closes rather than lingering at a stale spot.
  useEffect(() => {
    if (popover && !anchorExists) setOpenPointPopover(null);
  }, [popover, anchorExists, setOpenPointPopover]);

  const open = Boolean(popover && anchorExists && measured);
  const { mounted, closing } = usePopoverPresence(open, POPOVER_EXIT_MS);
  const shown = useLastPresent(open ? popover : null);
  if (!mounted || !shown) return null;
  return <OpenPointPopoverBody key={`${shown.anchor.kind}:${shown.anchor.id}`} state={shown} closing={closing} listening={open} />;
}

function OpenPointPopoverBody({ state, closing, listening }: { state: OpenPointPopoverState; closing: boolean; listening: boolean }) {
  const { anchor } = state;
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const interactionActive = useUiStore((state) => state.interactionActive);
  const setOpenPointPopover = useUiStore((state) => state.setOpenPointPopover);
  const readOnly = useEditorStore((state) => state.mode === 'present');
  const document = useEditorStore((state) => state.document);
  const points = openPointsFor(document, anchor);
  const unresolved = points.filter((point) => !point.resolved);
  const resolved = points.filter((point) => point.resolved);

  const node = anchor.kind === 'node' ? nodeIndex(document.nodes).get(anchor.id) : undefined;
  const edge = anchor.kind === 'edge' ? edgeIndex(document.edges).get(anchor.id) : undefined;
  const nodeInternal = useInternalNode(node?.id ?? '');
  const sourceInternal = useInternalNode(edge?.source ?? '');
  const targetInternal = useInternalNode(edge?.target ?? '');

  const subject = node
    ? displayNameFor(node)
    : edge
      ? `${nameOf(document, edge.source)} → ${nameOf(document, edge.target)}`
      : 'this element';

  const panelRef = useRef<HTMLDivElement>(null);
  usePopoverKeyboard(panelRef);

  // `creating` is consumed: once the first kind is picked the point exists and the popover becomes
  // an ordinary editor for it, with that point's context field ready to type into.
  const [creating, setCreating] = useState(state.creating);
  const [focusContextOf, setFocusContextOf] = useState<string | null>(null);
  const [resolutionEditing, setResolutionEditing] = useState<string | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(Boolean(state.pointId && resolved.some((p) => p.id === state.pointId)));
  useEffect(() => {
    // Nothing left to edit and nothing being raised: an empty popover is one to put away.
    if (!creating && points.length === 0) setOpenPointPopover(null);
  }, [creating, points.length, setOpenPointPopover]);

  const close = useCallback(
    (returnFocus: boolean) => {
      setOpenPointPopover(null);
      if (!returnFocus) return;
      // Back to the marker this came from, so a keyboard user lands where they left — or, with no
      // marker (a point just deleted, or none raised), on the canvas itself.
      const marker = window.document.querySelector<HTMLElement>(
        `.dc-open-point-marker[data-anchor="${CSS.escape(`${anchor.kind}:${anchor.id}`)}"]`,
      );
      (marker ?? window.document.querySelector<HTMLElement>('.dc-canvas'))?.focus({ preventScroll: true });
    },
    [anchor.id, anchor.kind, setOpenPointPopover],
  );

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeKeyEvent(event) && !overlayAboveCanvasIsOpen()) {
        event.stopPropagation();
        close(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpenPointPopover(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [listening, close, setOpenPointPopover]);

  // Opened to raise a point, the first kind takes focus so Enter (or an arrow, then Enter) raises
  // it without a mouse. Opened from a marker, focus stays on the marker — the popover is being read.
  useLayoutEffect(() => {
    if (!state.creating) return;
    panelRef.current?.querySelector<HTMLElement>('.dc-open-point-kinds button')?.focus({ preventScroll: true });
  }, [state.creating]);

  const rect: PlacementRect | null = (() => {
    if (node && nodeInternal) return rectOfInternal(nodeInternal);
    if (edge && sourceInternal && targetInternal) {
      const types = new Map(document.nodes.map((n) => [n.id, n.type]));
      const source = rectOfInternal(sourceInternal, types.get(edge.source));
      const target = rectOfInternal(targetInternal, types.get(edge.target));
      if (!source || !target) return null;
      const point = edgeLabelPoint(document, edge, source, target, { interactionActive });
      return { x: point.x - MARKER_SIZE, y: point.y - MARKER_SIZE, width: MARKER_SIZE * 2, height: MARKER_SIZE * 2 };
    }
    return null;
  })();
  const anchors = rect ? anchorsForRect(rect) : null;

  const toolbarHeight = useToolbarHeight(true);
  const baseClearances: PlacementClearances = {
    gap: GAP,
    top: toolbarHeight ? toolbarHeight + 10 : TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: LEFT_CLEARANCE,
  };
  const { target, placement } = useOverlayPosition<Placement>(panelRef, 'right', (frame, current) => {
    if (!anchors) return null;
    const clearances = { ...baseClearances, right: rightClearance(flowPanelOpen, LEFT_CLEARANCE) };
    const next = interactionActive ? current : resolvePlacement(current, anchors, frame.flowToScreenPosition, frame.size, clearances);
    return {
      placement: next,
      transform: placementTransform(next, anchors, frame.size, clearances, frame.flowToScreenPosition, frame.screenToOverlay),
    };
  });

  if (!target || !anchors) return null;

  const raise = (kind: OpenPointKind) => {
    const id = useEditorStore.getState().addOpenPoint(kind, state.targets);
    if (!id) {
      useUiStore.getState().notify('This canvas is holding as many open points as it can.', 'error');
      return;
    }
    setCreating(false);
    setFocusContextOf(id);
  };

  const resolve = (point: OpenPoint) => {
    useEditorStore.getState().resolveOpenPoint(point.id);
    // The settled point is where the note about how it was settled goes — shown, and ready to type
    // into, but never required.
    setResolvedOpen(true);
    setResolutionEditing(point.id);
  };

  return createPortal(
    <div
      ref={panelRef}
      className="dc-popover dc-open-point-popover"
      role="dialog"
      aria-label={`Open points for ${subject}`}
      data-closing={closing ? 'true' : undefined}
      data-placement={placement}
      data-read-only={readOnly ? 'true' : undefined}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="dc-popover-caret" aria-hidden="true" />
      <div className="dc-popover-inner">
        <header className="dc-open-point-head">
          <span className="dc-open-point-title">{creating && points.length === 0 ? 'Open point' : 'Open points'}</span>
          <span className="dc-open-point-subject" title={subject}>
            {subject}
          </span>
          <Button variant="quiet" icon="close" aria-label="Close" onClick={() => close(true)} />
        </header>

        {creating && !readOnly && (
          <div className="dc-open-point-picker">
            <span className="dc-open-point-prompt">
              {state.targets.length > 1 ? `One point about ${count(state.targets.length, 'element')} — what's still open?` : 'What’s still open?'}
            </span>
            <KindPicker onPick={raise} />
          </div>
        )}

        {unresolved.length > 0 && (
          <ul className="dc-open-point-list">
            {unresolved.map((point) => (
              <OpenPointRow
                key={point.id}
                point={point}
                anchor={anchor}
                readOnly={readOnly}
                autoFocus={focusContextOf === point.id}
                onResolve={() => resolve(point)}
                onClose={() => close(true)}
              />
            ))}
          </ul>
        )}

        {!creating && !readOnly && (
          <button type="button" className="dc-open-point-add" onClick={() => setCreating(true)}>
            <Icon name="plus" size={12} /> Add another
          </button>
        )}

        {resolved.length > 0 && (
          <div className="dc-open-point-resolved">
            <button
              type="button"
              className="dc-open-point-resolved-toggle"
              aria-expanded={resolvedOpen}
              onClick={() => setResolvedOpen((value) => !value)}
            >
              <Icon name={resolvedOpen ? 'down' : 'forward'} />
              {count(resolved.length, 'resolved point')}
            </button>
            {resolvedOpen && (
              <ul className="dc-open-point-list">
                {resolved.map((point) => (
                  <ResolvedRow
                    key={point.id}
                    point={point}
                    readOnly={readOnly}
                    editing={resolutionEditing === point.id}
                    onEdit={() => setResolutionEditing(point.id)}
                    onDoneEditing={() => setResolutionEditing(null)}
                    onClose={() => close(true)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>,
    target,
  );
}

function nameOf(document: Pick<DraftDocument, 'nodes'>, id: string): string {
  const node = nodeIndex(document.nodes).get(id);
  return node ? displayNameFor(node) : '?';
}

/** The three kinds, as one choice. Picking one is the whole action: the point exists on click. */
function KindPicker({ onPick }: { onPick: (kind: OpenPointKind) => void }) {
  return (
    <div className="dc-open-point-kinds" data-layout="picker">
      {OPEN_POINT_KINDS.map((kind) => (
        <button key={kind} type="button" className="dc-open-point-kind" title={OPEN_POINT_HINTS[kind]} onClick={() => onPick(kind)}>
          <OpenPointGlyph kind={kind} />
          <span>{OPEN_POINT_LABELS[kind]}</span>
        </button>
      ))}
    </div>
  );
}

/** The same three, for changing a point that already exists — radio semantics, one checked. */
function KindSwitch({ value, onChange }: { value: OpenPointKind; onChange: (kind: OpenPointKind) => void }) {
  return (
    <div className="dc-open-point-kinds" role="radiogroup" aria-label="Kind">
      {OPEN_POINT_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="radio"
          aria-checked={kind === value}
          className="dc-open-point-kind"
          data-compact="true"
          title={OPEN_POINT_HINTS[kind]}
          onClick={() => onChange(kind)}
        >
          <OpenPointGlyph kind={kind} />
          <span>{OPEN_POINT_LABELS[kind]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A multi-line field that writes to the document as it is typed. Enter commits and closes the
 * popover; Shift+Enter is a new line; the coalesce key on the store action turns the burst into one
 * undo step. `stopPropagation` on every key keeps the canvas's bare-letter shortcuts out of it.
 *
 * What is shown is a local draft, not the stored value read straight back: the store trims what it
 * keeps, so a controlled field bound to it lost every space the moment it was typed (the trailing
 * space came back trimmed before the next letter arrived). The draft follows the document only when
 * the document moved away from it — an undo, an edit from elsewhere.
 */
function ContextField({
  value,
  placeholder,
  label,
  autoFocus,
  onChange,
  onCommit,
}: {
  value: string;
  placeholder: string;
  label: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (normalizeOpenPointText(draft) !== value) setDraft(value);
    // Only the document changing under the field matters; the draft's own edits already match it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (isImeKeyEvent(event)) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onCommit();
    }
  };
  return (
    <textarea
      ref={ref}
      className="dc-open-point-context nowheel"
      rows={2}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

function OpenPointRow({
  point,
  anchor,
  readOnly,
  autoFocus,
  onResolve,
  onClose,
}: {
  point: OpenPoint;
  anchor: OpenPointTarget;
  readOnly: boolean;
  autoFocus: boolean;
  onResolve: () => void;
  onClose: () => void;
}) {
  const others = point.targets.length - 1;
  const sharedLine = others > 0 ? `Also about ${count(others, 'other element')}` : null;
  return (
    <li className="dc-open-point-row" data-kind={point.kind}>
      {readOnly ? (
        <>
          <span className="dc-open-point-kind-chip">
            <OpenPointGlyph kind={point.kind} />
            {OPEN_POINT_LABELS[point.kind]}
          </span>
          {point.context ? <p className="dc-open-point-text">{point.context}</p> : <p className="dc-open-point-text dc-open-point-text-empty">No context was added.</p>}
          {sharedLine && <span className="dc-open-point-shared">{sharedLine}</span>}
        </>
      ) : (
        <>
          <KindSwitch value={point.kind} onChange={(kind) => useEditorStore.getState().setOpenPointKind(point.id, kind)} />
          <ContextField
            value={point.context ?? ''}
            placeholder="Add context… (optional)"
            label={`Context for ${OPEN_POINT_LABELS[point.kind].toLowerCase()} point`}
            autoFocus={autoFocus}
            onChange={(value) => useEditorStore.getState().setOpenPointContext(point.id, value)}
            onCommit={onClose}
          />
          <div className="dc-open-point-actions">
            {sharedLine ? (
              <span className="dc-open-point-shared">
                {sharedLine}
                {' · '}
                <button
                  type="button"
                  className="dc-open-point-link"
                  title="Keep the point on the other elements, not this one"
                  onClick={() => useEditorStore.getState().removeOpenPointTarget(point.id, anchor)}
                >
                  Not this one
                </button>
              </span>
            ) : (
              <span className="dc-open-point-spacer" />
            )}
            <Button variant="quiet" onClick={onResolve} title="Settled — the marker goes, the point is kept">
              Resolve
            </Button>
            <Button
              variant="quiet"
              icon="trash"
              aria-label="Delete open point"
              title="Delete this point (undoable)"
              onClick={() => useEditorStore.getState().removeOpenPoint(point.id)}
            />
          </div>
        </>
      )}
    </li>
  );
}

function ResolvedRow({
  point,
  readOnly,
  editing,
  onEdit,
  onDoneEditing,
  onClose,
}: {
  point: OpenPoint;
  readOnly: boolean;
  editing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
  onClose: () => void;
}) {
  return (
    <li className="dc-open-point-row" data-kind={point.kind} data-resolved="true">
      <span className="dc-open-point-kind-chip" data-resolved="true">
        <Icon name="check" size={11} />
        {OPEN_POINT_LABELS[point.kind]} · resolved
      </span>
      {point.context && <p className="dc-open-point-text">{point.context}</p>}
      {!readOnly && editing ? (
        <ContextField
          value={point.resolution ?? ''}
          placeholder="How was it settled? (optional)"
          label="Resolution"
          autoFocus
          onChange={(value) => useEditorStore.getState().setOpenPointResolution(point.id, value)}
          onCommit={() => {
            onDoneEditing();
            onClose();
          }}
        />
      ) : point.resolution ? (
        <p className="dc-open-point-text dc-open-point-resolution">{point.resolution}</p>
      ) : null}
      {!readOnly && (
        <div className="dc-open-point-actions">
          {!editing && (
            <button type="button" className="dc-open-point-link" onClick={onEdit}>
              {point.resolution ? 'Edit note' : 'Add a note'}
            </button>
          )}
          <span className="dc-open-point-spacer" />
          <Button variant="quiet" onClick={() => useEditorStore.getState().reopenOpenPoint(point.id)} title="Back to open — the marker returns">
            Reopen
          </Button>
          <Button
            variant="quiet"
            icon="trash"
            aria-label="Delete resolved point"
            title="Delete this point (undoable)"
            onClick={() => useEditorStore.getState().removeOpenPoint(point.id)}
          />
        </div>
      )}
    </li>
  );
}
