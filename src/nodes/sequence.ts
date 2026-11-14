/**
 * What a sequence looks like: the display list for a `sequence` node, drawn from the geometry
 * `sequence/layout.ts` works out. The canvas and every export draw this same list.
 *
 * A participant's head is not drawn here. It is an ordinary Draft Canvas shape — a service box, a
 * data store's cylinder, a queue, a person — drawn by the same code that draws that shape on the
 * canvas, at a compact size, with its technology mark. That is what makes a sequence read as part
 * of the diagram beside it instead of as a picture from another tool.
 *
 * The lines follow UML, because that is what a reader of sequence diagrams already knows: a call is
 * a solid line with a filled head, an asynchronous message a solid line with an open one, a reply a
 * dashed line with an open one; a created participant's head sits on the message that creates it,
 * and a destroyed one's lifeline ends in a cross.
 */
import { minSizeFor } from '../document/factory';
import { sequenceOf } from '../document/sequenceModel';
import type { DraftNode, DraftSequence, SeqParticipant } from '../document/types';
import type { DisplayList, Shape, Stroke } from '../render/displayList';
import { connectorHead, connectorStrokePath } from '../render/connectorStyle';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { FONTS } from '../render/text/fonts';
import type { TextMeasurer } from '../render/text/measure';
import { accentOf, type Theme } from '../render/theme/tokens';
import { checkSequence } from '../sequence/check';
import { layoutSequence, type LabelLayout, type MessageLayout, type Rect, type SequenceLayout } from '../sequence/layout';
import type { DescribeContext } from './describe';
import { nodeTechnologyIcon, type TechnologyIconSnapshot } from './technology';

/**
 * What this module borrows from `describe.ts`, handed in rather than imported so the two do not
 * import each other: how a shape is drawn, how big it wants to be, and the one outline every
 * rounded shape goes through (which is what makes a frame hand-drawn at Draft and Sketch).
 */
export interface SequenceKit {
  describe: (node: DraftNode, ctx: DescribeContext) => DisplayList;
  naturalSize: (node: DraftNode, ctx: DescribeContext, bounds: { maxWidth: number; maxHeight: number; maxNameLines?: number }) => { width: number; height: number; fits: boolean };
  outline: (
    seedId: string,
    ctx: DescribeContext,
    rect: { x: number; y: number; w: number; h: number; r: number },
    paint: { fill?: string; opacity?: number; stroke?: Stroke },
  ) => Shape;
}

const FRAME_RADIUS = 10;
const FRAGMENT_RADIUS = 5;
const LINE_WIDTH = 1.6;
const HEAD_SCALE = 0.8;
const REPLY_DASH = [5, 4];
const LIFELINE_DASH = [4, 4];
const SEPARATOR_DASH = [5, 4];
const CROSS = 7;
/** How far a message to itself runs out before turning back. */
const SELF_LOOP = 26;
const HEAD_MAX_WIDTH = 196;
const HEAD_MAX_HEIGHT = 132;

/* --------------------------------------------------------------------- heads -- */

/** The shape a participant's head is: an architecture shape with the participant's identity. */
export function headNode(host: Pick<DraftNode, 'id'>, participant: SeqParticipant, size?: { width: number; height: number }): DraftNode {
  const floor = minSizeFor(participant.type);
  // A queue with a name needs the taller box that holds the name under its tube (`DEFAULTS.queueNamedHeight`).
  const height = participant.type === 'queue' && participant.name.trim() ? 72 : floor.height;
  const node: DraftNode = {
    id: `${host.id}:${participant.id}`,
    type: participant.type,
    x: 0,
    y: 0,
    width: size?.width ?? floor.width,
    height: size?.height ?? height,
    z: 0,
    text: participant.name,
    textOrigin: 'explicit',
  };
  if (participant.accent) node.accent = participant.accent;
  if (participant.serviceKind) node.serviceKind = participant.serviceKind;
  if (participant.databaseKind) node.databaseKind = participant.databaseKind;
  if (participant.queueKind) node.queueKind = participant.queueKind;
  if (participant.deliveryRole) node.deliveryRole = participant.deliveryRole;
  if (participant.actorKind) node.actorKind = participant.actorKind;
  if (participant.componentKind) node.componentKind = participant.componentKind;
  if (participant.technology) node.technology = participant.technology;
  if (participant.type === 'actor') node.actorFrame = 'borderless';
  return node;
}

