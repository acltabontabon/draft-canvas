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
  type CodeLanguage,
  type ConnectorKind,
  type EdgeSemantic,
  type NoteKind,
  type ViewLevel,
} from '../document/types';
import { LIMITS } from '../document/limits';
import { STARTER_IDS, type StarterId } from '../starters/types';
import { AgentError, Problems } from './errors';
import { starterFor, starterIds } from './starter';
import { GROUP_KINDS, NOTE_KIND_NAMES, resolveType, suggestTypes, type NativeShape } from './vocabulary';

/** What one request may carry. Published through `get_capabilities` and the tool schemas. */
export const AGENT_LIMITS = {
  nodesPerRequest: 300,
  relationshipsPerRequest: 600,
  groupsPerRequest: 60,
  flowsPerRequest: 20,
  stepsPerFlow: 60,
  notesPerRequest: 60,
  actionsPerRequest: 50,
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
  actionLength: LIMITS.maxActionLength,
  flowTitleLength: LIMITS.maxFlowTitleLength,
  captionLength: 120,
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
  id: string;
  from: string;
  to: string;
  label?: string;
  semantic?: EdgeSemantic;
  kind?: ConnectorKind;
  directed?: boolean;
  async?: boolean;
  condition?: string;
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
  steps: { relationship: string; caption?: string }[];
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
  text: string;
  kind: NoteKind;
  near?: string;
  group?: string;
  attachTo?: { kind: 'node' | 'edge'; id: string };
}

export interface ActionSpec {
  id?: string;
  text: string;
  done?: boolean;
  about?: string;
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
  actions: ActionSpec[];
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

  object(value: unknown, path: string): Json | undefined {
    if (isObject(value)) return value;
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

