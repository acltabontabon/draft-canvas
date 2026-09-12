import { describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { anchorPoint, laneIndex, routeEdge, rectOf as rectOfNode } from '../src/edges/routing';
import { routingPlan } from '../src/edges/bundles';
import type { DraftNode } from '../src/document/types';
import { BOUNDARY_PAD, BOUNDARY_HEADER_CAPTION_ONLY, BOUNDARY_TITLE_SUBLINE_Y } from '../src/starters/compose';
import { ARCHITECTURE_STARTERS, STARTER_IDS, starterById, starterSize } from '../src/starters';
import { buildStarter, sizeOfSpec } from '../src/starters/build';
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
  it('exposes exactly the ten declared starters, each reachable by id, architectures before patterns', () => {
    expect(ARCHITECTURE_STARTERS.map((starter) => starter.id)).toEqual([...STARTER_IDS]);
    for (const id of STARTER_IDS) expect(starterById(id)?.id).toBe(id);
    const categories = ARCHITECTURE_STARTERS.map((starter) => starter.category);
    expect(categories.lastIndexOf('architecture')).toBeLessThan(categories.indexOf('pattern'));
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
    // 13, not 12: Hexagonal carries a boundary and that boundary's one subtitle on top of its eleven
    // architectural elements — the elements themselves stay well inside "a starting point."
    expect(starter.nodes.length).toBeLessThanOrEqual(13);
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
      // A boundary-header subtitle (Modular Monolith's, Hexagonal's) is a deliberate, narrow exception: it's
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
      // The preset caption and title are drawn inside the top edge — see `nodes/describe.ts`.
      expect(child.y - parent.y).toBeGreaterThanOrEqual(BOUNDARY_HEADER_CAPTION_ONLY);
    }
  });
});

