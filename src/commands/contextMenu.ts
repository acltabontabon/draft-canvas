import { ALL_PRESETS } from '../canvas/presets';
import { categoryOf, edgeRelationLabel } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import type { DraftEdge, DraftNode } from '../document/types';
import { count } from '../lib/plural';
import { QUEUE_KIND_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import {
  canvasCommands,
  arrangeSelectionCommands,
  createCommandAt,
  edgeCommands,
  multiCommands,
  nodeCommands,
  openPointCommands,
  pasteAtCommand,
  viewCommands,
} from './registry';
import type { Command, CommandContext } from './types';
import type { ContextMenuTarget } from '../store/uiStore';

/**
 * A right-click menu is a small, curated subset of what `commandsFor` already knows how to build —
 * never a parallel command catalog. Every entry here is a real `Command` sourced from `registry.ts`
 * (the same object the ⌘K palette would show, same `id`/`run`), just picked, ordered, grouped and
 * sometimes given a shorter menu label — see `docs/reference/architecture.md`'s "Command surface"
 * section.
 *
 * Hard rule, applied uniformly rather than as one-off exclusions: a context-menu entry never wraps a
 * command whose `run()` can return a `CommandStage` (a follow-up picker, e.g. "Connect to…" or
 * "Change relationship…") — this is a plain single-level menu with no flyouts, so those stay
 * ⌘K-only.
 *
 * Each menu stays short on purpose: the one-step z-order pair and Cut are left to ⌘K and their
 * shortcuts, since right-click is for the handful of things this element is most likely to need.
 */

export interface ContextMenuItem {
  command: Command;
  /** What the menu calls it, when the palette's title reads too long or too formal in a menu. */
  label: string;
}

export type AlignIcon =
  | 'align-left'
  | 'align-center-x'
  | 'align-right'
  | 'align-top'
  | 'align-center-y'
  | 'align-bottom'
  | 'distribute-x'
  | 'distribute-y';

export type ContextMenuEntry =
  | { type: 'separator' }
  /** A quiet first line naming what the menu acts on — never focusable. */
  | { type: 'header'; title: string; caption?: string }
  | ({ type: 'command' } & ContextMenuItem)
  /** Short, parallel choices laid out two to a row under a small label (the pane's shapes). */
  | { type: 'grid'; label: string; items: ContextMenuItem[] }
  /** One row of icon buttons, each named by its tooltip (a multi-selection's align set). */
  | { type: 'icons'; label: string; items: (ContextMenuItem & { icon: AlignIcon })[] };

/** Menu and toolbar wording where it differs from the palette's: the header already names the
 *  target, so "Spotlight selection" is just "Spotlight"; an attachment reads as attaching, not adding
 *  a shape; and short action labels use sentence case. */
const MENU_LABELS: Record<string, string> = {
  'attach-note': 'Attach note',
  'attach-code': 'Attach code',
  'open-point-add': 'Add open point…',
  spotlight: 'Spotlight',
  'add-consumer': 'Add consumer',
  'add-subscriber': 'Add subscriber',
  'add-data-store': 'Connect data store',
  'add-routed-service': 'Route to service',
  'arrange-selection': 'Tidy up selection',
  arrange: 'Tidy up layout',
  delete: 'Delete',
};

export const menuLabelOf = (command: Command) => MENU_LABELS[command.id] ?? command.title;
const itemOf = (command: Command): ContextMenuItem => ({ command, label: menuLabelOf(command) });

const SEPARATOR: ContextMenuEntry = { type: 'separator' };

/** Pulls named ids out of a command list in a specific order, silently skipping any id the source
 *  function didn't include (e.g. `flow-start-here` when there's no outgoing edge) — this is what
 *  keeps a curated menu correct without hand-duplicating each command's own gating logic here. */
function pick(commands: Command[], ids: readonly string[]): Command[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return ids.map((id) => byId.get(id)).filter((command): command is Command => command !== undefined);
}

type Group = Command[] | Extract<ContextMenuEntry, { type: 'grid' | 'icons' }>;

/** Interleaves groups with separators, dropping any group that ended up empty (every id in it was
 *  gated out) so a menu never shows two separators in a row. A header leads without a separator. */
function grouped(header: Extract<ContextMenuEntry, { type: 'header' }> | null, groups: Group[]): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = header ? [header] : [];
  let any = false;
  for (const group of groups) {
    const empty = Array.isArray(group) ? group.length === 0 : group.items.length === 0;
    if (empty) continue;
    if (any) entries.push(SEPARATOR);
    any = true;
    if (Array.isArray(group)) entries.push(...group.map((command) => ({ type: 'command' as const, ...itemOf(command) })));
    else entries.push(group);
  }
  return any ? entries : [];
}

/** Every runnable item in menu order — what keyboard navigation walks, grid and icon rows included. */
export function menuItemsOf(entries: ContextMenuEntry[]): ContextMenuItem[] {
  return entries.flatMap((entry) => {
    if (entry.type === 'command') return [entry];
    if (entry.type === 'grid' || entry.type === 'icons') return entry.items;
    return [];
  });
}

