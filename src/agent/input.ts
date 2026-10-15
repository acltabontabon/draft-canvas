/**
 * Reading an agent's request: every field checked, every reference resolved, every bound enforced —
 * before anything is laid out or changed. What comes back is typed and trustworthy; what doesn't is
 * refused with the JSON path of each problem, so a single correction round fixes all of them.
 *
 * Permissive about architecture, strict about structure. An unusual pairing (a queue feeding a topic,
 * a component at context level) is the person's call and at most an advisory later on. A reference to
 * nothing, a containment cycle, an unknown type or text past its limit is refused here.
 */

import {
  ACCENTS,
  CODE_LANGUAGES,
  CONNECTOR_KINDS,
  EDGE_SEMANTICS,
  type Accent,
  type AttachableType,
  type CodeLanguage,
  type ConnectorKind,
  type EdgeSemantic,
  type NoteKind,
  type OpenPointKind,
  OPEN_POINT_KINDS,
  type ViewLevel,
} from '../document/types';
import { LIMITS } from '../document/limits';
import { STARTER_IDS, type StarterId } from '../starters/types';
import { AgentError, Problems } from './errors';
import { starterFor, starterIds } from './starter';
import { isEvidence, EVIDENCE_LIMIT } from '../document/evidence';
import type { SourceEvidence } from '../document/types';
import { ROOM_FIELDS } from './fields';
import { GROUP_KINDS, LINE_STYLE_NAMES, NOTE_FORM_NAMES, NOTE_KIND_NAMES, resolveType, suggestTypes, type LineStyleName, type NativeShape } from './vocabulary';

/** What one request may carry. Published through `get_capabilities` and the tool schemas. */
export const AGENT_LIMITS = {
  nodesPerRequest: 300,
  relationshipsPerRequest: 600,
  groupsPerRequest: 60,
  flowsPerRequest: 20,
  stepsPerFlow: 60,
  notesPerRequest: 60,
  openPointsPerRequest: 50,
  openPointContextLength: LIMITS.maxOpenPointContextLength,
  openPointTargets: LIMITS.maxOpenPointTargets,
  opsPerRequest: 100,
  attachmentsPerElement: 4,
  idLength: 64,
  labelLength: 120,
  descriptionLength: LIMITS.maxDescriptionLength,
  technologyLength: LIMITS.maxTechnologyLength,
  relationshipLabelLength: 80,
  groupLabelLength: 80,
  noteLength: 1_000,
  codeLength: 4_000,
  flowTitleLength: LIMITS.maxFlowTitleLength,
  captionLength: 120,
  /** Extra elements, and extra relationships, one flow step may light (each, not together). */
  highlightsPerStep: LIMITS.maxExtraMembersPerStep,
  responseLength: LIMITS.maxResponseLength,
  /** `deliveryAttempts` is a whole number in this range — the inspector's own stepper bounds. */
  deliveryAttempts: { min: 1, max: 50 },
  insideDepth: LIMITS.maxInsideDepth,
} as const;

/** New ids an agent chooses. Existing ids — including the editor's own `n_…` ones — are addressed as they are. */
export const NEW_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface AttachmentSpec {
  kind: 'note' | 'code';
  text?: string;
  noteKind?: NoteKind;
  language?: CodeLanguage;
  code?: string;
}

export interface NodeSpec {
  evidence?: SourceEvidence[];
  id: string;
  typeWord: string;
  shape: NativeShape;
  label: string;
  description?: string;
  technology?: string;
  group?: string;
  color?: Accent;
  attachments?: AttachmentSpec[];
  inside?: RoomSpec;
}

export interface RelationshipSpec {
  evidence?: SourceEvidence[];
  id: string;
  from: string;
  to: string;
  label?: string;
  semantic?: EdgeSemantic;
  kind?: ConnectorKind;
  directed?: boolean;
  async?: boolean;
  condition?: string;
  color?: Accent;
  lineStyle?: LineStyleName;
  /** The reply line of a synchronous call: `true` draws it unlabelled, a string labels it. */
  response?: string | true;
  deliveryAttempts?: number;
  attachments?: AttachmentSpec[];
}

export interface GroupSpec {
  id: string;
  label: string;
  kind: keyof typeof GROUP_KINDS;
  parent?: string;
}

export interface FlowSpec {
  id: string;
  title: string;
  color?: Accent;
  /** The flow this is a named alternative telling of (e.g. a failure path) — see `setFlowVariantOf`
   *  for the hub-and-spoke rule this must still pass once the whole room has been read. */
  variantOf?: string;
  steps: StepSpec[];
}

/**
 * One step of a new flow. A relationship step plays that connector and may light more with it
 * (`extraNodeIds`/`extraEdgeIds`, the Flows panel's "+ Selection"). A spotlight step has no
 * relationship: it lights just its extras — an overview, a boundary, a starting state — and the
 * presentation frames them, as it does any step whose connector is gone.
 */
export interface StepSpec {
  relationship?: string;
  caption?: string;
  extraNodeIds?: string[];
  extraEdgeIds?: string[];
}

/**
 * A note, and how it relates to the diagram — kept to what the document model can actually hold:
 * - `attachTo`: a native attachment (the chip on an element or connector) — it moves, exports and is
 *   removed with its host;
 * - `group`: a member of a boundary, placed inside it (the boundary grows to hold it);
 * - `near`: placed beside an element — placement only; nothing records the link afterwards.
 */
