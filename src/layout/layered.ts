/**
 * A deterministic layered layout for compound graphs — what arranges a diagram an agent described
 * without coordinates.
 *
 * Pure geometry: it is handed every box's size already measured (by the renderer's own text
 * measurement, on the page) and returns positions. It never measures text, never touches the DOM,
 * and imports nothing but numbers, so it runs the same in a worker, on the main thread and in tests.
 *
 * The shape of it is Sugiyama's, kept small and predictable:
 *
 * 1. **Clusters, bottom-up.** A boundary is laid out on its own, then placed as one block in the
 *    cluster around it. An edge between two boundaries' contents is "lifted" to the level where
 *    they meet, so blocks are ordered by what connects them.
 * 2. **Cycles** are broken for *layering only*, by a depth-first search in input order (with the
 *    primary flow's edges visited first). No edge changes direction in the document.
 * 3. **Layers** by longest path, then sources pulled next to what they feed, so a lone producer
 *    doesn't sit a whole column away from its consumer.
 * 4. **Long edges** get placeholder slots in the layers they cross, which keeps a corridor open for
 *    the connector and lets ordering take it into account.
 * 5. **Order** within layers by barycentre sweeps, keeping the arrangement with fewest crossings.
 * 6. **Positions** across the layers by weighted isotonic regression: each box as close as it can
 *    get to the median of its neighbours without overlapping its siblings — the step that makes a
 *    main path come out straight and a fan-out come out balanced.
 *
 * Every tie is broken by input order, and every loop has a fixed bound, so the same input always
 * produces the same output, to the pixel.
 */

export type Direction = 'right' | 'down';

export interface LayoutBox {
  id: string;
  width: number;
  height: number;
  /** The group (boundary) this box sits inside, if any. */
  parent?: string;
  /**
   * Where, down from its top, a left/right connector meets the box — when that isn't its middle (a
   * queue's tube, a Data Store's glyph). Laying out left to right, boxes line up on this, so a
   * connector between two of them runs straight instead of jogging between a middle and a glyph.
   */
  band?: number;
  /**
   * Where, across the flow from its start, the box's connectors line up — in either direction. For a
   * box that stands for more than one shape (a shape with its loop companion beside it), so the
   * shape itself, not the pair's middle, is what lines up with its neighbours. Overrides `band`.
   */
  lead?: number;
}

export interface LayoutGroup {
  id: string;
  parent?: string;
  /** Room above the content for the boundary's caption and title. */
  header: number;
  /** The narrowest the boundary may be, so its one-line title fits. */
  minWidth: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  /** Width of the connector's caption, so the gap it crosses leaves room to read it. */
  labelWidth?: number;
  labelHeight?: number;
  /** Part of the primary flow: laid out forwards where it can be, and pulled straight. */
  primary?: boolean;
  /** A side path — a failure, retry or dead-letter branch: it yields the straight line to the main one. */
  minor?: boolean;
}

export interface LayoutSpacing {
  /** Between layers (the reading direction). */
  layer: number;
  /** Between siblings within a layer. */
  sibling: number;
  /** Inside a boundary: its padding on three sides. */
  pad: number;
  /** Between disconnected parts. */
  component: number;
}

export interface LayoutInput {
  boxes: LayoutBox[];
  groups: LayoutGroup[];
  edges: LayoutEdge[];
  direction: Direction;
  spacing: LayoutSpacing;
  /**
   * `align` (the default): a box with two neighbours pulling equally lines up with one of them, so
   * one connector runs straight. `balance`: it sits halfway between — both connectors step, but a
   * crowded diagram sometimes has room for its captions only that way (a repair falls back to it).
   */
  ties?: 'align' | 'balance';
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutOutput {
  boxes: Map<string, { x: number; y: number }>;
  groups: Map<string, Rect>;
  width: number;
  height: number;
}

type Point = { x: number; y: number };
type Size = { width: number; height: number };

/** Barycentre sweeps per component. A bound, not a target. */
const ORDER_SWEEPS = 24;
/** Alternating passes of the position solver. */
const POSITION_PASSES = 8;
/** Passes of the neighbour-swapping refinement after the sweeps. */
const TRANSPOSE_PASSES = 6;
/** How wide the corridor a long edge's placeholder keeps open is, across the layer. */
const DUMMY_THICKNESS = 18;
/** Gap next to a placeholder: corridors can run closer together than boxes. */
const DUMMY_GAP = 14;
/** Empty space kept around a connector's caption in the gap it crosses. */
const CAPTION_AIR = 40;
/** The run of a fan-out's shared trunk before it branches (`edges/bundles.ts` needs at least 56). */
const FAN_TRUNK = 72;
/** How far off its feeder's line a box may be and still be moved onto it. */
const STRAIGHTEN = 28;

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

function get<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new LayoutError('Layout lost track of an item');
  return value;
}

