import type {
  BoundaryPreset,
  DatabaseKind,
  DraftNode,
  NoteKind,
  QueueKind,
  ServiceKind,
} from '../document/types';
import type { DisplayList, Shape, Stroke } from '../render/displayList';
import { tokenizeCode } from '../render/code/highlight';
import { CODE_THEMES } from '../render/code/theme';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { PRESET_AMPLITUDE } from '../render/roughness/presets';
import { roughEllipsePath, roughRectPath } from '../render/roughness/roughRect';
import { jitter } from '../render/roughness/seed';
import { accentOf, type Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import { getMeasurer, type TextMeasurer } from '../render/text/measure';
import type { PersonalityPreset } from '../ui/personality/usePersonality';

/**
 * Turns a node from the document model into a display list.
 *
 * Every function here is pure: same node and theme in, same shapes out. Nothing
 * reads the DOM, so node appearance is fully unit-testable and the exporter can
 * produce it without a browser.
 */

export interface DescribeContext {
  theme: Theme;
  measurer: TextMeasurer;
  /** Phase 5.2 — Intentional Roughness. Defaults to `'clean'`, today's exact
   *  appearance, so every existing call site that only passes a theme keeps
   *  compiling and keeps producing byte-identical output. */
  preset: PersonalityPreset;
}

export function describeContext(theme: Theme, preset: PersonalityPreset = 'clean'): DescribeContext {
  return { theme, measurer: getMeasurer(), preset };
}

const PADDING = 12;
const CODE_HEADER_HEIGHT = 26;
const CODE_PADDING_X = 12;
const CODE_PADDING_Y = 8;
const NOTE_BAR_WIDTH = 3;

/** Notes are colour-coded by intent — the whole point of having four kinds. Exported so an edge
 *  attachment (`EdgeAttachmentReveal` in `DraftEdgeView.tsx`) can match a note's own look exactly
 *  rather than duplicating this table. */
export const NOTE_ACCENTS: Record<NoteKind, 'amber' | 'blue' | 'rose' | 'green'> = {
  note: 'amber',
  question: 'blue',
  warning: 'rose',
  decision: 'green',
};

export const NOTE_LABELS: Record<NoteKind, string> = {
  note: 'NOTE',
  question: 'QUESTION',
  warning: 'WARNING',
  decision: 'DECISION',
};

/** The default preset renders no caption at all — a plain boundary needs no label. */
const BOUNDARY_PRESET_LABELS: Partial<Record<BoundaryPreset, string>> = {
  system: 'SYSTEM',
  domain: 'DOMAIN',
  network: 'NETWORK',
  deployment: 'DEPLOYMENT',
  group: 'GROUP',
};

/**
 * Sub-kind captions for Service/Database/Queue. Unlike a `NoteKind` (which
 * does change accent), these never touch `accentOf` — the base category
 * colour must keep dominating, so the variant only ever adds this small
 * corner caption, the same restrained treatment a boundary preset gets.
 * The default kind of Service and Database ("generic") renders no caption —
 * it means "unspecified," not a real subtype. Queue has no such placeholder:
 * `queue`/`topic`/`stream` are three equally specific kinds, so all three are
 * captioned.
 */
const SERVICE_KIND_LABELS: Partial<Record<ServiceKind, string>> = {
  api: 'API',
  worker: 'WORKER',
  external: 'EXTERNAL',
};
const DATABASE_KIND_LABELS: Partial<Record<DatabaseKind, string>> = {
  sql: 'SQL',
  nosql: 'NOSQL',
  cache: 'CACHE',
};
const QUEUE_KIND_LABELS: Record<QueueKind, string> = {
  queue: 'QUEUE',
  topic: 'TOPIC',
  stream: 'STREAM',
};

/** A small, muted corner tag — the one shared visual for every node variant. */
function variantCaption(node: DraftNode, ctx: DescribeContext, label: string, color: string): Shape[] {
  const layout = layoutText(label, {
    font: FONTS.variantTag,
    maxWidth: Math.max(16, node.width - 12),
    lineHeight: FONTS.variantTag.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer: ctx.measurer,
  });
  return [
    {
      t: 'text',
      x: node.width - 7,
      y: node.height - layout.height - 5,
      layout,
      font: FONTS.variantTag,
      fill: color,
      align: 'end',
    },
  ];
}

export function describeNode(node: DraftNode, ctx: DescribeContext): DisplayList {
  const shapes = shapesFor(node, ctx);
  return { width: node.width, height: node.height, shapes };
}

function shapesFor(node: DraftNode, ctx: DescribeContext): Shape[] {
  switch (node.type) {
    case 'code':
      return codeCard(node, ctx);
    case 'note':
      return note(node, ctx);
    case 'text':
      return freeText(node, ctx);
    case 'group':
      return group(node, ctx);
    case 'ellipse':
      return ellipse(node, ctx);
    case 'database':
      return database(node, ctx);
    case 'queue':
      return queue(node, ctx);
    case 'actor':
      return actor(node, ctx);
    case 'service':
      return service(node, ctx);
    case 'rounded':
      return box(node, ctx, 18);
    case 'card':
    default:
      return box(node, ctx, 8);
  }
}

/* ------------------------------------------------------------- primitives -- */

function centredLabel(
  node: DraftNode,
  ctx: DescribeContext,
  options: { top: number; bottom: number; color: string } = {
    top: 0,
    bottom: 0,
    color: '',
  },
): Shape[] {
  const text = node.text ?? '';
  if (!text.trim()) return [];

  const palette = accentOf(ctx.theme, node.accent);
  const maxWidth = Math.max(16, node.width - PADDING * 2);
  const available = node.height - options.top - options.bottom;
  const lineHeight = FONTS.nodeLabel.size * LINE_HEIGHTS.label;

  const layout = layoutText(text, {
    font: FONTS.nodeLabel,
    maxWidth,
    lineHeight,
    maxLines: Math.max(1, Math.floor(available / lineHeight)),
    measurer: ctx.measurer,
  });

  return [
    {
      t: 'text',
      x: node.width / 2,
      y: options.top + (available - layout.height) / 2,
      layout,
      font: FONTS.nodeLabel,
      fill: options.color || palette.text,
      align: 'middle',
    },
  ];
}

function surfaceStroke(ctx: DescribeContext, node: DraftNode): Stroke {
  return { color: accentOf(ctx.theme, node.accent).line, width: 1.5 };
}

/**
 * A rounded-rect outline that stays a plain `RectShape` at Clean (so Clean's
 * emitted SVG element type never changes) and switches to a jittered
 * `PathShape` only when Draft/Sketch's amplitude is above zero — see
 * `render/roughness/roughRect.ts`. Shared by every node whose outline is a
 * plain rounded rectangle: `box`, `note`, `group`, and `codeCard`.
 */
function outlineShape(
  seedId: string,
  ctx: DescribeContext,
  rect: { x: number; y: number; w: number; h: number; r: number },
  paint: { fill?: string; opacity?: number; stroke?: Stroke; shadow?: boolean },
): Shape {
  const amplitude = PRESET_AMPLITUDE[ctx.preset].outline;
  if (amplitude === 0) {
    return { t: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, r: rect.r, ...paint };
  }
  return {
    t: 'path',
    d: roughRectPath(rect.x, rect.y, rect.w, rect.h, rect.r, seedId, amplitude),
    ...paint,
  };
}

function box(node: DraftNode, ctx: DescribeContext, radius: number): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  return [
    outlineShape(
      node.id,
      ctx,
      { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: radius },
      { fill: palette.fill, stroke: surfaceStroke(ctx, node), shadow: true },
    ),
    ...centredLabel(node, ctx, { top: 0, bottom: 0, color: '' }),
  ];
}

