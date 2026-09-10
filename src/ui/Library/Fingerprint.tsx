import { memo } from 'react';
import { isLibraryShape } from '../../document/shape';
import type { LibraryShape, ShapeKind } from '../../document/types';

const WIDTH = 56;
const HEIGHT = 32;
const PAD = 2;
/** Nothing smaller than this is a mark; it is a smudge. */
const MIN_MARK = 3;

/**
 * A canvas's topology at thumbnail size — the thing that lets someone tell
 * "the checkout one" from "the events one" in a list of a dozen "Untitled
 * canvas"es without opening either.
 *
 * Drawn from `LibraryShape`, not from the document (the list never has the
 * document — see `DraftSummary`), with plain SVG primitives rather than
 * `describeNode`. That is a deliberate exception to the one-renderer rule
 * `ShapePreview.tsx` follows: at 4–8px a real service silhouette, with its
 * corner radius and kind tag, is illegible, and a hand-drawn wobble is noise.
 * What survives at this size is *category* — box, cylinder, pill, circle,
 * dot, dashed frame — and that is all this draws. Everything is
 * `currentColor`, so the row's own text colour themes it for free.
 */
export const Fingerprint = memo(function Fingerprint({ shape }: { shape: LibraryShape | undefined }) {
  const drawable = isLibraryShape(shape) && shape.nodes.length > 0;
  return (
    <svg
      className="dc-fingerprint"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      aria-hidden="true"
      focusable="false"
    >
      {drawable ? (
        <Glyphs shape={shape} />
      ) : (
        <rect className="dc-fingerprint-empty" x={PAD + 0.5} y={PAD + 0.5} width={WIDTH - 2 * PAD - 1} height={HEIGHT - 2 * PAD - 1} rx={2} />
      )}
    </svg>
  );
});

function Glyphs({ shape }: { shape: LibraryShape }) {
  const scale = Math.min((WIDTH - 2 * PAD) / Math.max(shape.w, 1), (HEIGHT - 2 * PAD) / Math.max(shape.h, 1));
  const ox = PAD + (WIDTH - 2 * PAD - shape.w * scale) / 2;
  const oy = PAD + (HEIGHT - 2 * PAD - shape.h * scale) / 2;
  const boxes = shape.nodes.map(([kind, x, y, w, h]) => {
    const width = Math.max(MIN_MARK, w * scale);
    const height = Math.max(MIN_MARK, h * scale);
    // Grow around the centre when clamped, so a tiny node stays where it was.
    const left = ox + x * scale - (width - w * scale) / 2;
    const top = oy + y * scale - (height - h * scale) / 2;
    return { kind, x: left, y: top, w: width, h: height, cx: left + width / 2, cy: top + height / 2 };
  });

  return (
    <>
      {shape.edges.map(([from, to], i) => {
        const a = boxes[from];
        const b = boxes[to];
        if (!a || !b) return null;
        return <line key={`e${i}`} className="dc-fingerprint-edge" x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} />;
      })}
      {boxes.map((box, i) => (
        <Mark key={`n${i}`} {...box} />
      ))}
    </>
  );
}

function Mark({ kind, x, y, w, h, cx, cy }: { kind: ShapeKind; x: number; y: number; w: number; h: number; cx: number; cy: number }) {
  switch (kind) {
    case 'boundary':
      return <rect className="dc-fingerprint-boundary" x={x} y={y} width={w} height={h} rx={1.5} />;
    case 'actor':
      return <circle className="dc-fingerprint-actor" cx={cx} cy={cy} r={Math.min(w, h) / 2} />;
    case 'junction':
      return <circle className="dc-fingerprint-junction" cx={cx} cy={cy} r={1.4} />;
    case 'database':
      return (
        <g className="dc-fingerprint-database">
          <rect x={x} y={y} width={w} height={h} rx={1} />
          <line x1={x} y1={y + Math.min(2, h * 0.3)} x2={x + w} y2={y + Math.min(2, h * 0.3)} />
        </g>
      );
    case 'queue':
      return <rect className="dc-fingerprint-queue" x={x} y={y} width={w} height={h} rx={h / 2} />;
    case 'topic':
      return <rect className="dc-fingerprint-topic" x={x} y={y} width={w} height={h} rx={h / 2} />;
    case 'external':
      return <rect className="dc-fingerprint-external" x={x} y={y} width={w} height={h} rx={1} />;
    case 'component':
      return <rect className="dc-fingerprint-component" x={x} y={y} width={w} height={h} rx={1} />;
    default:
      return <rect className="dc-fingerprint-service" x={x} y={y} width={w} height={h} rx={1} />;
  }
}
