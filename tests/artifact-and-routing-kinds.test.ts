import { beforeEach, describe, expect, it } from 'vitest';
import { baseCategory, capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { relationLabel } from '../src/document/edgeSemantics';
import { convertedNode } from '../src/document/convert';
import { boxForServiceKind, createDocument, createNode, defaultSizeFor, displayNameFor } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { anchorBandOf } from '../src/document/queueGeometry';
import { isLinkable } from '../src/document/sequenceLinks';
import { kindForTechnology } from '../src/document/technologyKind';
import { ARTIFACT_KINDS, CURRENT_VERSION, SERVICE_KINDS } from '../src/document/types';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { CONCEPT_PRESETS, conceptShapes } from '../src/lib/conceptPresets';
import { ALL_PRESETS } from '../src/lib/presets';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { trafficRoleOf } from '../src/traffic/eligibility';

describe('Load Balancer and Proxy', () => {
  it('route the way a Gateway does', () => {
    for (const serviceKind of ['load-balancer', 'proxy'] as const) {
      const category = categoryOf({ type: 'service', serviceKind });
      expect(baseCategory(category)).toBe('gateway');
      expect(capabilityFor(category, 'service')?.defaultRelation).toBe('routes');
      // And everywhere a gateway borrows a service's row, so do they.
      expect(capabilityFor(category, 'queue')).toEqual(capabilityFor('gateway', 'queue'));
      expect(capabilityFor('actor', category)).toEqual(capabilityFor('actor', 'gateway'));
    }
  });

  it('say what each does with a request', () => {
    expect(relationLabel('routes', 'gateway', 'service')).toBe('routes to');
    expect(relationLabel('routes', 'loadBalancer', 'service')).toBe('distributes to');
    expect(relationLabel('routes', 'proxy', 'external')).toBe('forwards to');
    expect(relationLabel('calls', 'proxy', 'service')).toBe('calls');
  });

  it('start named for what they are, at the size their glyph needs', () => {
    const balancer = createNode({ type: 'service', serviceKind: 'load-balancer', x: 0, y: 0 });
    expect(balancer.text).toBe('Load Balancer');
    expect({ width: balancer.width, height: balancer.height }).toEqual(defaultSizeFor('database'));
    expect(createNode({ type: 'service', serviceKind: 'proxy', x: 0, y: 0 }).text).toBe('Proxy');
    // A card kind keeps the card's box.
    expect(createNode({ type: 'service', serviceKind: 'api', x: 0, y: 0 }).width).toBe(defaultSizeFor('service').width);
  });

  it('take connectors on the glyph, not on the empty box around it', () => {
    const balancer = createNode({ type: 'service', serviceKind: 'load-balancer', x: 100, y: 100 });
    const band = anchorBandOf(balancer)!;
    expect(band.left!).toBeGreaterThan(balancer.x);
    expect(band.right!).toBeLessThan(balancer.x + balancer.width);
    expect(band.bottom).toBeLessThan(balancer.y + balancer.height);
    expect(anchorBandOf(createNode({ type: 'service', serviceKind: 'api', x: 0, y: 0 }))).toBeUndefined();
  });

  it('change box when the kind moves between a card and a glyph, around the same centre', () => {
    const card = createNode({ type: 'service', x: 0, y: 0 });
    const box = boxForServiceKind(card, 'generic', 'proxy')!;
    expect({ width: box.width, height: box.height }).toEqual(defaultSizeFor('service', 'proxy'));
    expect(box.x + box.width / 2).toBeCloseTo(card.x + card.width / 2, 0);
    expect(boxForServiceKind(card, 'generic', 'api')).toBeNull();
    expect(boxForServiceKind({ ...card, ...box }, 'proxy', 'load-balancer')).toBeNull();
    expect(boxForServiceKind({ ...card, ...box }, 'proxy', 'worker')).toBeNull();
  });

  it.each([
    ['HAProxy', 'load-balancer'],
    ['Application Load Balancer', 'load-balancer'],
    ['NGINX', 'proxy'],
    ['Envoy', 'proxy'],
    ['Amazon CloudFront', 'proxy'],
    ['Kong', 'gateway'],
  ] as const)('%s is a %s', (technology, serviceKind) => {
    expect(kindForTechnology('service', technology)).toMatchObject({ serviceKind });
  });

  it('draw every kind, at a default box and a small one, with and without replicas', () => {
    const ctx = describeContext(LIGHT);
    for (const serviceKind of SERVICE_KINDS) {
      for (const replicas of [undefined, 3]) {
        const node = { ...createNode({ type: 'service', serviceKind, x: 0, y: 0, text: 'Edge' }), replicas };
        expect(describeNode(node, ctx).shapes.length).toBeGreaterThan(0);
        expect(describeNode({ ...node, width: 96, height: 48 }, ctx).shapes.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Artifact', () => {
  it('is its own category, read by default and never a data store', () => {
    const artifact = createNode({ type: 'artifact', artifactKind: 'config', x: 0, y: 0 });
    expect(baseCategory(categoryOf(artifact))).toBe('artifact');
    expect(capabilityFor(categoryOf(artifact), 'service')).toEqual(capabilityFor('artifact', 'service'));
    expect(capabilityFor('service', 'artifact')?.defaultRelation).toBe('reads');
    // A worker, a gateway and a component reach the same row through `service`.
    expect(capabilityFor('worker', 'artifact')?.defaultRelation).toBe('reads');
    expect(capabilityFor('artifact', 'database')).toBeUndefined();
    // Nothing fails over or backs up at a certificate.
    expect(trafficRoleOf(artifact)).toBe('excluded');
  });

  it.each([
    ['artifact', 'reads', 'reads', 'read by'],
    ['config', 'reads', 'configured by', 'configures'],
    ['config', 'watches', 'reloads on change', 'watched by'],
    ['secret', 'reads', 'authenticates with', 'authenticates'],
    ['secret', 'writes', 'issues', 'issued by'],
    ['certificate', 'reads', 'presents', 'presented by'],
    ['certificate', 'uses', 'trusts', 'trusted by'],
    ['certificate', 'writes', 'issues', 'issued by'],
  ] as const)('a connector to a %s that %s reads "%s", and "%s" drawn from it', (kind, semantic, active, passive) => {
    expect(relationLabel(semantic, 'service', kind)).toBe(active);
    expect(relationLabel(semantic, kind, 'service')).toBe(passive);
  });

  it('starts as a File and is named for its kind', () => {
    expect(createNode({ type: 'artifact', x: 0, y: 0 })).toMatchObject({ artifactKind: 'file', text: 'File', textOrigin: 'auto' });
    for (const artifactKind of ARTIFACT_KINDS) {
      const node = createNode({ type: 'artifact', artifactKind, x: 0, y: 0 });
      expect(displayNameFor({ ...node, text: '' })).toBe(node.text);
    }
  });

  it('carries a description and a technology, and never stands on a lifeline', () => {
    const node = createNode({ type: 'artifact', artifactKind: 'secret', x: 0, y: 0, technology: 'Vault', description: 'Rotated every 90 days.' });
    expect(node).toMatchObject({ technology: 'Vault', description: 'Rotated every 90 days.' });
    expect(isLinkable(node)).toBe(false);
  });

  it('survives a save and a load, kind and all', () => {
    const doc = addNodes(createDocument(), [
      createNode({ id: 'cert', type: 'artifact', artifactKind: 'certificate', x: 0, y: 0, text: 'TLS Certificate' }),
      createNode({ id: 'lb', type: 'service', serviceKind: 'load-balancer', x: 200, y: 0 }),
    ]);
    const read = deserializeDocument(serializeDocument(doc));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.document.version).toBe(CURRENT_VERSION);
    expect(read.document.nodes.find((node) => node.id === 'cert')).toMatchObject({ type: 'artifact', artifactKind: 'certificate' });
    expect(read.document.nodes.find((node) => node.id === 'lb')).toMatchObject({ serviceKind: 'load-balancer' });
  });

  it('reads an unknown kind as a File rather than refusing the shape', () => {
    const text = JSON.stringify({
      ...JSON.parse(serializeDocument(createDocument())),
      nodes: [{ id: 'a', type: 'artifact', x: 0, y: 0, width: 120, height: 104, z: 0, artifactKind: 'scroll' }],
    });
    const read = deserializeDocument(text);
    expect(read.ok && read.document.nodes[0]).toMatchObject({ type: 'artifact', artifactKind: 'file' });
  });

  it('draws every kind', () => {
    const ctx = describeContext(LIGHT);
    for (const artifactKind of ARTIFACT_KINDS) {
      const shapes = describeNode(createNode({ type: 'artifact', artifactKind, x: 0, y: 0, text: 'app.yaml' }), ctx).shapes;
      expect(shapes.some((shape) => shape.t === 'text')).toBe(true);
    }
  });

  it('takes connectors on its sheet', () => {
    const node = createNode({ type: 'artifact', x: 0, y: 0 });
    const band = anchorBandOf(node)!;
    expect(band.right! - band.left!).toBeLessThan(node.width / 2);
  });
});

describe('in the editor', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Store'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('a Service turned into a Proxy takes the glyph box and the kind name; turned back, the card', () => {
    const editor = useEditorStore.getState();
    const node = editor.addNode({ type: 'service', x: 0, y: 0 });
    useEditorStore.getState().updateNodeById(node.id, { serviceKind: 'proxy' });
    let now = useEditorStore.getState().document.nodes.find((n) => n.id === node.id)!;
    expect(now).toMatchObject({ serviceKind: 'proxy', text: 'Proxy', ...defaultSizeFor('service', 'proxy') });
    useEditorStore.getState().updateNodeById(node.id, { serviceKind: 'api' });
    now = useEditorStore.getState().document.nodes.find((n) => n.id === node.id)!;
    expect(now).toMatchObject({ serviceKind: 'api', text: 'API', ...defaultSizeFor('service') });
  });

  it('typing HAProxy onto a Service makes it a Load Balancer, box included', () => {
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0 });
    useEditorStore.getState().setNodeC4Text(node.id, { technology: 'HAProxy' });
    const now = useEditorStore.getState().document.nodes.find((n) => n.id === node.id)!;
    expect(now).toMatchObject({ serviceKind: 'load-balancer', kindOrigin: 'technology' });
    expect(now.height).toBeGreaterThanOrEqual(defaultSizeFor('service', 'load-balancer').height);
  });

  it('an unnamed Artifact follows its kind', () => {
    const node = useEditorStore.getState().addNode({ type: 'artifact', x: 0, y: 0 });
    useEditorStore.getState().updateNodeById(node.id, { artifactKind: 'certificate' });
    expect(useEditorStore.getState().document.nodes.find((n) => n.id === node.id)).toMatchObject({ text: 'Certificate' });
  });

  it('a Queue with HAProxy on it, turned into a Service, is a Load Balancer in a glyph box', () => {
    const queue = createNode({ type: 'queue', x: 0, y: 0, technology: 'HAProxy' });
    expect(convertedNode(queue, 'service')).toMatchObject({ serviceKind: 'load-balancer', ...defaultSizeFor('service', 'load-balancer') });
  });
});

