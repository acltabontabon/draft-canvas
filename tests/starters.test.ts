import { describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { anchorPoint, laneIndex, routeEdge, rectOf as rectOfNode } from '../src/edges/routing';
import { routingPlan } from '../src/edges/bundles';
import type { DraftNode } from '../src/document/types';
import {
  BOUNDARY_PAD,
  BOUNDARY_HEADER_CAPTION_ONLY,
  BOUNDARY_HEADER_PLAIN_MIN,
  BOUNDARY_TITLE_SUBLINE_Y,
} from '../src/starters/compose';
import { ARCHITECTURE_STARTERS, STARTER_IDS, starterById, starterSize } from '../src/starters';
import { buildStarter, sizeOfSpec } from '../src/starters/build';
import { describeContext, describeNode } from '../src/nodes/describe';
import { LIGHT } from '../src/render/theme/tokens';
import type { Shape } from '../src/render/displayList';
import type { ArchitectureStarter, StarterNodeSpec } from '../src/starters/types';

/**
 * The catalog is authored by hand, which is exactly why it needs a machine to check it: a
 * mistyped coordinate produces a diagram that is subtly wrong rather than obviously broken, and a
 * starter is supposed to be the one thing on the canvas nobody has to tidy up.
 */

const rectOf = (spec: StarterNodeSpec) => ({ x: spec.x, y: spec.y, ...sizeOfSpec(spec) });

function overlaps(a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function ancestors(spec: StarterNodeSpec, byKey: Map<string, StarterNodeSpec>): string[] {
  const chain: string[] = [];
  let parent = spec.parent;
  while (parent) {
    chain.push(parent);
    parent = byKey.get(parent)?.parent;
  }
  return chain;
}

const each = (name: string, run: (starter: ArchitectureStarter) => void) =>
  it.each(ARCHITECTURE_STARTERS.map((starter) => [starter.name, starter] as const))(
    `${name}: %s`,
    (_label, starter) => run(starter),
  );

describe('the starter catalog', () => {
  it('exposes exactly the thirteen declared starters, each reachable by id, architectures then data architectures then patterns', () => {
    expect(ARCHITECTURE_STARTERS.map((starter) => starter.id)).toEqual([...STARTER_IDS]);
    for (const id of STARTER_IDS) expect(starterById(id)?.id).toBe(id);
    const categories = ARCHITECTURE_STARTERS.map((starter) => starter.category);
    expect(categories.lastIndexOf('architecture')).toBeLessThan(categories.indexOf('data'));
    expect(categories.lastIndexOf('data')).toBeLessThan(categories.indexOf('pattern'));
    expect(ARCHITECTURE_STARTERS.filter((s) => s.category === 'data').map((s) => s.id)).toEqual([
      'medallion',
      'kappa',
      'cdc',
    ]);
    expect(ARCHITECTURE_STARTERS.filter((s) => s.category === 'pattern').map((s) => s.id)).toEqual([
      'saga-orchestration',
      'saga-choreography',
      'transactional-outbox',
    ]);
  });

  each('names every connector key once, and every flow step by one of them', (starter) => {
    const keys = starter.edges.flatMap((edge) => (edge.key === undefined ? [] : [edge.key]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const flow of starter.flows ?? []) {
      expect(flow.title.trim()).not.toBe('');
      expect(flow.steps.length).toBeGreaterThan(0);
      for (const step of flow.steps) expect(keys).toContain(step.edgeKey);
      // One connector is one beat of a flow — `addStepToFlow` refuses a repeat too.
      expect(new Set(flow.steps.map((step) => step.edgeKey)).size).toBe(flow.steps.length);
    }
  });

  each('authors only relations the matrix already offers for the pairing', (starter) => {
    const byKey = new Map(starter.nodes.map((spec) => [spec.key, spec]));
    for (const edge of starter.edges) {
      if (edge.semantic === undefined) continue;
      const source = byKey.get(edge.from)!;
      const target = byKey.get(edge.to)!;
      const offered = capabilityFor(categoryOf(source as unknown as DraftNode), categoryOf(target as unknown as DraftNode))?.relations;
      expect(offered, `${starter.name}: ${edge.from} → ${edge.to} authors "${edge.semantic}"`).toContain(edge.semantic);
    }
  });

  each('names itself and describes itself in one line', (starter) => {
    expect(starter.name.trim()).not.toBe('');
    // "Template" is the mental model this feature exists to avoid — a starter is something you
    // immediately change, not something you conform to.
    expect(`${starter.name} ${starter.description}`.toLowerCase()).not.toContain('template');
    expect(starter.description.length).toBeLessThan(60);
    expect(starter.aliases.length).toBeGreaterThan(2);
    expect(new Set(starter.aliases).size).toBe(starter.aliases.length);
    for (const alias of starter.aliases) expect(alias).toBe(alias.toLowerCase().trim());
  });

  each('stays small enough to be a starting point', (starter) => {
    // Boundaries and their quiet annotations (a subtitle, a descriptor under a layer) frame a
    // starter; they aren't things someone has to understand. The cap is on the architectural
    // elements — Hexagonal and Event-Driven sit at eleven — with a looser ceiling on the framing so
    // a starter can't hide bulk in it either: Medallion frames nine elements in three zones.
    const elements = starter.nodes.filter((spec) => spec.type !== 'group' && !(spec.type === 'text' && spec.annotation));
    expect(elements.length).toBeLessThanOrEqual(11);
    expect(starter.nodes.length).toBeLessThanOrEqual(18);
    expect(starter.edges.length).toBeLessThanOrEqual(10);
  });

  each('references only keys it declares', (starter) => {
    const keys = new Set(starter.nodes.map((spec) => spec.key));
    expect(keys.size).toBe(starter.nodes.length);
    const byKey = new Map(starter.nodes.map((spec) => [spec.key, spec]));
    for (const spec of starter.nodes) {
      if (!spec.parent) continue;
      expect(keys).toContain(spec.parent);
      // Only a boundary may contain anything — nothing else renders as a container.
      expect(byKey.get(spec.parent)!.type).toBe('group');
      expect(ancestors(spec, byKey)).not.toContain(spec.key);
    }
    for (const edge of starter.edges) {
      expect(keys).toContain(edge.from);
      expect(keys).toContain(edge.to);
      expect(edge.from).not.toBe(edge.to);
    }
  });

  each('never overlaps two elements that do not contain each other', (starter) => {
    const byKey = new Map(starter.nodes.map((spec) => [spec.key, spec]));
    for (const a of starter.nodes) {
      for (const b of starter.nodes) {
        if (a.key >= b.key) continue;
        if (ancestors(a, byKey).includes(b.key) || ancestors(b, byKey).includes(a.key)) continue;
        expect(
          overlaps(rectOf(a), rectOf(b)),
          `${starter.name}: "${a.key}" overlaps "${b.key}"`,
        ).toBe(false);
      }
    }
  });

  each('keeps every child inside its boundary, clear of the boundary caption', (starter) => {
    const byKey = new Map(starter.nodes.map((spec) => [spec.key, spec]));
    for (const spec of starter.nodes) {
      if (!spec.parent) continue;
      // A boundary-header subtitle (Hexagonal's, BFF's, CQRS's) is a deliberate, narrow exception: it's
      // authored as the second line of the boundary's own header (`compose.ts`'s
      // `BOUNDARY_TITLE_INSET`/`BOUNDARY_TITLE_SUBLINE_Y`), sharing the title's own left edge and
      // sitting exactly as close beneath it as the title's own metrics allow — not an ordinary
      // piece of content held to the general child-inset floor below.
      if (spec.type === 'text' && spec.annotation && spec.y === byKey.get(spec.parent)!.y + BOUNDARY_TITLE_SUBLINE_Y) continue;
      const child = rectOf(spec);
      const parent = rectOf(byKey.get(spec.parent)!);
      expect(child.x - parent.x).toBeGreaterThanOrEqual(BOUNDARY_PAD);
      expect(parent.x + parent.width - (child.x + child.width)).toBeGreaterThanOrEqual(BOUNDARY_PAD);
      expect(parent.y + parent.height - (child.y + child.height)).toBeGreaterThanOrEqual(BOUNDARY_PAD);
      // The header row (marker, title, kind caption — and Deployment's rule under them) is drawn
      // inside the top edge — see `nodes/describe.ts`. A generic boundary's header is its title alone.
      const header =
        (byKey.get(spec.parent)!.boundaryPreset ?? 'boundary') === 'boundary'
          ? BOUNDARY_HEADER_PLAIN_MIN
          : BOUNDARY_HEADER_CAPTION_ONLY;
      expect(child.y - parent.y).toBeGreaterThanOrEqual(header);
    }
  });
});

describe('buildStarter', () => {
  /**
   * A node's box is invisible, so a caption that outgrows it goes unnoticed until something is
   * drawn underneath — which is how the `table` card's kind label ended up printed over Medallion's
   * layer descriptors, while the same overflow in Kappa and Outbox sat in empty space and looked
   * fine. Checking the drawn text rather than the authored rectangle is the only way to see it.
   */
  each('gives every node room for the caption it actually draws', (starter) => {
    const ctx = describeContext(LIGHT);
    const flatten = (shapes: readonly Shape[]): Shape[] =>
      shapes.flatMap((shape) => (shape.t === 'group' ? flatten(shape.children) : [shape]));
    for (const node of buildStarter(starter, { x: 0, y: 0 }).nodes) {
      // A boundary's own caption is drawn inside its top edge, not stacked under a glyph.
      if (node.type === 'group') continue;
      const texts = flatten(describeNode(node, ctx).shapes).filter(
        (shape): shape is Extract<Shape, { t: 'text' }> => shape.t === 'text',
      );
      if (texts.length === 0) continue;
      const bottom = Math.max(...texts.map((text) => text.y + text.layout.height));
      expect(
        bottom - node.height,
        `${starter.name}: "${node.text ?? node.type}" draws ${(bottom - node.height).toFixed(1)}px past its box`,
      ).toBeLessThanOrEqual(0.5);
    }
  });

  each('lands its bounding box exactly on the requested origin', (starter) => {
    const origin = { x: 1200, y: -340 };
    const { nodes } = buildStarter(starter, origin);
    expect(Math.min(...nodes.map((node) => node.x))).toBe(origin.x);
    expect(Math.min(...nodes.map((node) => node.y))).toBe(origin.y);
    const size = starterSize(starter);
    expect(Math.max(...nodes.map((node) => node.x + node.width))).toBe(origin.x + size.width);
    expect(Math.max(...nodes.map((node) => node.y + node.height))).toBe(origin.y + size.height);
  });

  each('is deterministic in everything but identity', (starter) => {
    // Attachment ids are minted per build too — compare their content, not their identity.
    const geometry = (nodes: DraftNode[]) =>
      nodes.map(({ id: _id, parentId: _parentId, attachments, ...rest }) => ({
        ...rest,
        attachments: attachments?.map(({ id: _attachmentId, ...attachment }) => attachment),
      }));
    const first = buildStarter(starter, { x: 0, y: 0 });
    const second = buildStarter(starter, { x: 0, y: 0 });
    expect(geometry(second.nodes)).toEqual(geometry(first.nodes));
    expect(first.nodes.map((node) => node.id)).not.toEqual(second.nodes.map((node) => node.id));
  });

  each('resolves parentage to real ids and puts boundaries behind their contents', (starter) => {
    const { nodes } = buildStarter(starter, { x: 0, y: 0 });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (!node.parentId) continue;
      const parent = byId.get(node.parentId);
      expect(parent).toBeDefined();
      expect(parent!.type).toBe('group');
      expect(parent!.z).toBeLessThan(node.z);
    }
  });

  each('takes every relationship from the capability matrix, never from the catalog', (starter) => {
    const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(edges).toHaveLength(starter.edges.length);
    edges.forEach((edge, index) => {
      const capability = capabilityFor(
        categoryOf(byId.get(edge.source)!),
        categoryOf(byId.get(edge.target)!),
      );
      const authored = starter.edges[index]!.semantic;
      if (authored !== undefined) {
        // An authored relation is one the matrix offers for the pairing, stamped the way the
        // inspector stamps a user's own pick — so it survives a later re-inference, as it should.
        expect(capability?.relations).toContain(authored);
        expect(edge.semantic).toBe(authored);
        expect(edge.semanticsOrigin).toBe('explicit');
      } else {
        expect(edge.semantic).toBe(capability?.defaultRelation);
        // Inferred, not explicit: changing a node's kind afterwards must re-derive these, exactly as
        // it does for a connector the user drew by hand (`isEligibleForReinference`).
        expect(edge.semanticsOrigin).toBe(capability?.defaultRelation ? 'inferred' : undefined);
      }
      expect(edge.kind).toBe(capability?.defaultBehavior);
      // A starter never doubles its own arrow count with reply lines. `routeMode` is deliberately
      // not checked here — like `label`/`condition`, it's an authored escape hatch (opting a
      // connector out of Smart Routing's bundling) that changes nothing about the *derived*
      // semantic/kind asserted above.
      expect(edge.async).toBe(capability?.defaultAsync || undefined);
      expect(edge.hasResponse).toBeUndefined();
    });
  });

  it('models microservices as an optional gateway over three capabilities, each its own deployment owning its own store', () => {
    const { nodes, edges, flows } = buildStarter(starterById('microservices')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(14);
    expect(edges).toHaveLength(8);
    expect(nodes.filter((n) => n.type === 'text')).toHaveLength(0);

    // The client is software, not a person.
    expect(byText('Client')).toMatchObject({ type: 'actor', actorKind: 'system' });

    // One optional entry point: the gateway routes to every API service — no made-up path rules on
    // the branches — and its note says a gateway is optional.
    const gateway = nodes.find((node) => node.serviceKind === 'gateway')!;
    expect(gateway.attachments?.[0]?.text).toMatch(/Optional/);
    const routes = edges.filter((edge) => edge.source === gateway.id);
    expect(routes).toHaveLength(3);
    expect(routes.map((edge) => edge.semantic)).toEqual(['routes', 'routes', 'routes']);
    expect(edges.every((edge) => edge.condition === undefined)).toBe(true);
    // All three leave the same point, so Smart Routing can draw them as one trunk.
    expect(new Set(routes.map((edge) => JSON.stringify(edge.sourceAnchor))).size).toBe(1);
    const services = nodes.filter((node) => node.serviceKind === 'api');
    expect(services.map((node) => node.text)).toEqual(['Capability A Service', 'Capability B Service', 'Capability C Service']);
    expect(new Set(routes.map((edge) => edge.target))).toEqual(new Set(services.map((node) => node.id)));

    // Two boundaries per capability, distinct in kind: an ownership boundary (logical) holding the
    // service and its store, and a deployment boundary inside it holding the service alone — the
    // store is never inside the deployment.
    const owners = nodes.filter((node) => node.type === 'group' && node.boundaryPreset === 'boundary');
    const deployments = nodes.filter((node) => node.boundaryPreset === 'deployment');
    expect(owners.map((node) => node.text)).toEqual(['Capability A', 'Capability B', 'Capability C']);
    expect(deployments).toHaveLength(3);
    const stores = nodes.filter((node) => node.type === 'database');
    expect(stores).toHaveLength(3);
    services.forEach((service, index) => {
      const deployment = nodes.find((node) => node.id === service.parentId)!;
      expect(deployment.boundaryPreset).toBe('deployment');
      expect(deployment.parentId).toBe(owners[index]!.id);
      expect(nodes.filter((node) => node.parentId === deployment.id)).toEqual([service]);
      const store = stores[index]!;
      expect(store.parentId).toBe(owners[index]!.id);
      expect(store.databaseKind).toBe('generic');
      expect(overlaps(store, deployment)).toBe(false);
      // Each store is written by exactly one service — its own — with the shared persistence caption.
      const writers = edges.filter((edge) => edge.target === store.id);
      expect(writers).toHaveLength(1);
      expect(writers[0]).toMatchObject({ source: service.id, semantic: 'writes', label: 'reads / writes' });
    });
    expect(stores[0]!.attachments?.[0]?.text).toMatch(/separate server is not required/);

    // Exactly one service-to-service interaction: a synchronous call through C's API, never its
    // store — and no store is ever reached from another capability.
    const serviceIds = new Set(services.map((node) => node.id));
    const between = edges.filter((edge) => serviceIds.has(edge.source) && serviceIds.has(edge.target));
    expect(between).toHaveLength(1);
    expect(between[0]).toMatchObject({ source: byText('Capability B Service').id, target: byText('Capability C Service').id, semantic: 'calls' });
    expect(between[0]!.async).toBeUndefined();
    expect(between[0]!.attachments?.[0]?.text).toMatch(/never its store/);
    expect(nodes.some((node) => node.type === 'queue')).toBe(false);

    // Nothing domain-specific anywhere.
    for (const text of nodes.flatMap((node) => [node.text ?? '', ...(node.attachments ?? []).map((a) => a.text ?? '')])) {
      expect(text).not.toMatch(/order|payment|account|customer/i);
    }
    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Handle a request', 3],
      ['Call another service', 4],
    ]);
  });

  it('models the modular monolith as one deployment holding three modules over one shared database of module-owned tables', () => {
    const { nodes, edges, flows } = buildStarter(starterById('modular-monolith')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const boundaries = nodes.filter((node) => node.type === 'group');
    expect(boundaries.map((node) => [node.text, node.boundaryPreset])).toEqual([
      ['Application', 'deployment'],
      ['Shared Database', 'boundary'],
    ]);
    const [app, database] = boundaries as [DraftNode, DraftNode];
    expect(nodes.filter((node) => node.type === 'text')).toHaveLength(0);
    expect(byText('Client')).toMatchObject({ type: 'actor', actorKind: 'system' });

    // Three peer modules, neutrally named, all inside the one deployment — no Service anywhere.
    const modules = nodes.filter((node) => node.componentKind === 'module');
    expect(modules.map((node) => node.text)).toEqual(['Capability A', 'Capability B', 'Capability C']);
    for (const module of modules) expect(module.parentId).toBe(app.id);
    expect(nodes.some((node) => node.type === 'service')).toBe(false);
    const api = byText('Application API');
    expect(api).toMatchObject({ type: 'component', componentKind: 'adapter', parentId: app.id });
    for (const module of modules) expect(edges.some((e) => e.source === api.id && e.target === module.id)).toBe(true);

    // Exactly one edge among the modules — a controlled, explicit dependency captioned as what it
    // is: an in-process call on a public interface, never HTTP, never another module's internals.
    const moduleIds = new Set(modules.map((node) => node.id));
    const moduleEdges = edges.filter((edge) => moduleIds.has(edge.source) && moduleIds.has(edge.target));
    expect(moduleEdges).toHaveLength(1);
    expect(moduleEdges[0]).toMatchObject({ source: byText('Capability B').id, target: byText('Capability C').id, semantic: 'uses', label: 'in-process public interface' });

    // One shared database: a logical boundary (not a deployment) holding one table per module,
    // each written only by its own module, straight down its own column — so which module owns
    // which data is on the canvas, without three database servers.
    expect(database.parentId).toBeUndefined();
    expect(database.y).toBeGreaterThan(app.y + app.height);
    const tables = nodes.filter((node) => node.type === 'database');
    expect(tables.map((node) => [node.text, node.databaseKind, node.parentId])).toEqual([
      ['Capability A Tables', 'table', database.id],
      ['Capability B Tables', 'table', database.id],
      ['Capability C Tables', 'table', database.id],
    ]);
    modules.forEach((module, index) => {
      const table = tables[index]!;
      expect(table.x + table.width / 2).toBe(module.x + module.width / 2);
      const writers = edges.filter((edge) => edge.target === table.id);
      expect(writers).toHaveLength(1);
      expect(writers[0]).toMatchObject({ source: module.id, semantic: 'writes', label: 'reads / writes' });
    });
    expect(database.attachments?.[0]?.text).toMatch(/one schema per module/i);
    expect(app.attachments?.[0]?.text).toMatch(/build time/);

    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Handle a request', 3],
      ['Collaborate across modules', 4],
    ]);
  });

  it('models the monolith as one deployment boundary holding three layered components over one outside store', () => {
    const { nodes, edges } = buildStarter(starterById('monolith')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(7);
    expect(edges).toHaveLength(5);
    expect(nodes.filter((node) => node.type === 'text')).toHaveLength(0);
    expect(byText('Client')).toMatchObject({ type: 'actor', actorKind: 'system' });

    const app = nodes.find((node) => node.type === 'group')!;
    expect(app.boundaryPreset).toBe('deployment');
    const layers = ['API', 'Application Logic', 'Data Access'].map(byText);
    for (const layer of layers) {
      expect(layer.type).toBe('component');
      expect(layer.parentId).toBe(app.id);
    }
    expect(layers.map((layer) => layer.componentKind)).toEqual(['adapter', 'generic', 'adapter']);
    // Stacked top to bottom on one axis, and nothing inside the boundary is a Service.
    expect(new Set(layers.map((layer) => layer.x + layer.width / 2)).size).toBe(1);
    expect(layers[0]!.y).toBeLessThan(layers[1]!.y);
    expect(layers[1]!.y).toBeLessThan(layers[2]!.y);
    expect(nodes.filter((node) => node.parentId === app.id)).toHaveLength(3);
    expect(nodes.some((node) => node.type === 'service' && node.parentId === app.id)).toBe(false);

    // The store is generic, outside, below; the external system is outside, level with the logic.
    const database = byText('Application Database');
    expect(database).toMatchObject({ type: 'database', databaseKind: 'generic' });
    expect(database.parentId).toBeUndefined();
    expect(database.y).toBeGreaterThan(app.y + app.height);
    const external = byText('External System');
    expect(external).toMatchObject({ type: 'service', serviceKind: 'external' });
    expect(external.x).toBeGreaterThan(app.x + app.width);
    const logic = byText('Application Logic');
    expect(external.y + external.height / 2).toBe(logic.y + logic.height / 2);

    const edgeBetween = (fromText: string, toText: string) =>
      edges.find((e) => e.source === byText(fromText).id && e.target === byText(toText).id)!;
    for (const [fromText, toText, semantic, label] of [
      ['Client', 'API', 'calls', undefined],
      ['API', 'Application Logic', 'uses', undefined],
      ['Application Logic', 'Data Access', 'uses', undefined],
      ['Data Access', 'Application Database', 'writes', 'reads / writes'],
      ['Application Logic', 'External System', 'calls', undefined],
    ] as const) {
      const edge = edgeBetween(fromText, toText);
      expect(edge, `${fromText} → ${toText}`).toBeDefined();
      expect(edge.semantic).toBe(semantic);
      expect(edge.label).toBe(label);
      expect(edge.condition).toBeUndefined();
    }

    // Two notes: what "one unit" means (and what it doesn't require), and that the store is a
    // separate runtime resource.
    expect(app.attachments).toHaveLength(1);
    expect(app.attachments![0]!.text).toMatch(/not a requirement/);
    expect(database.attachments).toHaveLength(1);
    expect(nodes.flatMap((node) => node.attachments ?? [])).toHaveLength(2);
  });

  it('models event-driven flow as one producer, a topic fanning out to two named subscriber queues, and one illustrative failure route', () => {
    const { nodes, edges, flows } = buildStarter(starterById('event-driven')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const edgesFrom = (id: string) => edges.filter((e) => e.source === id);
    const edgesTo = (id: string) => edges.filter((e) => e.target === id);

    const producer = byText('Producer Service');
    const topic = byText('Domain Events');
    const queues = [byText('Projection Queue'), byText('Integration Queue')];
    const workers = [byText('Projection Worker'), byText('Integration Worker')];
    const store = byText('Read Store');
    const external = byText('External System');
    const dlq = nodes.find((n) => n.deliveryRole === 'dead-letter')!;

    // Nine elements, eight connections, no free-floating text, no boundary, no junction.
    expect(nodes).toHaveLength(9);
    expect(edges).toHaveLength(8);
    expect(nodes.filter((n) => n.type === 'text' || n.type === 'group' || n.type === 'ellipse')).toHaveLength(0);
    expect(nodes.filter((n) => n.queueKind === 'topic')).toEqual([topic]);
    // Subscriptions are named for their responsibility — never two interchangeable QUEUEs.
    expect(nodes.filter((n) => n.type === 'queue' && n.queueKind === 'queue' && !n.deliveryRole)).toEqual(queues);

    // The producer publishes exactly once, to the topic, and names a state-change event rather than
    // a business one; the envelope and the delivery caveats ride the connector.
    expect(edgesFrom(producer.id)).toHaveLength(1);
    const published = edgesTo(topic.id);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ source: producer.id, semantic: 'publishes', kind: 'event', label: 'publishes state-change event' });
    expect(published[0]!.attachments?.map((a) => a.type)).toEqual(['code', 'note']);
    expect(published[0]!.attachments![0]!.code).toContain('"type": "StateChanged"');
    expect(published[0]!.attachments![1]!.text).toMatch(/at-least-once/i);
    expect(topic.attachments?.[0]?.text).toMatch(/own copy/);

    // The topic fans out to each queue — inferred, unoverridden, and bundle-eligible (one trunk).
    const fanned = edgesFrom(topic.id);
    expect(fanned).toHaveLength(2);
    expect(new Set(fanned.map((e) => e.target))).toEqual(new Set(queues.map((q) => q.id)));
    for (const edge of fanned) {
      expect(edge.semantic).toBe('fansOut');
      expect(edge.kind).toBe('event');
      expect(edge.label).toBeUndefined();
      expect(edge.routeMode).toBeUndefined();
      expect(edge.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
      expect(edge.targetAnchor).toEqual({ side: 'top', offset: 0.5 });
    }

    // Every consumer is a Worker fed by exactly one queue of its own, directly above it — the
    // producer never reaches a consumer directly.
    workers.forEach((worker, index) => {
      expect(worker.serviceKind).toBe('worker');
      const consumes = edgesTo(worker.id);
      expect(consumes).toHaveLength(1);
      expect(consumes[0]).toMatchObject({ source: queues[index]!.id, semantic: 'consumes', kind: 'event' });
      expect(queues[index]!.x + queues[index]!.width / 2).toBe(worker.x + worker.width / 2);
      expect(queues[index]!.y + queues[index]!.height).toBeLessThan(worker.y);
    });
    expect(edges.some((e) => e.source === producer.id && workers.some((w) => w.id === e.target))).toBe(false);

    // Projection owns the only store; Integration calls the only external system (a synchronous,
    // solid call — the one non-event line).
    expect(nodes.filter((n) => n.type === 'database')).toEqual([store]);
    expect(edgesFrom(workers[0]!.id).map((e) => [e.target, e.semantic])).toEqual([[store.id, 'writes']]);
    expect(external.serviceKind).toBe('external');
    expect(edgesFrom(workers[1]!.id).map((e) => [e.target, e.semantic, e.kind, e.async])).toEqual([[external.id, 'calls', undefined, undefined]]);

    // One DLQ, beside the Integration queue only, on a dashed, inferred dead-letter route captioned
    // as a policy rather than a count, and named an illustrative path.
    const deadLetters = edgesTo(dlq.id);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({ source: queues[1]!.id, semantic: 'deadLetters', kind: 'failure', async: true, semanticsOrigin: 'inferred', label: 'after configured retry limit' });
    expect(deadLetters[0]!.deliveryAttempts).toBeUndefined();
    expect(deadLetters[0]!.attachments?.[0]?.text).toMatch(/illustrative/i);
    expect(dlq.x).toBeGreaterThan(queues[1]!.x + queues[1]!.width);
    expect(edgesFrom(dlq.id)).toHaveLength(0);
    // The DLQ is the only node right of the two lanes — never mistakable for a third consumer.
    expect(nodes.filter((n) => n.x >= dlq.x)).toEqual([dlq]);

    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Update a projection', 4],
      ['Reach an external system', 4],
      ['Handle a failed delivery', 2],
    ]);
  });

  it('keeps hexagonal technology outside the core, and routes every crossing through a port the core owns', () => {
    const { nodes, edges } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const core = nodes.find((node) => node.type === 'group')!;
    const inside = new Set(nodes.filter((node) => node.parentId === core.id).map((node) => node.id));
    const ports = nodes.filter((node) => node.componentKind === 'port');
    const portIds = new Set(ports.map((port) => port.id));

    expect(nodes).toHaveLength(13);
    expect(edges).toHaveLength(10);
    expect(nodes.filter((node) => node.type === 'group')).toEqual([core]);

    // The core owns its contracts: all three ports live inside it. Everything infrastructural —
    // adapters on both sides, the store, the external system — lives outside it.
    expect(ports).toHaveLength(3);
    for (const port of ports) expect(inside.has(port.id)).toBe(true);
    for (const node of nodes) {
      if (inside.has(node.id) || node.id === core.id) continue;
      expect(overlaps(node, core)).toBe(false);
    }
    const database = nodes.find((node) => node.type === 'database')!;
    expect(nodes.filter((node) => node.type === 'database')).toEqual([database]);
    expect(database.databaseKind).toBe('generic');
    expect(nodes.filter((node) => node.serviceKind === 'external')).toHaveLength(1);

    // Every connector crossing the boundary meets a port on the inside — nothing outside ever
    // touches Use Cases or the Domain Model directly, in either direction.
    const crossingIn = edges.filter((edge) => inside.has(edge.target) && !inside.has(edge.source));
    const crossingOut = edges.filter((edge) => inside.has(edge.source) && !inside.has(edge.target));
    expect(crossingIn).toHaveLength(4);
    for (const edge of crossingIn) expect(portIds.has(edge.target)).toBe(true);
    expect(crossingOut).toHaveLength(0);

    // One shared inbound port (both driving adapters call the same use cases), and each port has
    // exactly one implementer arriving at it.
    const inboundPort = nodes.find((node) => node.text === 'Inbound')!;
    expect(crossingIn.filter((edge) => edge.semantic === 'calls').every((edge) => edge.target === inboundPort.id)).toBe(true);
    for (const port of ports) {
      expect(edges.filter((edge) => edge.target === port.id && edge.semantic === 'implements')).toHaveLength(1);
      expect(edges.filter((edge) => edge.source === port.id)).toHaveLength(0);
    }
  });

  it('gives every piece the kind that is true of it: Adapters translate, Components work, Ports promise', () => {
    const { nodes, edges } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const core = nodes.find((node) => node.type === 'group')!;

    // Adapters on both sides of the core, the same kind facing opposite ways.
    for (const name of ['HTTP Adapter', 'Message Consumer', 'Persistence Adapter', 'Integration Adapter']) {
      expect(byText(name)).toMatchObject({ type: 'component', componentKind: 'adapter' });
      expect(byText(name).parentId).toBeUndefined();
    }
    expect(byText('Use Cases')).toMatchObject({ type: 'component', componentKind: 'generic', parentId: core.id });
    expect(byText('Domain Model')).toMatchObject({ type: 'component', componentKind: 'generic', parentId: core.id });
    for (const name of ['Inbound', 'Persistence', 'Integration']) {
      expect(byText(name)).toMatchObject({ type: 'component', componentKind: 'port', parentId: core.id });
    }
    expect(byText('External System')).toMatchObject({ type: 'service', serviceKind: 'external' });
    // The one Service on the canvas is the external system; the application itself is components.
    expect(nodes.filter((n) => n.type === 'service')).toEqual([byText('External System')]);

    // The one annotation is the core's own subtitle — never a floating label, never a Condition.
    const labels = nodes.filter((n) => n.type === 'text');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ text: 'Dependencies point inward', annotation: true, parentId: core.id });
    expect(edges.every((e) => e.condition === undefined)).toBe(true);
    expect(core.attachments?.[0]?.text).toMatch(/hollow/);
  });

  // Runtime reads left to right with solid heads; the three realizations point the other way —
  // from each implementer back into the port it satisfies — which is the way the source dependency
  // points. "Dependencies point inward" is drawn, not just captioned.
  it('draws runtime calls left to right and every implementation arrow back into the core', () => {
    const { nodes, edges, flows } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const edgeBetween = (fromText: string, toText: string) => {
      const from = byText(fromText).id;
      const to = byText(toText).id;
      return edges.find((e) => e.source === from && e.target === to)!;
    };

    const expected: Array<[string, string, string, 'explicit' | 'inferred']> = [
      ['HTTP Adapter', 'Inbound', 'calls', 'explicit'],
      ['Message Consumer', 'Inbound', 'calls', 'explicit'],
      ['Use Cases', 'Inbound', 'implements', 'explicit'],
      ['Use Cases', 'Domain Model', 'uses', 'inferred'],
      ['Use Cases', 'Persistence', 'uses', 'inferred'],
      ['Use Cases', 'Integration', 'uses', 'inferred'],
      ['Persistence Adapter', 'Persistence', 'implements', 'explicit'],
      ['Integration Adapter', 'Integration', 'implements', 'explicit'],
      ['Persistence Adapter', 'Database', 'writes', 'inferred'],
      ['Integration Adapter', 'External System', 'calls', 'inferred'],
    ];
    for (const [fromText, toText, semantic, origin] of expected) {
      const edge = edgeBetween(fromText, toText);
      expect(edge, `${fromText} → ${toText}`).toBeDefined();
      expect(edge.semantic, `${fromText} → ${toText}`).toBe(semantic);
      expect(edge.semanticsOrigin).toBe(origin);
      expect(edge.condition).toBeUndefined();
    }
    // Nothing is drawn from a port outward, and nothing is captioned the old way round.
    expect(edges.some((edge) => edge.semantic === 'implementedBy')).toBe(false);
    // A realization is a level line from the implementer's left edge back into the port's right.
    for (const edge of edges.filter((edge) => edge.semantic === 'implements')) {
      expect(edge.sourceAnchor).toEqual({ side: 'left', offset: 0.5 });
      expect(edge.targetAnchor).toEqual({ side: 'right', offset: 0.5 });
    }

    // The funnel shares one point on the inbound port; the fork shares one point on Use Cases —
    // that's what lets Smart Routing draw each as one trunk with one collapsed caption.
    expect(edgeBetween('HTTP Adapter', 'Inbound').targetAnchor).toEqual(edgeBetween('Message Consumer', 'Inbound').targetAnchor);
    expect(edgeBetween('Use Cases', 'Persistence').sourceAnchor).toEqual(edgeBetween('Use Cases', 'Integration').sourceAnchor);

    // Presentation walks runtime only: no flow steps across a realization.
    const realizations = new Set(edges.filter((edge) => edge.semantic === 'implements').map((edge) => edge.id));
    expect(flows).toHaveLength(2);
    for (const flow of flows) for (const step of flow.steps) expect(realizations.has(step.edgeId!)).toBe(false);
  });

  // The visual-hierarchy point of the whole Component primitive: in a starter that mixes both,
  // every Service (the runtime/external participants) must out-size every Component (the internal
  // application pieces) on both dimensions — "outside → internal → outside" has to read from
  // size alone, before anyone reads a single label.
  it('keeps every Service larger than every Component on both dimensions — the hierarchy holds inside the starter', () => {
    const { nodes } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const services = nodes.filter((n) => n.type === 'service');
    const components = nodes.filter((n) => n.type === 'component');
    expect(services.length).toBeGreaterThan(0);
    expect(components.length).toBeGreaterThan(0);
    const smallestService = { width: Math.min(...services.map((n) => n.width)), height: Math.min(...services.map((n) => n.height)) };
    for (const component of components) {
      expect(component.width).toBeLessThan(smallestService.width);
      expect(component.height).toBeLessThanOrEqual(smallestService.height);
    }
  });

  it('models BFF as one tailored adapter per client experience over shared backend capabilities', () => {
    const { nodes, edges, flows } = buildStarter(starterById('bff')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(13);
    expect(edges).toHaveLength(7);
    // Two flows: one per client experience, matching the tailored fan each adapter draws.
    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Web request', 4],
      ['Mobile request', 3],
    ]);

    // A browser and a phone — software clients, never people.
    expect(byText('Web Client')).toMatchObject({ type: 'actor', actorKind: 'system' });
    expect(byText('Mobile Client')).toMatchObject({ type: 'actor', actorKind: 'device' });

    // Two BFFs, both plain `api`-kind services (never `gateway`), each inside its own experience
    // boundary with its own client, each saying what it tailors — and no gateway anywhere.
    expect(nodes.some((node) => node.serviceKind === 'gateway')).toBe(false);
    const adapters = [byText('Web BFF'), byText('Mobile BFF')];
    expect(adapters.every((node) => node.serviceKind === 'api')).toBe(true);
    expect(adapters.map((node) => node.description)).toEqual(['Composes page data', 'Tailors compact responses']);
    expect(new Set(adapters.map((node) => node.parentId)).size).toBe(2);
    const shared = byText('Shared backend capabilities');
    expect(shared.boundaryPreset).toBe('boundary');
    for (const adapter of adapters) {
      const client = nodes.find((node) => node.type === 'actor' && node.parentId === adapter.parentId)!;
      expect(edges.filter((edge) => edge.source === client.id).map((edge) => edge.target)).toEqual([adapter.id]);
      // Every connector leaving an adapter *calls* into the shared capabilities — a BFF composes, it
      // never routes — and never reaches another adapter.
      for (const edge of edges.filter((edge) => edge.source === adapter.id)) {
        expect(edge.semantic).toBe('calls');
        expect(nodes.find((node) => node.id === edge.target)!.parentId).toBe(shared.id);
      }
    }
    // Tailored, not uniform: the web experience uses one more capability than mobile does.
    expect(edges.filter((edge) => edge.source === byText('Web BFF').id)).toHaveLength(3);
    expect(edges.filter((edge) => edge.source === byText('Mobile BFF').id)).toHaveLength(2);
    // Every boundary says who owns it — that ownership is why a BFF may be tailored — and the
    // shared one says where the rules live. All three are logical groupings, none a deployment.
    const subtitles = nodes.filter((node) => node.type === 'text' && node.annotation).map((node) => node.text);
    expect(subtitles).toEqual(['Owned by the web team', 'Business rules live here', 'Owned by the mobile team']);
    expect(nodes.filter((node) => node.type === 'group').every((node) => node.boundaryPreset === 'boundary')).toBe(true);
    // Shared capabilities are neutral, independent of each other, and nothing here is asynchronous.
    const capabilities = nodes.filter((node) => node.parentId === shared.id && node.type === 'service');
    expect(capabilities.map((node) => node.text)).toEqual(['Capability A Service', 'Capability B Service', 'Capability C Service']);
    for (const edge of edges) {
      expect(capabilities.some((node) => node.id === edge.source)).toBe(false);
      expect(edge.async).toBeUndefined();
      expect(edge.kind === undefined || edge.kind === 'sync').toBe(true);
    }
  });

  it('models CQRS as intent in, questions answered from a projection, with an outbox relay and a topic as the only bridge', () => {
    const { nodes, edges, flows } = buildStarter(starterById('cqrs')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const between = (from: string, to: string) =>
      edges.find((edge) => edge.source === byText(from).id && edge.target === byText(to).id)!;
    expect(nodes).toHaveLength(14);
    expect(edges).toHaveLength(9);
    expect(byText('Client')).toMatchObject({ type: 'actor', actorKind: 'system' });

    // Commands express intent; queries never mutate — said by the relationship words themselves.
    expect(between('Client', 'Command API').semantic).toBe('command');
    // Handling a command is *executing* it — not a second "command" caption in a row.
    expect(between('Command API', 'Command Handler')).toMatchObject({ semantic: 'command', label: 'executes' });
    expect(byText('Command Handler').type).toBe('component');
    expect(between('Client', 'Query API').semantic).toBe('query');
    expect(between('Query API', 'Read Store').semantic).toBe('reads');
    // State and the outbox record commit together; nothing publishes from inside the transaction.
    expect(between('Command Handler', 'Write Store')).toMatchObject({ semantic: 'writes', label: 'writes state + outbox record' });
    expect(between('Command Handler', 'Write Store').attachments).toBeUndefined();
    // The relay — a worker, never the handler or a model object — reads committed records and
    // publishes; the topic carries facts and is not an event store.
    expect(byText('Outbox Relay').serviceKind).toBe('worker');
    expect(between('Outbox Relay', 'Write Store')).toMatchObject({ semantic: 'reads', semanticsOrigin: 'explicit', label: 'reads outbox' });
    expect(between('Outbox Relay', 'Write Store').attachments).toBeUndefined();
    expect(between('Outbox Relay', 'Domain Events')).toMatchObject({ semantic: 'publishes', kind: 'event' });
    expect(between('Outbox Relay', 'Domain Events').attachments?.[0]?.text).toMatch(/one transaction/);
    expect(edges.some((edge) => edge.source === byText('Command Handler').id && edge.target === byText('Domain Events').id)).toBe(false);
    expect(byText('Domain Events').queueKind).toBe('topic');
    expect(byText('Domain Events').attachments).toBeUndefined();
    expect(byText('Command side').attachments?.[0]?.text).toMatch(/not an event store/);
    expect(nodes.filter((node) => node.type === 'database').map((node) => node.text).sort()).toEqual(['Read Store', 'Write Store']);
    // Only the projection writes the read store; the query API only reads it.
    expect(between('Domain Events', 'Projection Worker')).toMatchObject({ semantic: 'deliversTo', kind: 'event' });
    expect(between('Projection Worker', 'Read Store')).toMatchObject({ semantic: 'writes', label: 'updates projection' });
    expect(byText('Projection Worker').serviceKind).toBe('worker');
    expect(edges.filter((edge) => edge.target === byText('Read Store').id).map((edge) => edge.semantic).sort()).toEqual(['reads', 'writes']);
    expect(edges.filter((edge) => edge.target === byText('Write Store').id).map((edge) => edge.semantic).sort()).toEqual(['reads', 'writes']);

    // Two logical sides, each owning its workers: the relay is on the command side, the projection
    // on the query side, and the topic between them is the only thing that crosses.
    const command = byText('Command side');
    const query = byText('Query side');
    expect([command.boundaryPreset, query.boundaryPreset]).toEqual(['boundary', 'boundary']);
    expect(byText('Outbox Relay').parentId).toBe(command.id);
    expect(byText('Projection Worker').parentId).toBe(query.id);
    expect(byText('Domain Events').parentId).toBeUndefined();
    const sideOf = (id: string) => nodes.find((node) => node.id === id)!.parentId;
    for (const edge of edges) {
      expect(sideOf(edge.source) === command.id && sideOf(edge.target) === query.id).toBe(false);
      expect(sideOf(edge.source) === query.id && sideOf(edge.target) === command.id).toBe(false);
    }
    // The propagation is one level line along the store row.
    const row = [byText('Write Store'), byText('Outbox Relay'), byText('Domain Events'), byText('Projection Worker'), byText('Read Store')];
    for (let i = 1; i < row.length; i += 1) expect(row[i]!.x).toBeGreaterThan(row[i - 1]!.x + row[i - 1]!.width);
    // The one honest cost of the pattern is on the canvas, under the bridge, tied to the projection.
    expect(byText('Eventually consistent read projection').annotation).toBe(true);
    expect(byText('Eventually consistent read projection').parentId).toBeUndefined();
    // What CQRS does not require is said, not left to be assumed.
    expect(command.attachments?.[0]?.text).toMatch(/neither messaging, event sourcing nor separate services/);
    expect(byText('Read Store').attachments?.[0]?.text).toMatch(/not necessarily databases/);

    // Two flows: the whole write story including the async tail, and the two-step read.
    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Submit command', 7],
      ['Read projection', 2],
    ]);
    const edgeIds = new Set(edges.map((edge) => edge.id));
    for (const flow of flows) for (const step of flow.steps) expect(edgeIds.has(step.edgeId!)).toBe(true);
    expect(flows[1]!.steps.map((step) => step.edgeId)).toEqual([
      between('Client', 'Query API').id,
      between('Query API', 'Read Store').id,
    ]);
  });

  it('models the saga as a coordinator issuing commands to services that each commit locally, compensated in reverse', () => {
    const { nodes, edges, flows } = buildStarter(starterById('saga-orchestration')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(10);
    expect(edges).toHaveLength(9);

    const orchestrator = byText('Saga Orchestrator');
    // The coordinator is the only thing inside the Coordinator boundary, whose subtitle is its job.
    const coordinator = byText('Coordinator');
    expect(coordinator.type).toBe('group');
    expect(nodes.filter((node) => node.parentId === coordinator.id && node.type !== 'text')).toEqual([orchestrator]);
    expect(nodes.find((node) => node.parentId === coordinator.id && node.type === 'text')!.text).toBe('Drives the workflow, owns its state');
    // The one accent nobody else carries: the coordinator reads as the coordinator.
    expect(nodes.filter((node) => node.type !== 'group' && node.accent === orchestrator.accent)).toEqual([orchestrator]);
    // Every step is a command from the orchestrator — transport-neutral, never a plain call — and
    // the compensations are the connectors that say what they are for, coloured apart.
    const fromOrchestrator = edges.filter((edge) => edge.source === orchestrator.id);
    expect(fromOrchestrator).toHaveLength(5);
    const releases = fromOrchestrator.filter((edge) => edge.semantic === 'compensates');
    expect(releases.map((edge) => edge.label)).toEqual(['Release inventory', 'Release payment']);
    for (const edge of releases) expect(edge.accent).toBe('rose');
    const release = releases.find((edge) => edge.target === byText('Payment Service').id)!;
    const releaseInventory = releases.find((edge) => edge.target === byText('Inventory Service').id)!;
    // When they fire is the flow's story — a condition chip would sit on the fan's trunk.
    for (const edge of releases) expect(edge.condition).toBeUndefined();
    const steps = fromOrchestrator.filter((edge) => !releases.includes(edge));
    for (const step of steps) expect(step.accent).toBeUndefined();
    expect(steps.map((edge) => edge.label)).toEqual(['Reserve payment', 'Reserve inventory', 'Schedule fulfillment']);
    for (const step of steps) {
      expect(step.semantic).toBe('command');
      expect(step.semanticsOrigin).toBe('explicit');
    }
    for (const edge of fromOrchestrator) {
      expect(edge.routeMode).toBeUndefined();
      expect(edge.routing).toBe('smoothstep');
      expect(edge.hasResponse).toBeUndefined();
    }
    // Each participant owns exactly its own store and commits locally — no cross-service write.
    for (const name of ['Payment', 'Inventory', 'Fulfillment']) {
      const service = byText(`${name} Service`);
      const store = byText(`${name} DB`);
      const writes = edges.filter((edge) => edge.target === store.id);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.source).toBe(service.id);
      expect(writes[0]!.semantic).toBe('writes');
    }
    // Compensation is a second connector to a service whose step already succeeded — its own
    // relationship, leaving the orchestrator's side rather than its bottom, and landing on the
    // participant's side, never on the forward step's anchor.
    const payment = byText('Payment Service');
    expect(release.target).toBe(payment.id);
    expect(release.semantic).toBe('compensates');
    expect(release.label).toBe('Release payment');
    expect(release.sourceAnchor).toEqual({ side: 'left', offset: 0.75 });
    expect(releaseInventory.sourceAnchor).toEqual({ side: 'right', offset: 0.75 });
    const reservePayment = steps.find((edge) => edge.target === payment.id)!;
    expect(reservePayment.targetAnchor).toEqual({ side: 'top', offset: 0.5 });
    expect(release.targetAnchor).toEqual({ side: 'right', offset: 0.25 });
    expect(releaseInventory.targetAnchor).toEqual({ side: 'right', offset: 0.25 });
    // The order service starts the saga from beside the coordinator, with a level line.
    const start = edges.find((edge) => edge.target === orchestrator.id)!;
    expect(start.source).toBe(byText('Order Service').id);
    expect(start.label).toBe('Start saga');
    expect(start.sourceAnchor?.side).toBe('right');
    expect(start.targetAnchor?.side).toBe('left');

    // The three steps share one hub anchor, so Smart Routing draws them as one fan — and the
    // compensation, touching different points, neither joins the fan nor nudges the step out of it.
    for (const step of steps) expect(step.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
    const plan = routingPlan(nodes, edges);
    const spine = plan.spineFor(steps[0]!.id);
    expect(spine).toBeDefined();
    expect(spine!.count).toBe(3);
    for (const step of steps) expect(plan.spineFor(step.id)).toBe(spine);
    expect(plan.spineFor(release.id)).toBeUndefined();
    expect(plan.spineFor(releaseInventory.id)).toBeUndefined();
    expect(plan.spineFor(start.id)).toBeUndefined();
    const lanes = laneIndex(edges);
    expect(lanes.get(reservePayment.id)).toEqual({ offset: 0, count: 1 });
    expect(lanes.get(release.id)).toEqual({ offset: 0, count: 1 });
    expect(lanes.get(releaseInventory.id)).toEqual({ offset: 0, count: 1 });

    // Compensation replays the forward steps up to the failure, then undoes them in reverse.
    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Happy path', 7],
      ['Compensation', 6],
    ]);
    const happy = flows[0]!.steps.map((step) => step.edgeId);
    expect(happy).not.toContain(release.id);
    expect(happy).not.toContain(releaseInventory.id);
    const compensation = flows[1]!.steps.map((step) => step.edgeId);
    const commitPayment = edges.find((edge) => edge.source === payment.id)!;
    const reserveInventory = steps.find((edge) => edge.target === byText('Inventory Service').id)!;
    const scheduleFulfillment = steps.find((edge) => edge.target === byText('Fulfillment Service').id)!;
    expect(compensation).toEqual([
      reservePayment.id,
      commitPayment.id,
      reserveInventory.id,
      scheduleFulfillment.id,
      releaseInventory.id,
      release.id,
    ]);
  });

  it('models the choreographed saga as an event chain with no coordinator, compensated by another event', () => {
    const { nodes, edges, flows } = buildStarter(starterById('saga-choreography')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const between = (from: string, to: string) =>
      edges.find((edge) => edge.source === byText(from).id && edge.target === byText(to).id)!;
    expect(nodes).toHaveLength(10);
    expect(edges).toHaveLength(9);

    // No coordinator of any kind: no boundary, no orchestrator, no service that commands another.
    expect(nodes.filter((node) => node.type === 'group')).toHaveLength(0);
    expect(nodes.some((node) => node.type !== 'text' && /orchestrat|coordinat/i.test(node.text ?? ''))).toBe(false);
    expect(edges.some((edge) => edge.semantic === 'command' || edge.semantic === 'calls')).toBe(false);
    expect(nodes.find((node) => node.type === 'text')!.text).toMatch(/No central coordinator/);

    // The forward chain: publish → deliver → publish → deliver, through topics named for facts.
    expect(between('Order Service', 'Order Placed').semantic).toBe('publishes');
    expect(between('Order Placed', 'Payment Service').semantic).toBe('deliversTo');
    expect(between('Payment Service', 'Payment Taken').semantic).toBe('publishes');
    expect(between('Payment Taken', 'Inventory Service').semantic).toBe('deliversTo');
    for (const topic of ['Order Placed', 'Payment Taken', 'Stock Rejected']) expect(byText(topic).queueKind).toBe('topic');
    // Every event hop is an event (dashed, asynchronous) — that is what makes the process emergent.
    for (const edge of edges.filter((edge) => edge.semantic !== 'writes')) expect(edge.kind).toBe('event');
    // Each participant owns exactly its own store and commits locally.
    for (const name of ['Order', 'Payment', 'Inventory']) {
      const writes = edges.filter((edge) => edge.target === byText(`${name} DB`).id);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.source).toBe(byText(`${name} Service`).id);
      expect(writes[0]!.semantic).toBe('writes');
    }
    // Compensation is event-driven too: a failure event, and a reaction that is a new local action.
    const reject = between('Inventory Service', 'Stock Rejected');
    const refund = between('Stock Rejected', 'Payment Service');
    expect(reject.semantic).toBe('publishes');
    expect(refund.semantic).toBe('deliversTo');
    expect(refund.label).toBe('Refund payment');
    expect(reject.accent).toBe('rose');
    expect(refund.accent).toBe('rose');
    expect(byText('Stock Rejected').attachments?.[0]?.text).toMatch(/Payment Refunded/);

    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Happy path', 7],
      ['Compensation', 4],
    ]);
    expect(flows[1]!.steps.map((step) => step.edgeId)).toEqual([
      between('Payment Taken', 'Inventory Service').id,
      reject.id,
      refund.id,
      between('Payment Service', 'Payment DB').id,
    ]);
  });

  it('models the outbox as one atomic write of state and event, published later, consumed independently', () => {
    const { nodes, edges, flows } = buildStarter(starterById('transactional-outbox')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(8);
    expect(edges).toHaveLength(5);

    // The outbox is a table — not a queue, and not a second database — and it lives in the same
    // transaction as the business row: two tables of one store, drawn as tables.
    const transaction = byText('One local transaction');
    expect(transaction.type).toBe('group');
    expect(byText('Outbox').type).toBe('database');
    expect(byText('Outbox').databaseKind).toBe('table');
    expect(byText('Business Data').databaseKind).toBe('table');
    expect(byText('Business Data').parentId).toBe(transaction.id);
    expect(byText('Outbox').parentId).toBe(transaction.id);
    // No dual write: the producer's only connectors land inside the transaction, from one point,
    // and nothing links the producer to the broker.
    const producer = byText('Producer Service');
    const writes = edges.filter((edge) => edge.source === producer.id);
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((edge) => JSON.stringify(edge.sourceAnchor))).size).toBe(1);
    for (const write of writes) {
      expect(write.semantic).toBe('writes');
      expect(nodes.find((node) => node.id === write.target)!.parentId).toBe(transaction.id);
    }
    expect(edges.some((edge) => edge.source === producer.id && edge.target === byText('Domain Events').id)).toBe(false);
    // Publication is a separate worker reading the outbox; consumption is separate again.
    const chain = ['Outbox', 'Outbox Publisher', 'Domain Events', 'Consumer Service'];
    const semantics = chain.slice(1).map(
      (to, index) => edges.find((edge) => edge.source === byText(chain[index]!).id && edge.target === byText(to).id)!.semantic,
    );
    expect(semantics).toEqual(['reads', 'publishes', 'deliversTo']);
    expect(byText('Outbox Publisher').serviceKind).toBe('worker');
    expect(byText('Consumer Service').serviceKind).toBe('worker');
    expect(byText('Business Data').id).not.toBe(edges.find((edge) => edge.target === byText('Outbox Publisher').id)!.source);

    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Service transaction', 2],
      ['Outbox publication', 2],
      ['Event consumption', 1],
    ]);
  });

  it('routes every straight-authored connector as an actual straight line, not a hidden detour', () => {
    for (const starter of ARCHITECTURE_STARTERS) {
      const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const edge of edges) {
        const source = byId.get(edge.source)!;
        const target = byId.get(edge.target)!;
        const sourceIsVertical = edge.sourceAnchor?.side === 'top' || edge.sourceAnchor?.side === 'bottom';
        const targetIsVertical = edge.targetAnchor?.side === 'top' || edge.targetAnchor?.side === 'bottom';
        if (!sourceIsVertical || !targetIsVertical) continue;
        const sourceX = anchorPoint(rectOfNode(source), edge.sourceAnchor!.side, edge.sourceAnchor!.offset).x;
        const targetX = anchorPoint(rectOfNode(target), edge.targetAnchor!.side, edge.targetAnchor!.offset).x;
        if (Math.abs(sourceX - targetX) > 0.5) continue;

        const obstacles = nodes
          .filter((node) => node.id !== edge.source && node.id !== edge.target && node.type !== 'group')
          .map(rectOfNode);
        const route = routeEdge(edge, byId, { obstacles });
        expect(
          route?.d.includes('Q'),
          `${starter.name}: "${source.text ?? source.type}" → "${target.text ?? target.type}" was authored straight but routes with a detour`,
        ).toBe(false);
      }
    }
  });

  // The same guard for the *horizontal* starters: a connector authored level (same y on both
  // ends, left/right anchors) must route as one straight line too — a Port node sits in exactly
  // the corridors Hexagonal's funnel and fork travel through, so this is where a hidden detour
  // would first appear.
  it('routes every level-authored connector as an actual straight line, not a hidden detour', () => {
    for (const starter of ARCHITECTURE_STARTERS) {
      const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const edge of edges) {
        const source = byId.get(edge.source)!;
        const target = byId.get(edge.target)!;
        const sourceIsHorizontal = edge.sourceAnchor?.side === 'left' || edge.sourceAnchor?.side === 'right';
        const targetIsHorizontal = edge.targetAnchor?.side === 'left' || edge.targetAnchor?.side === 'right';
        if (!sourceIsHorizontal || !targetIsHorizontal) continue;
        // Through `anchorPoint`, so "level" means what routing means (a queue's tube band included).
        const sourceY = anchorPoint(rectOfNode(source), edge.sourceAnchor!.side, edge.sourceAnchor!.offset).y;
        const targetY = anchorPoint(rectOfNode(target), edge.targetAnchor!.side, edge.targetAnchor!.offset).y;
        if (Math.abs(sourceY - targetY) > 0.5) continue;

        const obstacles = nodes
          .filter((node) => node.id !== edge.source && node.id !== edge.target && node.type !== 'group')
          .map(rectOfNode);
        const route = routeEdge(edge, byId, { obstacles });
        expect(
          route?.d.includes('Q'),
          `${starter.name}: "${source.text ?? source.type}" → "${target.text ?? target.type}" was authored level but routes with a detour`,
        ).toBe(false);
      }
    }
  });

  // The guard above only looks at lines that *are* level. A Data Store's glyph sits above its box
  // centre and routing lands a side connector on the glyph, so a store placed by its box leaves the
  // line into it jogging — and drops out of that check unseen.
  it('lands a one-to-one side connection to a Data Store level, so it never jogs into the shape', () => {
    for (const starter of ARCHITECTURE_STARTERS) {
      const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const horizontal = (edge: (typeof edges)[number]) =>
        (edge.sourceAnchor?.side === 'left' || edge.sourceAnchor?.side === 'right') &&
        (edge.targetAnchor?.side === 'left' || edge.targetAnchor?.side === 'right');
      const sideEdges = edges.filter(horizontal);
      const sharing = (id: string, side: string | undefined) =>
        sideEdges.filter(
          (edge) =>
            (edge.source === id && edge.sourceAnchor?.side === side) || (edge.target === id && edge.targetAnchor?.side === side),
        ).length;
      for (const edge of sideEdges) {
        const source = byId.get(edge.source)!;
        const target = byId.get(edge.target)!;
        if (source.type !== 'database' && target.type !== 'database') continue;
        // A fan (one node reaching several) is deliberately not level: each branch leaves at its own height.
        if (sharing(source.id, edge.sourceAnchor!.side) > 1 || sharing(target.id, edge.targetAnchor!.side) > 1) continue;
        const sourceY = anchorPoint(rectOfNode(source), edge.sourceAnchor!.side, edge.sourceAnchor!.offset).y;
        const targetY = anchorPoint(rectOfNode(target), edge.targetAnchor!.side, edge.targetAnchor!.offset).y;
        expect(
          Math.abs(sourceY - targetY),
          `${starter.name}: "${source.text ?? source.type}" → "${target.text ?? target.type}" should meet the store's glyph level`,
        ).toBeLessThanOrEqual(0.5);
      }
    }
  });
});
