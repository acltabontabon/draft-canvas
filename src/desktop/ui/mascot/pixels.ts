/**
 * Nodi (NOH-dee), the companion's mascot, as pixels: a sheet of paper with its corner folded (the Quick Draft card's
 * own fold) for a head, a screen for a face, and a connector on its chest. Data only, drawn by
 * `Mascot.tsx`.
 */

export type Mood = 'idle' | 'working' | 'waiting' | 'happy' | 'asleep' | 'walking';

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
};

export const SHADOW = 'rgba(0, 0, 0, 0.32)';

type Face = 'idle' | 'blink' | 'look' | 'happy' | 'asleep' | 'dots1' | 'dots2' | 'dots3';

/** Lit screen pixels for each face, as [x, y]. */
const FACES: Record<Face, [number, number][]> = {
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

/** What one frame shows: the face and how high the mascot is, from its mood and the frame count. */
export function pose(mood: Mood, tick: number): { face: Face; lift: number; stride?: number } {
  switch (mood) {
    case 'walking':
      // A step every other frame, bobbing up on each one, eyes on where it is going.
      return { face: 'look', lift: tick % 2, stride: tick % 2 };
    case 'working':
      return { face: (['dots1', 'dots2', 'dots3'] as const)[Math.floor(tick / 2) % 3]!, lift: Math.floor(tick / 2) % 2 };
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
  const { face, lift, stride } = pose(mood, tick);
  const grid = ROWS.map((row) => row.split(''));
  for (const [x, y] of FACES[face]) grid[y]![x] = 'g';
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
      runs.push({ x, y: y + top, width: n, fill: PALETTE[c]! });
      x += n;
    }
  });
  // The shadow stays on the ground, smaller while the mascot is up.
  runs.push(lift ? { x: 8, y: HEIGHT - 1, width: 8, fill: SHADOW } : { x: 6, y: HEIGHT - 1, width: 12, fill: SHADOW });
  return runs;
}
