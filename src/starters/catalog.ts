/**
 * The Starters, composed by hand: seven architectures and two patterns (see `StarterCategory`).
 *
 * Every coordinate here is deliberate. These are canonical diagrams whose structure is known in
 * advance, so the composition is authored rather than solved: hierarchy reads top to bottom (or,
 * for a pipeline, left to right), columns share a gutter, related things align on the same axis,
 * and each starter carries only enough elements to establish its idea — a pattern starter is drawn
 * at the scope of the problem it solves, never grown to look like an architecture. The empty space
 * is part of the design — a starter is the first thirty seconds of a diagram, not a reference
 * architecture, and a real system composes several of them.
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
import { queueTubeSpan } from '../document/queueGeometry';
import type { ArchitectureStarter, StarterEdgeSpec, StarterNodeSpec } from './types';

/* ------------------------------------------------------------------ sizes -- */
/** Mirrors of `document/limits.ts`'s `DEFAULTS`, named for what they are here. Authoring against
 *  literals keeps every coordinate below arithmetically checkable by eye. */
const SERVICE = { width: 176, height: 68 };
const STORE = { width: 148, height: 88 };
/** The queue-family box — Queue, Topic and DLQ all share it. */
const QUEUE = { width: 140, height: 48 };
/** The same box for a queue-family node that carries a name (`DEFAULTS.queueNamedHeight`): the
 *  name and kind caption stack under the tube and need the extra height to stay inside the box. */
const NAMED_QUEUE = { width: QUEUE.width, height: 72 };
/** A `table` Data Store: a flat card, deliberately shorter than a cylinder — a table is a part of
 *  a store, and reads as one. */
const TABLE = { width: STORE.width, height: 64 };
const ACTOR = { width: 120, height: 92 };
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

/** A plain top-to-bottom connection: the default reading direction of every starter. */
function down(from: string, to: string): StarterEdgeSpec {
  return { from, to, sourceAnchor: BOTTOM, targetAnchor: TOP };
}

/** A level, centre-to-centre connection — the reading direction of Hexagonal, and the one line in
 *  each monolith that leaves the application sideways. */
function across(from: string, to: string): StarterEdgeSpec {
  return { from, to, sourceAnchor: RIGHT, targetAnchor: LEFT };
}

/* --------------------------------------------------------------- monolith -- */
/**
 * One deployable application, drawn as one box — and, inside it, the classic *layers*: an inbound
 * API, the business logic, and the data access that reaches the store. That horizontal layering is
 * the whole contrast with the Modular Monolith next to it in the palette (one deployable organised
 * in vertical *modules*), so it's the one thing this starter spends its elements on.
 *
 * Every layer is a `Component`, never a `Service`: nothing inside one deployable is independently
 * deployable, and the same rule already holds inside Hexagonal's core and Modular Monolith's
 * boundary. `API` and `Data Access` are `adapter` Components — the two places the application
 * translates to and from the outside world (the same notched silhouette Hexagonal's adapters wear);
 * `Business Logic` is a plain Component between them. All three sit at Component's own default
 * footprint, as peers: a layered monolith has no hero layer, its hero is the boundary that holds
 * them. `Data Access` earns its place by making "the database is outside the application" literally
 * true — without it, business logic writes straight to the store and the layering isn't there to
 * read. The external call leaves from `Business Logic` (`calls`, level, crossing the boundary
 * edge on the right): the honest place most monoliths call out from, and drawn as the one line
 * that leaves sideways so it reads as "this one goes outside" before its caption is read.
 *
 * `Database` is a generic Data Store outside the boundary, directly beneath it — a separate runtime
 * resource, not part of the deployed artifact; which engine it is stays the team's decision. The
 * two notes carry the production facts a diagram this size can't afford to show as elements: what
 * "one artifact" means operationally, and that the schema ships with the release.
 */
/** Every layer at Component's own default footprint (`DEFAULTS.componentWidth`/`componentHeight`)
 *  — see this block's doc comment for why no layer is grown into a hero. */
const LAYER = { width: 152, height: 56 };
const MONOLITH_BOUNDARY_WIDTH = LAYER.width + BOUNDARY_PAD * 2;
const MONOLITH_CX = MONOLITH_BOUNDARY_WIDTH / 2;
const MONOLITH_API_Y = BOUNDARY_HEADER;
const MONOLITH_LOGIC_Y = MONOLITH_API_Y + LAYER.height + INNER_BAND;
const MONOLITH_DATA_Y = MONOLITH_LOGIC_Y + LAYER.height + INNER_BAND;
const MONOLITH_BOUNDARY_HEIGHT = MONOLITH_DATA_Y + LAYER.height + BOUNDARY_PAD;
const MONOLITH_EXTERNAL_X = MONOLITH_BOUNDARY_WIDTH + GUTTER;

