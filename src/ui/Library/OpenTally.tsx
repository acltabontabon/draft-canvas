import { memo } from 'react';

/** Boxes drawn before the row gives up and counts instead. Five is about as many as anyone reads
 *  as a quantity rather than as a queue to be counted one at a time. */
const MAX_BOXES = 5;

const BOX = 9;
const GAP = 4;
const STROKE = 1;

/**
 * What a canvas still owes, drawn rather than counted.
 *
 * One unticked box per open action — the same hairline square the Takeaways list puts beside every
 * row, at the same weight, so the Library and the panel are visibly talking about the same thing.
 * Three boxes read as "three" without being read as a number, which is the point: the Library is
 * scanned, not studied, and a quantity you take in at a glance survives that better than a digit.
 *
 * Past five it stops drawing and says the number, because a row of eleven boxes is a thing you
 * have to count, which is precisely what drawing them was for.
 *
 * `currentColor` throughout, like `Fingerprint` — the row's own text colour themes it for free.
 */
export const OpenTally = memo(function OpenTally({ count }: { count: number }) {
  if (count <= 0) return null;
  const boxes = Math.min(count, MAX_BOXES);
  const width = boxes * BOX + (boxes - 1) * GAP;
  return (
    <span className="dc-open-tally">
      <svg
        className="dc-open-tally-boxes"
        viewBox={`0 0 ${width} ${BOX}`}
        width={width}
        height={BOX}
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        {Array.from({ length: boxes }, (_, index) => (
          <rect
            key={index}
            x={index * (BOX + GAP) + STROKE / 2}
            y={STROKE / 2}
            width={BOX - STROKE}
            height={BOX - STROKE}
            rx={2}
            stroke="currentColor"
            strokeWidth={STROKE}
          />
        ))}
      </svg>
      {count > MAX_BOXES && <span className="dc-open-tally-rest">+{count - MAX_BOXES}</span>}
      <span className="dc-sr-only">{count === 1 ? '1 open action' : `${count} open actions`}</span>
    </span>
  );
});
