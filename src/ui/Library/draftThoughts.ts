import { MOD_SYMBOL } from '../../lib/platform';

/**
 * One line of editorial at the foot of the home screen — the product saying
 * something it actually believes, the way a good tool's release notes do.
 *
 * Every line here is a claim about how Draft Canvas behaves, and each has
 * been checked against the code it describes (`document/connectorSemantics.ts`
 * for the vocabulary ones). A thought that stops being true gets deleted,
 * not softened. Deliberately no local-first line: the footer beside this
 * already says it, and saying it twice would start to sound like marketing.
 */
export const DRAFT_THOUGHTS: readonly string[] = [
  'Drop a junction when your arrows start looking like spaghetti.',
  'Queues can have DLQs. Draft Canvas knows that.',
  'Connect a Service to a Topic and the arrow already reads “publishes”.',
  'Ports live inside the core. The arrow out of one reads “implemented by”.',
  'A flow tells the same diagram one step at a time.',
  `${MOD_SYMBOL}K knows five architectures by name. Try “hexagonal”.`,
  'Export is SVG, PNG, or GIF. Nothing renders on a server.',
  'A boundary around three services is a statement. Name it.',
  'An External System is a box you don’t own. Draft Canvas draws it that way.',
];

/**
 * Picked by the day, not the render: the same thought all day, a different
 * one tomorrow. No state, no timer, nothing to rotate while someone is
 * reading it.
 */
export function thoughtForDay(date: Date = new Date()): string {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = Math.floor((date.getTime() - start) / 86_400_000);
  const count = DRAFT_THOUGHTS.length;
  return DRAFT_THOUGHTS[((day % count) + count) % count]!;
}
