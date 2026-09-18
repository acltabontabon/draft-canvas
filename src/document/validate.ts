/**
 * The untrusted-input boundary.
 *
 * Everything entering the app from a file or from a possibly-corrupted
 * IndexedDB record passes through `normalizeDocument`. The policy is *repair,
 * don't reject*: a diagram with three broken edges should open with the other
 * ninety-seven intact and tell the user what was dropped. Only a file we cannot
 * recognise at all, or one written by a newer format, is refused outright.
 */
import { createId } from './ids';
import { LIMITS } from './limits';
import { migrateToCurrent, UnsupportedVersionError } from './migrate';
import { defaultSizeFor } from './factory';
import {
  ACCENTS,
  ACTOR_KINDS,
  ATTACHABLE_TYPES,
  BACKGROUND_FITS,
  BOUNDARY_PRESETS,
  CODE_LANGUAGES,
  COMPONENT_KINDS,
  CONNECTOR_KINDS,
  CURRENT_VERSION,
  DATABASE_KINDS,
  DELIVERY_ROLES,
  DRAFT_FORMAT,
  EDGE_ROUTINGS,
  GRID_MODES,
  NODE_TYPES,
  NOTE_KINDS,
  EDGE_SEMANTICS,
  QUEUE_KINDS,
  ROUTE_MODES,
  SERVICE_KINDS,
  SIDES,
  TEXT_ALIGNS,
  TEXT_ROLES,
  VIEW_LEVELS,
  type Accent,
  type ActorKind,
  type AttachableType,
  type Attachment,
  type DraftAction,
  type BackgroundFit,
  type BoundaryPreset,
  type CodeLanguage,
  type ComponentKind,
  type ConnectorKind,
  type DatabaseKind,
  type DeliveryRole,
  type DraftDocument,
  type DraftEdge,
  type DraftFlow,
  type DraftFlowStep,
  type DraftNode,
  type DraftNodeType,
  type EdgeAnchor,
  type EdgeRouting,
  type EdgeSemantic,
  type GridMode,
  type NoteKind,
  type QueueKind,
  type RouteMode,
  type ServiceKind,
  type TextAlign,
  type TextRole,
  type ViewLevel,
} from './types';
import { clamp, isFiniteNumber } from '../lib/math';
import { isRecord } from '../lib/isRecord';

export type NormalizeResult =
  | { ok: true; document: DraftDocument; repairs: string[] }
  | { ok: false; error: string };

const finite = (value: unknown, fallback: number): number => (isFiniteNumber(value) ? value : fallback);

/**
 * Control characters have no place in a label and confuse DOM and SVG alike.
 * Tab, newline and carriage return are deliberately kept: code cards
 * legitimately contain them.
 */
// oxlint-disable-next-line no-control-regex -- matching them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(CONTROL_CHARS, '');
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Like `oneOf`, but an absent or invalid value stays absent rather than being
 *  coerced to a fallback — used for fields that are optional conveniences
 *  rather than always-present classifications (e.g. an edge's `semantic`). */
function oneOfOptional<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Like `oneOfOptional`, but for a number: absent or non-finite stays absent (never a fabricated
 * default — genuine absence is meaningful, e.g. a `deadLetters` edge someone hasn't configured a
 * count for yet), while a present-but-out-of-range value (zero, negative, a hand-edited million)
 * is clamped into range rather than dropped — the same "repair the value, don't reject the field"
 * discipline every other numeric field in this file already follows.
 */
function positiveIntOptional(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clamp(Math.round(value), min, max);
}

/**
 * The `note`/`code` field pairs shared by a top-level node and an attachment —
 * both are "a Note or a Code card's content," so this is the one place that
 * knows how to read them out of an untrusted candidate object.
 */
function validateAttachableFields(
  candidate: Record<string, unknown>,
  type: DraftNodeType | AttachableType,
): Pick<DraftNode, 'noteKind' | 'language' | 'code'> {
  const fields: Pick<DraftNode, 'noteKind' | 'language' | 'code'> = {};
  if (type === 'note') {
    fields.noteKind = oneOf<NoteKind>(candidate.noteKind, NOTE_KINDS, 'note');
  }
  if (type === 'code') {
    fields.language = oneOf<CodeLanguage>(candidate.language, CODE_LANGUAGES, 'plaintext');
    fields.code = text(candidate.code, LIMITS.maxCodeLength) ?? '';
  }
  return fields;
}

/** An edge's `sourceAnchor`/`targetAnchor`: a closed-enum side plus a clamped
 *  0..1 offset. Absent or malformed collapses to `undefined` — same repair
 *  discipline as `semantic` — rather than a coerced fallback, since "no
 *  anchor" is a meaningful, common state (see `EdgeAnchor` in `types.ts`). */
function parseAnchor(value: unknown): EdgeAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const side = oneOfOptional(value.side, SIDES);
  if (!side) return undefined;
  return { side, offset: clamp(finite(value.offset, 0.5), 0, 1) };
}

