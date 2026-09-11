/**
 * Pure geometry for the Sequence Diagram's custom SVG preview — no React, no DOM writes, so it's
 * unit-testable exactly like the rest of this module. `render/svg/`'s own `SvgEl` tree is
 * deliberately not reused here: that exists to keep the live canvas and an exported-file SVG
 * byte-identical, which is irrelevant when there is exactly one output path (an in-app preview,
 * no image export in V1).
 */
import { FONTS } from '../render/text/fonts';
import { getMeasurer, type TextMeasurer } from '../render/text/measure';
import type { Accent } from '../document/types';
import type { InteractionKind, SequenceModel } from './types';

const PARTICIPANT_FONT = FONTS.nodeLabel;
const MESSAGE_FONT = FONTS.connectorCaption;

const COLUMN_MIN_WIDTH = 96;
/** Horizontal padding inside a participant box, each side. */
const COLUMN_PADDING_X = 16;
/** Minimum gap between two adjacent lifelines, beyond their boxes' own half-widths. */
const COLUMN_GUTTER = 56;
/** Minimum clearance a message's label needs on each side of its arrow. */
const MESSAGE_LABEL_PADDING = 24;
/** Exported so the SVG component can draw each participant's header box in the same band this
 *  module reserves for it, without duplicating the constant. */
export const HEADER_HEIGHT = 36;
export const TOP_MARGIN = 16;
const ROW_HEIGHT = 44;
const BOTTOM_MARGIN = 24;
/** A layout with no participants still needs a sane, non-zero canvas to sit an empty state in. */
const EMPTY_WIDTH = 240;

export interface SequenceLayoutParticipant {
  id: string;
  x: number;
  boxWidth: number;
}

export interface SequenceLayoutMessage {
  id: string;
  y: number;
  fromX: number;
  toX: number;
  labelX: number;
  /** The label's measured text width, in the same units as `x`/`width` — lets a renderer size a
   *  legibility background behind the text without re-measuring it itself. */
  labelWidth: number;
  interaction: InteractionKind;
  accent?: Accent;
}

export interface SequenceLayout {
  width: number;
  height: number;
  participants: SequenceLayoutParticipant[];
  lifelineTop: number;
  lifelineBottom: number;
  messages: SequenceLayoutMessage[];
}

function isAdjacentPair(participants: SequenceModel['participants'], leftIndex: number, from: string, to: string) {
  const a = participants[leftIndex]!.id;
  const b = participants[leftIndex + 1]!.id;
  return (from === a && to === b) || (from === b && to === a);
}

export function computeSequenceLayout(model: SequenceModel, measurer: TextMeasurer = getMeasurer()): SequenceLayout {
  const lifelineTop = TOP_MARGIN + HEADER_HEIGHT;

  if (model.participants.length === 0) {
    return {
      width: EMPTY_WIDTH,
      height: lifelineTop + BOTTOM_MARGIN,
      participants: [],
      lifelineTop,
      lifelineBottom: lifelineTop,
      messages: [],
    };
  }

  const boxWidths = model.participants.map((p) =>
    Math.max(COLUMN_MIN_WIDTH, measurer.width(p.label, PARTICIPANT_FONT) + COLUMN_PADDING_X * 2),
  );

  // Minimum center-to-center gap between each adjacent column pair, widened when a message
  // directly between exactly those two columns needs more room than the boxes alone allow. A
  // message between non-adjacent columns is not specifically accounted for — a documented V1
  // simplification, since Draft Canvas's flows are predominantly near-linear; worst case a very
  // long-distance label sits a little tight, never overlapping or breaking layout.
  const gaps: number[] = [];
  for (let i = 0; i < model.participants.length - 1; i += 1) {
    const boxGap = boxWidths[i]! / 2 + COLUMN_GUTTER + boxWidths[i + 1]! / 2;
    let messageGap = 0;
    for (const message of model.messages) {
      if (!isAdjacentPair(model.participants, i, message.from, message.to)) continue;
      messageGap = Math.max(messageGap, measurer.width(message.label, MESSAGE_FONT) + MESSAGE_LABEL_PADDING * 2);
    }
    gaps.push(Math.max(boxGap, messageGap));
  }

  const xs: number[] = [boxWidths[0]! / 2];
  for (const gap of gaps) xs.push(xs[xs.length - 1]! + gap);

  const participants: SequenceLayoutParticipant[] = model.participants.map((p, i) => ({
    id: p.id,
    x: xs[i]!,
    boxWidth: boxWidths[i]!,
  }));

  const indexById = new Map(model.participants.map((p, i) => [p.id, i]));
  const messages: SequenceLayoutMessage[] = model.messages.map((message, i) => {
    const fromX = xs[indexById.get(message.from)!]!;
    const toX = xs[indexById.get(message.to)!]!;
    return {
      id: String(message.order),
      y: lifelineTop + ROW_HEIGHT * (i + 1),
      fromX,
      toX,
      labelX: (fromX + toX) / 2,
      labelWidth: measurer.width(message.label, MESSAGE_FONT),
      interaction: message.interaction,
      accent: message.accent,
    };
  });

  const lifelineBottom = lifelineTop + ROW_HEIGHT * (model.messages.length + 1);
  const width = xs[xs.length - 1]! + boxWidths[boxWidths.length - 1]! / 2 + COLUMN_GUTTER;
  const height = lifelineBottom + BOTTOM_MARGIN;

  return { width, height, participants, lifelineTop, lifelineBottom, messages };
}
