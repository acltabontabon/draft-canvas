import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/document/limits';
import { crc32, unzipFiles, zipFiles } from '../src/export/zip';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function le32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}
function le16(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);
}

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('crc32', () => {
  it('matches the published check value and the empty input', () => {
    // "123456789" → 0xCBF43926 is the IEEE CRC-32 check value every implementation is tested against.
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('can be continued from a seed, so a stream hashes like the whole', () => {
    const whole = encoder.encode('The quick brown fox');
    const first = crc32(whole.subarray(0, 7));
    expect(crc32(whole.subarray(7), first)).toBe(crc32(whole));
  });
});

describe('zipFiles / unzipFiles', () => {
  const entries = [
    { name: 'checkout.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    { name: 'checkout--orders-api.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]) },
    { name: 'empty.txt', data: new Uint8Array(0) },
    { name: 'café--設計.svg', data: 'ünïcödé' },
  ];

  it('round-trips every entry byte for byte, in order, with the name intact', () => {
    const archive = zipFiles(entries);
    const back = unzipFiles(archive);
    expect(back.map((entry) => entry.name)).toEqual(entries.map((entry) => entry.name));
    back.forEach((entry, index) => {
      const expected = entries[index]!.data;
      // `Array.from`: jsdom and Node each have a `Uint8Array` of their own, and `toEqual` refuses to
      // call two of them equal even when every byte is.
      expect(Array.from(entry.data)).toEqual(Array.from(typeof expected === 'string' ? encoder.encode(expected) : expected));
    });
    expect(decoder.decode(back[3]!.data)).toBe('ünïcödé');
    expect(back[2]!.data).toHaveLength(0);
  });

  it('preserves numeric, prototype-like and duplicate names without object-key interpretation', () => {
    const names = ['2', '1', '__proto__', 'constructor', 'same', 'same'];
    const back = unzipFiles(zipFiles(names.map((name, i) => ({ name, data: String(i) }))));
    expect(back.map((entry) => entry.name)).toEqual(names);
    expect(back.map((entry) => decoder.decode(entry.data))).toEqual(names.map((_, i) => String(i)));
  });

  it('is reproducible — the same entries give the same bytes, and unzip(zip(x)) is x', () => {
    const once = zipFiles(entries);
    const twice = zipFiles(entries);
    expect(Array.from(twice)).toEqual(Array.from(once));
    // The archive is itself an entry, so an archive of an archive comes back identical.
    const nested = unzipFiles(zipFiles([{ name: 'inner.zip', data: once }]));
    expect(Array.from(nested[0]!.data)).toEqual(Array.from(once));
  });

  it('lays the file out to the spec: local headers, a central directory, one end record', () => {
    const archive = zipFiles([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: '' }]);

    // Local header for "a.txt" at the very start.
    expect(le32(archive, 0)).toBe(0x04034b50);
    expect(le16(archive, 6) & 0x0800).toBe(0); // ASCII needs no encoding flag
    expect(le16(archive, 8)).toBe(0); // stored
    expect(le16(archive, 10)).toBe(0); // 00:00
    expect(le16(archive, 12)).toBe(0x0021); // 1980-01-01
    expect(le16(archive, 6) & 0x0008).toBe(0x0008); // CRC and size follow the data
    expect(le32(archive, 14)).toBe(0);
    expect(le32(archive, 18)).toBe(0);
    expect(le32(archive, 22)).toBe(0);
    expect(le16(archive, 26)).toBe(5);
    expect(decoder.decode(archive.subarray(30, 35))).toBe('a.txt');
    expect(decoder.decode(archive.subarray(35, 40))).toBe('hello');

    // The descriptor records the CRC and size, followed by the next local header.
    expect(le32(archive, 40)).toBe(0x08074b50);
    expect(le32(archive, 44)).toBe(crc32(encoder.encode('hello')));
    expect(le32(archive, 48)).toBe(5);
    expect(le32(archive, 52)).toBe(5);
    const second = 56;
    expect(le32(archive, second)).toBe(0x04034b50);
    expect(le32(archive, second + 18)).toBe(0);

    // The end record closes the file and points at a central directory of two entries.
    const end = archive.length - 22;
    expect(le32(archive, end)).toBe(0x06054b50);
    expect(le16(archive, end + 8)).toBe(2);
    expect(le16(archive, end + 10)).toBe(2);
    const centralStart = le32(archive, end + 16);
    const centralSize = le32(archive, end + 12);
    expect(centralStart + centralSize).toBe(end);
    expect(le32(archive, centralStart)).toBe(0x02014b50);
    expect(le32(archive, centralStart + 42)).toBe(0); // "a.txt" local header offset
    const secondCentral = centralStart + 46 + 5;
    expect(le32(archive, secondCentral)).toBe(0x02014b50);
    expect(le32(archive, secondCentral + 42)).toBe(second);
  });

  it.skipIf(!hasUnzip)('opens with the system unzip tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-zip-'));
    try {
      const file = join(dir, 'levels.zip');
      writeFileSync(file, zipFiles(entries));
      // `-t` tests every entry's CRC; a non-zero exit is a thrown error.
      const report = execFileSync('unzip', ['-t', file], { encoding: 'utf-8' });
      expect(report).toContain('No errors detected');
      // Only the ASCII names: Info-ZIP prints a UTF-8 name however the locale it runs under
      // allows, and `-t` above already checked that entry by content.
      const listing = execFileSync('unzip', ['-Z1', file], { encoding: 'utf-8' });
      expect(listing.trim().split('\n').slice(0, 3)).toEqual(entries.slice(0, 3).map((entry) => entry.name));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a compressed entry with a clear error', () => {
    const archive = zipFiles([{ name: 'a.txt', data: 'hello' }]);
    const end = archive.length - 22;
    const centralStart = le32(archive, end + 16);
    const view = new DataView(archive.buffer);
    view.setUint16(centralStart + 10, 8, true); // Deflate
    expect(() => unzipFiles(archive)).toThrow(/compressed \(method 8\)/);
  });

  it('refuses an archive whose declared sizes exceed the document limit before reading it', () => {
    const archive = zipFiles([{ name: 'a.txt', data: 'hello' }]);
    const end = archive.length - 22;
    const centralStart = le32(archive, end + 16);
    const view = new DataView(archive.buffer);
    const absurd = LIMITS.maxFileBytes + 1;
    view.setUint32(centralStart + 20, absurd, true);
    view.setUint32(centralStart + 24, absurd, true);
    expect(() => unzipFiles(archive)).toThrow(/larger than 24 MB/);
  });

  it('reads back an archive whose entries together pass the single-document limit', () => {
    // A library backup is many documents: each is bounded, the sum is not. A fixed total once made a
    // backup that had saved without complaint impossible to restore.
    const chunk = 'x'.repeat(Math.floor(LIMITS.maxFileBytes / 2.5));
    const archive = zipFiles([1, 2, 3].map((n) => ({ name: `d${n}.txt`, data: chunk })));
    const entries = unzipFiles(archive);
    expect(entries.map((entry) => entry.name)).toEqual(['d1.txt', 'd2.txt', 'd3.txt']);
    expect(entries.every((entry) => entry.data.length === chunk.length)).toBe(true);
  });

  it('refuses bytes that are not an archive, and a corrupted entry', () => {
    expect(() => unzipFiles(encoder.encode('not a zip at all, really not'))).toThrow(/Not a ZIP archive/);
    const archive = zipFiles([{ name: 'a.txt', data: 'hello' }]);
    archive[31] = 0x7a; // "a.txt" → "aztxt" in the local header only; the data itself moved
    archive[35] = 0x4a; // 'h' → 'J'
    expect(() => unzipFiles(archive)).toThrow(/checksum/);
  });

  it('accepts a trailing archive comment', () => {
    const archive = zipFiles([{ name: 'a.txt', data: 'hello' }]);
    const comment = encoder.encode('made by a test');
    const withComment = new Uint8Array(archive.length + comment.length);
    withComment.set(archive);
    withComment.set(comment, archive.length);
    new DataView(withComment.buffer).setUint16(archive.length - 2, comment.length, true);
    expect(unzipFiles(withComment)[0]!.name).toBe('a.txt');
  });
});