const monolith: ArchitectureStarter = {
  id: 'monolith',
  category: 'architecture',
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
      attachments: [
        { type: 'note', text: 'Built, tested, versioned and deployed as one artifact. Scale by running more copies.' },
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
      text: 'Business Logic',
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
      text: 'Database',
      accent: 'blue',
      x: centeredAt(MONOLITH_CX, STORE.width),
      y: MONOLITH_BOUNDARY_HEIGHT + BAND,
      ...STORE,
      attachments: [{ type: 'note', text: 'One schema, migrated with each release.' }],
    },
    {
      // Outside the boundary, level with the layer that calls it, so the arrow crossing the
      // boundary edge is a clean horizontal — "this one leaves the application."
      key: 'external',
      type: 'service',
      serviceKind: 'external',
      accent: 'teal',
      x: MONOLITH_EXTERNAL_X,
      y: centeredAt(MONOLITH_LOGIC_Y + LAYER.height / 2, SERVICE.height),
      ...SERVICE,
    },
  ],
  edges: [
    down('client', 'api'),
    down('api', 'logic'),
    down('logic', 'data'),
    down('data', 'database'),
    across('logic', 'external'),
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
 *
 * What a later pass added is depth without elements: the store is a generic Data Store (which
 * engine is the team's decision, not the starter's), and two click-to-reveal notes carry the
 * production facts that make a modular monolith work in practice — the boundary's ("one artifact,
 * one deploy; module lines are enforced at build time, not by the network") and the database's
 * ("one database, three schemas; no query crosses a module line").
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
  category: 'architecture',
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
      attachments: [
        { type: 'note', text: 'One artifact, one deploy. Module boundaries are enforced by build rules, not by the network.' },
      ],
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
      databaseKind: 'generic',
      text: 'Application Database',
      accent: 'blue',
      x: centeredAt(MODULAR_CX, DATABASE_BOX.width),
      y: MODULAR_DATABASE_Y,
      ...DATABASE_BOX,
      attachments: [
        {
          type: 'note',
          text: 'One database, three schemas: each module owns its tables, and no query crosses a module line.',
        },
      ],
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
 * The smallest microservices system worth starting from, in four lessons a reader meets top to
 * bottom:
 *
 * 1. **One public entry point.** A Client calls the API Gateway and nothing else; the gateway
 *    `routes` to every service through one fan (Smart Routing draws it as one trunk with one
 *    collapsed caption), and each branch carries the route rule that selects it — `/accounts/*`,
 *    `/orders/*`, `/payments/*` — as a `condition`, the one Draft Canvas element whose meaning
 *    ("when this branch applies") is exactly what a route rule is. Every other starter has been
 *    careful *not* to put architecture words into `condition`; this is the case it exists for.
 * 2. **Independent deployables.** Each service sits inside its own `DEPLOYMENT` boundary. The
 *    boundaries carry no title of their own — the service inside already names the thing, and
 *    the `DEPLOYMENT` caption is the entire point they're making.
 * 3. **Database per service.** Every service `writes` its own store, and no store has a second
 *    writer. The stores are generic Data Stores, not SQL: which engine each team picks is
 *    exactly the kind of decision this pattern leaves to each service, and a starter shouldn't
 *    make it for them. The services are `api` Services — what a gateway routes to is an HTTP API,
 *    and the tag completes the sentence the `routes` caption starts.
 * 4. **Integrate through events, never through each other's tables.** `Orders` publishes to an
 *    `Order Events` Topic and `Payments` is delivered the event; no service calls another
 *    service, and no service reads another's store. One event path, not several: Payments
 *    reacting to an order is the canonical cross-service reaction, and the consumer-side detail
 *    (per-consumer queues, retries, a DLQ) is the Event-Driven starter's lesson, one right-click
 *    away here. An earlier revision left the services silent to keep the layout symmetric; a
 *    microservices baseline that never shows *how* services integrate leaves the single most
 *    common way these systems go wrong neither shown nor contradicted.
 *
 * **Layout.** The Topic hangs below the gutter between the two services that talk, and both of
 * its connectors run straight down that gutter — `Orders` leaves from its right-middle handle,
 * the Topic feeds `Payments`' left-middle handle — so nothing crosses a neighbour's boundary and
 * nothing threads past a store. The gutter is wider than the shared `GUTTER` for exactly that
 * reason: two verticals with their own quiet captions need the room. Captions stay inferred and
 * quiet (`publishes`, `delivers to`); the event's name lives in the publish connector's note.
 *
 * Three click-to-reveal notes carry the production detail a meeting-speed diagram can't: what the
 * gateway owns, why a store is private, and when an event may be emitted.
 */
const SERVICE_BOX = {
  width: SERVICE.width + BOUNDARY_PAD * 2,
  height: BOUNDARY_HEADER_CAPTION_ONLY + SERVICE.height + INNER_BAND + STORE.height + BOUNDARY_PAD,
};
/** Wider than the shared `GUTTER`: the Orders/Payments gutter carries two vertical connectors and
 *  their captions side by side, each clear of the boundary borders either side of it. */
const MICRO_GUTTER = 200;
const MICRO_CX = Math.round((SERVICE_BOX.width * 3 + MICRO_GUTTER * 2) / 2);
const MICRO_COLUMNS = columnsAt(MICRO_CX, 3, SERVICE_BOX.width, MICRO_GUTTER);
const MICRO_SERVICE_Y = BOUNDARY_HEADER_CAPTION_ONLY;
const MICRO_STORE_Y = MICRO_SERVICE_Y + SERVICE.height + INNER_BAND;
const MICRO_NAMES = ['Accounts', 'Orders', 'Payments'] as const;
const MICRO_ROUTES = ['/accounts/*', '/orders/*', '/payments/*'] as const;
/** Deeper than a plain `BAND`, because the fan's shared trunk is placed a fixed fraction down the
 *  corridor (`edges/bundles.ts`'s `TRUNK_BIAS`) and the corridor here ends at the *services*, one
 *  boundary header further down than the boxes the trunk visually has to clear. */
const MICRO_GATEWAY_BAND = BAND + BOUNDARY_HEADER_CAPTION_ONLY;
/** The event topic sits a full `BAND` below the deployments, centred under the Orders/Payments
 *  gutter. Its two connectors land on its top edge at different offsets so their verticals run
 *  side by side in the gutter with room for each one's caption between them. */
const MICRO_EVENTS_Y = SERVICE_BOX.height + BAND;
const MICRO_EVENTS_GUTTER_CENTER = MICRO_COLUMNS[2]! - MICRO_GUTTER / 2;
const MICRO_PUBLISH_IN: StarterEdgeSpec['targetAnchor'] = { side: 'top', offset: 0.15 };
const MICRO_DELIVER_OUT: StarterEdgeSpec['sourceAnchor'] = { side: 'top', offset: 0.65 };

const microservices: ArchitectureStarter = {
  id: 'microservices',
  category: 'architecture',
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
      attachments: [{ type: 'note', text: 'Routing, auth, rate limits, TLS. The only public entry point.' }],
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
          serviceKind: 'api',
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
          databaseKind: 'generic',
          text: `${name} DB`,
          accent: 'blue',
          parent: `box-${index}`,
          x: centeredAt(left + SERVICE_BOX.width / 2, STORE.width),
          y: MICRO_STORE_Y,
          ...STORE,
          ...(name === 'Orders'
            ? { attachments: [{ type: 'note' as const, text: 'Private to Orders. Other services never read it directly.' }] }
            : {}),
        },
      ];
    }),
    {
      key: 'events',
      type: 'queue',
      queueKind: 'topic',
      text: 'Order Events',
      x: centeredAt(MICRO_EVENTS_GUTTER_CENTER, NAMED_QUEUE.width),
      y: MICRO_EVENTS_Y,
      ...NAMED_QUEUE,
    },
  ],
  edges: [
    down('client', 'gateway'),
    ...MICRO_NAMES.map((_, index) => ({ ...down('gateway', `service-${index}`), condition: MICRO_ROUTES[index]! })),
    ...MICRO_NAMES.map((_, index) => down(`service-${index}`, `store-${index}`)),
    {
      from: 'service-1',
      to: 'events',
      sourceAnchor: RIGHT,
      targetAnchor: MICRO_PUBLISH_IN,
      attachments: [{ type: 'note', text: 'OrderPlaced — emitted after the Orders DB commit, never before.' }],
    },
    { from: 'events', to: 'service-2', sourceAnchor: MICRO_DELIVER_OUT, targetAnchor: LEFT },
  ],
};

