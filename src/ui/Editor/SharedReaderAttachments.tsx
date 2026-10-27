import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useStore, useStoreApi } from '@xyflow/react';
import { ReadOnlyCode } from '../../canvas/AttachmentPresentation';
import { markerLoop } from '../../canvas/trafficSketchPaths';
import { familyOf } from '../../render/text/fonts';
import { OpenPointGlyph } from '../../canvas/OpenPointGlyph';
import { rectOfInternal } from '../../canvas/edgeGeometry';
import { edgeAnchor } from '../../canvas/presentation/presentationAnchor';
import { useOverlayPosition, type OverlayFrame } from '../../canvas/useOverlayPosition';
import { pathKey } from '../../depth/tree';
import { OPEN_POINT_LABELS } from '../../document/openPoints';
import { NOTE_LABELS } from '../../nodes/describe';
import type { ElementTarget } from '../../openPoints/locate';
import { inflate, placeCallout, type Box, type CalloutPlacementName } from '../../presentation/calloutPlacement';
import type { ReaderContextItem } from '../../share/context';
import { useEditorStore } from '../../store/editorStore';
import { edgeIndex } from '../../store/selectors';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

export interface ReaderAttachmentSelection { id: string; target: ElementTarget }
interface AttachmentGroup { target: ElementTarget; items: ReaderContextItem[] }
interface Props {
  items: ReaderContextItem[];
  selected: ReaderAttachmentSelection | null;
  onSelect: (item: ReaderContextItem, target: ElementTarget, reveal?: boolean) => void;
  onClose: () => void;
}

const labelOf = (item: ReaderContextItem) => item.point
  ? item.point.resolved ? 'Resolved' : OPEN_POINT_LABELS[item.point.kind]
  : item.code ? 'Code' : sentenceCase(NOTE_LABELS[item.note?.noteKind ?? 'note']);

const sentenceCase = (label: string) => label[0]! + label.slice(1).toLowerCase();

function DetailGlyph({ item }: { item: ReaderContextItem }) {
  return item.point ? <OpenPointGlyph kind={item.point.kind} /> : <Icon name={item.code ? 'code' : item.note?.noteKind === 'decision' ? 'flow' : 'file'} size={14} />;
}

/** Reader-only chrome. The underlying canvas keeps drawing the actual shapes and connectors. */
export function SharedReaderAttachments({ items, selected, onSelect, onClose }: Props) {
  const path = useEditorStore((state) => state.path);
  const compact = useStore((state) => state.width <= 650 || state.height < 340);
  const groups = useMemo(() => {
    const byHost = new Map<string, AttachmentGroup>();
    for (const item of items) for (const target of item.targets) {
      if (pathKey(target.path) !== pathKey(path)) continue;
      const key = `${target.kind}:${target.id}`;
      const group = byHost.get(key);
      if (group) group.items.push(item);
      else byHost.set(key, { target, items: [item] });
    }
    return [...byHost.values()];
  }, [items, path]);
  const item = items.find((entry) => entry.id === selected?.id);
  const here = selected && pathKey(selected.target.path) === pathKey(path);
  const card = item && selected && here ? (
    <DetailCard item={item} target={selected.target} index={items.indexOf(item)} count={items.length} onClose={onClose}
      onBrowse={(direction) => {
        const next = items[(items.indexOf(item) + direction + items.length) % items.length]!;
        const target = next.targets.find((entry) => pathKey(entry.path) === pathKey(path)) ?? next.targets[0];
        if (target) onSelect(next, target, true);
      }} onTarget={(target) => onSelect(item, target, true)} />
  ) : null;
  return <>
    {groups.map((group) => <AttachmentMarker key={`${group.target.kind}:${group.target.id}`} group={group} selected={selected} onSelect={onSelect} onClose={onClose} />)}
    {card && (compact ? <div className="dc-reader-attachment-dock">{card}</div> : <FloatingDetail target={selected!.target}>{card}</FloatingDetail>)}
  </>;
}

