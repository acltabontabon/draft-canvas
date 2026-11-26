/**
 * Linked Junctions: which Junctions are the same continuation point drawn in another place.
 *
 * The whole relationship is one field, `DraftNode.link`, on the Junctions themselves: a group is
 * the Junctions that share a value, wherever in the file they sit. There is no table of groups to
 * keep in step with them, so a group cannot outlive its members, name one that is gone, or
 * disagree with a copy, an undo or a collaborator's edit about who belongs to it.
 *
 * What follows from that, and is relied on everywhere:
 *
 * - **Identity is the link, never the label.** Two groups may both read "A". The label is each
 *   member's own `text`; a group rename writes it on all of them in one step. Members that came to
 *   disagree (two people renaming at once, a file edited by hand) are still one group, each drawn
 *   with its own words until the next rename.
 * - **A link is not a connector.** Nothing here adds an edge or is read by routing, flows, outage
 *   walks, semantics or sequence export.
 * - **A group of one is not an error.** It is a Junction waiting for its counterpart, or the one
 *   left when the other was deleted; putting the other back joins them again.
 *
 * Pure, and free of React, the store and the DOM: it reads the file and returns a file.
 */
import { createId } from '../document/ids';
import { LIMITS } from '../document/limits';
import { cleanText } from '../document/sanitize';
import type { DraftDocument, DraftNode } from '../document/types';
import { mapRooms, pathKey, roomsOf, type DepthPath, type Graph } from '../depth/tree';

/** The prefix of a link id — `j_…`, beside `n_…` for nodes and `e_…` for connectors. */
export const JUNCTION_LINK_PREFIX = 'j';

/** A Junction's largest and default diameters, restated from `document/factory.ts`'s `maxSizeFor`. */
const MAX_DIAMETER = 64;

export function isJunction(node: Pick<DraftNode, 'type'>): boolean {
  return node.type === 'ellipse';
}

/** One Junction and the room it is drawn in. */
export interface JunctionMember {
  node: DraftNode;
  /** The room: owner node ids from the file inward, `[]` at the top. */
  path: DepthPath;
  /** The shapes that own that room, outermost first — what the room is named by. */
  owners: readonly DraftNode[];
}

export interface JunctionIndex {
  /** Every linked Junction by its group, in file order: the top level first, then each room. */
  groups: ReadonlyMap<string, readonly JunctionMember[]>;
  /** Every Junction in the file, linked or not, by node id. */
  byId: ReadonlyMap<string, JunctionMember>;
}

const NO_MEMBERS: readonly JunctionMember[] = Object.freeze([]);

/**
 * Remembered against the file's own node list. Structural sharing gives that list a new identity
 * exactly when something in the file changed — any room, since an edited room rebuilds every owner
 * above it — so one walk serves every question asked of the same file, and nothing is kept for a
 * file nobody holds any more.
 */
const cache = new WeakMap<readonly DraftNode[], JunctionIndex>();

/** Built from scratch, at module level: the returned maps hold only members, never scratch data. */
function build(file: DraftDocument): JunctionIndex {
  const groups = new Map<string, JunctionMember[]>();
  const byId = new Map<string, JunctionMember>();
  for (const room of roomsOf(file)) {
    for (const node of room.graph.nodes) {
      if (node.type !== 'ellipse') continue;
      const member: JunctionMember = { node, path: room.path, owners: room.owners };
      byId.set(node.id, member);
      if (!node.link) continue;
      const members = groups.get(node.link);
      if (members) members.push(member);
      else groups.set(node.link, [member]);
    }
  }
  return { groups, byId };
}

export function junctionIndex(file: DraftDocument): JunctionIndex {
  const cached = cache.get(file.nodes);
  if (cached) return cached;
  const index = build(file);
  cache.set(file.nodes, index);
  return index;
}

/** Every member of a group, in file order. Empty for a link nothing carries. */
export function membersOf(file: DraftDocument, link: string | undefined): readonly JunctionMember[] {
  return link ? (junctionIndex(file).groups.get(link) ?? NO_MEMBERS) : NO_MEMBERS;
}

/** A Junction by id, with its room — whichever room that is. */
export function junctionOf(file: DraftDocument, id: string): JunctionMember | undefined {
  return junctionIndex(file).byId.get(id);
}

/**
 * Reading order within one room: top to bottom, then left to right, then by id so two Junctions on
 * the same spot never swap places between two reads.
 */
function readingOrder(a: JunctionMember, b: JunctionMember): number {
  return a.node.y - b.node.y || a.node.x - b.node.x || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
}

/**
 * Where a Junction continues: the other members of its group. Those in its own room come first, in
 * reading order; then each other room in file order, each in reading order. The same file always
 * gives the same list.
 */
