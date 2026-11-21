import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityFor, categoryOf } from '../src/document/connectorSemantics';
import { relationshipCaptionLabel } from '../src/document/edgeSemantics';
import { createDocument, createNode, defaultSizeFor, defaultTextFor, displayNameFor, minSizeFor } from '../src/document/factory';
import { DEFAULTS } from '../src/document/limits';
import { anchorBandOf } from '../src/document/queueGeometry';
import { deserializeDocument, serializeDocument } from '../src/export/project';
import { describeContext, describeNode, naturalArchitectureSize } from '../src/nodes/describe';
import { THEMES } from '../src/render/theme/tokens';
import { PERSONALITY_PRESETS } from '../src/theme/usePersonality';
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

  it('Generic keeps the card; Module, Adapter and Port take the glyph box a Service glyph does', () => {
    expect(defaultSizeFor('component')).toEqual({ width: DEFAULTS.componentWidth, height: DEFAULTS.componentHeight });
    expect(defaultSizeFor('component', 'generic')).toEqual(defaultSizeFor('component'));
    for (const kind of ['module', 'adapter', 'port'] as const) {
      expect(defaultSizeFor('component', kind)).toEqual(defaultSizeFor('service', 'worker'));
      expect(minSizeFor('component', kind)).toEqual(minSizeFor('service', 'worker'));
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
    // A Component folds to `service` for the matrix, so it gets `service>database`'s default: the
    // store beside it is "its database", read and written.
    expect(edge.semantic).toBe('readsWrites');
    store.getState().updateNodeById(a.id, { componentKind: 'adapter' });
    // Component's kinds never change `categoryOf`'s result (see connectorSemantics tests below),
    // so this is a no-op re-inference — asserting it *doesn't* go stale is still the point.
    expect(store.getState().document.edges[0]!.semantic).toBe('readsWrites');
  });

  it('takes the box the new drawing needs when the kind moves between the card and a glyph, around the same centre', () => {
    const node = store.getState().addNode({ type: 'component', x: 40, y: 60 });
    const centre = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
    store.getState().updateNodeById(node.id, { componentKind: 'adapter' });
    const glyph = store.getState().document.nodes[0]!;
    expect({ width: glyph.width, height: glyph.height }).toEqual(defaultSizeFor('component', 'adapter'));
    expect(glyph.x + glyph.width / 2).toBeCloseTo(centre.x, 0);
    expect(glyph.y + glyph.height / 2).toBeCloseTo(centre.y, 0);
    store.getState().updateNodeById(node.id, { componentKind: 'generic' });
    const card = store.getState().document.nodes[0]!;
    expect({ width: card.width, height: card.height }).toEqual(defaultSizeFor('component'));
  });

  it('keeps its box between two glyph kinds: a Port resized by hand is the same size as an Adapter', () => {
    const node = store.getState().addNode({ type: 'component', componentKind: 'port', x: 40, y: 60, width: 200, height: 150 });
    store.getState().updateNodeById(node.id, { componentKind: 'adapter' });
    expect(store.getState().document.nodes[0]).toMatchObject({ x: 40, y: 60, width: 200, height: 150 });
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

describe('Component — visual family: a card, and three glyphs in one notation', () => {
  const nodeFor = (kind: ComponentKind) => ({
    id: 'n',
    type: 'component' as const,
    x: 0,
    y: 0,
    z: 0,
    ...defaultSizeFor('component', kind),
    text: '',
    componentKind: kind,
  });
  const ctx = describeContext(THEMES.light, 'clean');
  type Drawn = ReturnType<typeof describeNode>['shapes'][number];
  const flat = (shapes: Drawn[]): Drawn[] => shapes.flatMap((s) => (s.t === 'group' ? flat(s.children as Drawn[]) : [s]));
  const drawn = (kind: ComponentKind) => flat(describeNode(nodeFor(kind), ctx).shapes);

  it('every kind renders something (never an empty shape list)', () => {
    for (const kind of COMPONENT_KINDS) {
      expect(describeNode(nodeFor(kind), ctx).shapes.length).toBeGreaterThan(0);
    }
  });

  it('Generic is one card the size of its box; no glyph kind draws a body that size', () => {
    const fullWidth = (kind: ComponentKind) => drawn(kind).filter((s) => s.t === 'rect' && s.w > nodeFor(kind).width - 4);
    expect(fullWidth('generic')).toHaveLength(1);
    for (const kind of ['module', 'adapter', 'port'] as const) expect(fullWidth(kind)).toHaveLength(0);
  });

  it('draws the three glyph kinds differently from one another', () => {
    const signature = (kind: ComponentKind) => JSON.stringify(drawn(kind).filter((s) => s.t !== 'text'));
    const signatures = (['module', 'adapter', 'port'] as const).map(signature);
    expect(new Set(signatures).size).toBe(3);
  });

  it("a Port's ball is the size of the cup an Adapter holds it in", () => {
    const ball = drawn('port').find((s) => s.t === 'ellipse')!;
    const cup = drawn('adapter').find((s) => s.t === 'path' && /A/.test(s.d))!;
    expect(ball.t === 'ellipse' && ball.rx).toBe(7.5);
    // The cup's arc is one pixel wider all round, so a ball drawn into it would sit clear of it.
    expect(cup.t === 'path' && cup.d).toContain('A8.5,8.5');
  });

  it('a Port holds a name and its PORT tag under the glyph, inside its own box', () => {
    const port = createNode({ type: 'component', componentKind: 'port', text: 'Persistence', x: 0, y: 0 });
    const texts = flat(describeNode(port, ctx).shapes).filter((s) => s.t === 'text');
    expect(texts.map((s) => s.layout.lines.map((l) => l.text).join(''))).toEqual(['Persistence', 'PORT']);
    for (const shape of texts) {
      expect(shape.layout.truncated).toBe(false);
      expect(shape.y).toBeGreaterThanOrEqual(0);
      expect(shape.y + shape.layout.height).toBeLessThanOrEqual(port.height);
    }
    expect(texts[0]!.y + texts[0]!.layout.height).toBeLessThanOrEqual(texts[1]!.y);
  });

  it('a described glyph kind takes a balanced box, not the widest one around a small glyph', () => {
    // At 280 across, a connector into the glyph's side crossed a hundred pixels of the shape's own
    // empty box and its caption had nowhere to sit but on it: an agent's diagram with a described
    // Adapter failed its readability check (`e2e/desktop/skill-architecture.spec.ts`).
    const adapter = createNode({
      type: 'component',
      componentKind: 'adapter',
      text: 'Peer transport',
      description: 'Carries patches and numbered commits over WebRTC or LAN.',
      technology: 'TypeScript',
      x: 0,
      y: 0,
    });
    const size = naturalArchitectureSize(adapter, ctx);
    expect(size.fits).toBe(true);
    expect(size.width).toBeLessThanOrEqual(200);
    expect(size.height).toBeLessThanOrEqual(Math.max(adapter.height, size.width));
  });

  it('connectors meet a glyph kind at its glyph, and a Generic card at its box', () => {
    expect(anchorBandOf({ ...nodeFor('generic') })).toBeUndefined();
    for (const kind of ['module', 'adapter', 'port'] as const) {
      const band = anchorBandOf({ ...nodeFor(kind) })!;
      expect(band.left).toBeGreaterThan(0);
      expect(band.right).toBeLessThan(nodeFor(kind).width);
      expect(band.bottom).toBeLessThan(nodeFor(kind).height / 2 + 10);
    }
  });

  it('Module, Adapter and Port each carry their kind under the name; Generic carries none', () => {
    const captionOf = (kind: ComponentKind) =>
      drawn(kind)
        .filter((s) => s.t === 'text')
        .map((s) => s.layout.lines.map((line) => line.text).join(''));
    expect(captionOf('generic')).toEqual([]);
    expect(captionOf('module')).toContain('MODULE');
    expect(captionOf('adapter')).toContain('ADAPTER');
    expect(captionOf('port')).toContain('PORT');
  });

  it("does not depend on colour alone — the same distinction holds with every accent, including a colour-neutral one", () => {
    for (const accent of ['neutral', 'teal', 'blue'] as const) {
      const marks = (kind: ComponentKind) =>
        flat(describeNode({ ...nodeFor(kind), accent }, ctx).shapes)
          .filter((s) => s.t !== 'text')
          .map((s) => s.t)
          .join(' ');
      expect(marks('generic')).not.toBe(marks('adapter'));
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
    expect(componentToDatabase?.defaultRelation).toBe('readsWrites');

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
      // `none` is the absence of a paint, not a colour that could be off-theme.
      if (color === 'none') continue;
      expect(themeColors.has(color), `${color} is not a theme token`).toBe(true);
    }
  });
});

describe('relationshipCaptionLabel — Component pairings read like any other', () => {
  it('labels a Component→Datastore connector "writes", not something bespoke', () => {
    expect(relationshipCaptionLabel('writes')).toBe('writes to');
  });
});
