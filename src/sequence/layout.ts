/**
 * Where everything in a sequence is drawn.
 *
 * A sequence is a timeline, not a graph: participants are columns, and everything else is a row in
 * the order it is said. So this is its own small solver rather than the graph layout Arrange uses —
 * a general one has no idea that a reply belongs under its call. It is a pure function of the
 * sequence: the same sequence gives the same picture, and nothing is ever read back from it.
 *
 * Columns are spaced by what has to fit between them (a message's words, a fragment's frame, a note),
 * rows by what they hold. A box larger than that takes the slack as wider gaps and longer lifelines;
 * text and arrowheads never stretch.
 *
 * The result is geometry only. `nodes/sequence.ts` draws it, the canvas overlay hit-tests it, and
 * presentation frames it — all from this one answer.
 */
import { heightOf, participantsIn } from '../document/sequenceModel';
import type {
  DraftSequence,
  SeqFragment,
  SeqItem,
  SeqMessage,
  SeqMessageKind,
  SeqNote,
  SeqOperator,
  SeqParticipant,
} from '../document/types';
import { FONTS, LINE_HEIGHTS, type FontSpec } from '../render/text/fonts';
import { layoutText, type TextLayout } from '../render/text/layout';
import { getMeasurer, type TextMeasurer } from '../render/text/measure';
import { executionsOf } from './executions';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutInput {
  sequence: DraftSequence;
  title?: string;
  /** The node's own box. Anything beyond what the sequence needs becomes wider gaps and longer lifelines. */
  box?: { width: number; height: number };
  measurer?: TextMeasurer;
  /** The size a participant's head is drawn at — the shape's own renderer decides (`nodes/sequence.ts`). */
  headSize: (participant: SeqParticipant) => { width: number; height: number };
  /** Whether a participant's head carries a mark above its corner, which needs headroom. */
  hasMark?: (participant: SeqParticipant) => boolean;
}

export interface ColumnLayout {
  id: string;
  index: number;
  /** The lifeline. */
  x: number;
  head: Rect;
  lifeTop: number;
  lifeBottom: number;
  /** Brought into being part-way down: its head sits at its creation, not in the top row. */
  created: boolean;
  destroyed: boolean;
}

export interface LabelLayout {
  /** Anchor x; meaning depends on `align`. */
  x: number;
  /** Top of the text block. */
  y: number;
  align: 'start' | 'middle' | 'end';
  layout: TextLayout;
  font: FontSpec;
}

export interface MessageLayout {
  id: string;
  number: number;
  kind: SeqMessageKind;
  from: string;
  to: string;
  self: boolean;
  /** Where it leaves its sender. */
  x1: number;
  y: number;
  /** Where it arrives. For a message to itself, lower on the same lifeline. */
  x2: number;
  yEnd: number;
  /** How far a message to itself reaches out to the right. */
  reach: number;
  label: LabelLayout | null;
  /** Everything of it: line and words. What a click or a selection takes hold of. */
  box: Rect;
}

export interface NoteLayout {
  id: string;
  box: Rect;
  text: LabelLayout;
}

export interface OperandLayout {
  id: string;
  /** The branch's band, the full width of its fragment. */
  box: Rect;
  guard: LabelLayout | null;
  /** The dashed line above every branch but the first. */
  separatorY: number | null;
}

export interface FragmentLayout {
  id: string;
  operator: SeqOperator;
  box: Rect;
  /** The corner tab holding the operator's name. */
  tab: Rect;
  tabText: LabelLayout;
  /** A `ref`'s name, centred in its frame. */
  label: LabelLayout | null;
  operands: OperandLayout[];
  /** Fragments around it. */
  depth: number;
}

export interface ExecutionLayout {
  participantId: string;
  startId: string;
  box: Rect;
  depth: number;
}

export interface GroupLayout {
  id: string;
  box: Rect;
  caption: LabelLayout | null;
}

/** Somewhere a new item can go: a line across the list it would join. */
export interface SlotLayout {
  operandId: string | null;
  index: number;
  y: number;
  x1: number;
  x2: number;
  /** Fragments around the list. */
  depth: number;
}

export interface SequenceLayout {
  /** What the sequence needs. */
  natural: { width: number; height: number };
  /** What it is drawn at: `natural`, or the box when that is larger. */
  width: number;
  height: number;
  title: LabelLayout | null;
  columns: ColumnLayout[];
  messages: MessageLayout[];
  notes: NoteLayout[];
  fragments: FragmentLayout[];
  executions: ExecutionLayout[];
  groups: GroupLayout[];
  slots: SlotLayout[];
  /** Where the lifelines begin and end for participants that are there throughout. */
  bodyTop: number;
  bodyBottom: number;
  /** Every participant, item, branch and group by id. */
  boxes: Map<string, Rect>;
}

/* ------------------------------------------------------------------ measures -- */

