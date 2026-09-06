/**
 * The five Architecture Starters, composed by hand.
 *
 * Every coordinate here is deliberate. These are canonical diagrams whose structure is known in
 * advance, so the composition is authored rather than solved: hierarchy reads top to bottom,
 * columns share a gutter, related things align on the same axis, and each starter carries only
 * enough elements to establish its pattern. The empty space is part of the design — a starter is
 * the first thirty seconds of a diagram, not a reference architecture.
 *
 * Two rules the compositions follow, and one they don't:
 *
 * - **Relationships are never stated here.** `build.ts` derives every connector's semantics from
 *   the capability matrix, so a starter says what it connects and Draft Canvas says what that means.
 * - **Anchors are always stated here.** Symmetry is the whole point; leaving `chooseSides` to
 *   re-derive a fan-out's sides would let it drift as soon as anything moves.
 * - Nothing here sets a colour, a font, or a personality. A starter is document content; how it
 *   looks is the canvas's business (`ui/personality/`, `render/theme/tokens.ts`), so a starter is
 *   automatically correct in every theme and every personality.
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
  centeredAt,
  columnsAt,
} from './compose';
import type { ArchitectureStarter, StarterEdgeSpec, StarterNodeSpec } from './types';

/* ------------------------------------------------------------------ sizes -- */
/** Mirrors of `document/limits.ts`'s `DEFAULTS`, named for what they are here. Authoring against
 *  literals keeps every coordinate below arithmetically checkable by eye. */
const SERVICE = { width: 176, height: 68 };
const STORE = { width: 148, height: 88 };
const TOPIC = { width: 140, height: 48 };
const ACTOR = { width: 120, height: 92 };
const TOP: StarterEdgeSpec['sourceAnchor'] = { side: 'top', offset: 0.5 };
const BOTTOM: StarterEdgeSpec['sourceAnchor'] = { side: 'bottom', offset: 0.5 };
const LEFT: StarterEdgeSpec['sourceAnchor'] = { side: 'left', offset: 0.5 };
const RIGHT: StarterEdgeSpec['sourceAnchor'] = { side: 'right', offset: 0.5 };

/** A plain top-to-bottom connection: the default reading direction of every starter. */
function down(from: string, to: string): StarterEdgeSpec {
  return { from, to, sourceAnchor: BOTTOM, targetAnchor: TOP };
}

/* --------------------------------------------------------------- monolith -- */
/**
 * One deployable application, drawn as one box.
 *
 * The composition is a single centred column — a monolith should *feel* centralized before a word
 * of it is read — with the two things that are genuinely outside the application (its data store
 * and a third-party dependency) placed plainly outside the boundary. It is a clean monolith, not a
 * cautionary tale: the internals are ordered, not tangled.
 */
const MONOLITH_CX = 160;
const MONOLITH_BOUNDARY_WIDTH = 320;
const MONOLITH_API_Y = BOUNDARY_HEADER;
const MONOLITH_LOGIC_Y = MONOLITH_API_Y + SERVICE.height + INNER_BAND;
const MONOLITH_BOUNDARY_HEIGHT = MONOLITH_LOGIC_Y + SERVICE.height + BOUNDARY_PAD;

const monolith: ArchitectureStarter = {
  id: 'monolith',
  name: 'Monolith',
  description: 'One deployable application over one data store',
  aliases: ['monolith', 'monolithic', 'single deployment', 'one application'],
  nodes: [
    {
      key: 'client',
      type: 'actor',
      actorKind: 'human',
      text: 'Client',
      x: centeredAt(MONOLITH_CX, ACTOR.width),
      y: -(BAND + ACTOR.height),
      ...ACTOR,
    },
    {
      key: 'app',
      type: 'group',
      boundaryPreset: 'deployment',
      text: 'Application',
      x: 0,
      y: 0,
      width: MONOLITH_BOUNDARY_WIDTH,
      height: MONOLITH_BOUNDARY_HEIGHT,
    },
    {
      key: 'api',
      type: 'service',
      serviceKind: 'api',
      accent: 'teal',
      parent: 'app',
      x: centeredAt(MONOLITH_CX, SERVICE.width),
      y: MONOLITH_API_Y,
      ...SERVICE,
    },
    {
      key: 'logic',
      type: 'service',
      serviceKind: 'generic',
      text: 'Business Logic',
      accent: 'teal',
      parent: 'app',
      x: centeredAt(MONOLITH_CX, SERVICE.width),
      y: MONOLITH_LOGIC_Y,
      ...SERVICE,
    },
    {
      key: 'database',
      type: 'database',
      databaseKind: 'sql',
      text: 'Database',
      accent: 'blue',
      x: centeredAt(MONOLITH_CX, STORE.width),
      y: MONOLITH_BOUNDARY_HEIGHT + BAND,
      ...STORE,
    },
    {
      // Outside the boundary, on the same axis as the code that calls it, so the arrow crossing
      // the boundary edge is a clean horizontal — "this one leaves the application."
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      accent: 'teal',
      x: MONOLITH_BOUNDARY_WIDTH + BAND,
      y: MONOLITH_LOGIC_Y,
      ...SERVICE,
    },
  ],
  edges: [
    down('client', 'api'),
    down('api', 'logic'),
    down('logic', 'database'),
    { from: 'logic', to: 'external', sourceAnchor: RIGHT, targetAnchor: LEFT },
  ],
};