function ellipse(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const cx = node.width / 2;
  const cy = node.height / 2;
  const rx = node.width / 2 - 0.75;
  const ry = node.height / 2 - 0.75;
  const amplitude = PRESET_AMPLITUDE[ctx.preset].outline;
  const paint = { fill: palette.fill, stroke: surfaceStroke(ctx, node), shadow: true };
  const outline: Shape =
    amplitude === 0
      ? { t: 'ellipse', cx, cy, rx, ry, ...paint }
      : { t: 'path', d: roughEllipsePath(cx, cy, rx, ry, node.id, amplitude), ...paint };
  return [
    outline,
    ...centredLabel(node, ctx, { top: 0, bottom: 0, color: '' }),
  ];
}

/* ----------------------------------------------------------- dev presets -- */

/**
 * The developer presets earn their keep through silhouette, not iconography:
 * a service has a coloured cap, a database is a (vertical) cylinder, a queue
 * is a horizontal one — a pipe messages travel through — and an actor has a
 * head and shoulders. Recognisable at a glance on a shared screen, and none
 * of them look like clip art.
 */
function service(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'teal');
  const capHeight = 4;
  const kindLabel = SERVICE_KIND_LABELS[node.serviceKind ?? 'generic'];
  return [
    outlineShape(
      node.id,
      ctx,
      { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 8 },
      { fill: palette.fill, stroke: { color: palette.line, width: 1.5 }, shadow: true },
    ),
    // The cap is clipped to the card's rounded top so it never overhangs —
    // the clip region itself always stays the exact rounded rect regardless
    // of preset (a `GroupShape` clip is analytic-only, never a jittered
    // path), so the cap's edge stays crisp even when the outline above wobbles.
    {
      t: 'group',
      clip: { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 8 },
      children: [
        {
          t: 'rect',
          x: 0.75,
          y: 0.75,
          w: node.width - 1.5,
          h: capHeight,
          fill: palette.chip,
        },
      ],
    },
    ...centredLabel(node, ctx, { top: capHeight, bottom: 0, color: palette.text }),
    ...(kindLabel ? variantCaption(node, ctx, kindLabel, ctx.theme.textMuted) : []),
  ];
}

