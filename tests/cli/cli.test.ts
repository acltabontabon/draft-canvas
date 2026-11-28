// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../../cli/main';
import { fileSystemReader } from '../../cli/repo';
import { REPO_LIMITS } from '../../src/checks';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument, DraftNode, SourceEvidence } from '../../src/document/types';
import { serializeDocument } from '../../src/export/project';

const dir = mkdtempSync(join(tmpdir(), 'draftcanvas-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = { x: 0, y: 0 };
const service = (id: string, text: string, x: number, evidence?: SourceEvidence[]): DraftNode => ({ ...createNode({ id, type: 'service', text, x, y: 0 }), ...(evidence ? { evidence } : {}) });

function diagram(name: string, document: DraftDocument): string {
  const path = join(dir, name);
  writeFileSync(path, serializeDocument(document));
  return path;
}

function shop(evidence?: SourceEvidence[]): DraftDocument {
  const base = createDocument('Shop');
  return {
    ...base,
    // Fixed, so two runs over "the same diagram" really are.
    metadata: { ...base.metadata, id: 'shop', createdAt: 0, updatedAt: 0 },
    nodes: [service('web', 'Web', 0), service('api', 'Orders API', 300, evidence), createNode({ id: 'db', type: 'database', databaseKind: 'sql', text: 'Orders', x: 600, y: 0 })],
    edges: [createEdge({ id: 'e1', source: 'web', target: 'api', semantic: 'http', semanticsOrigin: 'explicit' }), createEdge({ id: 'e2', source: 'api', target: 'db', semantic: 'readsWrites', semanticsOrigin: 'explicit' })],
  };
}

const repo = join(dir, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(repo, 'src', 'api.ts'), 'export class OrdersApi {}\n');
writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), '');
writeFileSync(join(dir, 'secret.txt'), 'TOP-SECRET-MARKER\n');

const plain = diagram('shop.draftcanvas', shop());

