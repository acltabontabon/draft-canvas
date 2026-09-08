import { describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { routeEdge, rectOf as rectOfNode } from '../src/edges/routing';
import type { DraftNode } from '../src/document/types';
import { BOUNDARY_PAD, BOUNDARY_HEADER_CAPTION_ONLY } from '../src/starters/compose';
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
  it('exposes exactly the five declared starters, each reachable by id', () => {
    expect(ARCHITECTURE_STARTERS.map((starter) => starter.id)).toEqual([...STARTER_IDS]);
    for (const id of STARTER_IDS) expect(starterById(id)?.id).toBe(id);
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
    expect(starter.nodes.length).toBeLessThanOrEqual(12);
    expect(starter.edges.length).toBeLessThanOrEqual(8);
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
      // Modular Monolith's boundary-header subtitle is a deliberate, narrow exception: it's
      // authored as the second line of the boundary's own header (`compose.ts`'s
      // `BOUNDARY_TITLE_INSET`/`BOUNDARY_TITLE_SUBLINE_Y`), sharing the title's own left edge and
      // sitting exactly as close beneath it as the title's own metrics allow — not an ordinary
      // piece of content held to the general child-inset floor below.
      if (spec.key === 'app-subtitle') continue;
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
    const geometry = (nodes: DraftNode[]) =>
      nodes.map(({ id: _id, parentId: _parentId, ...rest }) => rest);
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
    for (const edge of edges) {
      const capability = capabilityFor(
        categoryOf(byId.get(edge.source)!),
        categoryOf(byId.get(edge.target)!),
      );
      expect(edge.semantic).toBe(capability?.defaultRelation);
      expect(edge.kind).toBe(capability?.defaultBehavior);
      // Inferred, not explicit: changing a node's kind afterwards must re-derive these, exactly as
      // it does for a connector the user drew by hand (`isEligibleForReinference`).
      expect(edge.semanticsOrigin).toBe(capability?.defaultRelation ? 'inferred' : undefined);
      // A starter never doubles its own arrow count with reply lines. `routeMode` is deliberately
      // not checked here — like `label`/`condition`, it's an authored escape hatch (opting a
      // connector out of Smart Routing's bundling) that changes nothing about the *derived*
      // semantic/kind asserted above.
      expect(edge.hasResponse).toBeUndefined();
    }
  });

  it('models microservices as service-owned data, never a shared database', () => {
    const { nodes, edges } = buildStarter(starterById('microservices')!, { x: 0, y: 0 });
    const stores = nodes.filter((node) => node.type === 'database');
    expect(stores).toHaveLength(3);
    // Each store is written by exactly one service, and each service writes exactly one store.
    for (const store of stores) {
      const writers = edges.filter((edge) => edge.target === store.id);
      expect(writers).toHaveLength(1);
      expect(writers[0]!.semantic).toBe('writes');
    }
    // Every service sits inside its own deployment boundary, and no two share one.
    const boundaries = nodes.filter((node) => node.boundaryPreset === 'deployment');
    expect(boundaries).toHaveLength(3);
    expect(new Set(nodes.filter((node) => node.parentId).map((node) => node.parentId)).size).toBe(3);
    // No service calls another service: the whole point of the gateway fan.
    const services = new Set(nodes.filter((node) => node.type === 'service').map((node) => node.id));
    const gateway = nodes.find((node) => node.serviceKind === 'gateway')!;
    for (const edge of edges) {
      if (edge.source === gateway.id) continue;
      expect(services.has(edge.source) && services.has(edge.target)).toBe(false);
    }
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
    const database = nodes.find((node) => node.databaseKind === 'sql')!;
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
  });

  it('models event-driven flow as one producer publishing to a topic that fans out to three named architectural reactions', () => {
    const { nodes, edges } = buildStarter(starterById('event-driven')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const edgesFrom = (id: string) => edges.filter((e) => e.source === id);
    const edgesTo = (id: string) => edges.filter((e) => e.target === id);

    const producer = byText('Producer Service');
    const topic = byText('Domain Events');
    const projection = byText('Projection Service');
    const processing = byText('Processing Service');
    const integration = byText('Integration Service');
    const store = byText('Read Store');

    expect(nodes.filter((n) => n.queueKind === 'topic')).toHaveLength(1);
    expect(topic.type).toBe('queue');

    // Published to exactly once, quietly (no override on the publish itself) — the producer's only edge.
    const published = edgesTo(topic.id);
    expect(published).toHaveLength(1);
    expect(published[0]!.source).toBe(producer.id);
    expect(published[0]!.semantic).toBe('publishes');
    expect(published[0]!.label).toBeUndefined();
    expect(edgesFrom(producer.id)).toHaveLength(1);

    // Fans out to exactly three independent reactions, each an inferred `deliversTo`/`event`
    // relationship displayed as "consumes" (the one deliberate display override in this starter) and
    // kept out of Smart Routing's bundling — three individual rays, never one shared delivery bus.
    const delivered = edgesFrom(topic.id);
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered.map((e) => e.target))).toEqual(new Set([projection.id, processing.id, integration.id]));
    for (const edge of delivered) {
      expect(edge.semantic).toBe('deliversTo');
      expect(edge.kind).toBe('event');
      expect(edge.label).toBe('consumes');
      expect(edge.routeMode).toBe('direct');
    }

    // Every consumer is a plain, generic Service — never defaulted to Worker.
    for (const consumer of [projection, processing, integration]) {
      expect(consumer.type).toBe('service');
      expect(consumer.serviceKind).toBe('generic');
    }

    // Only Projection Service owns a store — not one under every column, and no reaction chains back
    // into the topology (no second event, no reply, no call to the producer).
    expect(nodes.filter((n) => n.type === 'database')).toHaveLength(1);
    const writes = edgesTo(store.id);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.source).toBe(projection.id);
    expect(writes[0]!.semantic).toBe('writes');
    expect(edgesFrom(projection.id)).toEqual([writes[0]]);
    expect(edgesFrom(processing.id)).toHaveLength(0);
    expect(edgesFrom(integration.id)).toHaveLength(0);

    // Exactly five edges, exactly one event name — nothing scattered, nothing chained.
    expect(edges).toHaveLength(5);
    const eventLabel = byText('DomainEvent');
    expect(eventLabel.type).toBe('text');
    expect(eventLabel.annotation).toBe(true);
    expect(eventLabel.parentId).toBeUndefined();
  });

  it('keeps hexagonal technology outside the core and its ports on one vertical axis each', () => {
    const starter = starterById('hexagonal')!;
    const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
    const core = nodes.find((node) => node.type === 'group')!;
    const inside = new Set(nodes.filter((node) => node.parentId === core.id).map((node) => node.id));
    for (const node of nodes) {
      if (inside.has(node.id) || node.id === core.id) continue;
      // Adapters, technology and band labels all live outside the core's rectangle.
      expect(overlaps(node, core)).toBe(false);
    }
    expect(nodes.filter((node) => node.databaseKind === 'sql')).toHaveLength(1);
    expect(nodes.filter((node) => node.serviceKind === 'external')).toHaveLength(1);
    // Two connectors point into the core and two point out of it — the dependency story.
    expect(edges.filter((edge) => inside.has(edge.target) && !inside.has(edge.source))).toHaveLength(2);
    expect(edges.filter((edge) => inside.has(edge.source) && !inside.has(edge.target))).toHaveLength(2);
  });

  // The whole point of the Component/Label vocabulary pass: the driving adapters stay real
  // Services (they're genuine runtime roles), everything logical inside/around the core is a
  // Component, and no relationship ever rides on a Condition.
  it('uses Component (never Service) for every internal architectural piece, honestly', () => {
    const { nodes, edges } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;

    expect(byText('REST API').type).toBe('service');
    expect(byText('REST API').serviceKind).toBe('api');
    expect(byText('Message Consumer').type).toBe('service');
    expect(byText('Message Consumer').serviceKind).toBe('worker');

    expect(byText('Use Cases')).toMatchObject({ type: 'component', componentKind: 'generic' });
    expect(byText('Domain Model')).toMatchObject({ type: 'component', componentKind: 'generic' });
    expect(byText('Persistence Adapter')).toMatchObject({ type: 'component', componentKind: 'adapter' });
    expect(byText('Integration Adapter')).toMatchObject({ type: 'component', componentKind: 'adapter' });

    expect(nodes.some((n) => n.type === 'service' && n.serviceKind === undefined)).toBe(false);

    // No Condition anywhere in this starter — a port designation was never a condition.
    expect(edges.every((e) => e.condition === undefined)).toBe(true);
  });

  // A later refinement pass removed "Inbound Port"/"Outbound Port" edge labels entirely: they hid
  // each connector's actual relationship (all four quietly defaulted to `calls` underneath) behind
  // a position in the architecture, and rode the app's more prominent label-chip style while doing
  // it. Every crossing connector now carries no `label` override at all — `component>component`
  // has its own exact `MATRIX` row (default relation `uses`) in `connectorSemantics.ts`, so the
  // internal/driven side infers `uses` naturally, through the same quiet caption style `calls`
  // already used on the driving side, never a bordered chip standing in for a port name.
  it('lets every crossing connector read its own natural relationship, quietly — never a port name', () => {
    const { nodes, edges } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const byText = (t: string) => nodes.find((n) => n.text === t)!;
    const edgeBetween = (fromText: string, toText: string) => {
      const from = byText(fromText).id;
      const to = byText(toText).id;
      return edges.find((e) => e.source === from && e.target === to)!;
    };

    for (const [fromText, toText] of [
      ['REST API', 'Use Cases'],
      ['Message Consumer', 'Use Cases'],
    ] as const) {
      const edge = edgeBetween(fromText, toText);
      expect(edge.label).toBeUndefined();
      expect(edge.semantic).toBe('calls');
    }

    for (const [fromText, toText] of [
      ['Use Cases', 'Domain Model'],
      ['Use Cases', 'Persistence Adapter'],
      ['Use Cases', 'Integration Adapter'],
    ] as const) {
      const edge = edgeBetween(fromText, toText);
      expect(edge.label).toBeUndefined();
      expect(edge.semantic).toBe('uses');
    }

    // Persistence Adapter → Database and Integration Adapter → External System are untouched by
    // this pass — reads/writes and calls are already the right words for genuine infrastructure.
    expect(edgeBetween('Persistence Adapter', 'Database').label).toBeUndefined();
    expect(edgeBetween('Integration Adapter', 'External System').label).toBeUndefined();
  });

  // A later revision restored the "Inbound ports"/"Outbound ports" terminology this same pass had
  // removed — but as exactly one plain Label annotation per side (never a per-connector caption),
  // exactly the "Label / edge annotation, never Condition" mechanism the vocabulary rules require.
  it('names each side of the core with exactly one quiet Label — never a Condition, Note, Component, or Service standing in', () => {
    const { nodes } = buildStarter(starterById('hexagonal')!, { x: 0, y: 0 });
    const inbound = nodes.filter((n) => n.text === 'Inbound ports');
    const outbound = nodes.filter((n) => n.text === 'Outbound ports');
    expect(inbound).toHaveLength(1);
    expect(outbound).toHaveLength(1);
    for (const label of [...inbound, ...outbound]) {
      expect(label.type).toBe('text');
      expect(label.annotation).toBe(true);
      expect(label.parentId).toBeUndefined();
    }
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
  it('routes every straight-authored connector as an actual straight line, not a hidden detour', () => {
    for (const starter of ARCHITECTURE_STARTERS) {
      const { nodes, edges } = buildStarter(starter, { x: 0, y: 0 });
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const edge of edges) {
        const source = byId.get(edge.source)!;
        const target = byId.get(edge.target)!;
        const sourceX = source.x + source.width * (edge.sourceAnchor?.offset ?? 0.5);
        const targetX = target.x + target.width * (edge.targetAnchor?.offset ?? 0.5);
        const sourceIsVertical = edge.sourceAnchor?.side === 'top' || edge.sourceAnchor?.side === 'bottom';
        const targetIsVertical = edge.targetAnchor?.side === 'top' || edge.targetAnchor?.side === 'bottom';
        if (!sourceIsVertical || !targetIsVertical || Math.abs(sourceX - targetX) > 0.5) continue;

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
});