/* ---------------------------------------------------------- event-driven -- */
/**
 * The smallest event-driven architecture worth starting from: a producer publishes a fact, a Topic
 * fans it out, and every consumer gets its *own* delivery path — so one slow or failing consumer
 * never holds up another. Read top to bottom: producer → event → topic → fan-out → queue → worker →
 * side effect. Every element below earns its place by teaching one of those steps; anything that
 * didn't (a second topic, a saga, an outbox, consumer groups, a schema registry, an event store, a
 * boundary around "the consumers") is a separate, more opinionated starter this one deliberately
 * isn't.
 *
 * **What each element is, and why it's that and not something else.**
 * - `Producer Service` is a plain generic Service: nothing in the pattern says it's an API or a
 *   scheduler, and it knows nothing about who reacts — its only connector goes to the Topic, so a
 *   fourth reaction later is purely a Topic-side change.
 * - `Domain Events` is a Topic (the one queue-family node a starter names — the broker is the
 *   architecture's centre, and "Domain Events" is what makes it reusable rather than an
 *   order-system diagram). `Producer → Domain Events` infers `publishes`/`event`, and the one
 *   explicit caption in this starter, `publishes OrderCreated`, names a concrete event on the
 *   connector that carries it — a fact that already happened, never a command (`CreateOrder`)
 *   dressed up as one. The event is a message, not a component, so it's a caption, not a node.
 * - Three plain, unnamed Queues sit between the Topic and its consumers. This is the pattern's
 *   real lesson and the reason the consumers don't hang off the Topic directly: `Topic → Queue`
 *   infers `fansOut` (one published event, three independently consumable copies) and
 *   `Queue → Service` infers `consumes`, and because each queue is owned by exactly one consumer
 *   nothing competes for a message, nothing shares a backlog, and each lane can retry on its own
 *   terms. A Queue is deliberately what they are, not a new "Subscription" kind: SNS→SQS, an
 *   exchange-bound RabbitMQ queue, a Service Bus subscription and a Kafka consumer group are all
 *   this same architectural shape, and Draft Canvas models the shape, not a vendor's name for it.
 *   Each queue sits directly above its worker, centred on the same axis, and shows only its kind
 *   caption — ownership reads from alignment, so a name would be noise.
 * - The three consumers are `worker` Services (`WORKER` caption): a queue-fed background process
 *   is exactly what a Worker already is, so no "event consumer" kind is needed — it would share
 *   every relationship rule Worker has and change nothing but a caption. Their *names* carry the
 *   three genuinely common reasons a system reacts to an event: `Projection Service` builds a read
 *   model (the only one that owns a store — `Read Store`, a technology-neutral generic Data Store,
 *   reached by `writes`); `Processing Service` runs internal business logic and deliberately owns
 *   nothing below it (persistence under every column would read as a rule of "being a consumer"
 *   rather than the per-role decision it is); `Integration Service` hands off to something the
 *   system doesn't control — `External System`, an `external` Service, reached by a solid
 *   synchronous `calls` line. That one solid line among dotted event lines is on purpose: it's
 *   the point where the asynchronous architecture touches a synchronous dependency, and it's
 *   exactly why this lane, and only this lane, gets failure handling.
 * - Failure handling is one DLQ, beside the Integration queue and only there. `Queue → DLQ` infers
 *   `deadLetters`/`failure` (dashed) from the same matrix row the "Add DLQ" command reads, and the
 *   authored `deliveryAttempts: 3` renders as "after 3 attempts": retries belong to the consumer's
 *   own delivery path, a poison message is parked rather than blocking the lane, and the shared
 *   Topic is never where a consumer's failures are dumped (`topic>deadLetter` is an `unusual`
 *   pairing for exactly that reason). One DLQ, not one per queue — the diagram shows the practice
 *   once, and the other two queues are a right-click away from the same treatment.
 *
 * **Routing and hierarchy.** The three `Topic → Queue` connectors are left unoverridden so Smart
 * Routing bundles them into one stem, one trunk, and one collapsed `fans out` caption
 * (`edges/bundles.ts`): unlike an earlier revision's Topic → *Service* rays, these connectors *are*
 * delivery infrastructure, and one shared trunk is the honest picture of "one event, delivered
 * three ways." A full `BAND` above the queue row is that trunk's corridor and a full `BAND` above
 * the Topic holds the publish caption; the queue → worker and worker → side-effect gaps are the
 * tighter `INNER_BAND`, so a queue reads as *belonging to* its worker while the layers of the
 * architecture stay clearly separated. Services stay the visual heroes: queues are smaller,
 * captioned only by kind, and the DLQ is smaller and dashed again — secondary to its queue, never
 * mistakable for a fourth consumer.
 *
 * **Depth without noise.** Two click-to-reveal attachments carry the production detail a
 * meeting-speed diagram would otherwise have to leave out: the publish connector holds an example
 * `OrderCreated` payload in the CloudEvents core shape (an id to dedupe on, a type, a time — what
 * makes an event a fact consumers can process idempotently), and the dead-letter route holds the one operational note
 * that matters about a DLQ. Neither adds a visible node; each is a small chip until clicked.
 */