/* ------------------------------------------------------- modular monolith -- */
/**
 * One deployable application whose internals are the whole point: three peer modules, each
 * reached individually through one internal adapter, each owning its own slice of one shared
 * database. Every choice below exists to keep this from reading as Microservices, a layered
 * architecture, a request-fan-out bus, or a linear pipeline — the four misreadings a Modular
 * Monolith most needs to avoid.
 *
 * The outer boundary reads `Application` / `Single deployable unit`, not `Application` under a
 * fixed `DEPLOYMENT` tag. `boundaryPreset: 'deployment'`'s caption is a closed vocabulary word
 * (`nodes/describe.ts`'s `BOUNDARY_PRESET_LABELS`) — there's no way to make it say anything but
 * `DEPLOYMENT` — so saying the actual phrase means dropping the preset caption
 * (`boundaryPreset: 'boundary'`, the same choice Hexagonal already made for `Application Core`)
 * and adding one small `annotation: true` text node directly under the boundary's own title, the
 * identical technique Hexagonal already uses for its own `Inbound ports`/`Outbound ports` labels.
 * `Application` stays the one real title (primary, in `groupTitle`);
 * `Single deployable unit` rides the quiet annotation style (secondary, muted, no chip) — and
 * says, specifically, *unit*: this boundary is the one thing that gets built and shipped as a
 * single artifact, not a generic "everything the application owns" container. That distinction is
 * what earns the database its place *outside* it (see below). The subtitle sits at
 * `BOUNDARY_TITLE_INSET`/`BOUNDARY_TITLE_SUBLINE_Y` (`compose.ts`) rather than an ordinary child's
 * `BOUNDARY_PAD` inset and `BOUNDARY_HEADER_CAPTION_ONLY` floor — it shares the title's own left
 * edge and sits as close beneath it as the title's own metrics allow, deliberately reading as the
 * second line of one header rather than a detached annotation that happens to be nearby.
 * `API` and all three modules still sit inside this one boundary: nothing here gets its own
 * separate boundary, which is precisely
 * what would turn this into Microservices.
 *
 * `Payments`, `Orders`, and `Customer` are `Component`/`module` nodes, not empty boundaries. An
 * empty boundary box says "here is a zone" and nothing else — it can't be the hero of a diagram,
 * only its container. A Component is a real, sized, named thing that can still sit inside
 * `Application`'s own boundary while reading as internal rather than a deployable peer — the same
 * read `docs/ARCHITECTURE.md` already documents for Hexagonal's Use Cases and Domain Model,
 * applied here to the primitive it names for exactly this ("an internal subdivision" —
 * `document/types.ts`'s `COMPONENT_KINDS`). Grown past Component's own default footprint (152×56
 * → `MODULE`'s 176×76) the same way Hexagonal grew its one hub node past default for hero status —
 * except here there's no separate "core" competing for it, so the growth goes straight to the
 * three modules themselves. They stay larger than `API` and sit as visual peers of each other:
 * identical size, identical row, no nesting, no nesting hierarchy implied.
 *
 * `API` is a `Component`/`adapter`, not a `Service` — the monolith's own inbound dispatch point,
 * living entirely inside the one `Application` boundary, not an externally-reachable network
 * endpoint. `actor>component` infers the correct `calls` for the one crossing that's real here
 * (Client → API). Its three edges down into the modules are `component>component`, whose own
 * exact matrix row defaults to `uses`, not `service>service`'s `calls` — in-process dispatch never
 * reads as a network call. All three leave the same point on `API`'s bottom edge
 * (`down('api', …)`, the plain shared-anchor helper every other fan-out in this file uses), so
 * `edges/bundles.ts`'s Smart Routing bundles them into one shared trunk with one collapsed "uses"
 * caption — a symmetric fork reading as one deliberate relationship into three peer capabilities,
 * not three unrelated lines that happen to start nearby. An earlier revision kept these
 * individually unbundled (`routeMode: 'direct'`, spread anchors, straight lines) on the theory
 * that a shared trunk flattens three separately-owned relationships into one; the accepted design
 * came back to the bundle regardless — the symmetric, single-caption fork reads as more
 * intentional than three separate diagonals, and the document model underneath is identical
 * either way (three real, independent, individually-selectable edges — bundling is a rendering
 * choice, `edges/bundles.ts`'s own doc comment is explicit that nothing about the relationships
 * themselves changes). The API is an inbound adapter into three capabilities, never an
 * orchestration bus; the trunk says "one entry point," not "one relationship."
 *
 * Module-to-module coupling is exactly one edge: `Orders → Customer`, captioned `uses public API`
 * rather than the plain inferred `uses` — an explicit `label` override (the one documented escape
 * hatch from "relationships come from the matrix," `StarterEdgeSpec.label`) naming the *rule*
 * itself: modules may collaborate, but only through another module's own public surface, never by
 * reaching into its internals. `Payments` carries no module-to-module edge at all, staying a
 * fully independent peer. A chain (`Payments → Orders → Customer`) or a mesh would invent
 * domain coupling this pattern doesn't actually require; the point is that *a* controlled,
 * explicit, contract-shaped dependency is possible, not that every module needs one.
 *
 * `Shared Infrastructure` — an earlier revision's fourth internal layer — stays gone. It added a
 * whole extra tier purely to gesture at "some shared platform code exists," without being
 * load-bearing for what this starter is actually about: modules, their explicit contract, and
 * their data.
 *
 * The database sits *outside* the one `Application` boundary, centred directly beneath it — the
 * boundary is the single deployable *unit*, and a database is normally its own separate runtime
 * resource, not something that ships inside the same deployed artifact as the application code. A
 * previous revision moved it inside on the reasoning that a modular monolith's database "ships as
 * part of the one deployable unit"; that blurred exactly the distinction `Single deployable unit`
 * now exists to draw, and is reverted here. Placement alone still keeps it visibly, unambiguously
 * associated with the application above it: centred on the same axis, one ordinary gap below,
 * with nothing else nearby it could be mistaken for belonging to.
 *
 * It carries exactly one edge: `Application → Application Database` (`down('app', 'database')`),
 * from the boundary itself, not any one module. No per-module edge exists — an earlier revision
 * drew `Payments → Application Database`/`Orders → …`/`Customer → …`, each labelled `owns`, but
 * every one of those edges necessarily starts at a *module* and ends at the *database node
 * itself*, so the arrow's own endpoints say "Payments owns [the] Application Database" no matter
 * what word labels it — three modules can't each own the same one node without that reading like
 * three overlapping claims on the same thing, which is exactly backwards: the modules own their
 * *data*, not the shared physical store that happens to hold it. The boundary-level edge instead
 * says "the application, as a whole, persists here" — a claim only the boundary itself can
 * honestly make.
 *
 * That edge is deliberately uncaptioned. A `group` node has no category of its own in
 * `connectorSemantics.ts` (`categoryOf` falls through to `'generic'`, exactly alongside `text`,
 * `note`, and `code` — `tests/connector-semantics.test.ts` pins this explicitly, so it's a tested,
 * deliberate design decision, not a gap this file could patch on its own authority), and the
 * capability matrix's own doc comment lists "anything touching a generic node" among its
 * deliberately-absent pairs — so `inferRelationship` genuinely returns nothing for this pairing,
 * the same honest "no opinion" a hand-drawn boundary→database connection gets anywhere else in the
 * app. Rather than force a label onto a relationship the matrix doesn't recognise (which would say
 * something the rest of the app doesn't actually agree with — the one thing `docs/ARCHITECTURE.md`'s
 * own rule for this file, "relationships come from the matrix, never from the catalog," exists to
 * prevent), this connector carries no `label` and gets none: `DraftEdgeView.tsx`'s caption block is
 * gated on `edge.semantic` being truthy, so an edge with neither an inferred semantic nor an
 * explicit label renders as a plain, honest line — present because the association is real, silent
 * because Draft Canvas has no opinion on what to call it at this level. `Application Database` is
 * sized to `MODULE`'s own width (176, not `STORE`'s default 148) because its label needs the room
 * on a single line — a data-store cylinder's caption never wraps (`nodes/describe.ts`'s
 * `dataStoreCylinder`). No annotation sits beneath it either: an earlier revision added
 * `Module-owned data` to spell out the ownership principle in words, but the boundary-level edge,
 * the database's own placement, and the module row above it already carry that weight — a caption
 * repeating what the diagram already shows is exactly the noise a starter should stay quiet about.
 */
