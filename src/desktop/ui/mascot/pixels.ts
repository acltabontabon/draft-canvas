/**
 * Nodi (NOH-dee), the companion's mascot, as pixels: a sheet of paper with its corner folded (the Quick Draft card's
 * own fold) for a head, a screen for a face, and a connector on its chest. Data only, drawn by
 * `Mascot.tsx`.
 */

export type Mood = 'idle' | 'working' | 'waiting' | 'happy' | 'asleep' | 'walking' | 'angry' | 'dizzy' | 'love' | 'surprised' | 'sleepy';

/** How often the mascot moves: a few frames a second is all pixel motion needs. */
export const FRAME_MS = 150;

export const WIDTH = 24;
/** The figure's 25 rows, two rows above it to hop into, and one for its shadow. */
export const HEIGHT = 28;

/** The body, row by row. `.` is empty; the other letters are `PALETTE` keys. */
export const ROWS = [
  '...ooooooooooooooo......',
  '..ohhhhhhhhhhhhhhso.....',
  '.ohmmmmmmmmmmmmmmsfo....',
  '.ohmmmmmmmmmmmmmmsffo...',
  '.ohmmmmmmmmmmmmmmsfffo..',
  '.ohmmmmmmmmmmmmmmssssso.',
  '.ohmmoooooooooooooommso.',
  '.ohmoddddddddddddddomso.',
  '.ohmoddddddddddddddomso.',
  '.ohmoddddddddddddddomso.',
  '.ohmoddddddddddddddomso.',
  '.ohmoddddddddddddddomso.',
  '.ohmoddddddddddddddomso.',
  '.ohmmoooooooooooooommso.',
  '.ohmmmmmmmmmmmmmmmmmmso.',
  '..osssssssssssssssssso..',
  '...oooooooooooooooooo...',
  '......ommmmmmmmmmo......',
  '...oooohmoooooommoooo...',
  '...ohmohmogkkgommohmo...',
  '...ommohmoooooommommo...',
  '....ooossssssssssooo....',
  '.......oooooooooo.......',
  '........oso..oso........',
  '........ooo..ooo........',
] as const;

export const PALETTE: Record<string, string> = {
  o: '#0a2724',
  m: '#46cbb8',
  h: '#a6f2e5',
  s: '#2a9a8b',
  f: '#d4f7f1',
  d: '#0f1d1c',
  g: '#b9fff5',
  k: '#2c6f67',
  /** A screen gone red with rage, and one gone soft. */
  r: '#ff7a66',
  p: '#ff9ec7',
};

export const SHADOW = 'rgba(0, 0, 0, 0.32)';

type Face = 'idle' | 'blink' | 'look' | 'happy' | 'asleep' | 'dots1' | 'dots2' | 'dots3' | 'angry' | 'dizzy' | 'love' | 'surprised';

/** The screen's colour for a face, when it isn't the usual glow. */
const FACE_COLOUR: Partial<Record<Face, string>> = { angry: 'r', love: 'p' };

/** Lit screen pixels for each face, as [x, y]. */
const FACES: Record<Face, [number, number][]> = {
  // Brows down to the middle, eyes narrowed, mouth turned down.
  angry: [[6, 8], [7, 8], [8, 9], [7, 10], [8, 10], [17, 8], [16, 8], [15, 9], [15, 10], [16, 10], [10, 12], [11, 11], [12, 11], [13, 12]],
  // X for eyes, a wobbly mouth.
  dizzy: [[6, 8], [8, 8], [7, 9], [6, 10], [8, 10], [15, 8], [17, 8], [16, 9], [15, 10], [17, 10], [10, 12], [11, 11], [12, 12], [13, 11]],
  // A heart for each eye.
  love: [[6, 8], [8, 8], [6, 9], [7, 9], [8, 9], [7, 10], [15, 8], [17, 8], [15, 9], [16, 9], [17, 9], [16, 10], [10, 11], [11, 12], [12, 12], [13, 11]],
  // Eyes up and wide, mouth an O.
  surprised: [[7, 7], [8, 7], [7, 8], [8, 8], [15, 7], [16, 7], [15, 8], [16, 8], [11, 10], [12, 10], [10, 11], [13, 11], [11, 12], [12, 12]],
  idle: [[7, 8], [8, 8], [7, 9], [8, 9], [7, 10], [8, 10], [15, 8], [16, 8], [15, 9], [16, 9], [15, 10], [16, 10], [11, 11], [12, 11]],
  blink: [[7, 10], [8, 10], [15, 10], [16, 10], [11, 11], [12, 11]],
  look: [[6, 8], [7, 8], [6, 9], [7, 9], [6, 10], [7, 10], [14, 8], [15, 8], [14, 9], [15, 9], [14, 10], [15, 10], [10, 11], [11, 11]],
  happy: [[6, 9], [7, 8], [8, 8], [9, 9], [14, 9], [15, 8], [16, 8], [17, 9], [10, 11], [11, 12], [12, 12], [13, 11]],
  asleep: [[6, 10], [7, 10], [8, 10], [15, 10], [16, 10], [17, 10]],
  dots1: [[6, 8], [7, 8], [6, 9], [7, 9], [14, 8], [15, 8], [14, 9], [15, 9], [10, 11]],
  dots2: [[6, 8], [7, 8], [6, 9], [7, 9], [14, 8], [15, 8], [14, 9], [15, 9], [10, 11], [12, 11]],
  dots3: [[6, 8], [7, 8], [6, 9], [7, 9], [14, 8], [15, 8], [14, 9], [15, 9], [10, 11], [12, 11], [14, 11]],
};