const EVENT_CX = 312;
// Tighter than the shared `GUTTER` other starters' rows use — the three lanes should read as one
// contained architecture around one Topic, not three services spread to fill the canvas.
const EVENT_LANE_GUTTER = 48;
const EVENT_LANES = columnsAt(EVENT_CX, 3, SERVICE.width, EVENT_LANE_GUTTER);
const EVENT_PRODUCER_Y = 0;
const EVENT_TOPIC_Y = EVENT_PRODUCER_Y + SERVICE.height + BAND;
// A full `BAND`, not `INNER_BAND`: the fan-out's shared trunk needs the corridor (see the doc
// comment above, and `BAND`'s own).
const EVENT_QUEUE_Y = EVENT_TOPIC_Y + NAMED_QUEUE.height + BAND;
const EVENT_WORKER_Y = EVENT_QUEUE_Y + QUEUE.height + INNER_BAND;
const EVENT_SIDE_EFFECT_Y = EVENT_WORKER_Y + SERVICE.height + INNER_BAND;
/** Room for the dead-letter route's own "after 3 attempts" caption to sit between its two tubes
 *  with clear air either side — the same width `editorStore.ts`'s `gapForCaption` would leave when
 *  "Add DLQ" places one interactively. */
const EVENT_DLQ_GAP = BAND;
/** The dead-letter route runs tube-to-tube: the sides are pinned so the route is a level line, and
 *  routing itself lands a left/right anchor on the tube glyph (`anchorBandOf`) — the same thing
 *  `addDeadLetterQueue` relies on when it places one interactively. */
const EVENT_TUBE_OUT: StarterEdgeSpec['sourceAnchor'] = RIGHT;
const EVENT_TUBE_IN: StarterEdgeSpec['targetAnchor'] = LEFT;

/** The centre axis of one consumer lane — its queue, its worker and its side effect all share it. */
function eventLaneCenter(lane: number): number {
  return EVENT_LANES[lane]! + SERVICE.width / 2;
}

const EVENT_LANE_KEYS = ['projection', 'processing', 'integration'] as const;
const EVENT_LANE_NAMES = ['Projection Service', 'Processing Service', 'Integration Service'] as const;