export interface NoteSpec {
  id: string;
  /** The card it is in the editor: a note, a code snippet (`code` + `language`) or a Text label. */
  type: AttachableType;
  /** A note's or a label's words; empty for a code snippet. */
  text: string;
  /** Note kind; `note` for a snippet or a label, which have none. */
  kind: NoteKind;
  code?: string;
  language?: CodeLanguage;
  near?: string;
  group?: string;
  attachTo?: { kind: 'node' | 'edge'; id: string };
}

/** An open point an agent raises: its kind, what it is about (one or more ids), and optional context. */
export interface OpenPointSpec {
  id?: string;
  kind: OpenPointKind;
  context?: string;
  about: string[];
}

export interface RoomSpec {
  level?: Exclude<ViewLevel, 'none'>;
  nodes: NodeSpec[];
  relationships: RelationshipSpec[];
  groups: GroupSpec[];
  flows: FlowSpec[];
  notes: NoteSpec[];
}

export interface LayoutSpec {
  direction: 'right' | 'down';
  /** The caller named the direction — a repair never overrides it. */
  directionChosen?: boolean;
  spacing: 'compact' | 'comfortable' | 'spacious';
  primaryFlow?: string;
  allowDegraded: boolean;
  /**
   * Keep peer shapes (same type, sub-kind and parent) a uniform size. Left `undefined` when the
   * caller didn't say — each call site resolves its own default: a new diagram or a newly-added
   * block has nothing manual to preserve (default on); an existing diagram being re-arranged keeps
   * whatever sizes it already has unless normalization is explicitly requested (default off). See
   * `peerNormalize` (`agent/place.ts`).
   */
  normalizePeerSizes?: boolean;
  /** The intended presentation frame, `[width, height]` px — see `agent/quality.ts`'s `FitReport`. */
  viewport?: [number, number];
  /** Internal to repair (never read from a request): see `LayoutInput.ties`. */
  ties?: 'align' | 'balance';
  /** Internal (never read from a request): `unlabelled` keeps labelled connectors off shared trunks —
   *  the arrangement compared against one with them (see `AnchorOptions.fans`). */
  fans?: 'all' | 'unlabelled';
}

export interface StarterSpec {
  id: StarterId;
  prefix: string;
  overrides: Record<string, { label?: string; description?: string; technology?: string }>;
}

export interface CreateSpec extends RoomSpec {
  title: string;
  starter?: StarterSpec;
  layout: LayoutSpec;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Field readers that record a problem and return `undefined` rather than throwing, so one pass
 *  finds everything wrong with a request. */
export class Reader {
  readonly problems: Problems;

  constructor(problems: Problems) {
    this.problems = problems;
  }

  fields(value: Json, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.problems.add('INVALID_INPUT', `${path}/${key}`, 'unknown or unsupported field');
  }

  object(value: unknown, path: string, allowed?: readonly string[]): Json | undefined {
    if (isObject(value)) {
      if (allowed) this.fields(value, path, allowed);
      return value;
    }
    this.problems.add('INVALID_INPUT', path, 'must be an object');
    return undefined;
  }

  array(value: unknown, path: string, max: number): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.problems.add('INVALID_INPUT', path, 'must be an array');
      return [];
    }
    if (value.length > max) {
      this.problems.add('LIMIT_EXCEEDED', path, `at most ${max} items (got ${value.length}); split the work into several requests`);
      return value.slice(0, max);
    }
    return value;
  }

  text(value: unknown, path: string, max: number, options: { required?: boolean; singleLine?: boolean; code?: boolean } = {}): string | undefined {
    if (value === undefined || value === null) {
      if (options.required) this.problems.add('INVALID_INPUT', path, 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      this.problems.add('INVALID_INPUT', path, 'must be a string');
      return undefined;
    }
    // Control characters never reach a document (the importer would strip them anyway).
    // oxlint-disable-next-line no-control-regex -- matching them is the point
    let text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (options.singleLine) text = text.replace(/\s+/g, ' ');
    // Code keeps its first line's indentation: only blank lines before it and whitespace after go.
    text = options.code ? text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd() : text.trim();
    if (!text) {
      if (options.required) this.problems.add('INVALID_INPUT', path, 'must not be empty');
      return undefined;
    }
    if ([...text].length > max) {
      this.problems.add('LIMIT_EXCEEDED', path, `at most ${max} characters (got ${[...text].length}); keep long explanations in a note`);
      return undefined;
    }
    return text;
  }

  bool(value: unknown, path: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    this.problems.add('INVALID_INPUT', path, 'must be true or false');
    return undefined;
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    this.problems.add('INVALID_INPUT', path, `must be one of: ${allowed.join(', ')}`);
    return undefined;
  }

  newId(value: unknown, path: string, taken: Set<string>): string | undefined {
    if (typeof value !== 'string' || !NEW_ID.test(value)) {
      this.problems.add('INVALID_INPUT', path, 'must be an id: a letter, then letters, digits, "_", "." or "-" (at most 64)');
      return undefined;
    }
    if (taken.has(value)) {
      this.problems.add('DUPLICATE_ID', path, `id "${value}" is already used in this diagram or request`, { id: value });
      return undefined;
    }
    taken.add(value);
    return value;
  }
}

