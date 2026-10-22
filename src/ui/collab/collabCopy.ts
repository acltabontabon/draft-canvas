import type { EndReason, LinkState, Role } from '../../collab/protocol';
import { readPreference, writePreference } from '../../lib/preferences';
import type { ConnectionPreferences } from '../../collab/connect';

/** What a person sees when a session ends, by reason — always with what they can do next. */
export const END_MESSAGES: Record<EndReason, string> = {
  'owner-left': 'The owner closed the canvas, so the session ended.',
  ended: 'The owner ended the session.',
  removed: 'The owner removed you from the session.',
  version: 'Your copy of Draft Canvas and the owner’s don’t match — whoever is behind needs to update.',
  full: 'The session is full: it holds up to 10 collaborators.',
  unauthorized: 'This link isn’t valid for that session any more. Ask the owner for a new invite.',
  protocol: 'The connection sent something unreadable, so it was closed.',
  timeout: 'Lost the connection to the owner.',
  'document-changed': 'The owner switched to another canvas, so the session ended.',
  'too-large': 'This diagram is too large to share live. Ask the owner to export it instead.',
  denied: 'The owner didn’t let you in.',
};

export const ROLE_LABELS: Record<Role, string> = {
  editor: 'Can edit',
  viewer: 'Can view',
};

export const LINK_LABELS: Record<LinkState, string> = {
  connecting: 'Connecting…',
  live: 'Connected',
  reconnecting: 'Reconnecting…',
  gone: 'Disconnected',
};

/** Up to two initials, for the little round badge each person wears. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!].map((word) => [...word][0]) : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase();
}

const NAME_KEY = 'collab.name';
const NETWORK_KEY = 'collab.network';
const SERVER_KEY = 'collab.stun';

export function readDisplayName(): string {
  return readPreference(NAME_KEY) ?? '';
}

export function writeDisplayName(name: string): void {
  writePreference(NAME_KEY, name.trim().slice(0, 40));
}

export function readConnectionPreferences(): ConnectionPreferences {
  return { localOnly: readPreference(NETWORK_KEY) === 'local', server: readPreference(SERVER_KEY) ?? '' };
}

export function writeConnectionPreferences(preferences: ConnectionPreferences): void {
  writePreference(NETWORK_KEY, preferences.localOnly ? 'local' : 'internet');
  writePreference(SERVER_KEY, preferences.server.trim().slice(0, 64));
}