const eventDriven: ArchitectureStarter = {
  id: 'event-driven',
  category: 'architecture',
  name: 'Event-Driven',
  description: 'A producer, a topic, and consumers that own their delivery',
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
    },
    ...EVENT_LANE_KEYS.flatMap((lane, index): StarterNodeSpec[] => [
      {
        key: `${lane}-queue`,
        type: 'queue',
        queueKind: 'queue',
        x: centeredAt(eventLaneCenter(index), QUEUE.width),
        y: EVENT_QUEUE_Y,
        ...QUEUE,
      },
      {
        key: `${lane}-service`,
        type: 'service',
        serviceKind: 'worker',
        text: EVENT_LANE_NAMES[index],
        accent: 'teal',
        x: EVENT_LANES[index]!,
        y: EVENT_WORKER_Y,
        ...SERVICE,
      },
    ]),
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
      x: EVENT_LANES[2]!,
      y: EVENT_SIDE_EFFECT_Y,
      ...SERVICE,
    },
    {
      key: 'integration-dlq',
      type: 'queue',
      queueKind: 'queue',
      deliveryRole: 'dead-letter',
      x: centeredAt(eventLaneCenter(2), QUEUE.width) + QUEUE.width + EVENT_DLQ_GAP,
      y: EVENT_QUEUE_Y,
      ...QUEUE,
    },
  ],
  edges: [
    {
      ...down('producer', 'topic'),
      label: 'publishes OrderCreated',
      attachments: [
        {
          type: 'code',
          text: 'OrderCreated',
          language: 'json',
          // The CloudEvents core envelope (id/type/time/data): a vendor-neutral shape, and every
          // line short enough to read in the attachment card without scrolling.
          code: [
            '{',
            '  "id": "evt_8f3a1c2d",',
            '  "type": "OrderCreated",',
            '  "time": "2026-09-10T08:15Z",',
            '  "data": {',
            '    "orderId": "ord_4821"',
            '  }',
            '}',
          ].join('\n'),
        },
      ],
    },
    // All three leave the same point on the Topic's bottom edge so Smart Routing bundles them into
    // one trunk with one collapsed `fans out` caption — see this block's doc comment.
    ...EVENT_LANE_KEYS.map((lane) => down('topic', `${lane}-queue`)),
    ...EVENT_LANE_KEYS.map((lane) => down(`${lane}-queue`, `${lane}-service`)),
    down('projection-service', 'read-store'),
    down('integration-service', 'external'),
    {
      from: 'integration-queue',
      to: 'integration-dlq',
      sourceAnchor: EVENT_TUBE_OUT,
      targetAnchor: EVENT_TUBE_IN,
      deliveryAttempts: 3,
      attachments: [
        {
          type: 'note',
          noteKind: 'note',
          text: 'Poison messages park here for inspection and redrive. Alert on depth.',
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------- hexagonal -- */
/**
 * Ports and adapters, drawn left to right: driving adapters → **port** → application core →
 * **ports** → driven adapters → infrastructure. Horizontal, not layered, is what lets that whole
 * sentence read before a single label does — and the ports are now real elements, not two floating
 * words in the gaps between boxes.
 *
 * **Runtime flow and source dependency are different arrows, and this diagram draws only one.**
 * Every connector points the way a request travels: `REST API` calls the `Inbound` port, which
 * is implemented by `Use Cases`, which uses the `Persistence` port, which is implemented by
 * `Persistence Adapter`, which writes to `Database`. Dependency inversion — the thing Hexagonal
 * exists for — isn't carried by reversing arrows (a picture nobody can trace); it's carried by
 * *where the ports live* and *what the words say*. All three ports sit inside `Application Core`:
 * the core owns its contracts. And the connector leaving a port reads `implemented by`, not
 * `calls`: the adapter after it depends on the port's owner, never the other way round. The one
 * annotation in the starter, the core's own subtitle, says the rest in three words.
 *
 * **What each element is.**
 * - `REST API` (`api`) and `Message Consumer` (`worker`) stay `Service` — they're runtime roles,
 *   and two different kinds are what say "different things can drive the same application."
 * - `Inbound`, `Persistence`, `Integration` are `component`/`port` — dashed, small, and captioned
 *   `PORT` so the caption completes each name ("Inbound port"). One inbound port, not two: both
 *   driving adapters call the same use cases, and a shared contract is the honest picture of that.
 *   Two outbound ports, because persistence and integration are genuinely different needs.
 * - `Use Cases` and `Domain Model` are plain Components inside the core — `Domain Model` hangs
 *   beneath `Use Cases`, reached by exactly one connector and touching nothing else: the deepest,
 *   most infrastructure-independent piece, orchestrated by the use cases above it.
 * - `Persistence Adapter` / `Integration Adapter` are `adapter` Components outside the core: the
 *   translation layer, notched on both sides because an adapter faces two worlds.
 * - `Database` is a generic Data Store (technology-neutral — SQL would be a decision this starter
 *   doesn't make) and `External System` an `external` Service; both a full gutter beyond their
 *   adapters, plainly infrastructure the core never touches.
 *
 * **Routing and hierarchy.** The two driving connectors share the inbound port's left-middle point,
 * so Smart Routing draws one funnel with one collapsed `calls`; `Use Cases` forks to both outbound
 * ports from its right-middle point, one trunk, one collapsed `uses`. Everything else is a level,
 * straight line between two centred handles. The core is the only boundary and the tallest thing
 * on the canvas — it spans both rows, with its ports on the rows and its use cases centred between
 * them — so it reads as the middle everything else adapts to, before any label is read.
 */
const HEX_ROW_GAP = 160;
const HEX_ROW_A_Y = 0;
const HEX_ROW_B_Y = HEX_ROW_A_Y + HEX_ROW_GAP;
const HEX_ROW_A_CENTER = HEX_ROW_A_Y + SERVICE.height / 2;
const HEX_ROW_B_CENTER = HEX_ROW_B_Y + SERVICE.height / 2;
const HEX_CORE_CENTER = (HEX_ROW_A_CENTER + HEX_ROW_B_CENTER) / 2;

// Sized to the same visual-hierarchy rule every Component follows — noticeably smaller than
// Service's 176×68, so the core reads as *internal* next to the Service-shaped driving side. Use
// Cases stays the widest thing inside the boundary (the hub every connector meets); Domain Model
// the smallest of the working pieces; a Port smaller still — a contract, not a thing doing work.
const HEX_USE_CASES = { width: 172, height: 64 };
const HEX_DOMAIN = { width: 140, height: 50 };
/** Component's default height, but wider than its default 152: "Persistence Adapter" has to stay
 *  on one line above the ADAPTER tag row at real browser font metrics, and 172 is as wide as a
 *  Component may be while every Service in this starter still out-sizes it. */
const HEX_ADAPTER = { width: 172, height: 56 };
/** Wide enough for a one-word port name at `nodeLabel` with the family's own padding, tall enough
 *  for the name and the centred `PORT` tag beneath it (`nodes/describe.ts`'s `componentPort`). */
const HEX_PORT = { width: 120, height: 44 };
/** The gap on either side of Use Cases inside the core: room for an `implemented by` caption on
 *  the left, and for the outbound fork's shared trunk on the right (`edges/bundles.ts` needs
 *  `MIN_STEM` + `MIN_BRANCH` = 56 at the very least). */
const HEX_INNER_GAP = 88;

const HEX_USE_CASES_Y = HEX_CORE_CENTER - HEX_USE_CASES.height / 2;
const HEX_DOMAIN_GAP = 28;
const HEX_DOMAIN_Y = HEX_USE_CASES_Y + HEX_USE_CASES.height + HEX_DOMAIN_GAP;

const HEX_DRIVING_X = 0;
const HEX_CORE_X = HEX_DRIVING_X + SERVICE.width + GUTTER;
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
/** The boundary's one subtitle — the same second-header-line technique Modular Monolith uses:
 *  `BOUNDARY_TITLE_INSET` for the title's own left edge, `BOUNDARY_TITLE_SUBLINE_Y` for the line
 *  right under it, and the same width that starter's subtitle uses (see its own comment on why the
 *  test environment's measurer under-reads real font metrics). */
const HEX_SUBTITLE = { width: 176, height: 24 };

const HEX_DRIVEN_X = HEX_CORE_X + HEX_CORE_WIDTH + GUTTER;
const HEX_TECH_X = HEX_DRIVEN_X + HEX_ADAPTER.width + GUTTER;

const hexagonal: ArchitectureStarter = {
  id: 'hexagonal',
  category: 'architecture',
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
      // The one annotation: the second line of the core's own header, not a floating label.
      key: 'core-subtitle',
      type: 'text',
      text: 'Dependencies point inward',
      annotation: true,
      parent: 'core',
      x: HEX_CORE_X + BOUNDARY_TITLE_INSET,
      y: HEX_CORE_Y + BOUNDARY_TITLE_SUBLINE_Y,
      ...HEX_SUBTITLE,
    },
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
      databaseKind: 'generic',
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
    // Both driving adapters meet the inbound port at one point — one funnel, one `calls`.
    across('rest', 'inbound-port'),
    across('consumer', 'inbound-port'),
    across('inbound-port', 'use-cases'),
    down('use-cases', 'domain'),
    // One fork from Use Cases to both outbound ports — one trunk, one `uses`.
    across('use-cases', 'persistence-port'),
    across('use-cases', 'integration-port'),
    across('persistence-port', 'persistence'),
    across('integration-port', 'integration'),
    across('persistence', 'database'),
    across('integration', 'external'),
  ],
};

/* ------------------------------------------------------ backend for frontend -- */
/**
 * Two client experiences, each with its own backend adapter, sharing one set of domain services —
 * drawn with the shared services *in the middle* and an experience on either side, so the sentence
 * "different clients get tailored backends; the domain stays shared and independent" reads before
 * a single label does, and no connector ever crosses another.
 *
 * **What each element is.**
 * - `Web Client` / `Mobile Client` are `device` Actors: the pattern is about *client experiences*,
 *   and a browser and a phone are the two that most often diverge in what they need.
 * - `Web BFF` / `Mobile BFF` are plain `api` Services — Backend for Frontend is an architectural
 *   role, not its own shape kind, so the label and the diagram itself carry the distinction from
 *   an API Gateway rather than a dedicated silhouette. A gateway is one shared front door (routing,
 *   auth, rate limits — see Microservices) and its connectors say `routes`; a BFF is *one client's*
 *   adapter that shapes and aggregates calls for that experience alone, and its connectors say
 *   `calls`. There is deliberately **no gateway** here: drawing both would blur exactly the
 *   distinction this starter exists to make, and the Web BFF's note says so in one line.
 * - Each client and its BFF share a boundary titled for the *experience* and subtitled with who
 *   owns it: the BFF belongs to the team that owns that client, which is the whole reason it may be
 *   tailored. Two boundaries, not one, is what says "not a shared layer." Nothing here says every
 *   client *must* have one — the diagram shows the shape once per experience that wants it.
 * - `Customer`, `Orders`, `Recommendations` are `api` Services inside a `Domain services`
 *   boundary — shared capabilities with their own owners, and the boundary's subtitle says so. A
 *   BFF composes them; it never owns them, and it is never where business rules live (the
 *   boundary's note carries that rule).
 *
 * **Routing.** The Web BFF's three connectors leave its right-middle point, so Smart Routing draws
 * one trunk with one collapsed `calls`; the Mobile BFF's two leave its left-middle point for one
 * funnel of its own. The two fans meet the services from opposite sides, so the asymmetry — only
 * the web experience uses Recommendations — is visible as a shorter fan, not as a crossing line.
 * The adapter row sits level with the middle service so each stem meets its trunk at the trunk's
 * own centre. Everything is a synchronous request: a BFF is a request-time adapter, and this is
 * the one starter where nothing is dashed on purpose.
 */
const BFF_BOX_WIDTH = SERVICE.width + BOUNDARY_PAD * 2;
/** A boundary subtitle spans the box's inner width, sharing the title's own left inset. */
const BFF_SUBTITLE = { width: BFF_BOX_WIDTH - BOUNDARY_TITLE_INSET * 2, height: 24 };
/** First content row clears the boundary's subtitle — the same arithmetic as `MODULAR_API_Y`. */
const BFF_TOP = BOUNDARY_TITLE_SUBLINE_Y + BFF_SUBTITLE.height + 8;
const BFF_CLIENT_Y = BFF_TOP;
/** Tighter than `INNER_BAND`: the `calls` caption between a client and its adapter sits inside a
 *  boundary that already separates them from everything else. */
const BFF_CLIENT_GAP = 64;
const BFF_ADAPTER_Y = BFF_CLIENT_Y + ACTOR.height + BFF_CLIENT_GAP;
const BFF_BOX_HEIGHT = BFF_ADAPTER_Y + SERVICE.height + BOUNDARY_PAD;
/** Wider than `INNER_BAND`: each service row also hosts a fan branch and its tap-off. */
const BFF_SERVICE_GAP = 88;
const BFF_SERVICE_Y = (index: number) => BFF_TOP + index * (SERVICE.height + BFF_SERVICE_GAP);
const BFF_DOMAIN_HEIGHT = BFF_SERVICE_Y(2) + SERVICE.height + BOUNDARY_PAD;
/** A full `BAND` either side of the domain: room for a fan's trunk corridor and its caption. */
const BFF_GUTTER = BAND;
const BFF_WEB_X = 0;
const BFF_DOMAIN_X = BFF_WEB_X + BFF_BOX_WIDTH + BFF_GUTTER;
const BFF_MOBILE_X = BFF_DOMAIN_X + BFF_BOX_WIDTH + BFF_GUTTER;
const BFF_SERVICES = ['customer', 'orders', 'recommendations'] as const;
const BFF_SERVICE_NAMES = ['Customer Service', 'Orders Service', 'Recommendations Service'] as const;

/** A title-only boundary's second header line — the same shape CQRS and the Outbox use. */
function boundarySubtitle(
  key: string,
  parent: string,
  left: number,
  text: string,
  size: { width: number; height: number },
): StarterNodeSpec {
  return {
    key,
    type: 'text',
    text,
    annotation: true,
    parent,
    x: left + BOUNDARY_TITLE_INSET,
    y: BOUNDARY_TITLE_SUBLINE_Y,
    ...size,
  };
}

function bffExperience(
  key: 'web' | 'mobile',
  left: number,
  title: string,
  owner: string,
  client: string,
  adapter: string,
  note: string,
): StarterNodeSpec[] {
  const cx = left + BFF_BOX_WIDTH / 2;
  return [
    {
      key: `${key}-box`,
      type: 'group',
      boundaryPreset: 'boundary',
      text: title,
      x: left,
      y: 0,
      width: BFF_BOX_WIDTH,
      height: BFF_BOX_HEIGHT,
    },
    boundarySubtitle(`${key}-subtitle`, `${key}-box`, left, owner, BFF_SUBTITLE),
    {
      key: `${key}-client`,
      type: 'actor',
      actorKind: 'device',
      text: client,
      parent: `${key}-box`,
      x: centeredAt(cx, ACTOR.width),
      y: BFF_CLIENT_Y,
      ...ACTOR,
    },
    {
      key: `${key}-bff`,
      type: 'service',
      serviceKind: 'api',
      text: adapter,
      accent: 'teal',
      parent: `${key}-box`,
      x: left + BOUNDARY_PAD,
      y: BFF_ADAPTER_Y,
      ...SERVICE,
      attachments: [{ type: 'note', text: note }],
    },
  ];
}

const backendForFrontend: ArchitectureStarter = {
  id: 'bff',
  category: 'architecture',
  name: 'Backend for Frontend',
  description: 'Backend adapters tailored to each client experience',
  aliases: ['bff', 'backend for frontend', 'backends for frontends', 'client adapter', 'per-client api'],
  nodes: [
    ...bffExperience(
      'web',
      BFF_WEB_X,
      'Web experience',
      'Owned by the web team',
      'Web Client',
      'Web BFF',
      'Shapes and aggregates backend calls for the web app. Not a shared gateway, not the domain.',
    ),
    {
      key: 'domain',
      type: 'group',
      boundaryPreset: 'boundary',
      text: 'Domain services',
      x: BFF_DOMAIN_X,
      y: 0,
      width: BFF_BOX_WIDTH,
      height: BFF_DOMAIN_HEIGHT,
      attachments: [
        { type: 'note', text: 'Shared capabilities with their own owners. A BFF composes them; it never owns them.' },
      ],
    },
    boundarySubtitle('domain-subtitle', 'domain', BFF_DOMAIN_X, 'Shared, reused by every client', BFF_SUBTITLE),
    ...BFF_SERVICES.map(
      (key, index): StarterNodeSpec => ({
        key,
        type: 'service',
        serviceKind: 'api',
        text: BFF_SERVICE_NAMES[index],
        accent: 'teal',
        parent: 'domain',
        x: BFF_DOMAIN_X + BOUNDARY_PAD,
        y: BFF_SERVICE_Y(index),
        ...SERVICE,
      }),
    ),
    ...bffExperience(
      'mobile',
      BFF_MOBILE_X,
      'Mobile experience',
      'Owned by the mobile team',
      'Mobile Client',
      'Mobile BFF',
      'Fewer round trips, smaller payloads — what a phone on a slow network needs.',
    ),
  ],
  edges: [
    down('web-client', 'web-bff'),
    down('mobile-client', 'mobile-bff'),
    // One fan per adapter, from opposite sides — see this block's doc comment.
    ...BFF_SERVICES.map((key) => across('web-bff', key)),
    { from: 'mobile-bff', to: 'customer', sourceAnchor: LEFT, targetAnchor: RIGHT },
    { from: 'mobile-bff', to: 'orders', sourceAnchor: LEFT, targetAnchor: RIGHT },
  ],
};

/* ------------------------------------------------------------------- cqrs -- */
/**
 * One client, two sides. Commands go left and change authoritative state; queries go right and
 * are answered from a model shaped for reading. The only bridge between the two is an event and
 * the projection that consumes it — which is also the only place eventual consistency enters, and
 * the diagram says so in as many words.
 *
 * **What each element is, and what it is careful not to say.**
 * - `Command API` → `Write Model` → `Write Store` is the command side: the API accepts an
 *   imperative (`command`, its attached example is `PlaceOrder` — a thing the caller wants, never a
 *   row to upsert), the model *executes* it (labelled so, since a second `command` caption in a
 *   row says nothing new), and the store holds current state in the write model's own shape.
 * - `Domain Events` is a Topic carrying *facts* (`OrderPlaced`), published by the write model after
 *   its store commits. It is **not an event store**: nothing here replays events to rebuild state,
 *   so this starter stays valid for a plain state-based write model that emits events. CQRS is
 *   not Event Sourcing, and the two are drawn apart on purpose.
 * - `Projection Service` is a Worker that turns each event into an update of the `Read Store`
 *   (`projects`, its own relationship — a derived write, never confused with the authoritative
 *   one), and `Query API` → `Read Store` is the query side: it `reads` and mutates nothing (the
 *   boundary's subtitle is the rule).
 * - The "Eventually consistent" annotation sits under the bridge: a read straight after a command
 *   may not yet see it. That is the one honest cost of the pattern, so it is on the canvas, not in
 *   a footnote.
 * - Two models, not necessarily two databases — the read store's note carries that nuance.
 *
 * **Routing.** Rows line up across the three columns so every bridge connector is a level line
 * or a plain drop; the topic's *tube* (not its box) sits level with the write model so the
 * `publishes` line is straight. The client's two connectors leave its bottom-centre for one
 * `command` and one `query`, whose captions the router keeps clear of the fan's horizontal run.
 *
 * **Flows.** "Submit command" walks the whole write story including its asynchronous tail; "Read
 * projection" is the two-step read.
 */
const CQRS_BOX_WIDTH = SERVICE.width + BOUNDARY_PAD * 2;
const CQRS_SUBTITLE = { width: 176, height: 24 };
/** First content row clears the boundary's subtitle — the same arithmetic as `MODULAR_API_Y`. */
const CQRS_TOP = BOUNDARY_TITLE_SUBLINE_Y + CQRS_SUBTITLE.height + 8;
/** Component's own default footprint (`DEFAULTS.componentWidth/Height`). */
const CQRS_MODEL = { width: 152, height: 56 };
const CQRS_API_Y = CQRS_TOP;
const CQRS_MODEL_Y = CQRS_API_Y + SERVICE.height + INNER_BAND;
const CQRS_STORE_Y = CQRS_MODEL_Y + CQRS_MODEL.height + INNER_BAND;
const CQRS_BOX_HEIGHT = CQRS_STORE_Y + STORE.height + BOUNDARY_PAD;
const CQRS_COMMAND_X = 0;
const CQRS_BRIDGE_X = CQRS_COMMAND_X + CQRS_BOX_WIDTH + GUTTER;
const CQRS_BRIDGE_CX = CQRS_BRIDGE_X + SERVICE.width / 2;
const CQRS_QUERY_X = CQRS_BRIDGE_X + SERVICE.width + GUTTER;
const CQRS_COMMAND_CX = CQRS_COMMAND_X + CQRS_BOX_WIDTH / 2;
const CQRS_QUERY_CX = CQRS_QUERY_X + CQRS_BOX_WIDTH / 2;
const CQRS_MODEL_CENTER = CQRS_MODEL_Y + CQRS_MODEL.height / 2;
const CQRS_STORE_CENTER = CQRS_STORE_Y + STORE.height / 2;
/** The annotation sits just under the store row, still inside the boundaries' own bottom pad. */
const CQRS_ANNOTATION_Y = CQRS_STORE_Y + STORE.height + 8;
const CQRS_ANNOTATION = { width: 124, height: 24 };

function cqrsSide(key: 'command' | 'query', left: number, title: string, subtitle: string): StarterNodeSpec[] {
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
    },
    boundarySubtitle(`${key}-subtitle`, `${key}-box`, left, subtitle, CQRS_SUBTITLE),
  ];
}