function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.maxIdLength) return null;
  return trimmed;
}

/**
 * A node id, which unlike every other id is also a path segment: `depth/tree.ts` joins them with a
 * control character to name a room. An id carrying a control character itself could name the same
 * room as two other nodes and be handed the wrong room's contents, so only those are refused here;
 * a refused id is reissued like a duplicate one, and every reference to it remapped.
 */
function safeNodeId(value: unknown): string | null {
  const id = safeId(value);
  if (id === null) return null;
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return id;
}

/**
 * A host's attachment list — shared by nodes and connectors, which carry the identical shape. Keeps
 * at most `max`, gives missing or duplicate ids fresh ones, and keeps a card's size (detaching
 * restores it at the size it had, not a default). Counts what it dropped and cut so the caller can
 * report it.
 */
function parseAttachments(
  value: unknown,
  max: number,
): { attachments: Attachment[]; dropped: number; truncated: number } {
  const raw = Array.isArray(value) ? value : [];
  const attachments: Attachment[] = [];
  const seenIds = new Set<string>();
  let dropped = 0;
  for (const rawAttachment of raw.slice(0, max)) {
    if (!isRecord(rawAttachment)) {
      dropped += 1;
      continue;
    }
    let id = safeId(rawAttachment.id);
    if (!id || seenIds.has(id)) id = createId('a');
    seenIds.add(id);

    const type = oneOf<AttachableType>(rawAttachment.type, ATTACHABLE_TYPES, 'note');
    const attachment: Attachment = { id, type };

    const label = text(rawAttachment.text, LIMITS.maxTextLength);
    if (label !== undefined) attachment.text = label;

    const accent = oneOfOptional<Accent>(rawAttachment.accent, ACCENTS);
    if (accent !== undefined) attachment.accent = accent;

    Object.assign(attachment, validateAttachableFields(rawAttachment, type));

    const width = finite(rawAttachment.width, Number.NaN);
    const height = finite(rawAttachment.height, Number.NaN);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      attachment.width = clamp(width, LIMITS.minNodeSize, LIMITS.maxNodeSize);
      attachment.height = clamp(height, LIMITS.minNodeSize, LIMITS.maxNodeSize);
    }

    attachments.push(attachment);
  }
  return { attachments, dropped, truncated: Math.max(0, raw.length - max) };
}

/** Node types that may own a room. Narrower than what the app offers "Look inside" on: a Service
 *  retyped to a Data Store must keep its contents (`depth/tree.ts`'s `canCreateInside` is the
 *  narrower, authoring-time rule), but a Note claiming to have an inside is a hand-edited file. */
const CAN_HOLD_INSIDE: readonly DraftNodeType[] = ['service', 'component', 'database', 'queue', 'actor'];

/**
 * One room waiting to be validated, held over rather than recursed into on the spot.
 *
 * Rooms are processed a level at a time, and that ordering is the whole point: the document's
 * limits are a budget for the *file*, and spending it breadth-first means an enormous file loses
 * its deepest detail rather than the overview everything else hangs off.
 */
interface PendingInside {
  node: DraftNode;
  raw: unknown;
  depth: number;
}

/** What is shared by every room in one file: id uniqueness, the remaining budget, and the queue. */
interface FileContext {
  depth: number;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  flowIds: Set<string>;
  budget: { nodes: number; edges: number; flows: number };
  pending: PendingInside[];
  dropped: { deep: number; unreadable: number; overBudget: number };
}

/** The same file's context, one room deeper. Everything but `depth` is shared on purpose. */
function childContext(ctx: FileContext, depth: number): FileContext {
  return {
    depth,
    nodeIds: ctx.nodeIds,
    edgeIds: ctx.edgeIds,
    flowIds: ctx.flowIds,
    budget: ctx.budget,
    pending: ctx.pending,
    dropped: ctx.dropped,
  };
}

function rootContext(): FileContext {
  return {
    depth: 0,
    nodeIds: new Set(),
    edgeIds: new Set(),
    flowIds: new Set(),
    budget: { nodes: LIMITS.maxNodes, edges: LIMITS.maxEdges, flows: LIMITS.maxFlows },
    pending: [],
    dropped: { deep: 0, unreadable: 0, overBudget: 0 },
  };
}

/**
 * Validates every queued room, level by level, attaching each to the node that owns it.
 *
 * A room is validated by the same function as the document that contains it, so every repair the
 * top level makes — whitelisted enums, clamped coordinates, dropped dangling references — applies
 * identically however deep the shape sits. Two rules are enforced only here: nesting stops at
 * `maxInsideDepth`, and an empty room is not a room (see `DraftInside`), so a file hand-edited to
 * contain one opens without it rather than showing a shape that claims an inside it hasn't got.
 */