/** The one inbound interface of the monolith — a routing/dispatch adapter, not an independently
 *  deployable network peer. Kept at Component's own default footprint (`document/limits.ts`'s
 *  `componentWidth`/`componentHeight`): a Component that isn't this diagram's hero gets no special
 *  treatment, exactly like Hexagonal's own Adapters. */
const API = { width: 152, height: 56 };
/** The three business modules — the entire reason this diagram exists. Grown past Component's
 *  default the way Hexagonal grew exactly one component, its hub — but by more, since these three
 *  aren't sharing hero status with a separate "core." */
const MODULE = { width: 176, height: 76 };
const MODULAR_CX = 396;
const MODULE_COLUMNS = columnsAt(MODULAR_CX, 3, MODULE.width, GUTTER);
const MODULAR_INNER_LEFT = MODULE_COLUMNS[0]!;
const MODULAR_INNER_WIDTH = MODULE_COLUMNS[2]! + MODULE.width - MODULAR_INNER_LEFT;
// `BOUNDARY_TITLE_SUBLINE_Y`, not `BOUNDARY_HEADER_CAPTION_ONLY`: the latter is the floor an
// ordinary child of *any* boundary must clear, generous enough to also cover presets with a real
// caption row above the title; this subtitle isn't ordinary content, it's the second line of the
// boundary's own header, and sits exactly as close to the title as that header's own metrics
// allow — see `tests/starters.test.ts`'s narrow, explicit exception for this one node.
const MODULAR_SUBTITLE_Y = BOUNDARY_TITLE_SUBLINE_Y;
/** The boundary's own `Single deployable unit` subtitle — the one small `annotation: true` label
 *  left in this starter. Width reuses `MODULE`'s own 176, comfortably past what the text needs at
 *  this style's real font metrics (`connectorCaption`, 9.5px/500, measured directly in a canvas
 *  context rather than estimated — the fallback text measurer this repo's own test environment
 *  uses under-measures real browser font metrics by a wide enough margin to pass a narrower check
 *  here and still visibly clip live). */