/** A node's `x`/`y` is its top-left, not its center — this is the same `-88,-34` (half of the
 *  default 176×68 node size) convention `createAtPointer`/the double-click-to-create flow already
 *  use, so a menu-placed node lands under the cursor the same way every other creation path does.
 *  Only "Add X" needs this: `flowPosition` itself is the literal click point, which is exactly what
 *  Paste wants (it computes its own centering from the pasted fragment's real bounding box). */
function centeredOn(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x - 88, y: point.y - 34 };
}

/** Architecture shapes first, then annotation and structure — the order people reach for them. */
const PANE_SHAPE_ORDER = ['service', 'database', 'queue', 'actor', 'component', 'boundary', 'note', 'code', 'text', 'ellipse'];

function paneMenu(ctx: CommandContext, flowPosition: { x: number; y: number }): ContextMenuEntry[] {
  const presets = PANE_SHAPE_ORDER.map((id) => ALL_PRESETS.find((preset) => preset.id === id)).filter(
    (preset) => preset !== undefined,
  );
  const shapes: ContextMenuItem[] = presets.map((preset) => ({
    command: createCommandAt(preset, centeredOn(flowPosition)),
    label: preset.label,
  }));
  const canvas = canvasCommands(ctx);
  return grouped(null, [
    [pasteAtCommand(flowPosition), ...pick(canvas, ['undo'])],
    { type: 'grid', label: 'Add here', items: shapes },
    [...pick(canvas, ['select-all']), ...pick(viewCommands(ctx), ['fit']), ...pick(canvas, ['arrange'])],
    // What acts on the whole diagram lives with the diagram, now that the header has no ⋯ for it.
    pick(canvas, ['find-replace', 'settings']),
  ]);
}

const KIND_CAPTIONS: Record<DraftNode['type'], string> = {
  ellipse: 'Junction',
  text: 'Text',
  note: 'Note',
  code: 'Code',
  group: 'Boundary',
  service: 'Service',
  database: 'Data Store',
  queue: 'Queue',
  actor: 'Actor',
  component: 'Component',
};

function nodeHeader(node: DraftNode): Extract<ContextMenuEntry, { type: 'header' }> {
  const caption = node.type === 'queue' ? QUEUE_KIND_OPTION_LABELS[node.queueKind ?? 'queue'] : KIND_CAPTIONS[node.type];
  // A note, code card or text box's "name" is its body, which can run to paragraphs — one line of
  // it is enough to say which one this is.
  const name = (displayNameFor(node).split('\n')[0] ?? '').trim();
  return !name || name === caption ? { type: 'header', title: caption } : { type: 'header', title: name, caption };
}

/** The connector's own label, or the caption its relationship draws on the canvas ("consumed by"). */
function edgeHeader(ctx: CommandContext, edge: DraftEdge): Extract<ContextMenuEntry, { type: 'header' }> {
  const label = (edge.label || edgeRelationLabel(ctx.editor.document, edge))?.split('\n')[0]?.trim();
  return label ? { type: 'header', title: label, caption: 'Connector' } : { type: 'header', title: 'Connector' };
}

const COPY_AND_ORDER = ['duplicate', 'copy', 'bring-to-front', 'send-to-back'];
const ATTACH = ['attach-note', 'attach-code', 'open-point-add'];

/** A Junction is a routing point, not a content holder — no Add Note/Add Code. */
function junctionMenu(node: DraftNode, commands: Command[]): ContextMenuEntry[] {
  return grouped(nodeHeader(node), [
    pick(commands, ['edit-text']),
    pick(commands, COPY_AND_ORDER),
    pick(commands, ['spotlight']),
    pick(commands, ['delete']),
  ]);
}

function regularNodeMenu(ctx: CommandContext, node: DraftNode, commands: Command[]): ContextMenuEntry[] {
  // `flow-start-here` resolves directly only with exactly one outgoing edge — with more, its
  // `run()` returns a `CommandStage` (a picker), which the stage-command rule excludes.
  const outgoing = ctx.editor.document.edges.filter((edge) => edge.source === node.id);
  const lastGroup = outgoing.length === 1 ? ['spotlight', 'flow-start-here'] : ['spotlight'];
  return grouped(nodeHeader(node), [
    pick(commands, ['edit-text', 'look-inside']),
    pick(commands, ['add-consumer', 'add-dead-letter-queue', 'remove-dead-letter-queue', 'add-subscriber']),
    pick(commands, ATTACH),
    pick(commands, COPY_AND_ORDER),
    pick(commands, lastGroup),
    pick(commands, ['delete']),
  ]);
}

