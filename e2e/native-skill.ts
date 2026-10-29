/** Real desktop verification, with no mock shell or disk. Start the packaged app, add an empty
 * project folder and allow agent access to it in Settings first. Run create, quit/relaunch the app
 * and reopen the saved file, then run verify with the same --out folder.
 *
 * npx tsx e2e/native-skill.ts --phase create --sidecar <binary> --agent-dir <app-data/agent> \
 *   --project-dir <enabled-folder> --out <report-folder>
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpSession } from './agent-conversations';

type Json = Record<string, unknown>;
const flag = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  assert(index >= 0 && process.argv[index + 1], `--${name} is required`);
  return process.argv[index + 1]!;
};
const phase = flag('phase');
assert(phase === 'create' || phase === 'verify', '--phase must be create or verify');
const projectDir = resolve(flag('project-dir'));
const out = resolve(flag('out'));
mkdirSync(out, { recursive: true });
const client = new McpSession(`native-skill-${phase}`, flag('sidecar'), flag('agent-dir'));
const records: Json[] = [];
const statePath = join(out, 'session.json');
const fileNames = () => readdirSync(projectDir).filter(name => name.endsWith('.draftcanvas'));
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const persist = () => writeFileSync(join(out, `${phase}-report.json`), JSON.stringify({ phase, calls: client.records, results: records }, null, 2));
async function call(tool: string, args: Json = {}, error?: string) {
  const result = await client.call(tool, args);
  records.push({ tool, value: result.value });
  persist();
  if (error) assert.equal(result.record.code, error, JSON.stringify(result.value));
  else assert(result.ok, `${tool}: ${JSON.stringify(result.value)}`);
  return result;
}
const timeout = setTimeout(() => {
  persist();
  client.stop();
  console.error('Native skill verification timed out after 180 seconds. Inspect the app and report before retrying.');
  process.exitCode = 1;
}, 180_000);

try {
  await client.start();
  await call('get_capabilities', { topics: ['readability'] });
  let state: Json;
  if (phase === 'create') {
    assert.equal(fileNames().length, 0, 'Use an empty verification folder; never overwrite an earlier run.');
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/agent/draft-canvas.request.json'), 'utf8'));
    const args = { ...fixture, title: 'Draft Canvas — native skill verification', requestId: randomUUID(), open: true };
    const created = await call('create_diagram', args);
    const diagramId = created.value.diagramId;
    assert.equal(fileNames().length, 1);
    const file = join(projectDir, fileNames()[0]!);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).metadata.id, diagramId);
    const replay = await call('create_diagram', args);
    assert.equal(replay.value.diagramId, diagramId);
    assert.equal(replay.value.replayed, true);
    assert.equal(fileNames().length, 1, 'Idempotent create must not duplicate the file.');
    const initial = await call('read_diagram', { diagramId, include: ['views'] });
    const revision = initial.value.revision;
    const originalBytes = hash(file);
    const preview = await call('preview_diagram', {
      diagramId, expectedRevision: revision, view: { inside: ['editor'] },
      ops: [{ op: 'update', id: 'e.model', set: { description: 'Transforms immutable graphs and lenses nested rooms.' } }],
    });
    await call('render_diagram', { diagramId, previewId: preview.value.previewId, view: { inside: ['editor'] } });
    assert.equal(hash(file), originalBytes, 'Preparing and rendering a preview must not touch the real file.');
    const updateArgs = { requestId: randomUUID(), diagramId, expectedRevision: revision, view: { inside: ['editor'] }, previewId: preview.value.previewId };
    const updated = await call('update_diagram', updateArgs);
    assert.equal(updated.value.persisted, true, 'The native app must confirm a real save.');
    const savedBytes = hash(file);
    assert.notEqual(savedBytes, originalBytes);
    const repeated = await call('update_diagram', updateArgs);
    assert.equal(repeated.value.replayed, true);
    assert.equal(hash(file), savedBytes, 'Replaying an update must not write again.');
    await call('update_diagram', { requestId: randomUUID(), diagramId, expectedRevision: revision, ops: [{ op: 'update', id: 'editor', set: { label: 'Stale write must fail' } }] }, 'REVISION_CONFLICT');
    assert.equal(hash(file), savedBytes, 'A stale write must not change the disk.');
    state = { diagramId, file, revision: updated.value.revision, hash: savedBytes, views: initial.value.views };
  } else {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(hash(String(state.file)), state.hash, 'The saved file must survive an app restart unchanged.');
  }
  const listing = await call('list_diagrams');
  assert.equal((listing.value.active as Json)?.diagramId, state.diagramId, 'The native app must actually have this saved diagram open.');
  const views = [{ inside: [] as string[] }, ...(state.views as { inside: string[] }[])];
  const reads: Json[] = [];
  for (const view of views) {
    const read = await call('read_diagram', { diagramId: state.diagramId, view: { inside: view.inside }, include: ['fullText', 'geometry'] });
    assert.equal(read.value.revision, state.revision);
    reads.push(read.value);
    const image = await call('render_diagram', { diagramId: state.diagramId, view: { inside: view.inside }, format: 'png', scale: 1 });
    assert.equal(image.images.length, 1);
    const name = view.inside.join('-') || 'overview';
    writeFileSync(join(out, `${phase}-${name}.png`), Buffer.from(image.images[0]!.data, 'base64'));
  }
  if (phase === 'create') {
    state.reads = reads;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } else {
    assert.deepEqual(reads, state.reads, 'All views, flows, evidence, attachments and geometry must survive reopening.');
  }
  assert.equal(fileNames().length, 1);
  persist();
  console.log(`PASS native ${phase}: ${views.length} views; one real saved diagram; ${client.records.length} MCP calls.\n${state.file}`);
} finally {
  clearTimeout(timeout);
  client.stop();
}