export function counterpartsOf(file: DraftDocument, id: string): JunctionMember[] {
  const index = junctionIndex(file);
  const self = index.byId.get(id);
  if (!self?.node.link) return [];
  const here = pathKey(self.path);
  const near: JunctionMember[] = [];
  const far = new Map<string, JunctionMember[]>();
  for (const member of index.groups.get(self.node.link) ?? NO_MEMBERS) {
    if (member.node.id === id) continue;
    const key = pathKey(member.path);
    if (key === here) near.push(member);
    else {
      const room = far.get(key);
      if (room) room.push(member);
      else far.set(key, [member]);
    }
  }
  near.sort(readingOrder);
  for (const room of far.values()) near.push(...room.sort(readingOrder));
  return near;
}

/** The words a group goes by: its first member's, in file order, that has any. */
export function groupLabel(members: readonly JunctionMember[]): string {
  for (const member of members) {
    const text = member.node.text?.trim();
    if (text) return text;
  }
  return '';
}

/** `0 → A`, `25 → Z`, `26 → AA`: the letters a spreadsheet names its columns with. */
export function letterLabel(index: number): string {
  let label = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) label = String.fromCharCode(65 + (n % 26)) + label;
  return label;
}

/**
 * The first of A, B, … Z, AA, AB, … that no Junction in the file is already labelled, linked or
 * not: a new group must not read like one that exists. Case is ignored, as a reader would.
 */
export function nextJunctionLabel(file: DraftDocument): string {
  const taken = new Set<string>();
  for (const member of junctionIndex(file).byId.values()) {
    const text = member.node.text?.trim();
    if (text) taken.add(text.toUpperCase());
  }
  for (let index = 0; ; index += 1) {
    const label = letterLabel(index);
    if (!taken.has(label)) return label;
  }
}

/** A label as it is stored: one line, trimmed, within what a load keeps. */
export function cleanJunctionLabel(label: string): string {
  return cleanText(label.replace(/\s+/g, ' ').trim(), LIMITS.maxTextLength);
}

/**
 * The diameter a label asks for. One or two letters sit in the default circle; a short word is
 * given room up to the Junction's own ceiling. Never smaller than it already is: a size somebody
 * chose is kept.
 */
export function diameterFor(label: string, current: number): number {
  const length = label.trim().length;
  if (length <= 2) return current;
  return Math.max(current, Math.min(MAX_DIAMETER, Math.round(22 + length * 7.5)));
}

/** One Junction's fields set, wherever in the file it is. Unchanged rooms keep their identity. */
function patchJunctions(file: DraftDocument, patchFor: (node: DraftNode) => Partial<DraftNode> | null): DraftDocument {
  return mapRooms(file, <G extends Graph>(graph: G): G => {
    let changed = false;
    const nodes = graph.nodes.map((node) => {
      if (node.type !== 'ellipse') return node;
      const patch = patchFor(node);
      if (!patch) return node;
      const next: DraftNode = { ...node, ...patch };
      for (const key of Object.keys(patch) as (keyof DraftNode)[]) {
        if (patch[key] === undefined) delete next[key];
      }
      const keys = Object.keys(next) as (keyof DraftNode)[];
      if (keys.length === Object.keys(node).length && keys.every((key) => next[key] === node[key])) return node;
      changed = true;
      return next;
    });
    return changed ? { ...graph, nodes } : graph;
  });
}

/** The fields that give a Junction a label: the words, marked as chosen, and room for them. */
function labelled(node: DraftNode, label: string): Partial<DraftNode> {
  const diameter = diameterFor(label, Math.max(node.width, node.height));
  const grow = diameter > Math.max(node.width, node.height);
  return {
    text: label,
    textOrigin: 'explicit',
    // Grown about its own middle, so the connectors that meet it stay where they were.
    ...(grow
      ? { width: diameter, height: diameter, x: Math.round(node.x - (diameter - node.width) / 2), y: Math.round(node.y - (diameter - node.height) / 2) }
      : {}),
  };
}

export interface LinkResult {
  file: DraftDocument;
  /** The group the Junctions are now in; `null` when nothing could be linked. */
  link: string | null;
  label: string;
}

/**
 * Puts Junctions into one group.
 *
 * `into` names the group to join. Without it the first Junction named that already has a group
 * decides; when none has, a new group is made. Each joins on its own: a Junction taken from another
 * group leaves that group's other members where they were.
 *
 * The group's label is written on every Junction joining it — the group's own when it has one,
 * else the first label any of them carries, else the next free letter — so what reads as one
 * continuation point is one.
 */
export function linkJunctions(file: DraftDocument, ids: readonly string[], into?: string): LinkResult {
  const index = junctionIndex(file);
  const joining = ids.map((id) => index.byId.get(id)).filter((member): member is JunctionMember => member !== undefined);
  if (joining.length === 0) return { file, link: null, label: '' };
  const link = into ?? joining.find((member) => member.node.link)?.node.link ?? createId(JUNCTION_LINK_PREFIX);
  const label = cleanJunctionLabel(groupLabel(index.groups.get(link) ?? NO_MEMBERS) || groupLabel(joining)) || nextJunctionLabel(file);
  const wanted = new Set(joining.map((member) => member.node.id));
  const next = patchJunctions(file, (node) => (wanted.has(node.id) ? { link, ...labelled(node, label) } : null));
  return { file: next, link, label };
}

