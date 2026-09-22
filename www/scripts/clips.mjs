#!/usr/bin/env node
/*
 * Cuts the site's short demo clips out of the full demo reel.
 *
 * docs/media/demo.mp4 is 148 seconds — the right length for a README, far too long for a landing
 * page to open with. These are its chapters, trimmed to the beat each one is actually about, at a
 * size and bitrate a page can afford. Nothing is re-staged or re-recorded: this is the same footage
 * of the same real UI, cut shorter. The chapter names and boundaries come from demo/scenes.ts.
 *
 * The output is committed, so the site builds and deploys without ffmpeg. Run this only when the
 * reel is re-cut:
 *
 *     npm --prefix www run clips
 *
 * A re-cut reel moves every timestamp below. Check them against the new cut before trusting it —
 * `ffmpeg -i docs/media/demo.mp4 -vf fps=1/2,scale=228:-1,tile=8x10 -frames:v 1 sheet.png` prints a
 * contact sheet at two seconds a tile, which is how these were found in the first place.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const reel = join(www, '..', 'docs', 'media', 'demo.mp4');
const out = join(www, 'public', 'clips');

/** `poster` is the offset into the clip to freeze for its poster frame, not into the reel. */
const CLIPS = [
  { name: 'draw', start: 10.5, duration: 13, poster: 9.5 },
  { name: 'compose', start: 36.4, duration: 8, poster: 6.8 },
  { name: 'present', start: 63.5, duration: 14, poster: 6 },
  { name: 'inside', start: 96.3, duration: 14, poster: 11 },
];

if (!existsSync(reel)) {
  console.error(`clips: ${reel} is missing.`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });

const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const kb = (path) => `${Math.round(statSync(path).size / 1024)} KB`;

for (const clip of CLIPS) {
  const mp4 = join(out, `${clip.name}.mp4`);
  const jpg = join(out, `${clip.name}.jpg`);

  // `-ss` before `-i` seeks on keyframes, which is fast but lands wherever the nearest one is;
  // after `-i` it decodes to the exact frame. The cuts here are chosen to the tenth of a second
  // around chapter slates, so exactness wins over speed.
  ffmpeg([
    '-i', reel,
    '-ss', String(clip.start),
    '-t', String(clip.duration),
    '-an',
    '-vf', 'scale=1280:-2',
    '-c:v', 'libx264', '-profile:v', 'high', '-crf', '27', '-preset', 'slow',
    // A keyframe a second, so scrubbing and the poster hand-off do not stall.
    '-g', '60', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4,
  ]);

  // The poster is taken from the clip, not the reel, so it can never drift out of the cut.
  ffmpeg(['-ss', String(clip.poster), '-i', mp4, '-frames:v', '1', '-q:v', '4', jpg]);

  console.log(`clips: ${clip.name}.mp4 ${kb(mp4)} · ${clip.name}.jpg ${kb(jpg)}`);
}