/** From the frame to the outermost thing in it: room for the frame's own handles and a place to add a participant. */
const PAD_X = 30;
const PAD_TOP = 12;
const PAD_BOTTOM = 14;
const TITLE_GAP = 8;
/** A title makes its sequence this wide at most; a longer one is cut short, in full in its editor. */
const TITLE_MAX_WIDTH = 360;
/** Room above the heads for a technology mark (`markerRail.ts`: a 16px mark lifted 5px). */
const MARK_HEADROOM = 24;
const NO_MARK_HEADROOM = 4;
const GROUP_CAPTION_HEIGHT = 18;
const GROUP_PAD = 8;
/** Between two heads that are not in the same group. */
const GROUP_GAP = 18;
const HEAD_GAP = 28;
const MIN_COLUMN_GAP = 132;
const HEAD_TO_BODY = 18;
const MIN_LIFELINE = 44;
const LIFELINE_TAIL = 24;

const LABEL_MAX_WIDTH = 240;
const LABEL_MIN_WIDTH = 56;
/** Clear of the lifeline (and any bar on it) at each end of a message's words. */
const LABEL_SIDE = 16;
const LABEL_GAP = 4;
const ROW_MIN_ABOVE = 10;
// Leave a clear target between the arrow's endpoint handles and the next insertion slot.
const ROW_AFTER = 30;

const SELF_REACH = 30;
const SELF_DROP = 18;
const SELF_LABEL_GAP = 8;
const SELF_LABEL_MAX = 180;

const BAR_WIDTH = 10;
const BAR_STEP = 5;
const BAR_OPEN_TAIL = 10;
const BAR_MIN_HEIGHT = 12;

/** A frame keeps this far from the lifelines at its edges, so it reads as around them. */
const FRAME_SIDE = 24;
/** And this far from a frame inside it. */
const FRAME_NEST = 8;
const FRAME_HEADER = 24;
const FRAME_BRANCH_HEADER = 20;
const FRAME_EMPTY = 22;
const FRAME_BOTTOM = 8;
const TAB_PAD_X = 8;
const TAB_HEIGHT = 18;
/** Between a tab's cut corner and the lifeline beside it. */
const TAB_CLEAR = 12;
const GUARD_GAP = 8;
/** From a lifeline to a condition written beside it: past two stacked bars. */
const GUARD_CLEAR = 16;
const GUARD_MAX_WIDTH = 200;
const REF_HEIGHT = 44;

const NOTE_PAD_X = 8;
const NOTE_PAD_Y = 6;
const NOTE_MAX_WIDTH = 180;
const NOTE_SIDE_GAP = 12;

const lineHeightOf = (font: FontSpec, ratio = LINE_HEIGHTS.label): number => font.size * ratio;

/** The words a fragment's tab shows. UML's own, lower case: what a reader of sequence diagrams looks for. */
export const OPERATOR_WORDS: Record<SeqOperator, string> = {
  alt: 'alt',
  opt: 'opt',
  loop: 'loop',
  par: 'par',
  break: 'break',
  critical: 'critical',
  ref: 'ref',
};

/* -------------------------------------------------------------------- columns -- */

interface Spacing {
  /** Centre-to-centre distance between column `i` and `i + 1`. */
  gaps: number[];
  /** Room needed left of the first lifeline and right of the last. */
  left: number;
  right: number;
}

interface Need {
  a: number;
  b: number;
  width: number;
}