const MODULAR_NOTE = { width: MODULE.width, height: 24 };
const MODULAR_NOTE_GAP = 8;
// Clears the `Single deployable unit` subtitle before the API begins — `BOUNDARY_HEADER` alone
// (sized for a preset caption + title, not a title + a second annotation line) would overlap it.
const MODULAR_API_Y = MODULAR_SUBTITLE_Y + MODULAR_NOTE.height + MODULAR_NOTE_GAP;
/** A full `BAND`, not `INNER_BAND`: this is the one gap the API→module fan-out has to plan a
 *  shared trunk across (`edges/bundles.ts`), and a trunk that lands a few pixels above the modules
 *  it feeds reads as a near-miss rather than as routing. */
const MODULAR_MODULES_Y = MODULAR_API_Y + API.height + BAND;
// The module row is the last thing the boundary contains — the database moved back outside it
// (see this block's own doc comment) — so `BOUNDARY_PAD` closes the boundary directly beneath it.
const MODULAR_BOUNDARY_HEIGHT = MODULAR_MODULES_Y + MODULE.height + BOUNDARY_PAD;
const MODULAR_BOUNDARY_WIDTH = MODULAR_INNER_WIDTH + BOUNDARY_PAD * 2;
/** `MODULE`'s width, not `STORE`'s default 148: "Application Database" needs the room on a single
 *  line — a data-store cylinder's caption never wraps (`nodes/describe.ts`'s `dataStoreCylinder`).
 */
const DATABASE_BOX = { width: MODULE.width, height: STORE.height };
// `INNER_BAND`, not the fuller `BAND`: the one boundary→database edge is a single uncaptioned
// line, not a fan needing trunk-planning room (see this block's own doc comment) — only enough gap
// to read as clearly its own separate runtime resource, not a part the boundary forgot to include.
const MODULAR_DATABASE_Y = MODULAR_BOUNDARY_HEIGHT + INNER_BAND;

const modularMonolith: ArchitectureStarter = {
  id: 'modular-monolith',
  name: 'Modular Monolith',
  description: 'One deployment, strongly separated modules',
  aliases: [
    'modular monolith',
    'modular architecture',
    'modules',
    'module boundaries',
    'majestic monolith',
    'monolith modules',
  ],
  nodes: [
    {
      key: 'client',
      type: 'actor',
      actorKind: 'human',
      text: 'Client',
      x: centeredAt(MODULAR_CX, ACTOR.width),
      y: -(BAND + ACTOR.height),
      ...ACTOR,
    },
    {
      // `'boundary'`, not `'deployment'`: that preset's caption is the fixed word `DEPLOYMENT`,
      // and this starter says the actual phrase "single deployable unit" instead, via the plain
      // annotation right below (`app-subtitle`) — the same "preset caption is a closed
      // vocabulary, an annotation is free text" split Hexagonal already established.
      key: 'app',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Application',
      x: MODULAR_INNER_LEFT - BOUNDARY_PAD,
      y: 0,
      width: MODULAR_BOUNDARY_WIDTH,
      height: MODULAR_BOUNDARY_HEIGHT,
    },
    {
      // Sits directly beneath the boundary's own title (drawn by `group()` itself, not a node) —
      // a plain annotation, not a second title competing for the same line, but deliberately
      // sharing the title's exact left edge (`BOUNDARY_TITLE_INSET`, 12) rather than falling back
      // to an ordinary child's wider `BOUNDARY_PAD` inset: this is the second line of one header,
      // not independent content, and reads as one only if it lines up with the first. See
      // `tests/starters.test.ts`'s narrow, explicit exception for this one node.
      key: 'app-subtitle',
      type: 'text',
      text: 'Single deployable unit',
      annotation: true,
      parent: 'app',
      x: MODULAR_INNER_LEFT - BOUNDARY_PAD + BOUNDARY_TITLE_INSET,
      y: MODULAR_SUBTITLE_Y,
      ...MODULAR_NOTE,
    },
    {
      key: 'api',
      type: 'component',
      componentKind: 'adapter',
      text: 'API',
      parent: 'app',
      x: centeredAt(MODULAR_CX, API.width),
      y: MODULAR_API_Y,
      ...API,
    },
    // Left to right: Payments, Orders, Customer — Orders adjacent to Customer is what keeps the
    // one module-to-module edge below (`Orders → Customer`) a short, non-crossing hop; Payments
    // carries no module-to-module edge at all, staying a fully independent peer.
    {
      key: 'module-payments',
      type: 'component',
      componentKind: 'module',
      text: 'Payments',
      parent: 'app',
      x: MODULE_COLUMNS[0]!,
      y: MODULAR_MODULES_Y,
      ...MODULE,
    },
    {
      key: 'module-orders',
      type: 'component',
      componentKind: 'module',
      text: 'Orders',
      parent: 'app',
      x: MODULE_COLUMNS[1]!,
      y: MODULAR_MODULES_Y,
      ...MODULE,
    },
    {
      key: 'module-customer',
      type: 'component',
      componentKind: 'module',
      text: 'Customer',
      parent: 'app',
      x: MODULE_COLUMNS[2]!,
      y: MODULAR_MODULES_Y,
      ...MODULE,
    },
    {
      // Outside `app`, not inside it — see this block's own doc comment. Centred on the same
      // `MODULAR_CX` axis as everything above it, so the association reads from alignment alone.
      key: 'database',
      type: 'database',
      databaseKind: 'sql',
      text: 'Application Database',
      accent: 'blue',
      x: centeredAt(MODULAR_CX, DATABASE_BOX.width),
      y: MODULAR_DATABASE_Y,
      ...DATABASE_BOX,
    },
  ],
  edges: [
    down('client', 'api'),
    // All three leave the same point on API's bottom edge, so Smart Routing bundles them into one
    // shared trunk with one collapsed "uses" caption — three individual edges in the document
    // model (each still its own relationship, still independently selectable/deletable), one
    // deliberate, symmetric fork on screen. See this block's own doc comment for why this starter
    // wants the bundle here, unlike the module→database connectors below.
    down('api', 'module-payments'),
    down('api', 'module-orders'),
    down('api', 'module-customer'),
    // The one controlled, explicit module dependency — see this block's own doc comment for why
    // it's exactly one, and why it's captioned as a contract rather than the plain inferred `uses`.
    { from: 'module-orders', to: 'module-customer', sourceAnchor: RIGHT, targetAnchor: LEFT, label: 'uses public API' },
    // The one high-level "this application persists somewhere" connector — from the boundary
    // itself, not any one module. Deliberately uncaptioned: see this block's own doc comment.
    down('app', 'database'),
  ],
};

