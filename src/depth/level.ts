/**
 * What a view is showing, in the one sense architecture has a zoom.
 *
 * Two rules, and they are the whole design:
 *
 * - **Stored only when someone said so.** A level comes from a starter that declared one or from
 *   the "View level" command. Draft Canvas never writes one down because a canvas *looked* like a
 *   system overview — a guess that silently changed what the app suggests, on evidence the user
 *   never saw, is exactly the kind of clever nobody asked for.
 * - **Derived for the rooms inside it.** If this canvas is a System Context, then what runs inside
 *   one of its systems is its Containers, and what those are made of is Components. That follows
 *   from where you are standing, so it is worked out on the spot rather than stamped on the file —
 *   change the outer level and every room inside it follows, unless it was given one of its own.
 *
 * A level is only ever allowed to *narrow* what Draft Canvas offers where the level is known, and
 * where it is known it is also shown (the status bar says it, the trail repeats it). Nothing here
 * ever refuses a shape or a connection: the vocabulary of a view is a suggestion about what is
 * usually drawn at that altitude, not a rule about what may be.
 */

import type { DraftDocument, ViewLevel } from '../document/types';
import { ownerAt, type DepthPath } from './tree';

/** What the rooms inside a view of this level are, unless they say otherwise. */
export function nextLevel(level: ViewLevel | undefined): ViewLevel | undefined {
  switch (level) {
    case 'context':
      return 'container';
    case 'container':
      return 'component';
    // Inside a component are more components: there is no fourth level Draft Canvas has an
    // opinion about (C4's Code level is a job for an IDE, not a diagram).
    case 'component':
      return 'component';
    default:
      return undefined;
  }
}

/**
 * The level in force for the room at `path`: its own if it has one, otherwise the one that
 * follows from the room outside it. `undefined` means nothing is known, which is the honest
 * answer for any canvas nobody has said anything about — and the state in which everything
 * behaves exactly as it did before levels existed.
 */
export function effectiveLevel(file: DraftDocument, path: DepthPath): ViewLevel | undefined {
  let level = normalize(file.level);
  for (let depth = 1; depth <= path.length; depth += 1) {
    const owner = ownerAt(file, path.slice(0, depth));
    const stored = normalize(owner?.inside?.level);
    level = stored ?? nextLevel(level);
  }
  return level;
}

/** `'none'` is a deliberate "no level here", which reads the same as not knowing — except that it
 *  also stops the room outside handing one down. */
function normalize(level: ViewLevel | undefined): ViewLevel | undefined {
  return level === 'none' ? undefined : level;
}

/** What a level is called, where one is shown. Plural, because a view shows several of them. */
export const LEVEL_LABELS: Record<Exclude<ViewLevel, 'none'>, string> = {
  context: 'System context',
  container: 'Containers',
  component: 'Components',
};

/** The one-line explanation each level carries where there is room for it. */
export const LEVEL_HINTS: Record<Exclude<ViewLevel, 'none'>, string> = {
  context: 'People, this system, and the systems around it',
  container: 'The apps, services and data stores it runs on',
  component: 'The parts one of those is made of',
};
