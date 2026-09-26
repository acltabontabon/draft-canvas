/**
 * The Starters, composed by hand: seven architectures, three data architectures, and three
 * patterns (see `StarterCategory`).
 *
 * Every coordinate here is deliberate. These are canonical diagrams whose structure is known in
 * advance, so the composition is authored rather than solved: hierarchy reads top to bottom (or,
 * for a pipeline, left to right), columns share a gutter, related things align on the same axis,
 * and each starter carries only enough elements to establish its idea — a pattern starter is drawn
 * at the scope of the problem it solves, never grown to look like an architecture. The empty space
 * is part of the design — a starter is the first thirty seconds of a diagram, not a reference
 * architecture, and a real system composes several of them: Hexagonal and CQRS live happily inside
 * a monolith or one microservice, and event-driven integration needs no microservices at all. The
 * seven architectures are seven ideas at seven scopes, never seven rungs of a ladder.
 *
 * Two rules the compositions follow, and one they don't:
 *
 * - **Relationships are never stated here.** `build.ts` derives every connector's semantics from
 *   the capability matrix, so a starter says what it connects and Draft Canvas says what that means.
 *   Where a composition needs a relation other than the pairing's default (`implements` on an
 *   adapter, `reads` on a query), it picks one the matrix already offers for that pairing.
 * - **Anchors are always stated here.** Symmetry is the whole point; leaving `chooseSides` to
 *   re-derive a fan-out's sides would let it drift as soon as anything moves.
 * - Nothing here sets a colour, a font, or a personality. A starter is document content; how it
 *   looks is the canvas's business (`ui/personality/`, `render/theme/tokens.ts`), so a starter is
 *   automatically correct in every theme and every personality.
 *
 * One vocabulary across the seven: a software `Client` (an Actor of kind `system`, a machine — a
 * person is only drawn where a person is meant), `Capability A/B/C` for the business-neutral
 * capabilities a system is cut into, `Application API` for an in-process entry point, `External
 * System` for anything outside the team's control. No loans, orders, payments or customers: a
 * starter is about responsibilities and ownership, and a domain example would only be something
 * to rename first.
 */

import {
  BAND,
  BOUNDARY_HEADER,
  BOUNDARY_HEADER_CAPTION_ONLY,
  BOUNDARY_HEADER_TITLE_ONLY,
  BOUNDARY_PAD,
  BOUNDARY_TITLE_INSET,
  BOUNDARY_TITLE_SUBLINE_Y,
  GUTTER,
  INNER_BAND,
  STACK_GAP,
  SUBTITLE_HEIGHT,
  centeredAt,
  columnsAt,
  columnsFrom,
} from './compose';
import { dataStoreGlyphBounds } from '../document/dataStoreGeometry';
import { queueTubeSpan } from '../document/queueGeometry';
import type { ArchitectureStarter, StarterEdgeSpec, StarterNodeSpec } from './types';

/* ------------------------------------------------------------------ sizes -- */
/** Mirrors of `document/limits.ts`'s `DEFAULTS`, named for what they are here. Authoring against
 *  literals keeps every coordinate below arithmetically checkable by eye. */
const SERVICE = { width: 176, height: 68 };
const STORE = { width: 172, height: 102 };
/** The queue-family box — Queue, Topic and DLQ all share it. */
const QUEUE = { width: 140, height: 48 };
/** The same box for a queue-family node that carries a name (`DEFAULTS.queueNamedHeight`): the
 *  name and kind caption stack under the tube and need the extra height to stay inside the box. */
const NAMED_QUEUE = { width: QUEUE.width, height: 72 };
/** A `table` Data Store. The box is a store's box: what is deliberately shorter than a cylinder is
 *  the *card* (`dataStoreTable` draws it 4px shorter, and flat), and the box has to hold the name
 *  and kind caption underneath it like every other kind's does. It used to be pinned at 64, which
 *  is less than the caption alone needs — the kind label overflowed onto whatever the starter put
 *  below the card, which is exactly what Medallion's layer descriptors are. Making the box shorter
 *  again cannot work: the glyph scales with the box, so the caption moves down with it. */
const TABLE = { width: STORE.width, height: STORE.height };
const ACTOR = { width: 120, height: 92 };
/** Component's own default footprint (`DEFAULTS.componentWidth`/`componentHeight`) — an internal
 *  piece that is not a diagram's hero sits at exactly this, so it reads as *contained* next to the
 *  Services around it. */
const COMPONENT = { width: 152, height: 56 };
const TOP: StarterEdgeSpec['sourceAnchor'] = { side: 'top', offset: 0.5 };
const BOTTOM: StarterEdgeSpec['sourceAnchor'] = { side: 'bottom', offset: 0.5 };
const LEFT: StarterEdgeSpec['sourceAnchor'] = { side: 'left', offset: 0.5 };
const RIGHT: StarterEdgeSpec['sourceAnchor'] = { side: 'right', offset: 0.5 };

/**
 * The top edge that puts a queue-family node's *tube* (not its box) on the axis `cy` — the
 * counterpart of `centeredAt` for the one node whose drawn glyph sits above its box centre. Routing
 * lands a left/right connector on the tube band (`anchorBandOf`), so this is what makes a level
 * line into a topic actually level.
 */
function tubeCenteredAt(cy: number, height: number): number {
  const span = queueTubeSpan(height);
  return Math.round(cy - (span.top + span.bottom) / 2);
}

/**
 * How far below a Data Store's top edge its glyph is centred. Every kind shares it
 * (`dataStoreGlyphBounds`), a cylinder and a table alike — but *size* matters: the glyph grows
 * with a box bigger than its unit one, and the flat `TABLE` card is short enough that it never
 * does while a full `STORE` does. So this takes the box rather than assuming one; a level line
 * between a cylinder and a table is only level if each is placed by its own centre.
 */
function storeGlyphCenter(size: { width: number; height: number }): number {
  const glyph = dataStoreGlyphBounds({ x: 0, y: 0, width: size.width, height: size.height });
  return (glyph.top + glyph.bottom) / 2;
}

const STORE_GLYPH_CENTER = storeGlyphCenter(STORE);
const TABLE_GLYPH_CENTER = storeGlyphCenter(TABLE);

/**
 * The top edge that puts a Data Store's *glyph* (not its box) on the axis `cy` — the counterpart of
 * `tubeCenteredAt` for the other node whose drawn glyph sits above its box centre. Routing lands a
 * left/right connector on the glyph (`anchorBandOf`), so a store on a level line has to be placed by
 * its glyph or the line jogs.
 */
function storeCenteredAt(cy: number, center: number = STORE_GLYPH_CENTER): number {
  return Math.round(cy - center);
}

/** A plain top-to-bottom connection: the default reading direction of every starter. */
function down(from: string, to: string): StarterEdgeSpec {
  return { from, to, sourceAnchor: BOTTOM, targetAnchor: TOP };
}

/** A level, centre-to-centre connection — the reading direction of Hexagonal, and the one line in
 *  each monolith that leaves the application sideways. */
function across(from: string, to: string): StarterEdgeSpec {
  return { from, to, sourceAnchor: RIGHT, targetAnchor: LEFT };
}

/** The same level line drawn the other way — right to left. Hexagonal's implementation arrows,
 *  which point from an adapter *back* into the port it satisfies while the request still travels
 *  left to right around them. */
function back(from: string, to: string): StarterEdgeSpec {
  return { from, to, sourceAnchor: LEFT, targetAnchor: RIGHT };
}

/**
 * The persistence caption every comparison starter shares. `service>database`'s default relation
 * is `writes` and its caption "writes to", which understates a normal application's relationship
 * with its own store — it reads at least as often as it writes. The relation stays the matrix's
 * own (`writes`, inferred, re-inferable); only the words are the starter's.
 */
const READS_WRITES = 'reads / writes';

/**
 * The software client at the top of every request-shaped starter: an Actor of kind `system` — a
 * machine, drawn as a monitor — never the human bust. A person is drawn only where a person is
 * meant; what calls an API is a browser, an app or another program, and calling it a person would
 * put a human on the wrong side of the first arrow. Centred on `cx`, one `BAND` above `y`.
 */
function softwareClient(cx: number, above: number, text = 'Client'): StarterNodeSpec {
  return {
    key: 'client',
    type: 'actor',
    actorKind: 'system',
    text,
    x: centeredAt(cx, ACTOR.width),
    y: above - BAND - ACTOR.height,
    ...ACTOR,
  };
}

/** A title-only boundary's second header line — the shape every subtitled boundary here uses. */
function boundarySubtitle(
  key: string,
  parent: string,
  left: number,
  text: string,
  size: { width: number; height: number },
  top = 0,
): StarterNodeSpec {
  return {
    key,
    type: 'text',
    text,
    annotation: true,
    parent,
    x: left + BOUNDARY_TITLE_INSET,
    y: top + BOUNDARY_TITLE_SUBLINE_Y,
    ...size,
  };
}

/* --------------------------------------------------------------- monolith -- */
/**
 * One deployable application. That is the whole definition — not "one machine", not "one
 * database", not "layers" — so the one element this starter spends everything on is the
 * `DEPLOYMENT` boundary: build it, test it, version it, ship it, as a unit. What is drawn inside it
 * is *one* common way to organise such an application, the classic layers (an inbound API, the
 * application logic, the data access that reaches the store), and the boundary's own note says so.
 *
 * Every layer is a `Component`, never a `Service`: nothing inside one deployable is independently
 * deployable, and the layers talk in-process (`component>component` infers `uses`, never `calls`).
 * `API` and `Data Access` are `adapter` Components — the two places the application translates to
 * and from the outside world; `Application Logic` is a plain Component between them. All three sit
 * at Component's own height, drawn as three equal bands spanning the box: a layered monolith has no
 * hero layer, its hero is the boundary that holds them.
 *
 * `Application Database` is a generic Data Store outside the boundary, directly beneath it — a
 * separate runtime resource, not part of the deployed artifact; which engine it is stays the
 * team's decision. Its connector says `reads / writes` rather than the matrix's default "writes
 * to", because that is what a data-access layer does with its store. `External System` sits
 * outside on the right, level with the layer that calls it — the application logic, which is what
 * decides to call out — so the one line that leaves sideways reads as "this one goes outside".
 *
 * Compact on purpose: the layers stack at `STACK_GAP`, the least room a one-word caption needs
 * between two components inside a box, and the store sits one `INNER_BAND` under the boundary.
 * Only the client keeps a full `BAND` above: its connector crosses the boundary's header row, and
 * that is the room its caption needs to sit clear of the title.
 */
/**
 * A layer is a *band*: Component's own height, but wide enough to span the application the way a
 * layered diagram has always drawn its layers — a layer is the whole application at one level of
 * abstraction, not a box among boxes. The width is also what keeps the client's connector honest:
 * it enters the API layer at the layer's centre, and the `DEPLOYMENT` header (plate, title and
 * caption) is drawn from the boundary's left edge, so a narrow box would run that connector
 * straight through the header text. Wide bands put the centre well clear of it.
 */
const LAYER = { width: 376, height: COMPONENT.height };
const MONOLITH_BOUNDARY_WIDTH = LAYER.width + BOUNDARY_PAD * 2;
const MONOLITH_CX = MONOLITH_BOUNDARY_WIDTH / 2;
const MONOLITH_API_Y = BOUNDARY_HEADER;
const MONOLITH_LOGIC_Y = MONOLITH_API_Y + LAYER.height + STACK_GAP;
const MONOLITH_DATA_Y = MONOLITH_LOGIC_Y + LAYER.height + STACK_GAP;
const MONOLITH_BOUNDARY_HEIGHT = MONOLITH_DATA_Y + LAYER.height + BOUNDARY_PAD;
const MONOLITH_EXTERNAL_X = MONOLITH_BOUNDARY_WIDTH + GUTTER;
/** Wide enough for "Application Database" on one line — a cylinder's caption never wraps. */
const DATABASE_BOX = { width: 176, height: STORE.height };

const monolith: ArchitectureStarter = {
  id: 'monolith',
  category: 'architecture',
  name: 'Monolith',
  description: 'One application, built and deployed as a unit',
  aliases: ['monolith', 'monolithic', 'single deployment', 'one application', 'layered'],
  nodes: [
    softwareClient(MONOLITH_CX, 0),
    {
      key: 'app',
      type: 'group',
      boundaryPreset: 'deployment',
      text: 'Application',
      x: 0,
      y: 0,
      width: MONOLITH_BOUNDARY_WIDTH,
      height: MONOLITH_BOUNDARY_HEIGHT,
      attachments: [
        {
          type: 'note',
          text: 'Built, tested, versioned and deployed as one unit — that is the whole definition. Layers are one common way to organise the inside, not a requirement; nor is one database or one running copy.',
        },
      ],
    },
    {
      key: 'api',
      type: 'component',
      componentKind: 'adapter',
      text: 'API',
      parent: 'app',
      x: centeredAt(MONOLITH_CX, LAYER.width),
      y: MONOLITH_API_Y,
      ...LAYER,
    },
    {
      key: 'logic',
      type: 'component',
      componentKind: 'generic',
      text: 'Application Logic',
      parent: 'app',
      x: centeredAt(MONOLITH_CX, LAYER.width),
      y: MONOLITH_LOGIC_Y,
      ...LAYER,
    },
    {
      key: 'data',
      type: 'component',
      componentKind: 'adapter',
      text: 'Data Access',
      parent: 'app',
      x: centeredAt(MONOLITH_CX, LAYER.width),
      y: MONOLITH_DATA_Y,
      ...LAYER,
    },
    {
      key: 'database',
      type: 'database',
      databaseKind: 'generic',
      text: 'Application Database',
      accent: 'blue',
      x: centeredAt(MONOLITH_CX, DATABASE_BOX.width),
      y: MONOLITH_BOUNDARY_HEIGHT + INNER_BAND,
      ...DATABASE_BOX,
      attachments: [
        { type: 'note', text: 'A separate runtime resource, not part of the deployed artifact. One database is typical, not required.' },
      ],
    },
    {
      // Outside the boundary, level with the layer that calls it, so the arrow crossing the
      // boundary edge is a clean horizontal — "this one leaves the application."
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      text: 'External System',
      accent: 'teal',
      x: MONOLITH_EXTERNAL_X,
      y: centeredAt(MONOLITH_LOGIC_Y + LAYER.height / 2, SERVICE.height),
      ...SERVICE,
    },
  ],
  edges: [
    { key: 'call', ...down('client', 'api') },
    { key: 'dispatch', ...down('api', 'logic') },
    { key: 'access', ...down('logic', 'data') },
    { key: 'persist', ...down('data', 'database'), label: READS_WRITES },
    { key: 'reach', ...across('logic', 'external') },
  ],
  flows: [
    {
      title: 'Handle a request',
      accent: 'green',
      steps: [
        { edgeKey: 'call' },
        { edgeKey: 'dispatch', caption: 'In-process — no network between layers' },
        { edgeKey: 'access' },
        { edgeKey: 'persist' },
      ],
    },
    {
      title: 'Call an external dependency',
      accent: 'amber',
      steps: [{ edgeKey: 'call' }, { edgeKey: 'dispatch' }, { edgeKey: 'reach' }],
    },
  ],
};

/* ------------------------------------------------------- modular monolith -- */
/**
 * The same `DEPLOYMENT` boundary as the Monolith, with the inside cut differently: three peer
 * modules, each an explicitly encapsulated capability, behind one in-process `Application API`.
 * Everything the Monolith starter says about the boundary holds here unchanged — one artifact, one
 * deploy — and the two are drawn on the same axis with the same client, so the comparison is the
 * inside, not the frame. Read against Microservices next to it in the palette, the difference is
 * the frame: three modules in one deployment, three services in three.
 *
 * `Capability A/B/C` are `module` Components (never Services, never their own boundaries — either
 * would turn this into Microservices). The one thing a modular monolith enforces is *how modules
 * may talk*: through each other's public interface, in-process, never into each other's internals
 * or tables. That rule is exactly one connector, `Capability B → Capability C`, captioned
 * `in-process public interface` — "public API" alone can be read as HTTP, and the whole point is
 * that it isn't. A is left fully independent: the point is that a controlled dependency is
 * possible, not that every module needs one. The modules sit a wider gutter apart than the shared
 * `GUTTER` so that caption has a corridor of its own.
 *
 * Data: one `Shared Database` boundary holding one `table` Data Store per module — three schemas
 * of one physical database, each written only by its own module, straight down its own column. Not
 * three cylinders (that would say three database servers, which modularity does not require) and
 * not one cylinder with three arrows into it (which cannot say *which* module owns *what*). The
 * boundary is a `boundary`, not a `deployment`: it groups logically, and its note says a separate
 * schema is enough. Its title is kept short so the leftmost column's connector crosses its top edge
 * clear of the header text; the ownership rule lives in the note rather than a subtitle for the
 * same reason.
 */
const MODULE = { width: 176, height: 76 };
/** Wider than `GUTTER`: the one module-to-module connector carries the starter's longest caption
 *  level between two modules, and the caption has to clear both. */
