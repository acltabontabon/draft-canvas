/**
 * Commit messages: a factual summary line, an optional body, and Git trailers that say how a
 * revision came to be. Standard `git log` shows all of it; `git interpret-trailers` parses it.
 *
 * Every value is untrusted on the way in (a collaborator's display name, an agent's label, a
 * diagram's title) and on the way out (a bundle or remote can carry any message), so both
 * directions go through `clean`: no line breaks or control characters, so nothing can forge a
 * header or a trailer, and a bounded length. Names are labelled unverified where they are: Git
 * author metadata is not identity.
 */
import { HISTORY_LIMITS, type Oid } from './contracts';
import { isOid } from './refs';

/** Who or what started a revision. The recorder (Git committer) is always this device. */
export type Initiator = 'auto' | 'manual' | 'agent' | 'restore' | 'merge' | 'external' | 'remote' | 'import';

const INITIATORS: readonly Initiator[] = ['auto', 'manual', 'agent', 'restore', 'merge', 'external', 'remote', 'import'];

export interface Trailers {
  initiator: Initiator;
  documentId?: string;
  categories?: string[];
  /** People whose changes the captured snapshot actually contains, as their sessions named them. */
  contributors?: string[];
  /** Agents whose reviewed changes it contains. */
  agents?: string[];
  restoredFrom?: Oid;
  /** The collaboration commit number the snapshot was captured at, on the owner's side. */
  collabSeq?: number;
  lineage?: { repoId: string; oid: Oid };
  /** The alternative the revision was made on, by id (names change, ids never do). */
  alternative?: string;
}

export interface RevisionMessage {
  summary: string;
  body?: string[];
  trailers: Trailers;
}

// Control characters, and the two Unicode line separators some readers break lines at.
const UNSAFE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');

/** One line of untrusted text made safe for a commit message. */
export function clean(value: string, max: number = HISTORY_LIMITS.maxTrailerValue): string {
  const flat = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

const KEY = {
  initiator: 'Draft-Canvas-Initiator',
  documentId: 'Draft-Canvas-Document-Id',
  categories: 'Draft-Canvas-Categories',
  contributor: 'Draft-Canvas-Contributor',
  agent: 'Draft-Canvas-Agent',
  restoredFrom: 'Draft-Canvas-Restored-From',
  collabSeq: 'Draft-Canvas-Collab-Seq',
  lineage: 'Draft-Canvas-Lineage',
  alternative: 'Draft-Canvas-Alternative',
} as const;

const UNVERIFIED = ' (unverified)';

export function formatMessage(message: RevisionMessage): string {
  const lines: string[] = [clean(message.summary, 120) || 'Update diagram'];
  const body = (message.body ?? []).map((line) => clean(line, 160)).filter(Boolean).slice(0, 40);
  if (body.length > 0) lines.push('', ...body);
  const t = message.trailers;
  const trailers: string[] = [`${KEY.initiator}: ${t.initiator}`];
  if (t.documentId) trailers.push(`${KEY.documentId}: ${clean(t.documentId, 80)}`);
  if (t.alternative) trailers.push(`${KEY.alternative}: ${clean(t.alternative, 80)}`);
  if (t.categories?.length) trailers.push(`${KEY.categories}: ${t.categories.map((c) => clean(c, 40)).join(', ')}`);
  for (const name of unique(t.contributors ?? []).slice(0, 20)) trailers.push(`${KEY.contributor}: ${clean(name, 80)}${UNVERIFIED}`);
  for (const name of unique(t.agents ?? []).slice(0, 10)) trailers.push(`${KEY.agent}: ${clean(name, 80)}`);
  if (t.restoredFrom && isOid(t.restoredFrom)) trailers.push(`${KEY.restoredFrom}: ${t.restoredFrom}`);
  if (t.collabSeq !== undefined && Number.isSafeInteger(t.collabSeq) && t.collabSeq >= 0) trailers.push(`${KEY.collabSeq}: ${t.collabSeq}`);
  if (t.lineage && isOid(t.lineage.oid)) trailers.push(`${KEY.lineage}: ${clean(t.lineage.repoId, 64)}@${t.lineage.oid}`);
  lines.push('', ...trailers);
  const text = `${lines.join('\n')}\n`;
  return utf8Length(text) <= HISTORY_LIMITS.maxMessageBytes ? text : `${withinBytes(text, HISTORY_LIMITS.maxMessageBytes - 1)}\n`;
}

// The limit is in UTF-8 bytes, as the desktop store checks it (`history/objects.rs`). It was once
// measured in UTF-16 units here: a message of CJK names or labels passed this check, was refused by
// the desktop on every capture and retried with backoff forever — and the cut could split a
// surrogate pair. Measured and cut in bytes now, only ever between whole code points.
const utf8 = new TextEncoder();

function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

/** The longest start of `text`, in whole code points, that fits in `max` UTF-8 bytes. */
function withinBytes(text: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > max) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))].sort();
}

/**
 * Reads a message written by `formatMessage` — or by anyone: a message without trailers reads as an
 * `import` revision whose summary is its first line. Nothing here is trusted; every value is
 * cleaned again and anything malformed is dropped.
 */
export function parseMessage(text: string): RevisionMessage {
  const normalized = text.length > HISTORY_LIMITS.maxMessageBytes ? withinBytes(text, HISTORY_LIMITS.maxMessageBytes) : text;
  const paragraphs = normalized.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
  const summary = clean(paragraphs[0]?.split('\n')[0] ?? '', 120) || 'Untitled revision';
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]! : '';
  const trailerLines = last.split('\n').filter((line) => /^Draft-Canvas-[A-Za-z-]+: /.test(line));
  const hasTrailers = trailerLines.length > 0 && trailerLines.length === last.split('\n').length;
  const bodyParagraphs = paragraphs.slice(1, hasTrailers ? -1 : undefined);
  const body = bodyParagraphs.flatMap((p) => p.split('\n')).map((line) => clean(line, 160)).filter(Boolean).slice(0, 40);
  const trailers: Trailers = { initiator: hasTrailers ? 'auto' : 'import' };
  if (hasTrailers) {
    for (const line of trailerLines) {
      const at = line.indexOf(': ');
      const key = line.slice(0, at);
      const value = clean(line.slice(at + 2));
      switch (key) {
        case KEY.initiator:
          if ((INITIATORS as readonly string[]).includes(value)) trailers.initiator = value as Initiator;
          break;
        case KEY.documentId:
          trailers.documentId = value;
          break;
        case KEY.alternative:
          trailers.alternative = value;
          break;
        case KEY.categories:
          trailers.categories = value.split(',').map((part) => clean(part, 40)).filter(Boolean).slice(0, 20);
          break;
        case KEY.contributor:
          (trailers.contributors ??= []).push(value.endsWith(UNVERIFIED) ? value.slice(0, -UNVERIFIED.length) : value);
          break;
        case KEY.agent:
          (trailers.agents ??= []).push(value);
          break;
        case KEY.restoredFrom:
          if (isOid(value)) trailers.restoredFrom = value;
          break;
        case KEY.collabSeq: {
          const seq = Number(value);
          if (Number.isSafeInteger(seq) && seq >= 0) trailers.collabSeq = seq;
          break;
        }
        case KEY.lineage: {
          const [repoId, oid] = value.split('@');
          if (repoId && oid && isOid(oid)) trailers.lineage = { repoId, oid };
          break;
        }
      }
    }
  }
  return { summary, ...(body.length > 0 ? { body } : {}), trailers };
}