function database(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'blue');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const ry = Math.min(12, h * 0.18);
  const x = 0.75;
  const y = 0.75;
  const amplitude = PRESET_AMPLITUDE[ctx.preset].outline;

  let body: string;
  let lid: string;
  if (amplitude === 0) {
    // Cylinder: an elliptical top, straight sides, an elliptical bottom.
    body = [
      `M${x},${y + ry}`,
      `a${w / 2},${ry} 0 0 1 ${w},0`,
      `l0,${h - ry * 2}`,
      `a${w / 2},${ry} 0 0 1 ${-w},0`,
      'Z',
    ].join(' ');
    lid = `M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0 a${w / 2},${ry} 0 0 0 ${-w},0`;
  } else {
    // Each defining point of the cylinder — top/bottom cap height, left/right
    // walls — jitters independently, so the cap height and overall width stay
    // close to their Clean values (still recognisably a cylinder) while the
    // drawn curve gets a hand-drawn wobble.
    const j = (i: number) => jitter(node.id, i, amplitude);
    const topRy = ry + j(0);
    const bottomRy = ry + j(1);
    const left = x + j(2);
    const right = x + w + j(3);
    const top = y + j(4);
    const bottom = y + h + j(5);
    const bodyW = right - left;
    body = [
      `M${left},${top + topRy}`,
      `A${bodyW / 2},${topRy} 0 0 1 ${right},${top + topRy}`,
      `L${right},${bottom - bottomRy}`,
      `A${bodyW / 2},${bottomRy} 0 0 1 ${left},${bottom - bottomRy}`,
      'Z',
    ].join(' ');
    lid =
      `M${left},${top + topRy} A${bodyW / 2},${topRy} 0 0 0 ${right},${top + topRy} ` +
      `A${bodyW / 2},${topRy} 0 0 0 ${left},${top + topRy}`;
  }
  const kindLabel = DATABASE_KIND_LABELS[node.databaseKind ?? 'generic'];

  return [
    { t: 'path', d: body, fill: palette.fill, stroke: { color: palette.line, width: 1.5 } },
    { t: 'path', d: lid, fill: 'none', stroke: { color: palette.line, width: 1.5 } },
    ...centredLabel(node, ctx, { top: ry * 2, bottom: ry, color: palette.text }),
    ...(kindLabel ? variantCaption(node, ctx, kindLabel, ctx.theme.textMuted) : []),
  ];
}