function spaceColumns(input: LayoutInput, heads: { width: number; height: number }[], measurer: TextMeasurer): Spacing {
  const { sequence } = input;
  const count = sequence.participants.length;
  const index = new Map(sequence.participants.map((participant, at) => [participant.id, at]));
  const gaps: number[] = [];
  const groupOf = (participantId: string) => sequence.groups?.find((group) => group.participantIds.includes(participantId))?.id;
  for (let at = 0; at < count - 1; at += 1) {
    const left = sequence.participants[at]!;
    const right = sequence.participants[at + 1]!;
    const apart = groupOf(left.id) !== groupOf(right.id) ? GROUP_GAP : 0;
    gaps.push(Math.max(MIN_COLUMN_GAP, (heads[at]!.width + heads[at + 1]!.width) / 2 + HEAD_GAP + apart));
  }
  const spacing: Spacing = {
    gaps,
    left: count > 0 ? heads[0]!.width / 2 : 0,
    right: count > 0 ? heads[count - 1]!.width / 2 : 0,
  };
  if (sequence.groups?.some((group) => group.participantIds.includes(sequence.participants[0]?.id ?? ''))) spacing.left += GROUP_PAD;
  if (sequence.groups?.some((group) => group.participantIds.includes(sequence.participants[count - 1]?.id ?? ''))) spacing.right += GROUP_PAD;

  const spans: Need[] = [];
  const needRight = (column: number, width: number) => {
    if (column < count - 1) gaps[column] = Math.max(gaps[column]!, width);
    else spacing.right = Math.max(spacing.right, width);
  };
  const needLeft = (column: number, width: number) => {
    if (column > 0) gaps[column - 1] = Math.max(gaps[column - 1]!, width);
    else spacing.left = Math.max(spacing.left, width);
  };
  const widthOf = (text: string, font: FontSpec, max: number): number =>
    text.trim() ? layoutText(text, { font, maxWidth: max, lineHeight: lineHeightOf(font), maxLines: 2, measurer }).width : 0;

  /** `depth` is how many frames sit between the item and the open sequence: each needs its own margin. */
  const visit = (items: readonly SeqItem[], depth: number) => {
    for (const item of items) {
      if (item.t === 'message') {
        const from = index.get(item.from);
        const to = index.get(item.to);
        if (from === undefined || to === undefined) continue;
        const words = widthOf(item.label, FONTS.sequenceMessage, LABEL_MAX_WIDTH);
        if (from === to) {
          const label = Math.min(words, SELF_LABEL_MAX);
          needRight(from, BAR_WIDTH + SELF_REACH + (label > 0 ? SELF_LABEL_GAP + label : 0) + FRAME_NEST * depth + LABEL_SIDE);
        } else {
          spans.push({ a: Math.min(from, to), b: Math.max(from, to), width: words + LABEL_SIDE * 2 + BAR_WIDTH });
        }
        continue;
      }
      if (item.t === 'note') {
        const columns = item.over.map((id) => index.get(id)).filter((at): at is number => at !== undefined);
        if (columns.length === 0) continue;
        const first = Math.min(...columns);
        const last = Math.max(...columns);
        const width = widthOf(item.text, FONTS.sequenceNote, NOTE_MAX_WIDTH) + NOTE_PAD_X * 2;
        if (item.side === 'right') needRight(first, NOTE_SIDE_GAP + width + NOTE_SIDE_GAP + FRAME_NEST * depth);
        else if (item.side === 'left') needLeft(first, NOTE_SIDE_GAP + width + NOTE_SIDE_GAP + FRAME_NEST * depth);
        else if (first === last) {
          needRight(first, width / 2 + NOTE_SIDE_GAP + FRAME_NEST * depth);
          needLeft(first, width / 2 + NOTE_SIDE_GAP + FRAME_NEST * depth);
        }
        continue;
      }
      const touched = [...participantsIn(item)].map((id) => index.get(id)).filter((at): at is number => at !== undefined);
      const first = touched.length > 0 ? Math.min(...touched) : 0;
      const last = touched.length > 0 ? Math.max(...touched) : Math.max(0, count - 1);
      // Its own margin beyond the lifelines, plus one for every frame it holds and every one around it.
      // On the left the margin also has to hold the tab, which sits clear of the first lifeline.
      const tab = Math.ceil(measurer.width(OPERATOR_WORDS[item.operator], FONTS.sequenceOperator)) + TAB_PAD_X * 2;
      const margin = FRAME_SIDE + FRAME_NEST * (heightOf(item) - 1);
      needLeft(first, Math.max(margin, tab + TAB_CLEAR) + FRAME_NEST * depth + (first > 0 ? LABEL_SIDE : 0));
      needRight(last, margin + FRAME_NEST * depth + (last < count - 1 ? LABEL_SIDE : 0));
      const guard = item.operator === 'ref' ? widthOf(item.label ?? '', FONTS.sequenceMessage, GUARD_MAX_WIDTH) : widthOf(item.operands[0]?.guard ? `[${item.operands[0].guard}]` : '', FONTS.sequenceGuard, GUARD_MAX_WIDTH);
      const header = tab + TAB_CLEAR + GUARD_CLEAR + guard + GUARD_GAP * 2;
      if (last > first) spans.push({ a: first, b: last, width: header - margin * 2 });
      else needRight(first, header - margin + FRAME_NEST * depth);
      for (const branch of item.operands) visit(branch.items, depth + 1);
    }
  };
  visit(sequence.items, 0);

  // Shortest spans first, so a long message is only given what its shorter neighbours left it short of.
  spans.sort((p, q) => p.b - p.a - (q.b - q.a));
  for (const need of spans) {
    let have = 0;
    for (let at = need.a; at < need.b; at += 1) have += gaps[at]!;
    if (have >= need.width) continue;
    const each = (need.width - have) / (need.b - need.a);
    for (let at = need.a; at < need.b; at += 1) gaps[at] = gaps[at]! + each;
  }
  for (let at = 0; at < gaps.length; at += 1) gaps[at] = Math.ceil(gaps[at]!);
  spacing.left = Math.ceil(spacing.left);
  spacing.right = Math.ceil(spacing.right);
  return spacing;
}

/* ----------------------------------------------------------------------- rows -- */

interface Extent {
  min: number;
  max: number;
}

const NOTHING: Extent = { min: Infinity, max: -Infinity };
const join = (a: Extent, b: Extent): Extent => ({ min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) });

/**
 * A box wider than the sequence needs is taken up by wider gaps between the lifelines, which moves
 * everything — so the sequence is laid out once to learn what it needs, and again with the slack
 * when there is any.
 */
export function layoutSequence(input: LayoutInput): SequenceLayout {
  const measurer = input.measurer ?? getMeasurer();
  const heads = input.sequence.participants.map((participant) => input.headSize(participant));
  const spacing = spaceColumns(input, heads, measurer);
  const snug = solve(input, measurer, heads, spacing, 0, null);
  const slack = (input.box?.width ?? 0) - snug.natural.width;
  if (slack <= 0 || spacing.gaps.length === 0) return snug;
  return solve(input, measurer, heads, spacing, slack, snug.natural);
}

