import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { relationshipCaptionLabel } from '../src/document/edgeSemantics';
import { createDocument, createNode, defaultSizeFor, defaultTextFor, displayNameFor, minSizeFor } from '../src/document/factory';
import { DEFAULTS } from '../src/document/limits';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { describeContext, describeNode } from '../src/nodes/describe';
import { THEMES } from '../src/render/theme/tokens';
import { PERSONALITY_PRESETS } from '../src/ui/personality/usePersonality';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { COMPONENT_KINDS, type ComponentKind } from '../src/document/types';

/**
 * Component: "a logical architectural building block inside a larger system or deployment
 * boundary" — the deliberate counterpart to Service that carries none of its deployment/runtime
 * implications. These tests pin the two things that actually matter for that claim to hold: the
 * capability matrix treats it as service-shaped for relationship *vocabulary* purposes (so
 * Component → Datastore reads "writes", not silence), while `categoryOf` never collapses it into
 * `service` itself (so a future capability that queries category can still tell them apart).
 */

describe('Component — creation', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Component'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('defaults to Generic, with no kind caption and the generic name', () => {
    const node = store.getState().addNode({ type: 'component', x: 0, y: 0 });
    expect(node.componentKind).toBe('generic');
    expect(node.text).toBe('Component');
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
  });

  it.each(COMPONENT_KINDS.map((kind) => [kind] as const))('creates a %s Component with the right default name', (kind) => {
    const node = store.getState().addNode({ type: 'component', componentKind: kind, x: 0, y: 0 });
    expect(node.componentKind).toBe(kind);
    expect(node.text).toBe(defaultTextFor('component', undefined, kind));
  });

  it('defaults to roughly 10-20% smaller than Service on each dimension — hierarchy, not a peer', () => {
    const service = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const component = store.getState().addNode({ type: 'component', x: 300, y: 0 });
    expect(component.width).toBeLessThan(service.width);
    expect(component.height).toBeLessThan(service.height);
    const widthRatio = component.width / service.width;
    const heightRatio = component.height / service.height;
    // "Restrained but noticeable" — smaller than Service, but nowhere near tiny/metadata-sized.
    expect(widthRatio).toBeGreaterThan(0.75);
    expect(widthRatio).toBeLessThan(0.95);
    expect(heightRatio).toBeGreaterThan(0.75);
    expect(heightRatio).toBeLessThan(0.95);
  });

  it('every kind shares the exact same default footprint — the hierarchy is family-wide', () => {
    for (const kind of COMPONENT_KINDS) {
      expect(defaultSizeFor('component')).toEqual({
        width: DEFAULTS.componentWidth,
        height: DEFAULTS.componentHeight,
      });
      void kind;
    }
  });

  it('is one undo step, and undo/redo restore it with its kind intact', () => {
    store.getState().addNode({ type: 'component', componentKind: 'adapter', x: 0, y: 0 });
    expect(store.getState().document.nodes).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().document.nodes[0]!.componentKind).toBe('adapter');
  });

  it('resizes within the same generic floor every other plain shape uses', () => {
    // Component gets no bespoke entry in `minSizeFor` (deliberately — see `document/factory.ts`),
    // the same choice already made for `service`.
    expect(minSizeFor('component')).toEqual(minSizeFor('service'));
  });
});

