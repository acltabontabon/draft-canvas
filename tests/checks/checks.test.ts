import { describe, expect, it } from 'vitest';
import { applyWaivers, assertFindings, builtinFindings, checkAnchors, checkCompose, checkDiagram, composeServices, finding, fingerprint, impactOf, linesNaming, memoryReader, normalizeRepoPath, parseConfig, reaches, sortFindings, type FindingInput, type RepoReader, type Rule } from '../../src/checks';
import { impactScope } from '../../src/checks/impact';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument, DraftEdge, DraftNode, SourceEvidence } from '../../src/document/types';
import { modelOf } from '../../src/model';

type NodeInput = Parameters<typeof createNode>[0];

const at = { x: 0, y: 0 };
const service = (id: string, text: string, evidence?: SourceEvidence[], extra: Partial<NodeInput> = {}): DraftNode => ({ ...createNode({ id, type: 'service', text, ...at, ...extra }), ...(evidence ? { evidence } : {}) });
const calls = (id: string, source: string, target: string, evidence?: SourceEvidence[]): DraftEdge => ({ ...createEdge({ id, source, target, semantic: 'calls', semanticsOrigin: 'explicit' }), ...(evidence ? { evidence } : {}) });
const file = (nodes: DraftNode[], edges: DraftEdge[] = []): DraftDocument => ({ ...createDocument('Shop'), nodes, edges });
const seen = (path: string, extra: Partial<SourceEvidence> = {}): SourceEvidence => ({ path, basis: 'observed', ...extra });
const rules = (findings: { rule: string }[]) => findings.map((entry) => entry.rule);