const MODULE_GUTTER = 168;
const MODULE_COLUMNS = columnsFrom(BOUNDARY_PAD, 3, MODULE.width, MODULE_GUTTER);
const MODULAR_INNER_WIDTH = MODULE_COLUMNS[2]! + MODULE.width - MODULE_COLUMNS[0]!;
const MODULAR_BOUNDARY_WIDTH = MODULAR_INNER_WIDTH + BOUNDARY_PAD * 2;
const MODULAR_CX = MODULAR_BOUNDARY_WIDTH / 2;
const MODULAR_API_Y = BOUNDARY_HEADER;
/** A full `BAND`, not `STACK_GAP`: this is the gap the API → module fan-out plans its shared
 *  trunk across (`edges/bundles.ts`), and a trunk that lands a few pixels above the modules it
 *  feeds reads as a near-miss rather than as routing. */
const MODULAR_MODULES_Y = MODULAR_API_Y + COMPONENT.height + BAND;
const MODULAR_BOUNDARY_HEIGHT = MODULAR_MODULES_Y + MODULE.height + BOUNDARY_PAD;
/** The database boundary is wider than a plain `BOUNDARY_PAD` on each side: its title is drawn at
 *  the left, and the leftmost table's connector — which crosses the boundary's top edge at the
 *  table's centre — has to land right of the title's last letter, not through it. */
const MODULAR_DB_PAD = 64;
const MODULAR_DB_Y = MODULAR_BOUNDARY_HEIGHT + INNER_BAND;
const MODULAR_TABLES_Y = MODULAR_DB_Y + BOUNDARY_HEADER_TITLE_ONLY;
const MODULAR_DB_X = MODULE_COLUMNS[0]! + MODULE.width / 2 - TABLE.width / 2 - MODULAR_DB_PAD;
const MODULAR_DB_WIDTH = MODULE_COLUMNS[2]! + MODULE.width / 2 + TABLE.width / 2 + MODULAR_DB_PAD - MODULAR_DB_X;
const MODULAR_DB_HEIGHT = BOUNDARY_HEADER_TITLE_ONLY + TABLE.height + BOUNDARY_PAD;
const CAPABILITIES = ['A', 'B', 'C'] as const;

const modularMonolith: ArchitectureStarter = {
  id: 'modular-monolith',
  category: 'architecture',
  name: 'Modular Monolith',
  description: 'One deployable, explicitly encapsulated modules inside',
  aliases: [
    'modular monolith',
    'modular architecture',
    'modules',
    'module boundaries',
    'majestic monolith',
    'monolith modules',
  ],
  nodes: [
    softwareClient(MODULAR_CX, 0),
    {
      key: 'app',
      type: 'group',
      boundaryPreset: 'deployment',
      text: 'Application',
      x: 0,
      y: 0,
      width: MODULAR_BOUNDARY_WIDTH,
      height: MODULAR_BOUNDARY_HEIGHT,
      attachments: [
        {
          type: 'note',
          text: 'One artifact, one deploy — the same unit as the Monolith. Module boundaries are enforced at build time (packages, visibility, dependency rules), not by the network.',
        },
      ],
    },
    {
      key: 'api',
      type: 'component',
      componentKind: 'adapter',
      text: 'Application API',
      parent: 'app',
      x: centeredAt(MODULAR_CX, COMPONENT.width),
      y: MODULAR_API_Y,
      ...COMPONENT,
    },
    ...CAPABILITIES.map(
      (letter, index): StarterNodeSpec => ({
        key: `module-${letter.toLowerCase()}`,
        type: 'component',
        componentKind: 'module',
        text: `Capability ${letter}`,
        parent: 'app',
        x: MODULE_COLUMNS[index]!,
        y: MODULAR_MODULES_Y,
        ...MODULE,
      }),
    ),
    {
      key: 'database',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Shared Database',
      x: MODULAR_DB_X,
      y: MODULAR_DB_Y,
      width: MODULAR_DB_WIDTH,
      height: MODULAR_DB_HEIGHT,
      attachments: [
        {
          type: 'note',
          text: 'One physical database, one schema per module. A module reads and writes only its own tables; anything it needs from another module goes through that module’s interface. Separate servers are not required.',
        },
      ],
    },
    ...CAPABILITIES.map(
      (letter, index): StarterNodeSpec => ({
        key: `tables-${letter.toLowerCase()}`,
        type: 'database',
        databaseKind: 'table',
        text: `Capability ${letter} Tables`,
        accent: 'blue',
        parent: 'database',
        x: centeredAt(MODULE_COLUMNS[index]! + MODULE.width / 2, TABLE.width),
        y: MODULAR_TABLES_Y,
        ...TABLE,
      }),
    ),
  ],
  edges: [
    { key: 'call', ...down('client', 'api') },
    // All three leave the same point on the API's bottom edge, so Smart Routing bundles them into
    // one shared trunk with one collapsed "uses" caption — three individual edges in the document
    // model, one deliberate, symmetric fork on screen: one entry point, three capabilities.
    ...CAPABILITIES.map((letter) => ({ ...down('api', `module-${letter.toLowerCase()}`), key: `dispatch-${letter.toLowerCase()}` })),
    // The one controlled, explicit module dependency — see this block's own doc comment.
    { key: 'collaborate', ...across('module-b', 'module-c'), label: 'in-process public interface' },
    // Each module persists straight down into its own tables, and nowhere else.
    ...CAPABILITIES.map((letter) => ({
      ...down(`module-${letter.toLowerCase()}`, `tables-${letter.toLowerCase()}`),
      key: `persist-${letter.toLowerCase()}`,
      label: READS_WRITES,
    })),
  ],
  flows: [
    {
      title: 'Handle a request',
      accent: 'green',
      steps: [{ edgeKey: 'call' }, { edgeKey: 'dispatch-a' }, { edgeKey: 'persist-a', caption: 'Its own tables, nobody else’s' }],
    },
    {
      title: 'Collaborate across modules',
      accent: 'amber',
      steps: [
        { edgeKey: 'call' },
        { edgeKey: 'dispatch-b' },
        { edgeKey: 'collaborate', caption: 'Through C’s public interface — never its internals or tables' },
        { edgeKey: 'persist-c', caption: 'C writes its own tables on B’s behalf' },
      ],
    },
  ],
};

/* --------------------------------------------------------- microservices -- */
/**
 * The frame the two monoliths share, cut three ways: each capability is its own `DEPLOYMENT`, and
 * each owns its data. Read against Modular Monolith, everything that was one box is now three —
 * that is the whole difference, and it is drawn so it cannot be mistaken for the modular monolith
 * with new labels.
 *
 * Each column is two boundaries, deliberately distinct in kind:
 * - An outer `Capability A` boundary (a plain `boundary`: ownership, logical) holds the service
 *   *and* its store — one team, one capability, one set of data nobody else touches.
 * - An inner `DEPLOYMENT` boundary holds the service alone. The store sits *outside* it, below:
 *   a database is a separate runtime resource, and putting it inside the deployment would say it
 *   ships in the same artifact or runs in the same process, which it does not.
 * Ownership does not mean separate servers — three schemas on one instance qualify as long as no
 * service reaches another's — and the first store's note says so.
 *
 * The `API Gateway` is an optional front door, not the pattern's definition: one entry point that
 * `routes` to each service — one trunk, one caption, three branches, each request taking one of
 * them. An earlier revision hung a path rule on every branch as a `condition`; with two boundary
 * headers under the fan the chips landed in the deployment header band, and made-up paths were
 * exactly the kind of example the pattern doesn't need. Its note says clients may also call
 * services directly.
 *
 * Exactly one service-to-service interaction: `Capability B` `calls` `Capability C` — through its
 * API, never its store, the connector's note says. A synchronous call is the simplest honest way
 * to show that services integrate through contracts; asynchronous integration, sagas and retries
 * are the Event-Driven and Saga starters' lessons, one right-click away.
 */
const MICRO_DEPLOY = {
  width: SERVICE.width + BOUNDARY_PAD * 2,
  height: BOUNDARY_HEADER_CAPTION_ONLY + SERVICE.height + BOUNDARY_PAD,
};
const MICRO_OWNER = {
  width: MICRO_DEPLOY.width + BOUNDARY_PAD * 2,
  height: BOUNDARY_HEADER_TITLE_ONLY + MICRO_DEPLOY.height + INNER_BAND + STORE.height + BOUNDARY_PAD,
};
const MICRO_COLUMNS = columnsFrom(0, 3, MICRO_OWNER.width, GUTTER);
const MICRO_CX = (MICRO_COLUMNS[2]! + MICRO_OWNER.width) / 2;
const MICRO_DEPLOY_Y = BOUNDARY_HEADER_TITLE_ONLY;
const MICRO_SERVICE_Y = MICRO_DEPLOY_Y + BOUNDARY_HEADER_CAPTION_ONLY;
const MICRO_STORE_Y = MICRO_DEPLOY_Y + MICRO_DEPLOY.height + INNER_BAND;
/** The gateway's fan plans its trunk a fixed fraction down the corridor to the *services*
 *  (`edges/bundles.ts`'s `TRUNK_BIAS`), two boundary headers below the boxes the trunk has to
 *  visually clear — so the corridor above the boxes is grown by both. */
const MICRO_GATEWAY_BAND = BAND + BOUNDARY_HEADER_TITLE_ONLY + BOUNDARY_HEADER_CAPTION_ONLY;
const MICRO_GATEWAY_Y = -(MICRO_GATEWAY_BAND + SERVICE.height);

const microservices: ArchitectureStarter = {
  id: 'microservices',
  category: 'architecture',
  name: 'Microservices',
  description: 'Independently deployed services, each owning its data',
  aliases: [
    'microservices',
    'microservice',
    'distributed services',
    'independent services',
    'api gateway',
  ],
  nodes: [
    softwareClient(MICRO_CX, MICRO_GATEWAY_Y),
    {
      key: 'gateway',
      type: 'service',
      serviceKind: 'gateway',
      text: 'API Gateway',
      accent: 'teal',
      x: centeredAt(MICRO_CX, SERVICE.width),
      y: MICRO_GATEWAY_Y,
      ...SERVICE,
      attachments: [
        {
          type: 'note',
          text: 'Optional: one entry point for routing, auth and rate limits. Clients may also call services directly — the pattern is the independent services, not the gateway.',
        },
      ],
    },
    ...CAPABILITIES.flatMap((letter, index): StarterNodeSpec[] => {
      const key = letter.toLowerCase();
      const left = MICRO_COLUMNS[index]!;
      const cx = left + MICRO_OWNER.width / 2;
      return [
        {
          key: `owner-${key}`,
          type: 'group',
          boundaryPreset: 'boundary',
          text: `Capability ${letter}`,
          x: left,
          y: 0,
          ...MICRO_OWNER,
        },
        {
          key: `deploy-${key}`,
          type: 'group',
          boundaryPreset: 'deployment',
          text: '',
          parent: `owner-${key}`,
          x: left + BOUNDARY_PAD,
          y: MICRO_DEPLOY_Y,
          ...MICRO_DEPLOY,
        },
        {
          key: `service-${key}`,
          type: 'service',
          serviceKind: 'api',
          text: `Capability ${letter} Service`,
          accent: 'teal',
          parent: `deploy-${key}`,
          x: centeredAt(cx, SERVICE.width),
          y: MICRO_SERVICE_Y,
          ...SERVICE,
        },
        {
          key: `store-${key}`,
          type: 'database',
          databaseKind: 'generic',
          text: `Capability ${letter} Store`,
          accent: 'blue',
          parent: `owner-${key}`,
          x: centeredAt(cx, STORE.width),
          y: MICRO_STORE_Y,
          ...STORE,
          ...(index === 0
            ? {
                attachments: [
                  {
                    type: 'note' as const,
                    text: 'Private to Capability A: no other service reads or writes it. Ownership is logical — a separate schema on a shared instance qualifies; a separate server is not required.',
                  },
                ],
              }
            : {}),
        },
      ];
    }),
  ],
  edges: [
    { key: 'call', ...down('client', 'gateway') },
    ...CAPABILITIES.map((letter) => ({
      ...down('gateway', `service-${letter.toLowerCase()}`),
      key: `route-${letter.toLowerCase()}`,
    })),
    ...CAPABILITIES.map((letter) => ({
      ...down(`service-${letter.toLowerCase()}`, `store-${letter.toLowerCase()}`),
      key: `persist-${letter.toLowerCase()}`,
      label: READS_WRITES,
    })),
    {
      key: 'collaborate',
      ...across('service-b', 'service-c'),
      attachments: [
        { type: 'note', text: 'Through Capability C’s API — its contract — never its store. Events are the other way to integrate; see Event-Driven.' },
      ],
    },
  ],
  flows: [
    {
      title: 'Handle a request',
      accent: 'green',
      steps: [{ edgeKey: 'call' }, { edgeKey: 'route-a' }, { edgeKey: 'persist-a', caption: 'Its own store — nobody else’s' }],
    },
    {
      title: 'Call another service',
      accent: 'amber',
      steps: [
        { edgeKey: 'call' },
        { edgeKey: 'route-b' },
        { edgeKey: 'collaborate', caption: 'A network call to C’s contract, not a query on C’s data' },
        { edgeKey: 'persist-c' },
      ],
    },
  ],
};

/* ---------------------------------------------------------- event-driven -- */
/**
 * Publish/subscribe with a topic and per-subscriber queues — one concrete, common variant of
 * event-driven architecture, named as such in the description so nobody reads it as *the*
 * definition. Read top to bottom: producer → event → topic → fan-out → queue → worker → side
 * effect. Everything else (a second topic, a saga, an outbox, a schema registry, an event store) is
 * a separate, more opinionated starter this one deliberately isn't; event-driven communication
 * needs none of them, and it needs no microservices either.
 *
 * **What each element is, and why it's that and not something else.**
 * - `Producer Service` is a plain generic Service that knows nothing about who reacts — its only
 *   connector goes to the Topic, so a third reaction later is purely a Topic-side change. Its
 *   connector says `publishes state-change event`: a fact that already happened, never a command
 *   dressed up as one. The event's example envelope (an id to dedupe on, a type, a time) and the
 *   delivery caveats — at-least-once, no global ordering, and no atomicity with the state change
 *   that caused it — ride the connector as click-to-reveal attachments.
 * - `Domain Events` is a Topic — the broker is the architecture's centre. Its note is the
 *   pattern's real lesson: every subscription receives its own copy of every event, which is a
 *   different thing from several workers sharing one queue and competing for each message.
 * - The two queues are *named for their responsibility* — `Projection Queue`, `Integration Queue`
 *   — because each is one subscriber's own delivery path, and two anonymous `QUEUE`s would read as
 *   interchangeable. `Topic → Queue` infers `fansOut` (one trunk, one caption) and `Queue → Service`
 *   infers `consumes`; nothing competes for a message and each lane retries on its own terms. A
 *   Queue is deliberately what they are, not a "Subscription" kind: SNS→SQS, an exchange-bound
 *   RabbitMQ queue, a Service Bus subscription and a Kafka consumer group are all this shape.
 * - The consumers are `worker` Services named for what they do: `Projection Worker` maintains a
 *   read model (`Read Store`, reached by `writes`), `Integration Worker` hands off to `External
 *   System` by a solid synchronous `calls` — the one point where the asynchronous architecture
 *   touches a synchronous dependency, and why that lane is the one drawn with failure handling.
 * - One DLQ, beside the Integration queue only, on the inferred dashed `deadLetters` route
 *   captioned `after configured retry limit` — a policy, not a number the architecture depends on.
 *   The route's note names it an illustrative failure path: any subscription can have one.
 *
 * **Routing.** The two `Topic → Queue` connectors bundle into one stem, one trunk and one `fans
 * out` caption; a full `BAND` above the queue row is that trunk's corridor and a full `BAND` above
 * the Topic holds the publish caption. Queue → worker and worker → side-effect gaps are the tighter
 * `INNER_BAND`, so a queue reads as *belonging to* its worker. The DLQ sits a caption's width to
 * the right of its queue, tube to tube, so the failure route is a level line.
 */
const EVENT_LANES = columnsFrom(0, 2, SERVICE.width, GUTTER);
/** A subscription queue carries a two-word name ("Integration Queue") under its tube, which the
 *  named-queue default width wraps; a little wider keeps the name on one line. The topic keeps the
 *  default: its name is shorter, and the queues reading a touch wider than the topic that feeds
 *  them is the right hierarchy — they are where the work of this diagram lands. */
const SUBSCRIPTION_QUEUE = { width: 152, height: NAMED_QUEUE.height };
const EVENT_CX = (EVENT_LANES[1]! + SERVICE.width) / 2;
const EVENT_PRODUCER_Y = 0;
const EVENT_TOPIC_Y = EVENT_PRODUCER_Y + SERVICE.height + BAND;
const EVENT_QUEUE_Y = EVENT_TOPIC_Y + NAMED_QUEUE.height + BAND;
const EVENT_WORKER_Y = EVENT_QUEUE_Y + NAMED_QUEUE.height + INNER_BAND;
const EVENT_SIDE_EFFECT_Y = EVENT_WORKER_Y + SERVICE.height + INNER_BAND;
/** Room for the dead-letter route's "after configured retry limit" caption to sit between its two
 *  tubes with clear air either side. */