/** The feet (the last two rows) mid-stride: one foot down and forward, the other lifted. Walking in
 *  from the right, so "forward" is to the left. */
const STRIDES: [string, string][] = [
  ['.......oso...ooo........', '.......ooo..............'],
  ['........ooo..oso........', '..............ooo.......'],
];

/** One horizontal run of same-coloured pixels: what `Mascot.tsx` draws as a rect. */
export interface Run {
  x: number;
  y: number;
  width: number;
  fill: string;
}

/** A lit screen pixel with its colour (a `PALETTE` key). */
type Lit = [number, number, string];

/** What Nodi watches on its own screen while the agent thinks, a few seconds of each in turn. */
export const CHANNELS = ['typing', 'feed', 'show', 'likes', 'swipe', 'dating', 'pong', 'reading', 'music', 'coffee'] as const;
export type Channel = (typeof CHANNELS)[number];
/** Frames per channel: about four and a half seconds at `Mascot.tsx`'s pace. */
export const CHANNEL_TICKS = 30;

/** The screen is x 5–18, y 7–12. */
const SCREEN = { left: 5, right: 18, top: 7, bottom: 12 };

/** One frame of a channel, as lit screen pixels. */
export function channelFrame(channel: Channel, t: number): Lit[] {
  const lit: Lit[] = [];
  const bar = (y: number, from: number, length: number, colour = 'g') => {
    for (let x = from; x < Math.min(from + length, SCREEN.right + 1); x += 1) lit.push([x, y, colour]);
  };
  switch (channel) {
    case 'typing': {
      // Lines of code, typed out one character at a time, then a fresh page.
      const lines = [9, 6, 11, 4];
      // Started part-way, so the frame held still under reduced motion isn't a blank screen.
      // Never zero: a fresh page starts with its first character already typed.
      let budget = 1 + ((t + 18) % 33);
      lines.forEach((length, row) => {
        const typed = Math.min(length, Math.max(0, budget));
        budget -= length;
        bar(8 + row, 6 + (row % 2) * 2, typed, row === 0 ? 'p' : 'g');
      });
      break;
    }
    case 'feed': {
      // Posts going by, each with its upvote arrow: a headline, a line of text, a gap. Endless.
      const post = [
        (y: number) => {
          lit.push([6, y, 'r']);
          bar(y, 8, 10);
        },
        (y: number) => bar(y, 8, 6, 'k'),
        () => {},
      ];
      for (let y = SCREEN.top; y <= SCREEN.bottom; y += 1) post[(y + Math.floor(t / 2)) % post.length]!(y);
      break;
    }
    case 'show': {
      // An episode: a ball bouncing along the ground, and the progress bar creeping along the top.
      bar(SCREEN.top, SCREEN.left + 1, 1 + (Math.floor(t / 3) % 12), 'r');
      bar(SCREEN.bottom, SCREEN.left + 1, 12, 'k');
      const x = 6 + (t % 12);
      const y = [11, 10, 9, 9, 10, 11][t % 6]!;
      lit.push([x, y, 'g'], [x + 1, y, 'g']);
      break;
    }
    case 'likes': {
      // Hearts floating up off the screen: liking every post about microservices.
      for (const [start, x] of [[0, 7], [4, 12], [8, 16]] as const) {
        const y = SCREEN.bottom - ((t + start) % 6);
        if (y - 1 < SCREEN.top) continue;
        lit.push([x - 1, y - 1, 'p'], [x + 1, y - 1, 'p'], [x - 1, y, 'p'], [x, y, 'p'], [x + 1, y, 'p'], [x, y + 1 > SCREEN.bottom ? y : y + 1, 'p']);
      }
      break;
    }
    case 'swipe': {
      // Short vertical videos, one after another, swiped up: someone dancing, then the next one.
      const shift = t % 8 < 6 ? 0 : (t % 8) - 5;
      const arms = Math.floor(t / 2) % 2;
      for (let y = SCREEN.top; y <= SCREEN.bottom; y += 1) {
        const at = y + shift;
        if (at > SCREEN.bottom) continue;
        lit.push([9, at, 'k'], [14, at, 'k']);
      }
      const dancer: [number, number][] = [[11, 8], [12, 8], [11, 9], [12, 9], [11, 10], [12, 10], [11, 11], [12, 11], arms ? [10, 8] : [10, 10], arms ? [13, 10] : [13, 8]];
      for (const [x, y] of dancer) if (y + shift <= SCREEN.bottom) lit.push([x, y + shift, Math.floor(t / 8) % 2 ? 'p' : 'g']);
      break;
    }
    case 'dating': {
      // A profile card, swiped: right with a heart, left with a cross, then the next card comes up.
      const beat = t % 10;
      const right = Math.floor(t / 10) % 2 === 0;
      const slide = beat < 6 ? 0 : (beat - 5) * 2 * (right ? 1 : -1);
      for (let y = 8; y <= 12; y += 1) for (let x = 10; x <= 13; x += 1) {
        const edge = y === 8 || y === 12 || x === 10 || x === 13;
        lit.push([x + slide, y, edge ? 'g' : y === 10 && (x === 11 || x === 12) ? 'p' : 'k']);
      }
      if (beat >= 3) {
        if (right) lit.push([16, 9, 'p'], [18, 9, 'p'], [16, 10, 'p'], [17, 10, 'p'], [18, 10, 'p'], [17, 11, 'p']);
        else lit.push([5, 9, 'r'], [7, 9, 'r'], [6, 10, 'r'], [5, 11, 'r'], [7, 11, 'r']);
      }
      break;
    }
    case 'pong': {
      // A quick game against itself: two paddles, and the ball going back and forth between them.
      const run = t % 20;
      const x = run < 10 ? 7 + run : 26 - run;
      const y = 8 + [0, 1, 2, 3, 2, 1][t % 6]!;
      // The paddle on the ball's side goes to meet it; the other waits in the middle.
      const meet = Math.min(Math.max(y - 1, SCREEN.top), SCREEN.bottom - 2);
      const left = x < 12 ? meet : 9;
      const right = x >= 12 ? meet : 9;
      for (let dy = 0; dy < 3; dy += 1) lit.push([6, left + dy, 'g'], [17, right + dy, 'g']);
      lit.push([x, y, 'p']);
      break;
    }
    case 'music': {
      // Lo-fi beats to architect to: an equaliser, each bar on its own rhythm.
      for (let i = 0; i < 6; i += 1) {
        const height = 1 + ((t * (i + 2) + i * 3) % 5);
        for (let dy = 0; dy < height; dy += 1) lit.push([6 + i * 2, SCREEN.bottom - dy, dy >= 3 ? 'p' : 'g']);
      }
      break;
    }
    case 'coffee': {
      // A mug, steaming. Nothing gets designed before this.
      for (let x = 9; x <= 13; x += 1) lit.push([x, 12, 'g']);
      for (let y = 10; y <= 11; y += 1) lit.push([9, y, 'g'], [13, y, 'g']);
      lit.push([14, 10, 'g'], [15, 11, 'g'], [14, 11, 'g']);
      for (const [x, phase] of [[10, 0], [12, 2]] as const) {
        const rise = (t + phase) % 4;
        lit.push([x + (rise % 2), 9 - Math.min(rise, 2), 'k']);
      }
      break;
    }
    case 'reading': {
      // Eyes going along the lines and back, the way anyone reads the comments.
      const sweep = [0, 1, 2, 3, 4, 3, 2, 1][t % 8]!;
      for (const eye of [6, 14]) lit.push([eye + sweep - 1, 9, 'g'], [eye + sweep, 9, 'g'], [eye + sweep - 1, 10, 'g'], [eye + sweep, 10, 'g']);
      bar(12, 10, 3, 'k');
      break;
    }
  }
  return lit.filter(([x, y]) => x >= SCREEN.left && x <= SCREEN.right && y >= SCREEN.top && y <= SCREEN.bottom);
}