/* --------------------------------------------------------- microservices -- */
/**
 * Independent services that own their data.
 *
 * Each service and its store live inside their *own* `deployment` boundary — that is the whole
 * opinion of this starter, and the reason it can't be confused with the Modular Monolith. There is
 * no shared database, no service-to-service call, and no mesh. The gateway's one-to-three fan
 * bundles into a shared trunk automatically (`edges/bundles.ts`, `MIN_SPINE_MEMBERS = 3`), which is
 * exactly the picture you want while saying "everything comes in through the gateway."
 *
 * The boundaries carry no title of their own: the service inside already names the thing, and a
 * repeated name would be noise. The `DEPLOYMENT` caption is the entire point they're making.
 *
 * Three services, not ten — and generous space below for the asynchronous integration the
 * developer adds next, one right-click away via "Add Consumer".
 */
const SERVICE_BOX = {
  width: SERVICE.width + BOUNDARY_PAD * 2,
  height: BOUNDARY_HEADER_CAPTION_ONLY + SERVICE.height + INNER_BAND + STORE.height + BOUNDARY_PAD,
};
const MICRO_CX = 444;
const MICRO_COLUMNS = columnsAt(MICRO_CX, 3, SERVICE_BOX.width, GUTTER);
const MICRO_SERVICE_Y = BOUNDARY_HEADER_CAPTION_ONLY;
const MICRO_STORE_Y = MICRO_SERVICE_Y + SERVICE.height + INNER_BAND;
const MICRO_NAMES = ['Accounts', 'Orders', 'Payments'] as const;
/** Deeper than a plain `BAND`, because the fan's shared trunk is placed a fixed fraction down the
 *  corridor (`edges/bundles.ts`'s `TRUNK_BIAS`) and the corridor here ends at the *services*, one
 *  boundary header further down than the boxes the trunk visually has to clear. */
const MICRO_GATEWAY_BAND = BAND + BOUNDARY_HEADER_CAPTION_ONLY;

const microservices: ArchitectureStarter = {
  id: 'microservices',
  name: 'Microservices',
  description: 'Independent services behind a gateway, each owning its data',
  aliases: [
    'microservices',
    'microservice',
    'distributed services',
    'independent services',
    'api gateway',
  ],
  nodes: [
    {
      key: 'client',
      type: 'actor',
      actorKind: 'human',
      text: 'Client',
      x: centeredAt(MICRO_CX, ACTOR.width),
      y: -(MICRO_GATEWAY_BAND + BAND + SERVICE.height + ACTOR.height),
      ...ACTOR,
    },
    {
      key: 'gateway',
      type: 'service',
      serviceKind: 'gateway',
      text: 'API Gateway',
      accent: 'teal',
      x: centeredAt(MICRO_CX, SERVICE.width),
      y: -(MICRO_GATEWAY_BAND + SERVICE.height),
      ...SERVICE,
    },
    ...MICRO_NAMES.flatMap((name, index): StarterNodeSpec[] => {
      const left = MICRO_COLUMNS[index]!;
      return [
        {
          key: `box-${index}`,
          type: 'group',
          boundaryPreset: 'deployment',
          text: '',
          x: left,
          y: 0,
          ...SERVICE_BOX,
        },
        {
          key: `service-${index}`,
          type: 'service',
          serviceKind: 'generic',
          text: name,
          accent: 'teal',
          parent: `box-${index}`,
          x: left + BOUNDARY_PAD,
          y: MICRO_SERVICE_Y,
          ...SERVICE,
        },
        {
          key: `store-${index}`,
          type: 'database',
          databaseKind: 'sql',
          text: `${name} DB`,
          accent: 'blue',
          parent: `box-${index}`,
          x: centeredAt(left + SERVICE_BOX.width / 2, STORE.width),
          y: MICRO_STORE_Y,
          ...STORE,
        },
      ];
    }),
  ],
  edges: [
    down('client', 'gateway'),
    ...MICRO_NAMES.map((_, index) => down('gateway', `service-${index}`)),
    ...MICRO_NAMES.map((_, index) => down(`service-${index}`, `store-${index}`)),
  ],
};