export function readEvidence(r: Reader, value: unknown, path: string): SourceEvidence[] | undefined {
  if (value === undefined) return undefined;
  const entries = r.array(value, path, EVIDENCE_LIMIT);
  for (const [index, entry] of entries.entries()) if (!isEvidence(entry)) r.problems.add('INVALID_INPUT', `${path}/${index}`, 'must be a relative source path, observed/inferred basis and bounded optional symbol, commit, line and explanation');
  return entries.filter(isEvidence).map((entry) => ({ ...entry }));
}

function readAttachments(r: Reader, value: unknown, path: string): AttachmentSpec[] | undefined {
  const items = r.array(value, path, AGENT_LIMITS.attachmentsPerElement);
  if (items.length === 0) return undefined;
  const out: AttachmentSpec[] = [];
  items.forEach((raw, i) => {
    const at = `${path}/${i}`;
    const item = r.object(raw, at, ['kind', 'text', 'noteKind', 'language', 'code']);
    if (!item) return;
    const kind = r.oneOf(item.kind, `${at}/kind`, ['note', 'code'] as const) ?? 'note';
    if (kind === 'code') {
      const code = r.text(item.code, `${at}/code`, AGENT_LIMITS.codeLength, { required: true, code: true });
      const language = r.oneOf(item.language, `${at}/language`, CODE_LANGUAGES) ?? 'plaintext';
      if (code !== undefined) out.push({ kind, code, language });
    } else {
      const text = r.text(item.text, `${at}/text`, AGENT_LIMITS.noteLength, { required: true });
      const noteKind = r.oneOf(item.noteKind, `${at}/noteKind`, NOTE_KIND_NAMES);
      if (text !== undefined) out.push({ kind, text, ...(noteKind ? { noteKind } : {}) });
    }
  });
  return out;
}

export interface RoomContext {
  /** Every id already in use in the file, and every one this request has claimed so far. */
  taken: Set<string>;
  /** Elements, groups and relationships already in the room being edited (updates only), and its
   *  flows (each with the flow it is a variant of, if any). */
  existing?: { elements: Set<string>; groups: Set<string>; relationships: Set<string>; flows?: ReadonlyMap<string, string | undefined> };
  depth: number;
  fallbackType?: NativeShape;
}

/** Reads a room: its elements, relationships, groups, flows and notes. References are resolved
 *  within the room (plus, for an update, what the room already holds). */