function queue(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'violet');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const x = 0.75;
  const y = 0.75;
  // The tube is a compact glyph, not the whole node — like an actor's head
  // and shoulders, it doesn't grow to fill the box. The name and its kind
  // subtext live below it, stacked, in the full-width space that leaves —
  // kept small enough that even a pre-existing (shorter) queue node has room
  // for both lines without them running into the tube.
  const tubeH = Math.min(32, h * 0.5);
  // Capped at half the tube's own height, not just a width fraction — a cap
  // wider than the tube is tall reads as a flattened oval bulging past the
  // pill's own ends rather than a rounded one, which is what a short queue
  // node (tubeH below the historical 32px cap) would otherwise get.
  const rx = Math.min(14, w * 0.12, tubeH / 2);
  const amplitude = PRESET_AMPLITUDE[ctx.preset].outline;

  // A horizontal cylinder — a pipe messages travel through — built the same
  // way `database()` builds its (vertical) one: elliptical caps joined by
  // straight edges, with one cap's seam drawn again on top as a "lid" so it
  // reads as an open tube rather than a solid capsule.
  let body: string;
  let lid: string;
  if (amplitude === 0) {
    body = [
      `M${x + rx},${y}`,
      `a${rx},${tubeH / 2} 0 0 0 0,${tubeH}`,
      `l${w - rx * 2},0`,
      `a${rx},${tubeH / 2} 0 0 0 0,${-tubeH}`,
      'Z',
    ].join(' ');
    lid = `M${x + w - rx},${y} a${rx},${tubeH / 2} 0 0 1 0,${tubeH} a${rx},${tubeH / 2} 0 0 1 0,${-tubeH}`;
  } else {
    // Each defining point of the tube — left/right cap radius, top/bottom
    // walls — jitters independently, same discipline as `database()`.
    const j = (i: number) => jitter(node.id, i, amplitude);
    const leftRx = rx + j(0);
    const rightRx = rx + j(1);
    const top = y + j(2);
    const bottom = y + tubeH + j(3);
    const halfH = (bottom - top) / 2;
    const leftCapX = x + leftRx;
    const rightCapX = x + w - rightRx;
    body = [
      `M${leftCapX},${top}`,
      `A${leftRx},${halfH} 0 0 0 ${leftCapX},${bottom}`,
      `L${rightCapX},${bottom}`,
      `A${rightRx},${halfH} 0 0 0 ${rightCapX},${top}`,
      'Z',
    ].join(' ');
    lid =
      `M${rightCapX},${top} A${rightRx},${halfH} 0 0 1 ${rightCapX},${bottom} ` +
      `A${rightRx},${halfH} 0 0 1 ${rightCapX},${top}`;
  }

  // A few envelope glyphs, centred in the tube — messages in transit. Kept to
  // a fixed count and size regardless of node size, like a real icon would be.
  const iconCount = 3;
  const iconW = 17;
  const iconH = 13;
  const iconGap = 6;
  const iconY = y + tubeH / 2 - iconH / 2;
  const iconsStartX = x + (w - (iconW * iconCount + iconGap * (iconCount - 1))) / 2;
  function envelope(ex: number): string {
    return [
      `M${ex},${iconY}`,
      `h${iconW}`,
      `v${iconH}`,
      `h${-iconW}`,
      'Z',
      `M${ex},${iconY}`,
      `L${ex + iconW / 2},${iconY + iconH * 0.6}`,
      `L${ex + iconW},${iconY}`,
    ].join(' ');
  }
  const icons = Array.from({ length: iconCount }, (_, i) =>
    envelope(iconsStartX + i * (iconW + iconGap)),
  ).join(' ');

  const shapes: Shape[] = [
    { t: 'path', d: body, fill: palette.fill, stroke: { color: palette.line, width: 1.5 } },
    { t: 'path', d: lid, fill: 'none', stroke: { color: palette.line, width: 1.5 } },
    { t: 'path', d: icons, fill: 'none', stroke: { color: palette.line, width: 1.2 } },
  ];

  // Below the tube: the name, with its kind as a small muted subtext line
  // underneath it — not a corner tag (this silhouette has no filled corner to
  // put one in) and not inline (a long name would crowd it). Same treatment
  // `variantCaption` gives every other variant, just stacked instead of
  // cornered.
  const kindLabel = QUEUE_KIND_LABELS[node.queueKind ?? 'queue'];
  const kindFont = FONTS.variantTag;
  const kindLineHeight = kindFont.size * LINE_HEIGHTS.label;
  const kindLayout = layoutText(kindLabel, {
    font: kindFont,
    maxWidth: Math.max(16, node.width - PADDING * 2),
    lineHeight: kindLineHeight,
    maxLines: 1,
    measurer: ctx.measurer,
  });

  // Anchored right under the tube (not centred in whatever height the node
  // happens to be) — the tube is a small fixed-size glyph, not something that
  // grows to fill a resized node, so the caption stays close to the shape it
  // labels instead of drifting toward the middle of a tall box.
  const top = tubeH + 4;
  const text = node.text ?? '';
  const nameGap = 2;

  if (text.trim()) {
    const nameLineHeight = FONTS.nodeLabel.size * LINE_HEIGHTS.label;
    const nameLayout = layoutText(text, {
      font: FONTS.nodeLabel,
      maxWidth: Math.max(16, node.width - PADDING * 2),
      lineHeight: nameLineHeight,
      maxLines: 1,
      measurer: ctx.measurer,
    });

    shapes.push(
      {
        t: 'text',
        x: node.width / 2,
        y: top,
        layout: nameLayout,
        font: FONTS.nodeLabel,
        fill: palette.text,
        align: 'middle',
      },
      {
        t: 'text',
        x: node.width / 2,
        y: top + nameLayout.height + nameGap,
        layout: kindLayout,
        font: kindFont,
        fill: ctx.theme.textMuted,
        align: 'middle',
      },
    );
  } else {
    // No name — a queue node can no longer be given one — so the kind is the
    // only label, sitting right under the tube.
    shapes.push({
      t: 'text',
      x: node.width / 2,
      y: top,
      layout: kindLayout,
      font: kindFont,
      fill: ctx.theme.textMuted,
      align: 'middle',
    });
  }

  return shapes;
}

