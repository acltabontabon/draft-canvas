import type { Accent, CodeLanguage, DraftNodeType, NoteKind } from '../document/types';

export interface Preset {
  id: string;
  label: string;
  type: DraftNodeType;
  shortcut: string;
  /** Shown in the shortcut sheet and as the button tooltip. */
  hint: string;
  accent?: Accent;
  noteKind?: NoteKind;
  language?: CodeLanguage;
  text?: string;
}

/**
 * The entire shape vocabulary.
 *
 * It is short on purpose. A developer explaining a system reaches for a handful
 * of things over and over; a palette of three hundred shapes turns "explain the
 * idea" into "choose a shape", which is the failure mode this tool exists to
 * avoid.
 */
export const PRESETS: Preset[] = [
  { id: 'text', label: 'Text', type: 'text', shortcut: 'T', hint: 'Label with no box' },
  {
    id: 'note',
    label: 'Note',
    type: 'note',
    shortcut: 'N',
    hint: 'A remark, question, warning or decision',
    noteKind: 'note',
  },
  {
    id: 'code',
    label: 'Code',
    type: 'code',
    shortcut: 'C',
    hint: 'Syntax-highlighted code, config or logs',
    language: 'json',
  },
  {
    id: 'boundary',
    label: 'Boundary',
    type: 'group',
    shortcut: 'B',
    hint: 'A labelled container for related elements',
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
    accent: 'teal',
  },
  {
    id: 'database',
    label: 'Data Store',
    type: 'database',
    shortcut: 'D',
    hint: 'A data store',
    accent: 'blue',
    text: 'Data Store',
  },
  {
    id: 'queue',
    label: 'Queue',
    type: 'queue',
    shortcut: 'Q',
    hint: 'A queue, topic, or event stream',
    accent: 'violet',
  },
  {
    id: 'actor',
    label: 'Actor',
    type: 'actor',
    shortcut: 'A',
    hint: 'A person or client',
    text: 'User',
  },
  {
    id: 'ellipse',
    label: 'Junction',
    type: 'ellipse',
    shortcut: 'J',
    hint: 'Where connections branch or converge',
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