function drainInsides(ctx: FileContext, repairs: string[]): void {
  while (ctx.pending.length > 0) {
    const level = ctx.pending;
    ctx.pending = [];
    for (const { node, raw, depth } of level) {
      if (depth > LIMITS.maxInsideDepth) {
        ctx.dropped.deep += 1;
        continue;
      }
      if (ctx.budget.nodes <= 0) {
        ctx.dropped.overBudget += 1;
        continue;
      }
      // Deliberately the same context, one level down: the id sets, the remaining allowance, the
      // queue and the tally are the *file's*, and every room has to spend and add to the same ones.
      // Only `depth` differs, and `pending` is safe to hand on because this loop is iterating over
      // a list it already took off `ctx`.
      const result = normalizeDocument(raw, repairs, childContext(ctx, depth));
      if (!result.ok || result.document.nodes.length === 0) {
        ctx.dropped.unreadable += 1;
        continue;
      }
      const { nodes, edges, flows, viewport, level } = result.document;
      node.inside = { nodes, edges, flows, viewport, ...(level === undefined ? {} : { level }) };
    }
  }

  if (ctx.dropped.unreadable > 0) {
    repairs.push(`Dropped what was inside ${ctx.dropped.unreadable} shape(s) — unreadable or empty.`);
  }
  if (ctx.dropped.deep > 0) {
    repairs.push(`Dropped what was inside ${ctx.dropped.deep} shape(s) — nested deeper than ${LIMITS.maxInsideDepth} levels.`);
  }
  if (ctx.dropped.overBudget > 0) {
    repairs.push(`Dropped what was inside ${ctx.dropped.overBudget} shape(s) — the canvas was already full.`);
  }
}

/**
 * Parses a `.draftcanvas` payload. Accepts either a JSON string or an
 * already-parsed value so callers can reuse it for IndexedDB records.
 */
export function parseDocument(input: unknown): NormalizeResult {
  let raw: unknown = input;

  if (typeof input === 'string') {
    if (input.length > LIMITS.maxFileBytes) {
      return { ok: false, error: 'That file is too large to open.' };
    }
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
  }

  if (!isRecord(raw)) {
    return { ok: false, error: 'That file does not contain a Draft Canvas document.' };
  }
  if (raw.format !== DRAFT_FORMAT) {
    return {
      ok: false,
      error: 'That file is not a Draft Canvas document (missing "draft-canvas" format marker).',
    };
  }

  let migrated: Record<string, unknown>;
  const repairs: string[] = [];
  try {
    const result = migrateToCurrent(raw);
    migrated = result.doc;
    if (result.applied.length > 0) {
      repairs.push(`Upgraded document format from v${result.applied[0]} to v${CURRENT_VERSION}.`);
    }
  } catch (error) {
    if (error instanceof UnsupportedVersionError) return { ok: false, error: error.message };
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not read that file.',
    };
  }

  return normalizeDocument(migrated, repairs);
}

/**
 * Repairs and reshapes a raw value into a valid `DraftDocument` — does NOT
 * run schema migrations (see `migrateToCurrent` / `parseDocument`). Calling
 * this directly on a document whose `version` predates the current schema
 * will leave old-shaped fields unrecognised rather than migrated. Every real
 * document source (IndexedDB, file import, clipboard) goes through
 * `parseDocument`, which runs `migrateToCurrent` first — this is exported
 * separately only so tests can exercise repair behaviour in isolation,
 * already at current-schema shape.
 */
