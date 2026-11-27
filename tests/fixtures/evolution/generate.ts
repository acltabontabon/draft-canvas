/**
 * Regenerates `contract.json`, the cross-backend fixtures (ADR-1): `npx tsx tests/fixtures/evolution/generate.ts`.
 *
 * Each fixture is a linear history of canonical diagram texts with fixed messages and times, and the
 * commit ids standard Git computes for it. The browser backend, the desktop backend and Git itself
 * are each tested against these ids, so a backend that writes a different object fails on its own.
 * Regenerate only when the canonical format changes on purpose — then every id changes with it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEdges, addNodes, updateNode } from '../../../src/document/operations';
import { createDocument, createEdge, createNode } from '../../../src/document/factory';
import { historyText } from '../../../src/evolution/snapshot';
import { formatMessage } from '../../../src/evolution/trailers';
import { rngFrom, seededFile, randomEdit } from '../../collab/support';

const TIME = 1_700_000_000;

function message(summary: string): string {
  return formatMessage({ summary, trailers: { initiator: 'auto', documentId: 'd_fixture', categories: ['structure'] } });
}

function fixed<T extends { metadata: { id: string; createdAt: number; updatedAt: number } }>(doc: T): T {
  return { ...doc, metadata: { ...doc.metadata, id: 'd_fixture', createdAt: TIME * 1000, updatedAt: TIME * 1000 } };
}

function simple(): { text: string; message: string; time: number }[] {
  let doc = fixed(createDocument('Payments'));
  const out = [{ text: historyText(doc), message: message('Start Payments'), time: TIME }];
  const api = createNode({ type: 'service', x: 0, y: 0, id: 'n_api', text: 'API Gateway' });
  const orders = createNode({ type: 'service', x: 300, y: 0, id: 'n_orders', text: 'Order Service' });
  doc = addNodes(doc, [api, orders]);
  out.push({ text: historyText(doc), message: message('Add API Gateway and Order Service'), time: TIME });
  doc = addEdges(doc, [createEdge({ id: 'e_1', source: 'n_api', target: 'n_orders' })]);
  out.push({ text: historyText(doc), message: message('Connect API Gateway to Order Service'), time: TIME });
  doc = updateNode(doc, 'n_orders', { technology: 'Go', text: 'Orders — ünïcode ✓' });
  out.push({ text: historyText(doc), message: message('Update Order Service'), time: TIME });
  return out;
}

function seeded(): { text: string; message: string; time: number }[] {
  const rng = rngFrom(20261126);
  let doc = fixed(seededFile(rng, 20));
  const out: { text: string; message: string; time: number }[] = [];
  for (let i = 0; i < 4; i += 1) {
    out.push({ text: historyText(doc), message: message(`Seeded revision ${i + 1}`), time: TIME });
    for (let j = 0; j < 8; j += 1) doc = randomEdit(doc, rng);
  }
  return out;
}

function gitIds(revisions: { text: string; message: string }[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'dc-fixture-'));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@draftcanvas.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@draftcanvas.invalid',
    GIT_AUTHOR_DATE: `${TIME} +0000`,
    GIT_COMMITTER_DATE: `${TIME} +0000`,
  };
  const run = (args: string[], input?: string) => {
    const result = spawnSync('git', args, { cwd: dir, env, input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    run(['init', '--bare', '-q', '.']);
    const ids: string[] = [];
    for (const revision of revisions) {
      const blob = run(['hash-object', '-w', '--stdin'], revision.text);
      const tree = run(['mktree'], `100644 blob ${blob}\tdiagram.draftcanvas\n`);
      ids.push(run(['commit-tree', tree, ...(ids.length ? ['-p', ids.at(-1)!] : []), '-F', '-'], revision.message));
    }
    return ids;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixtures = [
  { name: 'simple', revisions: simple() },
  { name: 'seeded', revisions: seeded() },
].map((fixture) => ({ ...fixture, expected: { commits: gitIds(fixture.revisions) } }));

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'contract.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
console.warn(`Wrote ${fixtures.length} fixtures.`);