describe('shapes by name', () => {
  const labels = (query: string) => conceptShapes(query).map((preset) => preset.label);

  it.each([
    ['load balancer', 'Load Balancer'],
    ['lb', 'Load Balancer'],
    ['reverse proxy', 'Reverse Proxy'],
    ['rev pro', 'Reverse Proxy'],
    ['egress', 'Forward Proxy'],
    ['cdn', 'CDN'],
    ['sidecar', 'Sidecar'],
    ['config', 'Config'],
    ['yaml', 'Config'],
    ['tls', 'TLS Certificate'],
    ['cert', 'Certificate'],
    ['jwt', 'Token'],
    ['api key', 'API Key'],
    ['pod', 'Pod'],
    ['cache', 'Cache'],
    ['vault', 'Secrets Manager'],
  ])('"%s" finds %s first', (query, label) => {
    expect(labels(query)[0]).toBe(label);
  });

  it('finds nothing for a letter, or for a word nobody uses', () => {
    expect(conceptShapes('l')).toEqual([]);
    expect(conceptShapes('zebra')).toEqual([]);
  });

  it('every entry is an existing shape, a kind it really has, and a name of its own', () => {
    const ids = new Set<string>();
    for (const preset of CONCEPT_PRESETS) {
      expect(ALL_PRESETS.some((base) => base.type === preset.type)).toBe(true);
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      // The kind is one `createNode` keeps, so the file is the one made the long way round.
      const node = createNode({ type: preset.type, x: 0, y: 0, ...preset.start, text: preset.text });
      for (const [field, value] of Object.entries(preset.start ?? {})) expect(node).toMatchObject({ [field]: value });
      if (preset.text) expect(node.text).toBe(preset.label);
    }
  });
});