export function normalizeDocument(raw: unknown, repairs: string[] = [], parent?: FileContext): NormalizeResult {
  if (!isRecord(raw)) return { ok: false, error: 'That document is empty or unreadable.' };

  // Rooms are validated through this same function, sharing one context: ids stay unique across
  // the whole file, and the node/connector limits are one budget for all of it rather than a
  // fresh allowance per room.
  const ctx = parent ?? rootContext();
  const isRoot = parent === undefined;
  // The same function validates the document and every room in it, so anything it reports has to
  // say which one it is talking about; "Document had 800 nodes" about a room is a lie about the file.
  const here = isRoot ? 'Document' : 'What was inside a shape';

  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const now = Date.now();
  const createdAt = finite(meta.createdAt, now);

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];

  if (isRoot && !Array.isArray(raw.nodes)) {
    repairs.push('Document had no node list; started an empty canvas.');
  }
  if (rawNodes.length > ctx.budget.nodes) {
    repairs.push(`${here} had ${rawNodes.length} nodes; kept the first ${Math.max(0, ctx.budget.nodes)}.`);
  }
  if (rawEdges.length > ctx.budget.edges) {
    repairs.push(`${here} had ${rawEdges.length} connectors; kept the first ${Math.max(0, ctx.budget.edges)}.`);
  }

  /* --------------------------------------------------------------- nodes -- */

  const seenNodeIds = ctx.nodeIds;
  const nodes: DraftNode[] = [];
  let droppedNodes = 0;
  let renamedNodes = 0;
  let droppedAttachments = 0;
  let truncatedAttachments = 0;
  let droppedInsides = 0;
  let droppedEdgeAttachments = 0;
  let truncatedEdgeAttachments = 0;
  /** Maps the id as written in the file to the id we actually used. */
  const nodeIdRemap = new Map<string, string>();

  for (const candidate of rawNodes.slice(0, Math.max(0, ctx.budget.nodes))) {
    if (!isRecord(candidate)) {
      droppedNodes += 1;
      continue;
    }
    const originalId = typeof candidate.id === 'string' ? candidate.id : null;
    let id = safeNodeId(candidate.id);
    if (!id || seenNodeIds.has(id)) {
      // Missing or duplicate ids would make selection and edge routing ambiguous.
      id = createId('n');
      renamedNodes += 1;
    }
    seenNodeIds.add(id);
    if (originalId && !nodeIdRemap.has(originalId)) nodeIdRemap.set(originalId, id);

    const type = oneOf<DraftNodeType>(candidate.type, NODE_TYPES, 'note');
    const fallbackSize = defaultSizeFor(type);

    const node: DraftNode = {
      id,
      type,
      x: clamp(finite(candidate.x, 0), -LIMITS.maxCoordinate, LIMITS.maxCoordinate),
      y: clamp(finite(candidate.y, 0), -LIMITS.maxCoordinate, LIMITS.maxCoordinate),
      // Whole pixels, like every size the editor writes (`clampSize`): the canvas renders rounded sizes,
      // and a fractional one would never match them — a fresh node object on every render.
      width: Math.round(
        clamp(finite(candidate.width, fallbackSize.width), LIMITS.minNodeSize, LIMITS.maxNodeSize),
      ),
      height: Math.round(
        clamp(finite(candidate.height, fallbackSize.height), LIMITS.minNodeSize, LIMITS.maxNodeSize),
      ),
      z: Math.round(clamp(finite(candidate.z, 0), -10_000, 10_000)),
    };

    const label = text(candidate.text, LIMITS.maxTextLength);
    if (label !== undefined) node.text = label;

    // Absent stays absent, same reasoning as `semanticsOrigin` below: a document saved before
    // this field existed has no way to say its label was auto-generated, so it's left with no
    // marker at all — `DraftNode.textOrigin`'s own doc comment covers why that reads as
    // `'explicit'` wherever it's consulted, rather than defaulting the field itself to that value.
    const textOrigin = oneOfOptional<'auto' | 'explicit'>(candidate.textOrigin, ['auto', 'explicit']);
    if (textOrigin !== undefined) node.textOrigin = textOrigin;

    // `oneOfOptional`, not `oneOf`, is what this needs: a node's own accent is
    // an explicit override of its type's default colour, and neutral (grey)
    // is one of the choices a user can make, not a synonym for "unset". Using
    // `oneOf`'s forced fallback and then treating that fallback as "leave it
    // off" made an explicit choice of neutral indistinguishable from never
    // having set one, so it never survived a save/reload round trip (which
    // always passes through here) — the node would revert to its type's own
    // default colour (e.g. teal for a Service) instead of staying grey.
    const accent = oneOfOptional<Accent>(candidate.accent, ACCENTS);
    if (accent !== undefined) node.accent = accent;

    if (typeof candidate.parentId === 'string') {
      // Resolved in a second pass, once every node id is known.
      node.parentId = candidate.parentId;
    }

    Object.assign(node, validateAttachableFields(candidate, type));

    if (type === 'group') {
      node.boundaryPreset = oneOf<BoundaryPreset>(candidate.boundaryPreset, BOUNDARY_PRESETS, 'boundary');
    }
    if (type === 'service') {
      node.serviceKind = oneOf<ServiceKind>(candidate.serviceKind, SERVICE_KINDS, 'generic');
    }
    if (type === 'database') {
      node.databaseKind = oneOf<DatabaseKind>(candidate.databaseKind, DATABASE_KINDS, 'generic');
    }
    if (type === 'queue') {
      node.queueKind = oneOf<QueueKind>(candidate.queueKind, QUEUE_KINDS, 'queue');
      const deliveryRole = oneOfOptional<DeliveryRole>(candidate.deliveryRole, DELIVERY_ROLES);
      if (deliveryRole) node.deliveryRole = deliveryRole;
    }
    if (type === 'actor') {
      node.actorKind = oneOf<ActorKind>(candidate.actorKind, ACTOR_KINDS, 'human');
    }
    if (type === 'component') {
      node.componentKind = oneOf<ComponentKind>(candidate.componentKind, COMPONENT_KINDS, 'generic');
    }
    if (type === 'text' && candidate.annotation === true) {
      node.annotation = true;
    }
    if (type === 'text') {
      const textRole = oneOfOptional<TextRole>(candidate.textRole, TEXT_ROLES);
      if (textRole !== undefined) node.textRole = textRole;
      const textAlign = oneOfOptional<TextAlign>(candidate.textAlign, TEXT_ALIGNS);
      if (textAlign !== undefined) node.textAlign = textAlign;
      if (candidate.textBold === true) node.textBold = true;
      if (candidate.textItalic === true) node.textItalic = true;
    }

    const nodeAttachments = parseAttachments(candidate.attachments, LIMITS.maxAttachmentsPerNode);
    droppedAttachments += nodeAttachments.dropped;
    truncatedAttachments += nodeAttachments.truncated;
    if (nodeAttachments.attachments.length > 0) node.attachments = nodeAttachments.attachments;

    // Held over rather than validated here — see `PendingInside`.
    if (candidate.inside !== undefined) {
      if (isRecord(candidate.inside) && CAN_HOLD_INSIDE.includes(type)) {
        ctx.pending.push({ node, raw: candidate.inside, depth: ctx.depth + 1 });
      } else {
        droppedInsides += 1;
      }
    }

    nodes.push(node);
  }

  // Second pass: resolve parents, dropping dangling, self-, non-boundary and cyclic links.
  let droppedParents = 0;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (!node.parentId) continue;
    const mapped = nodeIdRemap.get(node.parentId);
    // Only a boundary contains anything: delete cascades through `parentId`, so a note
    // "inside" a service would vanish with it.
    if (!mapped || mapped === node.id || byId.get(mapped)?.type !== 'group') {
      delete node.parentId;
      droppedParents += 1;
      continue;
    }
    node.parentId = mapped;
  }
  // A link is only broken where the node itself sits on the cycle. A node whose chain merely
  // leads into a cycle keeps its parent — the cycle is cut at one of its own members instead.
  for (const node of nodes) {
    if (!node.parentId) continue;
    const visited = new Set<string>();
    let cursor = byId.get(node.parentId);
    while (cursor && !visited.has(cursor.id)) {
      if (cursor.id === node.id) {
        delete node.parentId;
        droppedParents += 1;
        break;
      }
      visited.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  /* --------------------------------------------------------------- edges -- */

  const seenEdgeIds = ctx.edgeIds;
  const edges: DraftEdge[] = [];
  let droppedEdges = 0;
  let droppedSelfLoopEdges = 0;
  /** Maps the edge id as written in the file to the id we actually used — flows resolve through this. */
  const edgeIdRemap = new Map<string, string>();

  for (const candidate of rawEdges.slice(0, Math.max(0, ctx.budget.edges))) {
    if (!isRecord(candidate)) {
      droppedEdges += 1;
      continue;
    }
    const source =
      typeof candidate.source === 'string' ? nodeIdRemap.get(candidate.source) : undefined;
    const target =
      typeof candidate.target === 'string' ? nodeIdRemap.get(candidate.target) : undefined;
    if (!source || !target || !byId.has(source) || !byId.has(target)) {
      droppedEdges += 1;
      continue;
    }
    // In-app `connect()` already refuses a self-loop; a file can still
    // contain one (hand-edited, or written by a different tool), and nothing
    // downstream (routing, hit-testing) expects a connector with the same
    // node at both ends.
    if (source === target) {
      droppedSelfLoopEdges += 1;
      continue;
    }

    const originalEdgeId = typeof candidate.id === 'string' ? candidate.id : null;
    let id = safeId(candidate.id);
    if (!id || seenEdgeIds.has(id)) id = createId('e');
    seenEdgeIds.add(id);
    if (originalEdgeId && !edgeIdRemap.has(originalEdgeId)) edgeIdRemap.set(originalEdgeId, id);

    const edge: DraftEdge = {
      id,
      source,
      target,
      directed: candidate.directed !== false,
      routing: oneOf<EdgeRouting>(candidate.routing, EDGE_ROUTINGS, 'smoothstep'),
    };

    const label = text(candidate.label, LIMITS.maxLabelLength);
    if (label) edge.label = label;

    // See the matching comment on the node's own accent above: `neutral` is a
    // real, explicit choice here too, not an absence to collapse away.
    const accent = oneOfOptional<Accent>(candidate.accent, ACCENTS);
    if (accent !== undefined) edge.accent = accent;

    const condition = text(candidate.condition, LIMITS.maxConditionLength)?.trim();
    if (condition) edge.condition = condition;

    const response = text(candidate.response, LIMITS.maxResponseLength)?.trim();
    if (response) edge.response = response;

    if (candidate.hasResponse === true) edge.hasResponse = true;

    if (candidate.async === true) edge.async = true;

    if (isRecord(candidate.details)) {
      const code = text(candidate.details.code, LIMITS.maxCodeLength);
      if (code) {
        edge.details = {
          language: oneOf<CodeLanguage>(candidate.details.language, CODE_LANGUAGES, 'json'),
          code,
        };
      }
    }

    // Unlike node sub-kinds, an absent or unrecognised semantic stays absent
    // rather than being coerced to a fallback value — a freshly-drawn edge
    // has no semantic by default, and an unknown string from a newer format
    // should not silently become e.g. "http".
    const semantic = oneOfOptional<EdgeSemantic>(candidate.semantic, EDGE_SEMANTICS);
    if (semantic) edge.semantic = semantic;

    // Not gated on `semantic === 'deadLetters'` at parse time — same "repair the value, don't
    // reject the field based on a sibling" discipline `response`/`hasResponse` already follow.
    const deliveryAttempts = positiveIntOptional(candidate.deliveryAttempts, 1, 50);
    if (deliveryAttempts !== undefined) edge.deliveryAttempts = deliveryAttempts;

    // Same discipline as semantic: absent or unrecognised stays absent, not
    // coerced to a fallback kind.
    const kind = oneOfOptional<ConnectorKind>(candidate.kind, CONNECTOR_KINDS);
    if (kind) edge.kind = kind;

    // Same discipline again: absent or unrecognised stays absent — a
    // connector saved before this field existed reads as legacy-explicit via
    // `isEligibleForReinference`, not as blank-and-inferrable.
    const semanticsOrigin = oneOfOptional<'inferred' | 'explicit'>(candidate.semanticsOrigin, [
      'inferred',
      'explicit',
    ]);
    if (semanticsOrigin) edge.semanticsOrigin = semanticsOrigin;

    // Absent means Smart Routing, so an unrecognised value must fall back to
    // absent rather than to a literal — see `DraftEdge.routeMode`. This also
    // carries the override through copy/paste: `clipboardCodec.ts` round-trips
    // a fragment through this same normalizer, so an omission here would
    // silently strip the user's choice on every paste.
    const routeMode = oneOfOptional<RouteMode>(candidate.routeMode, ROUTE_MODES);
    if (routeMode) edge.routeMode = routeMode;

    const sourceAnchor = parseAnchor(candidate.sourceAnchor);
    if (sourceAnchor) edge.sourceAnchor = sourceAnchor;
    const targetAnchor = parseAnchor(candidate.targetAnchor);
    if (targetAnchor) edge.targetAnchor = targetAnchor;

    // The identical `Attachment` shape a node carries, just hosted on a connector.
    const edgeAttachments = parseAttachments(candidate.attachments, LIMITS.maxAttachmentsPerEdge);
    droppedEdgeAttachments += edgeAttachments.dropped;
    truncatedEdgeAttachments += edgeAttachments.truncated;
    if (edgeAttachments.attachments.length > 0) edge.attachments = edgeAttachments.attachments;

    edges.push(edge);
  }

  if (droppedNodes > 0) repairs.push(`Dropped ${droppedNodes} unreadable node(s).`);
  if (renamedNodes > 0) {
    repairs.push(`Gave ${renamedNodes} node(s) new ids (missing or duplicate).`);
  }
  if (droppedParents > 0) repairs.push(`Removed ${droppedParents} invalid grouping link(s).`);
  if (droppedAttachments > 0) {
    repairs.push(`Dropped ${droppedAttachments} unreadable attachment(s).`);
  }
  if (truncatedAttachments > 0) {
    repairs.push(`A node had too many attachments; kept the first ${LIMITS.maxAttachmentsPerNode}.`);
  }
  if (droppedInsides > 0) {
    repairs.push(`Dropped what was inside ${droppedInsides} shape(s) — shapes of that kind hold nothing.`);
  }
  if (droppedEdges > 0) {
    repairs.push(`Dropped ${droppedEdges} connector(s) pointing at nodes that do not exist.`);
  }
  if (droppedSelfLoopEdges > 0) {
    repairs.push(`Dropped ${droppedSelfLoopEdges} connector(s) that pointed a node at itself.`);
  }
  if (droppedEdgeAttachments > 0) {
    repairs.push(`Dropped ${droppedEdgeAttachments} unreadable connector attachment(s).`);
  }
  if (truncatedEdgeAttachments > 0) {
    repairs.push(`A connector had too many attachments; kept the first ${LIMITS.maxAttachmentsPerEdge}.`);
  }

  /* --------------------------------------------------------------- flows -- */

  const rawFlows = Array.isArray(raw.flows) ? raw.flows : [];
  const flows: DraftFlow[] = [];
  let droppedFlows = 0;
  let droppedFlowSteps = 0;
  let truncatedFlowSteps = 0;
  const seenFlowIds = ctx.flowIds;
  const flowAllowance = Math.max(0, ctx.budget.flows);
  if (rawFlows.length > flowAllowance) {
    repairs.push(`${here} had too many flows; kept the first ${flowAllowance}.`);
  }

  for (const candidateFlow of rawFlows.slice(0, flowAllowance)) {
    if (!isRecord(candidateFlow)) {
      droppedFlows += 1;
      continue;
    }
    let id = safeId(candidateFlow.id) ?? createId('f');
    if (seenFlowIds.has(id)) id = createId('f');
    seenFlowIds.add(id);
    const title = text(candidateFlow.title, LIMITS.maxFlowTitleLength)?.trim() || 'Untitled flow';
    // Same discipline as a node/edge's own accent: absent or unrecognised
    // stays absent rather than being coerced to a fallback.
    const flowAccent = oneOfOptional<Accent>(candidateFlow.accent, ACCENTS);
    const rawSteps = Array.isArray(candidateFlow.steps) ? candidateFlow.steps : [];

    const steps: DraftFlowStep[] = [];
    const seenStepEdgeIds = new Set<string>();
    const seenStepIds = new Set<string>();
    if (rawSteps.length > LIMITS.maxStepsPerFlow) truncatedFlowSteps += 1;
    for (const candidateStep of rawSteps.slice(0, LIMITS.maxStepsPerFlow)) {
      if (!isRecord(candidateStep)) {
        droppedFlowSteps += 1;
        continue;
      }
      const rawEdgeId = typeof candidateStep.edgeId === 'string' ? candidateStep.edgeId : undefined;
      let edgeId = rawEdgeId ? edgeIdRemap.get(rawEdgeId) : undefined;
      // A primary connector that was dropped, or that duplicates one already
      // used as a primary elsewhere in this flow, is repaired away — but
      // unlike before `extraEdgeIds`/`extraNodeIds`/`viewport` existed, that
      // no longer means dropping the whole step; see below.
      if (edgeId && seenStepEdgeIds.has(edgeId)) edgeId = undefined;
      if (edgeId) seenStepEdgeIds.add(edgeId);

      const rawExtraEdgeIds = Array.isArray(candidateStep.extraEdgeIds) ? candidateStep.extraEdgeIds : [];
      const extraEdgeIds: string[] = [];
      for (const raw of rawExtraEdgeIds.slice(0, LIMITS.maxExtraMembersPerStep)) {
        if (typeof raw !== 'string') continue;
        const mapped = edgeIdRemap.get(raw);
        if (mapped && mapped !== edgeId && !extraEdgeIds.includes(mapped)) extraEdgeIds.push(mapped);
      }

      const rawExtraNodeIds = Array.isArray(candidateStep.extraNodeIds) ? candidateStep.extraNodeIds : [];
      const extraNodeIds: string[] = [];
      for (const raw of rawExtraNodeIds.slice(0, LIMITS.maxExtraMembersPerStep)) {
        if (typeof raw !== 'string') continue;
        const mapped = nodeIdRemap.get(raw);
        if (mapped && byId.has(mapped) && !extraNodeIds.includes(mapped)) extraNodeIds.push(mapped);
      }

      const rawViewport = candidateStep.viewport;
      const viewport = isRecord(rawViewport)
        ? {
            x: clamp(finite(rawViewport.x, 0), -LIMITS.maxCoordinate, LIMITS.maxCoordinate),
            y: clamp(finite(rawViewport.y, 0), -LIMITS.maxCoordinate, LIMITS.maxCoordinate),
            zoom: clamp(finite(rawViewport.zoom, 1), LIMITS.minZoom, LIMITS.maxZoom),
          }
        : undefined;

      // A step with nothing left to show at all — no primary, no extras, no
      // explicit view — is the only case actually dropped.
      if (!edgeId && extraEdgeIds.length === 0 && extraNodeIds.length === 0 && !viewport) {
        droppedFlowSteps += 1;
        continue;
      }

      let stepId = safeId(candidateStep.id);
      if (!stepId || seenStepIds.has(stepId)) stepId = createId('fs');
      seenStepIds.add(stepId);

      const step: DraftFlowStep = { id: stepId };
      if (edgeId) step.edgeId = edgeId;
      if (extraEdgeIds.length > 0) step.extraEdgeIds = extraEdgeIds;
      if (extraNodeIds.length > 0) step.extraNodeIds = extraNodeIds;
      if (viewport) step.viewport = viewport;
      const caption = text(candidateStep.caption, LIMITS.maxLabelLength)?.trim();
      if (caption) step.caption = caption;
      steps.push(step);
    }

    const flow: DraftFlow = { id, title, steps };
    if (flowAccent !== undefined) flow.accent = flowAccent;
    flows.push(flow);
  }

  if (droppedFlows > 0) repairs.push(`Dropped ${droppedFlows} unreadable flow(s).`);
  if (droppedFlowSteps > 0) {
    repairs.push(`Dropped ${droppedFlowSteps} flow step(s) that were unreadable or had nothing left to show.`);
  }
  if (truncatedFlowSteps > 0) {
    repairs.push(`${truncatedFlowSteps} flow(s) had too many steps; kept the first ${LIMITS.maxStepsPerFlow} of each.`);
  }

  /* ------------------------------------------------------------- actions -- */

  /*
   * Root-only, unlike flows: a room is a room, but the meeting is the file. A room carrying an
   * `actions` array is a file written by something that misunderstood the format, so it is
   * ignored rather than merged upward — silently, because there is nothing the reader could do
   * about it and nothing was lost that the root's own list didn't already hold.
   *
   * Anchors are only shape-checked here. Whether one still points at something can't be known
   * yet — the rooms it might name haven't been validated at this point — so the pruning happens
   * once the whole file is in, just below.
   */
  const actions: DraftAction[] = [];
  if (isRoot) {
    const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
    let droppedActions = 0;
    const seenActionIds = new Set<string>();
    if (rawActions.length > LIMITS.maxActions) {
      repairs.push(`Document had too many actions; kept the first ${LIMITS.maxActions}.`);
    }
    for (const candidate of rawActions.slice(0, LIMITS.maxActions)) {
      if (!isRecord(candidate)) {
        droppedActions += 1;
        continue;
      }
      // An action with nothing written in it is not an action — it is what an interrupted
      // capture leaves behind, and keeping it would put an empty row in the list forever.
      const actionText = text(candidate.text, LIMITS.maxActionLength)?.trim();
      if (!actionText) {
        droppedActions += 1;
        continue;
      }
      let id = safeId(candidate.id) ?? createId('a');
      if (seenActionIds.has(id)) id = createId('a');
      seenActionIds.add(id);

      const action: DraftAction = { id, text: actionText };
      if (candidate.done === true) action.done = true;
      const anchorRaw = isRecord(candidate.anchor) ? candidate.anchor : undefined;
      const anchorId = anchorRaw ? safeId(anchorRaw.id) : undefined;
      if (anchorId && (anchorRaw!.kind === 'node' || anchorRaw!.kind === 'edge')) {
        action.anchor = { kind: anchorRaw!.kind, id: anchorId };
      }
      actions.push(action);
    }
    if (droppedActions > 0) {
      repairs.push(`Dropped ${droppedActions} action(s) that were unreadable or had no text.`);
    }
  }

  /* ------------------------------------------------------------ document -- */

  const viewportRaw = isRecord(raw.viewport) ? raw.viewport : {};
  const settingsRaw = isRecord(raw.settings) ? raw.settings : {};
  const backgroundRaw = isRecord(settingsRaw.background) ? settingsRaw.background : {};

  const document: DraftDocument = {
    format: DRAFT_FORMAT,
    version: CURRENT_VERSION,
    metadata: {
      id: safeId(meta.id) ?? createId('d'),
      title: text(meta.title, LIMITS.maxTitleLength)?.trim() || 'Untitled canvas',
      createdAt,
      updatedAt: Math.max(createdAt, finite(meta.updatedAt, now)),
      ...(safeId(meta.projectId) ? { projectId: safeId(meta.projectId)! } : {}),
    },
    nodes,
    edges,
    viewport: {
      x: clamp(finite(viewportRaw.x, 0), -LIMITS.maxCoordinate, LIMITS.maxCoordinate),
      y: clamp(finite(viewportRaw.y, 0), -LIMITS.maxCoordinate, LIMITS.maxCoordinate),
      zoom: clamp(finite(viewportRaw.zoom, 1), LIMITS.minZoom, LIMITS.maxZoom),
    },
    settings: {
      showSequence: settingsRaw.showSequence !== false,
      grid: oneOf<GridMode>(settingsRaw.grid, GRID_MODES, 'dots'),
      background: {
        enabled: backgroundRaw.enabled === true,
        fit: oneOf<BackgroundFit>(backgroundRaw.fit, BACKGROUND_FITS, 'cover'),
        dim: clamp(finite(backgroundRaw.dim, 0.55), 0, 1),
        blur: clamp(finite(backgroundRaw.blur, 0), 0, 1),
        ...(safeId(backgroundRaw.imageId) ? { imageId: safeId(backgroundRaw.imageId)! } : {}),
      },
    },
    flows,
    actions,
    // Absent stays absent: a view with no level behaves exactly as every canvas did before
    // levels existed, and nothing here ever invents one.
    ...(() => {
      const level = oneOfOptional<ViewLevel>(raw.level, VIEW_LEVELS);
      return level === undefined ? {} : { level };
    })(),
  };

  // What this room kept comes off the file's allowance before any room inside it is looked at.
  ctx.budget.nodes -= nodes.length;
  ctx.budget.edges -= edges.length;
  ctx.budget.flows -= flows.length;
  if (isRoot) {
    drainInsides(ctx, repairs);
    // Only now does `ctx` know every id in the file, rooms included, so only now can an anchor be
    // told from a dangling one. The action itself always survives: it is the thing somebody has
    // to do, and the architecture it came from is a bonus — dropping the whole row because a
    // shape was deleted would lose the part that mattered. Same posture as a flow step that
    // outlives its connector.
    let strandedAnchors = 0;
    for (const action of document.actions) {
      if (!action.anchor) continue;
      const known = action.anchor.kind === 'node' ? ctx.nodeIds : ctx.edgeIds;
      if (known.has(action.anchor.id)) continue;
      delete action.anchor;
      strandedAnchors += 1;
    }
    if (strandedAnchors > 0) {
      repairs.push(`${strandedAnchors} action(s) pointed at something no longer here; kept the action.`);
    }
  }

  return { ok: true, document, repairs };
}
