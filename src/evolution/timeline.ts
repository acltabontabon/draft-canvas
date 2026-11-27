/**
 * The timeline's model: revisions as the person sees them, grouped into editing sessions.
 *
 * Grouping is presentation only. Every revision stays in Git exactly as recorded; a session is a run
 * of revisions with no long pause between them, shown as one line that expands. A session's summary
 * is its *net* change — start to end — so a shape added and removed again within it does not appear
 * at all (`sessionSummary`, in the worker).
 */
import type { CommitRecord, Oid, TagRecord } from './contracts';
import { parseMessage, type Initiator } from './trailers';

/** Revisions further apart than this start a new session. */
export const SESSION_GAP_MS = 20 * 60 * 1000;

export interface Revision {
  oid: Oid;
  parents: Oid[];
  /** When it was recorded, in milliseconds. */
  at: number;
  summary: string;
  body: string[];
  initiator: Initiator;
  categories: string[];
  contributors: string[];
  agents: string[];
  recordedBy: string;
  restoredFrom?: Oid;
  alternative?: string;
  /** Named milestones that point here. */
  milestones: Milestone[];
}

export interface Milestone {
  id: string;
  name: string;
  note: string;
  at: number;
  target: Oid;
}

export function toRevision(commit: CommitRecord, milestones: Milestone[] = []): Revision {
  const message = parseMessage(commit.message);
  return {
    oid: commit.oid,
    parents: commit.parents,
    at: commit.committer.timestamp * 1000,
    summary: message.summary,
    body: message.body ?? [],
    initiator: message.trailers.initiator,
    categories: message.trailers.categories ?? [],
    contributors: message.trailers.contributors ?? [],
    agents: message.trailers.agents ?? [],
    recordedBy: commit.committer.name,
    ...(message.trailers.restoredFrom ? { restoredFrom: message.trailers.restoredFrom } : {}),
    ...(message.trailers.alternative ? { alternative: message.trailers.alternative } : {}),
    milestones: milestones.filter((milestone) => milestone.target === commit.oid),
  };
}

/** A milestone's tag message is its name, a blank line, then an optional note. */
export function toMilestone(tag: TagRecord): Milestone | null {
  const id = tag.ref.split('/').pop() ?? '';
  const [first, ...rest] = tag.message.replace(/\r\n/g, '\n').split('\n');
  const name = (first ?? '').trim();
  if (!name) return null;
  return { id, name: name.slice(0, 120), note: rest.join('\n').trim().slice(0, 1000), at: tag.tagger.timestamp * 1000, target: tag.target };
}

export function milestoneMessage(name: string, note: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = (text: string, max: number) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
  const title = clean(name.replace(/\s+/g, ' '), 120) || 'Milestone';
  const body = clean(note, 1000);
  return body ? `${title}\n\n${body}\n` : `${title}\n`;
}

export interface Session {
  /** The newest revision's id: stable while the session is still growing at its start only. */
  id: string;
  start: number;
  end: number;
  /** Newest first, as the timeline lists them. */
  revisions: Revision[];
  /** The revision before the session's first, or `null` when it starts the history. */
  before: Oid | null;
  /** The session's last revision. */
  last: Oid;
}

/** Groups revisions (newest first) into sessions (newest first). */
export function groupSessions(revisions: Revision[], gapMs: number = SESSION_GAP_MS): Session[] {
  const sessions: Session[] = [];
  let current: Revision[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const newest = current[0]!;
    const oldest = current[current.length - 1]!;
    sessions.push({ id: newest.oid, start: oldest.at, end: newest.at, revisions: current, before: oldest.parents[0] ?? null, last: newest.oid });
    current = [];
  };
  for (const revision of revisions) {
    const previous = current[current.length - 1];
    if (previous && previous.at - revision.at > gapMs) flush();
    current.push(revision);
  }
  flush();
  return sessions;
}

export interface RevisionQuery {
  text?: string;
  categories?: string[];
  /** Only revisions with milestones. */
  milestones?: boolean;
}

/**
 * Whether a revision matches a search: its words (summary, the elements its body names, who took
 * part, its milestones) and its date as the person reads dates, then its categories.
 */
export function matches(revision: Revision, query: RevisionQuery, formatDate: (at: number) => string = (at) => new Date(at).toLocaleString()): boolean {
  if (query.milestones && revision.milestones.length === 0) return false;
  if (query.categories?.length && !query.categories.some((category) => revision.categories.includes(category))) return false;
  const text = query.text?.trim().toLowerCase();
  if (!text) return true;
  const haystack = [
    revision.summary,
    ...revision.body,
    ...revision.contributors,
    ...revision.agents,
    revision.recordedBy,
    ...revision.milestones.flatMap((milestone) => [milestone.name, milestone.note]),
    formatDate(revision.at),
    revision.oid.slice(0, 12),
  ]
    .join('\n')
    .toLowerCase();
  return text.split(/\s+/).every((word) => haystack.includes(word));
}
