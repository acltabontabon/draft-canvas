/**
 * The canonical shape of a `.draftcanvas` file: every object written with its keys in one fixed
 * order, whatever order the in-memory objects happened to acquire them in.
 *
 * Two documents that mean the same thing must serialize to the same bytes — that is what makes a
 * file diffable in a repository and lets the desktop tell "unchanged" from "changed" by comparing
 * text. An object's key order is an accident of how it was built (a spread here, a migration
 * there, a `validate.ts` pass on import), so nothing about it may reach the file.
 *
 * The order is the one `document/types.ts` declares: `id` first, then the interface's fields in
 * declaration order. A key the interface doesn't name (a field from a newer build, kept by a
 * lenient reader) goes after the known ones, sorted, with its own value deep-sorted the same way.
 * A key whose value is `undefined` is not written at all — "absent" is the only spelling of none.
 */
import type {
  Attachment,
  BackgroundSettings,
  DraftDocument,
  DraftEdge,
  DraftFlow,
  DraftFlowStep,
  DraftInside,
  DraftNode,
  DraftSettings,
  DraftViewport,
  EdgeAnchor,
  EdgeDetails,
  EmbeddedBackgroundImage,
  OpenPoint,
  OpenPointTarget,
} from '../document/types';

type Plain = Record<string, unknown>;

/** Every key of `T`, in the order `types.ts` declares them — `satisfies` keeps the list complete. */
type KeysOf<T> = readonly (keyof T & string)[];

const VIEWPORT_KEYS = ['x', 'y', 'zoom'] as const satisfies KeysOf<DraftViewport>;
const ANCHOR_KEYS = ['side', 'offset'] as const satisfies KeysOf<EdgeAnchor>;
const EDGE_DETAILS_KEYS = ['language', 'code'] as const satisfies KeysOf<EdgeDetails>;
const ATTACHMENT_KEYS = ['id', 'type', 'text', 'noteKind', 'language', 'code', 'accent', 'width', 'height'] as const satisfies KeysOf<Attachment>;
const NODE_KEYS = [
  'id',
  'type',
  'x',
  'y',
  'width',
  'height',
  'z',
  'parentId',
  'text',
  'description',
  'technology',
  'textOrigin',
  'accent',
  'noteKind',
  'language',
  'code',
  'serviceKind',
  'databaseKind',
  'queueKind',
  'actorKind',
  'componentKind',
  'boundaryPreset',
  'attachments',
  'deliveryRole',
  'annotation',
  'textRole',
  'textAlign',
  'textBold',
  'textItalic',
  'inside',
] as const satisfies KeysOf<DraftNode>;
const EDGE_KEYS = [
  'id',
  'source',
  'target',
  'label',
  'directed',
  'routing',
  'accent',
  'details',
  'semantic',
  'condition',
  'response',
  'hasResponse',
  'kind',
  'async',
  'sourceAnchor',
  'targetAnchor',
  'routeMode',
  'semanticsOrigin',
  'attachments',
  'deliveryAttempts',
] as const satisfies KeysOf<DraftEdge>;
const STEP_KEYS = ['id', 'edgeId', 'extraEdgeIds', 'extraNodeIds', 'viewport', 'caption'] as const satisfies KeysOf<DraftFlowStep>;
const FLOW_KEYS = ['id', 'title', 'steps', 'accent', 'variantOf'] as const satisfies KeysOf<DraftFlow>;
const INSIDE_KEYS = ['nodes', 'edges', 'flows', 'viewport', 'level'] as const satisfies KeysOf<DraftInside>;
const EMBEDDED_IMAGE_KEYS = ['dataUri', 'width', 'height'] as const satisfies KeysOf<EmbeddedBackgroundImage>;
const BACKGROUND_KEYS = ['enabled', 'fit', 'dim', 'blur', 'imageId', 'image'] as const satisfies KeysOf<BackgroundSettings>;
const SETTINGS_KEYS = ['showSequence', 'grid', 'background'] as const satisfies KeysOf<DraftSettings>;
const OPEN_POINT_TARGET_KEYS = ['kind', 'id'] as const satisfies KeysOf<OpenPointTarget>;
const OPEN_POINT_KEYS = ['id', 'kind', 'context', 'targets', 'resolved', 'resolution'] as const satisfies KeysOf<OpenPoint>;

type Nested = Partial<Record<string, (value: unknown) => unknown>>;

/** Whatever this file has no order for: keys sorted, all the way down, arrays kept in order. */
function deepSorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSorted);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Plain;
  const out: Plain = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = deepSorted(source[key]);
  }
  return out;
}

/**
 * `value` rewritten with `known` first (in that order, skipping what it lacks), then any other
 * key sorted. `nested` says how a known key's value is itself canonicalized; an unknown key's
 * value is deep-sorted.
 */
function ordered(value: object, known: readonly string[], nested: Nested = {}): Plain {
  const source = value as Plain;
  const out: Plain = {};
  const put = (key: string, canonical: (v: unknown) => unknown) => {
    const raw = source[key];
    if (raw !== undefined) out[key] = canonical(raw);
  };
  for (const key of known) {
    if (key in source) put(key, nested[key] ?? ((v) => v));
  }
  const extra = Object.keys(source).filter((key) => !known.includes(key)).sort();
  for (const key of extra) put(key, deepSorted);
  return out;
}

const list =
  (each: (value: unknown) => unknown) =>
  (value: unknown): unknown =>
    Array.isArray(value) ? value.map(each) : deepSorted(value);

const orderedIfObject =
  (known: readonly string[], nested: Nested = {}) =>
  (value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? ordered(value, known, nested) : deepSorted(value);

const viewport = orderedIfObject(VIEWPORT_KEYS);
const anchor = orderedIfObject(ANCHOR_KEYS);
const attachment = orderedIfObject(ATTACHMENT_KEYS);
const attachments = list(attachment);
const edge = orderedIfObject(EDGE_KEYS, {
  details: orderedIfObject(EDGE_DETAILS_KEYS),
  sourceAnchor: anchor,
  targetAnchor: anchor,
  attachments,
});
const step = orderedIfObject(STEP_KEYS, { viewport });
const flow = orderedIfObject(FLOW_KEYS, { steps: list(step) });
const flows = list(flow);
const edges = list(edge);
const openPoint = orderedIfObject(OPEN_POINT_KEYS, { targets: list(orderedIfObject(OPEN_POINT_TARGET_KEYS)) });

// `node` and `inside` refer to each other: a room holds nodes, and a node may hold a room.
function node(value: unknown): unknown {
  return orderedIfObject(NODE_KEYS, { attachments, inside })(value);
}
function inside(value: unknown): unknown {
  return orderedIfObject(INSIDE_KEYS, { nodes: list(node), edges, flows, viewport })(value);
}

const background = orderedIfObject(BACKGROUND_KEYS, { image: orderedIfObject(EMBEDDED_IMAGE_KEYS) });
const settings = orderedIfObject(SETTINGS_KEYS, { background });

/** The body of a document, every level in canonical key order. `format`, `version` and `metadata`
 *  are the serializer's own to write, so this covers the rest. */
export const canonical = {
  nodes: list(node) as (nodes: DraftNode[]) => unknown,
  edges: edges as (edges: DraftEdge[]) => unknown,
  viewport: viewport as (viewport: DraftViewport) => unknown,
  settings: settings as (settings: DraftSettings) => unknown,
  flows: flows as (flows: DraftFlow[]) => unknown,
  openPoints: list(openPoint) as (points: OpenPoint[]) => unknown,
} satisfies Partial<Record<keyof DraftDocument, unknown>>;
