#!/usr/bin/env node
/*
 * Packs the story film's rendered frames into the picture strips the page scrubs.
 *
 * A video can only be scrubbed by seeking, and seeking is never quite smooth, least of all
 * backwards. So the film ships as its frames, drawn to a canvas (src/storyFilm.js): any frame is
 * then as near as any other, in either direction.
 *
 * The frames travel as ordinary images, a few stacked in each, because the page makes no network
 * request of its own (its policy is `connect-src 'none'`): images are the browser's to load.
 *
 *     blender -b -P www/scripts/story-film.py -- /tmp/story-film-frames
 *     node www/scripts/pack-film.mjs /tmp/story-film-frames
 *
 * Needs `ffmpeg` and `cwebp` (brew install ffmpeg webp). The output is committed, so the site
 * builds without them. src/filmManifest.json tells the page what was written.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const frames = process.argv[2];
if (!frames) {
  console.error('pack-film: pass the folder of rendered frames.');
  process.exit(1);
}
const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const count = readdirSync(frames).filter((name) => /^\d{4}\.png$/.test(name)).length;
const FPS = 24;
// Frames to a strip: few enough that a decoded strip is a modest picture, many enough to keep the number of files down.
const PER = 6;
const SIZES = [
  { name: 'large', width: 1600, height: 900, quality: 46 },
  { name: 'small', width: 960, height: 540, quality: 50 },
];
const strips = Math.ceil(count / PER);
const work = mkdtempSync(join(tmpdir(), 'pack-film-'));

for (const size of SIZES) {
  const out = join(www, 'public', 'clips', 'film', size.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  let next = 0;
  let bytes = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < strips) {
      const strip = next++;
      const stacked = join(work, `${size.name}-${strip}.png`);
      // The last strip is short; ffmpeg leaves the rest of it black.
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-start_number', String(strip * PER), '-i', join(frames, '%04d.png'),
        '-frames:v', '1', '-vf', `scale=${size.width}:${size.height},tile=1x${PER}`, stacked]);
      const file = join(out, `${String(strip).padStart(3, '0')}.webp`);
      await run('cwebp', ['-quiet', '-q', String(size.quality), '-m', '5', stacked, '-o', file]);
      rmSync(stacked);
      bytes += statSync(file).size;
    }
  }));
  console.log(`pack-film: ${size.name} ${strips} strips, ${(bytes / 1048576).toFixed(1)} MB`);
}
rmSync(work, { recursive: true });
writeFileSync(join(www, 'src', 'filmManifest.json'), `${JSON.stringify({
  frames: count, fps: FPS, perStrip: PER, strips, sizes: Object.fromEntries(SIZES.map(({ name, width, height }) => [name, { width, height }])),
}, null, 2)}\n`);