/** Takes Junctions out of their groups. Each stays where it is, with its label and its connectors. */
export function unlinkJunctions(file: DraftDocument, ids: readonly string[]): DraftDocument {
  const wanted = new Set(ids);
  return patchJunctions(file, (node) => (wanted.has(node.id) && node.link ? { link: undefined } : null));
}

/** Writes one label on the Junctions named, wherever they are, growing each to hold it. */
export function labelJunctions(file: DraftDocument, ids: readonly string[], label: string): DraftDocument {
  const wanted = new Set(ids);
  const clean = cleanJunctionLabel(label);
  return patchJunctions(file, (node) => (wanted.has(node.id) ? labelled(node, clean) : null));
}

/** Renames a group: the new label on every member, in every room. An empty label clears it. */
export function renameJunctionGroup(file: DraftDocument, link: string, label: string): DraftDocument {
  const clean = cleanJunctionLabel(label);
  return patchJunctions(file, (node) => (node.link === link ? labelled(node, clean) : null));
}

/** What `settleJunctionLabels` did, for whoever made the edit to be told. */
export interface SettledJunctions {
  file: DraftDocument;
  /** Groups whose label was written on their other members: the label, and how many it changed. */
  renamed: Array<{ link: string; label: string; changed: number }>;
  /** Junctions that joined a group and took the label it already had in place of their own. */
  adopted: Array<{ id: string; link: string; label: string; was: string }>;
}

/**
 * Keeps a group reading as one label after a batch of edits made one Junction at a time — what an
 * agent's request is. The rules a person gets from the editor, stated for edits that arrive as data:
 *
 * - **A label set on a Junction in a group is the group's**: `relabelled` (in the order the edits
 *   were made, so the last word wins) is written on every member, in every room.
 * - **A Junction that joins a group takes the group's label**, when the group already has members
 *   that were not just joining it. A group made entirely by this batch keeps the labels it was given.
 *
 * `before` is the file the batch started from; anything whose link is new or different since then
 * has joined. Returns the same file when nothing needed settling.
 */
export function settleJunctionLabels(before: DraftDocument, after: DraftDocument, relabelled: readonly string[]): SettledJunctions {
  const was = junctionIndex(before).byId;
  const now = junctionIndex(after);
  const renames = new Map<string, string>();
  for (const id of relabelled) {
    const node = now.byId.get(id)?.node;
    if (node?.link) renames.set(node.link, node.text ?? '');
  }
  const joining = new Map<string, string[]>();
  for (const [id, member] of now.byId) {
    const link = member.node.link;
    if (!link || renames.has(link) || was.get(id)?.node.link === link) continue;
    const list = joining.get(link);
    if (list) list.push(id);
    else joining.set(link, [id]);
  }
  let file = after;
  const adopted: SettledJunctions['adopted'] = [];
  for (const [link, ids] of joining) {
    const newcomers = new Set(ids);
    const label = groupLabel((now.groups.get(link) ?? NO_MEMBERS).filter((member) => !newcomers.has(member.node.id)));
    if (!label) continue;
    const differ = ids.filter((id) => (now.byId.get(id)?.node.text ?? '').trim() !== label);
    if (differ.length === 0) continue;
    for (const id of differ) adopted.push({ id, link, label, was: now.byId.get(id)?.node.text ?? '' });
    file = labelJunctions(file, differ, label);
  }
  const renamed: SettledJunctions['renamed'] = [];
  for (const [link, label] of renames) {
    const clean = cleanJunctionLabel(label);
    const changed = membersOf(file, link).filter((member) => (member.node.text ?? '') !== clean).length;
    if (changed === 0) continue;
    renamed.push({ link, label: clean, changed });
    file = renameJunctionGroup(file, link, clean);
  }
  return { file, renamed, adopted };
}

/** A group that could be joined: its link, what it reads as, and how many places it is drawn in. */
export interface JunctionGroupSummary {
  link: string;
  label: string;
  count: number;
}

/** Every group in the file, by label and then by link, for a list somebody picks from. */
export function junctionGroups(file: DraftDocument): JunctionGroupSummary[] {
  const groups: JunctionGroupSummary[] = [];
  for (const [link, members] of junctionIndex(file).groups) groups.push({ link, label: groupLabel(members), count: members.length });
  return groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || (a.link < b.link ? -1 : 1));
}

/**
 * Junctions that read the same as this one without being linked to it: what a diagram drawn before
 * links existed, where "A" and "A" were matched by eye, is offered as a link to make. Never made
 * for anyone — two Junctions may share a letter and mean nothing by it.
 */
export function sameLabelJunctions(file: DraftDocument, id: string): JunctionMember[] {
  const index = junctionIndex(file);
  const self = index.byId.get(id);
  const label = self?.node.text?.trim().toUpperCase();
  if (!self || !label) return [];
  const matches: JunctionMember[] = [];
  for (const member of index.byId.values()) {
    if (member.node.id === id) continue;
    if (member.node.text?.trim().toUpperCase() !== label) continue;
    if (self.node.link && member.node.link === self.node.link) continue;
    matches.push(member);
  }
  return matches;
}