describe('findings', () => {
  it('have an id that is the same every time and differs with what they are about', () => {
    const base: FindingInput = { rule: 'evidence/missing-file', class: 'drift', severity: 'error', subjects: ['a'], message: 'm' };
    expect(finding(base).id).toBe(finding({ ...base, message: 'worded differently' }).id);
    expect(finding(base).id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set([finding(base).id, finding({ ...base, subjects: ['b'] }).id, finding({ ...base, selector: '1' }).id, finding({ ...base, room: ['x'] }).id, finding({ ...base, rule: 'evidence/other' }).id]).size).toBe(5);
    expect(fingerprint('')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('sort most severe first, then by rule', () => {
    const make = (rule: string, severity: 'error' | 'warning' | 'info') => finding({ rule, class: 'advisory', severity, subjects: [], message: '' });
    const sorted = sortFindings([make('b/x', 'info'), make('a/x', 'warning'), make('z/x', 'error'), make('a/a', 'warning')]);
    expect(rules(sorted)).toEqual(['z/x', 'a/a', 'a/x', 'b/x']);
    expect(reaches(sorted, 'error')).toBe(true);
    expect(reaches(sorted.slice(1), 'error')).toBe(false);
    expect(reaches(sorted.slice(1), 'warning')).toBe(true);
  });
});

describe('the checks a diagram gets with no setup', () => {
  it('carry the semantic review, view by view', () => {
    const writes = (id: string, source: string) => createEdge({ id, source, target: 'db', semantic: 'writes', semanticsOrigin: 'explicit' });
    const found = builtinFindings(file([service('a', 'Orders', undefined, { serviceKind: 'api' }), service('b', 'Billing', undefined, { serviceKind: 'api' }), createNode({ id: 'db', type: 'database', databaseKind: 'sql', text: 'Shared', ...at })], [writes('1', 'a'), writes('2', 'b')]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: 'review/shared-database', class: 'advisory', severity: 'warning', subjects: ['db', 'a', 'b'] });
    expect(found[0]!.room).toBeUndefined();
  });

  it('find a call loop through three parts, which the two-part review does not', () => {
    const found = builtinFindings(file([service('a', 'A'), service('b', 'B'), service('c', 'C')], [calls('ab', 'a', 'b'), calls('bc', 'b', 'c'), calls('ca', 'c', 'a')]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: 'model/dependency-cycle', severity: 'warning', subjects: ['a', 'b', 'c'] });
    expect(found[0]!.message).toContain('"A", "B", "C" call each other in a loop');
  });

  it('do not call an event back a loop', () => {
    const back = { ...calls('ca', 'c', 'a'), kind: 'event' as const };
    expect(builtinFindings(file([service('a', 'A'), service('b', 'B'), service('c', 'C')], [calls('ab', 'a', 'b'), calls('bc', 'b', 'c'), back]))).toEqual([]);
  });

  it('say when connectors lead nowhere, and stay quiet about one that carries on elsewhere', () => {
    const junction = (id: string, link?: string): DraftNode => ({ ...createNode({ id, type: 'ellipse', ...at }), ...(link ? { link } : {}) });
    const found = builtinFindings(file([service('a', 'A'), junction('dead'), junction('portal', 'L')], [calls('1', 'a', 'dead'), calls('2', 'a', 'portal')]));
    expect(found.map((entry) => [entry.rule, entry.subjects])).toEqual([['model/dangling-junction', ['1']]]);
  });
});

describe('evidence anchors', () => {
  const repo = {
    'src/orders/api.ts': ['export class OrdersApi {', '  placeOrder() {}', '}', ''].join('\n'),
    'src/billing/charge.ts': 'export function charge() {}\n',
    'legacy/a/util.ts': 'x\n',
    'legacy/b/util.ts': 'y\n',
    'moved/here/handler.ts': 'z\n',
  };

  const run = async (evidence: SourceEvidence[], reader: RepoReader = memoryReader(repo)) => checkAnchors(file([service('api', 'Orders API', evidence)]), reader);

  it('passes evidence that is where it says', async () => {
    const report = await run([seen('src/orders/api.ts', { symbol: 'OrdersApi', line: 1 }), seen('./src/billing/charge.ts'), seen('src\\orders\\api.ts', { line: 3 })]);
    expect(report).toEqual({ findings: [], checked: 3, intact: 3 });
  });

  it('reports a file that is gone as drift, and softer when it was only inferred', async () => {
    const observed = await run([seen('src/gone.ts')]);
    expect(observed.findings[0]).toMatchObject({ rule: 'evidence/missing-file', class: 'drift', severity: 'error', subjects: ['api'], evidence: [{ path: 'src/gone.ts' }] });
    expect(observed.findings[0]!.message).toBe('Evidence for "Orders API": src/gone.ts is no longer in the repository.');
    const inferred = await run([{ path: 'src/gone.ts', basis: 'inferred' }]);
    expect(inferred.findings[0]).toMatchObject({ class: 'drift', severity: 'warning' });
  });

  it('offers a file of the same name elsewhere, and never picks between several', async () => {
    const one = await run([seen('src/old/handler.ts')]);
    expect(one.findings[0]).toMatchObject({ rule: 'evidence/moved-file', class: 'potential-drift', severity: 'warning' });
    expect(one.findings[0]!.message).toContain('moved/here/handler.ts');
    const several = await run([seen('src/util.ts')]);
    expect(several.findings[0]).toMatchObject({ rule: 'evidence/moved-file', class: 'ambiguous' });
  });

  it('never calls a file missing as drift when the listing was incomplete', async () => {
    const report = await run([seen('src/gone.ts')], memoryReader(repo, { truncated: true }));
    expect(report.findings[0]).toMatchObject({ rule: 'evidence/missing-file', class: 'potential-drift', severity: 'warning' });
  });

  it('reports a name that is no longer in the file, matching whole names only', async () => {
    const report = await run([seen('src/orders/api.ts', { symbol: 'Orders' }), seen('src/orders/api.ts', { symbol: 'placeOrder()' })]);
    expect(rules(report.findings)).toEqual(['evidence/missing-symbol']);
    expect(report.findings[0]).toMatchObject({ class: 'drift', severity: 'error' });
    expect(report.intact).toBe(1);
  });

  it('says a name or a line has moved without calling it drift', async () => {
    const long = { 'big.ts': `${'\n'.repeat(99)}function target() {}\n` };
    const moved = await checkAnchors(file([service('s', 'S', [seen('big.ts', { symbol: 'target', line: 3 })])]), memoryReader(long));
    expect(moved.findings[0]).toMatchObject({ rule: 'evidence/moved-symbol', class: 'stale', severity: 'info', evidence: [{ path: 'big.ts', symbol: 'target', line: 100 }] });
    const short = await run([seen('src/billing/charge.ts', { line: 500 })]);
    expect(short.findings[0]).toMatchObject({ rule: 'evidence/line-out-of-range', class: 'stale', severity: 'info' });
  });

  it('reads evidence on connectors and in rooms, and says where', async () => {
    const inner = service('ctl', 'Controller', [seen('src/gone.ts')]);
    const owner: DraftNode = { ...service('api', 'API'), inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    const report = await checkAnchors(file([owner, service('b', 'Billing')], [calls('e', 'api', 'b', [seen('src/nope.ts')])]), memoryReader(repo));
    expect(report.findings.map((entry) => [entry.subjects, entry.room, entry.message])).toEqual([
      [['e'], undefined, 'Evidence for the connector from "API" to "Billing": src/nope.ts is no longer in the repository.'],
      [['ctl'], ['api'], 'Evidence for "Controller": src/gone.ts is no longer in the repository.'],
    ]);
  });

  it('reports what it could not read instead of guessing', async () => {
    const odd: RepoReader = {
      list: async () => ({ paths: [], truncated: false }),
      read: async (path) => (path === 'big.bin' ? { status: 'too-large' } : path === 'img.png' ? { status: 'binary' } : path === 'link' ? { status: 'outside' } : { status: 'unreadable', detail: 'EACCES' }),
    };
    const report = await checkAnchors(file([service('s', 'S', [seen('big.bin'), seen('img.png'), seen('link'), seen('locked')])]), odd);
    expect(report.findings.map((entry) => [entry.rule, entry.class])).toEqual([
      ['evidence/unread-file', 'unsupported'],
      ['evidence/unread-file', 'unsupported'],
      ['evidence/unread-file', 'unsupported'],
      ['evidence/unread-file', 'tool-error'],
    ]);
    expect(report.intact).toBe(0);
  });

  it('keeps paths inside the repository', () => {
    expect(normalizeRepoPath('./a//b/./c.ts')).toBe('a/b/c.ts');
    expect(normalizeRepoPath('a\\b.ts')).toBe('a/b.ts');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', 'file:///x', '', '  ', '.']) expect(normalizeRepoPath(bad), bad).toBeNull();
  });

  it('matches a name as a whole token', () => {
    expect(linesNaming(['const orders = 1', 'OrdersApi()', 'Orders.place()'], 'Orders')).toEqual([3]);
    expect(linesNaming(['GET /orders', 'POST /orders/{id}'], 'POST /orders')).toEqual([2]);
    expect(linesNaming(['a.b(c)'], 'a.b(c)')).toEqual([1]);
    expect(linesNaming(['x'], '  ')).toEqual([]);
  });
});

describe('Docker Compose', () => {
  const compose = ['services:', '  orders-api:', '    image: shop/orders', '    depends_on: [db, cache]', '  db:', '    image: postgres:16', '  cache:', '    image: redis', '  mailer:', '    depends_on:', '      db:', '        condition: service_healthy', ''].join('\n');
  const parts = [service('api', 'Orders API'), createNode({ id: 'db', type: 'database', databaseKind: 'sql', text: 'DB', ...at }), createNode({ id: 'cache', type: 'database', databaseKind: 'cache', text: 'Cache', ...at })];

  it('reads services and what each depends on, in either spelling', () => {
    expect(composeServices(compose)).toEqual([
      { name: 'orders-api', dependsOn: ['db', 'cache'] },
      { name: 'db', dependsOn: [] },
      { name: 'cache', dependsOn: [] },
      { name: 'mailer', dependsOn: ['db'] },
    ]);
    expect(composeServices('services: [1, 2]')).toBeNull();
    expect(composeServices('not: compose')).toBeNull();
    expect(composeServices('a: [unclosed')).toBeNull();
  });

  it('reports what is declared and not drawn as potential drift, never more', async () => {
    const model = modelOf(file(parts, [calls('1', 'api', 'db')]));
    const found = await checkCompose(model, memoryReader({ 'docker-compose.yml': compose }));
    expect(found.map((entry) => [entry.rule, entry.class, entry.severity, entry.subjects])).toEqual([
      ['compose/undrawn-service', 'potential-drift', 'info', []],
      ['compose/undrawn-dependency', 'potential-drift', 'info', ['api', 'cache']],
    ]);
    expect(found[0]!.message).toBe('docker-compose.yml declares a service "mailer" that no part of the diagram is named for.');
    expect(found[1]!.scope).toContain('3 of its 4 services matched');
  });

  it('says nothing about a Compose file the diagram does not claim', async () => {
    const model = modelOf(file([service('x', 'Something else')]));
    expect(await checkCompose(model, memoryReader({ 'compose.yaml': compose }))).toEqual([]);
  });

  it('takes a cited service name over a matching label', async () => {
    const model = modelOf(file([service('m', 'Notifications', [seen('deploy/compose.yml', { symbol: 'mailer' })]), ...parts.slice(1)]));
    const found = await checkCompose(model, memoryReader({ 'deploy/compose.yml': compose }));
    expect(found.filter((entry) => entry.rule === 'compose/undrawn-service').map((entry) => entry.evidence![0]!.symbol)).toEqual(['orders-api']);
    expect(found.find((entry) => entry.rule === 'compose/undrawn-dependency')).toMatchObject({ subjects: ['m', 'db'] });
  });

  it('says a cited file is not a Compose file rather than failing', async () => {
    const model = modelOf(file([service('m', 'M', [seen('compose.yml', { symbol: 'm' })])]));
    const found = await checkCompose(model, memoryReader({ 'compose.yml': '{ broken' }));
    expect(found.map((entry) => [entry.rule, entry.class])).toEqual([['compose/unreadable', 'unsupported']]);
  });
});

describe('checking a diagram', () => {
  it('checks the drawing alone when no repository is given', async () => {
    const report = await checkDiagram(file([service('a', 'A', [seen('src/gone.ts')])]));
    expect(report).toEqual({ findings: [], counts: { error: 0, warning: 0, info: 0 }, waived: [], checked: { views: 1, parts: 1, relations: 0 } });
  });

  it('holds evidence against a repository and says what it covered', async () => {
    const report = await checkDiagram(file([service('a', 'A', [seen('src/gone.ts'), seen('here.ts')])]), { repo: memoryReader({ 'here.ts': '' }) });
    expect(rules(report.findings)).toEqual(['evidence/missing-file']);
    expect(report.counts).toEqual({ error: 1, warning: 0, info: 0 });
    expect(report.checked.evidence).toEqual({ cited: 2, intact: 1 });
  });

  it('turns a reader that fails into a failed check, never a drifted diagram', async () => {
    const broken: RepoReader = { list: async () => Promise.reject(new Error('disk gone')), read: async () => ({ status: 'missing' }) };
    const report = await checkDiagram(file([service('a', 'A', [seen('x.ts')])]), { repo: broken });
    expect(report.findings.map((entry) => [entry.rule, entry.class])).toEqual([['evidence/reader-failed', 'tool-error']]);
  });

  it('gives the same report for the same input', async () => {
    const make = () => checkDiagram(file([service('a', 'A', [seen('src/gone.ts')]), service('b', 'B'), service('c', 'C')], [calls('ab', 'a', 'b'), calls('bc', 'b', 'c'), calls('ca', 'c', 'a')]), { repo: memoryReader({}) });
    expect(JSON.stringify(await make())).toBe(JSON.stringify(await make()));
  });
});

describe('impact', () => {
  const group = (id: string, text: string) => createNode({ id, type: 'group', text, boundaryPreset: 'system', ...at });
  const inner = service('ctl', 'Controller');
  const api: DraftNode = { ...service('api', 'Orders API', undefined, { parentId: 'sys' }), inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  const nodes = [group('sys', 'Shop'), service('web', 'Web'), api, service('billing', 'Billing', undefined, { parentId: 'sys' }), createNode({ id: 'db', type: 'database', databaseKind: 'sql', text: 'Orders', parentId: 'sys', ...at })];
  const writes = (id: string, source: string) => createEdge({ id, source, target: 'db', semantic: 'writes', semanticsOrigin: 'explicit' });
  const edges = [calls('1', 'web', 'api'), writes('2', 'api'), writes('3', 'billing')];
  const shop: DraftDocument = {
    ...file(nodes, edges),
    flows: [{ id: 'f1', title: 'Place an order', steps: [{ id: 's1', edgeId: '1' }, { id: 's2', edgeId: '2' }] }, { id: 'f2', title: 'Bill', steps: [{ id: 's1', edgeId: '3' }] }],
    openPoints: [{ id: 'op1', kind: 'tentative', targets: [{ kind: 'edge', id: '2' }] }, { id: 'op2', kind: 'tentative', targets: [{ kind: 'node', id: 'billing' }] }],
  };

  it('says what a part reaches, shares and crosses, and which flows and open points touch it', () => {
    const impact = impactOf(shop, 'api')!;
    expect(impact).toMatchObject({
      id: 'api',
      kind: 'part',
      name: 'Orders API',
      room: [],
      inside: [],
      contains: ['ctl'],
      downstream: { ids: ['db'], total: 1, truncated: false },
      upstream: { ids: ['web'], total: 1, truncated: false },
      crossings: [{ relation: '1', other: 'web', boundaries: ['sys'] }],
      shares: [{ id: 'db', with: ['billing'] }],
      flows: [{ id: 'f1', title: 'Place an order' }],
      openPoints: ['op1'],
    });
    expect(impact.basis).toContain('not what was measured');
  });

  it('carries the outage walk\'s reading, by the same rules', () => {
    const impact = impactOf(shop, 'api')!;
    expect(impact.outage!.headline).toContain('Orders API');
    expect(impact.outage!.affected.map((entry) => entry.id)).toContain('api');
    expect(impact.outage!.flows.find((flow) => flow.id === 'f1')).toMatchObject({ state: 'breaks' });
    expect(impact.outage!.flows.find((flow) => flow.id === 'f2')).toMatchObject({ state: 'unaffected' });
  });

  it('reads a part inside another, a boundary, and nothing for an id the file does not have', () => {
    expect(impactOf(shop, 'ctl')).toMatchObject({ room: ['api'], inside: ['api'], contains: [], downstream: { ids: [] } });
    expect(impactOf(shop, 'ctl')!.outage).toMatchObject({ affected: [{ id: 'ctl', state: 'down' }], notes: [], flows: [] });
    expect(impactOf(shop, 'sys')).toMatchObject({ kind: 'boundary', name: 'Shop', contains: ['api', 'billing', 'db'] });
    expect(impactOf(shop, 'nope')).toBeUndefined();
    expect(impactOf(shop, '2')).toBeUndefined();
  });
});

describe('declared rules', () => {
  const group = (id: string, text: string, parentId?: string) => createNode({ id, type: 'group', text, ...(parentId ? { parentId } : {}), ...at });
  const store = (id: string, text: string, parentId?: string) => createNode({ id, type: 'database', databaseKind: 'sql', text, technology: 'PostgreSQL 16', ...(parentId ? { parentId } : {}), ...at });
  const edge = (id: string, source: string, target: string, semantic: 'calls' | 'writes' | 'http' = 'calls') => createEdge({ id, source, target, semantic, semanticsOrigin: 'explicit' });
  const nodes = [
    group('pay', 'Payments'),
    group('ord', 'Orders'),
    service('web', 'Web App'),
    service('gw', 'Gateway', undefined, { serviceKind: 'gateway' }),
    service('orders', 'Orders API', undefined, { parentId: 'ord', serviceKind: 'api' }),
    service('billing', 'Billing API', undefined, { parentId: 'pay', serviceKind: 'api' }),
    store('paydb', 'Payments DB', 'pay'),
  ];
  const edges = [edge('1', 'web', 'gw', 'http'), edge('2', 'gw', 'orders', 'http'), edge('3', 'web', 'billing', 'http'), edge('4', 'orders', 'paydb', 'writes'), edge('5', 'billing', 'paydb', 'writes'), edge('6', 'billing', 'orders'), edge('7', 'orders', 'billing')];
  const model = modelOf(file(nodes, edges));
  const rule = (input: Record<string, unknown>): Rule => {
    const parsed = parseConfig({ version: 1, rules: [input] });
    if (!parsed.ok) throw new Error(parsed.errors.join(' '));
    return parsed.config.rules[0]!;
  };
  const found = (input: Record<string, unknown>) => assertFindings(model, [rule(input)]).map((entry) => [entry.class, entry.subjects.slice(0, 3)]);

  it('forbid a dependency, directly or at any distance', () => {
    expect(found({ id: 'own-data', type: 'must-not-depend', from: { boundary: 'Orders' }, to: { boundary: 'Payments', kind: 'database' } })).toEqual([['violation', ['orders', 'paydb', '4']]]);
    expect(found({ id: 'far', type: 'must-not-depend', from: { name: 'web*' }, to: { technology: 'postgresql' }, transitive: true })).toEqual([['violation', ['web', 'paydb']]]);
    expect(found({ id: 'fine', type: 'must-not-depend', from: { name: 'Gateway' }, to: { kind: ['database'] } })).toEqual([]);
  });

  it('require a way through, and a single way across a boundary', () => {
    expect(found({ id: 'via-gw', type: 'must-go-through', from: { name: 'Web App' }, to: { kind: 'api' }, via: { kind: 'gateway' } })).toEqual([['violation', ['web', 'billing', '3']]]);
    expect(found({ id: 'edge', type: 'crossing-only-via', boundary: 'Payments', via: { name: 'Billing API' } })).toEqual([['violation', ['orders', 'paydb', '4']]]);
  });

  it('forbid loops and shared stores, and require what a part must carry', () => {
    expect(found({ id: 'acyclic', type: 'no-cycle' })).toEqual([['violation', ['billing', 'orders']]]);
    expect(found({ id: 'one-writer', type: 'no-shared-store' })).toEqual([['violation', ['paydb', 'orders', 'billing']]]);
    expect(found({ id: 'tech', type: 'must-have', of: { kind: 'api' }, require: 'technology' })).toEqual([
      ['violation', ['orders']],
      ['violation', ['billing']],
    ]);
    expect(found({ id: 'tech-db', type: 'must-have', of: { kind: 'database' }, require: 'technology' })).toEqual([]);
  });

  it('say so when a rule matches nothing, rather than passing in silence', () => {
    const empty = assertFindings(model, [rule({ id: 'typo', type: 'must-not-depend', from: { boundary: 'Ordres' }, to: {} })]);
    expect(empty.map((entry) => [entry.class, entry.severity, entry.message])).toEqual([['ambiguous', 'info', 'Rule "typo" checked nothing: no part of the diagram matches its "from".']]);
  });

  it('carry the severity and the reason the person gave', () => {
    const [only] = assertFindings(model, [rule({ id: 'one-writer', type: 'no-shared-store', severity: 'warning', because: 'ADR 12' })]);
    expect(only).toMatchObject({ rule: 'rule/one-writer', severity: 'warning' });
    expect(only!.message).toBe('"Payments DB" is written by "Orders API", "Billing API"; rule "one-writer" allows one writer. (ADR 12)');
  });

  it('refuse a rule file that could be misread', () => {
    const errors = (input: unknown) => {
      const parsed = parseConfig(input);
      return parsed.ok ? [] : parsed.errors;
    };
    expect(errors([])).toHaveLength(1);
    expect(errors({ version: 2 })).toEqual(['"version" must be 1.']);
    expect(errors({ version: 1, rules: [{ id: 'a', type: 'run-script', script: 'rm -rf /' }] })).toEqual(['rules[0].type must be one of: must-not-depend, must-go-through, no-cycle, no-shared-store, crossing-only-via, must-have.']);
    expect(errors({ version: 1, rules: [{ id: 'a', type: 'no-cycle' }, { id: 'a', type: 'no-cycle' }] })).toEqual(['Two rules are called "a".']);
    expect(errors({ version: 1, rules: [{ id: 'a', type: 'no-cycle', among: { regex: '.*' } }] })).toEqual(['rules[0].among has an unknown field "regex".']);
    expect(errors({ version: 1, rules: [{ id: 'a', type: 'must-have', require: 'owner' }] })).toHaveLength(1);
    expect(errors({ version: 1, rules: [{ id: 'a', type: 'no-cycle', severity: 'fatal' }] })).toHaveLength(1);
    expect(errors({ version: 1, waivers: [{ finding: 'abc', reason: 'x' }] })).toHaveLength(1);
    expect(errors({ version: 1, waivers: [{ finding: '0123456789abcdef' }] })).toHaveLength(1);
    expect(errors({ version: 1, waivers: [{ finding: '0123456789abcdef', reason: 'ok', expires: '2027-02-30' }] })).toHaveLength(1);
    expect(errors({ version: 1, extra: true })).toEqual(['Unknown field "extra".']);
    expect(parseConfig({ version: 1 })).toEqual({ ok: true, config: { version: 1, rules: [], waivers: [] } });
  });
});

describe('waivers', () => {
  const make = (rule: string) => finding({ rule, class: 'violation', severity: 'error', subjects: ['a'], message: rule });
  const a = make('rule/a');
  const b = make('rule/b');

  it('set a finding aside with its reason, until the day after they expire', () => {
    const waivers = [{ finding: a.id, reason: 'accepted for the migration', expires: '2027-03-01' }];
    const during = applyWaivers([a, b], waivers, '2027-03-01');
    expect(during.findings).toEqual([b]);
    expect(during.waived).toEqual([{ finding: a, reason: 'accepted for the migration', expires: '2027-03-01' }]);
    const after = applyWaivers([a, b], waivers, '2027-03-02');
    expect(after.waived).toEqual([]);
    expect(after.findings.map((entry) => entry.rule)).toEqual(['rule/a', 'config/expired-waiver', 'rule/b']);
    expect(after.findings[1]).toMatchObject({ severity: 'warning' });
  });

  it('report a waiver for something no longer found', () => {
    const settled = applyWaivers([b], [{ finding: a.id, reason: 'old' }], '2027-01-01');
    expect(settled.findings.map((entry) => [entry.rule, entry.severity])).toEqual([['rule/b', 'error'], ['config/unused-waiver', 'info']]);
  });

  it('are applied by a check, which lists what was waived', async () => {
    const doc = file([service('a', 'A'), service('b', 'B')], [calls('ab', 'a', 'b'), calls('ba', 'b', 'a')]);
    const config = { version: 1 as const, rules: [], waivers: [] as { finding: string; reason: string }[] };
    const plain = await checkDiagram(doc, { config, today: '2027-01-01' });
    expect(rules(plain.findings)).toEqual(['review/call-cycle']);
    config.waivers.push({ finding: plain.findings[0]!.id, reason: 'two halves of one service' });
    const waived = await checkDiagram(doc, { config, today: '2027-01-01' });
    expect(waived.findings).toEqual([]);
    expect(waived.waived).toMatchObject([{ rule: 'review/call-cycle', reason: 'two halves of one service' }]);
    expect(waived.checked.rules).toBe(0);
  });
});

describe('impact in one view', () => {
  const junction = (id: string, link?: string): DraftNode => ({ ...createNode({ id, type: 'ellipse', ...at }), ...(link ? { link } : {}) });
  const inner = [junction('arrive', 'L'), createNode({ id: 'repo', type: 'component', text: 'Repository', ...at })];
  const api: DraftNode = { ...service('api', 'API'), inside: { nodes: inner, edges: [calls('in', 'arrive', 'repo')], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
  const doc = file(
    [service('web', 'Web'), junction('j'), service('orders', 'Orders'), service('stock', 'Stock'), service('other', 'Unrelated'), api, junction('leave', 'L')],
    [calls('1', 'web', 'j'), calls('2', 'j', 'orders'), calls('3', 'orders', 'stock'), calls('4', 'orders', 'leave'), calls('5', 'other', 'api')],
  );

  it('lights what a part reaches and what reaches it, with the Junctions and connectors on the way', () => {
    const scope = impactScope(doc, [], 'orders');
    expect(new Set(scope.nodeIds)).toEqual(new Set(['orders', 'web', 'stock', 'j', 'leave']));
    expect(new Set(scope.edgeIds)).toEqual(new Set(['1', '2', '3', '4']));
    // "Repository" is reached through the linked Junction, in another view.
    expect(scope.elsewhere).toBe(1);
  });

  it('shows the same relation from the other view, and nothing for an id the file does not have', () => {
    const scope = impactScope(doc, ['api'], 'repo');
    expect(new Set(scope.nodeIds)).toEqual(new Set(['repo', 'arrive']));
    expect(scope.edgeIds).toEqual(['in']);
    expect(scope.elsewhere).toBe(2);
    expect(impactScope(doc, [], 'nope')).toEqual({ nodeIds: [], edgeIds: [], elsewhere: 0 });
    expect(impactScope(doc, [], 'other')).toMatchObject({ elsewhere: 0 });
  });
});