describe('draftcanvas', () => {
  it('parses commands, options and values', () => {
    expect(parseArgs(['check', 'a.draftcanvas', '--repo', '.', '--json', '--fail-on=warning'])).toEqual({ command: 'check', args: { positional: ['a.draftcanvas'], flags: { repo: '.', json: true, 'fail-on': 'warning' } } });
    expect(parseArgs(['render', 'a', '-o', 'out.svg']).args.flags).toEqual({ output: 'out.svg' });
    expect(parseArgs(['check', 'a', '--repo']).error).toBe('--repo needs a value.');
    expect(parseArgs(['inspect', '--', '--odd-name']).args.positional).toEqual(['--odd-name']);
  });

  it('prints help, its version, and refuses what it does not know', async () => {
    expect((await main(['--help'])).stdout).toContain('draftcanvas check <diagram>');
    expect((await main([])).code).toBe(2);
    expect((await main(['--version'])).stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect(await main(['launch', plain])).toMatchObject({ code: 2, stdout: '' });
    expect(await main(['check', plain, '--frobnicate'])).toMatchObject({ code: 2, stderr: 'Unknown option --frobnicate.\n' });
    expect(await main(['check', plain, '--fail-on', 'sometimes'])).toMatchObject({ code: 2 });
  });

  it('inspects a diagram as text and as versioned JSON', async () => {
    const text = await main(['inspect', plain]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('1 view · 3 parts · 0 boundaries · 2 relations');
    expect(text.stdout).toContain('Orders API → Orders  readsWrites');
    const json = JSON.parse((await main(['inspect', plain, '--json'])).stdout);
    expect(json.schema).toBe('draftcanvas.inspect/1');
    expect(json.parts.map((part: { id: string }) => part.id)).toEqual(['web', 'api', 'db']);
    expect(json.relations.map((relation: { from: string; to: string }) => `${relation.from}>${relation.to}`)).toEqual(['web>api', 'api>db']);
  });

  it('checks the drawing alone, and says so when evidence was left unchecked', async () => {
    const result = await main(['check', diagram('cited.draftcanvas', shop([{ path: 'src/api.ts', basis: 'observed' }]))]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Evidence was not checked: name the repository with --repo.');
    expect(result.stdout).toContain('Nothing found.');
  });

  it('passes evidence that is intact and exits 1 on drift', async () => {
    const good = diagram('good.draftcanvas', shop([{ path: 'src/api.ts', basis: 'observed', symbol: 'OrdersApi' }]));
    const ok = await main(['check', good, '--repo', repo]);
    expect(ok).toMatchObject({ code: 0, stderr: '' });
    expect(ok.stdout).toContain('1 evidence entry, 1 intact');

    const bad = diagram('bad.draftcanvas', shop([{ path: 'src/gone.ts', basis: 'observed' }]));
    const drift = await main(['check', bad, '--repo', repo, '--json']);
    expect(drift.code).toBe(1);
    const report = JSON.parse(drift.stdout);
    expect(report.schema).toBe('draftcanvas.check/1');
    expect(report.counts).toEqual({ error: 1, warning: 0, info: 0 });
    expect(report.findings[0]).toMatchObject({ rule: 'evidence/missing-file', class: 'drift', severity: 'error', subjects: ['api'] });
    expect(report.checked.evidence).toEqual({ cited: 1, intact: 0 });
    expect((await main(['check', bad, '--repo', repo, '--fail-on', 'never'])).code).toBe(0);
  });

  it('checks the rules in a rule file, and honours waivers until they expire', async () => {
    const rulesFile = join(dir, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ version: 1, rules: [{ id: 'no-direct-db', type: 'must-not-depend', from: { name: 'Web' }, to: { kind: 'database' }, transitive: true, because: 'the API owns the data' }] }));
    const failing = await main(['check', plain, '--config', rulesFile, '--json']);
    expect(failing.code).toBe(1);
    const report = JSON.parse(failing.stdout);
    expect(report.rules).toBe(rulesFile);
    expect(report.checked.rules).toBe(1);
    expect(report.findings[0]).toMatchObject({ rule: 'rule/no-direct-db', class: 'violation', severity: 'error', subjects: ['web', 'db'] });

    writeFileSync(rulesFile, JSON.stringify({ version: 1, rules: JSON.parse(readFileSync(rulesFile, 'utf8')).rules, waivers: [{ finding: report.findings[0].id, reason: 'until the read model ships', expires: '2027-06-30' }] }));
    const waived = await main(['check', plain, '--config', rulesFile, '--today', '2027-06-30']);
    expect(waived.code).toBe(0);
    expect(waived.stdout).toContain('1 finding waived');
    expect((await main(['check', plain, '--config', rulesFile, '--today', '2027-07-01'])).code).toBe(1);

    // With --repo, the rule file at the top of the repository is read without being named.
    writeFileSync(join(repo, 'draftcanvas.json'), JSON.stringify({ version: 1, rules: [{ id: 'docs', type: 'must-have', of: { kind: 'service' }, require: 'description', severity: 'warning' }] }));
    const fromRepo = JSON.parse((await main(['check', plain, '--repo', repo, '--json'])).stdout);
    expect(fromRepo.rules).toBe('draftcanvas.json');
    expect(fromRepo.counts.warning).toBe(2);
    rmSync(join(repo, 'draftcanvas.json'));
  });

  it('refuses a rule file it cannot read exactly', async () => {
    const bad = join(dir, 'bad-rules.json');
    writeFileSync(bad, JSON.stringify({ version: 1, rules: [{ id: 'x', type: 'eval', code: 'process.exit()' }] }));
    const result = await main(['check', plain, '--config', bad]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('is not a valid rule file');
    writeFileSync(bad, '{ nope');
    expect(await main(['check', plain, '--config', bad])).toMatchObject({ code: 2 });
    expect(await main(['check', plain, '--config', join(dir, 'none.json')])).toMatchObject({ code: 2 });
    expect(await main(['check', plain, '--today', 'tomorrow'])).toMatchObject({ code: 2 });
  });

  it('gives the same bytes for the same input', async () => {
    const bad = diagram('same.draftcanvas', shop([{ path: 'src/gone.ts', basis: 'observed' }]));
    for (const argv of [['check', bad, '--repo', repo, '--json'], ['inspect', plain, '--json'], ['render', plain]]) {
      expect((await main(argv)).stdout, argv.join(' ')).toBe((await main(argv)).stdout);
    }
  });

  it('says what changed between two versions, and which findings came with it', async () => {
    const before = shop();
    const after: DraftDocument = {
      ...before,
      nodes: [...before.nodes, service('billing', 'Billing', 900)],
      edges: [...before.edges, createEdge({ id: 'e3', source: 'billing', target: 'db', semantic: 'writes', semanticsOrigin: 'explicit' }), createEdge({ id: 'e4', source: 'api', target: 'db', semantic: 'writes', semanticsOrigin: 'explicit' })],
    };
    const later = diagram('later.draftcanvas', after);
    const text = await main(['diff', plain, later]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Billing');
    const json = JSON.parse((await main(['diff', plain, later, '--json'])).stdout);
    expect(json.schema).toBe('draftcanvas.diff/1');
    expect(json.elements.filter((change: { change: string }) => change.change === 'added').map((change: { id: string }) => change.id).sort()).toEqual(['billing', 'e3', 'e4']);
    expect(json.findings.resolved).toEqual([]);
    expect(json.architecture.map((change: { kind: string }) => change.kind)).toEqual(['part-added', 'relation-added', 'relation-added']);
    expect(text.stdout).toContain('"Billing" now has a relation to "Orders" (writes). "Orders" now has 2 users.');
    // A move alone is a change to the file and none to the architecture.
    const shifted = diagram('shifted.draftcanvas', { ...before, nodes: before.nodes.map((node) => ({ ...node, y: 400 })) });
    expect((await main(['diff', plain, shifted])).stdout).toContain('No change to the architecture: layout, style or annotation only.');
    expect((await main(['diff', plain, plain])).stdout).toBe('No changes.\n');
    expect((await main(['diff', plain])).code).toBe(2);
  });

  it('says what a change to one part touches, by id or by label', async () => {
    const text = await main(['impact', plain, 'Orders API']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Reaches:     Orders');
    expect(text.stdout).toContain('Reached by:  Web');
    expect(text.stdout).toContain('not what was measured');
    const json = JSON.parse((await main(['impact', plain, 'api', '--json'])).stdout);
    expect(json).toMatchObject({ schema: 'draftcanvas.impact/1', id: 'api', downstream: { ids: ['db'] }, upstream: { ids: ['web'] } });
    expect(await main(['impact', plain, 'No Such Part'])).toMatchObject({ code: 2 });
    expect(await main(['impact', plain])).toMatchObject({ code: 2 });
    const twins = diagram('twins.draftcanvas', { ...shop(), nodes: [service('a', 'Twin', 0), service('b', 'twin', 300)], edges: [] });
    expect((await main(['impact', twins, 'Twin'])).stderr).toBe('2 parts are called "Twin". Use an id: a, b.\n');
  });

  it('renders SVG to a file or to the terminal', async () => {
    const svg = await main(['render', plain, '--theme', 'dark']);
    expect(svg.code).toBe(0);
    expect(svg.stdout.startsWith('<svg')).toBe(true);
    expect(svg.stdout).toContain('Orders API');
    const target = join(dir, 'out.svg');
    expect(await main(['render', plain, '-o', target])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readFileSync(target, 'utf8').startsWith('<svg')).toBe(true);
    // Other diagram formats are not this tool's business: the native file is the interchange format.
    expect(await main(['export', plain, '--format', 'mermaid'])).toMatchObject({ code: 2 });
    expect(await main(['render', plain, '--view', 'nowhere'])).toMatchObject({ code: 2 });
  });

  it('never writes over the diagram it was given', async () => {
    const before = readFileSync(plain, 'utf8');
    expect(await main(['render', plain, '-o', plain])).toMatchObject({ code: 2, stderr: 'The output would overwrite the diagram.\n' });
    expect(readFileSync(plain, 'utf8')).toBe(before);
    expect(await main(['render', plain, '-o', join(dir, 'no-such-folder', 'x.svg')])).toMatchObject({ code: 3 });
  });

  it('refuses what is not a diagram with exit 2, never a crash', async () => {
    const write = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };
    expect(await main(['check', write('not-json.draftcanvas', '{ nope')])).toMatchObject({ code: 2 });
    expect(await main(['check', write('other.draftcanvas', '{"format":"something-else"}')])).toMatchObject({ code: 2 });
    expect(await main(['check', write('future.draftcanvas', '{"format":"draft-canvas","version":99999}')])).toMatchObject({ code: 2 });
    expect(await main(['check', join(dir, 'missing.draftcanvas')])).toMatchObject({ code: 2 });
    expect(await main(['check', dir])).toMatchObject({ code: 2 });
    expect(await main(['check'])).toMatchObject({ code: 2 });
    // Hostile shapes inside valid JSON are repaired by the same validation the editor uses.
    const odd = write('odd.draftcanvas', JSON.stringify({ format: 'draft-canvas', version: 34, metadata: {}, nodes: [{ id: 1, type: 'service', evidence: [{ path: '../../etc/passwd', basis: 'observed' }] }, null, 'x'], edges: 'none' }));
    expect((await main(['check', odd, '--repo', repo])).code).not.toBe(3);
  });

  it('exits 3 when the repository cannot be opened', async () => {
    expect(await main(['check', plain, '--repo', join(dir, 'no-such-repo')])).toMatchObject({ code: 3, stdout: '' });
    expect(await main(['check', plain, '--repo', plain])).toMatchObject({ code: 3 });
  });
});

describe('the repository reader', () => {
  const reader = fileSystemReader(repo);

  it('lists regular files, sorted, and leaves dependency folders out', async () => {
    expect(await reader.list()).toEqual({ paths: ['src/api.ts'], truncated: false });
  });

  it('reads inside the folder and nowhere else', async () => {
    expect(await reader.read('src/api.ts')).toEqual({ status: 'ok', text: 'export class OrdersApi {}\n' });
    expect(await reader.read('src/none.ts')).toEqual({ status: 'missing' });
    expect(await reader.read('src/api.ts/x')).toEqual({ status: 'missing' });
    for (const path of ['../secret.txt', 'src/../../secret.txt', '/etc/hosts', join(dir, 'secret.txt')]) {
      expect((await reader.read(path)).status, path).toBe('outside');
    }
    expect((await reader.read('src')).status).toBe('unreadable');
  });

  it('does not follow a link out of the folder, or list through one', async () => {
    symlinkSync(join(dir, 'secret.txt'), join(repo, 'src', 'leak.txt'));
    symlinkSync(dir, join(repo, 'up'));
    const linked = fileSystemReader(repo);
    expect((await linked.read('src/leak.txt')).status).toBe('outside');
    expect((await linked.read('up/secret.txt')).status).toBe('outside');
    expect((await linked.list()).paths).toEqual(['src/api.ts']);
    // The whole way through: evidence that points at the link is reported, and nothing of the file is printed.
    const path = diagram('leak.draftcanvas', shop([{ path: 'src/leak.txt', basis: 'observed', symbol: 'TOP-SECRET-MARKER' }]));
    const result = await main(['check', path, '--repo', repo, '--json']);
    expect(JSON.parse(result.stdout).findings[0]).toMatchObject({ rule: 'evidence/unread-file', class: 'unsupported' });
    expect(result.stdout.replaceAll('"symbol": "TOP-SECRET-MARKER"', '')).not.toContain('TOP-SECRET-MARKER');
  });

  it('reports files that are too large or not text instead of reading them', async () => {
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2048));
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    const small = fileSystemReader(repo, { ...REPO_LIMITS, maxFileBytes: 1024 });
    expect(await small.read('big.txt')).toEqual({ status: 'too-large' });
    expect(await small.read('blob.bin')).toEqual({ status: 'binary' });
  });

  it('stops listing at its limits and says the listing is incomplete', async () => {
    expect(await fileSystemReader(repo, { ...REPO_LIMITS, maxFiles: 1 }).list()).toMatchObject({ truncated: true });
    expect(await fileSystemReader(repo, { ...REPO_LIMITS, maxDepth: 0 }).list()).toMatchObject({ truncated: true });
  });
});

// Kept last: it only needs the node helper, and shows the fixture still means what the tests assume.
it('the fixture diagram is a valid file', () => {
  expect(createNode({ id: 'n', type: 'service', ...at }).type).toBe('service');
});