/* ---------------------------------------------------------- event-driven -- */
/**
 * Asynchronous decoupling, drawn as a fan.
 *
 * The vertical axis is the message's journey — publish, distribute, consume, persist — and the
 * symmetric split under the Topic is the fan-out itself. No boundaries: this starter is about flow,
 * not ownership, and a box around any of it would say something the pattern doesn't.
 *
 * The connectors' directions are the semantics, not decoration: `service → topic` infers
 * `publishes`, `topic → service` infers `deliversTo` (a topic fans out to every subscriber), and
 * both come back from the matrix as `event` behaviour, so the asynchrony is drawn rather than
 * asserted. There is deliberately no dead-letter queue: the model attaches a DLQ to a plain Queue,
 * never to a Topic (`store/editorStore.ts`'s `addDeadLetterQueue`), and bending this composition to
 * fit one would cost its symmetry. "Add DLQ" is a right-click away once a Queue exists.
 */
const EVENT_CX = 224;
const EVENT_CONSUMER_GUTTER = 96;
const EVENT_COLUMNS = columnsAt(EVENT_CX, 2, SERVICE.width, EVENT_CONSUMER_GUTTER);
const EVENT_STORE_Y = SERVICE.height + BAND;

const eventDriven: ArchitectureStarter = {
  id: 'event-driven',
  name: 'Event-Driven',
  description: 'A producer publishing to a topic that fans out to consumers',
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
      text: 'Producer',
      accent: 'teal',
      x: centeredAt(EVENT_CX, SERVICE.width),
      y: -(BAND * 2 + TOPIC.height + SERVICE.height),
      ...SERVICE,
    },
    {
      // A Queue's name is always its kind — there is no text field to type into, by design
      // (`document/factory.ts`'s `defaultTextFor`) — so this one is deliberately unnamed.
      key: 'topic',
      type: 'queue',
      queueKind: 'topic',
      accent: 'violet',
      x: centeredAt(EVENT_CX, TOPIC.width),
      y: -(BAND + TOPIC.height),
      ...TOPIC,
    },
    ...(['A', 'B'] as const).flatMap((suffix, index): StarterNodeSpec[] => {
      const left = EVENT_COLUMNS[index]!;
      return [
        {
          key: `consumer-${index}`,
          type: 'service',
          serviceKind: 'worker',
          text: `Consumer ${suffix}`,
          accent: 'teal',
          x: left,
          y: 0,
          ...SERVICE,
        },
        {
          key: `store-${index}`,
          type: 'database',
          databaseKind: 'sql',
          text: `Store ${suffix}`,
          accent: 'blue',
          x: centeredAt(left + SERVICE.width / 2, STORE.width),
          y: EVENT_STORE_Y,
          ...STORE,
        },
      ];
    }),
  ],
  edges: [
    down('producer', 'topic'),
    // Both leave the topic's midpoint: one topic, many subscribers, drawn as one split.
    down('topic', 'consumer-0'),
    down('topic', 'consumer-1'),
    down('consumer-0', 'store-0'),
    down('consumer-1', 'store-1'),
  ],
};