interface SizedHead {
  icons: TechnologyIconSnapshot;
  measurer: TextMeasurer;
  size: { width: number; height: number };
}

/** How wide a participant with no name yet stands: the width of the field its name is typed in. */
export const UNNAMED_HEAD_WIDTH = 140;

/** A head's size asks the shape's own renderer, which is not cheap; a participant is immutable, so once is enough. */
const headSizes = new WeakMap<SeqParticipant, SizedHead>();

function headSize(participant: SeqParticipant, ctx: DescribeContext, kit: SequenceKit): { width: number; height: number } {
  const cached = headSizes.get(participant);
  if (cached && cached.icons === ctx.technologyIcons && cached.measurer === ctx.measurer) return cached.size;
  const base = headNode({ id: 'head' }, participant);
  // A name on one line if the head can be made wide enough for it; on two before it is cut short.
  const oneLine = kit.naturalSize(base, ctx, { maxWidth: HEAD_MAX_WIDTH, maxHeight: HEAD_MAX_HEIGHT, maxNameLines: 1 });
  const natural = oneLine.fits ? oneLine : kit.naturalSize(base, ctx, { maxWidth: HEAD_MAX_WIDTH, maxHeight: HEAD_MAX_HEIGHT, maxNameLines: 2 });
  // One still waiting for its name stands as wide as the field it is typed in, so the others have
  // already made room and the field covers nobody else's head.
  const width = participant.name.trim() ? natural.width : Math.max(natural.width, UNNAMED_HEAD_WIDTH);
  const size = { width: Math.ceil(width), height: Math.ceil(natural.height) };
  headSizes.set(participant, { icons: ctx.technologyIcons, measurer: ctx.measurer, size });
  return size;
}

/* -------------------------------------------------------------------- layout -- */

interface Laid {
  title: string;
  width: number;
  height: number;
  icons: TechnologyIconSnapshot;
  measurer: TextMeasurer;
  layout: SequenceLayout;
}

/** A sequence is immutable, so its layout is kept by identity — for the last few boxes it was asked at, since a resize asks at a new one every frame. */
const laid = new WeakMap<DraftSequence, Laid[]>();
const KEPT = 3;

/** The geometry of a sequence node at its current box. Shared by drawing, hit-testing and framing. */
export function sequenceLayoutOf(node: Pick<DraftNode, 'sequence' | 'text' | 'width' | 'height'>, ctx: DescribeContext, kit: SequenceKit): SequenceLayout {
  const sequence = sequenceOf(node);
  const title = node.text ?? '';
  const kept = laid.get(sequence) ?? [];
  const hit = kept.find(
    (entry) => entry.title === title && entry.width === node.width && entry.height === node.height && entry.icons === ctx.technologyIcons && entry.measurer === ctx.measurer,
  );
  if (hit) return hit.layout;
  const layout = layoutSequence({
    sequence,
    title,
    box: { width: node.width, height: node.height },
    measurer: ctx.measurer,
    headSize: (participant) => headSize(participant, ctx, kit),
    hasMark: (participant) => participant.type !== 'database' && Boolean(nodeTechnologyIcon(headNode({ id: 'head' }, participant), ctx.technologyIcons)),
  });
  laid.set(sequence, [{ title, width: node.width, height: node.height, icons: ctx.technologyIcons, measurer: ctx.measurer, layout }, ...kept].slice(0, KEPT));
  return layout;
}

/** The size a sequence needs, whatever box it is in now. */
export function naturalSequenceSize(node: Pick<DraftNode, 'sequence' | 'text'>, ctx: DescribeContext, kit: SequenceKit): { width: number; height: number } {
  return sequenceLayoutOf({ sequence: node.sequence, text: node.text, width: 0, height: 0 }, ctx, kit).natural;
}