export function readRoom(r: Reader, raw: Json, path: string, ctx: RoomContext): RoomSpec {
  const level = r.oneOf(raw.level, `${path}/level`, ['context', 'container', 'component'] as const);
  const groups: GroupSpec[] = [];
  r.array(raw.groups, `${path}/groups`, AGENT_LIMITS.groupsPerRequest).forEach((g, i) => {
    const at = `${path}/groups/${i}`;
    const item = r.object(g, at, ['id', 'label', 'kind', 'parent']);
    if (!item) return;
    const id = r.newId(item.id, `${at}/id`, ctx.taken);
    const label = r.text(item.label, `${at}/label`, AGENT_LIMITS.groupLabelLength, { required: true, singleLine: true });
    const kind = r.oneOf(item.kind, `${at}/kind`, Object.keys(GROUP_KINDS) as (keyof typeof GROUP_KINDS)[]) ?? 'boundary';
    const parent = typeof item.parent === 'string' ? item.parent : undefined;
    if (item.parent !== undefined && parent === undefined) r.problems.add('INVALID_INPUT', `${at}/parent`, 'must be a group id');
    if (id && label) groups.push({ id, label, kind, ...(parent ? { parent } : {}) });
  });
  const groupIds = new Set([...groups.map((g) => g.id), ...(ctx.existing?.groups ?? [])]);
  groups.forEach((g, i) => {
    if (g.parent !== undefined && !groupIds.has(g.parent)) {
      r.problems.add('INVALID_REFERENCE', `${path}/groups/${i}/parent`, `no group "${g.parent}" in this view`);
    }
  });
  // Containment must be a tree.
  const parentOf = new Map(groups.map((g) => [g.id, g.parent]));
  for (const g of groups) {
    const seen = new Set<string>();
    let at: string | undefined = g.id;
    while (at !== undefined && parentOf.has(at)) {
      if (seen.has(at)) {
        r.problems.add('CONTAINMENT_CYCLE', `${path}/groups`, `groups nest in a cycle through "${g.id}"`);
        break;
      }
      seen.add(at);
      at = parentOf.get(at);
    }
  }

  const nodes: NodeSpec[] = [];
  r.array(raw.nodes, `${path}/nodes`, AGENT_LIMITS.nodesPerRequest).forEach((n, i) => {
    const at = `${path}/nodes/${i}`;
    const item = r.object(n, at, ['id', 'type', 'label', 'description', 'technology', 'group', 'color', 'attachments', 'inside', 'evidence']);
    if (!item) return;
    const id = r.newId(item.id, `${at}/id`, ctx.taken);
    const typeWord = typeof item.type === 'string' ? item.type : '';
    let shape = typeWord ? resolveType(typeWord) : undefined;
    if (!shape) {
      if (ctx.fallbackType && typeWord) shape = ctx.fallbackType;
      else {
        const suggestions = typeWord ? suggestTypes(typeWord) : [];
        r.problems.add(
          'UNSUPPORTED_TYPE',
          `${at}/type`,
          typeWord
            ? `unknown type "${typeWord}"${suggestions.length ? ` — did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ''} (get_capabilities lists every type)`
            : 'is required',
        );
      }
    }
    const label = r.text(item.label, `${at}/label`, AGENT_LIMITS.labelLength, { required: true });
    const description = r.text(item.description, `${at}/description`, AGENT_LIMITS.descriptionLength);
    const technology = r.text(item.technology, `${at}/technology`, AGENT_LIMITS.technologyLength, { singleLine: true });
    const color = r.oneOf(item.color, `${at}/color`, ACCENTS);
    const group = typeof item.group === 'string' ? item.group : undefined;
    if (group !== undefined && !groupIds.has(group)) r.problems.add('INVALID_REFERENCE', `${at}/group`, `no group "${group}" in this view`);
    const evidence = readEvidence(r, item.evidence, `${at}/evidence`);
    const attachments = readAttachments(r, item.attachments, `${at}/attachments`);
    let inside: RoomSpec | undefined;
    if (item.inside !== undefined) {
      const insideAt = `${at}/inside`;
      const insideRaw = r.object(item.inside, insideAt, ROOM_FIELDS);
      const canHold = shape && (shape.type === 'service' || (shape.type === 'component' && shape.componentKind !== 'port'));
      if (insideRaw && !canHold) {
        r.problems.add('UNSUPPORTED', insideAt, 'only a service-like element or a (non-port) component can have an inside view');
      } else if (insideRaw && ctx.depth + 1 > AGENT_LIMITS.insideDepth) {
        r.problems.add('LIMIT_EXCEEDED', insideAt, `inside views nest at most ${AGENT_LIMITS.insideDepth} deep`);
      } else if (insideRaw) {
        inside = readRoom(r, insideRaw, insideAt, { taken: ctx.taken, depth: ctx.depth + 1, fallbackType: ctx.fallbackType });
        if (inside.nodes.length === 0) {
          r.problems.add('INVALID_INPUT', `${insideAt}/nodes`, 'an inside view needs at least one element');
          inside = undefined;
        }
      }
    }
    if (id && shape && label) {
      nodes.push({
        id,
        typeWord,
        shape,
        label,
        ...(description ? { description } : {}),
        ...(technology ? { technology } : {}),
        ...(group ? { group } : {}),
        ...(color ? { color } : {}),
        ...(attachments ? { attachments } : {}),
        ...(evidence?.length ? { evidence } : {}),
        ...(inside ? { inside } : {}),
      });
    }
  });

  const elementIds = new Set([...nodes.map((n) => n.id), ...(ctx.existing?.elements ?? [])]);
  const relationships: RelationshipSpec[] = [];
  const pairs = new Map<string, RelationshipSpec[]>();
  r.array(raw.relationships, `${path}/relationships`, AGENT_LIMITS.relationshipsPerRequest).forEach((e, i) => {
    const at = `${path}/relationships/${i}`;
    const item = r.object(e, at, ['id', 'from', 'to', 'label', 'semantic', 'kind', 'directed', 'async', 'condition', 'color', 'lineStyle', 'response', 'deliveryAttempts', 'attachments', 'evidence']);
    if (!item) return;
    const id = r.newId(item.id, `${at}/id`, ctx.taken);
    const from = typeof item.from === 'string' ? item.from : undefined;
    const to = typeof item.to === 'string' ? item.to : undefined;
    if (!from || !elementIds.has(from)) r.problems.add('INVALID_REFERENCE', `${at}/from`, from ? `no element "${from}" in this view` : 'is required');
    if (!to || !elementIds.has(to)) r.problems.add('INVALID_REFERENCE', `${at}/to`, to ? `no element "${to}" in this view` : 'is required');
    if (from && from === to) r.problems.add('UNSUPPORTED', at, 'a relationship from an element to itself is not supported; describe the loop in the label of a note instead');
    const label = r.text(item.label, `${at}/label`, AGENT_LIMITS.relationshipLabelLength, { singleLine: true });
    const semantic = r.oneOf(item.semantic, `${at}/semantic`, EDGE_SEMANTICS);
    const kind = r.oneOf(item.kind, `${at}/kind`, CONNECTOR_KINDS);
    const directed = r.bool(item.directed, `${at}/directed`);
    const async = r.bool(item.async, `${at}/async`);
    const condition = r.text(item.condition, `${at}/condition`, LIMITS.maxConditionLength, { singleLine: true });
    const color = r.oneOf(item.color, `${at}/color`, ACCENTS);
    const lineStyle = r.oneOf(item.lineStyle, `${at}/lineStyle`, LINE_STYLE_NAMES);
    const response = readResponse(r, item.response, `${at}/response`);
    const deliveryAttempts = readDeliveryAttempts(r, item.deliveryAttempts, `${at}/deliveryAttempts`);
    const evidence = readEvidence(r, item.evidence, `${at}/evidence`);
    const attachments = readAttachments(r, item.attachments, `${at}/attachments`);
    if (!id || !from || !to || from === to || !elementIds.has(from) || !elementIds.has(to)) return;
    const spec: RelationshipSpec = {
      id,
      from,
      to,
      ...(label ? { label } : {}),
      ...(semantic ? { semantic } : {}),
      ...(kind ? { kind } : {}),
      ...(directed !== undefined ? { directed } : {}),
      ...(async !== undefined ? { async } : {}),
      ...(condition ? { condition } : {}),
      ...(color ? { color } : {}),
      ...(lineStyle ? { lineStyle } : {}),
      ...(response !== undefined && response !== null ? { response } : {}),
      ...(deliveryAttempts !== undefined && deliveryAttempts !== null ? { deliveryAttempts } : {}),
      ...(attachments ? { attachments } : {}),
      ...(evidence?.length ? { evidence } : {}),
    };
    const key = `${from}\u0000${to}`;
    const same = pairs.get(key) ?? [];
    // The editor's own rule (`connect`): one connector per direction between two shapes, plus a
    // compensation twin. Two connectors the same way would draw on top of each other.
    if (same.length >= 2 || (same.length === 1 && spec.semantic !== 'compensates' && same[0]?.semantic !== 'compensates')) {
      r.problems.add('UNSUPPORTED', at, `a second relationship from "${from}" to "${to}" is only allowed as a compensation (semantic "compensates"); merge the labels, or draw the reverse direction`);
      return;
    }
    same.push(spec);
    pairs.set(key, same);
    relationships.push(spec);
  });

  const relationshipIds = new Set([...relationships.map((e) => e.id), ...(ctx.existing?.relationships ?? [])]);
  // What a step may light beyond its own relationship: elements and boundaries, and relationships.
  const lightable = { nodeIds: new Set([...elementIds, ...groupIds]), relationshipIds };
  const flows: FlowSpec[] = [];
  r.array(raw.flows, `${path}/flows`, AGENT_LIMITS.flowsPerRequest).forEach((f, i) => {
    const at = `${path}/flows/${i}`;
    const item = r.object(f, at, ['id', 'title', 'color', 'variantOf', 'steps']);
    if (!item) return;
    const flow = readFlow(r, item, at, ctx.taken, lightable);
    if (flow) flows.push(flow);
  });
  // A variant must name a flow that exists — here or already in the view. Which of two conflicting
  // links in one batch survives is left to `setFlowVariantOf`'s hub-and-spoke rule, applied in order.
  const flowIds = new Set([...flows.map((f) => f.id), ...(ctx.existing?.flows?.keys() ?? [])]);
  flows.forEach((f, i) => {
    if (f.variantOf !== undefined && (f.variantOf === f.id || !flowIds.has(f.variantOf))) {
      r.problems.add('INVALID_REFERENCE', `${path}/flows/${i}/variantOf`, `no other flow "${f.variantOf}" in this view`);
    }
  });

  const notes: NoteSpec[] = [];
  r.array(raw.notes, `${path}/notes`, AGENT_LIMITS.notesPerRequest).forEach((n, i) => {
    const at = `${path}/notes/${i}`;
    const item = r.object(n, at, ['id', 'text', 'kind', 'code', 'language', 'about', 'near', 'attach']);
    if (!item) return;
    const id = r.newId(item.id, `${at}/id`, ctx.taken);
    const body = readNoteBody(r, item, at);
    const relation = readNoteRelation(r, item, at, { elementIds, groupIds, relationshipIds }, body?.type ?? 'note');
    if (id && body && relation) notes.push({ id, ...body, ...relation });
  });

  return { ...(level ? { level } : {}), nodes, relationships, groups, flows, notes };
}

/**
 * What a note is (`kind`): one of the note kinds with its `text`, a code snippet (`code` and an
 * optional `language`, shown as code and never run) or a plain label (`text`). `undefined` when the
 * request is wrong (a problem is recorded).
 */
export function readNoteBody(r: Reader, item: Json, at: string): Pick<NoteSpec, 'type' | 'text' | 'kind' | 'code' | 'language'> | undefined {
  const form = r.oneOf(item.kind, `${at}/kind`, NOTE_FORM_NAMES) ?? 'note';
  if (form === 'code') {
    if (item.text !== undefined) r.problems.add('INVALID_INPUT', `${at}/text`, 'a code snippet has code, not text; say what it shows in a note beside it');
    const code = r.text(item.code, `${at}/code`, AGENT_LIMITS.codeLength, { required: true, code: true });
    const language = r.oneOf(item.language, `${at}/language`, CODE_LANGUAGES) ?? 'plaintext';
    return code === undefined || item.text !== undefined ? undefined : { type: 'code', text: '', kind: 'note', code, language };
  }
  for (const field of ['code', 'language'] as const) {
    if (item[field] !== undefined) r.problems.add('INVALID_INPUT', `${at}/${field}`, 'only a note of kind "code" has code');
  }
  const text = r.text(item.text, `${at}/text`, AGENT_LIMITS.noteLength, { required: true });
  if (text === undefined || item.code !== undefined || item.language !== undefined) return undefined;
  return form === 'label' ? { type: 'text', text, kind: 'note' } : { type: 'note', text, kind: form };
}

/**
 * What a note is about (`about`, or the older `near`) and whether it is attached (`attach`), as the
 * model can hold it: attached to an element, relationship or boundary, a member of a group, or placed
 * beside an element. A note about an element attaches unless `attach: false` asks for it beside —
 * attached, the link is stored and the note moves, exports and goes with its host; beside, only its
 * position says what it is about. A relationship has no "beside", so a note about one is always
 * attached. A note about a boundary heads it as a member, unless `attach: true` folds it onto the
 * boundary as a chip — the boundary's own Add Note / Add Code. Labels follow the editor's drag rule:
 * they fold onto elements only. `undefined` when the request is wrong (a problem is recorded).
 */
export function readNoteRelation(
  r: Reader,
  item: Json,
  at: string,
  known: { elementIds: ReadonlySet<string>; groupIds: ReadonlySet<string>; relationshipIds: ReadonlySet<string> },
  type: AttachableType = 'note',
): Pick<NoteSpec, 'near' | 'group' | 'attachTo'> | undefined {
  const field = item.about !== undefined ? 'about' : 'near';
  const about = typeof item[field] === 'string' ? (item[field] as string) : undefined;
  if (item[field] !== undefined && about === undefined) {
    r.problems.add('INVALID_INPUT', `${at}/${field}`, 'must be the id of an element, group or relationship');
    return undefined;
  }
  const attach = r.bool(item.attach, `${at}/attach`);
  if (about === undefined) {
    if (attach) r.problems.add('INVALID_INPUT', `${at}/attach`, 'needs about: the element, relationship or boundary to attach it to');
    return attach ? undefined : {};
  }
  if (known.relationshipIds.has(about)) {
    if (type === 'text') {
      r.problems.add('UNSUPPORTED', `${at}/about`, `a label can't attach to a relationship; put the words in the relationship's label, or make this a note`);
      return undefined;
    }
    return { attachTo: { kind: 'edge', id: about } };
  }
  if (known.groupIds.has(about)) {
    if (!attach) return { group: about };
    if (type === 'text') {
      r.problems.add('UNSUPPORTED', `${at}/attach`, `a label can't attach to a boundary; leave attach out to place it inside "${about}"`);
      return undefined;
    }
    return { attachTo: { kind: 'node', id: about } };
  }
  if (known.elementIds.has(about)) return attach === false ? { near: about } : { attachTo: { kind: 'node', id: about } };
  r.problems.add('INVALID_REFERENCE', `${at}/${field}`, `no element, group or relationship "${about}" in this view`);
  return undefined;
}

/** What a flow step may light, by id: elements and boundaries (`nodeIds`), and relationships. */
export interface Lightable {
  nodeIds: ReadonlySet<string>;
  relationshipIds: ReadonlySet<string>;
}

/**
 * A step's extra highlights (`highlight` on a relationship step, `spotlight` on a spotlight step):
 * one list of ids, split into the extra elements and the extra relationships the step lights.
 * Repeats are folded; the step's own relationship is refused (it is lit already).
 */
export function readHighlight(r: Reader, value: unknown, at: string, known: Lightable, own?: string): { nodes: string[]; edges: string[] } | undefined {
  if (!Array.isArray(value)) {
    r.problems.add('INVALID_INPUT', at, 'must be a list of element, boundary or relationship ids');
    return undefined;
  }
  const nodes: string[] = [];
  const edges: string[] = [];
  let ok = true;
  value.forEach((id, k) => {
    if (typeof id !== 'string') {
      r.problems.add('INVALID_INPUT', `${at}/${k}`, 'must be an id');
      ok = false;
    } else if (id === own) {
      r.problems.add('INVALID_INPUT', `${at}/${k}`, `"${id}" is this step's own relationship, lit already`);
      ok = false;
    } else if (known.nodeIds.has(id)) {
      if (!nodes.includes(id)) nodes.push(id);
    } else if (known.relationshipIds.has(id)) {
      if (!edges.includes(id)) edges.push(id);
    } else {
      r.problems.add('INVALID_REFERENCE', `${at}/${k}`, `no element, boundary or relationship "${id}" in this view`);
      ok = false;
    }
  });
  const cap = AGENT_LIMITS.highlightsPerStep;
  if (nodes.length > cap || edges.length > cap) {
    r.problems.add('LIMIT_EXCEEDED', at, `a step lights at most ${cap} extra elements and ${cap} extra relationships`);
    ok = false;
  }
  return ok ? { nodes, edges } : undefined;
}

export function readFlow(r: Reader, item: Json, at: string, taken: Set<string> | null, known: Lightable): FlowSpec | undefined {
  const id = taken ? r.newId(item.id, `${at}/id`, taken) : typeof item.id === 'string' ? item.id : undefined;
  const title = r.text(item.title, `${at}/title`, AGENT_LIMITS.flowTitleLength, { required: true, singleLine: true });
  const color = r.oneOf(item.color, `${at}/color`, ACCENTS);
  // Checked against the batch and the view once the whole room is read (`readRoom`); hub-and-spoke
  // itself is `setFlowVariantOf`'s, applied as the flows are linked.
  const variantOf = typeof item.variantOf === 'string' ? item.variantOf : undefined;
  if (item.variantOf !== undefined && variantOf === undefined) r.problems.add('INVALID_INPUT', `${at}/variantOf`, 'must be a flow id');
  const steps: StepSpec[] = [];
  const seen = new Set<string>();
  r.array(item.steps, `${at}/steps`, AGENT_LIMITS.stepsPerFlow).forEach((s, j) => {
    const stepAt = `${at}/steps/${j}`;
    // A bare relationship id is a step too — the common case, kept short.
    const step = typeof s === 'string' ? { relationship: s } : r.object(s, stepAt);
    if (!step) return;
    if (step.frame !== undefined) {
      r.problems.add('INVALID_INPUT', `${stepAt}/frame`, 'a new flow has no frame steps to keep; light elements without a relationship with {spotlight: [ids]}');
      return;
    }
    if (step.spotlight !== undefined || step.relationship === undefined) {
      r.fields(step, stepAt, ['spotlight', 'caption']);
      if (step.spotlight === undefined) {
        r.problems.add('INVALID_INPUT', `${stepAt}/relationship`, 'is required (or spotlight: the ids a step lights without a relationship)');
        return;
      }
      const lit = readHighlight(r, step.spotlight, `${stepAt}/spotlight`, known);
      if (lit && lit.nodes.length + lit.edges.length === 0) r.problems.add('INVALID_INPUT', `${stepAt}/spotlight`, 'needs at least one id');
      const caption = r.text(step.caption, `${stepAt}/caption`, AGENT_LIMITS.captionLength, { singleLine: true });
      if (lit && lit.nodes.length + lit.edges.length > 0) steps.push({ ...extrasOf(lit), ...(caption ? { caption } : {}) });
      return;
    }
    r.fields(step, stepAt, ['relationship', 'caption', 'highlight']);
    const relationship = typeof step.relationship === 'string' ? step.relationship : undefined;
    if (!relationship || !known.relationshipIds.has(relationship)) {
      r.problems.add('INVALID_REFERENCE', `${stepAt}/relationship`, relationship ? `no relationship "${relationship}" in this view` : 'must be a relationship id');
      return;
    }
    if (seen.has(relationship)) {
      // Native flows visit each connector once; a repeat would be dropped on the next load.
      r.problems.add('UNSUPPORTED', stepAt, `relationship "${relationship}" is already a step of this flow; a flow visits each relationship once — use a second flow for the return trip`);
      return;
    }
    seen.add(relationship);
    const caption = r.text(step.caption, `${stepAt}/caption`, AGENT_LIMITS.captionLength, { singleLine: true });
    const lit = step.highlight === undefined ? undefined : readHighlight(r, step.highlight, `${stepAt}/highlight`, known, relationship);
    steps.push({ relationship, ...(caption ? { caption } : {}), ...(lit ? extrasOf(lit) : {}) });
  });
  if (!id || !title) return undefined;
  return { id, title, ...(color ? { color } : {}), ...(variantOf ? { variantOf } : {}), steps };
}

/** A step's extras as the document stores them — absent rather than empty. */
export function extrasOf(lit: { nodes: string[]; edges: string[] }): Pick<StepSpec, 'extraNodeIds' | 'extraEdgeIds'> {
  return { ...(lit.nodes.length ? { extraNodeIds: lit.nodes } : {}), ...(lit.edges.length ? { extraEdgeIds: lit.edges } : {}) };
}

/**
 * A synchronous call's reply line: `true` draws it unlabelled, text labels it ("200 Order"), and
 * `false` (or `null`, on an update) takes it away — returned as `null`. Whether the pairing is a
 * synchronous call is checked where both ends are known.
 */
export function readResponse(r: Reader, value: unknown, at: string): string | true | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === false) return null;
  if (value === true) return true;
  return r.text(value, at, AGENT_LIMITS.responseLength, { singleLine: true, required: true });
}