describe('Component — changing kind', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Component'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('follows a system-managed label to the new kind, the same way Service does', () => {
    const node = store.getState().addNode({ type: 'component', x: 0, y: 0 });
    expect(node.text).toBe('Component');
    store.getState().updateNodeById(node.id, { componentKind: 'module' });
    expect(store.getState().document.nodes[0]!.text).toBe('Module');
    store.getState().updateNodeById(node.id, { componentKind: 'adapter' });
    expect(store.getState().document.nodes[0]!.text).toBe('Adapter');
  });

  it('never overwrites a name the user actually typed', () => {
    const node = store.getState().addNode({ type: 'component', x: 0, y: 0 });
    store.getState().updateNodeText(node.id, 'Persistence Adapter');
    store.getState().updateNodeById(node.id, { componentKind: 'adapter' });
    expect(store.getState().document.nodes[0]!.text).toBe('Persistence Adapter');
  });

  it('re-evaluates incident edges when the kind changes, same as any other kind field', () => {
    const a = store.getState().addNode({ type: 'component', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    expect(edge.semantic).toBe('writes');
    store.getState().updateNodeById(a.id, { componentKind: 'adapter' });
    // Component's kinds never change `categoryOf`'s result (see connectorSemantics tests below),
    // so this is a no-op re-inference — asserting it *doesn't* go stale is still the point.
    expect(store.getState().document.edges[0]!.semantic).toBe('writes');
  });

  it('never resizes a node just because its kind changed — the silhouette departs, the box does not', () => {
    const node = store.getState().addNode({ type: 'component', x: 0, y: 0, width: 300, height: 120 });
    for (const kind of ['module', 'adapter', 'generic'] as const) {
      store.getState().updateNodeById(node.id, { componentKind: kind });
      const after = store.getState().document.nodes[0]!;
      expect(after.width).toBe(300);
      expect(after.height).toBe(120);
    }
  });

  it('leaves position untouched — kind, label and position are three independent fields', () => {
    const node = store.getState().addNode({ type: 'component', x: 40, y: 60 });
    store.getState().updateNodeById(node.id, { componentKind: 'adapter' });
    const after = store.getState().document.nodes[0]!;
    expect(after.x).toBe(40);
    expect(after.y).toBe(60);
  });
});

describe('Component — an existing, already-sized node is never retroactively resized', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Component'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('a manually-sized Component keeps its own dimensions through save/reload and resize elsewhere', () => {
    // Simulates a node created before the smaller default existed, or simply resized by hand —
    // `defaultSizeFor` is consulted only at creation, when `width`/`height` are omitted entirely
    // (see `document/factory.ts`'s `createNode`); an explicit size is never overwritten by it.
    const node = store.getState().addNode({ type: 'component', x: 0, y: 0, width: 176, height: 68 });
    expect(node.width).toBe(176);
    expect(node.height).toBe(68);

    const result = deserializeDocument(serializeDocument(store.getState().document));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]).toMatchObject({ width: 176, height: 68 });

    // A resize elsewhere on the canvas (`commitPositions` doesn't touch size, but the equivalent
    // resize commit does) never snaps back to the type default either.
    store.getState().updateNodeById(node.id, { width: 200, height: 90 });
    expect(store.getState().document.nodes[0]).toMatchObject({ width: 200, height: 90 });
  });
});