const EVENT_DLQ_GAP = 176;
/** The dead-letter route runs tube-to-tube: the sides are pinned so the route is a level line, and
 *  routing itself lands a left/right anchor on the tube glyph (`anchorBandOf`) — the same thing
 *  `addDeadLetterQueue` relies on when it places one interactively. The DLQ is the caption-only
 *  box, and its tube is centred on the named queue's tube so the line stays level. */
const EVENT_DLQ_Y = tubeCenteredAt(EVENT_QUEUE_Y + (queueTubeSpan(NAMED_QUEUE.height).top + queueTubeSpan(NAMED_QUEUE.height).bottom) / 2, QUEUE.height);

function eventLaneCenter(lane: number): number {
  return EVENT_LANES[lane]! + SERVICE.width / 2;
}

const eventDriven: ArchitectureStarter = {
  id: 'event-driven',
  category: 'architecture',
  name: 'Event-Driven',
  description: 'Pub/sub: a topic fanning out to per-subscriber queues',
  aliases: [
    'event driven',
    'event-driven',
    'events',
    'event architecture',
    'pub sub',
    'publish subscribe',
    'messaging',
    'fan out',
    'asynchronous',
    'eda',
  ],
  nodes: [
    {
      key: 'producer',
      type: 'service',
      serviceKind: 'generic',
      text: 'Producer Service',
      accent: 'teal',
      x: centeredAt(EVENT_CX, SERVICE.width),
      y: EVENT_PRODUCER_Y,
      ...SERVICE,
    },
    {
      key: 'topic',
      type: 'queue',
      queueKind: 'topic',
      text: 'Domain Events',
      x: centeredAt(EVENT_CX, NAMED_QUEUE.width),
      y: EVENT_TOPIC_Y,
      ...NAMED_QUEUE,
      attachments: [
        {
          type: 'note',
          text: 'Fan-out, not competition: every subscription gets its own copy of every event. Workers sharing one queue would instead compete for each message.',
        },
      ],
    },
    {
      key: 'projection-queue',
      type: 'queue',
      queueKind: 'queue',
      text: 'Projection Queue',
      x: centeredAt(eventLaneCenter(0), SUBSCRIPTION_QUEUE.width),
      y: EVENT_QUEUE_Y,
      ...SUBSCRIPTION_QUEUE,
    },
    {
      key: 'integration-queue',
      type: 'queue',
      queueKind: 'queue',
      text: 'Integration Queue',
      x: centeredAt(eventLaneCenter(1), SUBSCRIPTION_QUEUE.width),
      y: EVENT_QUEUE_Y,
      ...SUBSCRIPTION_QUEUE,
    },
    {
      key: 'projection-worker',
      type: 'service',
      serviceKind: 'worker',
      text: 'Projection Worker',
      accent: 'teal',
      x: EVENT_LANES[0]!,
      y: EVENT_WORKER_Y,
      ...SERVICE,
    },
    {
      key: 'integration-worker',
      type: 'service',
      serviceKind: 'worker',
      text: 'Integration Worker',
      accent: 'teal',
      x: EVENT_LANES[1]!,
      y: EVENT_WORKER_Y,
      ...SERVICE,
    },
    {
      key: 'read-store',
      type: 'database',
      databaseKind: 'generic',
      text: 'Read Store',
      accent: 'blue',
      x: centeredAt(eventLaneCenter(0), STORE.width),
      y: EVENT_SIDE_EFFECT_Y,
      ...STORE,
    },
    {
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      text: 'External System',
      accent: 'teal',
      x: EVENT_LANES[1]!,
      y: EVENT_SIDE_EFFECT_Y,
      ...SERVICE,
    },
    {
      key: 'integration-dlq',
      type: 'queue',
      queueKind: 'queue',
      deliveryRole: 'dead-letter',
      x: centeredAt(eventLaneCenter(1), SUBSCRIPTION_QUEUE.width) + SUBSCRIPTION_QUEUE.width + EVENT_DLQ_GAP,
      y: EVENT_DLQ_Y,
      ...QUEUE,
    },
  ],
  edges: [
    {
      key: 'publish',
      ...down('producer', 'topic'),
      label: 'publishes state-change event',
      attachments: [
        {
          type: 'code',
          text: 'Event envelope',
          language: 'json',
          // The CloudEvents core shape (id/type/time/data): vendor-neutral, and every line short
          // enough to read in the attachment card without scrolling. The id is what a consumer
          // dedupes on; the type is a fact in the past tense.
          code: [
            '{',
            '  "id": "evt_8f3a1c2d",',
            '  "type": "StateChanged",',
            '  "time": "2026-09-10T08:15Z",',
            '  "data": {',
            '    "entityId": "ent_4821"',
            '  }',
            '}',
          ].join('\n'),
        },
        {
          type: 'note',
          text: 'Typically at-least-once and unordered across partitions: consumers dedupe on the event id and tolerate reordering. Publishing is not atomic with the state change that caused it — see Transactional Outbox.',
        },
      ],
    },
    // Both leave the same point on the Topic's bottom edge so Smart Routing bundles them into one
    // trunk with one collapsed `fans out` caption — see this block's doc comment.
    { key: 'fan-out-projection', ...down('topic', 'projection-queue') },
    { key: 'fan-out-integration', ...down('topic', 'integration-queue') },
    { key: 'consume-projection', ...down('projection-queue', 'projection-worker') },
    { key: 'consume-integration', ...down('integration-queue', 'integration-worker') },
    { key: 'project', ...down('projection-worker', 'read-store'), label: 'updates projection' },
    { key: 'call-external', ...down('integration-worker', 'external') },
    {
      key: 'dead-letter',
      from: 'integration-queue',
      to: 'integration-dlq',
      sourceAnchor: RIGHT,
      targetAnchor: LEFT,
      label: 'after configured retry limit',
      attachments: [
        {
          type: 'note',
          noteKind: 'note',
          text: 'An illustrative failure path — any subscription can have one. Poison messages park here for inspection and redrive; alert on depth.',
        },
      ],
    },
  ],
  flows: [
    {
      title: 'Update a projection',
      accent: 'green',
      steps: [
        { edgeKey: 'publish' },
        { edgeKey: 'fan-out-projection', caption: 'This subscription’s own copy' },
        { edgeKey: 'consume-projection' },
        { edgeKey: 'project' },
      ],
    },
    {
      title: 'Reach an external system',
      accent: 'amber',
      steps: [
        { edgeKey: 'publish' },
        { edgeKey: 'fan-out-integration', caption: 'The same event, delivered again — independently' },
        { edgeKey: 'consume-integration' },
        { edgeKey: 'call-external' },
      ],
    },
    {
      title: 'Handle a failed delivery',
      accent: 'rose',
      steps: [
        { edgeKey: 'fan-out-integration' },
        { edgeKey: 'dead-letter', caption: 'Parked after the configured retries, without blocking the lane' },
      ],
    },
  ],
};

/* ------------------------------------------------------------- hexagonal -- */
/**
 * Ports and adapters, drawn left to right — inbound adapters → **port** → application core →
 * **ports** → outbound adapters → technology — with the one thing the pattern exists for made
 * visible: the core owns its ports, and every dependency points *into* it.
 *
 * **Two kinds of arrow, deliberately told apart.** A request still travels left to right: an
 * adapter `calls` the inbound port, the use cases `use` the domain model and the outbound ports,
 * an adapter `writes` the database or `calls` the external system — solid heads, the words of
 * runtime. The three arrows that point the *other* way are not runtime at all: `Use Cases`
 * `implements` the inbound port, and each outbound adapter `implements` its port. They point from
 * the implementer to the contract, which is the way the source dependency points — adapters depend
 * on the core, the core depends on nothing outside itself — and they wear the hollow head every
 * realization gets (`edges/kindStyle.ts`), so they read as a different kind of line before their
 * caption does. An earlier revision drew these as `implemented by` in the runtime direction and
 * captioned the core "dependencies point inward"; the words were true and the arrows said the
 * opposite. Now the arrows say it. Presentation walks only the runtime arrows: a flow is an
 * execution, and a realization is not a step of one.
 *
 * **What each element is.**
 * - `HTTP Adapter` and `Message Consumer` are `adapter` Components, not Services: a controller and
 *   a listener are in-process translation layers, the driving mirror of the persistence and
 *   integration adapters on the right — the same notched silhouette on both sides of the core. Two
 *   different inbound technologies driving one port is what says "the core does not know how it
 *   was called."
 * - `Inbound`, `Persistence`, `Integration` are `port` Components inside the core — dashed, small,
 *   captioned `PORT`. One inbound port, not two: both adapters call the same use cases, and a
 *   shared contract is the honest picture of that. Two outbound ports, because persistence and
 *   integration are genuinely different needs. Nothing says a real system has three; it has as
 *   many as it has distinct conversations with the outside.
 * - `Use Cases` and `Domain Model` are plain Components inside the core — `Domain Model` hangs
 *   beneath `Use Cases`, reached by exactly one connector and touching nothing else: the deepest,
 *   most infrastructure-independent piece.
 * - `Database` (a generic Data Store) and `External System` (an `external` Service) sit a full
 *   gutter beyond their adapters: technology the core never touches, and the only Service on the
 *   canvas.
 *
 * **Routing.** The two driving connectors share the inbound port's left-middle point, so Smart
 * Routing draws one funnel with one collapsed `calls`; `Use Cases` forks to both outbound ports
 * from its right-middle point, one trunk, one collapsed `uses`. Every implementation arrow is a
 * level line from an implementer's left edge back into its port's right edge. The gap between the
 * core and the outbound adapters is the wider `HEX_INNER_GAP`, so `implements` has room. The core
 * is the only boundary and the tallest thing on the canvas, so it reads as the middle everything
 * else adapts to before any label is read. Not a literal hexagon: the shape was always a metaphor
 * for "many sides", never a rule of six.
 */
const HEX_ROW_GAP = 160;
const HEX_ROW_A_Y = 0;
const HEX_ROW_B_Y = HEX_ROW_A_Y + HEX_ROW_GAP;
const HEX_ROW_A_CENTER = HEX_ROW_A_Y + SERVICE.height / 2;
const HEX_ROW_B_CENTER = HEX_ROW_B_Y + SERVICE.height / 2;
const HEX_CORE_CENTER = (HEX_ROW_A_CENTER + HEX_ROW_B_CENTER) / 2;

// Sized to the same visual-hierarchy rule every Component follows — noticeably smaller than
// Service's 176×68, so the core reads as *internal* next to the one Service on the canvas. Use
// Cases stays the widest thing inside the boundary (the hub every connector meets); Domain Model
// the smallest of the working pieces; a Port smaller still — a contract, not a thing doing work.
const HEX_USE_CASES = { width: 172, height: 64 };
const HEX_DOMAIN = { width: 140, height: 50 };
/** Component's default height, but wider than its default 152: "Persistence Adapter" has to stay
 *  on one line above the ADAPTER tag row at real browser font metrics. Both sides' adapters share
 *  it — they are the same kind of thing facing opposite ways. */
const HEX_ADAPTER = { width: 172, height: 56 };
/** Wide enough for a one-word port name at `nodeLabel` with the family's own padding, tall enough
 *  for the name and the `PORT` tag beneath it (`nodes/describe.ts`'s `componentPort`). */
const HEX_PORT = { width: 120, height: 44 };
/** The gap on either side of Use Cases inside the core, and between the core and the outbound
 *  adapters: room for an `implements` caption, and for the outbound fork's shared trunk
 *  (`edges/bundles.ts` needs `MIN_STEM` + `MIN_BRANCH` = 56 at the very least). */
const HEX_INNER_GAP = 88;

const HEX_USE_CASES_Y = HEX_CORE_CENTER - HEX_USE_CASES.height / 2;
const HEX_DOMAIN_GAP = 28;
const HEX_DOMAIN_Y = HEX_USE_CASES_Y + HEX_USE_CASES.height + HEX_DOMAIN_GAP;

const HEX_DRIVING_X = 0;
const HEX_CORE_X = HEX_DRIVING_X + HEX_ADAPTER.width + GUTTER;
const HEX_INBOUND_PORT_X = HEX_CORE_X + BOUNDARY_PAD;
const HEX_USE_CASES_X = HEX_INBOUND_PORT_X + HEX_PORT.width + HEX_INNER_GAP;
const HEX_OUTBOUND_PORT_X = HEX_USE_CASES_X + HEX_USE_CASES.width + HEX_INNER_GAP;
const HEX_CORE_WIDTH = HEX_OUTBOUND_PORT_X + HEX_PORT.width + BOUNDARY_PAD - HEX_CORE_X;
const HEX_PORT_A_Y = centeredAt(HEX_ROW_A_CENTER, HEX_PORT.height);
const HEX_PORT_B_Y = centeredAt(HEX_ROW_B_CENTER, HEX_PORT.height);
// The core spans both rows: its outbound ports sit on them, so the boundary's header clears the
// upper port by the title-only header, and its bottom pad clears whichever of Domain Model and the
// lower port reaches further down.
const HEX_CORE_Y = HEX_PORT_A_Y - BOUNDARY_HEADER_TITLE_ONLY;
const HEX_CORE_HEIGHT =
  Math.max(HEX_DOMAIN_Y + HEX_DOMAIN.height, HEX_PORT_B_Y + HEX_PORT.height) + BOUNDARY_PAD - HEX_CORE_Y;
/** The boundary's one subtitle — the second-header-line technique every subtitled boundary uses. */
const HEX_SUBTITLE = { width: 200, height: SUBTITLE_HEIGHT };

const HEX_DRIVEN_X = HEX_CORE_X + HEX_CORE_WIDTH + HEX_INNER_GAP;
const HEX_TECH_X = HEX_DRIVEN_X + HEX_ADAPTER.width + GUTTER;