/* ------------------------------------------------------------- hexagonal -- */
/**
 * Ports and adapters, drawn left to right: outside world → driving adapters → (port) →
 * **application core** → (port) → driven adapters → outside world. Horizontal, not layered, is
 * what lets that whole sentence read before a single label does.
 *
 * The shape is one hub-and-spoke around a single point, `Use Cases`: both driving adapters
 * converge on its left-middle handle, both driven adapters diverge from its right-middle handle.
 * That shared entry/exit point *is* the port, drawn as geometry (two lines narrowing to one, one
 * line widening to two) — the port's name is a supporting detail, not the headline, so it rides as
 * an explicit edge `label` ("Inbound Port"/"Outbound Port"), the plain, honest annotation slot every
 * connector already has. It does **not** ride as `condition`: a Condition means a condition (an
 * `if`/`when` a branch applies), and "Inbound Port" isn't one — reusing it for a port designation
 * would look right and mean something else, exactly the "never reuse a semantic element solely
 * because its rendering is convenient" mistake this starter used to make. A real, lightweight Port/
 * Interface concept is worth building later (see `docs/ARCHITECTURE.md`'s note on it); until then,
 * an edge label is the one existing mechanism that doesn't lie.
 *
 * `Use Cases`, `Domain Model`, `Persistence Adapter`, and `Integration Adapter` are `Component`
 * nodes, not `Service` — none of them is independently deployable, has its own network boundary, or
 * is a peer of `REST API`/`Message Consumer` (which stay `Service`, correctly: they *are* runtime
 * roles). Component's own quieter default rendering (`nodes/describe.ts`'s `component()` — no cap
 * notch, `neutral` accent, a smaller footprint) is what actually earns the "adapters feel secondary,
 * the core feels contained" read this starter has always wanted; a starter that used Service for an
 * internal component purely because Service already existed and looked fine was exactly the
 * "convenient shape, wrong meaning" trap.
 *
 * The boundary is titled `Application Core` alone — `boundaryPreset: 'boundary'` is the one preset
 * with no secondary uppercase tag (`nodes/describe.ts`'s `BOUNDARY_PRESET_LABELS` has no entry for
 * it), so nothing competes with the one title that actually matters here. No `DRIVING ADAPTERS`/
 * `DRIVEN ADAPTERS` zone captions either: two boxes converging into one shared point, on either
 * side of a titled boundary, already says "these are grouped" without more text — a diagram this
 * size adding two more standalone Labels would read as a slide, not a sketch, and a floating Label
 * node here would have to sit inside the same horizontal corridor the funnel lines travel through,
 * risking exactly the invisible-hit-box routing detour a previous revision of this starter hit and
 * fixed (see `tests/starters.test.ts`'s detour regression test).
 *
 * `Domain Model` hangs directly beneath `Use Cases`, inside the same boundary, reached by exactly
 * one internal connector and touching nothing else — smaller, indented, one level down: the
 * deepest layer, orchestrated by Use Cases rather than reachable on its own. That connector's own
 * caption is left to its natural inferred `calls` — Draft Canvas always shows *some* caption for an
 * inferred relationship (there is no "keep the semantic, hide the text" toggle, and inventing one
 * for a single connector isn't a starter-scoped change), and `calls` already renders in the
 * quietest style in the whole app (9.5px, muted, no chip) — about as little as text here can weigh.
 *
 * `Database`/`External System` sit a further gutter beyond their adapters, outside the one
 * boundary — infrastructure, plainly apart from the core that never touches it directly.
 *
 * Port *text* went through two more revisions after the above was written. Naming the crossing
 * itself ("Inbound Port"/"Outbound Port") turned out to fight the diagram in two ways at once:
 * every crossing connector's own relationship word was hidden behind the port name, and the
 * override rode the app's one *explicit*, bordered-chip caption style — the more prominent of the
 * two, the opposite of "annotation" no matter how short the words are. So an earlier pass dropped
 * the port names and let each connector's own relationship speak instead — `REST API`/`Message
 * Consumer` → `Use Cases` carry no override at all, so their natural inferred `calls` shows through
 * the quietest caption style in the app (`FONTS.connectorCaption`, 9.5px, muted, no chip). `Use
 * Cases` → `Domain Model`/`Persistence Adapter`/`Integration Adapter` needed an explicit `label`
 * at the time, reading `uses` — component resolved straight through to `service>service`'s `calls`
 * default for lack of any row of its own, and `calls` is the wrong word for a plain internal
 * dependency. A later pass gave `component>component` its own exact row in
 * `connectorSemantics.ts`'s `MATRIX` (default relation `uses`, checked before the `service` fold),
 * so these three connectors now carry no override either — the same quiet, chip-less caption
 * every other inferred relationship gets, not a bespoke chip that happened to say the right word.
 * The geometry — two lines narrowing to one, one line forking to two — still *is* the port;
 * "Inbound"/"Outbound" as literal text is deferred to whatever the real Port/Interface concept
 * (`docs/ARCHITECTURE.md`) eventually becomes.
 */
const HEX_ROW_GAP = 160;
const HEX_GUTTER = 96;
const HEX_ROW_A_Y = 0;
const HEX_ROW_B_Y = HEX_ROW_A_Y + HEX_ROW_GAP;
const HEX_ROW_A_CENTER = HEX_ROW_A_Y + SERVICE.height / 2;
const HEX_ROW_B_CENTER = HEX_ROW_B_Y + SERVICE.height / 2;
const HEX_CORE_CENTER = (HEX_ROW_A_CENTER + HEX_ROW_B_CENTER) / 2;

// Sized to the same visual-hierarchy rule every Component now follows — noticeably smaller than
// Service's own 176×68, so the core reads as *internal* next to the Service-shaped driving/driven
// adapters either side of it, not a peer of them. Use Cases stays the widest thing inside the
// boundary (it's still the hub every connector converges on); Domain Model stays the smallest —
// the relative hierarchy that already existed is preserved, just at the new, quieter scale.
const HEX_USE_CASES = { width: 172, height: 64 };
const HEX_DOMAIN = { width: 140, height: 50 };
// Matches `DEFAULTS.componentWidth`/`componentHeight` exactly — an Adapter here is sized no
// differently than one created from the toolbar/⌘K, the same consistency Service's own kinds keep.
const HEX_ADAPTER = { width: 152, height: 56 };
const HEX_USE_CASES_Y = HEX_CORE_CENTER - HEX_USE_CASES.height / 2;
const HEX_DOMAIN_GAP = 28;
const HEX_DOMAIN_Y = HEX_USE_CASES_Y + HEX_USE_CASES.height + HEX_DOMAIN_GAP;

const HEX_DRIVING_X = 0;
const HEX_CORE_X = HEX_DRIVING_X + SERVICE.width + HEX_GUTTER;
const HEX_CORE_WIDTH = HEX_USE_CASES.width + BOUNDARY_PAD * 2;
const HEX_CORE_Y = HEX_USE_CASES_Y - BOUNDARY_HEADER_TITLE_ONLY;
const HEX_CORE_HEIGHT = HEX_DOMAIN_Y + HEX_DOMAIN.height + BOUNDARY_PAD - HEX_CORE_Y;

