/**
 * What an attachment looks like wherever it's shown — its chip and editing card
 * (`AttachmentPresentation.tsx`) and Presentation Mode's callout. Kept out of those component files
 * so they keep fast refresh.
 */
import type { Attachment } from '../document/types';
import { NOTE_ACCENTS, NOTE_LABELS } from '../nodes/describe';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { accentOf, type Theme } from '../render/theme/tokens';

/** What a chip/card looks like for one attachment — matches the corresponding card type's own
 *  real styling exactly (`nodes/describe.ts`'s `note`/`codeCard`), rather than a generic box, so
 *  a Note attachment reads as a note and a Code one reads as code. */
export interface AttachmentLook {
  fill: string;
  border: string;
  accent: string;
  headerBg?: string;
  label: string;
}

/** Everything the look depends on. Widened from `Attachment` to the fields it actually reads so a
 *  `DraftNode` can be passed straight in — the drag capsule (`DragCapsule.tsx`) draws the card it is
 *  standing in for as the chip that card is about to become, from this one function. */
export type LookSubject = Pick<Attachment, 'type' | 'noteKind' | 'language' | 'accent'>;

export function attachmentLookFor(theme: Theme, attachment: LookSubject): AttachmentLook {
  if (attachment.type === 'code') {
    const language = attachment.language ?? 'plaintext';
    return {
      fill: theme.codeBg,
      border: theme.codeBorder,
      accent: theme.textFaint,
      headerBg: theme.surfaceRaised,
      label: LANGUAGE_LABELS[language],
    };
  }
  const kind = attachment.noteKind ?? 'note';
  const palette = accentOf(theme, attachment.accent ?? NOTE_ACCENTS[kind]);
  return { fill: palette.fill, border: palette.line, accent: palette.chip, label: NOTE_LABELS[kind] };
}