const hexagonal: ArchitectureStarter = {
  id: 'hexagonal',
  category: 'architecture',
  name: 'Hexagonal',
  description: 'Adapters around a core that owns its ports',
  aliases: [
    'hexagonal',
    'hexagonal architecture',
    'ports and adapters',
    'ports adapters',
    'hex architecture',
    'clean architecture',
    'clean-ish architecture',
    'onion architecture',
    'domain core',
    'adapters',
  ],
  nodes: [
    {
      key: 'http-adapter',
      type: 'component',
      componentKind: 'adapter',
      text: 'HTTP Adapter',
      x: HEX_DRIVING_X,
      y: centeredAt(HEX_ROW_A_CENTER, HEX_ADAPTER.height),
      ...HEX_ADAPTER,
    },
    {
      key: 'message-consumer',
      type: 'component',
      componentKind: 'adapter',
      text: 'Message Consumer',
      x: HEX_DRIVING_X,
      y: centeredAt(HEX_ROW_B_CENTER, HEX_ADAPTER.height),
      ...HEX_ADAPTER,
    },
    {
      key: 'core',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Application Core',
      x: HEX_CORE_X,
      y: HEX_CORE_Y,
      width: HEX_CORE_WIDTH,
      height: HEX_CORE_HEIGHT,
      attachments: [
        {
          type: 'note',
          text: 'Owns its ports, depends on nothing outside itself. Solid arrows are runtime calls; hollow-headed “implements” arrows are source dependencies, and every one of them points in. Fits inside a monolith or a single microservice.',
        },
      ],
    },
    boundarySubtitle('core-subtitle', 'core', HEX_CORE_X, 'Dependencies point inward', HEX_SUBTITLE, HEX_CORE_Y),
    {
      key: 'inbound-port',
      type: 'component',
      componentKind: 'port',
      text: 'Inbound',
      parent: 'core',
      x: HEX_INBOUND_PORT_X,
      y: centeredAt(HEX_CORE_CENTER, HEX_PORT.height),
      ...HEX_PORT,
    },
    {
      key: 'use-cases',
      type: 'component',
      componentKind: 'generic',
      text: 'Use Cases',
      parent: 'core',
      x: HEX_USE_CASES_X,
      y: HEX_USE_CASES_Y,
      ...HEX_USE_CASES,
    },
    {
      key: 'domain',
      type: 'component',
      componentKind: 'generic',
      text: 'Domain Model',
      parent: 'core',
      x: centeredAt(HEX_USE_CASES_X + HEX_USE_CASES.width / 2, HEX_DOMAIN.width),
      y: HEX_DOMAIN_Y,
      ...HEX_DOMAIN,
    },
    {
      key: 'persistence-port',
      type: 'component',
      componentKind: 'port',
      text: 'Persistence',
      parent: 'core',
      x: HEX_OUTBOUND_PORT_X,
      y: HEX_PORT_A_Y,
      ...HEX_PORT,
    },
    {
      key: 'integration-port',
      type: 'component',
      componentKind: 'port',
      text: 'Integration',
      parent: 'core',
      x: HEX_OUTBOUND_PORT_X,
      y: HEX_PORT_B_Y,
      ...HEX_PORT,
    },
    {
      key: 'persistence-adapter',
      type: 'component',
      componentKind: 'adapter',
      text: 'Persistence Adapter',
      x: HEX_DRIVEN_X,
      y: centeredAt(HEX_ROW_A_CENTER, HEX_ADAPTER.height),
      ...HEX_ADAPTER,
    },
    {
      key: 'integration-adapter',
      type: 'component',
      componentKind: 'adapter',
      text: 'Integration Adapter',
      x: HEX_DRIVEN_X,
      y: centeredAt(HEX_ROW_B_CENTER, HEX_ADAPTER.height),
      ...HEX_ADAPTER,
    },
    {
      key: 'database',
      type: 'database',
      databaseKind: 'generic',
      text: 'Database',
      accent: 'blue',
      x: HEX_TECH_X,
      y: storeCenteredAt(HEX_ROW_A_CENTER),
      ...STORE,
    },
    {
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      text: 'External System',
      accent: 'teal',
      x: HEX_TECH_X,
      y: HEX_ROW_B_Y,
      ...SERVICE,
    },
  ],
  edges: [
    // Runtime, left to right. Both driving adapters meet the inbound port at one point — one
    // funnel, one `calls` (an adapter may drive a port or stand behind it, so the matrix's default
    // for the pairing is the neutral `uses`; these two drive).
    { key: 'http-call', ...across('http-adapter', 'inbound-port'), semantic: 'calls' },
    { key: 'consumer-call', ...across('message-consumer', 'inbound-port'), semantic: 'calls' },
    { key: 'use-domain', ...down('use-cases', 'domain') },
    // One fork from Use Cases to both outbound ports — one trunk, one `uses`.
    { key: 'use-persistence-port', ...across('use-cases', 'persistence-port') },
    { key: 'use-integration-port', ...across('use-cases', 'integration-port') },
    { key: 'write-database', ...across('persistence-adapter', 'database'), label: READS_WRITES },
    { key: 'call-external', ...across('integration-adapter', 'external') },
    // Source dependencies, pointing in: from each implementer back to the contract it satisfies.
    { key: 'implement-inbound', ...back('use-cases', 'inbound-port'), semantic: 'implements' },
    { key: 'implement-persistence', ...back('persistence-adapter', 'persistence-port'), semantic: 'implements' },
    { key: 'implement-integration', ...back('integration-adapter', 'integration-port'), semantic: 'implements' },
  ],
  flows: [
    {
      title: 'Handle an HTTP request',
      accent: 'green',
      steps: [
        { edgeKey: 'http-call', caption: 'The adapter translates HTTP into a call on the port' },
        { edgeKey: 'use-domain', caption: 'The use case behind the port runs the domain model' },
        { edgeKey: 'use-persistence-port', caption: 'The core asks its own port — not a database' },
        { edgeKey: 'write-database', caption: 'The adapter behind the port does the technology' },
      ],
    },
    {
      title: 'Consume a message',
      accent: 'amber',
      steps: [
        { edgeKey: 'consumer-call', caption: 'A different technology, the same port' },
        { edgeKey: 'use-domain' },
        { edgeKey: 'use-integration-port' },
        { edgeKey: 'call-external' },
      ],
    },
  ],
};

/* ------------------------------------------------------ backend for frontend -- */
/**
 * Two client experiences, each with a backend of its own, sharing one set of backend capabilities
 * — drawn with the shared capabilities *in the middle* and an experience on either side, so the
 * sentence "each frontend gets a backend tailored to it; the capabilities stay shared" reads before
 * a single label does, and no connector ever crosses another.
 *
 * **What each element is.**
 * - `Web Client` is an Actor of kind `system` (a monitor — a browser) and `Mobile Client` one of
 *   kind `device` (a phone): the pattern is about client experiences, and a browser and a phone are
 *   the two that most often diverge in what they need. Neither is a person.
 * - `Web BFF` / `Mobile BFF` are `api` Services: Backend for Frontend is a role, not a shape kind.
 *   Each carries its responsibility as its own C4 description, drawn inside the shape — the web
 *   one *composes page data*, the mobile one *tailors compact responses* — because a BFF that
 *   merely forwards is a gateway with extra steps. There is deliberately **no gateway** here: a
 *   gateway is one shared front door and its connectors say `routes`; a BFF is *one client's*
 *   adapter and its connectors say `calls`. Drawing both would blur exactly that.
 * - Each client and its BFF share a boundary titled for the *experience* and subtitled with who
 *   owns it — a logical/ownership grouping, never a deployment: browser code and a BFF do not run
 *   together, they belong together. Ownership is why a BFF may be tailored without a committee.
 * - `Capability A/B/C Service` sit inside `Shared backend capabilities`, subtitled with where the
 *   business rules live. A BFF composes them; it never owns them and never holds the rules.
 *
 * **Routing.** The Web BFF's three connectors leave its right-middle point, so Smart Routing draws
 * one trunk with one collapsed `calls`; the Mobile BFF's two leave its left-middle point for one
 * funnel of its own. The two fans meet the services from opposite sides, so the asymmetry — only
 * the web experience uses Capability C — is visible as a shorter fan, not as a crossing line, and
 * says "a different subset" without claiming every client uses every service. Everything is a
 * synchronous request: a BFF is a request-time adapter.
 */
const BFF_BOX_WIDTH = SERVICE.width + BOUNDARY_PAD * 2;
/** A BFF carries a one-line C4 description under its name, which Service's default height has no
 *  row for — grown just enough to hold the name, the description and the API tag. */
const BFF_ADAPTER = { width: SERVICE.width, height: 88 };
/** A boundary subtitle spans the box's inner width, sharing the title's own left inset. */
const BFF_SUBTITLE = { width: BFF_BOX_WIDTH - BOUNDARY_TITLE_INSET * 2, height: SUBTITLE_HEIGHT };
/** First content row clears the boundary's subtitle. */
const BFF_TOP = BOUNDARY_TITLE_SUBLINE_Y + SUBTITLE_HEIGHT + 8;
const BFF_CLIENT_Y = BFF_TOP;
/** Tighter than `INNER_BAND`: the `calls` caption between a client and its adapter sits inside a
 *  boundary that already separates them from everything else. */
const BFF_CLIENT_GAP = 64;
const BFF_ADAPTER_Y = BFF_CLIENT_Y + ACTOR.height + BFF_CLIENT_GAP;
const BFF_BOX_HEIGHT = BFF_ADAPTER_Y + BFF_ADAPTER.height + BOUNDARY_PAD;
/** Wider than `INNER_BAND`: each service row also hosts a fan branch and its tap-off. */
const BFF_SERVICE_GAP = 88;
const BFF_SERVICE_Y = (index: number) => BFF_TOP + index * (SERVICE.height + BFF_SERVICE_GAP);
const BFF_SHARED_HEIGHT = BFF_SERVICE_Y(2) + SERVICE.height + BOUNDARY_PAD;
/** A full `BAND` either side of the shared capabilities: room for a fan's trunk corridor and its
 *  caption. */
const BFF_GUTTER = BAND;
const BFF_WEB_X = 0;
const BFF_SHARED_X = BFF_WEB_X + BFF_BOX_WIDTH + BFF_GUTTER;
const BFF_MOBILE_X = BFF_SHARED_X + BFF_BOX_WIDTH + BFF_GUTTER;
/** The experience boxes are shorter than the shared one; centring them on its middle row keeps
 *  each BFF level with the middle service, so every stem meets its trunk at the trunk's own centre. */
const BFF_EXPERIENCE_Y = Math.round(BFF_SERVICE_Y(1) + SERVICE.height / 2 - (BFF_ADAPTER_Y + BFF_ADAPTER.height / 2));

function bffExperience(
  key: 'web' | 'mobile',
  left: number,
  title: string,
  owner: string,
  client: { text: string; kind: 'system' | 'device' },
  adapter: { text: string; description: string; note: string },
): StarterNodeSpec[] {
  const cx = left + BFF_BOX_WIDTH / 2;
  return [
    {
      key: `${key}-box`,
      type: 'group',
      boundaryPreset: 'boundary',
      text: title,
      x: left,
      y: BFF_EXPERIENCE_Y,
      width: BFF_BOX_WIDTH,
      height: BFF_BOX_HEIGHT,
    },
    boundarySubtitle(`${key}-subtitle`, `${key}-box`, left, owner, BFF_SUBTITLE, BFF_EXPERIENCE_Y),
    {
      key: `${key}-client`,
      type: 'actor',
      actorKind: client.kind,
      text: client.text,
      parent: `${key}-box`,
      x: centeredAt(cx, ACTOR.width),
      y: BFF_EXPERIENCE_Y + BFF_CLIENT_Y,
      ...ACTOR,
    },
    {
      key: `${key}-bff`,
      type: 'service',
      serviceKind: 'api',
      text: adapter.text,
      description: adapter.description,
      accent: 'teal',
      parent: `${key}-box`,
      x: left + BOUNDARY_PAD,
      y: BFF_EXPERIENCE_Y + BFF_ADAPTER_Y,
      ...BFF_ADAPTER,
      attachments: [{ type: 'note', text: adapter.note }],
    },
  ];
}

const backendForFrontend: ArchitectureStarter = {
  id: 'bff',
  category: 'architecture',
  name: 'Backend for Frontend',
  description: 'A backend per frontend, over shared capabilities',
  aliases: ['bff', 'backend for frontend', 'backends for frontends', 'client adapter', 'per-client api'],
  nodes: [
    ...bffExperience(
      'web',
      BFF_WEB_X,
      'Web experience',
      'Owned by the web team',
      { text: 'Web Client', kind: 'system' },
      {
        text: 'Web BFF',
        description: 'Composes page data',
        note: 'Aggregates several capability calls into one page-shaped response for the browser. Not a shared gateway, and not where business rules live.',
      },
    ),
    {
      key: 'shared',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Shared backend capabilities',
      x: BFF_SHARED_X,
      y: 0,
      width: BFF_BOX_WIDTH,
      height: BFF_SHARED_HEIGHT,
      attachments: [
        {
          type: 'note',
          text: 'Shared capabilities with their own owners and the business rules. A BFF composes a subset of them for its client; it never owns them, and no client is required to use them all.',
        },
      ],
    },
    boundarySubtitle('shared-subtitle', 'shared', BFF_SHARED_X, 'Business rules live here', BFF_SUBTITLE),
    ...CAPABILITIES.map(
      (letter, index): StarterNodeSpec => ({
        key: `capability-${letter.toLowerCase()}`,
        type: 'service',
        serviceKind: 'api',
        text: `Capability ${letter} Service`,
        accent: 'teal',
        parent: 'shared',
        x: BFF_SHARED_X + BOUNDARY_PAD,
        y: BFF_SERVICE_Y(index),
        ...SERVICE,
      }),
    ),
    ...bffExperience(
      'mobile',
      BFF_MOBILE_X,
      'Mobile experience',
      'Owned by the mobile team',
      { text: 'Mobile Client', kind: 'device' },
      {
        text: 'Mobile BFF',
        description: 'Tailors compact responses',
        note: 'Fewer round trips and smaller payloads — what a phone on a slow network needs. Uses only the capabilities the mobile experience needs.',
      },
    ),
  ],
  edges: [
    { key: 'web-call', ...down('web-client', 'web-bff') },
    { key: 'mobile-call', ...down('mobile-client', 'mobile-bff') },
    // One fan per adapter, from opposite sides — see this block's doc comment.
    ...CAPABILITIES.map((letter) => ({ ...across('web-bff', `capability-${letter.toLowerCase()}`), key: `web-${letter.toLowerCase()}` })),
    { key: 'mobile-a', ...back('mobile-bff', 'capability-a') },
    { key: 'mobile-b', ...back('mobile-bff', 'capability-b') },
  ],
  flows: [
    {
      title: 'Web request',
      accent: 'teal',
      steps: [
        { edgeKey: 'web-call', caption: 'One request for a whole page' },
        { edgeKey: 'web-a' },
        { edgeKey: 'web-b' },
        { edgeKey: 'web-c', caption: 'Composed into one page-shaped response' },
      ],
    },
    {
      title: 'Mobile request',
      accent: 'amber',
      steps: [
        { edgeKey: 'mobile-call', caption: 'One compact request from the phone' },
        { edgeKey: 'mobile-a' },
        { edgeKey: 'mobile-b', caption: 'Only what the mobile experience needs, trimmed for it' },
      ],
    },
  ],
};

/* ------------------------------------------------------------------- cqrs -- */
/**
 * One client, two sides, two models. Commands go left and change authoritative state through a
 * handler that validates intent; queries go right and are answered from a model shaped for
 * reading, without changing anything. That separation of *responsibilities* — not two cylinders
 * with different names — is the pattern; everything on the bridge between the two sides is one
 * particular way to keep the read model up to date, named as such: CQRS **with an asynchronous
 * read projection**.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Command API` → `Command Handler` → `Write Store` is the command side: the API accepts an
 *   imperative (`command`, its attached example names what the caller wants, never a row to
 *   upsert), the handler *executes* it — validates, applies the rules, may reject — and the store
 *   holds current state in the write model's own shape. One write does two things in one
 *   transaction: the state, and an outbox record of what changed. The connector says so, and the
 *   publish's note says why: a database write and a broker publish are never atomic on their own.
 * - `Outbox Relay` is a Worker on the command side that reads committed outbox records *after* the
 *   transaction and publishes them to `Domain Events`. It exists so that no passive model object
 *   is drawn as a network publisher and no publish happens inside a transaction — one compact,
 *   coherent propagation strategy (the Transactional Outbox starter is the same idea at its own
 *   scope). The Topic carries facts, not state: it is **not an event store**, and nothing replays
 *   it to rebuild anything. CQRS is not Event Sourcing.
 * - `Projection Worker` is a Worker on the query side that turns each event into an update of
 *   `Read Store`; `Query API` only ever `reads`. The one honest cost is written under the bridge:
 *   the read projection is *eventually consistent* — a read straight after a command may not see
 *   it yet — and that caption is tied to this propagation, not to CQRS as such.
 * - Two models, not necessarily two databases, and no requirement for messaging, event sourcing or
 *   separate deployments: the command side's and the Read Store's notes say so. The two boundaries
 *   are `boundary`s — logical sides, not deployments.
 *
 * **Routing.** The whole propagation is one level line along the store row: Write Store ← Relay →
 * Topic → Projection Worker → Read Store, so the asynchronous tail reads left to right as one
 * sentence, and the two dashed event hops sit between two solid data hops. Rows line up across
 * both boxes; the Topic's *tube* (not its box) and both stores' *glyphs* sit on that row so every
 * hop is straight. The client's two connectors leave its bottom-centre and meet each API from the
 * *side* facing the client — one `command` into the Command API's right edge, one `query` into the
 * Query API's left edge — so they cross each boundary's edge in open space rather than descending
 * through its title and subtitle.
 *
 * **Flows.** "Submit command" walks the whole write story including its asynchronous tail;
 * "Read projection" is the two-step read.
 */
const CQRS_INNER_GAP = 88;
const CQRS_BOX_WIDTH = BOUNDARY_PAD * 2 + SERVICE.width * 2 + CQRS_INNER_GAP;
const CQRS_SUBTITLE = { width: 200, height: SUBTITLE_HEIGHT };
/** First content row clears the boundary's subtitle. */
const CQRS_TOP = BOUNDARY_TITLE_SUBLINE_Y + SUBTITLE_HEIGHT + 8;
const CQRS_API_Y = CQRS_TOP;
const CQRS_HANDLER_Y = CQRS_API_Y + SERVICE.height + INNER_BAND;
const CQRS_STORE_Y = CQRS_HANDLER_Y + COMPONENT.height + INNER_BAND;
const CQRS_BOX_HEIGHT = CQRS_STORE_Y + STORE.height + BOUNDARY_PAD;
const CQRS_STORE_CENTER = CQRS_STORE_Y + STORE_GLYPH_CENTER;
/** The bridge gap on either side of the Topic: room for a dashed event hop's caption to sit clear
 *  of the boundary edge the hop crosses, not straddling it. */
const CQRS_BRIDGE_GAP = 120;
const CQRS_COMMAND_X = 0;
/** Command side: the write column on the left, the relay column beside the bridge. */
const CQRS_WRITE_CX = CQRS_COMMAND_X + BOUNDARY_PAD + SERVICE.width / 2;
const CQRS_RELAY_X = CQRS_COMMAND_X + BOUNDARY_PAD + SERVICE.width + CQRS_INNER_GAP;
const CQRS_TOPIC_X = CQRS_COMMAND_X + CQRS_BOX_WIDTH + CQRS_BRIDGE_GAP;
const CQRS_TOPIC_CX = CQRS_TOPIC_X + NAMED_QUEUE.width / 2;
const CQRS_QUERY_X = CQRS_TOPIC_X + NAMED_QUEUE.width + CQRS_BRIDGE_GAP;
/** Query side: the projection column beside the bridge, the read column on the right. */
const CQRS_PROJECTOR_X = CQRS_QUERY_X + BOUNDARY_PAD;
const CQRS_READ_CX = CQRS_PROJECTOR_X + SERVICE.width + CQRS_INNER_GAP + SERVICE.width / 2;
/** The annotation sits just under the store row, still inside the boundaries' own bottom pad. */
const CQRS_ANNOTATION_Y = CQRS_STORE_Y + STORE.height + 8;
const CQRS_ANNOTATION = { width: 220, height: SUBTITLE_HEIGHT };