// A tighter core→adapter gutter (the shared column `GUTTER` every other starter uses, rather than
// Hexagonal's own wider one) made the fork read as more deliberate for one pass, but the restored
// "Outbound ports" annotation below needs enough width to sit in that same corridor without
// crowding either the boundary or the adapter — back to the same gutter the driving side already
// uses, symmetric on both sides of the core again.
const HEX_DRIVEN_X = HEX_CORE_X + HEX_CORE_WIDTH + HEX_GUTTER;
const HEX_TECH_X = HEX_DRIVEN_X + HEX_ADAPTER.width + HEX_GUTTER;
// The two "port" annotations — plain, zero-semantics Labels (`type: 'text'`, `annotation: true`),
// never a Condition/Note/Component/Service standing in for architectural terminology one more
// time. One per side, not one per connector: Draft Canvas already had no way to show a repeated
// relationship caption once *without* real Smart Routing bundling (`edges/bundles.ts`'s
// `MIN_SPINE_MEMBERS` gate doesn't fire below three members), so a single annotation naming the
// whole crossing — not a caption on any one connector — is what keeps this to exactly one label
// per side regardless of how many connectors happen to cross there.
//
// Sits in the empty vertical band *between* the two stacked driving (or driven) nodes — the same
// column, centred at `HEX_CORE_CENTER` — rather than squeezed into the horizontal gutter the
// routing itself travels through. That band is guaranteed clear on every axis at once: it's below
// the top node, above the bottom one, and well clear of the funnel/fork lines, which live in the
// gutter to the side, not under the nodes. Height floors at `LIMITS.minNodeSize` (24) like every
// node must — `freeText` anchors its text at the box's own top edge, not centred, so the extra
// room below a single short line costs nothing.
const HEX_PORT_LABEL = { width: 80, height: 24 };
const HEX_PORT_LABEL_Y = HEX_CORE_CENTER - HEX_PORT_LABEL.height / 2;

const hexagonal: ArchitectureStarter = {
  id: 'hexagonal',
  name: 'Hexagonal',
  description: 'A domain core reached only through inbound/outbound ports',
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
      key: 'rest',
      type: 'service',
      serviceKind: 'api',
      text: 'REST API',
      accent: 'teal',
      x: HEX_DRIVING_X,
      y: HEX_ROW_A_Y,
      ...SERVICE,
    },
    {
      key: 'consumer',
      type: 'service',
      serviceKind: 'worker',
      text: 'Message Consumer',
      accent: 'teal',
      x: HEX_DRIVING_X,
      y: HEX_ROW_B_Y,
      ...SERVICE,
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
    },
    {
      key: 'use-cases',
      type: 'component',
      componentKind: 'generic',
      text: 'Use Cases',
      parent: 'core',
      x: centeredAt(HEX_CORE_X + HEX_CORE_WIDTH / 2, HEX_USE_CASES.width),
      y: HEX_USE_CASES_Y,
      ...HEX_USE_CASES,
    },
    {
      key: 'domain',
      type: 'component',
      componentKind: 'generic',
      text: 'Domain Model',
      parent: 'core',
      x: centeredAt(HEX_CORE_X + HEX_CORE_WIDTH / 2, HEX_DOMAIN.width),
      y: HEX_DOMAIN_Y,
      ...HEX_DOMAIN,
    },
    {
      key: 'inbound-ports',
      type: 'text',
      text: 'Inbound ports',
      annotation: true,
      x: centeredAt(HEX_DRIVING_X + SERVICE.width / 2, HEX_PORT_LABEL.width),
      y: HEX_PORT_LABEL_Y,
      ...HEX_PORT_LABEL,
    },
    {
      key: 'outbound-ports',
      type: 'text',
      text: 'Outbound ports',
      annotation: true,
      x: centeredAt(HEX_DRIVEN_X + HEX_ADAPTER.width / 2, HEX_PORT_LABEL.width),
      y: HEX_PORT_LABEL_Y,
      ...HEX_PORT_LABEL,
    },
    {
      key: 'persistence',
      type: 'component',
      componentKind: 'adapter',
      text: 'Persistence Adapter',
      x: HEX_DRIVEN_X,
      y: centeredAt(HEX_ROW_A_CENTER, HEX_ADAPTER.height),
      ...HEX_ADAPTER,
    },
    {
      key: 'integration',
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
      databaseKind: 'sql',
      text: 'Database',
      accent: 'blue',
      x: HEX_TECH_X,
      y: centeredAt(HEX_ROW_A_CENTER, STORE.height),
      ...STORE,
    },
    {
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      accent: 'teal',
      x: HEX_TECH_X,
      y: HEX_ROW_B_Y,
      ...SERVICE,
    },
  ],
  edges: [
    { from: 'rest', to: 'use-cases', sourceAnchor: RIGHT, targetAnchor: LEFT },
    { from: 'consumer', to: 'use-cases', sourceAnchor: RIGHT, targetAnchor: LEFT },
    down('use-cases', 'domain'),
    { from: 'use-cases', to: 'persistence', sourceAnchor: RIGHT, targetAnchor: LEFT },
    { from: 'use-cases', to: 'integration', sourceAnchor: RIGHT, targetAnchor: LEFT },
    { from: 'persistence', to: 'database', sourceAnchor: RIGHT, targetAnchor: LEFT },
    { from: 'integration', to: 'external', sourceAnchor: RIGHT, targetAnchor: LEFT },
  ],
};

export const ARCHITECTURE_STARTERS: readonly ArchitectureStarter[] = [
  monolith,
  modularMonolith,
  microservices,
  eventDriven,
  hexagonal,
];
