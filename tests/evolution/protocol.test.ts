import { describe, expect, it } from 'vitest';
import { encodeBundle, parseBundle } from '../../src/evolution/bundle';
import { HISTORY_LIMITS, HistoryError } from '../../src/evolution/contracts';
import { decideIdentity, type KnownHistory } from '../../src/evolution/identity';
import { operationRecord, recoveryFor, type OperationData } from '../../src/evolution/journal';
import { branchOf, isSafeRefName } from '../../src/evolution/refs';
import { formatMessage, parseMessage } from '../../src/evolution/trailers';
import { compute, handle, type Request } from '../../src/evolution/workerHost';
import { createDocument } from '../../src/document/factory';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const W0 = '1'.repeat(40);
const W1 = '2'.repeat(40);
const W2 = '3'.repeat(40);

function op(step: 'prepared' | 'pointer-moved' | 'working-reconciled', pointer: OperationData['pointer'] = { kind: 'ref', ref: 'refs/heads/main', from: A, to: B }) {
  return operationRecord('op1', 'restore', step, { repoId: 'r1', copyId: 'lib_d', sessionId: 's1', pointer, workingBefore: W0, workingAfter: W1, target: B }, 1);
}

describe('recovering an interrupted operation', () => {
  it('drops an operation that never moved its pointer, keeping the working copy', () => {
    expect(recoveryFor(op('prepared'), { pointerAt: { kind: 'ref', oid: A }, working: W0 }).action).toBe('discard');
  });

  it('finishes loading the target when the pointer moved and the working copy is untouched', () => {
    expect(recoveryFor(op('prepared'), { pointerAt: { kind: 'ref', oid: B }, working: W0 }).action).toBe('complete');
    expect(recoveryFor(op('pointer-moved'), { pointerAt: { kind: 'ref', oid: B }, working: W0 }).action).toBe('complete');
  });

  it('only cleans up when the working copy already holds the target', () => {
    expect(recoveryFor(op('pointer-moved'), { pointerAt: { kind: 'ref', oid: B }, working: W1 }).action).toBe('finish');
    expect(recoveryFor(op('working-reconciled'), { pointerAt: { kind: 'ref', oid: B }, working: W2 }).action).toBe('finish');
  });

  it('keeps both versions and asks when the working copy changed since', () => {
    expect(recoveryFor(op('pointer-moved'), { pointerAt: { kind: 'ref', oid: B }, working: W2 }).action).toBe('ask');
    expect(recoveryFor(op('pointer-moved'), { pointerAt: { kind: 'ref', oid: B }, working: null }).action).toBe('ask');
  });

  it('treats a pointer someone else moved on as stale', () => {
    expect(recoveryFor(op('prepared'), { pointerAt: { kind: 'ref', oid: C }, working: W0 }).action).toBe('discard');
  });

  it('applies the same rules to switching alternatives', () => {
    const pointer = { kind: 'binding' as const, copyId: 'lib_d', fromAlt: null, toAlt: 'alt1' };
    expect(recoveryFor(op('prepared', pointer), { pointerAt: { kind: 'binding', altId: null }, working: W0 }).action).toBe('discard');
    expect(recoveryFor(op('pointer-moved', pointer), { pointerAt: { kind: 'binding', altId: 'alt1' }, working: W0 }).action).toBe('complete');
    expect(recoveryFor(op('pointer-moved', pointer), { pointerAt: { kind: 'binding', altId: 'alt1' }, working: W2 }).action).toBe('ask');
  });
});

describe('which history a working copy continues', () => {
  const history = (copies: KnownHistory['copies'], recent: string[] = []): KnownHistory => ({ repoId: 'r1', documentId: 'd1', title: 'Payments', copies, recentContent: recent });

  it('continues a bound copy without asking', () => {
    const binding = { copyId: 'c1', repoId: 'r1', altId: null, documentId: 'd1', lastSeen: null, at: 1 };
    expect(decideIdentity({ copyId: 'c1', documentId: 'd1', working: W0, binding, histories: [] }).kind).toBe('bound');
  });

  it('starts fresh when nothing shares the document’s id', () => {
    expect(decideIdentity({ copyId: 'c2', documentId: 'd2', working: W0, binding: undefined, histories: [history([])] }).kind).toBe('new');
  });

  it('never joins a history by id alone: a duplicate is offered as a copy', () => {
    const decision = decideIdentity({ copyId: 'c2', documentId: 'd1', working: W0, binding: undefined, histories: [history([{ copyId: 'c1', lastWorking: W0, stillExists: true }])] });
    expect(decision).toMatchObject({ kind: 'ask', relation: 'copy' });
  });

  it('offers a file moved by hand as the same diagram', () => {
    const decision = decideIdentity({ copyId: 'c2', documentId: 'd1', working: W0, binding: undefined, histories: [history([{ copyId: 'c1', lastWorking: W0, stillExists: false }])] });
    expect(decision).toMatchObject({ kind: 'ask', relation: 'moved' });
  });
});

