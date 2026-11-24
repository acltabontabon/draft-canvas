import type { NoteKind } from '../document/types';

// A leaf, imported by `describe.ts` and by `attachmentLook.ts`. While these two tables lived in
// `describe.ts`, an attachment's look imported the whole node renderer for them, which closed a ring
// of five modules across `nodes/`, `edges/` and `sequence/`.

/** Notes are colour-coded by intent — the whole point of having four kinds. Shared so an edge
 *  attachment (`AttachmentChipRow` in `AttachmentPresentation.tsx`) can match a note's own look exactly
 *  rather than duplicating this table. */
export const NOTE_ACCENTS: Record<NoteKind, 'amber' | 'blue' | 'rose' | 'green'> = {
  note: 'amber',
  question: 'blue',
  warning: 'rose',
  decision: 'green',
};

/** The tag drawn on a note and on an attachment's chip. (`lib/nodeKindLabels.ts` holds the names an
 *  inspector's option list shows, which are set in sentence case.) */
export const NOTE_LABELS: Record<NoteKind, string> = {
  note: 'NOTE',
  question: 'QUESTION',
  warning: 'WARNING',
  decision: 'DECISION',
};
