import { useEffect, useLayoutEffect, useMemo, useRef, type AnimationEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useStoreApi } from '@xyflow/react';
import { displayNameFor } from '../../document/factory';
import type { Attachment, DraftNode } from '../../document/types';
import {
  calloutReach,
  inflate,
  placeCallout,
  segmentBoxes,
  type Box,
  type CalloutPlacementName,
} from '../../presentation/calloutPlacement';
import type { PresentationSubject } from '../../presentation/presentationAttachments';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { useThemeValue } from '../../ui/theme/useTheme';
import { ReadOnlyCode } from '../AttachmentPresentation';
import { attachmentLookFor } from '../../nodes/attachmentLook';
import { flattenPath } from '../../edges/routing';
import { rectOfInternal } from '../edgeGeometry';
import { useOverlayPosition, type OverlayFrame } from '../useOverlayPosition';
import { edgeAnchor, nodeAnchor, type FlowAnchor } from './presentationAnchor';

/** Canvas margin the callout keeps, in screen pixels. */
const EDGE_MARGIN = 16;
/** Breathing room around presentation chrome — the flow bar, the exit button. */
const CHROME_MARGIN = 10;
/** How thick a connector's line counts as, when keeping the callout off it. */
const LINE_THICKNESS = 10;
/** The shortest a docked callout is capped to — a couple of lines, scrolling past that. */
const MIN_ROOM = 72;
/** Everything riding on a connector that a callout would hide: labels, captions, chips. */
const DRAWN_LABELS = '.dc-edge-label, .dc-edge-caption, .dc-edge-meta, .dc-attachment-chip-row';
/** Must match `@keyframes dc-callout-out` in `canvas.css`, and its 140 ms there. */
const EXIT_ANIMATION = 'dc-callout-out';
const EXIT_MS = 140;

/** The presentation chrome a callout never covers: the flow bar, the exit button, and the step's
 *  caption or the opening/closing card, in whichever corner it took. */
const CHROME = ['.dc-explain', '.dc-present-exit', '.dc-present-caption, .dc-present-card'] as const;
const NO_BOXES = new Float64Array(0);

function packBoxes(boxes: readonly Box[]): Float64Array {
  const packed = new Float64Array(boxes.length * 4);
  boxes.forEach((box, index) => {
    packed[index * 4] = box.x;
    packed[index * 4 + 1] = box.y;
    packed[index * 4 + 2] = box.width;
    packed[index * 4 + 3] = box.height;
  });
  return packed;
}

/** Hands `take` every packed box that comes within `pad` of `area` — the rest can't overlap it. */
function collect(packed: Float64Array, area: Box, pad: number, take: (box: Box) => void): void {
  const left = area.x - pad;
  const top = area.y - pad;
  const right = area.x + area.width + pad;
  const bottom = area.y + area.height + pad;
  for (let i = 0; i < packed.length; i += 4) {
    const x = packed[i]!;
    const y = packed[i + 1]!;
    const width = packed[i + 2]!;
    const height = packed[i + 3]!;
    if (x > right || y > bottom || x + width < left || y + height < top) continue;
    take({ x, y, width, height });
  }
}

function chromeBox(selector: string): Box | null {
  const element = window.document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
}

/**
 * One presentation callout: an element's attachments, told beside it while its step plays.
 *
 * Lives in screen space (portaled into React Flow's root, like every canvas popover), so it keeps
 * its real size at any zoom and never inherits the presentation's dimming. Its position, and the
 * thread back to its marker, are recomputed on every pan/zoom frame and size change by
 * `useOverlayPosition` — written straight to the DOM, never through a React render.
 */