function actor(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const headR = 9;
  const cx = node.width / 2;
  const headCy = 14;
  const shoulderY = headCy + headR + 4;
  const shoulderW = 26;
  const amplitude = PRESET_AMPLITUDE[ctx.preset].outline;
  const stroke: Stroke = { color: palette.line, width: 1.6 };

  let shoulders: string;
  if (amplitude === 0) {
    shoulders = [
      `M${cx - shoulderW / 2},${shoulderY + 10}`,
      `a${shoulderW / 2},12 0 0 1 ${shoulderW},0`,
    ].join(' ');
  } else {
    const j = (i: number) => jitter(node.id, i, amplitude);
    const left = { x: cx - shoulderW / 2 + j(0), y: shoulderY + 10 + j(1) };
    const right = { x: cx + shoulderW / 2 + j(2), y: shoulderY + 10 + j(3) };
    const ry = 12 + j(4);
    shoulders = `M${left.x},${left.y} A${(right.x - left.x) / 2},${ry} 0 0 1 ${right.x},${right.y}`;
  }

  const headOutline: Shape =
    amplitude === 0
      ? { t: 'ellipse', cx, cy: headCy, rx: headR, ry: headR, fill: 'none', stroke }
      : { t: 'path', d: roughEllipsePath(cx, headCy, headR, headR, `${node.id}:head`, amplitude), fill: 'none', stroke };

  const shapes: Shape[] = [
    headOutline,
    { t: 'path', d: shoulders, fill: 'none', stroke },
  ];

  const text = node.text ?? '';
  if (text.trim()) {
    const top = shoulderY + 16;
    const lineHeight = FONTS.nodeLabel.size * LINE_HEIGHTS.label;
    const layout = layoutText(text, {
      font: FONTS.nodeLabel,
      maxWidth: Math.max(16, node.width - 4),
      lineHeight,
      maxLines: Math.max(1, Math.floor((node.height - top) / lineHeight)),
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: cx,
      y: top,
      layout,
      font: FONTS.nodeLabel,
      fill: palette.text,
      align: 'middle',
    });
  }
  return shapes;
}

/* ----------------------------------------------------------------- notes -- */