/** Which channel is on at frame `tick` of the channel clock. */
export function channelAt(tick: number): Channel {
  return CHANNELS[Math.floor(tick / CHANNEL_TICKS) % CHANNELS.length]!;
}

/**
 * The one clock the channels run on, read off the wall clock: the mascot's screen (`Mascot.tsx`) and
 * the caption that jokes about it (`Companion.tsx`'s `Working`) each read it, so they change channel
 * together. Each kept its own count before, started at different moments, and drifted apart:
 * "scrolling Reddit" under an episode playing.
 */
export function channelClock(ms: number = Date.now()): { tick: number; index: number } {
  const tick = Math.floor(ms / FRAME_MS);
  return { tick, index: Math.floor(tick / CHANNEL_TICKS) };
}

/** How long one channel is on, in milliseconds. */
export const CHANNEL_MS = CHANNEL_TICKS * FRAME_MS;

/** A Z floating up beside the head, two pixels a step: [x, y] from the frame's top-left. */
const ZED: [number, number][] = [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]];

/** What one frame shows: the face, how high the mascot is and how far it shakes sideways, and a Z
 *  above it when it dozes, from its mood and the frame count. */
export function pose(mood: Mood, tick: number): { face: Face; lift: number; stride?: number; shake?: number; zed?: { x: number; y: number }; screen?: Lit[] } {
  switch (mood) {
    case 'angry':
      // Shaking with it, a pixel each way.
      return { face: 'angry', lift: 0, shake: tick % 2 === 0 ? 1 : -1 };
    case 'dizzy':
      return { face: 'dizzy', lift: 0, shake: [0, 1, 0, -1][Math.floor(tick / 2) % 4]! };
    case 'love':
      return { face: 'love', lift: Math.floor(tick / 3) % 2 };
    case 'surprised':
      return { face: tick % 24 === 23 ? 'blink' : 'surprised', lift: tick % 24 < 2 ? 1 : 0 };
    case 'sleepy': {
      // Eyes shut, a slow breath, and a Z that drifts up and starts again.
      const step = Math.floor(tick / 3) % 4;
      return { face: 'asleep', lift: Math.floor(tick / 8) % 2, zed: { x: 19 + (step % 2), y: 3 - step } };
    }
    case 'walking':
      // A step every other frame, bobbing up on each one, eyes on where it is going.
      return { face: 'look', lift: tick % 2, stride: tick % 2 };
    case 'working':
      // "Thinking": its screen on whatever it watches while it waits, a channel at a time.
      return { face: 'dots1', lift: Math.floor(tick / 4) % 2, screen: channelFrame(channelAt(tick), tick % CHANNEL_TICKS) };
    case 'waiting':
      return { face: tick % 30 === 29 ? 'blink' : 'look', lift: Math.floor(tick / 4) % 2 };
    case 'happy':
      return { face: 'happy', lift: [0, 2, 1, 0][Math.floor(tick / 2) % 4]! };
    case 'asleep':
      return { face: 'asleep', lift: 0 };
    case 'idle':
      return { face: tick % 28 === 27 ? 'blink' : 'idle', lift: Math.floor(tick / 4) % 2 };
  }
}