function at<T>(list: readonly T[], index: number): T {
  return list[index] as T;
}

interface LiftedEdge {
  id: string;
  source: string;
  target: string;
  labelWidth: number;
  labelHeight: number;
  primary: boolean;
  minor: boolean;
}

export function layoutGraph(input: LayoutInput): LayoutOutput {
  const groupsById = new Map(input.groups.map((g) => [g.id, g]));
  const boxesById = new Map(input.boxes.map((b) => [b.id, b]));
  for (const box of input.boxes) {
    if (box.parent !== undefined && !groupsById.has(box.parent)) throw new LayoutError(`Unknown group ${box.parent}`);
    if (!(box.width > 0 && box.height > 0 && Number.isFinite(box.width) && Number.isFinite(box.height))) {
      throw new LayoutError(`Box ${box.id} has no usable size`);
    }
  }
  // Every cluster's chain of ancestors (itself first, the canvas — `undefined` — last).
  const chains = new Map<string | undefined, (string | undefined)[]>();
  const chain = (id: string | undefined): (string | undefined)[] => {
    const known = chains.get(id);
    if (known) return known;
    const out: (string | undefined)[] = [];
    let current = id;
    const seen = new Set<string>();
    while (current !== undefined) {
      if (seen.has(current)) throw new LayoutError(`Groups nest in a cycle at ${current}`);
      seen.add(current);
      out.push(current);
      current = groupsById.get(current)?.parent;
    }
    out.push(undefined);
    chains.set(id, out);
    return out;
  };
  for (const group of input.groups) chain(group.id);

  const order = new Map<string, number>();
  input.boxes.forEach((b, i) => order.set(b.id, i));
  input.groups.forEach((g, i) => order.set(g.id, input.boxes.length + i));

  const children = new Map<string | undefined, string[]>();
  const push = (cluster: string | undefined, id: string) => {
    const list = children.get(cluster);
    if (list) list.push(id);
    else children.set(cluster, [id]);
  };
  for (const box of input.boxes) push(box.parent, box.id);
  for (const group of input.groups) push(group.parent, group.id);

  // Edges lifted to the cluster where their endpoints meet.
  const lifted = new Map<string | undefined, LiftedEdge[]>();
  const clusterOf = (id: string): string | undefined => boxesById.get(id)?.parent ?? groupsById.get(id)?.parent;
  for (const edge of input.edges) {
    for (const end of [edge.source, edge.target]) {
      if (!boxesById.has(end) && !groupsById.has(end)) throw new LayoutError(`Unknown endpoint ${end}`);
    }
    const sourceChain: (string | undefined)[] = [edge.source, ...chain(clusterOf(edge.source))];
    const targetChain: (string | undefined)[] = [edge.target, ...chain(clusterOf(edge.target))];
    let meet: string | undefined;
    let from: string | undefined;
    let to: string | undefined;
    for (let i = 1; i < sourceChain.length; i += 1) {
      const j = targetChain.indexOf(sourceChain[i]);
      if (j > 0) {
        meet = sourceChain[i];
        from = sourceChain[i - 1];
        to = targetChain[j - 1];
        break;
      }
    }
    if (from === undefined || to === undefined || from === to) continue;
    const list = lifted.get(meet) ?? [];
    list.push({ id: edge.id, source: from, target: to, labelWidth: edge.labelWidth ?? 0, labelHeight: edge.labelHeight ?? 0, primary: edge.primary === true, minor: edge.minor === true && edge.primary !== true });
    lifted.set(meet, list);
  }

  const sizes = new Map<string, Size>();
  for (const box of input.boxes) sizes.set(box.id, { width: box.width, height: box.height });
  const local = new Map<string, Point>();
  const contentOffset = new Map<string, Point>();

  // Bottom-up: a boundary can be sized only once everything inside it is.
  const depthOf = (id: string) => chain(id).length;
  const deepestFirst = [...input.groups].sort((a, b) => depthOf(b.id) - depthOf(a.id) || get(order, a.id) - get(order, b.id));
  const bands = new Map<string, number>();
  for (const box of input.boxes) {
    if (box.lead !== undefined) bands.set(box.id, box.lead);
    else if (box.band !== undefined && input.direction === 'right') bands.set(box.id, box.band);
  }
  const env: Env = { sizes, order, direction: input.direction, spacing: input.spacing, local, bands, ties: input.ties ?? 'align' };
  for (const group of deepestFirst) {
    const content = layoutCluster(children.get(group.id) ?? [], lifted.get(group.id) ?? [], env);
    const pad = input.spacing.pad;
    const width = Math.max(group.minWidth, content.width + pad * 2, 160);
    const height = Math.max(group.header + content.height + pad, 120);
    sizes.set(group.id, { width: Math.round(width), height: Math.round(height) });
    contentOffset.set(group.id, { x: Math.round((width - content.width) / 2), y: group.header });
  }
  const root = layoutCluster(children.get(undefined) ?? [], lifted.get(undefined) ?? [], env);

  // Top-down: absolute positions.
  const absolute = (id: string): Point => {
    const here = local.get(id) ?? { x: 0, y: 0 };
    const parent = clusterOf(id);
    if (parent === undefined) return here;
    const origin = absolute(parent);
    const offset = contentOffset.get(parent) ?? { x: 0, y: 0 };
    return { x: origin.x + offset.x + here.x, y: origin.y + offset.y + here.y };
  };
  const boxes = new Map<string, Point>();
  const groups = new Map<string, Rect>();
  for (const box of input.boxes) {
    const p = absolute(box.id);
    boxes.set(box.id, { x: Math.round(p.x), y: Math.round(p.y) });
  }
  for (const group of input.groups) {
    const p = absolute(group.id);
    const size = get(sizes, group.id);
    groups.set(group.id, { x: Math.round(p.x), y: Math.round(p.y), width: size.width, height: size.height });
  }
  return { boxes, groups, width: root.width, height: root.height };
}