/** Read geometry only when its host changes; camera frames reuse it without rendering React. */
function useDetailAnchor(target: ElementTarget) {
  const document = useEditorStore((state) => state.document);
  const edge = target.kind === 'edge' ? edgeIndex(document.edges).get(target.id) : undefined;
  const host = useInternalNode(target.kind === 'node' ? target.id : '');
  const source = useInternalNode(edge?.source ?? '');
  const destination = useInternalNode(edge?.target ?? '');
  return useMemo(() => {
    if (host) {
      const box = rectOfInternal(host);
      return box ? { kind: 'node' as const, point: { x: box.x + box.width / 2, y: box.y }, host: box, avoid: [box], below: false } : null;
    }
    const anchor = edge ? edgeAnchor(document, edge, source, destination) : null;
    if (!anchor) return null;
    const marker = anchor.marker(null).box;
    return { kind: 'edge' as const, point: { x: marker.x + marker.width / 2, y: marker.y }, host: marker, avoid: anchor.avoid, below: anchor.preferBelow };
  }, [document, edge, host, source, destination]);
}

function AttachmentMarker({ group, selected, onSelect, onClose }: Pick<Props, 'selected' | 'onSelect' | 'onClose'> & { group: AttachmentGroup }) {
  const ref = useRef<HTMLButtonElement>(null);
  const anchor = useDetailAnchor(group.target);
  const loop = useMemo(() => markerLoop({ x: 6, y: 5, width: 108, height: 22 }, `reader:${group.target.kind}:${group.target.id}`), [group.target.kind, group.target.id]);
  const active = selected?.target.id === group.target.id && group.items.some((item) => item.id === selected.id);
  const item = group.items.find((entry) => entry.id === selected?.id) ?? group.items.find((entry) => !entry.point?.resolved) ?? group.items[0]!;
  const { target } = useOverlayPosition(ref, 'above', (frame) => {
    if (!anchor) return null;
    const point = frame.screenToOverlay(frame.flowToScreenPosition(anchor.point));
    return { placement: 'above', transform: `translate(${point.x - frame.size.width / 2}px, ${point.y - frame.size.height - 10}px)` };
  });
  if (!target || !anchor) return null;
  return createPortal(<button type="button" ref={ref} className="dc-reader-attachment-marker nodrag nopan" style={{ fontFamily: familyOf('hand') }} data-reader-host={`${group.target.kind}:${group.target.id}`} aria-label={`Attachments on ${group.target.label}`} aria-expanded={active}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); event.currentTarget.focus(); if (active) onClose(); else onSelect(item, group.target); }}>
    <svg className="dc-reader-annotation-strokes" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="dc-reader-annotation-underline" d="M9 27 Q49 29 110 25 M20 30 Q63 28 102 29" />
      <path className="dc-reader-annotation-loop" d={loop} />
    </svg>
    <DetailGlyph item={item} /><span>{group.items.length > 1 ? 'Details' : item.point && !item.point.resolved ? 'Pending' : labelOf(item)}</span>{group.items.length > 1 && <span className="dc-reader-attachment-count">{group.items.length}</span>}
  </button>, target);
}

function FloatingDetail({ target, children }: { target: ElementTarget; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useDetailAnchor(target);
  const store = useStoreApi();
  const obstacles = useRef<Box[]>([]);
  const otherMarkers = useRef<Array<{ x: number; y: number; width: number; height: number }>>([]);
  const chrome = useRef<{ root: DOMRect; boxes: Box[] } | null>(null);
  useLayoutEffect(() => {
    obstacles.current = [...store.getState().nodeLookup.values()].flatMap((node) => {
      if (node.type === 'group') return [];
      const rect = rectOfInternal(node);
      return rect ? [rect] : [];
    });
    const { domNode, transform: [panX, panY, zoom] } = store.getState();
    if (!domNode) return;
    const root = domNode.getBoundingClientRect();
    // A card must leave every other detail reachable. Cache marker anchors in flow space and
    // their unscaled sizes once; pan/zoom frames can project them without measuring the DOM.
    otherMarkers.current = [...domNode.querySelectorAll<HTMLElement>('.dc-reader-attachment-marker')]
      .filter((marker) => marker.dataset.readerHost !== `${target.kind}:${target.id}`)
      .map((marker) => {
        const rect = marker.getBoundingClientRect();
        return { x: (rect.x + rect.width / 2 - root.x - panX) / zoom, y: (rect.y + rect.height + 10 - root.y - panY) / zoom, width: rect.width, height: rect.height };
      });
  }, [anchor, store, target.kind, target.id]);
  const { target: portal } = useOverlayPosition<CalloutPlacementName>(ref, 'above', (frame, current) => {
    if (!anchor || frame.size.width === 0) return null;
    const zoom = store.getState().transform[2];
    const screenBox = (box: Box): Box => ({ ...frame.flowToScreenPosition(box), width: box.width * zoom, height: box.height * zoom });
    const point = frame.flowToScreenPosition(anchor.point);
    const marker = { x: point.x - 40, y: point.y - 38, width: 80, height: 28 };
    // Only the camera controls occupy this corner; reserving the entire bottom strip forced
    // otherwise-clear cards into the middle of the diagram on shorter desktop windows.
    if (chrome.current?.root !== frame.root) {
      const camera = store.getState().domNode?.closest('.dc-reader-canvas')?.querySelector('.dc-reader-camera')?.getBoundingClientRect();
      chrome.current = { root: frame.root, boxes: camera ? [inflate({ x: camera.x, y: camera.y, width: camera.width, height: camera.height }, 8)] : [] };
    }
    const placed = placeCallout({
      kind: anchor.kind, centeredMarker: true, marker, host: screenBox(anchor.host), avoid: anchor.avoid.map(screenBox),
      soft: obstacles.current.map(screenBox), exclusions: [...chrome.current.boxes, ...otherMarkers.current.map((marker) => {
        const at = frame.flowToScreenPosition(marker);
        return inflate({ x: at.x - marker.width / 2, y: at.y - marker.height - 10, width: marker.width, height: marker.height }, 4);
      })], preferBelow: anchor.below,
      bounds: { x: frame.root.x + 16, y: frame.root.y + 16, width: frame.root.width - 32, height: frame.root.height - 32 },
      size: frame.size, current,
    });
    return detailPlacement(frame, placed);
  });
  return portal && anchor ? createPortal(<div className="dc-reader-floating-detail" ref={ref} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}><svg className="dc-reader-attachment-leader" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="M0 6 Q28 0 52 6 T100 6" /></svg>{children}</div>, portal) : null;
}

