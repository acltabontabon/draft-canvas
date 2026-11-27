/**
 * Canvas Evolution's costs on the benchmark's own scale workloads: `npx tsx benchmark/history.ts`.
 *
 * Every number here is work the history worker (or the desktop shell) does off the drawing thread;
 * the drawing thread's only cost for a capture is handing the worker an immutable snapshot. Medians
 * of several runs after a warm-up. The supported workload is `medium` (200 shapes, 300 connectors).
 * Budgets (checked below, with headroom over the measured medians):
 *
 * | Step                                | medium budget |
 * | ----------------------------------- | ------------- |
 * | canonical text + blob id            | 60 ms         |
 * | semantic diff + wording, one edit   | 60 ms         |
 * | three-way merge, two edits          | 150 ms        |
 * | record a revision (web backend)     | 120 ms        |
 * | list 100 revisions                  | 400 ms        |
 */
import { performance } from 'node:perf_hooks';
import { webcrypto } from 'node:crypto';
import { updateNode } from '../src/document/operations';
import type { DraftDocument } from '../src/document/types';
import { BrowserBackend, MemoryState } from '../src/evolution/browser/backend';
import { KvFs, MemoryKv } from '../src/evolution/browser/kvfs';
import { processLocks } from '../src/evolution/locks';
import { MAIN_REF } from '../src/evolution/refs';
import { compute } from '../src/evolution/workerHost';
import { buildScaleDocument, SCALE_SPECS } from './workloads/scale';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

const BUDGETS_MEDIUM = { prepare: 60, diff: 60, merge: 150, record: 120, list: 400 };

async function median(runs: number, work: () => Promise<unknown>): Promise<number> {
  await work();
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

function edited(doc: DraftDocument, n: number): DraftDocument {
  const node = doc.nodes[n % doc.nodes.length]!;
  return updateNode(doc, node.id, { text: `${node.text ?? 'Node'} ${n}` });
}

async function measure(name: keyof typeof SCALE_SPECS) {
  const { document } = buildScaleDocument(SCALE_SPECS[name]);
  const next = edited(document, 1);
  const theirs = edited(document, 7);
  const prepare = await median(7, () => compute.prepare(next));
  const diff = await median(7, () => compute.describe(document, next));
  const merge = await median(5, () => compute.merge(document, next, theirs, []));

  const fs = new KvFs(new MemoryKv());
  const backend = new BrowserBackend(fs, new MemoryState(), processLocks());
  const store = await backend.create({ repoId: `r_${name}`, documentId: document.metadata.id, title: name, createdAt: 0, alternatives: [] });
  const sig = { name: 'Bench', email: 'bench@draftcanvas.invalid', timestamp: 1_700_000_000, timezoneOffset: 0 };
  let tip: string | null = null;
  let current = document;
  let n = 0;
  const record = await median(7, async () => {
    n += 1;
    current = edited(current, n);
    const { text } = await compute.prepare(current);
    const oid = await store.writeSnapshot({ text, parents: tip ? [tip] : [], author: sig, committer: sig, message: `Edit ${n}\n` });
    await store.updateRef({ ref: MAIN_REF, expected: tip, next: oid });
    tip = oid;
  });
  for (let i = 0; i < 100; i += 1) {
    n += 1;
    current = edited(current, n);
    const { text } = await compute.prepare(current);
    const oid = await store.writeSnapshot({ text, parents: tip ? [tip] : [], author: sig, committer: sig, message: `Edit ${n}\n` });
    await store.updateRef({ ref: MAIN_REF, expected: tip, next: oid });
    tip = oid;
  }
  const list = await median(3, () => store.log({ from: [tip!], limit: 100 }));
  const before = (await store.usage()).bytes;
  await (await backend.open(`r_${name}`))!.maintain(Number.MAX_SAFE_INTEGER);
  const packed = (await store.usage()).bytes;
  const fileBytes = (await compute.prepare(current)).text.length;
  return { name, prepare, diff, merge, record, list, revisions: n, looseBytes: before, packedBytes: packed, fileBytes };
}

const results = [];
for (const name of ['small', 'medium', 'large'] as const) results.push(await measure(name));
const fmt = (ms: number) => `${ms.toFixed(1)} ms`;
for (const r of results) {
  console.warn(
    `${r.name.padEnd(7)} prepare ${fmt(r.prepare)} · diff ${fmt(r.diff)} · merge ${fmt(r.merge)} · record ${fmt(r.record)} · list 100 ${fmt(r.list)} · ` +
      `${r.revisions} revisions of a ${(r.fileBytes / 1024).toFixed(0)} KB diagram: ${(r.looseBytes / 1024 / 1024).toFixed(1)} MB loose, ${(r.packedBytes / 1024 / 1024).toFixed(1)} MB after maintenance`,
  );
}
const medium = results.find((r) => r.name === 'medium')!;
const over = (Object.keys(BUDGETS_MEDIUM) as (keyof typeof BUDGETS_MEDIUM)[]).filter((key) => medium[key] > BUDGETS_MEDIUM[key]);
if (over.length > 0) {
  console.error(`Over budget on medium: ${over.map((key) => `${key} ${fmt(medium[key])} > ${BUDGETS_MEDIUM[key]} ms`).join(', ')}`);
  process.exitCode = 1;
}
