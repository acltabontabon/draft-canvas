import { compareVersions, isVersionNewer } from '../lib/semver';
import type { ProductRelease } from './types';

export type { ProductRelease, ProductReleaseHighlight } from './types';
// The notes themselves stay here; what's cheap enough for the Library's first paint lives in `seen.ts`.
export { hasUnreadRelease, markLastSeenRelease, readLastSeenRelease } from './seen';

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
    version: '1.9.1',
    date: '2026-09-19',
    summary: 'Nothing you type gets lost, and connectors behave in the tight spots.',
    highlights: [
      {
        title: 'Long text keeps its length',
        description:
          'Labels, conditions, responses and shape text are held to what a saved diagram keeps, so nothing you typed is quietly cut short when the canvas next opens.',
      },
      {
        title: 'Detach keeps what you just typed',
        description:
          'Detaching a note or code card from a connector or shape now brings along the text you were still editing.',
      },
      {
        title: 'Connectors steer clear',
        description:
          'A connector in a fan no longer runs through another shape in the same fan, and line jumps over a shared line stay put when a connector joins it.',
      },
      {
        title: 'Draft and Sketch reach every shape',
        description:
          'API, Gateway, Module, Adapter, Cache, File System and Object Storage now get the hand-drawn look instead of staying crisp.',
      },
      {
        title: 'Focus goes back where it was',
        description:
          'Close a dialog you opened from the command palette and you land where you were, and clicking away from a flow you just named no longer leaves Delete pointed at it.',
      },
      {
        title: 'Enter and ⌘Enter do what they say',
        description:
          'Enter on a selected Boundary edits its caption, and ⌘Enter presents the flow the way the Present button does.',
      },
    ],
  },
  {
    version: '1.9.0',
    date: '2026-09-19',
    summary: 'Capture what a diagram decided, and keep up on the big ones.',
    highlights: [
      {
        title: 'Takeaways',
        description: 'Press I to capture a decision, a question or something that needs doing, without stopping the drawing. A quiet count in the status bar opens them, and Copy as Markdown pastes the lot anywhere.',
      },
      {
        title: 'A canvas still knows what it owes you',
        description: 'Your diagram list shows which canvases have open actions, and opening one points them out for a few seconds before folding back into the status bar.',
      },
      {
        title: 'Crossing connectors hop over each other',
        description: 'Where two connectors cross, one now arcs over the other, so a crossing reads as a crossing rather than a join — in the canvas and in exported images.',
      },
      {
        title: 'Big diagrams keep up',
        description: 'On a diagram of around 500 shapes, clicking one takes about a third of the time it did, panning and zooming hold much closer to 60 frames a second, and the pause after dropping a shape is roughly halved.',
      },
      {
        title: 'Escape cancels a drag',
        description: 'Change your mind mid-drag and the shape goes back where it started — nothing moved, nothing attached, nothing to undo.',
      },
      {
        title: 'Notes say where they will land',
        description: 'Drag a Note or Code card towards a connector and a small tag shows what is about to attach, and which line it will attach to when several run close together.',
      },
    ],
  },
  {
    version: '1.8.0',
    date: '2026-09-17',
    summary: 'Connectors read like sentences, and the shape library got a redraw.',
    highlights: [
      {
        title: 'Captions read in the arrow’s direction',
        description: 'Queue → Worker now reads "consumed by", Database → Service reads "read by" — point the arrow either way and the words still make sense.',
      },
      {
        title: 'Reversing a connector keeps your choice',
        description: 'Flip a connector and a relationship you picked turns with it; one Draft Canvas worked out for you is worked out again for the new direction.',
      },
      {
        title: 'Adapters suggest their Port',
        description: 'Drag off an Adapter and Draft Canvas offers the Port it sits behind.',
      },
      {
        title: 'Shapes, redrawn',
        description: 'Every Data Store kind, Gateway, Stream and Actor has a fresh, flatter look — neutral by default, with a quieter colour palette in both themes.',
      },
      {
        title: 'Long names wrap before they’re cut',
        description: 'A name typed into a shape wraps onto more lines, and shrinks a little if it still doesn’t fit, before it’s ever trimmed with an ellipsis.',
      },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-09-17',
    summary: 'Look inside: C4-aware depth.',
    highlights: [
      {
        title: 'Look inside a shape',
        description: 'Keep the big picture big and draw what runs inside a service or component one level down, in the same canvas.',
      },
      {
        title: 'Always know where you are',
        description: '⌘↓ goes in and ⌘↑ comes back out. The Depth map in the corner shows the way up, the shapes beside you and the ones below.',
      },
      {
        title: 'C4-aware suggestions',
        description: 'Say a view shows System context, Containers or Components, and suggestions stay at that altitude.',
      },
      {
        title: 'Undo follows you in',
        description: 'Undoing something you changed inside a shape takes you back in to show you.',
      },
      {
        title: 'Learn it in ten seconds',
        description: 'The Look inside recipe in Learn plays the whole move, there and back.',
      },
    ],
  },
  {
    version: '1.6.2',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Copy and paste shortcuts work in VS Code',
        description:
          '⌘C, ⌘X and ⌘V copy, cut and paste shapes again in VS Code, and paste into your other diagrams with the latest Draft Canvas for VS Code.',
      },
      {
        title: 'Paste without the clipboard warning',
        description: 'Paste from the right-click menu or the command palette in VS Code no longer says clipboard access is blocked.',
      },
    ],
  },
  {
    version: '1.6.1',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Undo survives a busy drag',
        description:
          'Pressing Delete or another shortcut while dragging a shape waits for the drag to end, so undo keeps working for the rest of the session.',
      },
      {
        title: 'Updates never cost unsaved work',
        description:
          "If your latest changes couldn't be saved, Reload to update asks first so you can export them.",
      },
      {
        title: 'Boundaries keep what you add',
        description:
          'A queue, worker or duplicate added inside a boundary now belongs to it, and moves and deletes along with it.',
      },
      {
        title: 'Escape does just one thing',
        description:
          "Escape closes a shape's colour or text panel and keeps the suggestion beside it, and cancels a connector-end drag without deselecting the connector.",
      },
      {
        title: 'Copy and paste across VS Code diagrams',
        description:
          'Shapes copied or cut with ⌘C or ⌘X in VS Code paste into your other diagrams and other apps.',
      },
      {
        title: 'Smoother on small screens',
        description:
          'On a phone the canvas title stays clear of Undo and Redo, and long right-click menus scroll so every item is reachable.',
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Two tabs, one canvas, no surprises',
        description:
          "If another tab changed or deleted the canvas you're editing, the status bar asks which copy to keep instead of quietly overwriting either one.",
      },
      {
        title: 'Updates wait for you',
        description:
          'Reload to update saves your work first and reloads only the tab you clicked. Other open tabs just offer a Reload button.',
      },
      {
        title: 'Connectors stay on top',
        description:
          "A connector's label, attachments and end handles stay above shapes brought to the front, so its end can always be dragged somewhere new.",
      },
      {
        title: 'Undo does what you meant',
        description:
          'Recolouring several shapes is one step, a change you took back leaves no empty step, and undo no longer reverts a rename made in another tab.',
      },
      {
        title: 'Calmer toasts and tooltips',
        description:
          'Toasts sit below the toolbar and never stack up, tooltips open when you tab to a control, and the browser tab shows the canvas name.',
      },
      {
        title: 'Keys go where you expect',
        description:
          "Keys pressed in menus and prompts stay there instead of creating or moving shapes behind them, and Escape closes only what's on top.",
      },
    ],
  },
  {
    version: '1.5.1',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Links open in VS Code',
        description: 'The links in About now open in your browser or mail app when Draft Canvas is running inside VS Code.',
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Draft Canvas for VS Code',
        description:
          "Keep diagrams next to your code: the new VS Code extension opens a .draftcanvas file straight into the canvas and saves your edits back to that file, ready to commit.",
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-09-14',
    highlights: [
      {
        title: 'Presentation callouts',
        description:
          "Presenting a flow now shows the notes and code attached to each step in a small callout beside it, joined by a thin line and moving with the step.",
      },
      {
        title: 'Learn, as a handbook',
        description:
          'Learn Draft Canvas is now a handbook you open beside the canvas — search "how do I…" or browse short, animated recipes, with your diagram still live next to it.',
      },
      {
        title: 'Suggestions with alternatives',
        description:
          'Press ] or [ to step through a suggestion\'s alternatives, keep pressing Tab to keep sketching, and a suggestion can now add a small group — like a topic and its worker — in one step.',
      },
      {
        title: 'Three new Data Architecture starters',
        description:
          'Medallion, Kappa, and Change Data Capture join the starter list, each with a built-in flow, alongside a new "transforms" relationship for data refined from one store into another.',
      },
      {
        title: 'An official Docker image',
        description:
          'Run Draft Canvas yourself with acltabontabon/draft-canvas — the same static app served by nginx, for amd64 and arm64, published with every release.',
      },
      {
        title: 'A calmer starter shelf',
        description:
          "The home screen's starters are now an index, one category open at a time, and Export's shortcut moved to ⌘⇧E so browser extensions stop swallowing it.",
      },
      {
        title: 'Smoother and more reliable',
        description:
          'Dragging and resizing large diagrams is smoother, opening a diagram with one flow no longer dims everything else, and pasting or inserting into a full diagram says so instead of quietly losing shapes.',
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-09-13',
    highlights: [
      {
        title: 'Boundaries keep their contents',
        description:
          "Copying, cutting, nudging, or ungrouping a boundary now takes what's inside it along, instead of leaving it behind or pointing at nothing.",
      },
      {
        title: 'Flows stay accurate',
        description:
          "Turning a fan of connectors into a junction, or inserting a worker on one, no longer loses a flow step or the connector's label and attachments.",
      },
      {
        title: 'Cross-tab edits stay put',
        description:
          "Renaming or moving a diagram in one tab is no longer overwritten by another tab's autosave, and undoing an unrelated edit no longer reverts it.",
      },
      {
        title: 'Keyboard and IME fixes',
        description:
          'Enter and Space on a focused button now press it instead of editing your diagram, holding a shortcut key no longer piles up copies, and composing Japanese, Chinese, or Korean text with Enter no longer submits the field early.',
      },
      {
        title: 'Easier to grab when zoomed out',
        description:
          'Connection dots, resize handles, and connectors are easier to click precisely, and a connection dot no longer jumps when you hover it.',
      },
      {
        title: 'Menus behave',
        description:
          "Right-click and quick-add menus close when you pan or zoom, and the Library's move-to-project menu now supports arrow keys, Home, and End.",
      },
      {
        title: 'More accurate screen reader support',
        description:
          'Screen readers announce each step while presenting instead of staying silent, and no longer narrate every autosave.',
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-09-13',
    highlights: [
      {
        title: 'Your work, kept safer',
        description:
          'Imports no longer replace a newer local copy, leaving a diagram that failed to save warns you first, and edits made in another tab are never overwritten.',
      },
      {
        title: 'Undo, right where you deleted',
        description:
          'Deleting a flow now offers Undo in the confirmation itself, and notices wait while you hover over them.',
      },
      {
        title: 'Faster to open, smoother to drag',
        description:
          'The homepage loads about half as much code, and connectors keep routing around shapes while you move something else.',
      },
      {
        title: 'Popovers that stay readable',
        description:
          'Connector, element, and attachment popovers keep the same size at every zoom level and sit above the shapes around them.',
      },
      {
        title: 'Cleaner sequence exports',
        description:
          'Mermaid and PlantUML source now survives labels and notes full of code — semicolons, hashes, angle brackets, and all.',
      },
      {
        title: 'Easier to see and hear',
        description:
          'Stronger contrast for faint text, and screen readers now hear toggle states, open menus, dropdown values, and progress.',
      },
    ],
  },
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
