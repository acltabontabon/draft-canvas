import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useNodesStore } from '@xyflow/react';
import { destinationsOf, followJunction, junctionName, type JunctionDestination } from '../commands/junctions';
import type { CommandContext } from '../commands/types';
import { viewOf } from '../depth/tree';
import { junctionContext } from '../junctions/destination';
import { isImeKeyEvent, overlayAboveCanvasIsOpen } from '../lib/isEditableTarget';
import { count } from '../lib/plural';
import { fileOf, useEditorStore } from '../store/editorStore';
import { nodeIndex, selectNode } from '../store/selectors';
import { useUiStore, type JunctionPeekState } from '../store/uiStore';
import { useThemeValue } from '../theme/useTheme';
import { Icon } from '../ui/common/Icon';
import { rightClearance } from './canvasFrame';
import { rectOfInternal } from './edgeGeometry';
import { forgetPictures, junctionPicture, keptPicture, type JunctionPicture } from './junctionPreview';
import { anchorsForRect, placementTransform, resolvePlacement, type Placement, type PlacementClearances } from './popoverPlacement';
import { useDiagramStyle } from './useDiagramStyle';
import { useOverlayPosition } from './useOverlayPosition';
import { useLastPresent, usePopoverPresence } from './usePopoverPresence';
import { useToolbarHeight } from './useToolbarHeight';
import '../styles/junctions.css';

/** Must match `dc-popover-in`/`-out` in `canvas.css`. */
const POPOVER_EXIT_MS = 120;
/** Its own clearances, per house style (see `popoverPlacement.ts`). */
const GAP = 14;
const TOP_CLEARANCE = 56;
const BOTTOM_CLEARANCE = 44;
const SIDE_CLEARANCE = 12;

/** How long the pointer rests on a Junction before its places are shown: long enough to cross one. */
const HOVER_OPEN_MS = 380;
/** …and from one Junction to the next while a card is already showing: the reader is browsing. */
const HOVER_SWITCH_MS = 140;
/** How long the card outlives the pointer, so it can be reached across the gap beside the Junction. */
const HOVER_CLOSE_MS = 240;
/** After a press, how long a Junction appearing under a pointer that has not moved is not taken as resting on it. */
const PRESS_QUIET_MS = 900;
/** How far the pointer may drift from where it pressed and still count as not having moved. */
const PRESS_STILL_PX = 6;

/** The picture's frame, in CSS pixels. */
const FRAME = { width: 314, height: 150 };
/** A picture of two shapes is not blown up to fill the frame. */
const MAX_SCALE = 1.15;
/** With more places than this, the list can be narrowed by typing. */
const FILTER_FROM = 8;

/**
 * Where a Junction continues, shown beside it: a picture of the place, what it leads to, and the
 * way there. With several places it is the list to choose from, the picture following whichever
 * one is under the pointer or the arrow keys.
 *
 * It opens two ways (`JunctionPeekState.by`). Resting the pointer on a linked Junction shows it
 * and takes nothing: no focus, no keys, gone when the pointer leaves. Asking for it — the Go key
 * on a Junction with several places, the menu, a click while presenting — keeps it until dismissed
 * and gives it the arrows, Enter and Escape.
 *
 * Transient, like every popover here: `uiStore.junctionPeek` is never saved, undone or shared.
 */
export function JunctionPeek({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  useJunctionHover();
  const peek = useUiStore((state) => state.junctionPeek);
  usePointedGroup(peek?.id ?? null);
  // Pictures are of the diagram on screen: another diagram starts with none.
  const documentId = useEditorStore((state) => state.document.metadata.id);
  useEffect(() => forgetPictures, [documentId]);
  const linked = useEditorStore((state) => (peek ? Boolean(selectNode(state.document, peek.id)?.link) : false));
  const measured = useNodesStore((state) => (peek ? state.nodeLookup.has(peek.id) : false));
  // A drag or a resize is the pointer doing something else; the card steps aside for it.
  const busy = useUiStore((state) => state.interactionActive);
  const setJunctionPeek = useUiStore((state) => state.setJunctionPeek);

  // Unlinked or deleted while it was showing (an undo, somebody else's edit): nothing to show.
  useEffect(() => {
    if (peek && !linked) setJunctionPeek(null);
  }, [peek, linked, setJunctionPeek]);

  const open = Boolean(peek && linked && measured && !busy);
  const { mounted, closing } = usePopoverPresence(open, POPOVER_EXIT_MS);
  const shown = useLastPresent(open ? peek : null);
  if (!mounted || !shown) return null;
  return <JunctionPeekBody key={shown.id} state={shown} closing={closing} listening={open} buildCommandContext={buildCommandContext} />;
}

/** The group to point out on the canvas: the one being looked at, else the one selected. */
function usePointedGroup(peekId: string | null) {
  const link = useEditorStore((state) => {
    const { nodes, edges } = state.selection;
    const id = peekId ?? (nodes.length === 1 && edges.length === 0 ? nodes[0]! : null);
    return id ? (nodeIndex(state.document.nodes).get(id)?.link ?? null) : null;
  });
  useEffect(() => {
    useUiStore.getState().setJunctionPeerLink(link);
  }, [link]);
  useEffect(() => () => useUiStore.getState().setJunctionPeerLink(null), []);
}

function junctionIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.dc-node[data-link="linked"]')?.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
}

