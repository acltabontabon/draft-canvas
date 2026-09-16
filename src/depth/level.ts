/**
 * What a view is showing, in the one sense architecture has a zoom.
 *
 * Two rules, and they are the whole design:
 *
 * - **Stored only when someone said so.** A level comes from a starter that declared one, from the
 *   "View level" command, or from someone answering the one question Draft Canvas ever asks about
 *   it (`looksLikeSystemOverview`). It is never written down because a canvas merely *looked* like
 *   a system overview: a guess that silently changed what the app suggests, on evidence the user
 *   never saw, would be exactly the kind of clever nobody asked for. Asking is not guessing.
 * - **Derived for the rooms inside it.** If this canvas is a System Context, then what runs inside
 *   one of its systems is its Containers, and what those are made of is Components. That follows
 *   from where you are standing, so it is worked out on the spot rather than stamped on the file —
 *   change the outer level and every room inside it follows, unless it was given one of its own.
 *
 * A level is only ever allowed to *narrow* what Draft Canvas offers where the level is known, and
 * where it is known it is also shown (the status bar says it, the depth map repeats it). Nothing here
 * ever refuses a shape or a connection: the vocabulary of a view is a suggestion about what is
 * usually drawn at that altitude, not a rule about what may be.
 */

import type { DraftDocument, ViewLevel } from '../document/types';
import { ownerAt, type DepthPath } from './tree';

/**
 * Whether a view is shaped like a picture of one system among the people and systems around it.
 *
 * The one place Draft Canvas reads anything into a drawing, and it only ever produces a question —
 * never a stored level, never a changed suggestion on its own. Deliberately narrow, and biased
 * hard towards saying nothing: people, outside systems and systems of our own, and enough of them
 * to be a picture rather than a pair. A canvas holding a database, a queue or a component is a
 * picture of how something is built, which is a different altitude, and gets no question at all.
 *
 * Two shapes used to be enough, and two shapes is a sketch — "Customer → Order Service" is a thing
 * people draw all day without meaning anything about abstraction by it. Being wrong here is worse
 * than being quiet: a question nobody needed reads as the app trying to classify their drawing,
 * and the cost of never asking is that someone picks the level from the palette instead.
 */
export function looksLikeSystemOverview(view: DraftDocument): boolean {
  let ours = 0;
  let theirs = 0;
  for (const node of view.nodes) {
    if (node.type === 'actor') {
      theirs += 1;
      continue;
    }
    if (node.type !== 'service') return false;
    if (node.serviceKind === 'external') theirs += 1;
    else ours += 1;
  }
  return ours >= 1 && theirs >= 1 && ours + theirs >= 3;
}

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
  let level = file.level;
  for (let depth = 1; depth <= path.length; depth += 1) {
    const owner = ownerAt(file, path.slice(0, depth));
    level = owner?.inside?.level ?? nextLevel(level);
  }
  return normalize(level);
}

/** The level a room at `path` would show if it said nothing itself. Nothing at the top. */
export function inheritedLevel(file: DraftDocument, path: DepthPath): ViewLevel | undefined {
  return path.length === 0 ? undefined : nextLevel(effectiveLevel(file, path.slice(0, -1)));
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