/* ------------------------------------------------------------------- drawing -- */

const text = (label: LabelLayout, fill: string, extra: Partial<Extract<Shape, { t: 'text' }>> = {}): Shape => ({
  t: 'text',
  x: label.x,
  y: label.y,
  layout: label.layout,
  font: label.font,
  fill,
  align: label.align,
  ...extra,
});

/** An arrowhead with its tip at (`x`, `y`), pointing along `direction`: the connector's own nib, a little smaller. */
function arrowHead(x: number, y: number, direction: 1 | -1, open: boolean): string {
  const tokens = connectorHead(open).match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: string[] = [];
  let first = true;
  for (const token of tokens) {
    if (/[A-Za-z]/.test(token)) {
      out.push(token);
      first = true;
      continue;
    }
    const value = Number(token);
    const placed = first ? x + direction * (value - 14) * HEAD_SCALE : y + (value - 5) * HEAD_SCALE;
    out.push(String(Math.round(placed * 100) / 100));
    first = !first;
  }
  return out.join(' ');
}

function lineColor(theme: Theme, participant: SeqParticipant | undefined): string {
  const accent = participant?.accent ?? 'neutral';
  return accent === 'neutral' ? theme.edge : accentOf(theme, accent).line;
}

function messageShapes(message: MessageLayout, color: string, seed: string, ctx: DescribeContext): Shape[] {
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const open = message.kind === 'async' || message.kind === 'reply' || message.kind === 'create';
  const dashed = message.kind === 'reply' || message.kind === 'create';
  const stroke: Stroke = { color, width: LINE_WIDTH, linecap: 'round', ...(dashed ? { dash: REPLY_DASH } : {}) };
  const headStroke: Stroke = { color, width: LINE_WIDTH, linecap: 'round' };
  const shapes: Shape[] = [];

  if (message.self) {
    const far = Math.max(message.x1, message.x2) + SELF_LOOP;
    const r = 6;
    const d = `M ${message.x1} ${message.y} H ${far - r} Q ${far} ${message.y} ${far} ${message.y + r} V ${message.yEnd - r} Q ${far} ${message.yEnd} ${far - r} ${message.yEnd} H ${message.x2 + (open ? 0 : 6)}`;
    shapes.push({ t: 'path', d: connectorStrokePath(d, seed, profile, false), fill: 'none', stroke });
    shapes.push(
      open
        ? { t: 'path', d: arrowHead(message.x2, message.yEnd, -1, true), fill: 'none', stroke: headStroke }
        : { t: 'path', d: arrowHead(message.x2, message.yEnd, -1, false), fill: color },
    );
    return shapes;
  }

  const direction: 1 | -1 = message.x2 >= message.x1 ? 1 : -1;
  // A cross marks the end of a destroyed lifeline; the arrow stops short of it.
  const tip = message.kind === 'destroy' ? message.x2 - direction * (CROSS + 2) : message.x2;
  const lineEnd = open ? tip : tip - direction * 6;
  const d = `M ${message.x1} ${message.y} L ${lineEnd} ${message.y}`;
  shapes.push({ t: 'path', d: connectorStrokePath(d, seed, profile, false), fill: 'none', stroke });
  shapes.push(
    open
      ? { t: 'path', d: arrowHead(tip, message.y, direction, true), fill: 'none', stroke: headStroke }
      : { t: 'path', d: arrowHead(tip, message.y, direction, false), fill: color },
  );
  return shapes;
}

const crossAt = (x: number, y: number): string =>
  `M ${x - CROSS} ${y - CROSS} L ${x + CROSS} ${y + CROSS} M ${x + CROSS} ${y - CROSS} L ${x - CROSS} ${y + CROSS}`;

/** A fragment's tab: a label with its lower right corner cut, as UML draws it. */
const tabPath = (tab: Rect, radius: number): string => {
  const cut = 6;
  const right = tab.x + tab.w;
  const bottom = tab.y + tab.h;
  return `M ${tab.x} ${tab.y + radius} Q ${tab.x} ${tab.y} ${tab.x + radius} ${tab.y} H ${right} V ${bottom - cut} L ${right - cut} ${bottom} H ${tab.x} Z`;
};