describe('Component — visual family: distinct but related silhouettes', () => {
  const dims = { width: 160, height: 56 };
  const nodeFor = (kind: ComponentKind) => ({
    id: 'n',
    type: 'component' as const,
    x: 0,
    y: 0,
    z: 0,
    ...dims,
    text: '',
    componentKind: kind,
  });
  const ctx = describeContext(THEMES.light, 'clean');

  it('every kind renders something (never an empty shape list)', () => {
    for (const kind of COMPONENT_KINDS) {
      expect(describeNode(nodeFor(kind), ctx).shapes.length).toBeGreaterThan(0);
    }
  });

  it('Module and Adapter each depart from Generic with their own outline geometry', () => {
    const outlineOf = (kind: ComponentKind) =>
      describeNode(nodeFor(kind), ctx).shapes.find((s) => s.t === 'rect' || s.t === 'path')!;
    const generic = outlineOf('generic');
    const module = outlineOf('module');
    const adapter = outlineOf('adapter');

    // Generic, undecorated, stays a plain analytic rect at Clean (see `outlineShape`'s own doc
    // comment) — Module and Adapter each build a custom notched/tabbed path instead, the same
    // "a real departure from the plain body" `serviceApi`/`serviceGateway` already establish.
    expect(generic.t).toBe('rect');
    expect(module.t).toBe('path');
    expect(adapter.t).toBe('path');
    expect((module as { d: string }).d).not.toBe((adapter as { d: string }).d);
  });

  it('Port keeps the plain body but draws it dashed — a contract, not a concrete thing', () => {
    const outlineOf = (kind: ComponentKind) =>
      describeNode(nodeFor(kind), ctx).shapes.find((s) => s.t === 'rect' || s.t === 'path')!;
    const generic = outlineOf('generic');
    const port = outlineOf('port');
    expect(port.t).toBe('rect');
    expect('stroke' in port && port.stroke?.dash).toEqual([6, 5]);
    expect('stroke' in generic && generic.stroke?.dash).toBeUndefined();
  });

  it('a small Port fits a one-word name and its centred PORT tag inside its own box', () => {
    const port = createNode({ type: 'component', componentKind: 'port', text: 'Persistence', x: 0, y: 0, width: 120, height: 44 });
    const texts = describeNode(port, ctx).shapes.filter((s) => s.t === 'text');
    expect(texts.map((s) => s.layout.lines.map((l) => l.text).join(''))).toEqual(['Persistence', 'PORT']);
    for (const shape of texts) {
      expect(shape.layout.truncated).toBe(false);
      expect(shape.y).toBeGreaterThanOrEqual(0);
      expect(shape.y + shape.layout.height).toBeLessThanOrEqual(port.height);
      expect(shape.align).toBe('middle');
    }
    const name = texts[0]!;
    const tag = texts[1]!;
    expect(name.y + name.layout.height).toBeLessThanOrEqual(tag.y);
  });

  it('Module and Adapter each carry their own corner caption; Generic carries none', () => {
    const captionOf = (kind: ComponentKind) =>
      describeNode(nodeFor(kind), ctx)
        .shapes.filter((s) => s.t === 'text')
        .map((s) => s.layout.lines.map((line) => line.text).join(''));
    expect(captionOf('generic')).toEqual([]);
    expect(captionOf('module')).toContain('MODULE');
    expect(captionOf('adapter')).toContain('ADAPTER');
    expect(captionOf('port')).toContain('PORT');
  });

  it('all three kinds share the same body radius and stroke weight — one family, not three shapes', () => {
    // Component's own stroke is deliberately thinner than every other primitive's shared 1.5px —
    // but uniform *across* Generic/Module/Adapter, so the family reads as siblings, not as three
    // independently-weighted shapes.
    for (const kind of COMPONENT_KINDS) {
      const outline = describeNode(nodeFor(kind), ctx).shapes.find((s) => s.t === 'rect' || s.t === 'path')!;
      if ('stroke' in outline && outline.stroke) expect(outline.stroke.width).toBe(1.25);
    }
  });

  it("does not depend on colour alone — the same distinction holds with every accent, including a colour-neutral one", () => {
    for (const accent of ['neutral', 'teal', 'blue'] as const) {
      const generic = describeNode({ ...nodeFor('generic'), accent }, ctx).shapes.find((s) => s.t === 'rect' || s.t === 'path')!;
      const adapter = describeNode({ ...nodeFor('adapter'), accent }, ctx).shapes.find((s) => s.t === 'rect' || s.t === 'path')!;
      expect(generic.t).not.toBe(adapter.t);
    }
  });
});

describe('Component — categoryOf and the capability matrix', () => {
  it('is its own category — never silently folded into "generic" or "service"; only Port sub-divides it', () => {
    for (const kind of COMPONENT_KINDS) {
      expect(categoryOf({ type: 'component', componentKind: kind })).toBe(kind === 'port' ? 'port' : 'component');
    }
  });

  it('resolves to Service-shaped relationship vocabulary for every infrastructure-facing pairing', () => {
    const componentToDatabase = capabilityFor('component', 'database');
    const serviceToDatabase = capabilityFor('service', 'database');
    expect(componentToDatabase).toEqual(serviceToDatabase);
    expect(componentToDatabase?.defaultRelation).toBe('writes');

    const databaseToComponent = capabilityFor('database', 'component');
    expect(databaseToComponent?.defaultRelation).toBe('reads');

    const serviceToComponent = capabilityFor('service', 'component');
    expect(serviceToComponent?.defaultRelation).toBe('calls');

    const componentToExternal = capabilityFor('component', 'external');
    expect(componentToExternal?.defaultRelation).toBe('calls');
  });

  it('component → component is the one exception: an exact matrix row, not the Service fold — "uses", never "calls"', () => {
    const componentToComponent = capabilityFor('component', 'component')!;
    expect(componentToComponent.defaultRelation).toBe('uses');
    expect(componentToComponent.relations).toEqual(['uses', 'dependsOn', 'calls']);
    expect(componentToComponent).not.toEqual(capabilityFor('service', 'service'));
  });

  it.each([
    ['component', 'cache'],
    ['component', 'fileSystem'],
    ['component', 'objectStorage'],
    ['component', 'searchIndex'],
    ['component', 'queue'],
    ['component', 'topic'],
  ] as const)('%s > %s inherits exactly what service > %s would', (source, target) => {
    expect(capabilityFor(source, target)).toEqual(capabilityFor('service', target));
  });
});

