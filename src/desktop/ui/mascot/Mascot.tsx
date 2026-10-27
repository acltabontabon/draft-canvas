import { memo, useEffect, useMemo, useState } from 'react';
import { channelClock, frame, FRAME_MS, HEIGHT, pose, WIDTH, type Mood } from './pixels';

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

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Whether two ticks draw the same picture: idle, three frames in four are the last one again. */
function samePose(mood: Mood, a: number, b: number): boolean {
  return JSON.stringify(pose(mood, a)) === JSON.stringify(pose(mood, b));
}

/**
 * Nodi, the companion's mascot (`pixels.ts`), `scale` screen pixels per mascot pixel. It blinks and bobs
 * while idle, types while working, looks over at the canvas while a proposal waits, and hops when
 * done; with reduced motion it holds still. It holds still while the window is hidden too (in the
 * tray, minimised): drawn on every frame for nobody, it kept the app busy all day.
 */
export const Mascot = memo(function Mascot({ mood, scale = 3, facing = 'left' }: { mood: Mood; scale?: number; facing?: 'left' | 'right' }) {
  // Working, it follows the channel clock its caption reads too; otherwise it just counts frames.
  const clocked = mood === 'working';
  const [tick, setTick] = useState(() => (clocked && !prefersStill() ? channelClock().tick : 0));
  const [away, setAway] = useState(hidden);
  useEffect(() => {
    const onVisibility = () => setAway(hidden());
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (prefersStill() || mood === 'asleep' || away) return;
    let at = clocked ? channelClock().tick : 0;
    setTick(at);
    const timer = window.setInterval(() => {
      const next = clocked ? channelClock().tick : at + 1;
      // A tick that draws what is already there is no new render: idle, three in four were.
      const same = samePose(mood, at, next);
      at = next;
      if (!same) setTick(next);
    }, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [mood, clocked, away]);
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
      style={facing === 'right' ? { transform: 'scaleX(-1)' } : undefined}
    >
      {runs.map((run, i) => (
        <rect key={i} x={run.x} y={run.y} width={run.width} height={1} fill={run.fill} />
      ))}
    </svg>
  );
});
