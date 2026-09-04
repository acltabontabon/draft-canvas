import { MOD_SYMBOL } from '../lib/platform';

/**
 * Phase 7.1 — the small, fixed catalog of contextual hints. Each one is a single sentence folded
 * into a popover that selecting the element already opens (`ElementInspectorPopover`,
 * `EdgeInspectorPopover`) — never a second floating box competing with the first. See
 * `HintStrip.tsx` for how a hint actually renders and retires.
 */
export const HINT_IDS = [
  'service-node',
  'attachment-slot',
  'connector-selected',
  'connector-attachment-slot',
  'command-palette',
] as const;

export type HintId = (typeof HINT_IDS)[number];

export const HINT_COPY: Record<HintId, string> = {
  'service-node': 'Attach a note or code snippet to add detail to this service.',
  'attachment-slot': 'Attach a note or code snippet to add context to this element.',
  'connector-selected': 'Connections can describe HTTP, events, callbacks, and other interactions.',
  'connector-attachment-slot': 'Drag a note or code card onto this connector to attach it as detail.',
  // Phase 8 — shown on a selected node once its own hints are out of the way; retires the first
  // time the palette opens (Phase 7.2's "open the command menu once"), see `CommandPalette.tsx`.
  'command-palette': `Press ${MOD_SYMBOL}K to act on this from the keyboard — connect it, spotlight it, or start a flow here.`,
};
