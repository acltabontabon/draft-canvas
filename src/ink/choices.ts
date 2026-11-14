/**
 * The Draft Canvas elements Smart Ink can make from a drawing, what each is called, and the box
 * each takes. Kept apart from the recognizer so the editor can name and build them without loading
 * any recognition code — that only arrives once someone draws with Smart Ink.
 */
import type { DraftNodeType } from '../document/types';
import type { Box } from './geometry';

/** The element kinds Smart Ink can make — every one an existing Draft Canvas shape. */
export const INK_SHAPE_CHOICES = ['component', 'service', 'boundary', 'note', 'database', 'queue', 'actor', 'junction'] as const;
export type InkShapeChoice = (typeof INK_SHAPE_CHOICES)[number];

export const INK_CHOICE_TYPE: Record<InkShapeChoice, DraftNodeType> = {
  component: 'component',
  service: 'service',
  boundary: 'group',
  note: 'note',
  database: 'database',
  queue: 'queue',
  actor: 'actor',
  junction: 'ellipse',
};

export const INK_CHOICE_LABEL: Record<InkShapeChoice, string> = {
  component: 'Component',
  service: 'Service',
  boundary: 'Boundary',
  note: 'Note',
  database: 'Data Store',
  queue: 'Queue',
  actor: 'Actor',
  junction: 'Junction',
};

/**
 * The box a chosen element takes for a drawing: the drawn size where it carries meaning (a large
 * box is a large Boundary), grown to the element's own minimum around the same centre, and a
 * Junction's fixed size — a junction is punctuation, whatever size the circle was drawn.
 */
export function boxForChoice(choice: InkShapeChoice, drawn: Box, defaults: { width: number; height: number }): Box {
  const minimum = MINIMUM[choice];
  if (choice === 'junction') return centred(drawn, defaults.width, defaults.height);
  return centred(drawn, Math.max(drawn.width, minimum.width), Math.max(drawn.height, minimum.height));
}

const MINIMUM: Record<InkShapeChoice, { width: number; height: number }> = {
  component: { width: 112, height: 48 },
  service: { width: 120, height: 56 },
  boundary: { width: 160, height: 100 },
  note: { width: 120, height: 48 },
  database: { width: 72, height: 72 },
  queue: { width: 100, height: 40 },
  actor: { width: 80, height: 80 },
  junction: { width: 36, height: 36 },
};

function centred(box: Box, width: number, height: number): Box {
  return {
    x: Math.round(box.x + box.width / 2 - width / 2),
    y: Math.round(box.y + box.height / 2 - height / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}