  text(value: unknown, path: string, max: number, options: { required?: boolean; singleLine?: boolean } = {}): string | undefined {
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
    text = text.trim();
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

function readAttachments(r: Reader, value: unknown, path: string): AttachmentSpec[] | undefined {
  const items = r.array(value, path, AGENT_LIMITS.attachmentsPerElement);
  if (items.length === 0) return undefined;
  const out: AttachmentSpec[] = [];
  items.forEach((raw, i) => {
    const at = `${path}/${i}`;
    const item = r.object(raw, at);
    if (!item) return;
    const kind = r.oneOf(item.kind, `${at}/kind`, ['note', 'code'] as const) ?? 'note';
    if (kind === 'code') {
      const code = r.text(item.code, `${at}/code`, AGENT_LIMITS.codeLength, { required: true });
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
  /** Elements, groups and relationships already in the room being edited (updates only). */
  existing?: { elements: Set<string>; groups: Set<string>; relationships: Set<string> };
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
    const item = r.object(g, at);
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
    const item = r.object(n, at);
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
    const attachments = readAttachments(r, item.attachments, `${at}/attachments`);
    let inside: RoomSpec | undefined;
    if (item.inside !== undefined) {
      const insideAt = `${at}/inside`;
      const insideRaw = r.object(item.inside, insideAt);
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
        ...(inside ? { inside } : {}),
      });
    }
  });

  const elementIds = new Set([...nodes.map((n) => n.id), ...(ctx.existing?.elements ?? [])]);
  const relationships: RelationshipSpec[] = [];
  const pairs = new Map<string, RelationshipSpec[]>();
  r.array(raw.relationships, `${path}/relationships`, AGENT_LIMITS.relationshipsPerRequest).forEach((e, i) => {
    const at = `${path}/relationships/${i}`;
    const item = r.object(e, at);
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
      ...(attachments ? { attachments } : {}),
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
  const flows: FlowSpec[] = [];
  r.array(raw.flows, `${path}/flows`, AGENT_LIMITS.flowsPerRequest).forEach((f, i) => {
    const at = `${path}/flows/${i}`;
    const item = r.object(f, at);
    if (!item) return;
    const flow = readFlow(r, item, at, ctx.taken, relationshipIds);
    if (flow) flows.push(flow);
  });

  const notes: NoteSpec[] = [];
  r.array(raw.notes, `${path}/notes`, AGENT_LIMITS.notesPerRequest).forEach((n, i) => {
    const at = `${path}/notes/${i}`;
    const item = r.object(n, at);
    if (!item) return;
    const id = r.newId(item.id, `${at}/id`, ctx.taken);
    const text = r.text(item.text, `${at}/text`, AGENT_LIMITS.noteLength, { required: true });
    const kind = r.oneOf(item.kind, `${at}/kind`, NOTE_KIND_NAMES) ?? 'note';
    const relation = readNoteRelation(r, item, at, { elementIds, groupIds, relationshipIds });
    if (id && text && relation) notes.push({ id, text, kind, ...relation });
  });

  return { ...(level ? { level } : {}), nodes, relationships, groups, flows, notes };
}

/**
 * What a note is about (`about`, or the older `near`) and whether it is attached (`attach`), as the
 * model can hold it: attached to an element or relationship, a member of a group, or placed beside
 * an element. A note about an element attaches unless `attach: false` asks for it beside — attached,
 * the link is stored and the note moves, exports and goes with its host; beside, only its position
 * says what it is about. A relationship has no "beside", so a note about one is always attached.
 * `undefined` when the request is wrong (a problem is recorded).
 */
export function readNoteRelation(
  r: Reader,
  item: Json,
  at: string,
  known: { elementIds: ReadonlySet<string>; groupIds: ReadonlySet<string>; relationshipIds: ReadonlySet<string> },
): Pick<NoteSpec, 'near' | 'group' | 'attachTo'> | undefined {
  const field = item.about !== undefined ? 'about' : 'near';
  const about = typeof item[field] === 'string' ? (item[field] as string) : undefined;
  if (item[field] !== undefined && about === undefined) {
    r.problems.add('INVALID_INPUT', `${at}/${field}`, 'must be the id of an element, group or relationship');
    return undefined;
  }
  const attach = r.bool(item.attach, `${at}/attach`);
  if (about === undefined) {
    if (attach) r.problems.add('INVALID_INPUT', `${at}/attach`, 'needs about: the element or relationship to attach the note to');
    return attach ? undefined : {};
  }
  if (known.relationshipIds.has(about)) return { attachTo: { kind: 'edge', id: about } };
  if (known.groupIds.has(about)) {
    if (attach) {
      r.problems.add('UNSUPPORTED', `${at}/attach`, `a note attaches to an element or a relationship, not a boundary; leave attach out to place it inside "${about}"`);
      return undefined;
    }
    return { group: about };
  }
  if (known.elementIds.has(about)) return attach === false ? { near: about } : { attachTo: { kind: 'node', id: about } };
  r.problems.add('INVALID_REFERENCE', `${at}/${field}`, `no element, group or relationship "${about}" in this view`);
  return undefined;
}

export function readFlow(r: Reader, item: Json, at: string, taken: Set<string> | null, relationshipIds: Set<string>): FlowSpec | undefined {
  const id = taken ? r.newId(item.id, `${at}/id`, taken) : typeof item.id === 'string' ? item.id : undefined;
  const title = r.text(item.title, `${at}/title`, AGENT_LIMITS.flowTitleLength, { required: true, singleLine: true });
  const color = r.oneOf(item.color, `${at}/color`, ACCENTS);
  // Hub-and-spoke enforcement itself happens once the whole room is assembled (`setFlowVariantOf`
  // needs to see every flow's final id and existing links); here it's only read through as a string.
  const variantOf = typeof item.variantOf === 'string' ? item.variantOf : undefined;
  const steps: FlowSpec['steps'] = [];
  const seen = new Set<string>();
  r.array(item.steps, `${at}/steps`, AGENT_LIMITS.stepsPerFlow).forEach((s, j) => {
    const stepAt = `${at}/steps/${j}`;
    // A bare relationship id is a step too — the common case, kept short.
    const step = typeof s === 'string' ? { relationship: s } : r.object(s, stepAt);
    if (!step) return;
    const relationship = typeof step.relationship === 'string' ? step.relationship : undefined;
    if (!relationship || !relationshipIds.has(relationship)) {
      r.problems.add('INVALID_REFERENCE', `${stepAt}/relationship`, relationship ? `no relationship "${relationship}" in this view` : 'is required');
      return;
    }
    if (seen.has(relationship)) {
      // Native flows visit each connector once; a repeat would be dropped on the next load.
      r.problems.add('UNSUPPORTED', stepAt, `relationship "${relationship}" is already a step of this flow; a flow visits each relationship once — use a second flow for the return trip`);
      return;
    }
    seen.add(relationship);
    const caption = r.text(step.caption, `${stepAt}/caption`, AGENT_LIMITS.captionLength, { singleLine: true });
    steps.push({ relationship, ...(caption ? { caption } : {}) });
  });
  if (!id || !title) return undefined;
  return { id, title, ...(color ? { color } : {}), ...(variantOf ? { variantOf } : {}), steps };
}

export function readActions(r: Reader, value: unknown, path: string, taken: Set<string>, anchorable: Set<string>): ActionSpec[] {
  const out: ActionSpec[] = [];
  r.array(value, path, AGENT_LIMITS.actionsPerRequest).forEach((a, i) => {
    const at = `${path}/${i}`;
    const item = typeof a === 'string' ? { text: a } : r.object(a, at);
    if (!item) return;
    const id = item.id === undefined ? undefined : r.newId(item.id, `${at}/id`, taken);
    const text = r.text(item.text, `${at}/text`, AGENT_LIMITS.actionLength, { required: true, singleLine: true });
    const done = r.bool(item.done, `${at}/done`);
    const about = typeof item.about === 'string' ? item.about : undefined;
    if (about !== undefined && !anchorable.has(about)) r.problems.add('INVALID_REFERENCE', `${at}/about`, `no element or relationship "${about}"`);
    if (text) out.push({ ...(id ? { id } : {}), text, ...(done ? { done } : {}), ...(about && anchorable.has(about) ? { about } : {}) });
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

function allIds(room: RoomSpec, into: Set<string>) {
  for (const n of room.nodes) {
    into.add(n.id);
    if (n.inside) allIds(n.inside, into);
  }
  for (const e of room.relationships) into.add(e.id);
}

/** A whole `create_diagram` request. `taken` starts empty: a new file has no ids yet. */
export function readCreate(raw: unknown): CreateSpec {
  const problems = new Problems();
  const r = new Reader(problems);
  const body = r.object(raw, '') ?? {};
  const title = r.text(body.title, '/title', LIMITS.maxTitleLength, { required: true, singleLine: true }) ?? 'Untitled diagram';
  const taken = new Set<string>();
  let starter: StarterSpec | undefined;
  if (body.starter !== undefined) {
    const s = r.object(body.starter, '/starter');
    if (s) {
      const id = r.oneOf(s.id, '/starter/id', STARTER_IDS);
      const prefix = s.prefix === undefined ? '' : typeof s.prefix === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,15}$|^$/.test(s.prefix) ? s.prefix : undefined;
      if (prefix === undefined) problems.add('INVALID_INPUT', '/starter/prefix', 'must be a short id prefix (a letter, then up to 15 letters, digits, "_", "." or "-")');
      const overrides: StarterSpec['overrides'] = {};
      const rawOverrides = s.overrides === undefined ? {} : r.object(s.overrides, '/starter/overrides') ?? {};
      for (const [key, value] of Object.entries(rawOverrides)) {
        const at = `/starter/overrides/${key}`;
        const o = r.object(value, at);
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
  const anchorable = new Set<string>();
  allIds(room, anchorable);
  const actions = readActions(r, body.actions, '/actions', taken, anchorable);
  const layout = readLayout(r, body.layout, '/layout', new Set(room.flows.map((f) => f.id)));
  if (!starter && room.nodes.length === 0) problems.add('INVALID_INPUT', '/nodes', 'a diagram needs at least one element (or a starter)');
  problems.throwIfAny();
  return { ...room, title, ...(starter ? { starter } : {}), actions, layout };
}

export function requireObject(raw: unknown): Json {
  if (!isObject(raw)) throw new AgentError('INVALID_INPUT', 'Arguments must be an object.');
  return raw;
}
