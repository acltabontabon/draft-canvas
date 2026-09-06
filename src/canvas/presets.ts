import type { Accent, CodeLanguage, DraftNodeType, NoteKind } from '../document/types';

export interface Preset {
  id: string;
  label: string;
  type: DraftNodeType;
  shortcut: string;
  /** Shown in the shortcut sheet and as the ⌘K result's muted hint. */
  hint: string;
  /** The primitive's architectural definition — one sentence, the toolbar tooltip's main line. */
  description: string;
  /** Secondary "when to use this" guidance for the toolbar tooltip. Omit when the primitive needs
   *  no elaboration (e.g. Text). */
  usageHint?: string;
  accent?: Accent;
  noteKind?: NoteKind;
  language?: CodeLanguage;
  text?: string;
}

/** The toolbar tooltip's content shape — also covers Select, which isn't a `Preset` (it's
 *  `armed === null`, not a node type) but still needs the same tooltip. Kept here so every
 *  primitive's tooltip copy has one home. */
export interface PrimitiveTooltipContent {
  title: string;
  description: string;
  usageHint?: string;
  shortcut?: string;
}

export function tooltipContentFor(preset: Preset): PrimitiveTooltipContent {
  return {
    title: preset.label,
    description: preset.description,
    usageHint: preset.usageHint,
    shortcut: preset.shortcut,
  };
}

export const SELECT_TOOLTIP: PrimitiveTooltipContent = {
  title: 'Select',
  description: 'Select, move, resize, and edit elements.',
  shortcut: 'Esc',
};

/**
 * The entire shape vocabulary.
 *
 * It is short on purpose. A developer explaining a system reaches for a handful
 * of things over and over; a palette of three hundred shapes turns "explain the
 * idea" into "choose a shape", which is the failure mode this tool exists to
 * avoid.
 */
export const PRESETS: Preset[] = [
  {
    id: 'text',
    label: 'Text',
    type: 'text',
    shortcut: 'T',
    hint: 'Label with no box',
    description: 'Plain canvas text for labels, headings, or lightweight annotations.',
  },
  {
    id: 'note',
    label: 'Note',
    type: 'note',
    shortcut: 'N',
    hint: 'A remark, question, warning or decision',
    description: 'Capture context that is not part of the architecture itself.',
    usageHint: 'Use for assumptions, decisions, warnings, questions, or meeting notes.',
    noteKind: 'note',
  },
  {
    id: 'code',
    label: 'Code',
    type: 'code',
    shortcut: 'C',
    hint: 'Syntax-highlighted code, config or logs',
    description: 'Show a small technical artifact alongside the architecture.',
    usageHint: 'Useful for payloads, contracts, queries, configuration, or short snippets.',
    language: 'json',
  },
  {
    id: 'boundary',
    label: 'Boundary',
    type: 'group',
    shortcut: 'B',
    hint: 'A labelled container for related elements',
    description: 'Groups elements that share an architectural scope.',
    usageHint:
      'Use for systems, domains, network zones, deployment scopes, or ownership boundaries.',
  },
];

export const DEV_PRESETS: Preset[] = [
  {
    // No `text` here, deliberately — a fresh Service node's label should follow whatever
    // `serviceKind` it's created with (`document/factory.ts`'s `defaultTextFor`), starting as
    // "Service" for Generic but "API"/"Worker"/etc. for anything created pre-typed (e.g. a
    // Quick Connect preset or `insertWorkerOnEdge`). Hardcoding "Service" here would mark the
    // label `textOrigin: 'explicit'` at creation and freeze it forever — see `createNode`.
    id: 'service',
    label: 'Service',
    type: 'service',
    shortcut: 'S',
    hint: 'An application or service',
    description: 'A deployable or independently running capability.',
    usageHint: 'Use for APIs, workers, background processes, or external systems.',
    accent: 'teal',
  },
  {
    id: 'database',
    label: 'Data Store',
    type: 'database',
    shortcut: 'D',
    hint: 'A data store',
    description: 'Stores or serves persistent or temporary data.',
    usageHint: 'Use for databases, caches, object stores, indexes, or similar data infrastructure.',
    accent: 'blue',
    text: 'Data Store',
  },
  {
    id: 'queue',
    label: 'Queue',
    type: 'queue',
    shortcut: 'Q',
    hint: 'A queue, topic, or event stream',
    description: 'Asynchronous communication infrastructure between parts of the system.',
    usageHint: 'The base primitive for queues, topics, and streams — pick a kind for the specific pattern.',
    accent: 'violet',
  },
  {
    id: 'actor',
    label: 'Actor',
    type: 'actor',
    shortcut: 'A',
    hint: 'A person or client',
    description: 'A person or external participant interacting with the system.',
    usageHint: 'Use for users, operators, clients, organizations, or other external actors.',
    text: 'User',
  },
  {
    id: 'ellipse',
    label: 'Junction',
    type: 'ellipse',
    shortcut: 'J',
    hint: 'Where connections branch or converge',
    description: 'A visual routing point for organizing connections.',
    usageHint: 'Use for fan-in, fan-out, or cleaner paths — not a runtime component.',
  },
  {
    // No `text` here, for the same reason Service's fresh label follows `serviceKind` —
    // `defaultTextFor`'s "Component"/"Module"/"Adapter" table drives a fresh node's label, and a
    // hardcoded "Component" here would freeze it `textOrigin: 'explicit'` at creation.
    id: 'component',
    label: 'Component',
    type: 'component',
    shortcut: 'M',
    hint: 'A logical building block inside a boundary — not independently deployable',
    description: 'A logical part inside a larger system or service.',
    usageHint: "Use instead of Service when it isn't independently deployable.",
    accent: 'neutral',
  },
];

export const ALL_PRESETS = [...PRESETS, ...DEV_PRESETS];

/**
 * The Quick Connect creation menu's option list — plain data, not JSX, so a
 * later pass can add keyboard navigation or reorder it to surface a recently
 * used type first without touching how each option renders.
 */
export const QUICK_CONNECT_PRESETS: Preset[] = [
  DEV_PRESETS.find((preset) => preset.id === 'service')!,
  DEV_PRESETS.find((preset) => preset.id === 'database')!,
  DEV_PRESETS.find((preset) => preset.id === 'queue')!,
  DEV_PRESETS.find((preset) => preset.id === 'actor')!,
];

export function presetForShortcut(key: string): Preset | undefined {
  const upper = key.toUpperCase();
  return ALL_PRESETS.find((preset) => preset.shortcut === upper);
}