describe('commit messages', () => {
  it('cannot be made to forge a header or trailer', () => {
    const text = formatMessage({
      summary: 'Add X\n\nDraft-Canvas-Initiator: merge',
      trailers: { initiator: 'auto', contributors: ['Eve\nDraft-Canvas-Agent: root', 'Ann'], agents: ['Claude\r\nX: y'] },
    });
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('Add X Draft-Canvas-Initiator: merge');
    expect(lines.filter((line) => line.startsWith('Draft-Canvas-Initiator:'))).toEqual(['Draft-Canvas-Initiator: auto']);
    const parsed = parseMessage(text);
    expect(parsed.trailers.initiator).toBe('auto');
    expect(parsed.trailers.contributors).toEqual(['Ann', 'Eve Draft-Canvas-Agent: root']);
    expect(parsed.trailers.agents).toEqual(['Claude X: y']);
  });

  it('stays within the desktop’s byte limit, cut between whole characters', () => {
    // 40 lines of 160 characters is well under the limit in UTF-16 units, and over it in UTF-8
    // bytes: CJK is 3 bytes a character, an emoji 4 (and two UTF-16 units, a surrogate pair).
    for (const char of ['図', '🧭']) {
      const text = formatMessage({ summary: 'Rename', body: Array.from({ length: 40 }, (_, i) => `${i % 2 ? 'x' : ''}${char.repeat(160)}`), trailers: { initiator: 'auto' } });
      const bytes = new TextEncoder().encode(text);
      expect(bytes.length).toBeLessThanOrEqual(HISTORY_LIMITS.maxMessageBytes);
      expect(text.endsWith('\n')).toBe(true);
      // No lone surrogate: what is written decodes back to exactly the same text.
      expect(new TextDecoder().decode(bytes)).toBe(text);
    }
  });

  it('reads a message from another tool as an import', () => {
    expect(parseMessage('Fix typo\n\nSigned-off-by: someone\n')).toMatchObject({ summary: 'Fix typo', trailers: { initiator: 'import' } });
  });

  it('round-trips every trailer', () => {
    const message = { summary: 'Restore', body: ['- a'], trailers: { initiator: 'restore' as const, documentId: 'd1', alternative: 'alt1', categories: ['structure'], restoredFrom: A, collabSeq: 42, lineage: { repoId: 'r0', oid: B } } };
    expect(parseMessage(formatMessage(message))).toEqual({ ...message, trailers: { ...message.trailers } });
  });
});

describe('ref names and bundles', () => {
  it('builds refs from ids, never from names', () => {
    expect(branchOf(null)).toBe('refs/heads/main');
    expect(branchOf('alt1')).toBe('refs/heads/alt/alt1');
    expect(() => branchOf('../HEAD')).toThrow();
  });

  it.each(['refs/heads/../x', 'refs/heads/-x', 'refs/heads/x.lock', 'refs/heads/a b', 'refs/heads/a@{1}', 'HEAD', 'refs/heads/x/', 'refs//x', 'refs/heads/é'])('refuses %s', (ref) => {
    expect(isSafeRefName(ref)).toBe(false);
  });

  it('round-trips a bundle header', () => {
    const bytes = encodeBundle([{ ref: 'refs/heads/main', oid: A }, { ref: 'refs/heads/alt/x', oid: B }], A, new Uint8Array([0x50, 0x41, 0x43, 0x4b]));
    const { header, packStart } = parseBundle(bytes);
    expect(header).toEqual({ version: 2, prerequisites: [], head: A, refs: [{ ref: 'refs/heads/alt/x', oid: B }, { ref: 'refs/heads/main', oid: A }] });
    expect(bytes[packStart]).toBe(0x50);
  });

  it('refuses SHA-256 and partial bundles by name', () => {
    const v3 = (cap: string) => new TextEncoder().encode(`# v3 git bundle\n${cap}\n${A} refs/heads/main\n\nPACK`);
    expect(() => parseBundle(v3('@object-format=sha256'))).toThrow(/sha256/);
    expect(() => parseBundle(v3('@filter=blob:none'))).toThrow(/partial/);
    expect(parseBundle(v3('@object-format=sha1')).header.version).toBe(3);
    expect(() => parseBundle(new TextEncoder().encode(`# v2 git bundle\n${A} refs/heads/../x\n\nPACK`))).toThrow(HistoryError);
  });
});

describe('worker requests', () => {
  it('calls only the compute methods it defines, whatever name another thread sends', async () => {
    for (const method of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'nope']) {
      const request = { family: 'compute', method, args: [] } as unknown as Request;
      await expect(handle(request, undefined)).rejects.toMatchObject({ code: 'invalid' });
    }
    const prepared = (await handle({ family: 'compute', method: 'prepare', args: [createDocument('Worker')] }, undefined)) as { blobId: string };
    expect(prepared.blobId).toMatch(/^[0-9a-f]{40}$/);
  });

  it('dispatches every compute method it defines', async () => {
    for (const method of Object.keys(compute)) {
      const outcome = await handle({ family: 'compute', method, args: [] } as unknown as Request, undefined).catch((error: unknown) => error);
      expect((outcome as { code?: string } | undefined)?.code, method).not.toBe('invalid');
    }
  });
});