/** How many delivery attempts come before a dead-letter route is taken; `null` clears it. */
export function readDeliveryAttempts(r: Reader, value: unknown, at: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const { min, max } = AGENT_LIMITS.deliveryAttempts;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    r.problems.add('INVALID_INPUT', at, `must be a whole number from ${min} to ${max}`);
    return undefined;
  }
  return value;
}

/**
 * Open points an `add` op raises. `about` is required and must name elements or relationships in the
 * view (existing or added in the same op) — a point about nothing is refused, and an agent never
 * marks anything it wasn't asked to: nothing here infers a kind from a label's wording.
 */
export function readOpenPoints(r: Reader, value: unknown, path: string, taken: Set<string>, anchorable: Set<string>): OpenPointSpec[] {
  const out: OpenPointSpec[] = [];
  r.array(value, path, AGENT_LIMITS.openPointsPerRequest).forEach((raw, i) => {
    const at = `${path}/${i}`;
    const item = r.object(raw, at);
    if (!item) return;
    const id = item.id === undefined ? undefined : r.newId(item.id, `${at}/id`, taken);
    const kind = r.oneOf(item.kind, `${at}/kind`, OPEN_POINT_KINDS);
    const context = r.text(item.context, `${at}/context`, AGENT_LIMITS.openPointContextLength);
    const aboutRaw = typeof item.about === 'string' ? [item.about] : r.array(item.about, `${at}/about`, AGENT_LIMITS.openPointTargets);
    const about = aboutRaw.filter((entry): entry is string => typeof entry === 'string');
    if (about.length === 0) r.problems.add('INVALID_INPUT', `${at}/about`, 'is required: the id(s) of what this point is about');
    for (const target of about) {
      if (!anchorable.has(target)) r.problems.add('INVALID_REFERENCE', `${at}/about`, `no element or relationship "${target}"`);
    }
    if (kind && about.length && about.every((target) => anchorable.has(target))) {
      out.push({ ...(id ? { id } : {}), kind, ...(context ? { context } : {}), about });
    }
  });
  return out;
}

