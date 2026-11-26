import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { PackRejected, scanPack, type PackLimits } from '../../src/evolution/packScan';
import { HAS_GIT, gitOk, scratch } from './realGit';

const LIMITS: PackLimits = { maxObjects: 1000, maxObjectBytes: 1024 * 1024, maxTotalInflated: 8 * 1024 * 1024, maxDeltaDepth: 50 };

/** A pack of whole objects: `[type, declared size, inflated content]`. The trailer is not checked by the scan. */
function pack(objects: [number, number, Uint8Array][], extra = new Uint8Array()): Uint8Array {
  const parts: number[] = [0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, objects.length];
  for (const [type, size, content] of objects) {
    let rest = size >>> 4;
    parts.push(((rest > 0 ? 0x80 : 0) | (type << 4) | (size & 0x0f)) & 0xff);
    while (rest > 0) {
      const byte = rest & 0x7f;
      rest >>>= 7;
      parts.push(rest > 0 ? byte | 0x80 : byte);
    }
    parts.push(...zlibSync(content));
  }
  parts.push(...extra, ...new Array(20).fill(0));
  return Uint8Array.from(parts);
}

const text = (s: string) => new TextEncoder().encode(s);

describe('the pack pre-scan', { timeout: 60_000 }, () => {
  it('accepts well-formed whole objects', () => {
    const summary = scanPack(pack([[3, 5, text('hello')], [3, 0, text('')], [3, 11, text('hello world')]]), LIMITS);
    expect(summary).toMatchObject({ objects: 3, inflated: 16, deltas: 0 });
  });

  it('refuses an object that inflates past what it declares (a decompression bomb)', () => {
    const bomb = new Uint8Array(512 * 1024);
    expect(() => scanPack(pack([[3, 10, bomb]]), LIMITS)).toThrow(PackRejected);
  });

  it('refuses an object declared larger than any diagram', () => {
    expect(() => scanPack(pack([[3, 2 * 1024 * 1024, new Uint8Array(2 * 1024 * 1024)]]), LIMITS)).toThrow(/larger than/);
  });

  it('refuses more objects than allowed, a short pack, and trailing data', () => {
    expect(() => scanPack(pack([[3, 1, text('a')]]), { ...LIMITS, maxObjects: 0 })).toThrow(/at most 0/);
    const whole = pack([[3, 5, text('hello')]]);
    const claimsTwo = whole.slice();
    claimsTwo[11] = 2;
    expect(() => scanPack(claimsTwo, LIMITS)).toThrow(PackRejected);
    expect(() => scanPack(pack([[3, 5, text('hello')]], Uint8Array.from([1, 2, 3])), LIMITS)).toThrow(/after its last object/);
  });

  it('refuses something that is not a pack', () => {
    expect(() => scanPack(new Uint8Array(64), LIMITS)).toThrow(/Not a Git pack/);
  });

  it('refuses a delta that points before the pack', () => {
    const bad = pack([[3, 5, text('hello')]]);
    // Rewrite the object as an offset delta whose base would sit before the pack's header.
    const out = Uint8Array.from([...bad.subarray(0, 12), 0x65, 0x7f, ...bad.subarray(13)]);
    expect(() => scanPack(out, LIMITS)).toThrow(PackRejected);
  });

  it.skipIf(!HAS_GIT)('accepts packs Git writes, with deltas', () => {
    const { dir, done } = scratch();
    try {
      gitOk(dir, ['init', '-q', 'w']);
      const work = join(dir, 'w');
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(join(work, 'diagram.draftcanvas'), `${'line of a diagram\n'.repeat(200)}${i}\n`);
        gitOk(work, ['add', '.']);
        gitOk(work, ['commit', '-q', '-m', `r${i}`]);
      }
      gitOk(work, ['gc', '-q', '--aggressive']);
      const packDir = join(work, '.git', 'objects', 'pack');
      const file = readdirSync(packDir).find((name) => name.endsWith('.pack'))!;
      const summary = scanPack(new Uint8Array(readFileSync(join(packDir, file))), LIMITS);
      expect(summary.objects).toBe(18);
      expect(summary.deltas).toBeGreaterThan(0);
    } finally {
      done();
    }
  });
});
