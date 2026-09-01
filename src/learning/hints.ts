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
] as const;

export type HintId = (typeof HINT_IDS)[number];

export const HINT_COPY: Record<HintId, string> = {
  'service-node': 'You can attach notes or code to this.',
  'attachment-slot': 'Add context → Note · Code.',
  'connector-selected': 'Connections can describe HTTP, events, callbacks, and other interactions.',
  'connector-attachment-slot': 'Drag a note or code card onto this connector to attach it as detail.',
};
