import { readPreference, writePreference } from '../lib/preferences';
import { compareVersions, isVersionNewer } from '../lib/semver';
import { PRODUCT } from '../product';
import type { ProductRelease } from './types';

export type { ProductRelease, ProductReleaseHighlight } from './types';

/**
 * Curated, user-facing release notes for the About → What's New view. Newest release goes first
 * by convention, but nothing downstream relies on that — `applicableReleases` always re-sorts.
 *
 * Entries may be written ahead of the release that carries them (see CONTRIBUTING.md's "Release
 * workflow"), curated from CHANGELOG.md's `[Unreleased]` section. A prepared entry carries no
 * `date`, and `applicableReleases` filters it out entirely until the running app version genuinely
 * reaches it — it can never be shown as installed early.
 *
 * History only goes back to `0.1.0` ("the first production-ready release," per CHANGELOG.md) —
 * the `alpha`/`beta` milestones before it were never a real release anyone upgraded from, and a
 * point release with nothing user-facing to say (`0.3.1`, a one-line copy tweak) simply has no
 * entry at all rather than an empty one.
 */
export const PRODUCT_RELEASES: ProductRelease[] = [
  {
    version: '1.1.0',
    date: '2026-09-13',
    highlights: [
      {
        title: 'Pre-built flows for every starter',
        description:
          'All ten architecture starters now come with a ready-made flow to walk through, not just a diagram to look at.',
      },
      {
        title: 'Export, rebuilt',
        description:
          'Choose Document, Image, Animated, or Source, set only what that format needs, and export with one button — with a live preview of exactly what you are about to get.',
      },
      {
        title: 'Sequence export, tidied up',
        description:
          '.mmd and .puml file names instead of .sequence.*, and long notes now wrap onto several lines instead of stretching the diagram sideways.',
      },
      {
        title: 'Paste and drag-to-attach, more reliable',
        description:
          'Paste now shows up in the right-click menu and command palette even when you copied from outside the app, and dragging a note onto overlapping shapes lands on the one actually on top.',
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-09-12',
    summary:
      'The first stable release — diagrams that explain themselves, and a canvas you can drive without a mouse.',
    highlights: [
      {
        title: 'Flow → Sequence Diagram',
        description:
          "Turn a flow into Mermaid or PlantUML source when the sketch needs to become something more formal.",
      },
      {
        title: 'Four more architecture starters',
        description:
          'Backend for Frontend, CQRS, Saga (Orchestration and Choreography), and Transactional Outbox join the starter list, each with a ready-made flow.',
      },
      {
        title: 'Intent Continuation',
        description:
          "Draft Canvas sketches the obvious next move — a queue beside a topic, a worker after a queue. Tab to accept it, Escape to wave it off. Never AI, and nothing leaves your device.",
      },
      {
        title: 'Keyboard-first canvas',
        description:
          'Move between elements and along their connections without a mouse, and Tab now reaches the canvas as a single stop instead of visiting every shape.',
      },
      {
        title: 'Table',
        description: 'A Data Store can hold named Tables.',
      },
      {
        title: 'A toolbar that gets out of the way',
        description:
          'The creation tools sit in one centred rail, the canvas name reads as a title, and the settings you touch once a month moved behind a More menu.',
      },
      {
        title: 'Polish and reliability',
        description:
          'Light and dark now follow your system on their own, connector routing and labels got smarter, every shape and connector shares one popover, and dialogs reliably hand keyboard focus back where you left it.',
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-10',
    highlights: [
      {
        title: 'Architecture starters on the home screen',
        description:
          'Monolith, Modular Monolith, Microservices, Event-Driven, and Hexagonal — ready the moment you open a new workspace.',
      },
      {
        title: 'Diagrams you can recognize at a glance',
        description:
          "Every diagram in your library shows a small fingerprint of its shape beside its name, drawn from the diagram itself.",
      },
      {
        title: 'Flows live in one place',
        description: 'One panel replaces the old dropdown and separate edit mode. Naming a flow is part of creating it.',
      },
      {
        title: 'Notes that behave like text',
        description: 'Enter starts a new line, and a note grows as you type instead of needing a resize.',
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-09-10',
    highlights: [
      {
        title: 'Ports, for hexagonal architecture',
        description:
          'A dashed contract box a Service calls and a Component implements — the connector itself reads implemented by, so dependency inversion is stated, not just implied.',
      },
      {
        title: 'Starters that show real integration',
        description:
          'The Microservices, Hexagonal, and Monolith starters now show how their pieces actually talk to each other, not just where they sit.',
      },
      {
        title: 'Name your queues and topics',
        description: 'Queues, Topics, Streams, and DLQs can carry a name again — double-click and type.',
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-09-09',
    highlights: [
      {
        title: 'Architecture Starters',
        description:
          "Press ⌘K and type a pattern's name — Monolith, Modular Monolith, Microservices, Event-Driven, Hexagonal — to drop in a ready-made diagram you can change right away.",
      },
      {
        title: 'A Component shape',
        description: 'Deliberately smaller and lighter than Service, for the logical building blocks inside a boundary.',
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-09-06',
    highlights: [
      {
        title: 'Tidier fan-outs',
        description:
          'Connections that fan out from (or converge on) one shape now route through a shared trunk instead of a tangle of near-identical lines, with a right-click to opt out.',
      },
      {
        title: 'Shapes that look like what they are',
        description:
          'Data Store gets seven distinct silhouettes (SQL, NoSQL, Cache, and more), Service gets six, and every kind picker shows a live preview instead of plain text.',
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-05',
    highlights: [
      {
        title: 'One-click Dead Letter Queue and Consumer',
        description:
          'Right-click a Queue to add a connected DLQ or consumer worker in one step, positioned and labelled automatically.',
      },
      {
        title: "Paste that doesn't ask permission",
        description: 'Cmd/Ctrl+V now reads the paste event directly — no clipboard prompt for the shortcut you already know.',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-04',
    highlights: [
      {
        title: 'Right-click for a contextual menu',
        description:
          'Right-click a shape, connector, boundary, or empty canvas for just the actions that make sense there, each with its shortcut shown alongside it.',
      },
      {
        title: 'Connections that know what they are',
        description:
          'A Topic reads as its own thing, not just another Queue — Topic → Queue defaults to fans out, Topic → Service to delivers to — and an unusual connection gets a gentle nudge with a one-click fix.',
      },
      {
        title: 'Draft and Sketch actually look different',
        description:
          'Two distinct hand-drawn personalities now, not just more or less jitter on the same lines — see them live in Canvas Settings before choosing.',
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-04',
    highlights: [
      {
        title: 'Command palette',
        description:
          'Press ⌘K and type what you want to do — add a shape, connect it, spotlight it, present. Two-step commands like Connect to… pick their target right there.',
      },
      {
        title: 'Find anything by name',
        description: "Type a node, flow, or connection's name in the palette to jump straight to it.",
      },
      {
        title: 'A canvas that fails soft',
        description: 'A diagram that hits a rendering error now shows a recoverable screen instead of going blank.',
      },
    ],
  },
  {
    version: '0.1.2',
    date: '2026-09-02',
    highlights: [
      { title: 'A connector through a Junction keeps its full set of interaction types.' },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-09-02',
    highlights: [
      { title: 'A selected flow now stands out clearly against everything else on the canvas.' },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-02',
    summary: 'The first release meant for real use.',
    highlights: [
      {
        title: 'Projects',
        description:
          'Group canvases into flat Projects from the homepage, or leave them Unorganized — nothing required before creating a canvas.',
      },
      {
        title: 'Search and sort your library',
        description: 'A homepage search box and a sort control keep dozens (or hundreds) of diagrams navigable.',
      },
      {
        title: 'Copy and paste across diagrams',
        description:
          "Select part of one diagram, open another, and paste it there — only the connectors between what you selected come with it.",
      },
    ],
  },
];

/**
 * Releases the given app version is actually entitled to show, newest first. This is the one
 * place "prepared ahead of time" data gets reconciled with "what's really running" — a release
 * newer than `currentVersion` is filtered out, never presented as installed, current, or seen.
 */
export function applicableReleases(
  currentVersion: string,
  releases: ProductRelease[] = PRODUCT_RELEASES,
): ProductRelease[] {
  return releases
    .filter((release) => !isVersionNewer(release.version, currentVersion))
    .sort((a, b) => compareVersions(b.version, a.version));
}

export interface ReleaseYearGroup {
  year: string | null;
  releases: ProductRelease[];
}

/**
 * Groups already-sorted (newest-first) releases by the year of their `date`, merging consecutive
 * entries from the same year into one bucket — a release with no date (only possible for one
 * prepared ahead of shipping, which `applicableReleases` never actually surfaces) gets its own
 * `null`-year bucket rather than crashing. Whether a year heading is worth showing at all is the
 * caller's call (see `AboutDialog.tsx`) — a single group is just noise.
 */
export function groupReleasesByYear(releases: ProductRelease[]): ReleaseYearGroup[] {
  const groups: ReleaseYearGroup[] = [];
  for (const release of releases) {
    const year = release.date ? release.date.slice(0, 4) : null;
    const current = groups[groups.length - 1];
    if (current && current.year === year) current.releases.push(release);
    else groups.push({ year, releases: [release] });
  }
  return groups;
}

/**
 * Whether there's a curated release newer than the last one this device acknowledged. `releases`
 * is expected to already be `applicableReleases`'s output (newest first) — an empty list (nothing
 * curated yet for this version) is never unread. An unparseable `lastSeen` degrades to "treat as
 * unseen" via `compareVersions`, rather than silently hiding a real release.
 */
export function hasUnreadRelease(lastSeen: string, releases: ProductRelease[]): boolean {
  const latest = releases[0];
  return latest !== undefined && isVersionNewer(latest.version, lastSeen);
}

const LAST_SEEN_RELEASE_PREFERENCE = 'last-seen-product-release';

/**
 * The version whose product release notes (About → What's New) this device has already
 * acknowledged. A stored value is trusted as-is; its absence means "never asked before" — which
 * covers both a brand-new install and an existing install meeting this feature for the first
 * time — and is resolved immediately to the *current* version, not left unset. That way nobody
 * ever sees every past release retroactively flagged unread; only an actual upgrade past this
 * point can produce a newer "latest" than what's stored. A preference store that isn't usable
 * right now (blocked storage, a test harness still wiring up) falls back to the same quiet
 * default: nothing unread.
 */
export function readLastSeenRelease(): string {
  try {
    const stored = readPreference(LAST_SEEN_RELEASE_PREFERENCE);
    if (stored !== null) return stored;
    writePreference(LAST_SEEN_RELEASE_PREFERENCE, PRODUCT.version);
    return PRODUCT.version;
  } catch {
    return PRODUCT.version;
  }
}

/** Records that this device has now seen the given version's release notes — defaults to the
 *  running app version, which is what About → What's New actually calls this with. */
export function markLastSeenRelease(version: string = PRODUCT.version): void {
  writePreference(LAST_SEEN_RELEASE_PREFERENCE, version);
}
