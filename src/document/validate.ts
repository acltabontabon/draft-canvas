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
  type Accent,
  type ActorKind,
  type AttachableType,
  type Attachment,
  type BackgroundFit,
  type BoundaryPreset,
  type CodeLanguage,
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
} from './types';

export type NormalizeResult =
  | { ok: true; document: DraftDocument; repairs: string[] }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

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
export function normalizeDocument(raw: unknown, repairs: string[] = []): NormalizeResult {
  if (!isRecord(raw)) return { ok: false, error: 'That document is empty or unreadable.' };

  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  const now = Date.now();
  const createdAt = finite(meta.createdAt, now);

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];

  if (!Array.isArray(raw.nodes)) {
    repairs.push('Document had no node list; started an empty canvas.');
  }
  if (rawNodes.length > LIMITS.maxNodes) {
    repairs.push(`Document had ${rawNodes.length} nodes; kept the first ${LIMITS.maxNodes}.`);
  }
  if (rawEdges.length > LIMITS.maxEdges) {
    repairs.push(`Document had ${rawEdges.length} connections; kept the first ${LIMITS.maxEdges}.`);
  }

  /* --------------------------------------------------------------- nodes -- */

  const seenNodeIds = new Set<string>();
  const nodes: DraftNode[] = [];
  let droppedNodes = 0;
  let renamedNodes = 0;
  let droppedAttachments = 0;
  let truncatedAttachments = 0;
  let droppedEdgeAttachments = 0;
  let truncatedEdgeAttachments = 0;
  /** Maps the id as written in the file to the id we actually used. */
  const nodeIdRemap = new Map<string, string>();

  for (const candidate of rawNodes.slice(0, LIMITS.maxNodes)) {
    if (!isRecord(candidate)) {
      droppedNodes += 1;
      continue;
    }
    const originalId = typeof candidate.id === 'string' ? candidate.id : null;
    let id = safeId(candidate.id);
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
      width: clamp(
        finite(candidate.width, fallbackSize.width),
        LIMITS.minNodeSize,
        LIMITS.maxNodeSize,
      ),
      height: clamp(
        finite(candidate.height, fallbackSize.height),
        LIMITS.minNodeSize,
        LIMITS.maxNodeSize,
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

    const rawAttachments = Array.isArray(candidate.attachments) ? candidate.attachments : [];
    if (rawAttachments.length > LIMITS.maxAttachmentsPerNode) {
      truncatedAttachments += rawAttachments.length - LIMITS.maxAttachmentsPerNode;
    }
    if (rawAttachments.length > 0) {
      const attachments: Attachment[] = [];
      const seenAttachmentIds = new Set<string>();
      for (const rawAttachment of rawAttachments.slice(0, LIMITS.maxAttachmentsPerNode)) {
        if (!isRecord(rawAttachment)) {
          droppedAttachments += 1;
          continue;
        }
        let attachmentId = safeId(rawAttachment.id);
        if (!attachmentId || seenAttachmentIds.has(attachmentId)) attachmentId = createId('a');
        seenAttachmentIds.add(attachmentId);

        const attachmentType = oneOf<AttachableType>(rawAttachment.type, ATTACHABLE_TYPES, 'note');
        const attachment: Attachment = { id: attachmentId, type: attachmentType };

        const attachmentLabel = text(rawAttachment.text, LIMITS.maxTextLength);
        if (attachmentLabel !== undefined) attachment.text = attachmentLabel;

        const attachmentAccent = oneOfOptional<Accent>(rawAttachment.accent, ACCENTS);
        if (attachmentAccent !== undefined) attachment.accent = attachmentAccent;

        Object.assign(attachment, validateAttachableFields(rawAttachment, attachmentType));

        const width = finite(rawAttachment.width, Number.NaN);
        const height = finite(rawAttachment.height, Number.NaN);
        if (Number.isFinite(width) && Number.isFinite(height)) {
          attachment.width = clamp(width, LIMITS.minNodeSize, LIMITS.maxNodeSize);
          attachment.height = clamp(height, LIMITS.minNodeSize, LIMITS.maxNodeSize);
        }

        attachments.push(attachment);
      }
      if (attachments.length > 0) node.attachments = attachments;
    }

    nodes.push(node);
  }

  // Second pass: resolve parents, dropping dangling, self- and cyclic links.
  let droppedParents = 0;
  for (const node of nodes) {
    if (!node.parentId) continue;
    const mapped = nodeIdRemap.get(node.parentId);
    if (!mapped || mapped === node.id) {
      delete node.parentId;
      droppedParents += 1;
      continue;
    }
    node.parentId = mapped;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (!node.parentId) continue;
    const visited = new Set<string>([node.id]);
    let cursor = byId.get(node.parentId);
    while (cursor) {
      if (visited.has(cursor.id)) {
        delete node.parentId;
        droppedParents += 1;
        break;
      }
      visited.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  /* --------------------------------------------------------------- edges -- */

  const seenEdgeIds = new Set<string>();
  const edges: DraftEdge[] = [];
  let droppedEdges = 0;
  let droppedSelfLoopEdges = 0;
  /** Maps the edge id as written in the file to the id we actually used — flows resolve through this. */
  const edgeIdRemap = new Map<string, string>();

  for (const candidate of rawEdges.slice(0, LIMITS.maxEdges)) {
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

    // Same repair discipline as a node's own `attachments` above — this is
    // the identical `Attachment` shape, just hosted on a connector instead.
    const rawEdgeAttachments = Array.isArray(candidate.attachments) ? candidate.attachments : [];
    if (rawEdgeAttachments.length > LIMITS.maxAttachmentsPerEdge) {
      truncatedEdgeAttachments += rawEdgeAttachments.length - LIMITS.maxAttachmentsPerEdge;
    }
    if (rawEdgeAttachments.length > 0) {
      const attachments: Attachment[] = [];
      const seenEdgeAttachmentIds = new Set<string>();
      for (const rawAttachment of rawEdgeAttachments.slice(0, LIMITS.maxAttachmentsPerEdge)) {
        if (!isRecord(rawAttachment)) {
          droppedEdgeAttachments += 1;
          continue;
        }
        let attachmentId = safeId(rawAttachment.id);
        if (!attachmentId || seenEdgeAttachmentIds.has(attachmentId)) attachmentId = createId('a');
        seenEdgeAttachmentIds.add(attachmentId);

        const attachmentType = oneOf<AttachableType>(rawAttachment.type, ATTACHABLE_TYPES, 'note');
        const attachment: Attachment = { id: attachmentId, type: attachmentType };

        const attachmentLabel = text(rawAttachment.text, LIMITS.maxTextLength);
        if (attachmentLabel !== undefined) attachment.text = attachmentLabel;

        const attachmentAccent = oneOfOptional<Accent>(rawAttachment.accent, ACCENTS);
        if (attachmentAccent !== undefined) attachment.accent = attachmentAccent;

        Object.assign(attachment, validateAttachableFields(rawAttachment, attachmentType));

        attachments.push(attachment);
      }
      if (attachments.length > 0) edge.attachments = attachments;
    }

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
  if (droppedEdges > 0) {
    repairs.push(`Dropped ${droppedEdges} connection(s) pointing at nodes that do not exist.`);
  }
  if (droppedSelfLoopEdges > 0) {
    repairs.push(`Dropped ${droppedSelfLoopEdges} connection(s) that pointed a node at itself.`);
  }
  if (droppedEdgeAttachments > 0) {
    repairs.push(`Dropped ${droppedEdgeAttachments} unreadable connection attachment(s).`);
  }
  if (truncatedEdgeAttachments > 0) {
    repairs.push(`A connection had too many attachments; kept the first ${LIMITS.maxAttachmentsPerEdge}.`);
  }

  /* --------------------------------------------------------------- flows -- */

  const rawFlows = Array.isArray(raw.flows) ? raw.flows : [];
  const flows: DraftFlow[] = [];
  let droppedFlows = 0;
  let droppedFlowSteps = 0;
  const seenFlowIds = new Set<string>();

  for (const candidateFlow of rawFlows.slice(0, LIMITS.maxFlows)) {
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
    repairs.push(`Dropped ${droppedFlowSteps} flow step(s) referencing a missing connection.`);
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
      },
    },
    flows,
  };

  return { ok: true, document, repairs };
}
