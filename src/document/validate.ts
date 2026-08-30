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
  ATTACHABLE_TYPES,
  BOUNDARY_PRESETS,
  CODE_LANGUAGES,
  CURRENT_VERSION,
  DATABASE_KINDS,
  DRAFT_FORMAT,
  EDGE_ROUTINGS,
  GRID_MODES,
  NODE_TYPES,
  NOTE_KINDS,
  EDGE_SEMANTICS,
  QUEUE_KINDS,
  SERVICE_KINDS,
  type Accent,
  type AttachableType,
  type Attachment,
  type BoundaryPreset,
  type CodeLanguage,
  type DatabaseKind,
  type DraftDocument,
  type DraftEdge,
  type DraftFlow,
  type DraftFlowStep,
  type DraftNode,
  type DraftNodeType,
  type EdgeRouting,
  type EdgeSemantic,
  type GridMode,
  type NoteKind,
  type QueueKind,
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

    const type = oneOf<DraftNodeType>(candidate.type, NODE_TYPES, 'card');
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

  /* --------------------------------------------------------------- flows -- */

  const rawFlows = Array.isArray(raw.flows) ? raw.flows : [];
  const flows: DraftFlow[] = [];
  let droppedFlows = 0;
  let droppedFlowSteps = 0;

  for (const candidateFlow of rawFlows.slice(0, LIMITS.maxFlows)) {
    if (!isRecord(candidateFlow)) {
      droppedFlows += 1;
      continue;
    }
    const id = safeId(candidateFlow.id) ?? createId('f');
    const title = text(candidateFlow.title, LIMITS.maxFlowTitleLength)?.trim() || 'Untitled flow';
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
      const edgeId = rawEdgeId ? edgeIdRemap.get(rawEdgeId) : undefined;
      // A step whose connector was dropped, or that duplicates one already in
      // this flow, is silently repaired away rather than kept dangling.
      if (!edgeId || seenStepEdgeIds.has(edgeId)) {
        droppedFlowSteps += 1;
        continue;
      }
      seenStepEdgeIds.add(edgeId);

      let stepId = safeId(candidateStep.id);
      if (!stepId || seenStepIds.has(stepId)) stepId = createId('fs');
      seenStepIds.add(stepId);

      const step: DraftFlowStep = { id: stepId, edgeId };
      const caption = text(candidateStep.caption, LIMITS.maxLabelLength)?.trim();
      if (caption) step.caption = caption;
      steps.push(step);
    }

    flows.push({ id, title, steps });
  }

  if (droppedFlows > 0) repairs.push(`Dropped ${droppedFlows} unreadable flow(s).`);
  if (droppedFlowSteps > 0) {
    repairs.push(`Dropped ${droppedFlowSteps} flow step(s) referencing a missing connection.`);
  }

  /* ------------------------------------------------------------ document -- */

  const viewportRaw = isRecord(raw.viewport) ? raw.viewport : {};
  const settingsRaw = isRecord(raw.settings) ? raw.settings : {};

  const document: DraftDocument = {
    format: DRAFT_FORMAT,
    version: CURRENT_VERSION,
    metadata: {
      id: safeId(meta.id) ?? createId('d'),
      title: text(meta.title, LIMITS.maxTitleLength)?.trim() || 'Untitled canvas',
      createdAt,
      updatedAt: Math.max(createdAt, finite(meta.updatedAt, now)),
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
    },
    flows,
  };

  return { ok: true, document, repairs };
}