/** The frame as runs, ready to draw. */
export function frame(mood: Mood, tick: number): Run[] {
  const { face, lift, stride, shake = 0, zed, screen } = pose(mood, tick);
  const grid = ROWS.map((row) => row.split(''));
  const lit = FACE_COLOUR[face] ?? 'g';
  if (screen) for (const [x, y, colour] of screen) grid[y]![x] = colour;
  else for (const [x, y] of FACES[face]) grid[y]![x] = lit;
  if (stride !== undefined) {
    const [upper, lower] = STRIDES[stride]!;
    grid[ROWS.length - 2] = upper.split('');
    grid[ROWS.length - 1] = lower.split('');
  }
  const top = 2 - lift;
  const runs: Run[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x]!;
      if (c === '.') {
        x += 1;
        continue;
      }
      let n = 1;
      while (x + n < row.length && row[x + n] === c) n += 1;
      runs.push({ x: x + shake, y: y + top, width: n, fill: PALETTE[c]! });
      x += n;
    }
  });
  // Drifting up out of the frame: the rows above the top are simply not drawn.
  if (zed) for (const [dx, dy] of ZED) if (zed.y + dy - 3 >= 0) runs.push({ x: zed.x + dx, y: zed.y + dy - 3, width: 1, fill: PALETTE.g! });
  // The shadow stays on the ground, smaller while the mascot is up.
  runs.push(lift ? { x: 8, y: HEIGHT - 1, width: 8, fill: SHADOW } : { x: 6, y: HEIGHT - 1, width: 12, fill: SHADOW });
  return runs;
}
