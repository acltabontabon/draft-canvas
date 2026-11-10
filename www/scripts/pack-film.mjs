#!/usr/bin/env node
/*
 * Packs the story film's rendered frames into the two files the page scrubs.
 *
 * A video can only be scrubbed by seeking, and seeking is never quite smooth, least of all
 * backwards. So the film ships as its frames: each one a WebP, all of them in one file with an
 * index in front, which the page draws to a canvas (src/storyFilm.js). Any frame is then as near
 * as any other, in either direction.
 *
 *     blender -b -P www/scripts/story-film.py -- /tmp/story-film-frames
 *     node www/scripts/pack-film.mjs /tmp/story-film-frames
 *
 * Needs `cwebp` (brew install webp). The output is committed, so the site builds without it.
 *
 * File layout, little-endian: 'DCFM', frame count, frames per second, width, height, then
 * count + 1 byte offsets from the start of the file, then the frames end to end.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'clips');
const sources = readdirSync(frames).filter((name) => name.endsWith('.png')).sort();
const FPS = 24;
const SIZES = [
  { name: 'story-film.bin', width: 1600, height: 900, quality: 46 },
  { name: 'story-film-small.bin', width: 960, height: 540, quality: 50 },
];

for (const size of SIZES) {
  const work = mkdtempSync(join(tmpdir(), 'pack-film-'));
  let next = 0;
  // A few encoders at a time: cwebp is single-threaded and there are hundreds of frames.
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < sources.length) {
      const name = sources[next++];
      await run('cwebp', ['-quiet', '-q', String(size.quality), '-m', '5', '-resize', String(size.width), String(size.height), join(frames, name), '-o', join(work, name.replace('.png', '.webp'))]);
    }
  }));
  const blobs = sources.map((name) => readFileSync(join(work, name.replace('.png', '.webp'))));
  rmSync(work, { recursive: true });
  const header = Buffer.alloc(20 + 4 * (blobs.length + 1));
  header.write('DCFM', 0, 'latin1');
  [blobs.length, FPS, size.width, size.height].forEach((value, index) => header.writeUInt32LE(value, 4 + 4 * index));
  let offset = header.length;
  blobs.forEach((blob, index) => { header.writeUInt32LE(offset, 20 + 4 * index); offset += blob.length; });
  header.writeUInt32LE(offset, 20 + 4 * blobs.length);
  writeFileSync(join(out, size.name), Buffer.concat([header, ...blobs]));
  console.log(`pack-film: ${size.name} ${blobs.length} frames, ${(offset / 1048576).toFixed(1)} MB`);
}
