import { useLayoutEffect, useRef, type AnimationEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useStoreApi } from '@xyflow/react';
import { displayNameFor } from '../../document/factory';
import type { Attachment, DraftNode } from '../../document/types';
import {
  placeCallout,
  segmentBoxes,
  type Box,
  type CalloutPlacementName,
} from '../../presentation/calloutPlacement';
import type { PresentationSubject } from '../../presentation/presentationAttachments';
import { useEditorStore } from '../../store/editorStore';
import { edgeIndex, nodeIndex } from '../../store/selectors';
import { useThemeValue } from '../../ui/theme/useTheme';
import { ReadOnlyCode } from '../AttachmentPresentation';
import { attachmentLookFor } from '../attachmentLook';
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
/** Everything riding on a connector that a callout would hide: labels, captions, chips. */
const DRAWN_LABELS = '.dc-edge-label, .dc-edge-caption, .dc-edge-meta, .dc-attachment-chip-row';
/** Must match `@keyframes dc-callout-out` in `canvas.css`. */
const EXIT_ANIMATION = 'dc-callout-out';

const inflate = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
});

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

  const anchor: FlowAnchor | null = edge
    ? edgeAnchor(document, edge, source, target)
    : hostNode
      ? nodeAnchor(hostInternal)
      : null;
  // Every connector as drawn (each hit path carries its canonical route, in flow coordinates) and
  // every label and chip row riding on one — read once per commit into flow space, so placement
  // keeps off them on every pan/zoom frame without re-routing or re-measuring anything.
  // Declared before `useOverlayPosition` so its layout effect sees this commit's obstacles.
  const drawnRef = useRef<{ lines: { x: number; y: number }[][]; labels: Box[] }>({ lines: [], labels: [] });
  useLayoutEffect(() => {
    const { domNode: root, transform } = storeApi.getState();
    if (!root) return;
    const [tx, ty, zoom] = transform;
    const rootRect = root.getBoundingClientRect();
    drawnRef.current = {
      lines: [...root.querySelectorAll<SVGPathElement>('.dc-edge-hit')].map((path) =>
        flattenPath(path.getAttribute('d') ?? ''),
      ),
      labels: [...root.querySelectorAll<Element>(DRAWN_LABELS)].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: (rect.left - rootRect.left - tx) / zoom,
          y: (rect.top - rootRect.top - ty) / zoom,
          width: rect.width / zoom,
          height: rect.height / zoom,
        };
      }),
    };
  }, [document, storeApi]);

  const types = new Map(document.nodes.map((node) => [node.id, node.type]));

  const place = (frame: OverlayFrame, current: CalloutPlacementName) => {
    if (!anchor || frame.size.width === 0) return null;
    const { flowToScreenPosition, root, size } = frame;
    const toScreen = (box: Box): Box => {
      const topLeft = flowToScreenPosition({ x: box.x, y: box.y });
      const bottomRight = flowToScreenPosition({ x: box.x + box.width, y: box.y + box.height });
      return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    };
    const rootElement = storeApi.getState().domNode;
    const marker = toScreen(anchor.marker(rootElement));

    // Every other element on the canvas is a soft obstacle — covered only when nothing clean exists.
    // Boundaries are skipped: a callout inside a group is still "beside" what it annotates.
    const soft: Box[] = [];
    for (const internal of storeApi.getState().nodeLookup.values()) {
      if (anchor.exclude.includes(internal.id) || types.get(internal.id) === 'group') continue;
      const rect = rectOfInternal(internal);
      if (rect) soft.push(toScreen(rect));
    }
    for (const line of drawnRef.current.lines) {
      soft.push(...segmentBoxes(line.map((point) => flowToScreenPosition(point)), LINE_THICKNESS));
    }
    soft.push(...drawnRef.current.labels.map(toScreen));

    const flowBar = chromeBox('.dc-explain');
    const exitButton = chromeBox('.dc-present-exit');
    const bounds: Box = {
      x: root.left + EDGE_MARGIN,
      y: root.top + EDGE_MARGIN,
      width: root.width - EDGE_MARGIN * 2,
      height: root.height - EDGE_MARGIN * 2,
    };
    const result = placeCallout({
      kind: anchor.kind,
      marker,
      host: anchor.host ? toScreen(anchor.host) : marker,
      preferBelow: anchor.preferBelow,
      avoid: anchor.avoid.map(toScreen),
      soft,
      exclusions: [flowBar, exitButton]
        .filter((box): box is Box => box !== null)
        .map((box) => inflate(box, CHROME_MARGIN)),
      bounds,
      size,
      current,
      dockTo: flowBar,
    });

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
      },
    };
  };

  const { target: portalTarget } = useOverlayPosition<CalloutPlacementName>(panelRef, 'above', place);

  // A code leaf that has to scroll says so with a fade, and becomes keyboard-scrollable; one that
  // fits stays a plain, unfocusable block. Measured once per content change, not per frame.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    for (const scroller of panel.querySelectorAll<HTMLElement>('[data-callout-scroll]')) {
      const overflowing = scroller.scrollHeight > scroller.clientHeight + 1;
      scroller.dataset.overflowing = overflowing ? 'true' : 'false';
      if (overflowing) scroller.tabIndex = 0;
      else scroller.removeAttribute('tabindex');
    }
  }, [subject.attachments]);

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
