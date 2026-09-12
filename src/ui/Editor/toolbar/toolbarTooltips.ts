import type { PrimitiveTooltipContent } from '../../../canvas/presets';
import { shortcutFor } from '../../../commands/shortcutLookup';
import { MOD_SYMBOL } from '../../../lib/platform';

/**
 * Tooltip copy for the toolbar's *actions* — what you do to the workspace, as opposed to the
 * primitives you put on the canvas. Those live in `canvas/presets.ts`, which is the canvas's
 * shape vocabulary and has no business growing a "Canvas settings" entry.
 *
 * Shortcuts are read from the command registry rather than typed out here, so a rebinding can't
 * leave the bar advertising a key that no longer works — and so the modifier is spelled for the
 * platform you're actually on. The native `title` strings this replaces hardcoded "Cmd+Z" and
 * told every Windows and Linux user the wrong key.
 */
interface ToolbarTooltipSpec {
  title: string;
  /** Read the shortcut from this registered command. */
  commandId?: string;
  /** Only for keys with no command of their own to read — see the two below. */
  literalShortcut?: string;
  /** Present ⇒ the rich density. Reserved for the capabilities that genuinely need explaining;
   *  nobody needs a paragraph about Undo. */
  description?: string;
  usageHint?: string;
}

const SPECS = {
  back: { title: 'Back to your diagrams' },
  undo: { title: 'Undo', commandId: 'undo' },
  redo: { title: 'Redo', commandId: 'redo' },
  commands: {
    title: 'Commands',
    // The palette cannot offer a command that opens the palette, so there is nothing in the
    // registry to read this from.
    literalShortcut: `${MOD_SYMBOL} K`,
    description: 'Every action, searchable.',
    usageHint: 'Reach any command, flow, or starter without leaving the keyboard.',
  },
  flows: {
    title: 'Flows',
    // Handled directly by the editor's key map, not as a registered command.
    literalShortcut: 'F',
    description: 'A named, ordered walkthrough of connectors already on the canvas.',
    usageHint: 'An explanation layer over the architecture — dim everything else, or step through it.',
  },
  present: {
    title: 'Present',
    commandId: 'present',
    description: 'Shows the canvas full screen, without the editor around it.',
    usageHint: 'With a flow active, reveals it one step at a time.',
  },
  export: { title: 'Export', commandId: 'export' },
  settings: { title: 'Canvas settings', commandId: 'settings' },
  learn: {
    title: 'Learn Draft Canvas',
    commandId: 'learn-mode',
    description: 'Inline hints while you draw.',
    usageHint: 'Explains what Draft Canvas inferred — relationship types, shapes, and connector rules.',
  },
  shortcuts: { title: 'Keyboard shortcuts', commandId: 'shortcuts' },
  about: { title: 'About Draft Canvas', commandId: 'about' },
  more: { title: 'More' },
} satisfies Record<string, ToolbarTooltipSpec>;

export type ToolbarTooltipId = keyof typeof SPECS;

/**
 * Tooltips stay stateless — "About Draft Canvas", never "About Draft Canvas — what's new". State
 * belongs in the accessible name (and in the menu row's check), so a screen reader hears it
 * without a sighted user having to hover to find out.
 */
export function toolbarTooltip(id: ToolbarTooltipId): PrimitiveTooltipContent {
  const spec: ToolbarTooltipSpec = SPECS[id];
  return {
    title: spec.title,
    description: spec.description,
    usageHint: spec.usageHint,
    shortcut: spec.commandId ? shortcutFor(spec.commandId) : spec.literalShortcut,
  };
}

/** The label is the single source for a control's accessible name and its tooltip title. */
export function toolbarLabel(id: ToolbarTooltipId): string {
  return SPECS[id].title;
}