function note(node: DraftNode, ctx: DescribeContext): Shape[] {
  const kind = node.noteKind ?? 'note';
  const palette = accentOf(ctx.theme, node.accent ?? NOTE_ACCENTS[kind]);
  const shapes: Shape[] = [
    outlineShape(
      node.id,
      ctx,
      { x: 0.5, y: 0.5, w: node.width - 1, h: node.height - 1, r: 6 },
      { fill: palette.fill, stroke: { color: palette.line, width: 1 }, shadow: true },
    ),
    // A colour bar rather than a sticky-note skeuomorph.
    {
      t: 'group',
      clip: { x: 0.5, y: 0.5, w: node.width - 1, h: node.height - 1, r: 6 },
      children: [
        { t: 'rect', x: 0.5, y: 0.5, w: NOTE_BAR_WIDTH, h: node.height - 1, fill: palette.chip },
      ],
    },
  ];

  const left = NOTE_BAR_WIDTH + 10;
  const tagLayout = layoutText(NOTE_LABELS[kind], {
    font: FONTS.presetTag,
    maxWidth: node.width,
    lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer: ctx.measurer,
  });
  shapes.push({
    t: 'text',
    x: left,
    y: 8,
    layout: tagLayout,
    font: FONTS.presetTag,
    fill: palette.chip,
    align: 'start',
  });

  const body = node.text ?? '';
  if (body.trim()) {
    const top = 8 + tagLayout.height + 5;
    const lineHeight = FONTS.noteBody.size * LINE_HEIGHTS.body;
    const layout = layoutText(body, {
      font: FONTS.noteBody,
      maxWidth: Math.max(16, node.width - left - 10),
      lineHeight,
      maxLines: Math.max(1, Math.floor((node.height - top - 6) / lineHeight)),
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: left,
      y: top,
      layout,
      font: FONTS.noteBody,
      fill: ctx.theme.text,
      align: 'start',
    });
  }
  return shapes;
}

function freeText(node: DraftNode, ctx: DescribeContext): Shape[] {
  const body = node.text ?? '';
  if (!body.trim()) return [];
  const palette = accentOf(ctx.theme, node.accent);
  const lineHeight = FONTS.freeText.size * LINE_HEIGHTS.body;
  const layout = layoutText(body, {
    font: FONTS.freeText,
    maxWidth: Math.max(16, node.width),
    lineHeight,
    maxLines: Math.max(1, Math.floor(node.height / lineHeight)),
    measurer: ctx.measurer,
  });
  return [
    {
      t: 'text',
      x: 0,
      y: 0,
      layout,
      font: FONTS.freeText,
      fill: node.accent && node.accent !== 'neutral' ? palette.chip : ctx.theme.text,
      align: 'start',
    },
  ];
}

function group(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const shapes: Shape[] = [
    outlineShape(
      node.id,
      ctx,
      { x: 1, y: 1, w: node.width - 2, h: node.height - 2, r: 12 },
      { fill: ctx.theme.surface, opacity: 0.35, stroke: { color: palette.line, width: 1.25, dash: [6, 5] } },
    ),
  ];

  // The preset is a small secondary caption, never folded into the node's
  // own `text` — a Domain boundary labelled "Payment Platform" must still
  // read "Payment Platform", not "Domain: Payment Platform".
  const presetLabel = BOUNDARY_PRESET_LABELS[node.boundaryPreset ?? 'boundary'];
  let titleTop = 9;
  if (presetLabel) {
    const captionLayout = layoutText(presetLabel, {
      font: FONTS.presetTag,
      maxWidth: Math.max(16, node.width - 24),
      lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: 12,
      y: 8,
      layout: captionLayout,
      font: FONTS.presetTag,
      fill: palette.line,
      align: 'start',
    });
    titleTop = 8 + captionLayout.height + 2;
  }

  const title = node.text ?? '';
  if (title.trim()) {
    const layout = layoutText(title, {
      font: FONTS.groupTitle,
      maxWidth: Math.max(16, node.width - 24),
      lineHeight: FONTS.groupTitle.size * LINE_HEIGHTS.label,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: 12,
      y: titleTop,
      layout,
      font: FONTS.groupTitle,
      fill: ctx.theme.textMuted,
      align: 'start',
    });
  }
  return shapes;
}