export function readLayout(r: Reader, value: unknown, path: string, flowIds: Set<string>): LayoutSpec {
  const raw = value === undefined ? {} : r.object(value, path) ?? {};
  const direction = r.oneOf(raw.direction, `${path}/direction`, ['right', 'down'] as const) ?? 'right';
  const spacing = r.oneOf(raw.spacing, `${path}/spacing`, ['compact', 'comfortable', 'spacious'] as const) ?? 'comfortable';
  const primaryFlow = typeof raw.primaryFlow === 'string' ? raw.primaryFlow : undefined;
  if (primaryFlow !== undefined && !flowIds.has(primaryFlow)) r.problems.add('INVALID_REFERENCE', `${path}/primaryFlow`, `no flow "${primaryFlow}"`);
  const allowDegraded = r.bool(raw.allowDegraded, `${path}/allowDegraded`) ?? false;
  const normalizePeerSizes = r.bool(raw.normalizePeerSizes, `${path}/normalizePeerSizes`);
  const viewport = readViewport(r, raw.viewport, `${path}/viewport`);
  return {
    direction,
    ...(raw.direction !== undefined ? { directionChosen: true } : {}),
    spacing,
    ...(primaryFlow && flowIds.has(primaryFlow) ? { primaryFlow } : {}),
    allowDegraded,
    ...(normalizePeerSizes !== undefined ? { normalizePeerSizes } : {}),
    ...(viewport ? { viewport } : {}),
  };
}