function cqrsSide(key: 'command' | 'query', left: number, title: string, subtitle: string, note: string): StarterNodeSpec[] {
  return [
    {
      key: `${key}-box`,
      type: 'group',
      boundaryPreset: 'boundary',
      text: title,
      x: left,
      y: 0,
      width: CQRS_BOX_WIDTH,
      height: CQRS_BOX_HEIGHT,
      attachments: [{ type: 'note', text: note }],
    },
    boundarySubtitle(`${key}-subtitle`, `${key}-box`, left, subtitle, CQRS_SUBTITLE),
  ];
}

const cqrs: ArchitectureStarter = {
  id: 'cqrs',
  category: 'architecture',
  name: 'CQRS',
  description: 'Distinct command and query paths, async read projection',
  aliases: ['cqrs', 'command query', 'command query responsibility segregation', 'read model', 'write model', 'projection'],
  nodes: [
    softwareClient(CQRS_TOPIC_CX, 0),
    ...cqrsSide(
      'command',
      CQRS_COMMAND_X,
      'Command side',
      'Validates intent, changes state',
      'A logical side, not a deployment: the two sides can be one process and one database. CQRS requires neither messaging, event sourcing nor separate services — this starter adds an asynchronous projection as one common variant. Its topic carries facts about what changed and is not an event store: nothing replays it. A direct in-process update or a database change feed would feed the projection just as well.',
    ),
    {
      key: 'command-api',
      type: 'service',
      serviceKind: 'api',
      text: 'Command API',
      accent: 'teal',
      parent: 'command-box',
      x: centeredAt(CQRS_WRITE_CX, SERVICE.width),
      y: CQRS_API_Y,
      ...SERVICE,
      attachments: [
        {
          type: 'code',
          text: 'Example command',
          language: 'json',
          // An imperative, named for what the caller wants — never a row to upsert. The handler
          // may still say no.
          code: ['{', '  "type": "ChangeStatus",', '  "entityId": "ent_4821",', '  "status": "active"', '}'].join('\n'),
        },
      ],
    },
    {
      key: 'command-handler',
      type: 'component',
      componentKind: 'generic',
      text: 'Command Handler',
      parent: 'command-box',
      x: centeredAt(CQRS_WRITE_CX, COMPONENT.width),
      y: CQRS_HANDLER_Y,
      ...COMPONENT,
    },
    {
      key: 'write-store',
      type: 'database',
      databaseKind: 'generic',
      text: 'Write Store',
      accent: 'blue',
      parent: 'command-box',
      x: centeredAt(CQRS_WRITE_CX, STORE.width),
      y: CQRS_STORE_Y,
      ...STORE,
    },
    {
      key: 'relay',
      type: 'service',
      serviceKind: 'worker',
      text: 'Outbox Relay',
      accent: 'teal',
      parent: 'command-box',
      x: CQRS_RELAY_X,
      y: centeredAt(CQRS_STORE_CENTER, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'events',
      type: 'queue',
      queueKind: 'topic',
      text: 'Domain Events',
      x: CQRS_TOPIC_X,
      y: tubeCenteredAt(CQRS_STORE_CENTER, NAMED_QUEUE.height),
      ...NAMED_QUEUE,
    },
    {
      key: 'consistency',
      type: 'text',
      text: 'Eventually consistent read projection',
      annotation: true,
      x: centeredAt(CQRS_TOPIC_CX, CQRS_ANNOTATION.width),
      y: CQRS_ANNOTATION_Y,
      ...CQRS_ANNOTATION,
    },
    ...cqrsSide(
      'query',
      CQRS_QUERY_X,
      'Query side',
      'Answers questions, changes nothing',
      'Reads are answered from a model shaped for the questions asked. Only the projection writes here; the Query API never does.',
    ),
    {
      key: 'query-api',
      type: 'service',
      serviceKind: 'api',
      text: 'Query API',
      accent: 'teal',
      parent: 'query-box',
      x: centeredAt(CQRS_READ_CX, SERVICE.width),
      y: CQRS_API_Y,
      ...SERVICE,
    },
    {
      key: 'projector',
      type: 'service',
      serviceKind: 'worker',
      text: 'Projection Worker',
      accent: 'teal',
      parent: 'query-box',
      x: CQRS_PROJECTOR_X,
      y: centeredAt(CQRS_STORE_CENTER, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'read-store',
      type: 'database',
      databaseKind: 'generic',
      text: 'Read Store',
      accent: 'blue',
      parent: 'query-box',
      x: centeredAt(CQRS_READ_CX, STORE.width),
      y: CQRS_STORE_Y,
      ...STORE,
      attachments: [
        {
          type: 'note',
          text: 'Shaped for the questions asked of it — a projection, not the write model. It may be a second schema in the same database: CQRS separates models, not necessarily databases.',
        },
      ],
    },
  ],
  edges: [
    { key: 'submit', from: 'client', to: 'command-api', sourceAnchor: BOTTOM, targetAnchor: RIGHT, semantic: 'command' },
    { key: 'handle', ...down('command-api', 'command-handler'), semantic: 'command', label: 'executes' },
    { key: 'persist', ...down('command-handler', 'write-store'), label: 'writes state + outbox record' },
    { key: 'relay-read', ...back('relay', 'write-store'), semantic: 'reads', label: 'reads outbox' },
    {
      // The transaction's story rides the publish, not the handler's write: the write sits in a
      // crowded column where a presentation callout has nowhere to open, and the publish is the
      // moment the guarantee matters — it is what the outbox makes safe.
      key: 'publish',
      ...across('relay', 'events'),
      attachments: [
        {
          type: 'note',
          text: 'Published only after the commit: the new state and its outbox record were written in one transaction, or not at all, and nothing left it from inside. Delivery is at-least-once, so the projection dedupes on the record id.',
        },
      ],
    },
    { key: 'deliver', ...across('events', 'projector') },
    { key: 'materialize', ...across('projector', 'read-store'), label: 'updates projection' },
    { key: 'query', from: 'client', to: 'query-api', sourceAnchor: BOTTOM, targetAnchor: LEFT, semantic: 'query' },
    { key: 'read', ...down('query-api', 'read-store'), semantic: 'reads' },
  ],
  flows: [
    {
      title: 'Submit command',
      accent: 'amber',
      steps: [
        { edgeKey: 'submit', caption: 'The client states what it wants' },
        { edgeKey: 'handle', caption: 'Validated against the rules — it may be rejected' },
        { edgeKey: 'persist', caption: 'State and outbox record, one transaction' },
        { edgeKey: 'relay-read', caption: 'After the commit, the relay picks up the record' },
        { edgeKey: 'publish', caption: 'A fact leaves the command side' },
        { edgeKey: 'deliver' },
        { edgeKey: 'materialize', caption: 'The read model catches up — eventually' },
      ],
    },
    {
      title: 'Read projection',
      accent: 'green',
      steps: [
        { edgeKey: 'query', caption: 'The client asks a question' },
        { edgeKey: 'read', caption: 'Answered from the read model — nothing changes' },
      ],
    },
  ],
};

/* ---------------------------------------------------------- medallion -- */
/**
 * Progressive refinement, drawn so the three layers are the whole picture: sources on the left,
 * consumers on the right, and between them one wide **Lakehouse** boundary holding Bronze → Silver →
 * Gold — the same kind of thing three times, each more trustworthy than the last. Everything else
 * is supporting context, and the composition says so: the sources and the consumers sit in their
 * own smaller zones, and `Ingestion` stands alone between them, a step rather than a place.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Sources` frames three representative source *classes*, not a catalogue: `Operational
 *   Database` (structured, a system of record), `Files` (batch drops — a File System, not the lake
 *   itself), `Event Stream` (continuous facts). They read `reads`/`reads`/`consumes` from the
 *   matrix, so the streaming source is honestly the one dashed, asynchronous line among them.
 * - `Ingestion` is one plain Worker for both batch and stream — a background process that lands
 *   data as it arrives. Splitting it into two would make this an ingestion diagram; the layers are
 *   the point, and "how each source is pulled" is the first thing a user specialises.
 * - `Bronze`, `Silver`, `Gold` are three `table` Data Stores inside the one boundary. Not object
 *   storage for Bronze and tables above it: that reads as three different systems ("bucket, table,
 *   table"), and Medallion is three *zones of one store* rising in trust. The boundary carries the
 *   substrate; identical shapes carry "same thing, refined"; the quiet descriptor under each layer
 *   carries what the trust actually is — raw and source-aligned, validated and conformed, curated
 *   and business-ready. No bronze/silver/gold colour gradient anywhere: the layers read from
 *   position, label, and descriptor alone, in any theme.
 * - The two connectors between layers are where refinement happens, so they say what happens:
 *   `validate + conform` into Silver (the data-quality step — its note carries dedupe, typing and
 *   schema enforcement), `model + aggregate` into Gold. Both are `transforms` underneath, never a
 *   plain copy. `Ingestion → Bronze` is labelled `lands raw` for the same reason.
 * - `Serving` frames `Analytics / BI` and `Data API` — two kinds of consumer, both reading Gold and
 *   nothing upstream of it, which is the entire reason Gold exists. Two is enough to show Gold is
 *   built for consumption without turning the right edge into a fan-out exhibit.
 *
 * **Routing.** `Files` is level with `Ingestion`, which is level with the three tables: one
 * unbroken straight run from the middle source to Gold. The other two sources meet Ingestion from
 * above and below — `Operational Database` into its top, `Event Stream` into its bottom — each one
 * clean corner, mirror images of each other. Not a left-side fan: the stream's `consumes` can never
 * share the two `reads`' trunk, and a separate elbow beside that trunk bends at a different x and
 * squeezes the trunk's caption between two parallel lines. Three sides, three arrows, nothing
 * running alongside anything. Gold forks symmetrically to both consumers, one bundled `reads`. The
 * layer gap is wide enough for a label chip to sit clear of both tables.
 *
 * **Flow.** "Raw to insight" walks one representative source straight through to one
 * representative consumer — the others land and read the same way.
 */
const MED_SUBTITLE = { width: 200, height: 24 };
/** First content row clears the boundary's subtitle — the same arithmetic as `CQRS_TOP`. */
const MED_LAKE_TOP = BOUNDARY_TITLE_SUBLINE_Y + MED_SUBTITLE.height + 8;
/** Wider than `BAND`: a `validate + conform` label chip is centred in this gap and must clear
 *  both tables with air to spare. */
const MED_LAYER_GAP = 152;
/** A one-line annotation at the minimum node height (`minSizeFor`), the same as a subtitle's. */
const MED_DESCRIPTOR_HEIGHT = 24;
const MED_DESCRIPTOR_Y = MED_LAKE_TOP + TABLE.height + 8;
const MED_LAKE_HEIGHT = MED_DESCRIPTOR_Y + MED_DESCRIPTOR_HEIGHT + BOUNDARY_PAD;
const MED_LAKE_WIDTH = BOUNDARY_PAD * 2 + TABLE.width * 3 + MED_LAYER_GAP * 2;
/** The whole composition's spine: the tables' centre line. */
const MED_SPINE_CENTER = MED_LAKE_TOP + TABLE_GLYPH_CENTER;
/** Stacked siblings inside the Sources/Serving zones — tighter than `INNER_BAND` so neither box towers. */
const MED_STACK_GAP = 40;
/** Room between the Sources zone and Ingestion for the three arrows' captions. */
const MED_SOURCE_GAP = 96;
const MED_SOURCES_X = 0;
const MED_SOURCES_WIDTH = STORE.width + BOUNDARY_PAD * 2;
const MED_FILES_Y = storeCenteredAt(MED_SPINE_CENTER);
const MED_DB_Y = MED_FILES_Y - MED_STACK_GAP - STORE.height;
/** How far above the spine `Operational Database`'s arrow leaves — `Event Stream`'s tube sits the
 *  same distance below it, so the two corners into Ingestion mirror each other exactly. */
const MED_SOURCE_REACH = MED_SPINE_CENTER - (MED_DB_Y + STORE_GLYPH_CENTER);
const MED_STREAM_Y = tubeCenteredAt(MED_SPINE_CENTER + MED_SOURCE_REACH, NAMED_QUEUE.height);
const MED_SOURCES_Y = MED_DB_Y - BOUNDARY_HEADER_TITLE_ONLY;
const MED_SOURCES_HEIGHT = MED_STREAM_Y + NAMED_QUEUE.height + BOUNDARY_PAD - MED_SOURCES_Y;
const MED_INGEST_X = MED_SOURCES_X + MED_SOURCES_WIDTH + MED_SOURCE_GAP;
const MED_LAKE_X = MED_INGEST_X + SERVICE.width + GUTTER;
const MED_BRONZE_X = MED_LAKE_X + BOUNDARY_PAD;
const MED_SILVER_X = MED_BRONZE_X + TABLE.width + MED_LAYER_GAP;
const MED_GOLD_X = MED_SILVER_X + TABLE.width + MED_LAYER_GAP;
const MED_SERVING_X = MED_LAKE_X + MED_LAKE_WIDTH + GUTTER;
const MED_SERVING_WIDTH = SERVICE.width + BOUNDARY_PAD * 2;
const MED_CONSUMER_X = MED_SERVING_X + BOUNDARY_PAD;
const MED_CONSUMER_SPAN = SERVICE.height * 2 + MED_STACK_GAP;
const MED_ANALYTICS_Y = MED_SPINE_CENTER - MED_CONSUMER_SPAN / 2;
const MED_API_Y = MED_ANALYTICS_Y + SERVICE.height + MED_STACK_GAP;
const MED_SERVING_Y = MED_ANALYTICS_Y - BOUNDARY_HEADER_TITLE_ONLY;
const MED_SERVING_HEIGHT = MED_API_Y + SERVICE.height + BOUNDARY_PAD - MED_SERVING_Y;

/** The quiet line under each layer — annotation text is left-aligned at its own x, so the box is
 *  sized to the words and centred under the table. */
function medallionDescriptor(key: string, tableX: number, text: string, width: number): StarterNodeSpec {
  return {
    key,
    type: 'text',
    text,
    annotation: true,
    parent: 'lake',
    x: centeredAt(tableX + TABLE.width / 2, width),
    y: MED_DESCRIPTOR_Y,
    width,
    height: MED_DESCRIPTOR_HEIGHT,
  };
}

const medallion: ArchitectureStarter = {
  id: 'medallion',
  category: 'data',
  name: 'Medallion',
  description: 'Refine raw data into validated, business-ready datasets',
  aliases: ['medallion', 'medallion architecture', 'bronze silver gold', 'lakehouse', 'data lake', 'etl', 'data pipeline'],
  nodes: [
    {
      key: 'sources',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Sources',
      x: MED_SOURCES_X,
      y: MED_SOURCES_Y,
      width: MED_SOURCES_WIDTH,
      height: MED_SOURCES_HEIGHT,
    },
    {
      key: 'db',
      type: 'database',
      databaseKind: 'generic',
      text: 'Operational Database',
      accent: 'blue',
      parent: 'sources',
      x: MED_SOURCES_X + BOUNDARY_PAD,
      y: MED_DB_Y,
      ...STORE,
    },
    {
      key: 'files',
      type: 'database',
      databaseKind: 'file-system',
      text: 'Files',
      accent: 'blue',
      parent: 'sources',
      x: MED_SOURCES_X + BOUNDARY_PAD,
      y: MED_FILES_Y,
      ...STORE,
    },
    {
      key: 'stream',
      type: 'queue',
      queueKind: 'stream',
      text: 'Event Stream',
      parent: 'sources',
      x: centeredAt(MED_SOURCES_X + MED_SOURCES_WIDTH / 2, NAMED_QUEUE.width),
      y: MED_STREAM_Y,
      ...NAMED_QUEUE,
    },
    {
      key: 'ingestion',
      type: 'service',
      serviceKind: 'worker',
      text: 'Ingestion',
      accent: 'teal',
      x: MED_INGEST_X,
      y: centeredAt(MED_SPINE_CENTER, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'lake',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Lakehouse',
      x: MED_LAKE_X,
      y: 0,
      width: MED_LAKE_WIDTH,
      height: MED_LAKE_HEIGHT,
    },
    boundarySubtitle('lake-subtitle', 'lake', MED_LAKE_X, 'One lake, three levels of trust', MED_SUBTITLE),
    {
      key: 'bronze',
      type: 'database',
      databaseKind: 'table',
      text: 'Bronze',
      accent: 'blue',
      parent: 'lake',
      x: MED_BRONZE_X,
      y: MED_LAKE_TOP,
      ...TABLE,
      attachments: [
        {
          type: 'note',
          text: 'Append-only landing, kept exactly as received — so everything downstream can be rebuilt from here.',
        },
      ],
    },
    medallionDescriptor('bronze-descriptor', MED_BRONZE_X, 'Raw, source-aligned', 116),
    {
      key: 'silver',
      type: 'database',
      databaseKind: 'table',
      text: 'Silver',
      accent: 'blue',
      parent: 'lake',
      x: MED_SILVER_X,
      y: MED_LAKE_TOP,
      ...TABLE,
      attachments: [
        {
          type: 'note',
          text: 'Deduplicated, typed, schema-enforced — business entities start to emerge here.',
        },
      ],
    },
    medallionDescriptor('silver-descriptor', MED_SILVER_X, 'Validated, conformed', 120),
    {
      key: 'gold',
      type: 'database',
      databaseKind: 'table',
      text: 'Gold',
      accent: 'blue',
      parent: 'lake',
      x: MED_GOLD_X,
      y: MED_LAKE_TOP,
      ...TABLE,
      attachments: [
        {
          type: 'note',
          text: 'Modelled and aggregated for the questions asked of it — optimised for reads, not for landing.',
        },
      ],
    },
    medallionDescriptor('gold-descriptor', MED_GOLD_X, 'Curated, business-ready', 138),
    {
      key: 'serving',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Serving',
      x: MED_SERVING_X,
      y: MED_SERVING_Y,
      width: MED_SERVING_WIDTH,
      height: MED_SERVING_HEIGHT,
    },
    {
      key: 'analytics',
      type: 'service',
      // A consumer, not an endpoint — the same call Kappa's Analytics makes.
      serviceKind: 'generic',
      text: 'Analytics / BI',
      accent: 'teal',
      parent: 'serving',
      x: MED_CONSUMER_X,
      y: MED_ANALYTICS_Y,
      ...SERVICE,
    },
    {
      key: 'data-api',
      type: 'service',
      serviceKind: 'api',
      text: 'Data API',
      accent: 'teal',
      parent: 'serving',
      x: MED_CONSUMER_X,
      y: MED_API_Y,
      ...SERVICE,
    },
  ],
  edges: [
    { key: 'db-ingest', from: 'db', to: 'ingestion', sourceAnchor: RIGHT, targetAnchor: TOP },
    { key: 'files-ingest', ...across('files', 'ingestion') },
    { key: 'stream-ingest', from: 'stream', to: 'ingestion', sourceAnchor: RIGHT, targetAnchor: BOTTOM },
    { key: 'land', ...across('ingestion', 'bronze'), label: 'lands raw' },
    { key: 'refine', ...across('bronze', 'silver'), semantic: 'transforms', label: 'validate + conform' },
    { key: 'curate', ...across('silver', 'gold'), semantic: 'transforms', label: 'model + aggregate' },
    { key: 'to-analytics', ...across('gold', 'analytics') },
    { key: 'to-api', ...across('gold', 'data-api') },
  ],
  flows: [
    {
      title: 'Raw to insight',
      accent: 'teal',
      steps: [
        { edgeKey: 'db-ingest', caption: 'Source data arrives' },
        { edgeKey: 'land', caption: 'Landed in Bronze exactly as received' },
        { edgeKey: 'refine', caption: 'Validated, deduplicated, and conformed into Silver' },
        { edgeKey: 'curate', caption: 'Modelled and aggregated into Gold' },
        { edgeKey: 'to-analytics', caption: 'Analytics reads business-ready data' },
      ],
    },
  ],
};

/* -------------------------------------------------------------- kappa -- */
/**
 * One retained history, one processing path, and replay through that same path to rebuild derived
 * state. The **Streaming core** is the wide base of the diagram and holds exactly one straight line
 * — `Event Log → Stream Processor → Materialized View` — with nothing running beside it, because a
 * second line is precisely what Kappa refuses to draw: no batch layer, no replay processor, no
 * historical pipeline. `Producers` and `Serving` sit above its two ends, supporting context on
 * either side of the one thing that matters.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Application` and `External System` each publish into the log on their own arrow; Smart
 *   Routing draws the pair as one fork, so neither reads as publishing through the other, and
 *   neither owns the log. Two is enough to say "many producers, one history."
 * - `Event Log` is a **Stream**: Draft Canvas's retained-history kind, not a Topic's
 *   broadcast-and-forget. Its descriptor says "Append-only, replayable" — deliberately not
 *   "immutable", which retention and compaction make untrue in practice.
 * - The log's one connector into `Stream Processor` is labelled `live + replay`. That single arrow
 *   is the Kappa idea: new events and replayed history enter the *same* processor by the *same*
 *   path. A second "replay" arrow would draw two paths, which is the architecture this isn't.
 * - `Stream Processor` is a plain Worker — a continuous consumer — and `Materialized View` a
 *   `table` it writes to, described as "Derived, rebuildable". The two descriptors carry
 *   the contrast the whole pattern turns on: history on the left, current state on the right.
 * - `Query API` and `Analytics` *read* the view, so their arrows point at it — the consumer does
 *   the reading, the same direction CQRS's query side uses. Analytics is a plain Service: it
 *   consumes state, it isn't an API.
 * - Not Event Sourcing (no aggregates or commands — the log is the input to stream processing, not a
 *   domain model's storage) and not CQRS (no write side at all — every write here is an event).
 *
 * **Routing.** Both core connectors are level lines; the log is inset from the boundary so the
 * producers' fork lands clear of the "Streaming core" title. The two top zones are centred over the
 * log and the view, so each fork drops straight into its node's top centre and the composition
 * overhangs the core equally on both sides.
 *
 * **Flows.** "Live processing" walks one event end to end. "Rebuild view" re-walks the same two
 * core connectors with replay captions — the flow system shows the second reading of the path
 * without a second path on the canvas.
 */
/** Two services side by side inside a top zone; the gap is also the fork's spread. */
const KAP_PAIR_GAP = 40;
const KAP_ZONE = {
  width: BOUNDARY_PAD * 2 + SERVICE.width * 2 + KAP_PAIR_GAP,
  height: BOUNDARY_HEADER_TITLE_ONLY + SERVICE.height + BOUNDARY_PAD,
};
/** Between the top zones and the core. A fork's collapsed caption sits halfway down its stem, so the
 *  drop has to be long enough to lift that caption clear of the core's top edge. */
const KAP_FEED_GAP = 140;
const KAP_CORE_Y = KAP_ZONE.height + KAP_FEED_GAP;
/** Wider than `BOUNDARY_PAD`: the producers' fork drops into the log's top centre, and that stem
 *  has to clear the core's own title. The right side matches, so the core stays symmetric. */
const KAP_CORE_INSET = 56;
const KAP_SPINE = KAP_CORE_Y + BOUNDARY_HEADER_TITLE_ONLY + SERVICE.height / 2;
const KAP_LOG_X = KAP_CORE_INSET;
const KAP_LOG_Y = tubeCenteredAt(KAP_SPINE, NAMED_QUEUE.height);
/** Wide enough that the `live + replay` chip, placed a little short of the midpoint, clears the log. */
const KAP_REPLAY_GAP = 144;
const KAP_PROCESSOR_X = KAP_LOG_X + NAMED_QUEUE.width + KAP_REPLAY_GAP;
/** Wider than the shared `TABLE`: "Materialized View" doesn't fit the plain table card's width. */
const KAP_VIEW = { width: 172, height: TABLE.height };
const KAP_VIEW_X = KAP_PROCESSOR_X + SERVICE.width + BAND;
const KAP_VIEW_Y = storeCenteredAt(KAP_SPINE, TABLE_GLYPH_CENTER);
const KAP_LOG_CX = KAP_LOG_X + NAMED_QUEUE.width / 2;
const KAP_VIEW_CX = KAP_VIEW_X + KAP_VIEW.width / 2;
const KAP_CORE_WIDTH = KAP_VIEW_X + KAP_VIEW.width + KAP_CORE_INSET;
/** Annotation text is left-aligned at its own x, so each box is sized to its words to centre them. */
const KAP_HISTORY = { width: 120, height: 24 };
const KAP_DERIVED = { width: 104, height: 24 };
/** One shared row under the lowest of the two nodes, so history and derived state read as a pair. */
const KAP_DESCRIPTOR_Y = Math.max(KAP_LOG_Y + NAMED_QUEUE.height, KAP_VIEW_Y + KAP_VIEW.height) + 8;
const KAP_CORE_HEIGHT = KAP_DESCRIPTOR_Y + KAP_HISTORY.height + BOUNDARY_PAD - KAP_CORE_Y;
const KAP_PRODUCERS_X = centeredAt(KAP_LOG_CX, KAP_ZONE.width);
const KAP_SERVING_X = centeredAt(KAP_VIEW_CX, KAP_ZONE.width);
const KAP_ZONE_ROW_Y = BOUNDARY_HEADER_TITLE_ONLY;

/** A top zone's two services, left and right of its centre. */
function kappaPairX(zoneX: number, index: 0 | 1): number {
  return zoneX + BOUNDARY_PAD + index * (SERVICE.width + KAP_PAIR_GAP);
}

const kappa: ArchitectureStarter = {
  id: 'kappa',
  category: 'data',
  name: 'Kappa',
  description: 'Process live and historical data through one durable stream',
  aliases: ['kappa', 'kappa architecture', 'durable log', 'log replay', 'materialized view', 'stream processing', 'unified log'],
  nodes: [
    {
      key: 'producers',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Producers',
      x: KAP_PRODUCERS_X,
      y: 0,
      ...KAP_ZONE,
    },
    {
      key: 'application',
      type: 'service',
      serviceKind: 'generic',
      text: 'Application',
      accent: 'teal',
      parent: 'producers',
      x: kappaPairX(KAP_PRODUCERS_X, 0),
      y: KAP_ZONE_ROW_Y,
      ...SERVICE,
    },
    {
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      text: 'External System',
      accent: 'teal',
      parent: 'producers',
      x: kappaPairX(KAP_PRODUCERS_X, 1),
      y: KAP_ZONE_ROW_Y,
      ...SERVICE,
    },
    {
      key: 'core',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Streaming core',
      x: 0,
      y: KAP_CORE_Y,
      width: KAP_CORE_WIDTH,
      height: KAP_CORE_HEIGHT,
    },
    {
      key: 'log',
      type: 'queue',
      queueKind: 'stream',
      text: 'Event Log',
      parent: 'core',
      x: KAP_LOG_X,
      y: KAP_LOG_Y,
      ...NAMED_QUEUE,
      attachments: [{ type: 'note', text: 'Replay from the start through the same processor to rebuild any view.' }],
    },
    {
      key: 'history',
      type: 'text',
      text: 'Append-only, replayable',
      annotation: true,
      parent: 'core',
      x: centeredAt(KAP_LOG_CX, KAP_HISTORY.width),
      y: KAP_DESCRIPTOR_Y,
      ...KAP_HISTORY,
    },
    {
      key: 'processor',
      type: 'service',
      serviceKind: 'worker',
      text: 'Stream Processor',
      accent: 'teal',
      parent: 'core',
      x: KAP_PROCESSOR_X,
      y: centeredAt(KAP_SPINE, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'view',
      type: 'database',
      databaseKind: 'table',
      text: 'Materialized View',
      accent: 'blue',
      parent: 'core',
      x: KAP_VIEW_X,
      y: KAP_VIEW_Y,
      ...KAP_VIEW,
    },
    {
      key: 'derived',
      type: 'text',
      text: 'Derived, rebuildable',
      annotation: true,
      parent: 'core',
      x: centeredAt(KAP_VIEW_CX, KAP_DERIVED.width),
      y: KAP_DESCRIPTOR_Y,
      ...KAP_DERIVED,
    },
    {
      key: 'serving',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Serving',
      x: KAP_SERVING_X,
      y: 0,
      ...KAP_ZONE,
    },
    {
      key: 'query-api',
      type: 'service',
      serviceKind: 'api',
      text: 'Query API',
      accent: 'teal',
      parent: 'serving',
      x: kappaPairX(KAP_SERVING_X, 0),
      y: KAP_ZONE_ROW_Y,
      ...SERVICE,
    },
    {
      key: 'analytics',
      type: 'service',
      serviceKind: 'generic',
      text: 'Analytics',
      accent: 'teal',
      parent: 'serving',
      x: kappaPairX(KAP_SERVING_X, 1),
      y: KAP_ZONE_ROW_Y,
      ...SERVICE,
    },
  ],
  edges: [
    { key: 'app-publish', ...down('application', 'log') },
    { key: 'ext-publish', ...down('external', 'log') },
    { key: 'consume', ...across('log', 'processor'), label: 'live + replay' },
    { key: 'materialize', ...across('processor', 'view') },
    { key: 'query', ...down('query-api', 'view'), semantic: 'reads' },
    { key: 'analyze', ...down('analytics', 'view'), semantic: 'reads' },
  ],
  flows: [
    {
      title: 'Live processing',
      accent: 'teal',
      steps: [
        { edgeKey: 'app-publish', caption: 'Application publishes an event' },
        { edgeKey: 'consume', caption: 'Consumed live, in log order' },
        { edgeKey: 'materialize', caption: 'Projected into current state' },
        { edgeKey: 'query', caption: 'Query API reads the view' },
      ],
    },
    {
      title: 'Rebuild view',
      accent: 'violet',
      steps: [
        { edgeKey: 'consume', caption: 'Replayed from the start, same processor' },
        { edgeKey: 'materialize', caption: 'The view rebuilds from history' },
      ],
    },
  ],
};

/* ---------------------------------------------------------------- cdc -- */
/**
 * Capture once, fan out to many. The application writes to one place — its own database, the
 * source of truth — and every other system learns about that write from the database's committed
 * changes, never from the application writing twice. Three zones say it before any label is read:
 * the **operational system** on the left, the **CDC pipeline** as the one straight spine through the
 * middle, and **derived views** on the right, fed from that spine and owning nothing authoritative.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Application` sits *above* `Operational Database` inside one boundary, with exactly one
 *   outgoing arrow (`writes`) — "no dual writes" is carried by topology, not prose. The story turns
 *   90° at the database, which is where it has to turn: that's the one place a change becomes real.
 *   A quiet "Source of truth" under the database is the only descriptor on the diagram.
 * - `CDC Connector` is a Worker reaching the database with `cdc`, labelled `captures changes`
 *   (the relationship's own caption is just "CDC", which teaches nothing). Its boundary subtitle,
 *   "Captured once, after commit", is the pattern in five words; its note names the mechanism
 *   without diagramming it — the database's own change log, never the tables, never a poll.
 * - `Change Stream` is a **Stream**, not a Topic: an ordered, retained log of committed changes in
 *   which each consumer keeps its own position and a new view can replay from the start (its note).
 *   A Topic says "broadcast and forget"; that is not what a change feed is. Name and shape agree.
 * - `Derived views` holds two lanes, each a consumer Worker and the store it maintains:
 *   `Search Indexer` → `Search Index` (`indexes`), `Warehouse Loader` → `Data Warehouse`
 *   (`writes` — a derived view, named as one). The workers aren't
 *   completeness: each one owns its read position, pace and failures, which is the consumer
 *   independence CDC exists to buy — and because both read the stream the same way (`consumes`),
 *   Smart Routing draws the fan as one trunk with one caption, where two direct sinks with two
 *   different verbs could only ever be two unrelated arrows. The boundary's subtitle, "Eventually
 *   consistent", is the one supporting concept shown, and the one that makes "derived" legible.
 *
 * **Routing.** Database → connector → stream is one straight line on the spine; the two lanes sit
 * symmetrically above and below it, so the fan is balanced and every lane is a level line. The gap
 * before the pipeline is wide enough for the `captures changes` chip to sit between the two
 * boundaries rather than across either edge; the gap after it holds the fan's trunk.
 *
 * **Flow.** "Capture and fan out" walks both branches, because one-to-many is the point: one
 * commit, captured once, published once, read independently by each view.
 */
const CDC_OPS_WIDTH = SERVICE.width + BOUNDARY_PAD * 2;
const CDC_OPS_CX = CDC_OPS_WIDTH / 2;
const CDC_APP_Y = BOUNDARY_HEADER_TITLE_ONLY;
const CDC_DB_Y = CDC_APP_Y + SERVICE.height + INNER_BAND;
/** The pipeline's spine: the database's centre line, which the connector and stream share. */
const CDC_SPINE = CDC_DB_Y + STORE_GLYPH_CENTER;
/** Annotation text is left-aligned at its own x, so the box is sized to the words to centre them. */
const CDC_TRUTH = { width: 76, height: 24 };
const CDC_TRUTH_Y = CDC_DB_Y + STORE.height + 8;
const CDC_OPS_HEIGHT = CDC_TRUTH_Y + CDC_TRUTH.height + BOUNDARY_PAD;
/** Wide enough that the `captures changes` label chip (placed a little short of the line's midpoint)
 *  sits between the two boundaries, clear of both dashed edges. */
const CDC_CAPTURE_GAP = 168;
const CDC_SUBTITLE = { width: 200, height: 24 };
const CDC_SUBTITLED_TOP = BOUNDARY_TITLE_SUBLINE_Y + CDC_SUBTITLE.height + 8;
const CDC_PIPE_X = CDC_OPS_WIDTH + CDC_CAPTURE_GAP;
const CDC_PIPE_Y = CDC_SPINE - SERVICE.height / 2 - CDC_SUBTITLED_TOP;
const CDC_CONNECTOR_X = CDC_PIPE_X + BOUNDARY_PAD;
const CDC_STREAM_X = CDC_CONNECTOR_X + SERVICE.width + GUTTER;
const CDC_STREAM_Y = tubeCenteredAt(CDC_SPINE, NAMED_QUEUE.height);
const CDC_PIPE_WIDTH = CDC_STREAM_X + NAMED_QUEUE.width + BOUNDARY_PAD - CDC_PIPE_X;
/** Rounded because it is a *size*: a store's glyph centre — and so the spine derived from it — is
 *  a fraction at boxes bigger than the glyph's unit one, and a fractional width or height does not
 *  survive a save (`document/validate.ts` rounds it back), which would make the file differ from
 *  the canvas it was written from. Axes stay exact; only what gets stored is rounded — up, so the
 *  boundary never rounds down onto a child it is supposed to contain. */
const CDC_PIPE_HEIGHT = Math.ceil(
  Math.max(CDC_SPINE + SERVICE.height / 2, CDC_STREAM_Y + NAMED_QUEUE.height) + BOUNDARY_PAD - CDC_PIPE_Y,
);
/** The fan's collapsed `consumes` caption sits midway along its stem; this gap moves the trunk far
 *  enough out that the caption clears the pipeline boundary's edge instead of sitting on it. */
const CDC_FAN_GAP = 128;
const CDC_VIEWS_X = CDC_PIPE_X + CDC_PIPE_WIDTH + CDC_FAN_GAP;
const CDC_WORKER_X = CDC_VIEWS_X + BOUNDARY_PAD;
const CDC_STORE_X = CDC_WORKER_X + SERVICE.width + GUTTER;
const CDC_VIEWS_WIDTH = CDC_STORE_X + STORE.width + BOUNDARY_PAD - CDC_VIEWS_X;
const CDC_LANE_GAP = 40;
/** Each lane's centre sits this far above/below the spine, so the fan is symmetric. */
const CDC_LANE_OFFSET = (STORE.height + CDC_LANE_GAP) / 2;
const CDC_SEARCH_CY = CDC_SPINE - CDC_LANE_OFFSET;
const CDC_WAREHOUSE_CY = CDC_SPINE + CDC_LANE_OFFSET;
const CDC_VIEWS_Y = storeCenteredAt(CDC_SEARCH_CY) - CDC_SUBTITLED_TOP;
const CDC_VIEWS_HEIGHT = storeCenteredAt(CDC_WAREHOUSE_CY) + STORE.height + BOUNDARY_PAD - CDC_VIEWS_Y;

const cdc: ArchitectureStarter = {
  id: 'cdc',
  category: 'data',
  name: 'Change Data Capture',
  description: 'Capture committed changes once, fan out to derived views',
  aliases: ['cdc', 'change data capture', 'cdc pipeline', 'change stream', 'log-based replication', 'debezium'],
  nodes: [
    {
      key: 'operational',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Operational system',
      x: 0,
      y: 0,
      width: CDC_OPS_WIDTH,
      height: CDC_OPS_HEIGHT,
    },
    {
      key: 'application',
      type: 'service',
      serviceKind: 'generic',
      text: 'Application',
      accent: 'teal',
      parent: 'operational',
      x: centeredAt(CDC_OPS_CX, SERVICE.width),
      y: CDC_APP_Y,
      ...SERVICE,
    },
    {
      key: 'database',
      type: 'database',
      databaseKind: 'generic',
      text: 'Operational Database',
      accent: 'blue',
      parent: 'operational',
      x: centeredAt(CDC_OPS_CX, STORE.width),
      y: CDC_DB_Y,
      ...STORE,
    },
    {
      key: 'truth',
      type: 'text',
      text: 'Source of truth',
      annotation: true,
      parent: 'operational',
      x: centeredAt(CDC_OPS_CX, CDC_TRUTH.width),
      y: CDC_TRUTH_Y,
      ...CDC_TRUTH,
    },
    {
      key: 'pipeline',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'CDC pipeline',
      x: CDC_PIPE_X,
      y: CDC_PIPE_Y,
      width: CDC_PIPE_WIDTH,
      height: CDC_PIPE_HEIGHT,
    },
    {
      ...boundarySubtitle('pipeline-subtitle', 'pipeline', CDC_PIPE_X, 'Captured once, after commit', CDC_SUBTITLE),
      y: CDC_PIPE_Y + BOUNDARY_TITLE_SUBLINE_Y,
    },
    {
      key: 'connector',
      type: 'service',
      serviceKind: 'worker',
      text: 'CDC Connector',
      accent: 'teal',
      parent: 'pipeline',
      x: CDC_CONNECTOR_X,
      y: centeredAt(CDC_SPINE, SERVICE.height),
      ...SERVICE,
      attachments: [{ type: 'note', text: "Reads the database's own change log — never the tables, never on a poll interval." }],
    },
    {
      key: 'stream',
      type: 'queue',
      queueKind: 'stream',
      text: 'Change Stream',
      parent: 'pipeline',
      x: CDC_STREAM_X,
      y: CDC_STREAM_Y,
      ...NAMED_QUEUE,
      attachments: [{ type: 'note', text: 'Ordered and retained — a new view can replay it from the start to build itself.' }],
    },
    {
      key: 'views',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Derived views',
      x: CDC_VIEWS_X,
      y: CDC_VIEWS_Y,
      width: CDC_VIEWS_WIDTH,
      height: CDC_VIEWS_HEIGHT,
    },
    {
      ...boundarySubtitle('views-subtitle', 'views', CDC_VIEWS_X, 'Eventually consistent', CDC_SUBTITLE),
      y: CDC_VIEWS_Y + BOUNDARY_TITLE_SUBLINE_Y,
    },
    {
      key: 'search-indexer',
      type: 'service',
      serviceKind: 'worker',
      text: 'Search Indexer',
      accent: 'teal',
      parent: 'views',
      x: CDC_WORKER_X,
      y: centeredAt(CDC_SEARCH_CY, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'search-index',
      type: 'database',
      databaseKind: 'search-index',
      text: 'Search Index',
      accent: 'blue',
      parent: 'views',
      x: CDC_STORE_X,
      y: storeCenteredAt(CDC_SEARCH_CY),
      ...STORE,
    },
    {
      key: 'warehouse-loader',
      type: 'service',
      serviceKind: 'worker',
      text: 'Warehouse Loader',
      accent: 'teal',
      parent: 'views',
      x: CDC_WORKER_X,
      y: centeredAt(CDC_WAREHOUSE_CY, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'warehouse',
      type: 'database',
      databaseKind: 'generic',
      text: 'Data Warehouse',
      accent: 'blue',
      parent: 'views',
      x: CDC_STORE_X,
      y: storeCenteredAt(CDC_WAREHOUSE_CY),
      ...STORE,
    },
  ],
  edges: [
    { key: 'write', ...down('application', 'database') },
    { key: 'capture', ...across('database', 'connector'), semantic: 'cdc', label: 'captures changes' },
    { key: 'publish', ...across('connector', 'stream') },
    { key: 'consume-search', ...across('stream', 'search-indexer') },
    { key: 'consume-warehouse', ...across('stream', 'warehouse-loader') },
    { key: 'index', ...across('search-indexer', 'search-index') },
    { key: 'project', ...across('warehouse-loader', 'warehouse') },
  ],
  flows: [
    {
      title: 'Capture and fan out',
      accent: 'teal',
      steps: [
        { edgeKey: 'write', caption: 'One write, to its own database only' },
        { edgeKey: 'capture', caption: 'Captured from the log once committed' },
        { edgeKey: 'publish', caption: 'Published once, as a change event' },
        { edgeKey: 'consume-search', caption: 'The search indexer reads it at its own pace' },
        { edgeKey: 'index', caption: '…and updates the index' },
        { edgeKey: 'consume-warehouse', caption: 'The same change, read independently' },
        { edgeKey: 'project', caption: '…and loads it for analytics' },
      ],
    },
  ],
};

/* ---------------------------------------------------- saga – orchestration -- */
/**
 * A business transaction across services, coordinated by one orchestrator as a *sequence of
 * local transactions* — and, when a later step fails, *compensating actions* for the steps that
 * already committed, issued in reverse. A pattern, so it is drawn at the scope of the problem: one
 * order, three participants, no gateway, no client.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Saga Orchestrator` sits in a `Coordinator` boundary whose subtitle is its job: it drives the
 *   workflow and owns the saga's state. Nothing else is inside that boundary — ownership of the
 *   *sequence* is the orchestrator's alone, and each participant stays an autonomous service. Its
 *   accent is the one nobody else carries.
 * - `Payment`, `Inventory`, `Fulfillment` each own their own store and commit locally: three
 *   `writes`, each from its own service, and no shared database anywhere. That is what makes this
 *   a saga and not a distributed transaction.
 * - Every forward step is a `command` from the orchestrator — transport-neutral, never a plain
 *   `calls` — labelled with the step's own name. Sequence is what the flows are for.
 * - The compensations are `compensates` connectors, drawn in rose so they can never be mistaken
 *   for forward steps, and issued in reverse: fulfillment failing releases inventory, then releases
 *   payment. `Release payment` is a **new** local transaction that undoes an earlier one — the
 *   orchestrator's note says so — never a rollback of anything already committed. *When* they
 *   fire is the Compensation flow's story, not a condition chip's: a chip under either label would
 *   sit right on the fan's trunk, and the rose colour already says "not a forward step.
 *
 * **Routing.** `Order Service` sits level with the coordinator and starts the saga with one level
 * line into the orchestrator's side — from above, its drop would have to cross the boundary's own
 * subtitle. The three steps are the plain shared-anchor fan: one stem, one trunk, three drops,
 * each keeping its own label. The compensations wrap around the *outside* of the fan — one leaves
 * the orchestrator's lower-left point and lands on Payment's right side, the other leaves its
 * lower-right point and lands on Inventory's right side — so forward work reads as "straight down
 * the middle" and undoing reads as "back around the sides." Each participant pair touches four
 * distinct points, so `laneIndex` never nudges either and the forward step stays in its fan.
 *
 * **Flows.** "Happy path" is the forward sequence with each local commit as its own beat;
 * "Compensation" replays the first two steps succeeding, the third failing, and the two releases
 * in reverse.
 */
/** Wider than the shared `GUTTER`: three step captions sit side by side on the drops. */
const SAGA_GUTTER = 96;
const SAGA_CX = (SERVICE.width * 3 + SAGA_GUTTER * 2) / 2;
const SAGA_COLUMNS = columnsAt(SAGA_CX, 3, SERVICE.width, SAGA_GUTTER);
const SAGA_COORDINATOR_WIDTH = SERVICE.width + BOUNDARY_PAD * 2;
const SAGA_COORDINATOR_X = centeredAt(SAGA_CX, SAGA_COORDINATOR_WIDTH);
const SAGA_COORDINATOR_Y = 0;
/** The order service starts the saga from the coordinator's left, a full `BAND` away for the
 *  "Start saga" caption. */
const SAGA_ORDER_X = SAGA_COORDINATOR_X - BAND - SERVICE.width;
const SAGA_SUBTITLE = { width: SAGA_COORDINATOR_WIDTH - BOUNDARY_TITLE_INSET * 2, height: 24 };
const SAGA_ORCHESTRATOR_Y = SAGA_COORDINATOR_Y + BOUNDARY_TITLE_SUBLINE_Y + SAGA_SUBTITLE.height + 8;
const SAGA_COORDINATOR_HEIGHT = SAGA_ORCHESTRATOR_Y - SAGA_COORDINATOR_Y + SERVICE.height + BOUNDARY_PAD;
/** Deeper than `BAND`: the fan's trunk corridor, three drop labels, and the two compensation
 *  labels riding the outside all need the room. */
const SAGA_STEP_BAND = BAND + 56;
const SAGA_PARTICIPANT_Y = SAGA_COORDINATOR_Y + SAGA_COORDINATOR_HEIGHT + SAGA_STEP_BAND;
const SAGA_STORE_Y = SAGA_PARTICIPANT_Y + SERVICE.height + INNER_BAND;
const SAGA_PARTICIPANTS = ['payment', 'inventory', 'fulfillment'] as const;
const SAGA_PARTICIPANT_NAMES = ['Payment Service', 'Inventory Service', 'Fulfillment Service'] as const;
const SAGA_STEP_NAMES = ['Reserve payment', 'Reserve inventory', 'Schedule fulfillment'] as const;
const SAGA_STEP_KEYS = ['reserve-payment', 'reserve-inventory', 'schedule-fulfillment'] as const;
/** Where a compensation leaves the orchestrator: its lower side points, below the level line the
 *  order service starts the saga with. */
const SAGA_COMPENSATION_OUT_LEFT: StarterEdgeSpec['sourceAnchor'] = { side: 'left', offset: 0.75 };
const SAGA_COMPENSATION_OUT_RIGHT: StarterEdgeSpec['sourceAnchor'] = { side: 'right', offset: 0.75 };
/** Where a compensation lands: the participant's right side, high — beside the forward step's own
 *  top-centre anchor, never on it, and clear of the store below. */
const SAGA_COMPENSATION_IN: StarterEdgeSpec['targetAnchor'] = { side: 'right', offset: 0.25 };

function sagaParticipants(): StarterNodeSpec[] {
  return SAGA_PARTICIPANTS.flatMap((key, index): StarterNodeSpec[] => [
    {
      key,
      type: 'service',
      serviceKind: 'generic',
      text: SAGA_PARTICIPANT_NAMES[index],
      accent: 'teal',
      x: SAGA_COLUMNS[index]!,
      y: SAGA_PARTICIPANT_Y,
      ...SERVICE,
    },
    {
      key: `${key}-store`,
      type: 'database',
      databaseKind: 'generic',
      text: `${SAGA_PARTICIPANT_NAMES[index]!.replace(' Service', '')} DB`,
      accent: 'blue',
      x: centeredAt(SAGA_COLUMNS[index]! + SERVICE.width / 2, STORE.width),
      y: SAGA_STORE_Y,
      ...STORE,
    },
  ]);
}

const sagaOrchestration: ArchitectureStarter = {
  id: 'saga-orchestration',
  category: 'pattern',
  name: 'Saga – Orchestration',
  description: 'Local transactions and compensation, one coordinator',
  aliases: [
    'saga',
    'saga orchestration',
    'orchestrated saga',
    'orchestrator',
    'distributed transaction',
    'compensating transaction',
    'compensation',
  ],
  nodes: [
    {
      key: 'order',
      type: 'service',
      serviceKind: 'api',
      text: 'Order Service',
      accent: 'teal',
      x: SAGA_ORDER_X,
      y: SAGA_ORCHESTRATOR_Y,
      ...SERVICE,
    },
    {
      key: 'coordinator',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Coordinator',
      x: SAGA_COORDINATOR_X,
      y: SAGA_COORDINATOR_Y,
      width: SAGA_COORDINATOR_WIDTH,
      height: SAGA_COORDINATOR_HEIGHT,
    },
    {
      key: 'coordinator-subtitle',
      type: 'text',
      text: 'Drives the workflow, owns its state',
      annotation: true,
      parent: 'coordinator',
      x: SAGA_COORDINATOR_X + BOUNDARY_TITLE_INSET,
      y: SAGA_COORDINATOR_Y + BOUNDARY_TITLE_SUBLINE_Y,
      ...SAGA_SUBTITLE,
    },
    {
      key: 'orchestrator',
      type: 'service',
      serviceKind: 'generic',
      text: 'Saga Orchestrator',
      accent: 'violet',
      parent: 'coordinator',
      x: centeredAt(SAGA_CX, SERVICE.width),
      y: SAGA_ORCHESTRATOR_Y,
      ...SERVICE,
      attachments: [
        {
          type: 'note',
          text: 'Owns the saga’s state and the order of steps. Each service commits locally; a compensating action is a new local transaction that undoes an earlier one — never a rollback.',
        },
      ],
    },
    ...sagaParticipants(),
  ],
  edges: [
    { key: 'start', ...across('order', 'orchestrator'), semantic: 'command', label: 'Start saga' },
    ...SAGA_PARTICIPANTS.map(
      (key, index): StarterEdgeSpec => ({
        key: SAGA_STEP_KEYS[index],
        ...down('orchestrator', key),
        semantic: 'command',
        label: SAGA_STEP_NAMES[index],
      }),
    ),
    ...SAGA_PARTICIPANTS.map((key) => ({ key: `commit-${key}`, ...down(key, `${key}-store`) })),
    // The reverse sweep: the last committed step is undone first — see this block's doc comment.
    {
      key: 'release-inventory',
      from: 'orchestrator',
      to: 'inventory',
      sourceAnchor: SAGA_COMPENSATION_OUT_RIGHT,
      targetAnchor: SAGA_COMPENSATION_IN,
      semantic: 'compensates',
      label: 'Release inventory',
      accent: 'rose',
    },
    {
      key: 'release-payment',
      from: 'orchestrator',
      to: 'payment',
      sourceAnchor: SAGA_COMPENSATION_OUT_LEFT,
      targetAnchor: SAGA_COMPENSATION_IN,
      semantic: 'compensates',
      label: 'Release payment',
      accent: 'rose',
    },
  ],
  flows: [
    {
      title: 'Happy path',
      accent: 'green',
      steps: [
        { edgeKey: 'start' },
        { edgeKey: 'reserve-payment' },
        { edgeKey: 'commit-payment', caption: 'Local transaction commits' },
        { edgeKey: 'reserve-inventory' },
        { edgeKey: 'commit-inventory', caption: 'Local transaction commits' },
        { edgeKey: 'schedule-fulfillment' },
        { edgeKey: 'commit-fulfillment', caption: 'Local transaction commits — saga complete' },
      ],
    },
    {
      title: 'Compensation',
      accent: 'rose',
      steps: [
        { edgeKey: 'reserve-payment', caption: 'Succeeded' },
        { edgeKey: 'commit-payment', caption: 'Committed locally — nothing outside can roll it back' },
        { edgeKey: 'reserve-inventory', caption: 'Succeeded, and committed locally too' },
        { edgeKey: 'schedule-fulfillment', caption: 'Fails' },
        { edgeKey: 'release-inventory', caption: 'Undo the last committed step first — a new local transaction' },
        { edgeKey: 'release-payment', caption: 'Then the one before it' },
      ],
    },
  ],
};

/* ----------------------------------------------------- saga – choreography -- */
/**
 * The same business transaction with **no coordinator at all**: each service does its local
 * transaction, publishes an event about it, and the next service reacts to that event. The
 * overall process is nobody's code — it emerges from the reactions — and the annotation over the
 * row says exactly that. Drawn deliberately unlike the orchestrated saga: a chain, not a fan;
 * topics between the services, not commands from above.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Order`, `Payment`, `Inventory` are generic Services in a left-to-right row, each with its own
 *   store beneath it: every participant commits locally (`writes`), and no one shares a database.
 * - `Order Placed` and `Payment Taken` are Topics named for the *fact* they carry — a service
 *   `publishes` to the topic on its right and the topic `delivers to` the next service. Named
 *   topics rather than one shared bus so each hop reads as "this fact causes that reaction."
 * - There is no orchestrator, no saga log, no step numbers on the canvas. Anything that looked
 *   like a controller would be the other pattern.
 * - Failure is event-driven too: `Stock Rejected` is a topic Inventory publishes when it cannot
 *   reserve, and Payment reacts with `Refund payment` — a compensating action that is itself a new
 *   local transaction, drawn in rose. Its note says the unwinding keeps going the same way (Payment
 *   would publish `Payment Refunded`, Order would react to that) — one hop on the canvas is enough
 *   to teach the mechanism without a second diagram.
 *
 * **Routing.** Every forward connector is a level line between a service's side and a topic's
 * tube. The compensating topic sits *above* the row between the two services it links, so its two
 * connectors are one clean elbow up and one down, crossing nothing.
 *
 * **Flows.** "Happy path" walks the chain; "Compensation" walks the last hop failing and the
 * reaction that undoes the step before it.
 */
const CHOREO_Y = 0;
const CHOREO_ROW_CENTER = CHOREO_Y + SERVICE.height / 2;
const CHOREO_ORDER_X = 0;
const CHOREO_PLACED_X = CHOREO_ORDER_X + SERVICE.width + GUTTER;
const CHOREO_PAYMENT_X = CHOREO_PLACED_X + NAMED_QUEUE.width + GUTTER;
const CHOREO_TAKEN_X = CHOREO_PAYMENT_X + SERVICE.width + GUTTER;
const CHOREO_INVENTORY_X = CHOREO_TAKEN_X + NAMED_QUEUE.width + GUTTER;
const CHOREO_STORE_Y = CHOREO_Y + SERVICE.height + INNER_BAND;
/** The compensating topic sits a full `BAND` above the row: room for its two elbows' captions. */
const CHOREO_REJECTED_Y = CHOREO_Y - BAND - NAMED_QUEUE.height;
const CHOREO_REJECTED_X = centeredAt(
  (CHOREO_PAYMENT_X + SERVICE.width / 2 + CHOREO_INVENTORY_X + SERVICE.width / 2) / 2,
  NAMED_QUEUE.width,
);
const CHOREO_PARTICIPANTS = [
  { key: 'order', name: 'Order Service', x: CHOREO_ORDER_X },
  { key: 'payment', name: 'Payment Service', x: CHOREO_PAYMENT_X },
  { key: 'inventory', name: 'Inventory Service', x: CHOREO_INVENTORY_X },
] as const;

function choreoTopic(key: string, text: string, x: number, y = tubeCenteredAt(CHOREO_ROW_CENTER, NAMED_QUEUE.height)): StarterNodeSpec {
  return { key, type: 'queue', queueKind: 'topic', text, x, y, ...NAMED_QUEUE };
}

const sagaChoreography: ArchitectureStarter = {
  id: 'saga-choreography',
  category: 'pattern',
  name: 'Saga – Choreography',
  description: 'Local transactions chained by events, with no coordinator',
  aliases: [
    'saga choreography',
    'choreographed saga',
    'choreography',
    'event-driven saga',
    'no orchestrator',
    'reactive saga',
  ],
  nodes: [
    {
      key: 'annotation',
      type: 'text',
      text: 'No central coordinator: each service reacts to an event and publishes its own',
      annotation: true,
      x: CHOREO_ORDER_X,
      y: CHOREO_Y - 44,
      width: 460,
      height: 24,
    },
    ...CHOREO_PARTICIPANTS.flatMap(({ key, name, x }): StarterNodeSpec[] => [
      {
        key,
        type: 'service',
        serviceKind: 'generic',
        text: name,
        accent: 'teal',
        x,
        y: CHOREO_Y,
        ...SERVICE,
      },
      {
        key: `${key}-store`,
        type: 'database',
        databaseKind: 'generic',
        text: `${name.replace(' Service', '')} DB`,
        accent: 'blue',
        x: centeredAt(x + SERVICE.width / 2, STORE.width),
        y: CHOREO_STORE_Y,
        ...STORE,
      },
    ]),
    choreoTopic('placed', 'Order Placed', CHOREO_PLACED_X),
    choreoTopic('taken', 'Payment Taken', CHOREO_TAKEN_X),
    {
      ...choreoTopic('rejected', 'Stock Rejected', CHOREO_REJECTED_X, CHOREO_REJECTED_Y),
      attachments: [
        {
          type: 'note',
          text: 'Compensation is event-driven too: Payment refunds and publishes Payment Refunded; Order reacts to that in turn. Every hop of the unwinding is one more reaction.',
        },
      ],
    },
  ],
  edges: [
    { key: 'place', ...across('order', 'placed') },
    { key: 'take', ...across('placed', 'payment') },
    { key: 'taken', ...across('payment', 'taken') },
    { key: 'reserve', ...across('taken', 'inventory') },
    ...CHOREO_PARTICIPANTS.map(({ key }) => ({ key: `commit-${key}`, ...down(key, `${key}-store`) })),
    // The compensating event: up from Inventory into the topic, down from the topic into Payment.
    { key: 'reject', from: 'inventory', to: 'rejected', sourceAnchor: TOP, targetAnchor: RIGHT, accent: 'rose' },
    {
      key: 'refund',
      from: 'rejected',
      to: 'payment',
      sourceAnchor: LEFT,
      targetAnchor: TOP,
      label: 'Refund payment',
      accent: 'rose',
    },
  ],
  flows: [
    {
      title: 'Happy path',
      accent: 'green',
      steps: [
        { edgeKey: 'commit-order', caption: 'Order commits locally' },
        { edgeKey: 'place', caption: 'And publishes the fact' },
        { edgeKey: 'take', caption: 'Payment reacts — nobody told it to' },
        { edgeKey: 'commit-payment', caption: 'Its own local transaction' },
        { edgeKey: 'taken' },
        { edgeKey: 'reserve', caption: 'Inventory reacts in turn' },
        { edgeKey: 'commit-inventory', caption: 'Stock reserved — the saga completed with no one in charge' },
      ],
    },
    {
      title: 'Compensation',
      accent: 'rose',
      steps: [
        { edgeKey: 'reserve', caption: 'Inventory cannot reserve the stock' },
        { edgeKey: 'reject', caption: 'It publishes the failure as an event' },
        { edgeKey: 'refund', caption: 'Payment reacts: a refund, a new local transaction' },
        { edgeKey: 'commit-payment', caption: 'Committed locally — and the unwinding continues the same way' },
      ],
    },
  ],
};

/* ----------------------------------------------------- transactional outbox -- */
/**
 * How a service publishes an event *reliably*: it never writes to the broker at all. The business
 * row and an outbox row are written in **one local transaction** — the boundary in the middle of
 * the diagram *is* that transaction, its subtitle is the invariant, and the two things inside it
 * are drawn as **tables**, not databases: two tables of one store, never two stores. A separate
 * publisher relays the outbox to the broker afterwards.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Producer Service` writes `Business Data` and the `Outbox` in one fan of two `writes`, both
 *   landing inside the transaction boundary. It has no connector to the broker — that absence is
 *   the pattern. Its note says why: if the transaction rolls back, the event was never written.
 * - `Business Data` and `Outbox` are `table` Data Stores: logical tables inside the same database.
 *   The broker is three columns away and outside the boundary, so nothing can read as "the broker
 *   joined the transaction" — avoiding that distributed transaction is the whole point.
 * - `Outbox Publisher` is a Worker that `reads unpublished` rows *after* the commit and
 *   `publishes` them. Polling or tailing the log (CDC) — the outbox's note says both fit — is an
 *   implementation detail the diagram leaves open.
 * - `Domain Events` is the broker's topic; `Consumer Service` is any subscriber. At-least-once
 *   delivery is the honest consequence, and the consumer's note carries the dedupe rule.
 *
 * **Routing.** The two writes bundle into one `writes` trunk; everything downstream is one level
 * line, `reads unpublished` → `publishes` → `delivers to`, the topic's tube sitting on the same
 * axis as the outbox row.
 *
 * **Flows.** Three, because three things happen at three different times: the service's own
 * transaction, the publisher's relay, and the consumer's delivery.
 */
const OUTBOX_SUBTITLE = { width: 200, height: 24 };
const OUTBOX_TOP = BOUNDARY_TITLE_SUBLINE_Y + OUTBOX_SUBTITLE.height + 8;
/** Tighter than `INNER_BAND`: two rows of one transaction, not two layers of an architecture. */
const OUTBOX_ROW_GAP = 40;
const OUTBOX_BUSINESS_Y = OUTBOX_TOP;
const OUTBOX_RECORD_Y = OUTBOX_BUSINESS_Y + TABLE.height + OUTBOX_ROW_GAP;
const OUTBOX_BOX_WIDTH = TABLE.width + BOUNDARY_PAD * 2;
const OUTBOX_BOX_HEIGHT = OUTBOX_RECORD_Y + TABLE.height + BOUNDARY_PAD;
const OUTBOX_PRODUCER_X = 0;
/** A full `BAND`: the fan's trunk corridor plus its collapsed `writes` caption. */
const OUTBOX_BOX_X = OUTBOX_PRODUCER_X + SERVICE.width + BAND;
const OUTBOX_STORE_X = OUTBOX_BOX_X + BOUNDARY_PAD;
/** A full `BAND` again: `reads unpublished` is the longest caption in the catalog. */
const OUTBOX_PUBLISHER_X = OUTBOX_BOX_X + OUTBOX_BOX_WIDTH + BAND;
const OUTBOX_TOPIC_X = OUTBOX_PUBLISHER_X + SERVICE.width + GUTTER;
const OUTBOX_CONSUMER_X = OUTBOX_TOPIC_X + NAMED_QUEUE.width + GUTTER;
/** The producer faces the middle of the two rows it writes; everything downstream sits on the outbox row. */
const OUTBOX_ROWS_CENTER = (OUTBOX_BUSINESS_Y + OUTBOX_RECORD_Y) / 2 + TABLE_GLYPH_CENTER;
const OUTBOX_RECORD_CENTER = OUTBOX_RECORD_Y + TABLE_GLYPH_CENTER;

const transactionalOutbox: ArchitectureStarter = {
  id: 'transactional-outbox',
  category: 'pattern',
  name: 'Transactional Outbox',
  description: 'Persist state and event intent atomically, publish after',
  aliases: ['outbox', 'transactional outbox', 'outbox pattern', 'dual write', 'reliable publish'],
  nodes: [
    {
      key: 'producer',
      type: 'service',
      serviceKind: 'api',
      text: 'Producer Service',
      accent: 'teal',
      x: OUTBOX_PRODUCER_X,
      y: centeredAt(OUTBOX_ROWS_CENTER, SERVICE.height),
      ...SERVICE,
      attachments: [
        {
          type: 'note',
          text: 'Never talks to the broker. If the transaction rolls back, the event was never written either.',
        },
      ],
    },
    {
      key: 'transaction',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'One local transaction',
      x: OUTBOX_BOX_X,
      y: 0,
      width: OUTBOX_BOX_WIDTH,
      height: OUTBOX_BOX_HEIGHT,
    },
    boundarySubtitle('transaction-subtitle', 'transaction', OUTBOX_BOX_X, 'Committed together, or not at all', OUTBOX_SUBTITLE),
    {
      key: 'business',
      type: 'database',
      databaseKind: 'table',
      text: 'Business Data',
      accent: 'blue',
      parent: 'transaction',
      x: OUTBOX_STORE_X,
      y: OUTBOX_BUSINESS_Y,
      ...TABLE,
    },
    {
      key: 'outbox',
      type: 'database',
      databaseKind: 'table',
      text: 'Outbox',
      accent: 'blue',
      parent: 'transaction',
      x: OUTBOX_STORE_X,
      y: OUTBOX_RECORD_Y,
      ...TABLE,
      attachments: [
        {
          type: 'note',
          text: 'A table in the same database. Rows are marked published (or deleted) after the broker acks. Poll it, or tail the log (CDC) — same shape.',
        },
      ],
    },
    {
      key: 'publisher',
      type: 'service',
      serviceKind: 'worker',
      text: 'Outbox Publisher',
      accent: 'teal',
      x: OUTBOX_PUBLISHER_X,
      y: centeredAt(OUTBOX_RECORD_CENTER, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'events',
      type: 'queue',
      queueKind: 'topic',
      text: 'Domain Events',
      x: OUTBOX_TOPIC_X,
      y: tubeCenteredAt(OUTBOX_RECORD_CENTER, NAMED_QUEUE.height),
      ...NAMED_QUEUE,
    },
    {
      key: 'consumer',
      type: 'service',
      serviceKind: 'worker',
      text: 'Consumer Service',
      accent: 'teal',
      x: OUTBOX_CONSUMER_X,
      y: centeredAt(OUTBOX_RECORD_CENTER, SERVICE.height),
      ...SERVICE,
      attachments: [
        { type: 'note', text: 'At-least-once: the same event can arrive twice. Dedupe on the event id.' },
      ],
    },
  ],
  edges: [
    // One fan, both branches inside the transaction — see this block's doc comment.
    { key: 'write-business', ...across('producer', 'business') },
    { key: 'write-outbox', ...across('producer', 'outbox') },
    { key: 'relay', ...across('outbox', 'publisher'), label: 'reads unpublished' },
    { key: 'publish', ...across('publisher', 'events') },
    { key: 'deliver', ...across('events', 'consumer') },
  ],
  flows: [
    {
      title: 'Service transaction',
      accent: 'amber',
      steps: [
        { edgeKey: 'write-business', caption: 'The business change' },
        { edgeKey: 'write-outbox', caption: 'And the event to publish — same transaction' },
      ],
    },
    {
      title: 'Outbox publication',
      accent: 'violet',
      steps: [
        { edgeKey: 'relay', caption: 'Later, and independently — after the commit' },
        { edgeKey: 'publish', caption: 'Then mark the row published' },
      ],
    },
    {
      title: 'Event consumption',
      accent: 'green',
      steps: [{ edgeKey: 'deliver', caption: 'Possibly more than once — the consumer dedupes' }],
    },
  ],
};

/** Architectures first, then data architectures, then patterns — the palette's three headers stay
 *  contiguous by construction (`commands/registry.ts`'s `starterCommands`). */
export const ARCHITECTURE_STARTERS: readonly ArchitectureStarter[] = [
  monolith,
  modularMonolith,
  microservices,
  eventDriven,
  hexagonal,
  backendForFrontend,
  cqrs,
  medallion,
  kappa,
  cdc,
  sagaOrchestration,
  sagaChoreography,
  transactionalOutbox,
];