/* ------------------------------------------------------------ code cards -- */

export function codeMetrics(ctx: DescribeContext) {
  const lineHeight = FONTS.code.size * LINE_HEIGHTS.code;
  const { ascent, descent } = ctx.measurer.metrics(FONTS.code);
  return {
    lineHeight,
    ascent,
    descent,
    charWidth: ctx.measurer.charWidth(FONTS.code),
  };
}

function codeCard(node: DraftNode, ctx: DescribeContext): Shape[] {
  const language = node.language ?? 'plaintext';
  const lines = tokenizeCode(node.code ?? '', language);
  const metrics = codeMetrics(ctx);
  const theme = CODE_THEMES[ctx.theme.name];

  const bodyTop = CODE_HEADER_HEIGHT;
  const bodyHeight = Math.max(0, node.height - bodyTop - CODE_PADDING_Y);
  // Only the lines that fit are emitted; a 500-line paste does not become 500
  // unseen SVG elements in the export.
  const visibleLines = Math.max(0, Math.floor(bodyHeight / metrics.lineHeight));

  const shapes: Shape[] = [
    outlineShape(
      node.id,
      ctx,
      { x: 0.5, y: 0.5, w: node.width - 1, h: node.height - 1, r: 8 },
      { fill: ctx.theme.codeBg, stroke: { color: ctx.theme.codeBorder, width: 1 }, shadow: true },
    ),
    {
      t: 'group',
      clip: { x: 0.5, y: 0.5, w: node.width - 1, h: node.height - 1, r: 8 },
      children: [
        {
          t: 'rect',
          x: 0.5,
          y: 0.5,
          w: node.width - 1,
          h: CODE_HEADER_HEIGHT,
          fill: ctx.theme.surfaceRaised,
        },
        {
          t: 'rect',
          x: 0.5,
          y: CODE_HEADER_HEIGHT,
          w: node.width - 1,
          h: 1,
          fill: ctx.theme.codeBorder,
        },
      ],
    },
  ];

  const tagLayout = layoutText(LANGUAGE_LABELS[language], {
    font: FONTS.presetTag,
    maxWidth: node.width,
    lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer: ctx.measurer,
  });
  shapes.push({
    t: 'text',
    x: CODE_PADDING_X,
    y: (CODE_HEADER_HEIGHT - tagLayout.height) / 2,
    layout: tagLayout,
    font: FONTS.presetTag,
    fill: ctx.theme.textFaint,
    align: 'start',
  });

  if (visibleLines > 0 && lines.length > 0) {
    shapes.push({
      t: 'group',
      clip: {
        x: 1,
        y: bodyTop,
        w: node.width - 2,
        h: node.height - bodyTop - 1,
        r: 0,
      },
      children: [
        {
          t: 'code',
          x: CODE_PADDING_X,
          y: bodyTop + CODE_PADDING_Y,
          lines,
          font: FONTS.code,
          lineHeight: metrics.lineHeight,
          charWidth: metrics.charWidth,
          ascent: metrics.ascent,
          descent: metrics.descent,
          theme,
          firstLine: 0,
          lastLine: Math.min(lines.length - 1, visibleLines - 1),
        },
      ],
    });
  }

  return shapes;
}

/**
 * The height a code card needs to show all its content, used when a card is
 * created from a paste so the user does not have to resize it by hand.
 */
export function naturalCodeSize(
  code: string,
  ctx: DescribeContext,
): { width: number; height: number } {
  const metrics = codeMetrics(ctx);
  const lines = code.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: Math.min(680, Math.max(260, longest * metrics.charWidth + CODE_PADDING_X * 2 + 8)),
    height: Math.min(
      520,
      Math.max(
        110,
        CODE_HEADER_HEIGHT + CODE_PADDING_Y * 2 + Math.min(lines.length, 40) * metrics.lineHeight,
      ),
    ),
  };
}

export const CODE_LAYOUT = {
  headerHeight: CODE_HEADER_HEIGHT,
  paddingX: CODE_PADDING_X,
  paddingY: CODE_PADDING_Y,
} as const;