function detailPlacement(frame: OverlayFrame, placed: ReturnType<typeof placeCallout>) {
  const point = frame.screenToOverlay(placed);
  const line = placed.leader;
  return { placement: placed.placement, transform: `translate(${point.x}px, ${point.y}px)`, vars: {
    '--dc-reader-leader-x': `${line ? line.x1 - placed.x : 0}px`,
    '--dc-reader-leader-y': `${line ? line.y1 - placed.y : 0}px`,
    '--dc-reader-leader-length': `${line ? Math.hypot(line.x2 - line.x1, line.y2 - line.y1) : 0}px`,
    '--dc-reader-leader-angle': `${line ? Math.atan2(line.y2 - line.y1, line.x2 - line.x1) : 0}rad`,
  } };
}

function DetailCard({ item, target, index, count, onClose, onBrowse, onTarget }: {
  item: ReaderContextItem; target: ElementTarget; index: number; count: number;
  onClose: () => void; onBrowse: (direction: number) => void; onTarget: (target: ElementTarget) => void;
}) {
  const text = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = text.current;
    if (!element) return;
    const measure = () => {
      if (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1) element.tabIndex = 0;
      else element.removeAttribute('tabindex');
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.id]);
  return <section className="dc-reader-attachment-card" aria-label={`${labelOf(item)} for ${target.label}`}>
    <header><span style={{ fontFamily: familyOf('hand') }}><DetailGlyph item={item} />{labelOf(item)}</span><Button variant="quiet" icon="close" aria-label="Close attachment" onClick={onClose} /></header>
    <p className="dc-reader-attachment-owner">{target.room ? `${target.room} / ` : ''}{target.label}</p>
    <div className="dc-reader-attachment-text" key={item.id} ref={text} aria-live="polite">
      {item.code ? <ReadOnlyCode code={item.code.code ?? ''} language={item.code.language ?? 'plaintext'} /> : <p>{item.text}</p>}
      {item.point?.resolution && <div className="dc-reader-attachment-resolution"><span>Resolution</span><p>{item.point.resolution}</p></div>}
      {item.targets.length > 1 && <nav aria-label="Related elements">{item.targets.filter((entry) => entry.id !== target.id).map((entry) => <button type="button" key={entry.id} onClick={() => onTarget(entry)}>Also about {entry.label}<Icon name="external" size={12} /></button>)}</nav>}
    </div>
    <footer><span aria-label={`Attachment ${index + 1} of ${count}`}>{index + 1} / {count}</span><div><Button variant="quiet" icon="back" aria-label="Previous attachment" disabled={count < 2} onClick={() => onBrowse(-1)} /><Button variant="quiet" icon="forward" aria-label="Next attachment" disabled={count < 2} onClick={() => onBrowse(1)} /></div></footer>
  </section>;
}