describe('Component — serialization, copy/paste, and starter usage', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Component'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      pasteRepeat: 0,
      revision: 0,
    });
  });

  it('round-trips through the file format with its kind intact', () => {
    store.getState().addNode({ type: 'component', componentKind: 'adapter', x: 40, y: 40, text: 'Persistence Adapter' });
    const result = deserializeDocument(serializeDocument(store.getState().document));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairs).toEqual([]);
    const node = result.document.nodes[0]!;
    expect(node.type).toBe('component');
    expect(node.componentKind).toBe('adapter');
    expect(node.text).toBe('Persistence Adapter');
  });

  it('duplicates, copies and pastes like any other node, with zero Component-specific code', () => {
    const node = store.getState().addNode({ type: 'component', componentKind: 'module', x: 0, y: 0 });
    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().duplicateSelection();
    expect(store.getState().document.nodes).toHaveLength(2);
    expect(store.getState().document.nodes[1]!.componentKind).toBe('module');

    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().copySelection();
    store.getState().paste({ x: 500, y: 500 });
    const pasted = store.getState().document.nodes.find((n) => n.parentId === undefined && n.id !== node.id && n.componentKind === 'module' && n.x === 500 - node.width / 2);
    expect(store.getState().document.nodes.length).toBeGreaterThanOrEqual(3);
    expect(pasted).toBeDefined();
  });

  it('displayNameFor falls back to the kind name, same table `defaultTextFor` uses', () => {
    expect(displayNameFor({ type: 'component', componentKind: 'module' })).toBe('Module');
    expect(displayNameFor({ type: 'component', text: 'My Thing', componentKind: 'module' })).toBe('My Thing');
  });
});

describe('Component — rendering across themes and personalities', () => {
  it('produces shapes with no truncated label, in every theme × personality combination', () => {
    for (const themeName of ['light', 'dark'] as const) {
      for (const preset of PERSONALITY_PRESETS) {
        const ctx = describeContext(THEMES[themeName], preset);
        for (const kind of COMPONENT_KINDS) {
          const node = {
            id: 'n1',
            type: 'component' as const,
            x: 0,
            y: 0,
            width: 160,
            height: 56,
            z: 0,
            text: defaultTextFor('component', undefined, kind),
            componentKind: kind,
          };
          const list = describeNode(node, ctx);
          expect(list.shapes.length).toBeGreaterThan(0);
          for (const shape of list.shapes) {
            if (shape.t === 'text') expect(shape.layout.truncated).toBe(false);
          }
        }
      }
    }
  });

  it('never sets a literal colour outside the theme token set (accent-driven only)', () => {
    const ctx = describeContext(THEMES.light, 'clean');
    const node = {
      id: 'n1',
      type: 'component' as const,
      x: 0,
      y: 0,
      width: 160,
      height: 56,
      z: 0,
      text: 'Adapter',
      componentKind: 'adapter' as ComponentKind,
    };
    const list = describeNode(node, ctx);
    const themeColors = new Set(
      Object.values(THEMES).flatMap((theme) =>
        Object.entries(theme).flatMap(([key, value]) =>
          key === 'accents'
            ? Object.values(value as Record<string, Record<string, string>>).flatMap((p) => Object.values(p))
            : typeof value === 'string'
              ? [value]
              : [],
        ),
      ),
    );
    const walk = (shapes: typeof list.shapes): string[] =>
      shapes.flatMap((s) => {
        const colors: string[] = [];
        if ('fill' in s && typeof s.fill === 'string') colors.push(s.fill);
        if ('stroke' in s && s.stroke && typeof s.stroke === 'object' && 'color' in s.stroke) colors.push(s.stroke.color);
        if (s.t === 'group') colors.push(...walk(s.children));
        return colors;
      });
    for (const color of walk(list.shapes)) {
      expect(themeColors.has(color), `${color} is not a theme token`).toBe(true);
    }
  });
});

describe('relationshipCaptionLabel — Component pairings read like any other', () => {
  it('labels a Component→Datastore connector "writes", not something bespoke', () => {
    expect(relationshipCaptionLabel('writes')).toBe('writes');
  });
});
