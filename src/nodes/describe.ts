import type { DraftNode, NoteKind } from '../document/types';
import type { DisplayList, Shape, Stroke } from '../render/displayList';
import { tokenizeCode } from '../render/code/highlight';
import { CODE_THEMES } from '../render/code/theme';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { accentOf, type Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import { getMeasurer, type TextMeasurer } from '../render/text/measure';

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
}

export function describeContext(theme: Theme): DescribeContext {
  return { theme, measurer: getMeasurer() };
}

const PADDING = 12;
const CODE_HEADER_HEIGHT = 26;
const CODE_PADDING_X = 12;
const CODE_PADDING_Y = 8;
const NOTE_BAR_WIDTH = 3;

/** Notes are colour-coded by intent — the whole point of having four kinds. */
const NOTE_ACCENTS: Record<NoteKind, 'amber' | 'blue' | 'rose' | 'green'> = {
  note: 'amber',
  question: 'blue',
  warning: 'rose',
  decision: 'green',
};

const NOTE_LABELS: Record<NoteKind, string> = {
  note: 'NOTE',
  question: 'QUESTION',
  warning: 'WARNING',
  decision: 'DECISION',
};

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

function box(node: DraftNode, ctx: DescribeContext, radius: number): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  return [
    {
      t: 'rect',
      x: 0.75,
      y: 0.75,
      w: node.width - 1.5,
      h: node.height - 1.5,
      r: radius,
      fill: palette.fill,
      stroke: surfaceStroke(ctx, node),
      shadow: true,
    },
    ...centredLabel(node, ctx, { top: 0, bottom: 0, color: '' }),
  ];
}

function ellipse(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  return [
    {
      t: 'ellipse',
      cx: node.width / 2,
      cy: node.height / 2,
      rx: node.width / 2 - 0.75,
      ry: node.height / 2 - 0.75,
      fill: palette.fill,
      stroke: surfaceStroke(ctx, node),
      shadow: true,
    },
    ...centredLabel(node, ctx, { top: 0, bottom: 0, color: '' }),
  ];
}

/* ----------------------------------------------------------- dev presets -- */

/**
 * The developer presets earn their keep through silhouette, not iconography:
 * a service has a coloured cap, a database is a cylinder, a queue shows stacked
 * messages, an actor has a head and shoulders. Recognisable at a glance on a
 * shared screen, and none of them look like clip art.
 */
function service(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'teal');
  const capHeight = 4;
  return [
    {
      t: 'rect',
      x: 0.75,
      y: 0.75,
      w: node.width - 1.5,
      h: node.height - 1.5,
      r: 8,
      fill: palette.fill,
      stroke: { color: palette.line, width: 1.5 },
      shadow: true,
    },
    // The cap is clipped to the card's rounded top so it never overhangs.
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
  ];
}

function database(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'blue');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const ry = Math.min(12, h * 0.18);
  const x = 0.75;
  const y = 0.75;

  // Cylinder: an elliptical top, straight sides, an elliptical bottom.
  const body = [
    `M${x},${y + ry}`,
    `a${w / 2},${ry} 0 0 1 ${w},0`,
    `l0,${h - ry * 2}`,
    `a${w / 2},${ry} 0 0 1 ${-w},0`,
    'Z',
  ].join(' ');
  const lid = `M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0 a${w / 2},${ry} 0 0 0 ${-w},0`;

  return [
    { t: 'path', d: body, fill: palette.fill, stroke: { color: palette.line, width: 1.5 } },
    { t: 'path', d: lid, fill: 'none', stroke: { color: palette.line, width: 1.5 } },
    ...centredLabel(node, ctx, { top: ry * 2, bottom: ry, color: palette.text }),
  ];
}

function queue(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'violet');
  const slot = 7;
  const slots = 3;
  const gutter = slot * slots + 6;

  const shapes: Shape[] = [
    {
      t: 'rect',
      x: 0.75,
      y: 0.75,
      w: node.width - 1.5,
      h: node.height - 1.5,
      r: 6,
      fill: palette.fill,
      stroke: { color: palette.line, width: 1.5 },
      shadow: true,
    },
  ];

  // Stacked messages waiting at the head of the queue.
  for (let i = 0; i < slots; i += 1) {
    shapes.push({
      t: 'rect',
      x: 6 + i * slot,
      y: node.height / 2 - 9,
      w: slot - 2.5,
      h: 18,
      r: 1.5,
      fill: i === 0 ? palette.chip : 'none',
      stroke: { color: palette.line, width: 1.2 },
    });
  }

  const text = node.text ?? '';
  if (text.trim()) {
    const maxWidth = Math.max(16, node.width - gutter - PADDING);
    const lineHeight = FONTS.nodeLabel.size * LINE_HEIGHTS.label;
    const layout = layoutText(text, {
      font: FONTS.nodeLabel,
      maxWidth,
      lineHeight,
      maxLines: Math.max(1, Math.floor((node.height - 8) / lineHeight)),
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: gutter + (node.width - gutter - PADDING / 2) / 2,
      y: (node.height - layout.height) / 2,
      layout,
      font: FONTS.nodeLabel,
      fill: palette.text,
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

  const shoulders = [
    `M${cx - shoulderW / 2},${shoulderY + 10}`,
    `a${shoulderW / 2},12 0 0 1 ${shoulderW},0`,
  ].join(' ');

  const shapes: Shape[] = [
    {
      t: 'ellipse',
      cx,
      cy: headCy,
      rx: headR,
      ry: headR,
      fill: 'none',
      stroke: { color: palette.line, width: 1.6 },
    },
    { t: 'path', d: shoulders, fill: 'none', stroke: { color: palette.line, width: 1.6 } },
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
    {
      t: 'rect',
      x: 0.5,
      y: 0.5,
      w: node.width - 1,
      h: node.height - 1,
      r: 6,
      fill: palette.fill,
      stroke: { color: palette.line, width: 1 },
      shadow: true,
    },
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
    {
      t: 'rect',
      x: 1,
      y: 1,
      w: node.width - 2,
      h: node.height - 2,
      r: 12,
      fill: ctx.theme.surface,
      opacity: 0.35,
      stroke: { color: palette.line, width: 1.25, dash: [6, 5] },
    },
  ];

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
      y: 9,
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
    {
      t: 'rect',
      x: 0.5,
      y: 0.5,
      w: node.width - 1,
      h: node.height - 1,
      r: 8,
      fill: ctx.theme.codeBg,
      stroke: { color: ctx.theme.codeBorder, width: 1 },
      shadow: true,
    },
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