function stripLabelRole(shapes: readonly Shape[]): Shape[] {
  return shapes.map((shape) => {
    if (shape.t === 'group') return { ...shape, children: stripLabelRole(shape.children) };
    if (shape.t !== 'text' || shape.role === undefined) return shape;
    // Only the sequence's own title is "the label" its inline editor looks for.
    const { role: _role, labelWidth: _width, ...rest } = shape;
    return rest;
  });
}

/** Just the frame: what a sequence is outlined by, and what presentation lights. */
export function sequenceFrame(node: DraftNode, ctx: DescribeContext, kit: SequenceKit, width = node.width, height = node.height): Shape[] {
  const tinted = node.accent && node.accent !== 'neutral';
  const palette = accentOf(ctx.theme, node.accent);
  const rect = { x: 1, y: 1, w: Math.max(2, width - 2), h: Math.max(2, height - 2), r: FRAME_RADIUS };
  return [
    kit.outline(node.id, ctx, rect, { fill: tinted ? palette.fill : ctx.theme.surface, opacity: tinted ? 0.4 : 0.32 }),
    kit.outline(node.id, ctx, rect, { fill: 'none', stroke: { color: tinted ? palette.line : ctx.theme.borderStrong, width: 1.25 } }),
  ];
}

export interface DescribeSequenceOptions {
  /** Draw only these messages and the heads at their ends: what presentation shows over a dimmed sequence. */
  only?: ReadonlySet<string>;
}

