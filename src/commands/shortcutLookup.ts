import type { DraftEdge, DraftNode } from '../document/types';
import { commandsFor, edgeCommands, multiCommands, nodeCommands } from './registry';
import type { Command, CommandContext } from './types';

/**
 * Help-screen infrastructure only — never part of the real dispatch path (`EditorScreen.tsx`'s
 * `useKeyboard` switch stays the one place a key is actually bound to an action). This exists so
 * `ShortcutSheet.tsx` can show a command's real shortcut string by reading `Command.shortcut` —
 * the same field the palette and context menu already render as `<kbd>` chips — instead of a
 * second, hand-typed copy that can silently drift from it.
 *
 * A command's presence in `commandsFor`/`nodeCommands`/`edgeCommands`/`multiCommands` is
 * state-dependent (`undo` only exists once there's history to undo, `paste` only once the
 * clipboard is non-empty, and so on) — there's no single call that returns "every command that
 * could ever exist." So this builds one small, throwaway, never-rendered document and calls those
 * functions a handful of times with different selections, each pass chosen to make one more group
 * of conditionally-visible commands appear, and merges everything by id. It's built once (module
 * load) and cached — nothing here needs to react to the real document changing.
 */

const NODE_A: DraftNode = { id: 'shortcut-fixture-a', type: 'service', x: 0, y: 0, width: 176, height: 68, z: 0 };
const NODE_B: DraftNode = { id: 'shortcut-fixture-b', type: 'service', x: 300, y: 0, width: 176, height: 68, z: 0 };
const NODE_C: DraftNode = { id: 'shortcut-fixture-c', type: 'service', x: 600, y: 0, width: 176, height: 68, z: 0 };
const NODE_GROUP: DraftNode = { id: 'shortcut-fixture-group', type: 'group', x: 0, y: 200, width: 400, height: 200, z: 0 };
const NODE_TEXT: DraftNode = { id: 'shortcut-fixture-text', type: 'text', x: 0, y: 400, width: 200, height: 36, z: 0 };
const EDGE_A: DraftEdge = {
  id: 'shortcut-fixture-edge',
  source: NODE_A.id,
  target: NODE_B.id,
  directed: true,
  routing: 'smoothstep',
  routeMode: 'direct',
};

const FIXTURE_DOCUMENT = {
  nodes: [NODE_A, NODE_B, NODE_C, NODE_GROUP, NODE_TEXT],
  edges: [EDGE_A],
  flows: [],
};

const NOOP = () => {};
const NOOP_ASYNC = async () => true;

/**
 * A `CommandContext` built by hand rather than through React/store hooks — this module has to work
 * standalone (no live canvas, no React tree) since it runs as part of computing what the help
 * screen shows. Only the fields the command-builder functions actually read are filled in for
 * real; everything else is a harmless no-op, since nothing here ever calls a command's own `run` —
 * only `.id`/`.shortcut` are ever read off the results.
 */
function buildFixtureContext(selection: { nodes: string[]; edges: string[] }): CommandContext {
  const editor = {
    document: FIXTURE_DOCUMENT,
    selection,
    selectedFlowId: null,
    mode: 'edit',
    clipboard: { nodes: [NODE_A], edges: [] },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    canUndo: () => true,
    canRedo: () => true,
  };
  const ui = {
    continuationsEnabled: false,
    continuation: null,
    continuationDismissals: new Set(),
    learnModeActive: false,
  };
  return {
    editor,
    ui,
    camera: {
      fitView: NOOP_ASYNC,
      zoomIn: NOOP_ASYNC,
      zoomOut: NOOP_ASYNC,
      screenToFlowPosition: (p: { x: number; y: number }) => p,
      setViewport: NOOP_ASYNC,
      viewWidth: 1200,
      viewHeight: 800,
    },
    playback: {
      flows: [],
      flow: null,
      steps: [],
      step: 0,
      current: null,
      active: false,
      picking: false,
      canStart: false,
      start: NOOP,
      pickFlow: NOOP,
      stop: NOOP,
      next: NOOP,
      previous: NOOP,
      goTo: NOOP,
    },
    createAt: () => NODE_A,
    createAtPointer: () => NODE_A,
    toggleTheme: NOOP,
    // The two stores are large, real interfaces this fixture only implements a slice of — every
    // command-builder function this module calls is read directly above to confirm it never
    // touches anything past that slice. `unknown` first, not a direct cast, so TS doesn't try to
    // (and fail to) structurally match the rest of either store's real shape.
  } as unknown as CommandContext;
}

export interface ShortcutEntry {
  shortcut: string;
  /** The command's own `title` — `ShortcutSheet.tsx` falls back to this for any row that doesn't
   *  override it with its own `label`, so a row's description can't drift from the command's real
   *  name either, not just its key. */
  title: string;
}

function record(map: Map<string, ShortcutEntry>, commands: Command[]): void {
  for (const command of commands) {
    if (command.shortcut) map.set(command.id, { shortcut: command.shortcut, title: command.title });
  }
}

let cache: ReadonlyMap<string, ShortcutEntry> | null = null;

function buildCatalog(): ReadonlyMap<string, ShortcutEntry> {
  const map = new Map<string, ShortcutEntry>();

  // No selection: presets, starters, flow/view/canvas commands (undo/redo/paste all made visible
  // by the fixture's primed history + clipboard above).
  record(map, commandsFor(buildFixtureContext({ nodes: [], edges: [] })));

  const nodeCtx = buildFixtureContext({ nodes: [NODE_A.id], edges: [] });
  record(map, nodeCommands(nodeCtx, NODE_A));

  // Text-only commands (Bold/Italic/Text role…) only appear for `type: 'text'` — a second
  // single-node pass, otherwise identical, is what makes this catalog actually reach them.
  const textCtx = buildFixtureContext({ nodes: [NODE_TEXT.id], edges: [] });
  record(map, nodeCommands(textCtx, NODE_TEXT));

  const edgeCtx = buildFixtureContext({ nodes: [], edges: [EDGE_A.id] });
  record(map, edgeCommands(edgeCtx, EDGE_A));

  // Three plain nodes plus a boundary, all selected at once: >=2 unlocks Group/align, >=3 unlocks
  // Distribute, and including the boundary unlocks Ungroup — one pass covers the whole group.
  const multiCtx = buildFixtureContext({
    nodes: [NODE_A.id, NODE_B.id, NODE_C.id, NODE_GROUP.id],
    edges: [],
  });
  record(map, multiCommands(multiCtx));
  // `canvasCommands` is already folded into the no-selection `commandsFor` call above — not
  // called again here on purpose.

  return map;
}

/** The real shortcut string for a registered command, if it has one — or `undefined` if it
 *  doesn't, or isn't reachable from any of this module's fixture passes (present-mode-only
 *  commands, and anything gated on state this deliberately-minimal fixture doesn't construct). */
export function shortcutFor(commandId: string): string | undefined {
  cache ??= buildCatalog();
  return cache.get(commandId)?.shortcut;
}

/** The command's own `title`, for a help-screen row that doesn't need its own bespoke phrasing. */
export function titleFor(commandId: string): string | undefined {
  cache ??= buildCatalog();
  return cache.get(commandId)?.title;
}

/** Every `{id, {shortcut, title}}` pair this module was able to derive —
 *  `tests/shortcut-catalog.test.ts` walks it to confirm nothing with a real shortcut is missing
 *  from `ShortcutSheet.tsx`'s own `SECTIONS`, and that no two distinct commands claim the same
 *  shortcut string. */
export function shortcutCatalog(): ReadonlyMap<string, ShortcutEntry> {
  cache ??= buildCatalog();
  return cache;
}
