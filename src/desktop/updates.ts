import type { UpdateSnapshot } from './api';

/**
 * What the page says about an update, decided from the shell's snapshot alone. Pure, so every state
 * is tested here rather than by clicking through a real download.
 */

export type UpdateAction = 'download' | 'install' | 'later';

export interface UpdateView {
  /** The notice in Home's corner and the status bar. Null: nothing worth interrupting anyone for. */
  chip: string | null;
  /** The chip wants a look (an update to take) or is only reporting (a download under way). */
  tone: 'news' | 'busy';
  /** The version on offer, if one is. */
  version: string | null;
  notes: string | null;
  /** 0–1, or null for a download of unknown size: a gauge that travels, not one that lies. */
  progress: number | null | undefined;
  /** What the panel says under the versions. */
  detail: string | null;
  actions: UpdateAction[];
  /** Something went wrong, in words for a person. */
  problem: string | null;
}

const NOTHING: UpdateView = {
  chip: null,
  tone: 'news',
  version: null,
  notes: null,
  progress: undefined,
  detail: null,
  actions: [],
  problem: null,
};

export function describeUpdate(snapshot: UpdateSnapshot | null): UpdateView {
  if (!snapshot) return NOTHING;
  const { state } = snapshot;
  // Download and install are always asked for, so their failures are always shown; a background check
  // that failed isn't worth a word.
  const problem = snapshot.error && (snapshot.error.manual || snapshot.error.stage !== 'check') ? snapshot.error.message : null;
  switch (state.phase) {
    case 'available':
      return {
        ...NOTHING,
        chip: snapshot.dismissed && !problem ? null : `Update available · ${state.info.version}`,
        version: state.info.version,
        notes: state.info.notes,
        detail: 'Downloading doesn’t interrupt anything. Nothing is installed until you say so.',
        actions: ['download', 'later'],
        problem,
      };
    case 'downloading':
      return {
        ...NOTHING,
        chip: state.total ? `Downloading · ${Math.floor((state.received / state.total) * 100)}%` : 'Downloading update…',
        tone: 'busy',
        version: state.info.version,
        notes: state.info.notes,
        progress: state.total ? Math.min(1, state.received / state.total) : null,
        detail: 'Keep working. Draft Canvas says when it’s ready.',
        actions: ['later'],
      };
    case 'ready':
      return {
        ...NOTHING,
        chip: snapshot.dismissed && !snapshot.held ? null : 'Restart to update',
        version: state.info.version,
        notes: state.info.notes,
        detail:
          snapshot.held ??
          'Updating closes Draft Canvas and opens the new version. Anything unsaved is kept first, and a file with changes asks before it closes.',
        actions: ['install', 'later'],
        problem,
      };
    case 'installing':
      return {
        ...NOTHING,
        chip: 'Updating…',
        tone: 'busy',
        version: state.info.version,
        notes: state.info.notes,
        detail: 'Keeping your work, then restarting into the new version.',
      };
    default:
      return { ...NOTHING, problem };
  }
}

/** The one line Settings shows about updates, whatever the state. */
export function updateStatusLine(snapshot: UpdateSnapshot | null, now: number = Date.now()): string {
  if (!snapshot) return 'Checking whether updates work here…';
  // Settings is somewhere a person goes to look, so even a background check that failed is said here.
  if (snapshot.error) return snapshot.error.message;
  const { state } = snapshot;
  switch (state.phase) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return `Up to date. Checked ${whenChecked(state.checkedMs, now)}.`;
    case 'available':
      return `Version ${state.info.version} is available.`;
    case 'downloading':
      return `Downloading version ${state.info.version}…`;
    case 'ready':
      return `Version ${state.info.version} is downloaded and ready.`;
    case 'installing':
      return `Updating to ${state.info.version}…`;
    case 'unavailable':
      return state.reason;
  }
}

function whenChecked(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Whether a person can ask for a check right now. */
export function canCheck(snapshot: UpdateSnapshot | null): boolean {
  const phase = snapshot?.state.phase;
  return phase === 'idle' || phase === 'up-to-date' || phase === 'available';
}

/** Release notes as the changelog writes them: `### Heading` sections of `- item` lines. */
export type NoteBlock = { kind: 'heading'; text: string } | { kind: 'item'; text: string } | { kind: 'text'; text: string };

export function parseNotes(notes: string | null): NoteBlock[] {
  if (!notes) return [];
  const blocks: NoteBlock[] = [];
  let afterBlank = true;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      afterBlank = true;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (heading) blocks.push({ kind: 'heading', text: heading[1]! });
    else if (item) blocks.push({ kind: 'item', text: item[1]! });
    // A wrapped bullet continues the item above it, and a wrapped line its paragraph.
    else if (last && !afterBlank && ((last.kind === 'item' && /^\s/.test(raw)) || last.kind === 'text')) last.text = `${last.text} ${line}`;
    else blocks.push({ kind: 'text', text: line });
    afterBlank = false;
  }
  return blocks;
}

/** `**bold**` and `` `code` `` are all the changelog uses inline; everything else is plain text. */
export function inlineParts(text: string): { kind: 'text' | 'strong' | 'code'; text: string }[] {
  const parts: { kind: 'text' | 'strong' | 'code'; text: string }[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > at) parts.push({ kind: 'text', text: text.slice(at, match.index) });
    parts.push(match[1] !== undefined ? { kind: 'strong', text: match[1] } : { kind: 'code', text: match[2]! });
    at = match.index! + match[0].length;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}
