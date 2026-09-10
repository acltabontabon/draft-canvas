import { ALL_PRESETS } from '../canvas/presets';
import { categoryOf } from '../document/connectorSemantics';
import type { DraftNode } from '../document/types';
import { canvasCommands, createCommandAt, edgeCommands, multiCommands, nodeCommands, pasteAtCommand } from './registry';
import type { Command, CommandContext } from './types';
import type { ContextMenuTarget } from '../store/uiStore';

/**
 * A right-click menu is a small, curated subset of what `commandsFor` already knows how to build —
 * never a parallel command catalog. Every entry here is a real `Command` sourced from `registry.ts`
 * (the same object the ⌘K palette would show, same `id`/`run`), just picked, ordered, and grouped
 * differently for a menu that should show only what's useful for *this* thing, right now — see
 * `docs/ARCHITECTURE.md`'s "Command surface" section.
 *
 * Hard rule, applied uniformly rather than as one-off exclusions: a context-menu entry never wraps a
 * command whose `run()` can return a `CommandStage` (a follow-up picker, e.g. "Connect to…" or
 * "Change relationship…") — this is a plain single-level menu with no flyouts, so those stay
 * ⌘K-only.
 */

export type ContextMenuEntry = { type: 'separator' } | { type: 'command'; command: Command };

const SEPARATOR: ContextMenuEntry = { type: 'separator' };
const item = (command: Command): ContextMenuEntry => ({ type: 'command', command });

/** Pulls named ids out of a command list in a specific order, silently skipping any id the source
 *  function didn't include (e.g. `flow-start-here` when there's no outgoing edge) — this is what
 *  keeps a curated menu correct without hand-duplicating each command's own gating logic here. */
function pick(commands: Command[], ids: readonly string[]): Command[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return ids.map((id) => byId.get(id)).filter((command): command is Command => command !== undefined);
}

/** Interleaves `[group, group, group]` with separators, dropping any group that ended up empty
 *  (e.g. every id in it was gated out) so a menu never shows two separators in a row. */
function grouped(groups: Command[][]): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (entries.length > 0) entries.push(SEPARATOR);
    entries.push(...group.map(item));
  }
  return entries;
}

/** A node's `x`/`y` is its top-left, not its center — this is the same `-88,-34` (half of the
 *  default 176×68 node size) convention `createAtPointer`/the double-click-to-create flow already
 *  use, so a menu-placed node lands under the cursor the same way every other creation path does.
 *  Only "Add X" needs this: `flowPosition` itself is the literal click point, which is exactly what
 *  Paste wants (it computes its own centering from the pasted fragment's real bounding box). */
function centeredOn(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x - 88, y: point.y - 34 };
}

function paneMenu(ctx: CommandContext, flowPosition: { x: number; y: number }): ContextMenuEntry[] {
  const paste = pasteAtCommand(ctx, flowPosition);
  const addCommands = ALL_PRESETS.map((preset) => createCommandAt(preset, centeredOn(flowPosition)));
  const selectAll = pick(canvasCommands(ctx), ['select-all']);
  return grouped([paste ? [paste] : [], addCommands, selectAll]);
}

/** A Junction is a routing point, not a content holder — no Add Note/Add Code, and only the two
 *  z-order extremes (not the single-step Bring Forward/Send Backward pair a regular node gets),
 *  matching how compact the shape itself stays. */
function junctionMenu(commands: Command[]): ContextMenuEntry[] {
  return grouped([
    pick(commands, ['edit-text']),
    pick(commands, ['duplicate', 'copy', 'cut']),
    pick(commands, ['bring-to-front', 'send-to-back']),
    pick(commands, ['spotlight']),
    pick(commands, ['delete']),
  ]);
}

function regularNodeMenu(ctx: CommandContext, node: DraftNode, commands: Command[]): ContextMenuEntry[] {
  // `flow-start-here` resolves directly only with exactly one outgoing edge — with more, its
  // `run()` returns a `CommandStage` (a picker), which the stage-command rule excludes.
  const outgoing = ctx.editor.document.edges.filter((edge) => edge.source === node.id);
  const lastGroup = outgoing.length === 1 ? ['spotlight', 'flow-start-here'] : ['spotlight'];
  return grouped([
    pick(commands, ['edit-text']),
    pick(commands, ['attach-note', 'attach-code']),
    pick(commands, ['add-consumer', 'add-dead-letter-queue', 'remove-dead-letter-queue']),
    pick(commands, ['duplicate', 'copy', 'cut']),
    pick(commands, ['bring-to-front', 'bring-forward', 'send-backward', 'send-to-back']),
    pick(commands, lastGroup),
    pick(commands, ['delete']),
  ]);
}

