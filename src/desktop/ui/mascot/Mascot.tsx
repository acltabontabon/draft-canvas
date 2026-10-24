import { useEffect, useMemo, useState } from 'react';
import { frame, HEIGHT, WIDTH, type Mood } from './pixels';

/** How often the mascot moves: a few frames a second is all pixel motion needs. */
const FRAME_MS = 150;

const LABEL: Record<Mood, string> = {
  idle: 'Nodi, ready',
  working: 'Nodi, working',
  waiting: 'Nodi, waiting for you',
  happy: 'Nodi, done',
  asleep: 'Nodi, not set up',
  walking: 'Nodi, on the way',
  angry: 'Nodi, fuming',
  dizzy: 'Nodi, dizzy after an error',
  love: 'Nodi, delighted',
  surprised: 'Nodi, with news',
  sleepy: 'Nodi, dozing',
};

function prefersStill(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Nodi, the companion's mascot (`pixels.ts`), `scale` screen pixels per mascot pixel. It blinks and bobs
 * while idle, types while working, looks over at the canvas while a proposal waits, and hops when
 * done; with reduced motion it holds still.
 */
export function Mascot({ mood, scale = 3 }: { mood: Mood; scale?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (prefersStill() || mood === 'asleep') return;
    const timer = window.setInterval(() => setTick((t) => t + 1), FRAME_MS);
    return () => window.clearInterval(timer);
  }, [mood]);
  const runs = useMemo(() => frame(mood, tick), [mood, tick]);
  return (
    <svg
      className="dc-mascot"
      role="img"
      aria-label={LABEL[mood]}
      width={WIDTH * scale}
      height={HEIGHT * scale}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      shapeRendering="crispEdges"
      data-mood={mood}
    >
      {runs.map((run, i) => (
        <rect key={i} x={run.x} y={run.y} width={run.width} height={1} fill={run.fill} />
      ))}
    </svg>
  );
}