interface Env {
  sizes: Map<string, Size>;
  order: Map<string, number>;
  direction: Direction;
  spacing: LayoutSpacing;
  /** Where every placement is written: positions relative to the cluster's content origin. */
  local: Map<string, Point>;
  /** Each box's connection line, down from its top (see `LayoutBox.band`); absent means its middle. */
  bands: Map<string, number>;
  ties: 'align' | 'balance';
}

interface Block {
  width: number;
  height: number;
  place: (x: number, y: number) => void;
}

/** Lays out one cluster's direct items and returns the content's size. */
function layoutCluster(items: string[], edges: LiftedEdge[], env: Env): Size {
  if (items.length === 0) return { width: 0, height: 0 };
  const components = connectedComponents(items, edges, env.order);
  // Parts with edges first, largest first; lone items after, gathered into one row.
  const connected = components.filter((c) => c.length > 1);
  const alone = components.filter((c) => c.length === 1).map((c) => at(c, 0));
  connected.sort((a, b) => b.length - a.length || get(env.order, at(a, 0)) - get(env.order, at(b, 0)));

  const blocks: Block[] = [];
  for (const component of connected) {
    const set = new Set(component);
    blocks.push(layerComponent(component, edges.filter((e) => set.has(e.source) && set.has(e.target)), env));
  }
  if (alone.length > 0) blocks.push(rowOf(alone, env, blocks));

  // Stacked across the reading direction, aligned at the start.
  let offset = 0;
  let width = 0;
  let height = 0;
  for (const block of blocks) {
    if (env.direction === 'right') {
      block.place(0, offset);
      offset += block.height + env.spacing.component;
      width = Math.max(width, block.width);
      height = offset - env.spacing.component;
    } else {
      block.place(offset, 0);
      offset += block.width + env.spacing.component;
      height = Math.max(height, block.height);
      width = offset - env.spacing.component;
    }
  }
  for (const id of items) {
    const p = env.local.get(id);
    if (p) env.local.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** Unconnected items in rows along the reading direction, each row about as long as the longest
 *  connected part (or four items, when there is none). */
function rowOf(ids: string[], env: Env, others: Block[]): Block {
  const { direction, spacing } = env;
  const along = (id: string) => (direction === 'right' ? get(env.sizes, id).width : get(env.sizes, id).height);
  const across = (id: string) => (direction === 'right' ? get(env.sizes, id).height : get(env.sizes, id).width);
  const limit = others.length
    ? Math.max(...others.map((b) => (direction === 'right' ? b.width : b.height)))
    : ids.slice(0, 4).reduce((sum, id) => sum + along(id) + spacing.sibling, 0);
  const rows: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const id of ids) {
    const need = along(id) + (current.length ? spacing.sibling : 0);
    if (current.length && used + need > limit) {
      rows.push(current);
      current = [];
      used = 0;
    }
    used += along(id) + (current.length ? spacing.sibling : 0);
    current.push(id);
  }
  if (current.length) rows.push(current);
  const rowAcross = rows.map((row) => Math.max(...row.map(across)));
  const rowAlong = rows.map((row) => row.reduce((s, id, i) => s + along(id) + (i ? spacing.sibling : 0), 0));
  const totalAlong = Math.max(...rowAlong);
  const totalAcross = rowAcross.reduce((s, h, i) => s + h + (i ? spacing.sibling : 0), 0);
  return {
    width: direction === 'right' ? totalAlong : totalAcross,
    height: direction === 'right' ? totalAcross : totalAlong,
    place: (x, y) => {
      let crossAt = 0;
      rows.forEach((row, r) => {
        let alongAt = 0;
        for (const id of row) {
          const centred = crossAt + (at(rowAcross, r) - across(id)) / 2;
          env.local.set(id, direction === 'right' ? { x: x + alongAt, y: y + centred } : { x: x + centred, y: y + alongAt });
          alongAt += along(id) + spacing.sibling;
        }
        crossAt += at(rowAcross, r) + spacing.sibling;
      });
    },
  };
}

function connectedComponents(items: string[], edges: LiftedEdge[], order: Map<string, number>): string[][] {
  const parent = new Map(items.map((id) => [id, id]));
  const find = (id: string): string => {
    let current = id;
    while (get(parent, current) !== current) current = get(parent, current);
    return current;
  };
  for (const edge of edges) {
    const a = find(edge.source);
    const b = find(edge.target);
    if (a === b) continue;
    // The earlier item stays the root, so components keep input order.
    if (get(order, a) < get(order, b)) parent.set(b, a);
    else parent.set(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const id of items) {
    const root = find(id);
    const list = groups.get(root);
    if (list) list.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()];
}

interface Slot {
  dummy: boolean;
  /** Extent along the reading direction (width, reading right). */
  along: number;
  /** Extent across it. */
  across: number;
  /** From the start of `across` to the line the box is aligned on (its middle, or its band). */
  lead: number;
}

type Neighbour = { id: string; weight: number };

function layerComponent(ids: string[], edges: LiftedEdge[], env: Env): Block {
  const { direction, spacing } = env;
  const along = (id: string) => (direction === 'right' ? get(env.sizes, id).width : get(env.sizes, id).height);
  const across = (id: string) => (direction === 'right' ? get(env.sizes, id).height : get(env.sizes, id).width);
  const idx = (id: string) => env.order.get(id) ?? 0;

  // 2. Break cycles for layering: depth-first, primary edges first, then input order.
  const out = new Map<string, LiftedEdge[]>(ids.map((id) => [id, []]));
  for (const edge of edges) get(out, edge.source).push(edge);
  for (const list of out.values()) list.sort((a, b) => Number(b.primary) - Number(a.primary) || idx(a.target) - idx(b.target));
  const startsPrimary = (id: string) => edges.some((e) => e.primary && e.source === id) && !edges.some((e) => e.primary && e.target === id);
  const roots = [...ids].sort((a, b) => Number(startsPrimary(b)) - Number(startsPrimary(a)) || idx(a) - idx(b));
  const reversed = new Set<string>();
  const state = new Map<string, 1 | 2>();
  for (const root of roots) {
    if (state.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = at(stack, stack.length - 1);
      const list = get(out, top.id);
      if (top.next >= list.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const edge = at(list, top.next);
      top.next += 1;
      const seen = state.get(edge.target);
      if (seen === 1) reversed.add(edge.id);
      else if (seen === undefined) {
        state.set(edge.target, 1);
        stack.push({ id: edge.target, next: 0 });
      }
    }
  }
  const dag = edges.map((e) => (reversed.has(e.id) ? { ...e, source: e.target, target: e.source } : e));

  // 3. Layers: longest path, then sources pulled up to just before what they feed.
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of dag) {
    get(preds, e.target).push(e.source);
    get(succs, e.source).push(e.target);
  }
  const topo: string[] = [];
  const indegree = new Map(ids.map((id) => [id, get(preds, id).length]));
  const ready = ids.filter((id) => get(indegree, id) === 0).sort((a, b) => idx(a) - idx(b));
  while (ready.length) {
    const id = ready.shift() as string;
    topo.push(id);
    for (const next of get(succs, id)) {
      indegree.set(next, get(indegree, next) - 1);
      if (get(indegree, next) === 0) {
        // Kept sorted, so which of several ready items goes first never depends on edge order.
        const position = ready.findIndex((other) => idx(other) > idx(next));
        if (position === -1) ready.push(next);
        else ready.splice(position, 0, next);
      }
    }
  }
  const rank = new Map<string, number>();
  for (const id of topo) rank.set(id, Math.max(0, ...get(preds, id).map((p) => get(rank, p) + 1)));
  for (const id of [...topo].reverse()) {
    if (get(preds, id).length === 0 && get(succs, id).length > 0) {
      rank.set(id, Math.min(...get(succs, id).map((s) => get(rank, s))) - 1);
    }
  }
  const minRank = Math.min(...ids.map((id) => get(rank, id)));
  for (const id of ids) rank.set(id, get(rank, id) - minRank);
  const layerCount = Math.max(...ids.map((id) => get(rank, id))) + 1;

  // 4. Placeholders for edges spanning more than one layer.
  const slots = new Map<string, Slot>();
  for (const id of ids) slots.set(id, { dummy: false, along: along(id), across: across(id), lead: env.bands.get(id) ?? across(id) / 2 });
  const links: { from: string; to: string; weight: number }[] = [];
  const gapLabel = new Array<number>(layerCount).fill(0);
  // A source feeding several boxes in the next layer is drawn as a shared trunk that branches: the
  // captions then sit on the branches, after the trunk, so that gap needs the trunk's run as well.
  const fanOut = new Map<string, number>();
  for (const e of dag) if (get(rank, e.target) === get(rank, e.source) + 1) fanOut.set(e.source, (fanOut.get(e.source) ?? 0) + 1);
  for (const e of dag) {
    const from = get(rank, e.source);
    const to = get(rank, e.target);
    // A caption sits in the first gap the edge crosses; the widest one there sets that gap.
    const label = direction === 'right' ? e.labelWidth : e.labelHeight;
    const trunk = label > 0 && (fanOut.get(e.source) ?? 0) > 1 ? FAN_TRUNK : 0;
    if (to > from) gapLabel[from] = Math.max(at(gapLabel, from), label + trunk);
    // A return (reversed for layering) is drawn as a detour around the boxes, not along the reading
    // line, so it barely pulls: otherwise a reply from the far side drags its target off the line
    // it starts, and the forward connector turns into a jog for the sake of the return.
    // A side path (failure, retry, dead letter) pulls less than the main one, so where a shape could
    // line up with either, the main path is the one drawn straight.
    const pull = (reversed.has(e.id) ? 0.25 : 1) * (e.minor ? 0.35 : 1);
    let previous = e.source;
    for (let r = from + 1; r < to; r += 1) {
      const id = `\u0000${e.id}:${r}`;
      slots.set(id, { dummy: true, along: 0, across: DUMMY_THICKNESS, lead: DUMMY_THICKNESS / 2 });
      rank.set(id, r);
      links.push({ from: previous, to: id, weight: (e.primary ? 8 : 2) * pull });
      previous = id;
    }
    links.push({ from: previous, to: e.target, weight: (e.primary ? 8 : previous === e.source ? 1 : 2) * pull });
  }

  // 5. Order within layers.
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  const up = new Map<string, Neighbour[]>();
  const down = new Map<string, Neighbour[]>();
  for (const id of slots.keys()) {
    up.set(id, []);
    down.set(id, []);
  }
  for (const link of links) {
    get(down, link.from).push({ id: link.to, weight: link.weight });
    get(up, link.to).push({ id: link.from, weight: link.weight });
  }
  // How long a chain runs through each box (longest path in plus longest path out): on a tie, a box
  // lines up with the neighbour on the longer chain, so the diagram's spine is the part drawn straight.
  const longestIn = new Map<string, number>();
  const longestOut = new Map<string, number>();
  const bySlotRank = [...slots.keys()].sort((a, b) => get(rank, a) - get(rank, b));
  for (const id of bySlotRank) longestIn.set(id, Math.max(0, ...get(up, id).map((n) => (longestIn.get(n.id) ?? 0) + 1)));
  for (const id of [...bySlotRank].reverse()) longestOut.set(id, Math.max(0, ...get(down, id).map((n) => (longestOut.get(n.id) ?? 0) + 1)));
  const chain = new Map([...slots.keys()].map((id) => [id, get(longestIn, id) + get(longestOut, id)]));

  // Initial order: breadth-first from the earliest layer, in input order.
  const placed = new Set<string>();
  const visit = (id: string) => {
    if (placed.has(id)) return;
    placed.add(id);
    at(layers, get(rank, id)).push(id);
  };
  const starts = [...ids].sort((a, b) => get(rank, a) - get(rank, b) || idx(a) - idx(b));
  for (const start of starts) {
    const frontier = [start];
    while (frontier.length) {
      const id = frontier.shift() as string;
      if (placed.has(id)) continue;
      visit(id);
      for (const next of get(down, id)) if (!placed.has(next.id)) frontier.push(next.id);
    }
  }
  for (const id of slots.keys()) visit(id);

  const position = new Map<string, number>();
  const index = () => layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)));
  index();
  let best = layers.map((l) => [...l]);
  let bestCrossings = crossings(layers, down, position);
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep += 1) {
    const downward = sweep % 2 === 0;
    const range = [...Array(layerCount).keys()];
    const visitOrder = downward ? range.slice(1) : range.slice(0, -1).reverse();
    for (const r of visitOrder) {
      const neighbours = downward ? up : down;
      const layer = at(layers, r);
      const key = new Map<string, number>();
      for (const id of layer) {
        const around = get(neighbours, id);
        const total = around.reduce((s, n) => s + n.weight, 0);
        key.set(id, total > 0 ? around.reduce((s, n) => s + get(position, n.id) * n.weight, 0) / total : get(position, id));
      }
      layer.sort((a, b) => get(key, a) - get(key, b) || get(position, a) - get(position, b));
      layer.forEach((id, i) => position.set(id, i));
    }
    const count = crossings(layers, down, position);
    if (count < bestCrossings) {
      bestCrossings = count;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((layer, r) => (layers[r] = layer));
  index();
  // Transpose: swap neighbours in a layer whenever that strictly lowers the crossings with the
  // layers on both sides — the local fix barycentres miss. Bounded passes; ties never swap.
  const pairCrossings = (a: string, b: string, r: number) => {
    let count = 0;
    for (const [neighbours, layer] of [
      [up, r - 1],
      [down, r + 1],
    ] as const) {
      if (layer < 0 || layer >= layerCount) continue;
      for (const na of get(neighbours, a)) {
        for (const nb of get(neighbours, b)) {
          if (get(position, na.id) > get(position, nb.id)) count += 1;
        }
      }
    }
    return count;
  };
  for (let pass = 0; pass < TRANSPOSE_PASSES; pass += 1) {
    let improved = false;
    for (let r = 0; r < layerCount; r += 1) {
      const layer = at(layers, r);
      for (let i = 0; i + 1 < layer.length; i += 1) {
        const a = at(layer, i);
        const b = at(layer, i + 1);
        if (pairCrossings(b, a, r) < pairCrossings(a, b, r)) {
          layer[i] = b;
          layer[i + 1] = a;
          position.set(a, i + 1);
          position.set(b, i);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  // 6. Positions across the layers.
  const centre = new Map<string, number>();
  const separation = (a: string, b: string) => {
    const sa = get(slots, a);
    const sb = get(slots, b);
    return sa.across - sa.lead + sb.lead + (sa.dummy || sb.dummy ? DUMMY_GAP : spacing.sibling);
  };
  for (const layer of layers) {
    let cursor = 0;
    layer.forEach((id, i) => {
      if (i > 0) cursor += separation(at(layer, i - 1), id);
      centre.set(id, cursor);
    });
    for (const id of layer) centre.set(id, get(centre, id) - cursor / 2);
  }
  for (let pass = 0; pass < POSITION_PASSES; pass += 1) {
    const downward = pass % 2 === 0;
    const range = [...Array(layerCount).keys()];
    for (const r of downward ? range : range.reverse()) {
      const layer = at(layers, r);
      const desired: number[] = [];
      const weights: number[] = [];
      for (const id of layer) {
        // Both sides pull, the side just settled harder: a box lines up with what it connects to
        // on either side rather than only what came before it.
        const pulls = [...get(downward ? up : down, id).map((n) => ({ ...n, weight: n.weight * 2 })), ...get(downward ? down : up, id)];
        if (pulls.length === 0) {
          desired.push(get(centre, id));
          weights.push(0.1);
          continue;
        }
        desired.push(weightedMedian(pulls.map((n) => ({ value: get(centre, n.id), weight: n.weight, prefer: get(chain, n.id) * 1e6 - idx(n.id) })), env.ties));
        weights.push(pulls.reduce((s, n) => s + n.weight, 0) * (get(slots, id).dummy ? 1.5 : 1));
      }
      const gaps = layer.slice(1).map((id, i) => separation(at(layer, i), id));
      const solved = isotonic(desired, weights, gaps);
      layer.forEach((id, i) => centre.set(id, at(solved, i)));
    }
  }

  // Straighten: a box a few pixels off the line of the one thing feeding it is moved onto that line
  // when its neighbours leave room. A near-level connector otherwise gets a tiny jog, and the router
  // hangs the caption on the jog — on top of the line itself.
  for (let r = 1; r < layerCount; r += 1) {
    const layer = at(layers, r);
    layer.forEach((id, i) => {
      if (get(slots, id).dummy) return;
      const from = get(up, id);
      if (from.length !== 1) return;
      const delta = get(centre, at(from, 0).id) - get(centre, id);
      if (delta === 0 || Math.abs(delta) > STRAIGHTEN) return;
      const next = get(centre, id) + delta;
      const before = i > 0 ? at(layer, i - 1) : undefined;
      const after = i + 1 < layer.length ? at(layer, i + 1) : undefined;
      if (before && next - get(centre, before) < separation(before, id)) return;
      if (after && get(centre, after) - next < separation(id, after)) return;
      centre.set(id, next);
    });
  }

  // Along the reading direction: each layer as deep as its deepest box, gaps wide enough for captions.
  const depth = layers.map((layer) => Math.max(0, ...layer.map((id) => get(slots, id).along)));
  const layerStart: number[] = [];
  let cursor = 0;
  for (let r = 0; r < layerCount; r += 1) {
    layerStart.push(cursor);
    const captionRoom = at(gapLabel, r) > 0 ? at(gapLabel, r) + CAPTION_AIR : 0;
    cursor += at(depth, r) + Math.max(spacing.layer, captionRoom);
  }

  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const id of ids) {
    const lead = get(slots, id).lead;
    minAcross = Math.min(minAcross, get(centre, id) - lead);
    maxAcross = Math.max(maxAcross, get(centre, id) - lead + across(id));
  }
  const totalAlong = at(layerStart, layerCount - 1) + at(depth, layerCount - 1);
  const totalAcross = maxAcross - minAcross;

  return {
    width: Math.round(direction === 'right' ? totalAlong : totalAcross),
    height: Math.round(direction === 'right' ? totalAcross : totalAlong),
    place: (x, y) => {
      for (const id of ids) {
        const r = get(rank, id);
        // Centred in its layer, so boxes of different depths still share a centre line.
        const a = at(layerStart, r) + (at(depth, r) - along(id)) / 2;
        const c = get(centre, id) - get(slots, id).lead - minAcross;
        env.local.set(id, direction === 'right' ? { x: x + a, y: y + c } : { x: x + c, y: y + a });
      }
    },
  };
}

/**
 * The weighted median of the neighbours' positions. On an exact tie between two neighbours it lines
 * up with one of them — the one `prefer` ranks higher — rather than sitting halfway between, where
 * *both* connectors would step sideways. One straight connector beats two skewed ones.
 */
function weightedMedian(values: { value: number; weight: number; prefer: number }[], ties: 'align' | 'balance'): number {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, v) => s + v.weight, 0);
  let acc = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const here = at(sorted, i);
    acc += here.weight;
    if (acc * 2 === total && i + 1 < sorted.length) {
      const next = at(sorted, i + 1);
      if (ties === 'balance') return (here.value + next.value) / 2;
      return here.prefer >= next.prefer ? here.value : next.value;
    }
    if (acc * 2 > total) return here.value;
  }
  return at(sorted, sorted.length - 1).value;
}

/**
 * The positions closest (weighted least squares) to `desired` that keep each consecutive pair at
 * least `gaps[i]` apart, in order: pool-adjacent-violators on the gap-shifted values.
 */
export function isotonic(desired: number[], weights: number[], gaps: number[]): number[] {
  const n = desired.length;
  if (n === 0) return [];
  const offset = [0];
  for (let i = 1; i < n; i += 1) offset.push(at(offset, i - 1) + at(gaps, i - 1));
  const blocks: { value: number; weight: number; count: number }[] = [];
  for (let i = 0; i < n; i += 1) {
    blocks.push({ value: at(desired, i) - at(offset, i), weight: Math.max(at(weights, i), 1e-6), count: 1 });
    while (blocks.length > 1 && at(blocks, blocks.length - 2).value > at(blocks, blocks.length - 1).value) {
      const b = blocks.pop() as (typeof blocks)[number];
      const a = blocks.pop() as (typeof blocks)[number];
      const weight = a.weight + b.weight;
      blocks.push({ value: (a.value * a.weight + b.value * b.weight) / weight, weight, count: a.count + b.count });
    }
  }
  const out: number[] = [];
  for (const block of blocks) for (let k = 0; k < block.count; k += 1) out.push(block.value);
  return out.map((v, i) => v + at(offset, i));
}

function crossings(layers: string[][], down: Map<string, Neighbour[]>, position: Map<string, number>): number {
  let count = 0;
  for (let r = 0; r + 1 < layers.length; r += 1) {
    const pairs: [number, number][] = [];
    for (const id of at(layers, r)) for (const next of get(down, id)) pairs.push([get(position, id), get(position, next.id)]);
    for (let i = 0; i < pairs.length; i += 1) {
      const [a1, b1] = at(pairs, i);
      for (let j = i + 1; j < pairs.length; j += 1) {
        const [a2, b2] = at(pairs, j);
        if ((a1 < a2 && b1 > b2) || (a1 > a2 && b1 < b2)) count += 1;
      }
    }
  }
  return count;
}