function solve(
  input: LayoutInput,
  measurer: TextMeasurer,
  heads: { width: number; height: number }[],
  spacing: Spacing,
  slackX: number,
  known: { width: number; height: number } | null,
): SequenceLayout {
  const { sequence } = input;
  const participants = sequence.participants;
  const indexOf = new Map(participants.map((participant, at) => [participant.id, at]));
  const boxes = new Map<string, Rect>();

  const words = (text: string, font: FontSpec, maxWidth: number, maxLines = 2): TextLayout =>
    layoutText(text, { font, maxWidth: Math.max(LABEL_MIN_WIDTH, maxWidth), lineHeight: lineHeightOf(font), maxLines, measurer });

  /* Across. */
  const gapsNatural = spacing.gaps.reduce((sum, gap) => sum + gap, 0);
  const naturalWidth = PAD_X * 2 + spacing.left + gapsNatural + spacing.right;
  const gaps = spacing.gaps.length > 0 ? spacing.gaps.map((gap) => gap + slackX / spacing.gaps.length) : [];
  const columnX: number[] = [];
  let cursorX = PAD_X + spacing.left;
  for (let at = 0; at < participants.length; at += 1) {
    columnX.push(cursorX);
    cursorX += gaps[at] ?? 0;
  }
  const xOf = (participantId: string): number => columnX[indexOf.get(participantId) ?? 0] ?? PAD_X;
  const frameLeft = PAD_X / 2;
  const frameRight = (width: number) => width - PAD_X / 2;

  /* Down: the top band. */
  const titleText = input.title?.trim() ?? '';
  const titleLayout = titleText ? words(titleText, FONTS.groupTitle, Math.max(TITLE_MAX_WIDTH, naturalWidth + slackX - PAD_X * 2), 1) : null;
  const title: LabelLayout | null = titleLayout ? { x: PAD_X - 6, y: PAD_TOP - 2, align: 'start', layout: titleLayout, font: FONTS.groupTitle } : null;
  const anyMark = participants.some((participant) => input.hasMark?.(participant));
  const anyGroup = (sequence.groups?.length ?? 0) > 0;
  const bandTop = PAD_TOP + (titleLayout ? titleLayout.height + TITLE_GAP : 0);
  const headTop = bandTop + (anyGroup ? GROUP_CAPTION_HEIGHT : 0) + (anyMark ? MARK_HEADROOM : NO_MARK_HEADROOM);
  const created = new Map<string, string>();
  const destroyedBy = new Map<string, string>();
  const noteLifetimes = (items: readonly SeqItem[]) => {
    for (const item of items) {
      if (item.t === 'message') {
        if (item.kind === 'create' && item.from !== item.to && !created.has(item.to)) created.set(item.to, item.id);
        if (item.kind === 'destroy' && !destroyedBy.has(item.to)) destroyedBy.set(item.to, item.id);
      } else if (item.t === 'fragment') for (const branch of item.operands) noteLifetimes(branch.items);
    }
  };
  noteLifetimes(sequence.items);
  const topRow = heads.filter((_, at) => !created.has(participants[at]!.id));
  const headRow = topRow.length > 0 ? Math.max(...topRow.map((head) => head.height)) : 0;
  const headBottom = headTop + headRow;
  const bodyTop = headBottom + (participants.length > 0 ? HEAD_TO_BODY : 0);

  /* Down: the rows. */
  const messages: MessageLayout[] = [];
  const notes: NoteLayout[] = [];
  const fragments: FragmentLayout[] = [];
  const slots: SlotLayout[] = [];
  const messageById = new Map<string, MessageLayout>();
  const createdAt = new Map<string, number>();
  const destroyedAt = new Map<string, number>();
  let cursor = bodyTop;

  const placeMessage = (item: SeqMessage): Extent => {
    const from = xOf(item.from);
    const to = xOf(item.to);
    const top = cursor;
    if (item.from === item.to) {
      const layout = item.label.trim() ? words(item.label, FONTS.sequenceMessage, SELF_LABEL_MAX) : null;
      const labelHeight = layout?.height ?? 0;
      const y = top + Math.max(6, (labelHeight - SELF_DROP) / 2);
      const yEnd = y + SELF_DROP;
      const labelX = from + BAR_WIDTH + SELF_REACH + SELF_LABEL_GAP;
      const label: LabelLayout | null = layout ? { x: labelX, y: y + SELF_DROP / 2 - labelHeight / 2, align: 'start', layout, font: FONTS.sequenceMessage } : null;
      const bottom = Math.max(yEnd, label ? label.y + labelHeight : yEnd);
      const right = label ? labelX + layout!.width : from + BAR_WIDTH + SELF_REACH;
      const message: MessageLayout = {
        id: item.id,
        number: messages.length + 1,
        kind: item.kind,
        from: item.from,
        to: item.to,
        self: true,
        x1: from,
        y,
        x2: from,
        yEnd,
        reach: SELF_REACH,
        label,
        box: { x: from - 6, y: Math.min(y, label?.y ?? y) - 4, w: right - from + 12, h: bottom - Math.min(y, label?.y ?? y) + 8 },
      };
      messages.push(message);
      messageById.set(item.id, message);
      if (item.kind === 'destroy') destroyedAt.set(item.to, yEnd);
      cursor = bottom + ROW_AFTER;
      return { min: from - FRAME_SIDE, max: right + FRAME_NEST };
    }

    const span = Math.abs(to - from);
    const creates = item.kind === 'create' && created.get(item.to) === item.id;
    const head = heads[indexOf.get(item.to) ?? 0]!;
    const layout = item.label.trim() ? words(item.label, FONTS.sequenceMessage, Math.min(LABEL_MAX_WIDTH, span - LABEL_SIDE * 2 - (creates ? head.width / 2 : 0))) : null;
    const labelHeight = layout?.height ?? 0;
    let y = top + Math.max(labelHeight + LABEL_GAP, ROW_MIN_ABOVE);
    let after = ROW_AFTER;
    if (creates) {
      // The new participant's head sits on the message that makes it.
      y = Math.max(y, top + head.height / 2);
      after = Math.max(ROW_AFTER, head.height / 2 + 8);
      createdAt.set(item.to, y);
    }
    if (item.kind === 'destroy') destroyedAt.set(item.to, y);
    const end = creates ? to - Math.sign(to - from) * (head.width / 2) : to;
    const label: LabelLayout | null = layout ? { x: (from + end) / 2, y: y - LABEL_GAP - labelHeight, align: 'middle', layout, font: FONTS.sequenceMessage } : null;
    const left = Math.min(from, end);
    const message: MessageLayout = {
      id: item.id,
      number: messages.length + 1,
      kind: item.kind,
      from: item.from,
      to: item.to,
      self: false,
      x1: from,
      y,
      x2: end,
      yEnd: y,
      reach: 0,
      label,
      box: { x: left, y: (label?.y ?? y - 8) - 2, w: Math.abs(end - from), h: y - (label?.y ?? y - 8) + 10 },
    };
    messages.push(message);
    messageById.set(item.id, message);
    cursor = y + after;
    return { min: Math.min(from, to) - FRAME_SIDE, max: Math.max(from, to) + FRAME_SIDE };
  };

  const placeNote = (item: SeqNote): Extent => {
    const columns = item.over.map((id) => xOf(id));
    const first = Math.min(...columns);
    const last = Math.max(...columns);
    const spanning = last > first && !item.side;
    const maxText = spanning ? last - first + NOTE_SIDE_GAP * 2 - NOTE_PAD_X * 2 : NOTE_MAX_WIDTH;
    const layout = words(item.text.trim() ? item.text : ' ', FONTS.sequenceNote, maxText, 6);
    const width = spanning ? last - first + NOTE_SIDE_GAP * 2 : Math.max(layout.width, 40) + NOTE_PAD_X * 2;
    const height = layout.height + NOTE_PAD_Y * 2;
    const x = spanning ? first - NOTE_SIDE_GAP : item.side === 'right' ? first + NOTE_SIDE_GAP : item.side === 'left' ? first - NOTE_SIDE_GAP - width : first - width / 2;
    const box: Rect = { x, y: cursor, w: width, h: height };
    notes.push({ id: item.id, box, text: { x: x + NOTE_PAD_X, y: cursor + NOTE_PAD_Y, align: 'start', layout, font: FONTS.sequenceNote } });
    boxes.set(item.id, box);
    cursor += height + ROW_AFTER;
    return { min: x - FRAME_NEST, max: x + width + FRAME_NEST };
  };

  const placeFragment = (item: SeqFragment, depth: number): Extent => {
    const top = cursor;
    const tabWord = OPERATOR_WORDS[item.operator];
    const tabWidth = Math.ceil(measurer.width(tabWord, FONTS.sequenceOperator)) + TAB_PAD_X * 2;
    const placed: { id: string; top: number; bottom: number; guard?: string; separatorY: number | null }[] = [];
    let extent = NOTHING;

    if (item.operator === 'ref') {
      cursor += REF_HEIGHT;
    } else {
      cursor += FRAME_HEADER;
      item.operands.forEach((branch, at) => {
        const branchTop = at === 0 ? top : cursor;
        const separatorY = at === 0 ? null : cursor;
        if (at > 0) cursor += FRAME_BRANCH_HEADER;
        const before = cursor;
        extent = join(extent, placeItems(branch.items, branch.id, depth + 1));
        if (cursor === before) cursor += FRAME_EMPTY;
        placed.push({ id: branch.id, top: branchTop, bottom: cursor, guard: branch.guard, separatorY });
      });
      cursor += FRAME_BOTTOM;
    }
    const bottom = cursor;
    cursor += ROW_AFTER;

    if (extent.min === Infinity) {
      const covered = (item.covers ?? []).map((id) => indexOf.get(id)).filter((at): at is number => at !== undefined);
      const all = covered.length > 0 ? covered : participants.map((_, at) => at);
      extent = all.length > 0
        ? { min: columnX[Math.min(...all)]! - FRAME_SIDE, max: columnX[Math.max(...all)]! + FRAME_SIDE }
        : { min: PAD_X, max: PAD_X + 120 };
    }
    // The tab stays clear of the first lifeline the frame is around, and of any bar on it.
    const around = [...participantsIn(item)].map((id) => indexOf.get(id)).filter((at): at is number => at !== undefined);
    const firstLifeline = around.length > 0 ? columnX[Math.min(...around)]! : extent.min + FRAME_SIDE;
    extent = { min: Math.min(extent.min, firstLifeline - tabWidth - TAB_CLEAR), max: extent.max };
    const firstGuard = item.operands[0]?.guard ? `[${item.operands[0].guard}]` : '';
    const header = tabWidth + TAB_CLEAR + GUARD_CLEAR + (firstGuard ? Math.min(GUARD_MAX_WIDTH, measurer.width(firstGuard, FONTS.sequenceGuard)) : 0) + GUARD_GAP;
    const box: Rect = { x: extent.min, y: top, w: Math.max(extent.max - extent.min, header, tabWidth + 24), h: bottom - top };
    boxes.set(item.id, box);

    const tabLayout = words(tabWord, FONTS.sequenceOperator, tabWidth, 1);
    const tab: Rect = { x: box.x, y: box.y, w: tabWidth, h: TAB_HEIGHT };
    const operands: OperandLayout[] = placed.map((branch, at) => {
      const text = branch.guard ? `[${branch.guard}]` : '';
      // Every branch's condition starts just past the first lifeline: clear of the tab, clear of
      // any bar on that lifeline, and in one column down the frame.
      const guardX = Math.max(box.x + (at === 0 ? tabWidth : 0) + GUARD_GAP, Math.min(firstLifeline + GUARD_CLEAR, box.x + box.w - 60));
      const guardLayout = text ? words(text, FONTS.sequenceGuard, box.x + box.w - guardX - GUARD_GAP, 1) : null;
      const guardY = (at === 0 ? box.y + (TAB_HEIGHT - (guardLayout?.height ?? 0)) / 2 : branch.separatorY! + (FRAME_BRANCH_HEADER - (guardLayout?.height ?? 0)) / 2);
      const operandBox: Rect = { x: box.x, y: branch.top, w: box.w, h: (at === placed.length - 1 ? bottom : branch.bottom) - branch.top };
      boxes.set(branch.id, operandBox);
      return {
        id: branch.id,
        box: operandBox,
        guard: guardLayout ? { x: guardX, y: guardY, align: 'start', layout: guardLayout, font: FONTS.sequenceGuard } : null,
        separatorY: branch.separatorY,
      };
    });
    let label: LabelLayout | null = null;
    if (item.operator === 'ref' && item.label?.trim()) {
      const layout = words(item.label, FONTS.sequenceMessage, box.w - 24, 1);
      label = { x: box.x + box.w / 2, y: box.y + (REF_HEIGHT - layout.height) / 2 + 4, align: 'middle', layout, font: FONTS.sequenceMessage };
    }
    fragments.push({ id: item.id, operator: item.operator, box, tab, tabText: { x: tab.x + TAB_PAD_X, y: tab.y + (TAB_HEIGHT - tabLayout.height) / 2, align: 'start', layout: tabLayout, font: FONTS.sequenceOperator }, label, operands, depth });
    return { min: box.x - FRAME_NEST, max: box.x + box.w + FRAME_NEST };
  };

  /** Slots are filled in once the list's own extent is known; until then they carry only where down. */
  const pending: { slot: SlotLayout; list: number }[] = [];
  let lists = 0;
  const listExtents: Extent[] = [];

  function placeItems(items: readonly SeqItem[], operandId: string | null, depth: number): Extent {
    const list = lists;
    lists += 1;
    let extent = NOTHING;
    items.forEach((item, at) => {
      // The middle of the gap above the row: the top of the list for the first, the space the row
      // before left under itself for the rest.
      const y = at === 0 ? cursor - (depth === 0 ? HEAD_TO_BODY / 2 : 3) : cursor - ROW_AFTER / 2;
      pending.push({ slot: { operandId, index: at, y, x1: 0, x2: 0, depth }, list });
      const placed = item.t === 'message' ? placeMessage(item) : item.t === 'note' ? placeNote(item) : placeFragment(item, depth);
      extent = join(extent, placed);
    });
    pending.push({ slot: { operandId, index: items.length, y: items.length === 0 ? cursor + FRAME_EMPTY / 2 : cursor - ROW_AFTER / 2, x1: 0, x2: 0, depth }, list });
    listExtents[list] = extent;
    return extent;
  }

  const rootExtent = placeItems(sequence.items, null, 0);
  const contentBottom = Math.max(cursor, bodyTop + (participants.length > 0 ? MIN_LIFELINE : 0));

  /* Size. The spacing above already made room for all of it; this catches whatever it rounded short. */
  const reach = Math.max(
    rootExtent.max === -Infinity ? 0 : rootExtent.max - FRAME_NEST,
    ...fragments.map((fragment) => fragment.box.x + fragment.box.w),
    ...messages.map((message) => message.box.x + message.box.w),
    title ? title.x + title.layout.width : 0,
  );
  const natural = known ?? {
    width: Math.ceil(Math.max(naturalWidth, reach + PAD_X)),
    height: Math.ceil(contentBottom + LIFELINE_TAIL + PAD_BOTTOM),
  };
  const width = Math.max(natural.width, input.box?.width ?? 0);
  const height = Math.max(natural.height, input.box?.height ?? 0);
  const bodyBottom = height - PAD_BOTTOM;

  /* Slots, now that every list knows how wide it is. */
  for (const { slot, list } of pending) {
    const operandBox = slot.operandId ? boxes.get(slot.operandId) : undefined;
    const extent = listExtents[list]!;
    slot.x1 = operandBox ? operandBox.x : frameLeft;
    slot.x2 = operandBox ? operandBox.x + operandBox.w : frameRight(width);
    if (!operandBox && extent.min !== Infinity) {
      slot.x1 = Math.min(slot.x1, extent.min);
      slot.x2 = Math.max(slot.x2, extent.max);
    }
    slots.push(slot);
  }

  /* Lifelines. */
  const columns: ColumnLayout[] = participants.map((participant, at) => {
    const head = heads[at]!;
    const x = columnX[at]!;
    const madeAt = createdAt.get(participant.id);
    const headBox: Rect = madeAt === undefined
      ? { x: x - head.width / 2, y: headBottom - head.height, w: head.width, h: head.height }
      : { x: x - head.width / 2, y: madeAt - head.height / 2, w: head.width, h: head.height };
    boxes.set(participant.id, headBox);
    const end = destroyedAt.get(participant.id);
    return {
      id: participant.id,
      index: at,
      x,
      head: headBox,
      lifeTop: headBox.y + headBox.h,
      lifeBottom: end ?? bodyBottom,
      created: madeAt !== undefined,
      destroyed: end !== undefined,
    };
  });

  /* Bars, and where each message meets them. */
  const plan = executionsOf(sequence);
  const executions: ExecutionLayout[] = [];
  for (const execution of plan.executions) {
    const start = messageById.get(execution.startId);
    const end = messageById.get(execution.endId);
    if (!start || !end) continue;
    const top = start.yEnd;
    const endY = execution.ends === 'at' ? (end.from === execution.participantId ? end.y : end.yEnd) : Math.max(end.y, end.yEnd) + BAR_OPEN_TAIL;
    const x = xOf(execution.participantId) - BAR_WIDTH / 2 + execution.depth * BAR_STEP;
    executions.push({
      participantId: execution.participantId,
      startId: execution.startId,
      box: { x, y: top, w: BAR_WIDTH, h: Math.max(BAR_MIN_HEIGHT, endY - top) },
      depth: execution.depth,
    });
  }
  const barsAt = (participantId: string, y: number): ExecutionLayout[] =>
    executions.filter((bar) => bar.participantId === participantId && y >= bar.box.y - 0.5 && y <= bar.box.y + bar.box.h + 0.5);
  /** Where a line at `y` meets this lifeline on the side facing `toward`: the edge of whatever bar is there. */
  const meet = (participantId: string, y: number, toward: 1 | -1): number => {
    const x = xOf(participantId);
    const bars = barsAt(participantId, y);
    if (bars.length === 0) return x;
    if (toward < 0) return x - BAR_WIDTH / 2;
    return Math.max(...bars.map((bar) => bar.box.x + bar.box.w));
  };
  for (const message of messages) {
    const column = columns[indexOf.get(message.to) ?? 0];
    if (message.self) {
      message.x1 = meet(message.from, message.y, 1);
      message.x2 = meet(message.to, message.yEnd, 1);
      message.reach = Math.max(message.x1, message.x2) - xOf(message.from) + SELF_REACH;
      boxes.set(message.id, message.box);
      continue;
    }
    const direction: 1 | -1 = xOf(message.to) > xOf(message.from) ? 1 : -1;
    message.x1 = meet(message.from, message.y, direction);
    const madeHere = message.kind === 'create' && column?.created && createdAt.get(message.to) === message.y;
    if (!madeHere) message.x2 = meet(message.to, message.y, direction === 1 ? -1 : 1);
    if (message.label) message.label.x = (message.x1 + message.x2) / 2;
    message.box = { ...message.box, x: Math.min(message.x1, message.x2), w: Math.abs(message.x2 - message.x1) };
    if (message.label) {
      // Words wider than the line they sit on still belong to the message.
      const half = message.label.layout.width / 2;
      const left = Math.min(message.box.x, message.label.x - half);
      const right = Math.max(message.box.x + message.box.w, message.label.x + half);
      message.box = { ...message.box, x: left, w: right - left };
    }
    boxes.set(message.id, message.box);
  }

  /* Groups: a band behind the heads and lifelines of its members. */
  const groups: GroupLayout[] = [];
  for (const group of sequence.groups ?? []) {
    const members = group.participantIds.map((id) => columns[indexOf.get(id) ?? -1]).filter((column): column is ColumnLayout => !!column);
    if (members.length === 0) continue;
    const left = Math.min(...members.map((column) => column.head.x)) - GROUP_PAD;
    const right = Math.max(...members.map((column) => column.head.x + column.head.w)) + GROUP_PAD;
    const box: Rect = { x: left, y: bandTop, w: right - left, h: bodyBottom + 6 - bandTop };
    const captionLayout = group.name.trim() ? words(group.name, FONTS.variantTag, box.w - GROUP_PAD * 2, 1) : null;
    groups.push({ id: group.id, box, caption: captionLayout ? { x: box.x + GROUP_PAD, y: box.y + 4, align: 'start', layout: captionLayout, font: FONTS.variantTag } : null });
    boxes.set(group.id, box);
  }

  return { natural, width, height, title, columns, messages, notes, fragments, executions, groups, slots, bodyTop, bodyBottom, boxes };
}