const inCard = (target: EventTarget | null): boolean => target instanceof Element && target.closest('.dc-junction-peek') !== null;

/** Whether the pointer is busy with something a card must not get in the way of. */
function pointerIsBusy(): boolean {
  const ui = useUiStore.getState();
  return (
    ui.interactionActive ||
    ui.armed !== null ||
    ui.pencil !== null ||
    ui.junctionPlacing !== null ||
    ui.contextMenu !== null ||
    ui.quickConnect !== null ||
    ui.commandPaletteOpen ||
    window.document.querySelector('.dc-node[data-editing="true"]') !== null
  );
}

/**
 * Resting on a linked Junction shows where it continues. One pair of listeners for the whole
 * canvas rather than a handler on every Junction: nothing is added to a node's own render, and a
 * diagram with a thousand Junctions listens exactly as much as one with none. Touch has no hover;
 * there the Junction is selected and its inspector offers the same journey.
 */
function useJunctionHover() {
  useEffect(() => {
    let opening: number | null = null;
    let closing: number | null = null;
    let pressed = { at: 0, x: 0, y: 0 };
    const cancelOpen = () => {
      if (opening !== null) window.clearTimeout(opening);
      opening = null;
    };
    const cancelClose = () => {
      if (closing !== null) window.clearTimeout(closing);
      closing = null;
    };
    const onOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const id = junctionIdAt(event.target);
      if (!id) {
        if (inCard(event.target)) cancelClose();
        return;
      }
      cancelClose();
      const showing = useUiStore.getState().junctionPeek;
      if (showing?.id === id || event.buttons !== 0 || pointerIsBusy()) return;
      // The pointer has not moved since a click: the Junction was put down under it this instant,
      // or came to it with the camera. That is not resting on it; moving onto one is.
      const still = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < PRESS_STILL_PX;
      if (still && event.timeStamp - pressed.at < PRESS_QUIET_MS) return;
      // Asked for and still open: resting on another Junction does not take it away.
      if (showing?.by === 'ask') return;
      cancelOpen();
      opening = window.setTimeout(
        () => {
          opening = null;
          if (!pointerIsBusy()) useUiStore.getState().setJunctionPeek({ id, by: 'hover' });
        },
        showing ? HOVER_SWITCH_MS : HOVER_OPEN_MS,
      );
    };
    const onOut = (event: PointerEvent) => {
      const from = junctionIdAt(event.target);
      if (!from && !inCard(event.target)) return;
      if ((from && junctionIdAt(event.relatedTarget) === from) || inCard(event.relatedTarget)) return;
      cancelOpen();
      if (useUiStore.getState().junctionPeek?.by !== 'hover') return;
      cancelClose();
      closing = window.setTimeout(() => {
        closing = null;
        const ui = useUiStore.getState();
        if (ui.junctionPeek?.by === 'hover') ui.setJunctionPeek(null);
      }, HOVER_CLOSE_MS);
    };
    // A press is the start of a click, a drag or a connector: whatever was about to open, doesn't.
    const onDown = (event: PointerEvent) => {
      pressed = { at: event.timeStamp, x: event.clientX, y: event.clientY };
      cancelOpen();
      const ui = useUiStore.getState();
      if (ui.junctionPeek?.by === 'hover' && !inCard(event.target)) ui.setJunctionPeek(null);
    };
    window.document.addEventListener('pointerover', onOver);
    window.document.addEventListener('pointerout', onOut);
    window.document.addEventListener('pointerdown', onDown, true);
    return () => {
      cancelOpen();
      cancelClose();
      window.document.removeEventListener('pointerover', onOver);
      window.document.removeEventListener('pointerout', onOut);
      window.document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
}

/** What a place is called in the list: its section or room, else its number. */
function placeTitle(destination: JunctionDestination, index: number): string {
  return destination.where || `Place ${index + 1}`;
}

function matches(destination: JunctionDestination, query: string): boolean {
  if (!query) return true;
  return `${destination.where} ${destination.sentence} ${destination.member.node.text ?? ''}`.toLowerCase().includes(query);
}

function JunctionPeekBody({
  state,
  closing,
  listening,
  buildCommandContext,
}: {
  state: JunctionPeekState;
  closing: boolean;
  listening: boolean;
  buildCommandContext: () => CommandContext;
}) {
  const { id } = state;
  const asked = state.by === 'ask';
  const flowPanelOpen = useUiStore((ui) => ui.flowPanelOpen);
  const interactionActive = useUiStore((ui) => ui.interactionActive);
  const setJunctionPeek = useUiStore((ui) => ui.setJunctionPeek);
  const document = useEditorStore((editor) => editor.document);
  const path = useEditorStore((editor) => editor.path);
  const outer = useEditorStore((editor) => editor.outer);
  const file = fileOf({ document, path, outer });
  const node = nodeIndex(document.nodes).get(id);
  const nodeInternal = useInternalNode(id);
  const theme = useThemeValue();
  const style = useDiagramStyle();

  const all = useMemo(() => destinationsOf(file, id), [file, id]);
  const [query, setQuery] = useState('');
  const places = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return wanted ? all.filter((destination) => matches(destination, wanted)) : all;
  }, [all, query]);
  const [index, setIndex] = useState(0);
  const active = Math.min(index, Math.max(0, places.length - 1));
  const destination = places[active];

  // The last counterpart was deleted or unlinked while this was open: there is nowhere to show.
  useEffect(() => {
    if (all.length === 0) setJunctionPeek(null);
  }, [all.length, setJunctionPeek]);

  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(
    (returnFocus: boolean) => {
      setJunctionPeek(null);
      if (returnFocus) window.document.querySelector<HTMLElement>('.dc-canvas')?.focus({ preventScroll: true });
    },
    [setJunctionPeek],
  );
  const go = useCallback(
    (target: JunctionDestination | undefined) => {
      if (target) void followJunction(buildCommandContext(), id, target.member.node.id);
    },
    [buildCommandContext, id],
  );

  // Asked for, it is the thing being worked: it takes focus, so a screen reader says what opened.
  useLayoutEffect(() => {
    if (asked) panelRef.current?.focus({ preventScroll: true });
  }, [asked]);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyEvent(event) || overlayAboveCanvasIsOpen()) return;
      if (event.key === 'Escape') {
        // A card that only came up on hover closes but keeps no key from what is underneath: it
        // once swallowed the Escape that ends renaming the Junction, leaving the editor open.
        if (asked) event.stopPropagation();
        close(asked);
        return;
      }
      // Resting on a Junction shows this and takes no keys: the arrows still nudge, Enter still renames.
      if (!asked || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setIndex((current) => (Math.min(current, Math.max(0, places.length - 1)) + step + places.length) % Math.max(1, places.length));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        go(places[active]);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setJunctionPeek(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const timer = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(timer);
    };
  }, [listening, asked, close, go, places, active, setJunctionPeek]);

  // The highlighted place stays in view as the arrows move through a long list.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('.dc-junction-place[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const room = destination ? viewOf(file, destination.member.path) : undefined;
  const context = destination?.context;
  const pictureId = destination?.member.node.id;
  const themeName = theme.name;
  // One picture at a time, drawn after the card is on screen: opening never waits for it, and a
  // place already looked at (and not edited since) is shown at once.
  const [drawn, setDrawn] = useState<{ id: string; picture: JunctionPicture | null } | null>(null);
  const ready = room && pictureId ? keptPicture(pictureId, room, style, themeName) : undefined;
  useEffect(() => {
    if (!room || !context || !pictureId || ready) return;
    const timer = window.setTimeout(() => {
      try {
        setDrawn({ id: pictureId, picture: junctionPicture(room, context, style, themeName) });
      } catch {
        // The words beside the frame already say where it leads; a picture that failed is left out.
        setDrawn({ id: pictureId, picture: null });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [room, context, pictureId, ready, style, themeName]);
  const picture = ready ?? (drawn && drawn.id === pictureId ? drawn.picture : undefined);

  // Kept off the shapes this Junction is wired to: they are half of what is being read.
  const wired = useMemo(() => junctionContext(document, id)?.neighbours.map((other) => ({ x: other.x, y: other.y, width: other.width, height: other.height })) ?? [], [document, id]);
  const rect = nodeInternal ? rectOfInternal(nodeInternal) : null;
  const anchors = rect ? anchorsForRect(rect) : null;
  const toolbarHeight = useToolbarHeight(true);
  const baseClearances: PlacementClearances = {
    gap: GAP,
    top: toolbarHeight ? toolbarHeight + 10 : TOP_CLEARANCE,
    bottom: BOTTOM_CLEARANCE,
    left: SIDE_CLEARANCE,
    right: SIDE_CLEARANCE,
  };
  const { target, placement } = useOverlayPosition<Placement>(panelRef, 'below', (frame, current) => {
    if (!anchors) return null;
    const clearances = { ...baseClearances, right: rightClearance(flowPanelOpen, SIDE_CLEARANCE, frame.root.right) };
    const next = interactionActive ? current : resolvePlacement(current, anchors, frame.flowToScreenPosition, frame.size, clearances, wired);
    return {
      placement: next,
      transform: placementTransform(next, anchors, frame.size, clearances, frame.flowToScreenPosition, frame.screenToOverlay),
    };
  });

  if (!target || !anchors || !node || all.length === 0) return null;

  const name = junctionName(node);
  const several = all.length > 1;
  const scale = picture ? Math.min(FRAME.width / picture.width, FRAME.height / picture.height, MAX_SCALE) : 1;
  const focusStyle: CSSProperties | undefined = picture
    ? {
        left: (FRAME.width - picture.width * scale) / 2 + picture.focus.x * scale,
        top: (FRAME.height - picture.height * scale) / 2 + picture.focus.y * scale,
        width: picture.focus.width * scale,
        height: picture.focus.height * scale,
      }
    : undefined;
  const caption = destination ? [destination.where, destination.sentence].filter(Boolean).join(' · ') : '';

  return createPortal(
    <div
      ref={panelRef}
      className="dc-popover dc-junction-peek"
      role="dialog"
      aria-label={`Where ${name} continues`}
      tabIndex={-1}
      data-closing={closing ? 'true' : undefined}
      data-placement={placement}
      data-by={state.by}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="dc-popover-caret" aria-hidden="true" />
      <div className="dc-popover-inner">
        <header className="dc-junction-peek-head">
          <span className="dc-junction-peek-glyph" aria-hidden="true">
            {(node.text ?? '').trim().slice(0, 3)}
          </span>
          <span className="dc-junction-peek-title">
            <strong>{name}</strong>
            <span>{several ? `Continues in ${count(all.length, 'place')}` : 'Continues in one other place'}</span>
          </span>
        </header>

        <button
          type="button"
          className="dc-junction-picture"
          style={{ width: FRAME.width, height: FRAME.height, backgroundColor: style.theme(themeName).canvas }}
          aria-label={destination ? `Go to ${placeTitle(destination, active)}` : undefined}
          tabIndex={-1}
          onClick={() => go(destination)}
        >
          {picture ? (
            <>
              <span
                className="dc-junction-picture-art"
                style={{ width: picture.width * scale, height: picture.height * scale }}
                // The export renderer's own markup: shapes, paths and text, no scripts and no links.
                dangerouslySetInnerHTML={{ __html: picture.svg }}
              />
              <span className="dc-junction-picture-focus" style={focusStyle} />
            </>
          ) : picture === null ? (
            <span className="dc-junction-picture-words">{caption || 'Nothing is connected here yet.'}</span>
          ) : null}
        </button>
        {caption && !several && <p className="dc-junction-peek-caption">{caption}</p>}

        {several && (
          <>
            {all.length > FILTER_FROM && (
              <input
                className="dc-junction-filter"
                type="search"
                value={query}
                placeholder="Filter places"
                aria-label="Filter places"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                }}
              />
            )}
            <div className="dc-junction-places" role="listbox" aria-label="Linked places">
              {places.map((place, at) => (
                <button
                  key={place.member.node.id}
                  type="button"
                  role="option"
                  className="dc-junction-place"
                  aria-selected={at === active}
                  tabIndex={at === active ? 0 : -1}
                  onPointerEnter={() => setIndex(at)}
                  onFocus={() => setIndex(at)}
                  onClick={() => go(place)}
                >
                  <span className="dc-junction-place-number" aria-hidden="true">
                    {all.indexOf(place) + 1}
                  </span>
                  <span className="dc-junction-place-words">
                    <strong>{placeTitle(place, all.indexOf(place))}</strong>
                    <span>{place.sentence || 'Not connected to anything yet'}</span>
                  </span>
                  <Icon name="external" size={14} className="dc-junction-place-go" />
                </button>
              ))}
              {places.length === 0 && <p className="dc-junction-peek-caption">No place matches “{query.trim()}”.</p>}
            </div>
          </>
        )}

        <footer className="dc-junction-peek-foot">
          {several ? (
            <span className="dc-junction-peek-hint">{asked ? '↑ ↓ to look · Enter to go · Esc to close' : 'Click a place to go there'}</span>
          ) : (
            <button type="button" className="dc-junction-go" onClick={() => go(destination)}>
              Go there
              <Icon name="external" size={14} />
              <kbd>G</kbd>
            </button>
          )}
        </footer>
      </div>
    </div>,
    target,
  );
}