/** A Boundary's "Edit caption" reuses the same `edit-text` command every other node has (its title
 *  is already "Edit caption" for a `group` node — see `nodeCommands`) — no separate id needed.
 *  `select-contents` is present in `commands` only when the boundary actually has descendants (see
 *  `nodeCommands`' own gating), so `pick` already omits it correctly for an empty boundary. Tidying
 *  stays here, unlike on a single shape: for a boundary it lays out everything inside. */
function boundaryMenu(node: DraftNode, commands: Command[]): ContextMenuEntry[] {
  return grouped(nodeHeader(node), [
    pick(commands, ['edit-text', 'select-contents', 'arrange-selection']),
    pick(commands, ATTACH),
    pick(commands, COPY_AND_ORDER),
    pick(commands, ['spotlight']),
    pick(commands, ['ungroup', 'delete']),
  ]);
}

function nodeMenu(ctx: CommandContext, node: DraftNode): ContextMenuEntry[] {
  // Raising a point lives in its own builder (it is a canvas-level command, not a node one), so it
  // is borrowed in here the same way `paneMenu` borrows Select all — one command object, picked
  // into a second menu, never a second copy of it.
  const commands = [...arrangeSelectionCommands(ctx), ...nodeCommands(ctx, node), ...pick(openPointCommands(ctx), ['open-point-add'])];
  if (node.type === 'group') return boundaryMenu(node, commands);
  if (categoryOf(node) === 'junction') return junctionMenu(node, commands);
  return regularNodeMenu(ctx, node, commands);
}

/** No Duplicate/Copy/Cut — a lone connector has nothing meaningful to clone or clipboard-copy on
 *  its own (unlike a node, an edge's identity is entirely "this pair of endpoints," not something
 *  that reads as a sensible standalone duplicate). No Change relationship…/Change kind…/
 *  Reconnect…/Add to flow… either — every one of those is a `CommandStage` (a picker), excluded by
 *  the same stage-command rule as `connect-to`. */
function edgeMenu(ctx: CommandContext, edge: DraftEdge, commands: Command[]): ContextMenuEntry[] {
  return grouped(edgeHeader(ctx, edge), [
    pick(commands, ['edit-text']),
    // The routing entries are plain actions, not pickers, so they clear the stage-command rule
    // above. `pick` silently drops whichever is absent — "Convert to junction" only exists while
    // this connector is actually drawn through a shared trunk.
    pick(commands, [
      'edge-reverse',
      'edge-async',
      'edge-response',
      'edge-reset-route',
      'edge-route-direct',
      'edge-convert-to-junction',
    ]),
    pick(commands, ATTACH),
    pick(commands, ['spotlight']),
    pick(commands, ['delete']),
  ]);
}

const ALIGN_IDS: AlignIcon[] = [
  'align-left',
  'align-center-x',
  'align-right',
  'align-top',
  'align-center-y',
  'align-bottom',
  'distribute-x',
  'distribute-y',
];

/** Align and distribute are eight parallel choices that read better as one row of pictures than as
 *  eight rows of words; each keeps its full title as the tooltip and accessible name. Only the two
 *  z-order extremes here — fine reordering against one neighbour matters for a single shape, not a
 *  group moving together. */
function selectionMenu(ctx: CommandContext, commands: Command[]): ContextMenuEntry[] {
  const { nodes, edges } = ctx.editor.selection;
  const align = pick(commands, ALIGN_IDS).map((command) => ({ ...itemOf(command), icon: command.id as AlignIcon }));
  return grouped({ type: 'header', title: count(nodes.length + edges.length, 'element') }, [
    // One shared point for everything selected — the header already says how many.
    pick(commands, ['group', 'ungroup', 'arrange-selection', 'open-point-add']),
    { type: 'icons', label: 'Align and distribute', items: align },
    pick(commands, COPY_AND_ORDER),
    pick(commands, ['spotlight']),
    pick(commands, ['delete']),
  ]);
}

export function contextMenuCommandsFor(
  ctx: CommandContext,
  target: ContextMenuTarget,
  flowPosition: { x: number; y: number },
): ContextMenuEntry[] {
  switch (target.kind) {
    case 'pane':
      return paneMenu(ctx, flowPosition);
    case 'node': {
      const node = ctx.editor.document.nodes.find((entry) => entry.id === target.id);
      return node ? nodeMenu(ctx, node) : [];
    }
    case 'edge': {
      const edge = ctx.editor.document.edges.find((entry) => entry.id === target.id);
      return edge
        ? edgeMenu(ctx, edge, [...edgeCommands(ctx, edge), ...pick(openPointCommands(ctx), ['open-point-add'])])
        : [];
    }
    case 'selection': {
      const { nodes, edges } = ctx.editor.selection;
      if (nodes.length + edges.length < 2) return []; // no longer a multi-selection — see the effect that closes the menu when this happens
      return selectionMenu(ctx, [...arrangeSelectionCommands(ctx), ...multiCommands(ctx), ...pick(openPointCommands(ctx), ['open-point-add'])]);
    }
    default:
      return [];
  }
}