export function PresentationCallout({
  subject,
  leaving,
  onSettled,
}: {
  subject: PresentationSubject;
  leaving: boolean;
  onSettled: (key: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const storeApi = useStoreApi();
  const theme = useThemeValue();
  const document = useEditorStore((state) => state.document);
  const edge = subject.hostKind === 'edge' ? edgeIndex(document.edges).get(subject.hostId) : undefined;
  const hostNode = subject.hostKind === 'node' ? nodeIndex(document.nodes).get(subject.hostId) : undefined;
  const source = useInternalNode(edge?.source ?? '');
  const target = useInternalNode(edge?.target ?? '');
  const hostInternal = useInternalNode(hostNode?.id ?? '');

  // Routing the connector for its label point isn't free — only redone when what it reads changes.
  const anchor: FlowAnchor | null = useMemo(
    () => (edge ? edgeAnchor(document, edge, source, target) : hostNode ? nodeAnchor(hostInternal) : null),
    [document, edge, hostNode, source, target, hostInternal],
  );
  // Presentation chrome sits still in screen space while the canvas pans beneath it, so it's measured
  // when something could have moved it — a commit here, the canvas resizing, the step changing (its
  // caption takes a corner, or moves to another one as a manual pan slides the interaction under it)
  // — never per frame. A box not on screen yet is looked for again.
  const chromeRef = useRef<{ root: DOMRect; boxes: (Box | null)[] } | null>(null);
  useEffect(() => {
    const offEditor = useEditorStore.subscribe((state, previous) => {
      if (state.flowPlayback.step !== previous.flowPlayback.step || state.flowPlayback.stage !== previous.flowPlayback.stage) {
        chromeRef.current = null;
      }
    });
    // The caption changes corner without a step change (`useCaptionFollowsCamera`); a cached box
    // would keep the callout off where the caption was and let it land on where it is.
    const offUi = useUiStore.subscribe((state, previous) => {
      if (state.presentation.captionCorner !== previous.presentation.captionCorner) chromeRef.current = null;
    });
    return () => {
      offEditor();
      offUi();
    };
  }, []);

  // Everything placement keeps off, in flow space — every other node, every connector as drawn (each
  // hit path carries its canonical route) and every label and chip row riding on one — read once
  // per commit, so a pan/zoom frame only maps boxes to the screen: no walking the node lookup, no
  // re-segmenting routes, no measuring. Stored flat (x, y, width, height per box) so a frame's cull
  // to the callout's reach is a scan over numbers, not a walk over objects. Declared before
  // `useOverlayPosition` so its layout effect sees this commit's obstacles.
  const obstaclesRef = useRef<{ nodes: Float64Array; segments: Float64Array; labels: Float64Array }>({
    nodes: NO_BOXES,
    segments: NO_BOXES,
    labels: NO_BOXES,
  });
  // The marker's flow box, measured with this commit's obstacles rather than per frame. A marker not
  // mounted yet (its row renders in another component's commit) is looked for again next frame.
  const markerRef = useRef<{ box: Box; measured: boolean } | null>(null);
  useLayoutEffect(() => {
    const { domNode: root, transform, nodeLookup } = storeApi.getState();
    markerRef.current = null;
    chromeRef.current = null;
    if (!root) return;
    const [tx, ty, zoom] = transform;
    const rootRect = root.getBoundingClientRect();
    const types = new Map(document.nodes.map((node) => [node.id, node.type]));
    const nodes: Box[] = [];
    for (const internal of nodeLookup.values()) {
      // Boundaries are skipped: a callout inside a group is still "beside" what it annotates. So
      // are the ones the anchor already keeps the callout off outright.
      if (types.get(internal.id) === 'group' || anchor?.exclude.includes(internal.id)) continue;
      const rect = rectOfInternal(internal);
      if (rect) nodes.push(rect);
    }
    obstaclesRef.current = {
      nodes: packBoxes(nodes),
      // Zero-thickness in flow space; the line's thickness is a screen size, added per frame.
      segments: packBoxes(
        [...root.querySelectorAll<SVGPathElement>('.dc-edge-hit')].flatMap((path) =>
          segmentBoxes(flattenPath(path.getAttribute('d') ?? ''), 0),
        ),
      ),
      labels: packBoxes(
        [...root.querySelectorAll<Element>(DRAWN_LABELS)].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: (rect.left - rootRect.left - tx) / zoom,
            y: (rect.top - rootRect.top - ty) / zoom,
            width: rect.width / zoom,
            height: rect.height / zoom,
          };
        }),
      ),
    };
  }, [document, storeApi, source, target, hostInternal, anchor]);

  // The tallest a docked callout may be and still clear the flow bar. Only ever tightens while this
  // callout lives: capping shrinks its measured size, and a cap that lifted again as a result would
  // hand placement back the size that needed it — a resize loop.
  const roomRef = useRef(Number.POSITIVE_INFINITY);
  // …except when the canvas itself grows (a window resized taller, the flow bar shrinking back): that
  // room is real, not something capping caused, so the cap starts over.
  const rootHeightRef = useRef(0);

  const place = (frame: OverlayFrame, current: CalloutPlacementName) => {
    if (!anchor || frame.size.width === 0) return null;
    const { root, size } = frame;
    if (root.height > rootHeightRef.current + 1) roomRef.current = Number.POSITIVE_INFINITY;
    rootHeightRef.current = root.height;
    const { transform, domNode } = storeApi.getState();
    const [tx, ty, zoom] = transform;
    // Flow → screen is one affine map; `flowToScreenPosition` per corner, per box, per frame adds up.
    const toScreen = (box: Box): Box => ({
      x: root.left + box.x * zoom + tx,
      y: root.top + box.y * zoom + ty,
      width: box.width * zoom,
      height: box.height * zoom,
    });
    if (!markerRef.current?.measured) markerRef.current = anchor.marker(domNode);
    const marker = toScreen(markerRef.current.box);

    if (chromeRef.current?.root !== root) chromeRef.current = { root, boxes: [] };
    const chrome = chromeRef.current.boxes;
    CHROME.forEach((selector, index) => {
      if (!chrome[index]) chrome[index] = chromeBox(selector);
    });
    const [flowBar = null, exitButton = null, card = null] = chrome;
    const bounds: Box = {
      x: root.left + EDGE_MARGIN,
      y: root.top + EDGE_MARGIN,
      width: root.width - EDGE_MARGIN * 2,
      height: root.height - EDGE_MARGIN * 2,
    };
    const base = {
      kind: anchor.kind,
      marker,
      host: anchor.host ? toScreen(anchor.host) : marker,
      preferBelow: anchor.preferBelow,
      avoid: anchor.avoid.map(toScreen),
      exclusions: [flowBar, exitButton, card]
        .filter((box): box is Box => box !== null)
        .map((box) => inflate(box, CHROME_MARGIN)),
      bounds,
      size,
      current,
      dockTo: flowBar,
    };

    // Every other element on the canvas is a soft obstacle — covered only when nothing clean exists.
    // Only those inside the callout's reach (every spot it could take, mapped back to flow space)
    // can change where it goes; the rest are never mapped to the screen at all.
    const soft: Box[] = [];
    const reach = calloutReach(base);
    if (reach) {
      const area = {
        x: (reach.x - root.left - tx) / zoom,
        y: (reach.y - root.top - ty) / zoom,
        width: reach.width / zoom,
        height: reach.height / zoom,
      };
      const obstacles = obstaclesRef.current;
      collect(obstacles.nodes, area, 0, (box) => soft.push(toScreen(box)));
      collect(obstacles.segments, area, LINE_THICKNESS / 2 / zoom, (box) =>
        soft.push(inflate(toScreen(box), LINE_THICKNESS / 2)),
      );
      collect(obstacles.labels, area, 0, (box) => soft.push(toScreen(box)));
    }

    const result = placeCallout({ ...base, soft });
    if (result.maxHeight !== undefined) roomRef.current = Math.min(roomRef.current, result.maxHeight);

    const at = frame.screenToOverlay({ x: result.x, y: result.y });
    const leader = result.leader;
    const length = leader ? Math.hypot(leader.x2 - leader.x1, leader.y2 - leader.y1) : 0;
    const angle = leader ? Math.atan2(leader.y2 - leader.y1, leader.x2 - leader.x1) : 0;
    const px = (n: number) => `${Math.round(n * 10) / 10}px`;
    return {
      placement: result.placement,
      transform: `translate(${px(at.x)}, ${px(at.y)})`,
      vars: {
        '--dc-callout-leader-x': px(leader ? leader.x1 - result.x : 0),
        '--dc-callout-leader-y': px(leader ? leader.y1 - result.y : 0),
        '--dc-callout-leader-length': px(length),
        '--dc-callout-leader-angle': `${Math.round(angle * 1000) / 1000}rad`,
        '--dc-callout-marker-x': px(marker.x - result.x),
        '--dc-callout-marker-y': px(marker.y - result.y),
        '--dc-callout-marker-width': px(marker.width),
        '--dc-callout-marker-height': px(marker.height),
        // Never below a few readable lines (it scrolls past that): a canvas squeezed to nothing for a
        // moment must not leave the callout a zero-height strip for the rest of the step.
        '--dc-callout-room': Number.isFinite(roomRef.current) ? px(Math.max(MIN_ROOM, roomRef.current)) : '9999px',
      },
    };
  };

  const { target: portalTarget } = useOverlayPosition<CalloutPlacementName>(panelRef, 'above', place);

  // A leaf that has to scroll says so with a fade (vertically) and becomes keyboard-scrollable (either
  // way — a long code line too); one that fits stays a plain, unfocusable block. Re-measured whenever
  // the callout's box changes size — a window resize moves its `vh` cap — not per frame.
  const mounted = portalTarget !== null && anchor !== null;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      for (const scroller of panel.querySelectorAll<HTMLElement>('[data-callout-scroll]')) {
        const tall = scroller.scrollHeight > scroller.clientHeight + 1;
        const wide = scroller.scrollWidth > scroller.clientWidth + 1;
        scroller.dataset.overflowing = tall ? 'true' : 'false';
        if (tall || wide) scroller.tabIndex = 0;
        else scroller.removeAttribute('tabindex');
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [subject.attachments, mounted]);

  // A departing callout with nothing left to hang from never plays its exit — let it go at once.
  useEffect(() => {
    if (leaving && !anchor) onSettled(subject.key);
  }, [leaving, anchor, onSettled, subject.key]);
  // `animationend` is how a departing callout normally goes, but an exit the browser cancels — or
  // never gets round to on a starved page — sends none, and the callout stayed on screen as a ghost
  // until the next step replaced it. (React has no `animationcancel`.) This lets it go regardless;
  // `settle` ignores a key that has already gone, so the two never both act.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onSettled(subject.key), EXIT_MS + 260);
    return () => window.clearTimeout(timer);
  }, [leaving, onSettled, subject.key]);

  if (!portalTarget || !anchor) return null;

  const first = subject.attachments[0]!;
  const firstLook = attachmentLookFor(theme, first);
  const hasCode = subject.attachments.some((attachment) => attachment.type === 'code');
  const ownerName = edge
    ? `${nameOf(document.nodes, edge.source)} to ${nameOf(document.nodes, edge.target)}`
    : hostNode
      ? displayNameFor(hostNode)
      : '';
  const what =
    subject.attachments.length === 1 ? firstLook.label.toLowerCase() : `${subject.attachments.length} attachments`;

  return createPortal(
    <div
      ref={panelRef}
      className="dc-callout"
      role="note"
      aria-label={`Presented ${what} for ${ownerName}`}
      data-kind={first.type === 'code' ? 'code' : 'note'}
      data-leaving={leaving ? 'true' : undefined}
      data-wide={hasCode ? 'true' : undefined}
      aria-hidden={leaving ? true : undefined}
      // Nothing inside a departing callout keeps (or takes) focus.
      inert={leaving}
      style={
        {
          '--dc-callout-fill': firstLook.fill,
          '--dc-callout-line': firstLook.border,
          '--dc-callout-accent': firstLook.accent,
        } as CSSProperties
      }
      // A click or drag inside reads (or selects) the text — it must never pan the canvas beneath.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onAnimationEnd={(event: AnimationEvent) => {
        if (leaving && event.animationName === EXIT_ANIMATION) onSettled(subject.key);
      }}
    >
      <span className="dc-callout-pulse" aria-hidden="true" />
      <span className="dc-callout-leader" aria-hidden="true" />
      <div className="dc-callout-card">
        <ol className="dc-callout-thread" data-callout-scroll="" data-count={subject.attachments.length}>
          {subject.attachments.map((attachment, index) => (
            <CalloutLeaf key={attachment.id} attachment={attachment} index={index} />
          ))}
        </ol>
      </div>
    </div>,
    portalTarget,
  );
}

function nameOf(nodes: readonly DraftNode[], id: string): string {
  const node = nodes.find((candidate) => candidate.id === id);
  return node ? displayNameFor(node) : 'Untitled';
}

/** One attachment on the thread — its own knot, eyebrow and content, in its own accent. */
function CalloutLeaf({ attachment, index }: { attachment: Attachment; index: number }) {
  const theme = useThemeValue();
  const look = attachmentLookFor(theme, attachment);
  const isCode = attachment.type === 'code';
  return (
    <li
      className="dc-callout-leaf"
      data-kind={isCode ? 'code' : 'note'}
      style={{ '--i': index, '--dc-leaf-accent': look.accent, '--dc-leaf-line': look.border } as CSSProperties}
    >
      <span className="dc-callout-knot" aria-hidden="true">
        {isCode ? '{ }' : null}
      </span>
      <span className="dc-callout-eyebrow">{look.label}</span>
      {isCode ? (
        <div className="dc-callout-code" data-callout-scroll="">
          <ReadOnlyCode language={attachment.language ?? 'plaintext'} code={attachment.code ?? ''} />
        </div>
      ) : (
        <p className="dc-callout-note">{attachment.text}</p>
      )}
    </li>
  );
}