function readViewport(r: Reader, value: unknown, path: string): [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
    r.problems.add('INVALID_INPUT', path, 'must be [width, height] in px, both greater than 0');
    return undefined;
  }
  return [value[0] as number, value[1] as number];
}


/** A whole `create_diagram` request. `taken` starts empty: a new file has no ids yet. */
export function readCreate(raw: unknown): CreateSpec {
  const problems = new Problems();
  const r = new Reader(problems);
  const body = r.object(raw, '', ['requestId', 'title', 'project', 'starter', ...ROOM_FIELDS, 'layout', 'open', 'allowDuplicateTitle', 'fallbackType']) ?? {};
  const title = r.text(body.title, '/title', LIMITS.maxTitleLength, { required: true, singleLine: true }) ?? 'Untitled diagram';
  const taken = new Set<string>();
  let starter: StarterSpec | undefined;
  if (body.starter !== undefined) {
    const s = r.object(body.starter, '/starter', ['id', 'prefix', 'overrides']);
    if (s) {
      const id = r.oneOf(s.id, '/starter/id', STARTER_IDS);
      const prefix = s.prefix === undefined ? '' : typeof s.prefix === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,15}$|^$/.test(s.prefix) ? s.prefix : undefined;
      if (prefix === undefined) problems.add('INVALID_INPUT', '/starter/prefix', 'must be a short id prefix (a letter, then up to 15 letters, digits, "_", "." or "-")');
      const overrides: StarterSpec['overrides'] = {};
      const rawOverrides = s.overrides === undefined ? {} : r.object(s.overrides, '/starter/overrides') ?? {};
      for (const [key, value] of Object.entries(rawOverrides)) {
        const at = `/starter/overrides/${key}`;
        const o = r.object(value, at, ['label', 'description', 'technology']);
        if (!o) continue;
        const label = r.text(o.label, `${at}/label`, AGENT_LIMITS.labelLength);
        const description = r.text(o.description, `${at}/description`, AGENT_LIMITS.descriptionLength);
        const technology = r.text(o.technology, `${at}/technology`, AGENT_LIMITS.technologyLength, { singleLine: true });
        overrides[key] = { ...(label ? { label } : {}), ...(description ? { description } : {}), ...(technology ? { technology } : {}) };
      }
      if (id && prefix !== undefined) starter = { id, prefix, overrides };
    }
  }
  const fallbackWord = typeof body.fallbackType === 'string' ? body.fallbackType : undefined;
  const fallbackType = fallbackWord ? resolveType(fallbackWord) : undefined;
  if (fallbackWord && !fallbackType) problems.add('UNSUPPORTED_TYPE', '/fallbackType', `unknown type "${fallbackWord}"`);
  // A starter's elements exist before the request's own: relationships and flows may name them.
  let existing: RoomContext['existing'];
  if (starter) {
    const ids = starterIds(starterFor(starter.id), starter.prefix);
    existing = {
      elements: new Set(ids.nodes.filter((n) => !n.group).map((n) => n.id)),
      groups: new Set(ids.nodes.filter((n) => n.group).map((n) => n.id)),
      relationships: new Set(ids.edges),
    };
    for (const id of [...ids.nodes.map((n) => n.id), ...ids.edges, ...ids.flows]) taken.add(id);
  }
  const room = readRoom(r, body, '', { taken, depth: 0, fallbackType, ...(existing ? { existing } : {}) });
  const layout = readLayout(r, body.layout, '/layout', new Set(room.flows.map((f) => f.id)));
  if (!starter && room.nodes.length === 0) problems.add('INVALID_INPUT', '/nodes', 'a diagram needs at least one element (or a starter)');
  problems.throwIfAny();
  return { ...room, title, ...(starter ? { starter } : {}), layout };
}

export function requireObject(raw: unknown): Json {
  if (!isObject(raw)) throw new AgentError('INVALID_INPUT', 'Arguments must be an object.');
  return raw;
}
