import type { EndReason, LinkState, Role } from '../../collab/protocol';
import { readPreference, writePreference } from '../../lib/preferences';
import type { ConnectionPreferences } from '../../collab/connect';

/**
 * Letters from other scripts drawn the same as Latin ones, and Latin pairs easily read as each other:
 * "Аlice" with a Cyrillic А, "AIice" with a capital i. Not every confusable Unicode knows — the ones a
 * name is likeliest to be dressed in. Lower case, as `nameKey` compares.
 */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', і: 'l', ї: 'l', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ь: 'b',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'l', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ζ: 'z',
  // Latin and digits read as one another
  i: 'l', '1': 'l', '|': 'l', '0': 'o', '5': 's',
};

/**
 * How two names compare for "is this the same person's name": blind to case, accents, look-alike
 * letters from other scripts, and spacing — a warning, so a false alarm is cheap and a miss is not.
 */
export function nameKey(name: string): string {
  const plain = name.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/rn/g, 'm');
  return Array.from(plain, (letter) => LOOKALIKES[letter] ?? letter)
    .join('')
    .replace(/[\s._-]+/g, '');
}

/** The names of everyone in the session (this person included), as `nameKey`s. */
export function takenNameKeys(state: { selfName: string; peers: readonly { name: string; link: string }[] }): string[] {
  return [state.selfName, ...state.peers.filter((peer) => peer.link !== 'gone').map((peer) => peer.name)].map(nameKey);
}

/**
 * Whether someone at the door goes by a name like one already taken: by anyone in the session, or by
 * anyone else waiting — two knocks both saying "Alice" can't both be her.
 */
export function isLookalike(
  state: { selfName: string; peers: readonly { name: string; link: string }[]; knocks: readonly { id: string; name: string }[]; lanKnocks: readonly { id: string; name: string }[] },
  knock: { id: string; name: string },
): boolean {
  const key = nameKey(knock.name);
  if (takenNameKeys(state).includes(key)) return true;
  return [...state.knocks, ...state.lanKnocks].some((other) => other.id !== knock.id && nameKey(other.name) === key);
}

/** Said beside a knock wearing the name of someone already here: names are whatever each person typed. */
export const LOOKALIKE_WARNING = 'Someone here already goes by this name — make sure it’s who you expect.';

/** Said beside a knock from someone coming back to the place they had. */
export const RETURNING_NOTE = 'Back after their connection dropped.';

/** The same over the local network, where the proof travels in clear and anyone there could say so. */
export const LAN_RETURNING_NOTE = 'Says they’re back after a drop. Anyone on this network could say so: check it’s them.';

/** Which of the two a knock gets: `lan:` ids came by the local network link. */
export function returningNote(knockId: string): string {
  return knockId.startsWith('lan:') ? LAN_RETURNING_NOTE : RETURNING_NOTE;
}

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

/** What the card says first: who ended it and how, in one line. */
export function endHeadline(reason: EndReason, owner: string | null): string {
  const who = owner?.trim() || 'The owner';
  switch (reason) {
    case 'ended':
      return `${who} ended the session`;
    case 'owner-left':
      return `${who} closed the canvas`;
    case 'document-changed':
      return `${who} moved to another canvas`;
    case 'removed':
      return `${who} removed you from the session`;
    case 'timeout':
      return `Lost the line to ${who === 'The owner' ? 'the owner' : who}`;
    default:
      return 'The session ended';
  }
}

/**
 * Whether the copy on screen may be kept. Not after being removed: the owner took this person out of
 * their canvas, and handing them a copy of it on the way out would undo what the owner just did.
 */
export function mayKeepCopy(reason: EndReason): boolean {
  return reason !== 'removed';
}

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