/* ------------------------------------------------------------------ hit tests -- */

export type SequenceHit =
  | { kind: 'participant'; id: string }
  | { kind: 'message'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'fragment'; id: string }
  | { kind: 'operand'; id: string; fragmentId: string }
  | { kind: 'lifeline'; participantId: string }
  | { kind: 'body' };

const inside = (rect: Rect, x: number, y: number, pad = 0): boolean =>
  x >= rect.x - pad && x <= rect.x + rect.w + pad && y >= rect.y - pad && y <= rect.y + rect.h + pad;

const LIFELINE_REACH = 9;
const FRAME_EDGE = 5;

/** What is under a point, in the sequence's own coordinates. The innermost thing wins. */
export function hitSequence(layout: SequenceLayout, x: number, y: number): SequenceHit {
  for (const column of layout.columns) if (inside(column.head, x, y)) return { kind: 'participant', id: column.id };
  for (const note of layout.notes) if (inside(note.box, x, y)) return { kind: 'note', id: note.id };
  for (const message of layout.messages) if (inside(message.box, x, y, 2)) return { kind: 'message', id: message.id };
  // A frame is taken hold of by its tab, its header and its edges; its middle belongs to what it holds.
  const frames = [...layout.fragments].sort((a, b) => b.depth - a.depth);
  for (const frame of frames) {
    if (!inside(frame.box, x, y, FRAME_EDGE)) continue;
    for (const branch of frame.operands) {
      if (branch.guard && inside({ x: branch.guard.x - 3, y: branch.guard.y - 2, w: branch.guard.layout.width + 6, h: branch.guard.layout.height + 4 }, x, y)) {
        return { kind: 'operand', id: branch.id, fragmentId: frame.id };
      }
    }
    const onEdge =
      Math.abs(x - frame.box.x) <= FRAME_EDGE ||
      Math.abs(x - (frame.box.x + frame.box.w)) <= FRAME_EDGE ||
      Math.abs(y - frame.box.y) <= FRAME_EDGE ||
      Math.abs(y - (frame.box.y + frame.box.h)) <= FRAME_EDGE;
    if (onEdge || inside(frame.tab, x, y) || frame.operator === 'ref') return { kind: 'fragment', id: frame.id };
    for (const branch of frame.operands) {
      if (branch.separatorY !== null && Math.abs(y - branch.separatorY) <= FRAME_EDGE) return { kind: 'operand', id: branch.id, fragmentId: frame.id };
    }
  }
  for (const column of layout.columns) {
    if (Math.abs(x - column.x) <= LIFELINE_REACH && y >= column.lifeTop && y <= column.lifeBottom) return { kind: 'lifeline', participantId: column.id };
  }
  return { kind: 'body' };
}

