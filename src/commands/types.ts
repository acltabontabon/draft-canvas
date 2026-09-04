import type { useReactFlow } from '@xyflow/react';
import type { Preset } from '../canvas/presets';
import type { DraftNode } from '../document/types';
import type { FlowPlaybackController } from '../presentation/useFlowPlayback';
import type { EditorStore } from '../store/editorStore';
import type { UiStore } from '../store/uiStore';

/**
 * Phase 8 — the command surface's vocabulary. A command is a *thin* front-end onto an operation
 * the editor store already exposes: it never mutates the document itself, it calls the same
 * action the toolbar, popover, or keyboard shortcut would. That is what keeps the palette instant,
 * offline, undoable, and impossible to drift from the rest of the app — there is exactly one way
 * to duplicate a node, and the palette merely names it.
 */

/** Where a command sits in the list. Order here is display order when nothing is being searched. */
export type CommandGroup =
  | 'recent'
  | 'selection'
  | 'connector'
  | 'create'
  | 'flow'
  | 'jump'
  | 'view'
  | 'canvas';

export const GROUP_LABELS: Record<CommandGroup, string> = {
  recent: 'Recent',
  selection: 'Selection',
  connector: 'Connector',
  create: 'Create',
  flow: 'Flows',
  jump: 'Jump to',
  view: 'View',
  canvas: 'Canvas',
};

export const GROUP_ORDER: CommandGroup[] = [
  'recent',
  'selection',
  'connector',
  'create',
  'flow',
  'jump',
  'view',
  'canvas',
];

/** Everything a command needs to do its job — assembled by `CommandPalette` from live hooks. */
export interface CommandContext {
  /** The live editor store (`useEditorStore.getState()`): state and actions. */
  editor: EditorStore;
  /** The live UI store (`useUiStore.getState()`). */
  ui: UiStore;
  camera: Pick<
    ReturnType<typeof useReactFlow>,
    'fitView' | 'zoomIn' | 'zoomOut' | 'screenToFlowPosition' | 'setViewport'
  > & {
    /** The pane's size in pixels — what a bounds-fit needs to pick a zoom (see `focusNodes`). */
    viewWidth: number;
    viewHeight: number;
  };
  playback: FlowPlaybackController;
  /** `EditorScreen`'s own node factory, so a palette-created code card gets the same sample sizing. */
  createAt: (preset: Preset, position: { x: number; y: number }) => DraftNode;
  /** Under the pointer, or in the middle of the view — same placement the single-key shortcuts use. */
  createAtPointer: (preset: Preset) => DraftNode;
  toggleTheme: () => void;
}

/**
 * A second step for a command that needs an argument — "Connect to…" needs a target, "Add to
 * flow…" needs a flow. Returning one from `run` keeps the palette open, swaps its list for these
 * options, and shows `prompt` as a breadcrumb. Options are plain commands without a group.
 */
export interface CommandStage {
  prompt: string;
  options: CommandOption[];
}

export interface CommandOption {
  id: string;
  title: string;
  /** Extra words fuzzy search should also match — "db", "database" for Add Data Store. */
  keywords?: string[];
  /** Muted text at the right edge: a kind caption, a step count, a description. */
  hint?: string;
  /** An existing keyboard chord this command already has, shown as `<kbd>` chips — "Cmd D", "S". */
  shortcut?: string;
  run: (ctx: CommandContext) => void | CommandStage;
}

export interface Command extends CommandOption {
  group: CommandGroup;
}

export function isStage(value: unknown): value is CommandStage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'options' in value &&
    Array.isArray((value as CommandStage).options)
  );
}