/** A Boundary's "Edit caption" reuses the same `edit-text` command every other node has (its title
 *  is already "Edit caption" for a `group` node — see `nodeCommands`) — no separate id needed.
 *  `select-contents` is present in `commands` only when the boundary actually has descendants (see
 *  `nodeCommands`' own gating), so `pick` already omits it correctly for an empty boundary without
 *  any extra check here. */
function boundaryMenu(commands: Command[]): ContextMenuEntry[] {
  return grouped([
    pick(commands, ['edit-text', 'select-contents']),
    pick(commands, ['attach-note', 'attach-code']),
    pick(commands, ['duplicate', 'copy', 'cut']),
    pick(commands, ['bring-to-front', 'bring-forward', 'send-backward', 'send-to-back']),
    pick(commands, ['spotlight']),
    pick(commands, ['ungroup']),
    pick(commands, ['delete']),
  ]);
}

function nodeMenu(ctx: CommandContext, node: DraftNode): ContextMenuEntry[] {
  const commands = nodeCommands(ctx, node);
  if (node.type === 'group') return boundaryMenu(commands);
  if (categoryOf(node) === 'junction') return junctionMenu(commands);
  return regularNodeMenu(ctx, node, commands);
}

/** No Duplicate/Copy/Cut — a lone connector has nothing meaningful to clone or clipboard-copy on
 *  its own (unlike a node, an edge's identity is entirely "this pair of endpoints," not something
 *  that reads as a sensible standalone duplicate). No Change relationship…/Change kind…/
 *  Reconnect…/Add to flow… either — every one of those is a `CommandStage` (a picker), excluded by
 *  the same stage-command rule as `connect-to`. */
function edgeMenu(commands: Command[]): ContextMenuEntry[] {
  return grouped([
    pick(commands, ['edit-text']),
    pick(commands, ['edge-reverse', 'edge-async', 'edge-response']),
    // Both routing entries are plain actions, not pickers, so they clear the
    // stage-command rule above. `pick` silently drops whichever is absent —
    // "Convert to junction" only exists while this connector is actually
    // drawn through a shared trunk.
    pick(commands, ['edge-route-direct', 'edge-convert-to-junction']),
    pick(commands, ['attach-note', 'attach-code']),
    pick(commands, ['spotlight']),
    pick(commands, ['delete']),
  ]);
}

/**
 * The largest of the six menus — align/distribute/clipboard/z-order/spotlight/delete all in one
 * place — and the one spot "small and intentional" and "complete" are in genuine tension. Ships the
 * full align+distribute+order set (standard across Figma/Illustrator/PowerPoint for exactly this
 * gesture) but deliberately trims to just the two z-order *extremes* (Bring to Front/Send to Back,
 * no single-step Bring Forward/Send Backward) — the single-node menu keeps the full 4-way
 * granularity, where fine reordering relative to one specific neighbor is more likely to matter than
 * for a whole group moving together.
 */
function selectionMenu(commands: Command[]): ContextMenuEntry[] {
  return grouped([
    pick(commands, ['group', 'ungroup']),
    pick(commands, [
      'align-left',
      'align-center-x',
      'align-right',
      'align-top',
      'align-center-y',
      'align-bottom',
      'distribute-x',
      'distribute-y',
    ]),
    pick(commands, ['duplicate', 'copy', 'cut']),
    pick(commands, ['bring-to-front', 'send-to-back']),
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
      return edge ? edgeMenu(edgeCommands(ctx, edge)) : [];
    }
    case 'selection': {
      const { nodes, edges } = ctx.editor.selection;
      if (nodes.length + edges.length < 2) return []; // no longer a multi-selection — see the effect that closes the menu when this happens
      return selectionMenu(multiCommands(ctx));
    }
    default:
      return [];
  }
}
