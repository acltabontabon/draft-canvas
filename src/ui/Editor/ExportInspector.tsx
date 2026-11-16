import { useRef, useState, type PointerEvent } from 'react';
import { Modal } from '../common/Modal';
import { SegmentedControl } from '../common/SegmentedControl';

type Zoom = 'fit' | '1' | '2';

const ZOOMS: { value: Zoom; label: string; name: string }[] = [
  { value: 'fit', label: 'Fit', name: 'Fit the whole image' },
  { value: '1', label: '100%', name: '100%, actual size' },
  { value: '2', label: '200%', name: '200%, twice the size' },
];

/**
 * The image an export would produce, large enough to judge: the picture in a README or on a slide
 * is often all another developer sees of the diagram, and the dialog's tile is a hundred pixels tall.
 * Opens over the Export dialog (a nested `Modal`, so Escape closes only this) on the whole image, and
 * at **100%** shows it at the size it is drawn — one unit of the diagram to one pixel, the size an SVG
 * or a 2× PNG has on the page — so its smallest text can be read as a reader will meet it.
 *
 * The very SVG the tile shows, scaled by the browser as a vector: nothing is rendered again, and no
 * zoom level blurs. Drag to move around it, or scroll; the arrow keys scroll it once it has focus.
 */
export function ExportInspector({
  src,
  width,
  height,
  fileName,
  meta,
  background,
  onClose,
}: {
  src: string;
  /** The image's size as drawn, in the diagram's own units. */
  width: number;
  height: number;
  fileName: string;
  meta: string;
  /** The stage's fill; none for a transparent export, which sits on the checkerboard. */
  background: string | undefined;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState<Zoom>('fit');
  const view = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const scale = zoom === 'fit' ? null : Number(zoom);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const el = view.current;
    if (!el || event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const el = view.current;
    const from = drag.current;
    if (!el || !from) return;
    el.scrollLeft = from.left - (event.clientX - from.x);
    el.scrollTop = from.top - (event.clientY - from.y);
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <Modal title="Inspect image" onClose={onClose} width={1280} className="dc-modal-inspect">
      <div className="dc-export-inspect-bar">
        <SegmentedControl name="export-inspect-zoom" legend="Zoom" value={zoom} options={ZOOMS} onChange={setZoom} />
        <span className="dc-export-inspect-meta">
          <span className="dc-export-inspect-name" title={fileName}>{fileName}</span>
          <span>{meta}</span>
        </span>
      </div>
      <div
        ref={view}
        className="dc-export-inspect-view"
        data-zoom={zoom}
        data-transparent={background === undefined ? 'true' : undefined}
        style={background === undefined ? undefined : { background }}
        // Focusable so the arrow keys scroll it; named so a screen reader says what it is.
        tabIndex={0}
        role="img"
        aria-label={`${fileName}, ${zoom === 'fit' ? 'whole image' : `${ZOOMS.find((z) => z.value === zoom)?.label}`}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setZoom(zoom === 'fit' ? '1' : 'fit')}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          // `fit` is CSS's (never past its own size); a zoom is that many pixels per unit drawn.
          style={scale === null ? undefined : { width: width * scale, height: height * scale }}
        />
      </div>
    </Modal>
  );
}
