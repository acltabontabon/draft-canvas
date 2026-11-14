import { createId } from './ids';
import { LIMITS } from './limits';
import { finite, oneOf, oneOfOptional, safeId, text } from './validationValues';
import { clamp } from '../lib/math';
import { isRecord } from '../lib/isRecord';
import {
  ACCENTS, ATTACHABLE_TYPES, CODE_LANGUAGES, NOTE_KINDS,
  type Accent, type AttachableType, type Attachment, type CodeLanguage, type DraftNode, type DraftNodeType, type NoteKind,
} from './types';

/**
 * The `note`/`code` field pairs shared by a top-level node and an attachment —
 * both are "a Note or a Code card's content," so this is the one place that
 * knows how to read them out of an untrusted candidate object.
 */
export function validateAttachableFields(
  candidate: Record<string, unknown>,
  type: DraftNodeType | AttachableType,
): Pick<DraftNode, 'noteKind' | 'language' | 'code'> {
  const fields: Pick<DraftNode, 'noteKind' | 'language' | 'code'> = {};
  if (type === 'note') {
    fields.noteKind = oneOf<NoteKind>(candidate.noteKind, NOTE_KINDS, 'note');
  }
  if (type === 'code') {
    fields.language = oneOf<CodeLanguage>(candidate.language, CODE_LANGUAGES, 'plaintext');
    fields.code = text(candidate.code, LIMITS.maxCodeLength) ?? '';
  }
  return fields;
}

/**
 * A host's attachment list — shared by nodes and connectors, which carry the identical shape. Keeps
 * at most `max`, gives missing or duplicate ids fresh ones, and keeps a card's size (detaching
 * restores it at the size it had, not a default). Counts what it dropped and cut so the caller can
 * report it.
 */
export function parseAttachments(
  value: unknown,
  max: number,
): { attachments: Attachment[]; dropped: number; truncated: number } {
  const raw = Array.isArray(value) ? value : [];
  const attachments: Attachment[] = [];
  const seenIds = new Set<string>();
  let dropped = 0;
  for (const rawAttachment of raw.slice(0, max)) {
    if (!isRecord(rawAttachment)) {
      dropped += 1;
      continue;
    }
    let id = safeId(rawAttachment.id);
    if (!id || seenIds.has(id)) id = createId('a');
    seenIds.add(id);

    const type = oneOf<AttachableType>(rawAttachment.type, ATTACHABLE_TYPES, 'note');
    const attachment: Attachment = { id, type };

    const label = text(rawAttachment.text, LIMITS.maxTextLength);
    if (label !== undefined) attachment.text = label;

    const accent = oneOfOptional<Accent>(rawAttachment.accent, ACCENTS);
    if (accent !== undefined) attachment.accent = accent;

    Object.assign(attachment, validateAttachableFields(rawAttachment, type));

    const width = finite(rawAttachment.width, Number.NaN);
    const height = finite(rawAttachment.height, Number.NaN);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      attachment.width = clamp(width, LIMITS.minNodeSize, LIMITS.maxNodeSize);
      attachment.height = clamp(height, LIMITS.minNodeSize, LIMITS.maxNodeSize);
    }

    attachments.push(attachment);
  }
  return { attachments, dropped, truncated: Math.max(0, raw.length - max) };
}