describe('buildStarter', () => {
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

  it('models microservices as one entry point, independent deployables, service-owned data, and event integration', () => {
    const { nodes, edges } = buildStarter(starterById('microservices')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(12);
    expect(edges).toHaveLength(9);
    expect(nodes.filter((n) => n.type === 'text')).toHaveLength(0);

    // One public entry point: the gateway routes to every API service, each branch with the route
    // rule that selects it — a Condition used for what a Condition means.
    const gateway = nodes.find((node) => node.serviceKind === 'gateway')!;
    const routes = edges.filter((edge) => edge.source === gateway.id);
    expect(routes).toHaveLength(3);
    expect(routes.map((edge) => edge.semantic)).toEqual(['routes', 'routes', 'routes']);
    expect(new Set(routes.map((edge) => edge.condition))).toEqual(new Set(['/accounts/*', '/orders/*', '/payments/*']));
    // All three leave the same point, so Smart Routing can draw them as one trunk.
    expect(new Set(routes.map((edge) => JSON.stringify(edge.sourceAnchor))).size).toBe(1);
    const apis = nodes.filter((node) => node.serviceKind === 'api');
    expect(apis).toHaveLength(3);
    expect(new Set(routes.map((edge) => edge.target))).toEqual(new Set(apis.map((node) => node.id)));

    // Database per service: three generic stores, each written by exactly one service.
    const stores = nodes.filter((node) => node.type === 'database');
    expect(stores).toHaveLength(3);
    for (const store of stores) {
      expect(store.databaseKind).toBe('generic');
      const writers = edges.filter((edge) => edge.target === store.id);
      expect(writers).toHaveLength(1);
      expect(writers[0]!.semantic).toBe('writes');
    }

    // Independent deployables: every service sits inside its own deployment boundary, no two
    // share one, and the topic belongs to none of them.
    const boundaries = nodes.filter((node) => node.boundaryPreset === 'deployment');
    expect(boundaries).toHaveLength(3);
    expect(new Set(nodes.filter((node) => node.parentId).map((node) => node.parentId)).size).toBe(3);
    const topic = byText('Order Events');
    expect(topic).toMatchObject({ type: 'queue', queueKind: 'topic' });
    expect(topic.parentId).toBeUndefined();
    for (const boundary of boundaries) expect(overlaps(topic, boundary)).toBe(false);

    // Integrate through events: Orders publishes, the topic delivers to Payments — and no service
    // ever calls another service or touches another's store.
    const publish = edges.find((edge) => edge.source === byText('Orders').id && edge.target === topic.id)!;
    expect(publish).toMatchObject({ semantic: 'publishes', kind: 'event' });
    expect(publish.label).toBeUndefined();
    const deliver = edges.find((edge) => edge.source === topic.id)!;
    expect(deliver).toMatchObject({ target: byText('Payments').id, semantic: 'deliversTo', kind: 'event' });
    const services = new Set(nodes.filter((node) => node.type === 'service').map((node) => node.id));
    for (const edge of edges) {
      if (edge.source === gateway.id) continue;
      expect(services.has(edge.source) && services.has(edge.target)).toBe(false);
    }

    // Exactly three notes of production depth: the gateway's job, a private store, when an event
    // may be emitted — all click-to-reveal, never a visible node.
    const nodeNotes = nodes.flatMap((node) => node.attachments ?? []);
    const edgeNotes = edges.flatMap((edge) => edge.attachments ?? []);
    expect(nodeNotes.map((a) => a.type)).toEqual(['note', 'note']);
    expect(gateway.attachments).toHaveLength(1);
    expect(byText('Orders DB').attachments).toHaveLength(1);
    expect(edgeNotes).toHaveLength(1);
    expect(publish.attachments?.[0]?.text).toMatch(/OrderPlaced/);
  });

  it('models the modular monolith as one application boundary holding three modules with a controlled, acyclic dependency chain', () => {
    const { nodes, edges } = buildStarter(starterById('modular-monolith')!, { x: 0, y: 0 });
    const boundaries = nodes.filter((node) => node.type === 'group');
    expect(boundaries).toHaveLength(1);
    const app = boundaries[0]!;
    // No fixed `DEPLOYMENT` preset caption — the starter says "single deployment" itself, via a
    // plain annotation, so the boundary uses the one preset with no caption of its own.
    expect(app.boundaryPreset).toBe('boundary');

    const modules = nodes.filter((node) => node.type === 'component' && node.componentKind === 'module');
    expect(modules).toHaveLength(3);
    for (const module of modules) expect(module.parentId).toBe(app.id);

    const api = nodes.find((node) => node.type === 'component' && node.componentKind === 'adapter')!;
    expect(api).toBeDefined();
    expect(api.parentId).toBe(app.id);

    // No Shared Infrastructure layer, and no independent Service node at all — everything inside
    // the boundary is a Component.
    expect(nodes.some((node) => node.type === 'service')).toBe(false);

    // Exactly one edge among the modules — a controlled, explicit dependency, not a chain or a
    // mesh — captioned as a contract rather than the plain inferred "uses".
    const moduleIds = new Set(modules.map((node) => node.id));
    const moduleEdges = edges.filter((edge) => moduleIds.has(edge.source) && moduleIds.has(edge.target));
    expect(moduleEdges).toHaveLength(1);
    expect(moduleEdges[0]!.semantic).toBe('uses');
    expect(moduleEdges[0]!.label).toBe('uses public API');

    // The API reaches every module individually — three distinct edges in the document model,
    // even though Smart Routing bundles them into one shared trunk with one collapsed caption on
    // screen (bundling changes rendering, never the underlying relationships).
    for (const module of modules) {
      expect(edges.some((e) => e.source === api.id && e.target === module.id)).toBe(true);
    }

    // The database sits outside the boundary — it's a separate runtime resource, not part of the
    // one deployable unit — and carries exactly one edge, from the boundary itself, not any one
    // module: a module owns its own *data*, not the shared physical store, so a per-module edge
    // would misstate exactly that no matter how it's labelled. The boundary-level edge is
    // deliberately uncaptioned — a `group` node has no category in the capability matrix, so
    // there's genuinely no inferred relationship to show, and forcing a label onto one would say
    // something the rest of the app doesn't agree with.
    const database = nodes.find((node) => node.type === 'database')!;
    expect(database.databaseKind).toBe('generic');
    expect(database.parentId).toBeUndefined();
    const databaseEdges = edges.filter((e) => e.source === database.id || e.target === database.id);
    expect(databaseEdges).toHaveLength(1);
    expect(databaseEdges[0]!.source).toBe(app.id);
    expect(databaseEdges[0]!.target).toBe(database.id);
    expect(databaseEdges[0]!.semantic).toBeUndefined();
    expect(databaseEdges[0]!.label).toBeUndefined();

    // The boundary's own subtitle is the only annotation in the starter — no separate
    // "module-owned data" caption, and no repeated module-name list either.
    const subtitle = nodes.find((node) => node.parentId === app.id && node.type === 'text');
    expect(subtitle?.text).toBe('Single deployable unit');
    expect(nodes.filter((node) => node.type === 'text')).toHaveLength(1);

    // Two notes of production depth — on the boundary and on the store — and nothing on any edge.
    expect(app.attachments).toHaveLength(1);
    expect(database.attachments).toHaveLength(1);
    expect(nodes.flatMap((node) => node.attachments ?? [])).toHaveLength(2);
    expect(edges.flatMap((edge) => edge.attachments ?? [])).toHaveLength(0);
  });

  it('models the monolith as one deployment boundary holding three layered components over one outside store', () => {
    const { nodes, edges } = buildStarter(starterById('monolith')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(7);
    expect(edges).toHaveLength(5);
    expect(nodes.filter((node) => node.type === 'text')).toHaveLength(0);

    const app = nodes.find((node) => node.type === 'group')!;
    expect(app.boundaryPreset).toBe('deployment');
    const layers = ['API', 'Business Logic', 'Data Access'].map(byText);
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
    const database = byText('Database');
    expect(database).toMatchObject({ type: 'database', databaseKind: 'generic' });
    expect(database.parentId).toBeUndefined();
    expect(database.y).toBeGreaterThan(app.y + app.height);
    const external = byText('External System');
    expect(external).toMatchObject({ type: 'service', serviceKind: 'external' });
    expect(external.x).toBeGreaterThan(app.x + app.width);
    const logic = byText('Business Logic');
    expect(external.y + external.height / 2).toBe(logic.y + logic.height / 2);

    const edgeBetween = (fromText: string, toText: string) =>
      edges.find((e) => e.source === byText(fromText).id && e.target === byText(toText).id)!;
    for (const [fromText, toText, semantic] of [
      ['Client', 'API', 'calls'],
      ['API', 'Business Logic', 'uses'],
      ['Business Logic', 'Data Access', 'uses'],
      ['Data Access', 'Database', 'writes'],
      ['Business Logic', 'External System', 'calls'],
    ] as const) {
      const edge = edgeBetween(fromText, toText);
      expect(edge, `${fromText} → ${toText}`).toBeDefined();
      expect(edge.semantic).toBe(semantic);
      expect(edge.label).toBeUndefined();
      expect(edge.condition).toBeUndefined();
    }

    // Two notes: what "one artifact" means, and that the schema ships with the release.
    expect(app.attachments).toHaveLength(1);
    expect(database.attachments).toHaveLength(1);
    expect(nodes.flatMap((node) => node.attachments ?? [])).toHaveLength(2);
  });

  it('models event-driven flow as one producer, a topic fanning out to three consumer-owned queues, and one failure route', () => {
    const { nodes, edges } = buildStarter(starterById('event-driven')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const edgesFrom = (id: string) => edges.filter((e) => e.source === id);
    const edgesTo = (id: string) => edges.filter((e) => e.target === id);

    const producer = byText('Producer Service');
    const topic = byText('Domain Events');
    const workers = ['Projection Service', 'Processing Service', 'Integration Service'].map(byText);
    const [projection, processing, integration] = workers as [DraftNode, DraftNode, DraftNode];
    const store = byText('Read Store');
    const external = byText('External System');
    const queues = nodes.filter((n) => n.type === 'queue' && n.queueKind === 'queue' && !n.deliveryRole);
    const dlq = nodes.find((n) => n.deliveryRole === 'dead-letter')!;

    // Eleven elements, ten connections, no free-floating text, no boundary, no junction.
    expect(nodes).toHaveLength(11);
    expect(edges).toHaveLength(10);
    expect(nodes.filter((n) => n.type === 'text' || n.type === 'group' || n.type === 'ellipse')).toHaveLength(0);
    expect(nodes.filter((n) => n.queueKind === 'topic')).toEqual([topic]);
    expect(queues).toHaveLength(3);
    // Delivery queues carry no name of their own — ownership reads from sitting above their worker.
    for (const queue of queues) expect(queue.text ?? '').toBe('');

    // The producer publishes exactly once, to the topic, and names one concrete past-tense event.
    expect(edgesFrom(producer.id)).toHaveLength(1);
    const published = edgesTo(topic.id);
    expect(published).toHaveLength(1);
    expect(published[0]!.source).toBe(producer.id);
    expect(published[0]!.semantic).toBe('publishes');
    expect(published[0]!.kind).toBe('event');
    expect(published[0]!.label).toBe('publishes OrderCreated');
    expect(published[0]!.attachments).toHaveLength(1);
    expect(published[0]!.attachments![0]!.type).toBe('code');
    expect(published[0]!.attachments![0]!.code).toContain('"type": "OrderCreated"');

    // The topic fans out to each queue — inferred, unoverridden, and bundle-eligible (one trunk).
    const fanned = edgesFrom(topic.id);
    expect(fanned).toHaveLength(3);
    expect(new Set(fanned.map((e) => e.target))).toEqual(new Set(queues.map((q) => q.id)));
    for (const edge of fanned) {
      expect(edge.semantic).toBe('fansOut');
      expect(edge.kind).toBe('event');
      expect(edge.label).toBeUndefined();
      expect(edge.routeMode).toBeUndefined();
      expect(edge.sourceAnchor).toEqual({ side: 'bottom', offset: 0.5 });
      expect(edge.targetAnchor).toEqual({ side: 'top', offset: 0.5 });
    }

    // Every consumer is a Worker fed by exactly one queue of its own, directly above it.
    for (const worker of workers) {
      expect(worker.type).toBe('service');
      expect(worker.serviceKind).toBe('worker');
      const consumes = edgesTo(worker.id);
      expect(consumes).toHaveLength(1);
      expect(consumes[0]!.semantic).toBe('consumes');
      expect(consumes[0]!.kind).toBe('event');
      const queue = nodes.find((n) => n.id === consumes[0]!.source)!;
      expect(queues).toContain(queue);
      expect(queue.x + queue.width / 2).toBe(worker.x + worker.width / 2);
      expect(queue.y + queue.height).toBeLessThan(worker.y);
    }

    // Projection owns the only store (writes); Integration calls the only external system (a
    // synchronous, solid call — the one non-event line); Processing owns nothing below it.
    expect(nodes.filter((n) => n.type === 'database')).toEqual([store]);
    expect(store.databaseKind).toBe('generic');
    expect(edgesFrom(projection.id).map((e) => [e.target, e.semantic])).toEqual([[store.id, 'writes']]);
    expect(external.serviceKind).toBe('external');
    const calls = edgesFrom(integration.id);
    expect(calls.map((e) => [e.target, e.semantic, e.kind, e.async])).toEqual([[external.id, 'calls', undefined, undefined]]);
    expect(edgesFrom(processing.id)).toHaveLength(0);

    // One DLQ, beside the Integration queue only, on a dashed, inferred dead-letter route.
    expect(nodes.filter((n) => n.deliveryRole === 'dead-letter')).toEqual([dlq]);
    const integrationQueue = nodes.find((n) => n.id === edgesTo(integration.id)[0]!.source)!;
    const deadLetters = edgesTo(dlq.id);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.source).toBe(integrationQueue.id);
    expect(deadLetters[0]!.semantic).toBe('deadLetters');
    expect(deadLetters[0]!.kind).toBe('failure');
    expect(deadLetters[0]!.async).toBe(true);
    expect(deadLetters[0]!.semanticsOrigin).toBe('inferred');
    expect(deadLetters[0]!.deliveryAttempts).toBe(3);
    expect(deadLetters[0]!.attachments?.[0]?.type).toBe('note');
    expect(dlq.y).toBe(integrationQueue.y);
    expect(dlq.x).toBeGreaterThan(integrationQueue.x + integrationQueue.width);
    expect(edgesFrom(dlq.id)).toHaveLength(0);
    // The DLQ is the only node right of the three lanes — never mistakable for a fourth consumer.
    expect(nodes.filter((n) => n.x >= dlq.x)).toEqual([dlq]);

    // Exactly two attachments in the whole starter — depth on click, never a visible extra node.
    expect(edges.flatMap((e) => e.attachments ?? [])).toHaveLength(2);
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
    // adapters, the store, the external system, the driving services — lives outside it.
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
    expect(crossingIn).toHaveLength(2);
    for (const edge of crossingIn) expect(portIds.has(edge.target)).toBe(true);
    expect(crossingOut).toHaveLength(2);
    for (const edge of crossingOut) expect(portIds.has(edge.source)).toBe(true);

    // One shared inbound port (both driving adapters call the same use cases), and each outbound
    // port has exactly one implementer.
    const inboundPort = nodes.find((node) => node.text === 'Inbound')!;
    expect(crossingIn.every((edge) => edge.target === inboundPort.id)).toBe(true);
    for (const port of ports) {
      const out = edges.filter((edge) => edge.source === port.id);
      expect(out).toHaveLength(1);
    }
  });

  it('gives every piece the kind that is true of it: Services drive, Components work, Ports promise', () => {
    const { nodes, edges } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const core = nodes.find((node) => node.type === 'group')!;

    expect(byText('REST API')).toMatchObject({ type: 'service', serviceKind: 'api' });
    expect(byText('Message Consumer')).toMatchObject({ type: 'service', serviceKind: 'worker' });
    expect(byText('Use Cases')).toMatchObject({ type: 'component', componentKind: 'generic' });
    expect(byText('Domain Model')).toMatchObject({ type: 'component', componentKind: 'generic' });
    for (const name of ['Inbound', 'Persistence', 'Integration']) {
      expect(byText(name)).toMatchObject({ type: 'component', componentKind: 'port', parentId: core.id });
    }
    expect(byText('Persistence Adapter')).toMatchObject({ type: 'component', componentKind: 'adapter' });
    expect(byText('Integration Adapter')).toMatchObject({ type: 'component', componentKind: 'adapter' });
    expect(byText('External System')).toMatchObject({ type: 'service', serviceKind: 'external' });
    expect(nodes.some((n) => n.type === 'service' && n.serviceKind === undefined)).toBe(false);

    // The one annotation is the core's own subtitle — never a floating label, never a Condition.
    const labels = nodes.filter((n) => n.type === 'text');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ text: 'Dependencies point inward', annotation: true, parentId: core.id });
    expect(edges.every((e) => e.condition === undefined)).toBe(true);
  });

  // Every arrow points the way a request travels; dependency inversion is carried by where the
  // ports sit (inside the core) and by the word on the connector leaving each one.
  it('reads runtime flow left to right while the relationship words carry dependency inversion', () => {
    const { nodes, edges } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const edgeBetween = (fromText: string, toText: string) => {
      const from = byText(fromText).id;
      const to = byText(toText).id;
      return edges.find((e) => e.source === from && e.target === to)!;
    };

    const expected: Array<[string, string, string]> = [
      ['REST API', 'Inbound', 'calls'],
      ['Message Consumer', 'Inbound', 'calls'],
      ['Inbound', 'Use Cases', 'implementedBy'],
      ['Use Cases', 'Domain Model', 'uses'],
      ['Use Cases', 'Persistence', 'uses'],
      ['Use Cases', 'Integration', 'uses'],
      ['Persistence', 'Persistence Adapter', 'implementedBy'],
      ['Integration', 'Integration Adapter', 'implementedBy'],
      ['Persistence Adapter', 'Database', 'writes'],
      ['Integration Adapter', 'External System', 'calls'],
    ];
    for (const [fromText, toText, semantic] of expected) {
      const edge = edgeBetween(fromText, toText);
      expect(edge, `${fromText} → ${toText}`).toBeDefined();
      expect(edge.semantic, `${fromText} → ${toText}`).toBe(semantic);
      expect(edge.label).toBeUndefined();
      expect(edge.semanticsOrigin).toBe('inferred');
    }

    // The funnel shares one point on the inbound port; the fork shares one point on Use Cases —
    // that's what lets Smart Routing draw each as one trunk with one collapsed caption.
    expect(edgeBetween('REST API', 'Inbound').targetAnchor).toEqual(edgeBetween('Message Consumer', 'Inbound').targetAnchor);
    expect(edgeBetween('Use Cases', 'Persistence').sourceAnchor).toEqual(edgeBetween('Use Cases', 'Integration').sourceAnchor);
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

  // Regression: the "Inbound ports"/"Outbound ports" labels' invisible hit-boxes used to be wide
  // enough (and off-centre enough) to sit inside `edges/routing.ts`'s `OBSTACLE_BAND` of the
  // vertical connector running through the same band, so the router quietly detoured a
  // should-be-straight line a few pixels sideways — worse-looking under Sketch/Draft's hand-drawn
  // stroke, but a real routing decision, not personality styling. Every connector authored as a
  // plain vertical (same x on both ends) must stay one — no interior `Q` (quadratic) command.
  it('models BFF as one tailored adapter per client experience over shared, independent domain services', () => {
    const { nodes, edges, flows } = buildStarter(starterById('bff')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    expect(nodes).toHaveLength(13);
    expect(edges).toHaveLength(7);
    expect(flows).toEqual([]);

    // Two BFFs, both plain `api`-kind services (never `gateway`), each inside its own experience
    // boundary with its own client — and no gateway anywhere: BFF ≠ API Gateway is the whole
    // lesson, carried by label and connections rather than a dedicated shape kind.
    expect(nodes.some((node) => node.serviceKind === 'gateway')).toBe(false);
    const adapters = [byText('Web BFF'), byText('Mobile BFF')];
    expect(adapters.every((node) => node.serviceKind === 'api')).toBe(true);
    expect(adapters.map((node) => node.text).sort()).toEqual(['Mobile BFF', 'Web BFF']);
    expect(new Set(adapters.map((node) => node.parentId)).size).toBe(2);
    for (const adapter of adapters) {
      const client = nodes.find((node) => node.type === 'actor' && node.parentId === adapter.parentId)!;
      expect(client.actorKind).toBe('device');
      expect(edges.filter((edge) => edge.source === client.id).map((edge) => edge.target)).toEqual([adapter.id]);
      // Every connector leaving an adapter *calls* into the domain — a BFF composes, it never
      // routes — and never reaches another adapter.
      for (const edge of edges.filter((edge) => edge.source === adapter.id)) {
        expect(edge.semantic).toBe('calls');
        expect(nodes.find((node) => node.id === edge.target)!.parentId).toBe(byText('Domain services').id);
      }
    }
    // Tailored, not uniform: the web experience uses one more capability than mobile does.
    expect(edges.filter((edge) => edge.source === byText('Web BFF').id)).toHaveLength(3);
    expect(edges.filter((edge) => edge.source === byText('Mobile BFF').id)).toHaveLength(2);
    // Every boundary says who owns it — that ownership is why a BFF may be tailored.
    const subtitles = nodes.filter((node) => node.type === 'text' && node.annotation).map((node) => node.text);
    expect(subtitles).toEqual(['Owned by the web team', 'Shared, reused by every client', 'Owned by the mobile team']);
    // Shared domain services are independent of each other, and nothing here is asynchronous.
    const domain = nodes.filter((node) => node.parentId === byText('Domain services').id && node.type === 'service');
    expect(domain).toHaveLength(3);
    for (const edge of edges) {
      expect(domain.some((node) => node.id === edge.source)).toBe(false);
      expect(edge.async).toBeUndefined();
      expect(edge.kind === undefined || edge.kind === 'sync').toBe(true);
    }
  });

  it('models CQRS as intent in, questions answered from a projection, with an event as the only bridge', () => {
    const { nodes, edges, flows } = buildStarter(starterById('cqrs')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const between = (from: string, to: string) =>
      edges.find((edge) => edge.source === byText(from).id && edge.target === byText(to).id)!;
    expect(nodes).toHaveLength(13);
    expect(edges).toHaveLength(8);

    // Commands express intent; queries never mutate — said by the relationship words themselves.
    expect(between('Client', 'Command API').semantic).toBe('command');
    // Handling a command is *executing* it — not a second "command" caption in a row.
    expect(between('Command API', 'Write Model').label).toBe('executes');
    expect(between('Client', 'Query API').semantic).toBe('query');
    expect(between('Query API', 'Read Store').semantic).toBe('reads');
    expect(between('Write Model', 'Write Store').semantic).toBe('writes');
    // Not Event Sourcing: no event store, and the topic carries facts, not state.
    expect(nodes.filter((node) => node.type === 'database').map((node) => node.text).sort()).toEqual(['Read Store', 'Write Store']);
    expect(byText('Domain Events').queueKind).toBe('topic');
    expect(between('Write Model', 'Domain Events').semantic).toBe('publishes');
    // The only path between the two sides is event → projection → read store.
    const command = byText('Command').id;
    const query = byText('Query').id;
    const sideOf = (id: string) => nodes.find((node) => node.id === id)!.parentId;
    for (const edge of edges) {
      const crosses = sideOf(edge.source) === command && sideOf(edge.target) === query;
      expect(crosses).toBe(false);
      expect(sideOf(edge.source) === query && sideOf(edge.target) === command).toBe(false);
    }
    // A projection's write is a derived one, and reads as such — never the authoritative `writes`.
    expect(between('Projection Service', 'Read Store').semantic).toBe('projects');
    expect(between('Projection Service', 'Read Store').semanticsOrigin).toBe('explicit');
    expect(byText('Projection Service').serviceKind).toBe('worker');
    // The one honest cost of the pattern is on the canvas, under the bridge.
    expect(byText('Eventually consistent').annotation).toBe(true);
    expect(byText('Eventually consistent').parentId).toBeUndefined();
    // Nothing on the query side is written by the command side, and vice versa.
    expect(edges.filter((edge) => edge.target === byText('Read Store').id).map((edge) => edge.semantic).sort()).toEqual(['projects', 'reads']);
    expect(edges.filter((edge) => edge.target === byText('Write Store').id)).toHaveLength(1);

    // Two flows: the whole write story including the async tail, and the two-step read.
    expect(flows.map((flow) => [flow.title, flow.steps.length])).toEqual([
      ['Submit command', 6],
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
});