/** The lifeline nearest to `x`, within `reach` of it. */
export function columnNear(layout: SequenceLayout, x: number, reach = Infinity): ColumnLayout | null {
  let best: ColumnLayout | null = null;
  for (const column of layout.columns) {
    if (Math.abs(column.x - x) > reach) continue;
    if (!best || Math.abs(column.x - x) < Math.abs(best.x - x)) best = column;
  }
  return best;
}

/** Where a participant dropped at `x` would stand: before the first lifeline to its right. */
export function participantIndexAt(layout: SequenceLayout, x: number): number {
  let index = 0;
  for (const column of layout.columns) if (column.x < x) index = column.index + 1;
  return index;
}

/** The x of the gap a participant at `index` would open: between its neighbours, or just past the end. */
export function participantGapX(layout: SequenceLayout, index: number): number {
  const before = layout.columns[index - 1];
  const after = layout.columns[index];
  if (before && after) return (before.x + after.x) / 2;
  if (after) return after.head.x - 15;
  if (before) return before.head.x + before.head.w + 15;
  return PAD_X + 40;
}

/**
 * The slot a point would insert at: in the innermost branch under it, the gap nearest to it. Past
 * the last row of everything it is the end of the sequence.
 */
export function slotAt(layout: SequenceLayout, x: number, y: number): SlotLayout | null {
  let operandId: string | null = null;
  let depth = -1;
  for (const frame of layout.fragments) {
    if (frame.depth < depth) continue;
    for (const branch of frame.operands) {
      if (inside(branch.box, x, y) && frame.depth >= depth) {
        operandId = branch.id;
        depth = frame.depth;
      }
    }
  }
  let best: SlotLayout | null = null;
  for (const slot of layout.slots) {
    if (slot.operandId !== operandId) continue;
    if (!best || Math.abs(slot.y - y) < Math.abs(best.y - y)) best = slot;
  }
  return best;
}

/** The slot for a place in a list, if that list is drawn. */
export function slotFor(layout: SequenceLayout, operandId: string | null, index: number): SlotLayout | null {
  return layout.slots.find((slot) => slot.operandId === operandId && slot.index === index) ?? null;
}