const cqrs: ArchitectureStarter = {
  id: 'cqrs',
  category: 'architecture',
  name: 'CQRS',
  description: 'Separate write and read models that evolve independently',
  aliases: ['cqrs', 'command query', 'command query responsibility segregation', 'read model', 'write model', 'projection'],
  nodes: [
    {
      key: 'client',
      type: 'actor',
      actorKind: 'human',
      text: 'Client',
      x: centeredAt(CQRS_BRIDGE_CX, ACTOR.width),
      y: -(BAND + ACTOR.height),
      ...ACTOR,
    },
    ...cqrsSide('command', CQRS_COMMAND_X, 'Command', 'Expresses intent'),
    {
      key: 'command-api',
      type: 'service',
      serviceKind: 'api',
      text: 'Command API',
      accent: 'teal',
      parent: 'command-box',
      x: CQRS_COMMAND_X + BOUNDARY_PAD,
      y: CQRS_API_Y,
      ...SERVICE,
      attachments: [
        {
          type: 'code',
          text: 'PlaceOrder',
          language: 'json',
          // An imperative, named for what the caller wants — never a row to upsert.
          code: ['{', '  "type": "PlaceOrder",', '  "customerId": "cus_1182",', '  "lines": [{ "sku": "A-100", "qty": 2 }]', '}'].join(
            '\n',
          ),
        },
      ],
    },
    {
      key: 'write-model',
      type: 'component',
      componentKind: 'generic',
      text: 'Write Model',
      parent: 'command-box',
      x: centeredAt(CQRS_COMMAND_CX, CQRS_MODEL.width),
      y: CQRS_MODEL_Y,
      ...CQRS_MODEL,
    },
    {
      key: 'write-store',
      type: 'database',
      databaseKind: 'generic',
      text: 'Write Store',
      accent: 'blue',
      parent: 'command-box',
      x: centeredAt(CQRS_COMMAND_CX, STORE.width),
      y: CQRS_STORE_Y,
      ...STORE,
    },
    {
      key: 'events',
      type: 'queue',
      queueKind: 'topic',
      text: 'Domain Events',
      x: centeredAt(CQRS_BRIDGE_CX, NAMED_QUEUE.width),
      y: tubeCenteredAt(CQRS_MODEL_CENTER, NAMED_QUEUE.height),
      ...NAMED_QUEUE,
    },
    {
      key: 'projection',
      type: 'service',
      serviceKind: 'worker',
      text: 'Projection Service',
      accent: 'teal',
      x: CQRS_BRIDGE_X,
      y: centeredAt(CQRS_STORE_CENTER, SERVICE.height),
      ...SERVICE,
    },
    {
      key: 'consistency',
      type: 'text',
      text: 'Eventually consistent',
      annotation: true,
      // Sized to its own text so the left-aligned annotation sits centred under the bridge.
      x: centeredAt(CQRS_BRIDGE_CX, CQRS_ANNOTATION.width),
      y: CQRS_ANNOTATION_Y,
      ...CQRS_ANNOTATION,
    },
    ...cqrsSide('query', CQRS_QUERY_X, 'Query', 'Never mutates state'),
    {
      key: 'query-api',
      type: 'service',
      serviceKind: 'api',
      text: 'Query API',
      accent: 'teal',
      parent: 'query-box',
      x: CQRS_QUERY_X + BOUNDARY_PAD,
      y: CQRS_API_Y,
      ...SERVICE,
    },
    {
      key: 'read-store',
      type: 'database',
      databaseKind: 'generic',
      text: 'Read Store',
      accent: 'blue',
      parent: 'query-box',
      x: centeredAt(CQRS_QUERY_CX, STORE.width),
      y: CQRS_STORE_Y,
      ...STORE,
      attachments: [
        {
          type: 'note',
          text: 'Shaped for the questions asked of it — a projection, not the write model. May share a physical database: CQRS separates models, not necessarily databases.',
        },
      ],
    },
  ],
  edges: [
    { key: 'submit', ...down('client', 'command-api'), semantic: 'command' },
    { key: 'handle', ...down('command-api', 'write-model'), semantic: 'command', label: 'executes' },
    { key: 'persist', ...down('write-model', 'write-store') },
    {
      key: 'publish',
      ...across('write-model', 'events'),
      attachments: [{ type: 'note', text: 'OrderPlaced — a fact, published after the write store commits.' }],
    },
    { key: 'project', ...down('events', 'projection') },
    { key: 'materialize', ...across('projection', 'read-store'), semantic: 'projects' },
    { key: 'query', ...down('client', 'query-api'), semantic: 'query' },
    { key: 'read', ...down('query-api', 'read-store'), semantic: 'reads' },
  ],
  flows: [
    {
      title: 'Submit command',
      accent: 'amber',
      steps: [
        { edgeKey: 'submit', caption: 'The client states what it wants' },
        { edgeKey: 'handle' },
        { edgeKey: 'persist', caption: 'Current state, in the write model’s shape' },
        { edgeKey: 'publish', caption: 'A fact leaves the command side' },
        { edgeKey: 'project' },
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
const OUTBOX_ROWS_CENTER = (OUTBOX_BUSINESS_Y + OUTBOX_RECORD_Y + TABLE.height) / 2;
const OUTBOX_RECORD_CENTER = OUTBOX_RECORD_Y + TABLE.height / 2;

const transactionalOutbox: ArchitectureStarter = {
  id: 'transactional-outbox',
  category: 'pattern',
  name: 'Transactional Outbox',
  description: 'Persist state and event intent atomically, publish after',
  aliases: ['outbox', 'transactional outbox', 'outbox pattern', 'dual write', 'reliable publish', 'cdc'],
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

/** Architectures first, then patterns — the palette's two headers stay contiguous by construction
 *  (`commands/registry.ts`'s `starterCommands`). */
export const ARCHITECTURE_STARTERS: readonly ArchitectureStarter[] = [
  monolith,
  modularMonolith,
  microservices,
  eventDriven,
  hexagonal,
  backendForFrontend,
  cqrs,
  sagaOrchestration,
  sagaChoreography,
  transactionalOutbox,
];