export function describeSequence(node: DraftNode, ctx: DescribeContext, kit: SequenceKit, options: DescribeSequenceOptions = {}): Shape[] {
  const sequence = sequenceOf(node);
  const layout = sequenceLayoutOf(node, ctx, kit);
  const { theme } = ctx;
  const byId = new Map(sequence.participants.map((participant) => [participant.id, participant]));
  const only = options.only;
  const shapes: Shape[] = [];

  if (!only) {
    shapes.push(...sequenceFrame(node, ctx, kit, layout.width, layout.height));
    if (layout.title) {
      shapes.push(text(layout.title, accentOf(theme, node.accent).text, { role: 'label', labelWidth: Math.max(80, layout.width - 40) }));
    }

    for (const group of layout.groups) {
      const palette = accentOf(theme, sequence.groups?.find((entry) => entry.id === group.id)?.accent);
      // A wash of the group's own line colour: enough to read as "these belong together", never a frame.
      shapes.push({ t: 'rect', x: group.box.x, y: group.box.y, w: group.box.w, h: group.box.h, r: 8, fill: palette.line, opacity: 0.08 });
      if (group.caption) shapes.push(text(group.caption, theme.textMuted));
    }

    // Outermost first, so a frame inside another is drawn over it.
    for (const frame of [...layout.fragments].sort((a, b) => a.depth - b.depth)) {
      const stroke: Stroke = { color: theme.borderStrong, width: 1.1 };
      shapes.push(kit.outline(`${node.id}:${frame.id}`, ctx, { ...frame.box, r: FRAGMENT_RADIUS }, { fill: theme.surface, opacity: 0.28 }));
      shapes.push(kit.outline(`${node.id}:${frame.id}`, ctx, { ...frame.box, r: FRAGMENT_RADIUS }, { fill: 'none', stroke }));
      for (const branch of frame.operands) {
        if (branch.separatorY === null) continue;
        shapes.push({
          t: 'path',
          d: `M ${frame.box.x} ${branch.separatorY} H ${frame.box.x + frame.box.w}`,
          fill: 'none',
          stroke: { ...stroke, dash: SEPARATOR_DASH },
        });
      }
    }

    for (const column of layout.columns) {
      shapes.push({
        t: 'path',
        d: `M ${column.x} ${column.lifeTop} V ${column.lifeBottom}`,
        fill: 'none',
        stroke: { color: theme.edge, width: 1.1, dash: LIFELINE_DASH },
        opacity: 0.85,
      });
    }

    for (const bar of layout.executions) {
      shapes.push({
        t: 'rect',
        x: bar.box.x,
        y: bar.box.y,
        w: bar.box.w,
        h: bar.box.h,
        r: 2,
        fill: theme.surfaceRaised,
        stroke: { color: accentOf(theme, byId.get(bar.participantId)?.accent).line, width: 1.25 },
      });
    }
  }

  // A frame's words go over the lifelines they cross, on a patch of canvas, so a condition is never
  // read through a dashed line.
  const patched = (label: LabelLayout, fill: string): Shape[] => {
    const left = label.align === 'middle' ? label.x - label.layout.width / 2 : label.x;
    const crossed = layout.columns.some(
      (column) => column.x > left - 2 && column.x < left + label.layout.width + 2 && column.lifeTop < label.y + label.layout.height && column.lifeBottom > label.y,
    );
    const words = text(label, fill);
    return crossed
      ? [{ t: 'rect', x: left - 3, y: label.y - 1, w: label.layout.width + 6, h: label.layout.height + 2, r: 3, fill: theme.canvas, opacity: 0.9 }, words]
      : [words];
  };
  if (!only) {
    for (const frame of layout.fragments) {
      shapes.push({ t: 'path', d: tabPath(frame.tab, FRAGMENT_RADIUS), fill: theme.surfaceRaised, stroke: { color: theme.borderStrong, width: 1.1 } });
      shapes.push(text(frame.tabText, theme.textMuted));
      for (const branch of frame.operands) if (branch.guard) shapes.push(...patched(branch.guard, theme.edgeText));
      if (frame.label) shapes.push(...patched(frame.label, theme.text));
    }
  }

  const findings = only ? [] : checkSequence(sequence);
  const flagged = new Set(findings.map((finding) => finding.itemIds[0]));
  const lit = new Set<string>();
  for (const message of layout.messages) {
    if (only && !only.has(message.id)) continue;
    lit.add(message.from);
    lit.add(message.to);
    const color = lineColor(theme, byId.get(message.from));
    shapes.push(...messageShapes(message, color, `${node.id}:${message.id}`, ctx));
    if (message.kind === 'destroy') {
      const x = layout.columns.find((column) => column.id === message.to)?.x ?? message.x2;
      shapes.push({ t: 'path', d: crossAt(x, message.yEnd), fill: 'none', stroke: { color, width: LINE_WIDTH + 0.4, linecap: 'round' } });
    }
    const label = message.label;
    if (label) shapes.push(...(only ? [text(label, theme.edgeText)] : patched(label, theme.edgeText)));
    if (flagged.has(message.id)) {
      const at = label ? { x: (label.align === 'middle' ? label.x - label.layout.width / 2 : label.x) - 13, y: label.y + 1 } : { x: Math.min(message.x1, message.x2) + 6, y: message.y - 14 };
      shapes.push({ t: 'path', d: `M ${at.x} ${at.y + 9} L ${at.x + 5} ${at.y} L ${at.x + 10} ${at.y + 9} Z`, fill: theme.accents.amber.line });
    }
  }

  if (!only) {
    for (const note of layout.notes) {
      const palette = theme.accents.amber;
      shapes.push({ t: 'rect', x: note.box.x, y: note.box.y, w: note.box.w, h: note.box.h, r: 4, fill: palette.fill, stroke: { color: palette.line, width: 1 } });
      shapes.push(text(note.text, palette.text));
    }
  }

  for (const column of layout.columns) {
    if (only && !lit.has(column.id)) continue;
    const participant = byId.get(column.id);
    if (!participant) continue;
    const head = kit.describe(headNode(node, participant, { width: column.head.w, height: column.head.h }), ctx);
    shapes.push({ t: 'group', translate: { x: column.head.x, y: column.head.y }, children: stripLabelRole(head.shapes) });
  }

  return shapes;
}

/** The text styles a sequence is set in, for an inline editor to match. */
export const SEQUENCE_FONTS = {
  message: FONTS.sequenceMessage,
  guard: FONTS.sequenceGuard,
  note: FONTS.sequenceNote,
  title: FONTS.groupTitle,
  participant: FONTS.nodeLabel,
} as const;
