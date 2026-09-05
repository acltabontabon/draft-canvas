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
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { bowControlPoint, roughEllipsePath, roughRectOvershootPath, roughRectPath } from '../render/roughness/roughRect';
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
    default:
      // Defensive fallback for a node type that somehow bypassed
      // `document/validate.ts` — every valid `DraftNodeType` is handled above.
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
 * `PathShape` the moment Draft/Sketch's `outline` or `bow` is above zero —
 * see `render/roughness/roughRect.ts`. Shared by every node whose outline is
 * a plain rounded rectangle: `box`, `note`, `group`, `codeCard`, `service`,
 * and actor's container/system-glyph/device-glyph.
 *
 * `boost` scales both axes together for a primitive that wants more presence
 * than an ordinary node at the same preset — only `group()`/Boundary uses it.
 */
function outlineShape(
  seedId: string,
  ctx: DescribeContext,
  rect: { x: number; y: number; w: number; h: number; r: number },
  paint: { fill?: string; opacity?: number; stroke?: Stroke; shadow?: boolean },
  boost = 1,
): Shape {
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const outlineAmp = profile.outline * boost;
  const bowAmp = profile.bow * boost;
  // A caller's fixed corner radius (8 for most shapes, 12 for a Boundary) is never checked
  // against the rect it's drawn in — at the schema's minimum node size, half the shorter side can
  // be smaller than that. Clamped once here, the one shared choke point every rounded-rect outline
  // goes through, rather than at each of `box`/`service`/`group`/etc.'s call sites. A no-op at any
  // normal node size, where `r` is already well under `w/2`/`h/2`.
  const r = Math.min(rect.r, rect.w / 2, rect.h / 2);
  if (outlineAmp === 0 && bowAmp === 0) {
    return { t: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, r, ...paint };
  }
  return {
    t: 'path',
    d: roughRectPath(rect.x, rect.y, rect.w, rect.h, r, seedId, outlineAmp, bowAmp),
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

/**
 * A Junction (the `ellipse` node type) is 24-64px — the flattest, smallest node in the app (see
 * `document/factory.ts`'s uniquely-clamped `maxSizeFor('ellipse')`) — so the profile's flat
 * `outline`/`bow` values would be disproportionate on the smallest ones. Both axes clamp to a
 * fraction of the node's own radius instead of using the profile value directly.
 */
function junctionAmplitude(profile: (typeof PERSONALITY_PROFILES)[PersonalityPreset], rx: number, ry: number) {
  const cap = Math.min(rx, ry) * 0.18;
  return { outline: Math.min(profile.outline, cap), bow: Math.min(profile.bow, cap) };
}

function ellipse(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const cx = node.width / 2;
  const cy = node.height / 2;
  const rx = node.width / 2 - 0.75;
  const ry = node.height / 2 - 0.75;
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const amp = junctionAmplitude(profile, rx, ry);
  const paint = { fill: palette.fill, stroke: surfaceStroke(ctx, node), shadow: true };
  const outline: Shape =
    amp.outline === 0 && amp.bow === 0
      ? { t: 'ellipse', cx, cy, rx, ry, ...paint }
      : { t: 'path', d: roughEllipsePath(cx, cy, rx, ry, node.id, amp.outline, amp.bow), ...paint };
  const shapes: Shape[] = [outline];
  // The "obvious hand-drawn circle" — a second, independently-seeded rim pass, Sketch only.
  if (profile.retrace) {
    shapes.push({
      t: 'path',
      d: roughEllipsePath(cx, cy, rx, ry, `${node.id}:retrace`, amp.outline, amp.bow),
      fill: 'none',
      stroke: { ...surfaceStroke(ctx, node), width: 1 },
      opacity: 0.55,
    });
  }
  return [
    ...shapes,
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

/**
 * The (vertical) cylinder's body + lid paths, factored out so `database()` can call it twice at
 * Sketch — once for the real outline, once (independently seeded) for its `retrace` pass —
 * without duplicating the cylinder math itself.
 */
function cylinderPaths(
  x: number,
  y: number,
  w: number,
  h: number,
  ry: number,
  seedId: string,
  outlineAmp: number,
  bowAmp: number,
): { body: string; lid: string } {
  if (outlineAmp === 0 && bowAmp === 0) {
    // Cylinder: an elliptical top, straight sides, an elliptical bottom.
    const body = [
      `M${x},${y + ry}`,
      `a${w / 2},${ry} 0 0 1 ${w},0`,
      `l0,${h - ry * 2}`,
      `a${w / 2},${ry} 0 0 1 ${-w},0`,
      'Z',
    ].join(' ');
    const lid = `M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0 a${w / 2},${ry} 0 0 0 ${-w},0`;
    return { body, lid };
  }
  // Each defining point of the cylinder — top/bottom cap height, left/right
  // walls — jitters independently, so the cap height and overall width stay
  // close to their Clean values (still recognisably a cylinder) while the
  // drawn curve gets a hand-drawn wobble.
  const j = (i: number) => jitter(seedId, i, outlineAmp);
  const topRy = ry + j(0);
  const bottomRy = ry + j(1);
  const left = x + j(2);
  const right = x + w + j(3);
  const top = y + j(4);
  const bottom = y + h + j(5);
  const bodyW = right - left;
  // The two straight side walls, each independently bowed (Draft/Sketch) rather than laser-
  // straight — one drawn explicitly (`L`/`Q`), the other closed by `Z` at amplitude 0 becomes an
  // explicit segment too the moment it needs to bow, since a `Z`-closing segment can't curve.
  const wall = (a: { x: number; y: number }, b: { x: number; y: number }, index: number) => {
    if (bowAmp === 0) return `L${b.x},${b.y}`;
    const c = bowControlPoint(a, b, seedId, index, bowAmp);
    return `Q${c.x},${c.y} ${b.x},${b.y}`;
  };
  const rightTop = { x: right, y: top + topRy };
  const rightBottom = { x: right, y: bottom - bottomRy };
  const leftBottom = { x: left, y: bottom - bottomRy };
  const leftTop = { x: left, y: top + topRy };
  const body = [
    `M${leftTop.x},${leftTop.y}`,
    `A${bodyW / 2},${topRy} 0 0 1 ${rightTop.x},${rightTop.y}`,
    wall(rightTop, rightBottom, 10),
    `A${bodyW / 2},${bottomRy} 0 0 1 ${leftBottom.x},${leftBottom.y}`,
    wall(leftBottom, leftTop, 12),
    'Z',
  ].join(' ');
  const lid =
    `M${left},${top + topRy} A${bodyW / 2},${topRy} 0 0 0 ${right},${top + topRy} ` +
    `A${bodyW / 2},${topRy} 0 0 0 ${left},${top + topRy}`;
  return { body, lid };
}

function database(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'blue');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  // Shallower than a "stretched database icon" cap — flatter top/bottom curves leave more of
  // the box as usable body for the two-line label underneath.
  const ry = Math.min(10, h * 0.16);
  const x = 0.75;
  const y = 0.75;
  const profile = PERSONALITY_PROFILES[ctx.preset];

  const { body, lid } = cylinderPaths(x, y, w, h, ry, node.id, profile.outline, profile.bow);
  const kindLabel = DATABASE_KIND_LABELS[node.databaseKind ?? 'generic'];
  const innerTop = ry * 2;
  const innerBottom = ry;

  const shapes: Shape[] = [
    { t: 'path', d: body, fill: palette.fill, stroke: { color: palette.line, width: 1.5 } },
    { t: 'path', d: lid, fill: 'none', stroke: { color: palette.line, width: 1.5 } },
  ];

  // The "special opportunity" primitive — a second, independently-seeded pass over the same
  // cylinder, Sketch only, reusing the same body/lid coordinates the primary already stayed
  // aligned on (see the module doc comment on `cylinderPaths`).
  if (profile.retrace) {
    const retrace = cylinderPaths(x, y, w, h, ry, `${node.id}:retrace`, profile.outline, profile.bow);
    shapes.push(
      { t: 'path', d: retrace.body, fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.5 },
      { t: 'path', d: retrace.lid, fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.5 },
    );
  }

  // A named kind (SQL/NoSQL/Cache) reads as a quiet second line directly under the primary
  // label — not a corner badge like Service's, which has a real corner to badge; a cylinder
  // doesn't. The pair is centred as one block in the cylinder's inner window so it stays
  // balanced regardless of node height. The default ("generic") kind keeps the single-line
  // `centredLabel` path exactly as before — untouched, since there's nothing to stack.
  if (kindLabel) {
    const text = node.text ?? '';
    if (text.trim()) {
      const nameLineHeight = FONTS.nodeLabel.size * LINE_HEIGHTS.label;
      const nameLayout = layoutText(text, {
        font: FONTS.nodeLabel,
        maxWidth: Math.max(16, node.width - PADDING * 2),
        lineHeight: nameLineHeight,
        maxLines: 1,
        measurer: ctx.measurer,
      });
      const kindFont = FONTS.variantTag;
      const kindLineHeight = kindFont.size * LINE_HEIGHTS.label;
      const kindLayout = layoutText(kindLabel, {
        font: kindFont,
        maxWidth: Math.max(16, node.width - PADDING * 2),
        lineHeight: kindLineHeight,
        maxLines: 1,
        measurer: ctx.measurer,
      });
      const nameGap = 2;
      const available = node.height - innerTop - innerBottom;
      const groupHeight = nameLayout.height + nameGap + kindLayout.height;
      const groupTop = innerTop + (available - groupHeight) / 2;
      shapes.push(
        {
          t: 'text',
          x: node.width / 2,
          y: groupTop,
          layout: nameLayout,
          font: FONTS.nodeLabel,
          fill: palette.text,
          align: 'middle',
        },
        {
          t: 'text',
          x: node.width / 2,
          y: groupTop + nameLayout.height + nameGap,
          layout: kindLayout,
          font: kindFont,
          fill: ctx.theme.textMuted,
          align: 'middle',
        },
      );
    }
  } else {
    shapes.push(...centredLabel(node, ctx, { top: innerTop, bottom: innerBottom, color: palette.text }));
  }

  return shapes;
}

/**
 * The (horizontal) tube's body + lid paths — the `queue()` analogue of `database()`'s
 * `cylinderPaths`, factored out for the same reason: calling it twice, independently seeded, is
 * what `retrace` needs at Sketch.
 */
function tubePaths(
  x: number,
  y: number,
  w: number,
  tubeH: number,
  rx: number,
  seedId: string,
  outlineAmp: number,
  bowAmp: number,
): { body: string; lid: string } {
  if (outlineAmp === 0 && bowAmp === 0) {
    const body = [
      `M${x + rx},${y}`,
      `a${rx},${tubeH / 2} 0 0 0 0,${tubeH}`,
      `l${w - rx * 2},0`,
      `a${rx},${tubeH / 2} 0 0 0 0,${-tubeH}`,
      'Z',
    ].join(' ');
    const lid = `M${x + w - rx},${y} a${rx},${tubeH / 2} 0 0 1 0,${tubeH} a${rx},${tubeH / 2} 0 0 1 0,${-tubeH}`;
    return { body, lid };
  }
  // Each defining point of the tube — left/right cap radius, top/bottom
  // walls — jitters independently, same discipline as `database()`.
  const j = (i: number) => jitter(seedId, i, outlineAmp);
  const leftRx = rx + j(0);
  const rightRx = rx + j(1);
  const top = y + j(2);
  const bottom = y + tubeH + j(3);
  const halfH = (bottom - top) / 2;
  const leftCapX = x + leftRx;
  const rightCapX = x + w - rightRx;
  // The tube's two straight top/bottom walls, each independently bowed at Draft/Sketch — same
  // "make the Z-closing segment explicit so it can curve too" treatment as `cylinderPaths`.
  const wall = (a: { x: number; y: number }, b: { x: number; y: number }, index: number) => {
    if (bowAmp === 0) return `L${b.x},${b.y}`;
    const c = bowControlPoint(a, b, seedId, index, bowAmp);
    return `Q${c.x},${c.y} ${b.x},${b.y}`;
  };
  const leftTop = { x: leftCapX, y: top };
  const leftBottom = { x: leftCapX, y: bottom };
  const rightBottom = { x: rightCapX, y: bottom };
  const rightTop = { x: rightCapX, y: top };
  const body = [
    `M${leftTop.x},${leftTop.y}`,
    `A${leftRx},${halfH} 0 0 0 ${leftBottom.x},${leftBottom.y}`,
    wall(leftBottom, rightBottom, 10),
    `A${rightRx},${halfH} 0 0 0 ${rightTop.x},${rightTop.y}`,
    wall(rightTop, leftTop, 12),
    'Z',
  ].join(' ');
  const lid =
    `M${rightCapX},${top} A${rightRx},${halfH} 0 0 1 ${rightCapX},${bottom} ` +
    `A${rightRx},${halfH} 0 0 1 ${rightCapX},${top}`;
  return { body, lid };
}

/**
 * Where a Queue/Topic/Stream node's tube glyph sits, vertically, as a fraction (0..1) of the
 * node's own full height — mirrors `queue()`'s own `y`/`tubeH` geometry exactly. The tube is a
 * compact glyph anchored near the top of the box (the kind caption sits in the remaining space
 * below it, see `queue()`), so its own visual centre sits well above the box's vertical midpoint —
 * a connector anchored at the default `offset: 0.5` lands at the boundary between the tube and its
 * caption, not the tube's centre. Exported so a connector that's generated programmatically for a
 * queue-family node (rather than picked up by the live nearest-side fallback) can set an explicit
 * `EdgeAnchor.offset` that actually lands on the glyph — see `store/editorStore.ts`'s
 * `addDeadLetterQueue`/`addConsumer`.
 */
export function queueTubeCenterFraction(height: number): number {
  const h = height - 1.5;
  const tubeH = Math.min(32, h * 0.5);
  const top = 0.75;
  return (top + tubeH / 2) / height;
}

/** Same dash array `group()`'s boundary outline already uses — "dashed = subordinate" is an
 *  established visual meaning in this app, not a new one invented for the DLQ treatment. */
const DLQ_DASH = [6, 5];
/** Reduced visual weight for a generated DLQ's tube/icon shapes — never applied to its caption
 *  text, which must stay fully legible at small zoom and in exports. */
const DLQ_OPACITY = 0.75;

function queue(node: DraftNode, ctx: DescribeContext): Shape[] {
  const isDlq = node.deliveryRole === 'dead-letter';
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
  const profile = PERSONALITY_PROFILES[ctx.preset];

  // A horizontal cylinder — a pipe messages travel through — built the same
  // way `database()` builds its (vertical) one: elliptical caps joined by
  // straight edges, with one cap's seam drawn again on top as a "lid" so it
  // reads as an open tube rather than a solid capsule.
  const { body, lid } = tubePaths(x, y, w, tubeH, rx, node.id, profile.outline, profile.bow);

  // The message-icon cluster inside the tube is the one thing that differs between Queue,
  // Topic, and Stream — same tube, same lid, same stroke weight, so the three stay clearly one
  // Messaging family while still being distinguishable at a glance without reading the caption.
  function envelope(ex: number, ey: number, iw: number, ih: number): string {
    return [
      `M${ex},${ey}`,
      `h${iw}`,
      `v${ih}`,
      `h${-iw}`,
      'Z',
      `M${ex},${ey}`,
      `L${ex + iw / 2},${ey + ih * 0.6}`,
      `L${ex + iw},${ey}`,
    ].join(' ');
  }

  // Queue: a small number of envelopes in a row — messages waiting their turn, in order.
  function queueIcons(): string {
    const iconCount = 3;
    const iconW = 17;
    const iconH = 13;
    const iconGap = 6;
    const iconY = y + tubeH / 2 - iconH / 2;
    const startX = x + (w - (iconW * iconCount + iconGap * (iconCount - 1))) / 2;
    return Array.from({ length: iconCount }, (_, i) =>
      envelope(startX + i * (iconW + iconGap), iconY, iconW, iconH),
    ).join(' ');
  }

  // Topic: one source message with a small broadcast cue beside it (two nested, right-opening
  // arcs — a signal glyph, not an arrow) — fan-out to many subscribers, not a line of things
  // waiting.
  function topicIcons(): string {
    const iconW = 17;
    const iconH = 13;
    const iconY = y + tubeH / 2 - iconH / 2;
    const arcGap = 8;
    const outerArcR = 7;
    const groupWidth = iconW + arcGap + outerArcR;
    const startX = x + (w - groupWidth) / 2;
    const arcCx = startX + iconW + arcGap;
    const arcCy = y + tubeH / 2;
    const fanArc = (r: number) => `M${arcCx},${arcCy - r} A${r},${r} 0 0 1 ${arcCx},${arcCy + r}`;
    return [envelope(startX, iconY, iconW, iconH), fanArc(4), fanArc(outerArcR)].join(' ');
  }

  // Stream: small plain segments (no envelope fold — reads as data, not mail), gently staggered
  // to suggest continuous motion rather than a neat, stationary row.
  function streamIcons(): string {
    const segCount = 3;
    const segW = 14;
    const segH = 10;
    const segGap = 7;
    const stagger = 3;
    const offsets = [-stagger, stagger, -stagger];
    const baseY = y + tubeH / 2 - segH / 2;
    const startX = x + (w - (segW * segCount + segGap * (segCount - 1))) / 2;
    return Array.from(
      { length: segCount },
      (_, i) => `M${startX + i * (segW + segGap)},${baseY + offsets[i]!} h${segW} v${segH} h${-segW} Z`,
    ).join(' ');
  }

  // DLQ: a single, lonely envelope — "one message that didn't make it through," not a queue of
  // things waiting their turn — centred exactly where the other kinds' icon clusters sit.
  function dlqIcon(): string {
    const iconW = 17;
    const iconH = 13;
    return envelope(x + (w - iconW) / 2, y + tubeH / 2 - iconH / 2, iconW, iconH);
  }

  const icons = isDlq
    ? dlqIcon()
    : node.queueKind === 'topic'
      ? topicIcons()
      : node.queueKind === 'stream'
        ? streamIcons()
        : queueIcons();

  const dlqStroke = isDlq ? { dash: DLQ_DASH } : undefined;
  const dlqOpacity = isDlq ? DLQ_OPACITY : undefined;
  const shapes: Shape[] = [
    { t: 'path', d: body, fill: palette.fill, stroke: { color: palette.line, width: 1.5, ...dlqStroke }, opacity: dlqOpacity },
    { t: 'path', d: lid, fill: 'none', stroke: { color: palette.line, width: 1.5, ...dlqStroke }, opacity: dlqOpacity },
    { t: 'path', d: icons, fill: 'none', stroke: { color: palette.line, width: 1.2 }, opacity: dlqOpacity },
  ];

  // Same "special opportunity" retrace pass as `database()` — Sketch only, independently
  // seeded. The icon glyphs above never retrace; they're small, identifying, and text-adjacent.
  if (profile.retrace) {
    const retrace = tubePaths(x, y, w, tubeH, rx, `${node.id}:retrace`, profile.outline, profile.bow);
    shapes.push(
      { t: 'path', d: retrace.body, fill: 'none', stroke: { color: palette.line, width: 1, ...dlqStroke }, opacity: 0.5 },
      { t: 'path', d: retrace.lid, fill: 'none', stroke: { color: palette.line, width: 1, ...dlqStroke }, opacity: 0.5 },
    );
  }

  // Below the tube: the name, with its kind as a small muted subtext line
  // underneath it — not a corner tag (this silhouette has no filled corner to
  // put one in) and not inline (a long name would crowd it). Same treatment
  // `variantCaption` gives every other variant, just stacked instead of
  // cornered.
  // Overrides regardless of `queueKind` — even a manually-retargeted DLQ (a rare, accepted edge
  // case: changing a generated DLQ's queue-kind dropdown doesn't clear `deliveryRole`) still reads
  // as "DLQ" rather than reverting to a generic kind caption.
  const kindLabel = isDlq ? 'DLQ' : QUEUE_KIND_LABELS[node.queueKind ?? 'queue'];
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
  // labels instead of drifting toward the middle of a tall box. Deliberately
  // tight (not a generic paragraph gap) so the icon and its caption read as
  // one element, not an icon plus a detached line of text underneath it.
  const top = tubeH + 2;
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

/**
 * Every Actor glyph shares this vertical envelope — starting `GLYPH_TOP` down from the container
 * edge and filling the same `GLYPH_SLOT` of height, regardless of kind — so the label never shifts
 * position when the user switches Human/System/Device, and each glyph reads as filling roughly the
 * same share of the container rather than floating as a small icon in a mostly-empty card.
 */
const GLYPH_TOP = 13;
const GLYPH_SLOT = 41;
const GLYPH_BOTTOM = GLYPH_TOP + GLYPH_SLOT;
/** Tight on purpose — the glyph and the participant's name need to read as one unit, not two
 *  separate things with a gap between them. */
const GLYPH_LABEL_GAP = 6;

/**
 * Human: a simplified bust silhouette — a large head sitting just above a broad, closed
 * shoulder/torso shape, tinted with a very light wash of the line colour so the body reads as a
 * silhouette's mass rather than a thin wireframe arc. No facial features, no hair, no filled
 * avatar circle: it needs to read as "a person," not "a profile picture."
 */
function humanGlyph(
  node: DraftNode,
  cx: number,
  stroke: Stroke,
  ctx: DescribeContext,
): { shapes: Shape[]; glyphBottom: number } {
  const headR = 13;
  const headCy = GLYPH_TOP + headR;
  const torsoRx = 30;
  // A modest rounded cap, not a shallow dome spanning the full width — most of the torso's
  // height is straight-sided "shoulders," with just a soft curve at the very top, so it reads as
  // a broad body rather than a flattened crescent.
  const capRy = 8;
  // The rounded cap's peak sits a few pixels inside the head's own bottom edge — the two
  // silhouettes overlap slightly, like a real neck, instead of floating apart with a gap.
  const peakY = headCy + headR - 3;
  const shoulderTopY = peakY + capRy;
  const left = cx - torsoRx;
  const right = cx + torsoRx;
  const bottom = GLYPH_BOTTOM;
  // A wash this light gives the body presence as a mass without competing with the container's
  // own (unfilled) card — still clearly lighter than a filled architecture shape.
  const bodyFill = 0.12;
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const outlineAmp = profile.outline;
  const bowAmp = profile.bow;

  let torso: string;
  if (outlineAmp === 0 && bowAmp === 0) {
    torso = [
      `M${left},${bottom}`,
      `L${left},${shoulderTopY}`,
      `A${torsoRx},${capRy} 0 0 1 ${right},${shoulderTopY}`,
      `L${right},${bottom}`,
      'Z',
    ].join(' ');
  } else {
    const j = (i: number) => jitter(node.id, i, outlineAmp);
    const lb = { x: left + j(0), y: bottom + j(1) };
    const lt = { x: left + j(2), y: shoulderTopY + j(3) };
    const rt = { x: right + j(4), y: shoulderTopY + j(5) };
    const rb = { x: right + j(6), y: bottom + j(7) };
    const ry = capRy + j(8);
    // The torso's two side walls bow independently at Draft/Sketch — the bottom edge (the Z
    // close) stays straight, right where the participant's name begins just below it.
    const wall = (a: { x: number; y: number }, b: { x: number; y: number }, index: number) => {
      if (bowAmp === 0) return `L${b.x},${b.y}`;
      const c = bowControlPoint(a, b, node.id, index, bowAmp);
      return `Q${c.x},${c.y} ${b.x},${b.y}`;
    };
    torso = [
      `M${lb.x},${lb.y}`,
      wall(lb, lt, 20),
      `A${(rt.x - lt.x) / 2},${ry} 0 0 1 ${rt.x},${rt.y}`,
      wall(rt, rb, 22),
      'Z',
    ].join(' ');
  }

  const headOutline: Shape =
    outlineAmp === 0 && bowAmp === 0
      ? { t: 'ellipse', cx, cy: headCy, rx: headR, ry: headR, fill: 'none', stroke }
      : {
          t: 'path',
          d: roughEllipsePath(cx, headCy, headR, headR, `${node.id}:head`, outlineAmp, bowAmp),
          fill: 'none',
          stroke,
        };

  const shapes: Shape[] = [
    // The wash and its outline are two separate shapes sharing the same `d` — `opacity` dims a
    // shape's stroke along with its fill, and the outline needs to stay at full strength (the
    // same family stroke every other Actor line uses) while only the fill underneath is faint.
    // Torso first (behind), head last (in front) — the head reads as a clean, whole circle
    // sitting on top of the body, not overlapped by its fill.
    { t: 'path', d: torso, fill: stroke.color, opacity: bodyFill },
    { t: 'path', d: torso, fill: 'none', stroke },
    headOutline,
  ];
  // "Irregular actor shapes" — a retraced head is a distinctly hand-drawn tell that doesn't
  // touch the filled torso wash, Sketch only.
  if (profile.retrace) {
    shapes.push({
      t: 'path',
      d: roughEllipsePath(cx, headCy, headR, headR, `${node.id}:head-retrace`, outlineAmp, bowAmp),
      fill: 'none',
      stroke: { ...stroke, width: 1 },
      opacity: 0.55,
    });
  }

  return { shapes, glyphBottom: bottom };
}

/**
 * System: an external-system/window glyph — a plain outline frame with a title-bar line and one
 * quieter content line beneath it, just enough internal structure to read as an application
 * window rather than a blank box. Deliberately not Service's shape (a full accent-filled card):
 * the point is that this is something *outside* the architecture being modelled, not a component
 * of it. Technology-neutral on purpose — no vendor chrome.
 */
function systemGlyph(
  node: DraftNode,
  cx: number,
  stroke: Stroke,
  ctx: DescribeContext,
): { shapes: Shape[]; glyphBottom: number } {
  const rectW = 58;
  const rectH = GLYPH_SLOT;
  const rectX = cx - rectW / 2;
  const rectY = GLYPH_TOP;
  const headerY = rectY + 10;
  const contentW = rectW * 0.6;
  const contentX = cx - contentW / 2;
  const contentY = headerY + 12;
  // These are 1px reference lines, not the silhouette — a small bow only, restrained relative to
  // the container's own, and never jittered at their endpoints (they stay flush with the frame).
  const hairlineBow = PERSONALITY_PROFILES[ctx.preset].bow * 0.5;
  const hairline = (seedSuffix: string, y: number, x0: number, w: number) => {
    if (hairlineBow === 0) return `M${x0},${y} h${w}`;
    const c = bowControlPoint({ x: x0, y }, { x: x0 + w, y }, `${node.id}:${seedSuffix}`, 0, hairlineBow);
    return `M${x0},${y} Q${c.x},${c.y} ${x0 + w},${y}`;
  };

  return {
    shapes: [
      outlineShape(`${node.id}:actor-glyph`, ctx, { x: rectX, y: rectY, w: rectW, h: rectH, r: 4 }, { fill: 'none', stroke }),
      { t: 'path', d: hairline('header-line', headerY, rectX, rectW), fill: 'none', stroke },
      { t: 'path', d: hairline('content-line', contentY, contentX, contentW), fill: 'none', stroke },
    ],
    glyphBottom: rectY + rectH,
  };
}

/**
 * Device: a vertically-proportioned device silhouette with a subtle inset screen area —
 * generic enough to read as a phone, terminal, ATM, or IoT client. No buttons, no screen
 * content, no decorative detail beyond that one inset — the silhouette alone is the point.
 */
function deviceGlyph(
  node: DraftNode,
  cx: number,
  stroke: Stroke,
  ctx: DescribeContext,
): { shapes: Shape[]; glyphBottom: number } {
  const rectW = 26;
  const rectH = GLYPH_SLOT;
  const rectX = cx - rectW / 2;
  const rectY = GLYPH_TOP;
  const screenInset = 4;
  const screenX = rectX + screenInset;
  const screenY = rectY + 5;
  const screenW = rectW - screenInset * 2;
  const screenH = rectH - 14;

  return {
    shapes: [
      outlineShape(`${node.id}:actor-glyph`, ctx, { x: rectX, y: rectY, w: rectW, h: rectH, r: 5 }, { fill: 'none', stroke }),
      // A small internal detail — restrained relative to the outer silhouette so it doesn't
      // out-express it, at 0.6x the outer body's own boost.
      outlineShape(
        `${node.id}:actor-glyph-screen`,
        ctx,
        { x: screenX, y: screenY, w: screenW, h: screenH, r: 2 },
        { fill: 'none', stroke },
        0.6,
      ),
    ],
    glyphBottom: rectY + rectH,
  };
}

/**
 * Actor gets its own light outline container — unlike Service's filled, capped, shadowed card,
 * this is a plain unfilled rounded rect (a touch softer at the corners, too) so the hierarchy
 * reads through composition and treatment rather than through being tiny: a real participant
 * card, just visibly lighter than an internal architecture component.
 */
function actor(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const cx = node.width / 2;
  // 1.5 — same body stroke weight as Service/Data Store/Queue, for one consistent line weight
  // across every technical shape.
  const stroke: Stroke = { color: palette.line, width: 1.5 };
  const kind = node.actorKind ?? 'human';

  const container = outlineShape(
    node.id,
    ctx,
    { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 10 },
    { fill: 'none', stroke },
  );

  const { shapes: glyphShapes, glyphBottom } =
    kind === 'system'
      ? systemGlyph(node, cx, stroke, ctx)
      : kind === 'device'
        ? deviceGlyph(node, cx, stroke, ctx)
        : humanGlyph(node, cx, stroke, ctx);

  const shapes: Shape[] = [container, ...glyphShapes];

  // No on-shape kind caption ("HUMAN"/"SYSTEM"/"DEVICE") — unlike Service/Data Store/Queue, whose
  // silhouette is shared across every sub-kind, Actor's three kinds are already visually distinct
  // by shape; the only text this glyph needs is the participant's own name.
  const text = node.text ?? '';
  if (text.trim()) {
    const top = glyphBottom + GLYPH_LABEL_GAP;
    const lineHeight = FONTS.nodeLabel.size * LINE_HEIGHTS.label;
    const layout = layoutText(text, {
      font: FONTS.nodeLabel,
      maxWidth: Math.max(16, node.width - PADDING),
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

/** A boundary is explicitly meant to feel stronger than an ordinary node — "someone drawing a
 *  large boundary around several services... someone just circled this part" — so it boosts its
 *  own bow/outline over the plain per-node profile value, rather than reading identically to the
 *  services it contains. Clean stays 1 (no-op) so this never changes byte-identical output. */
const BOUNDARY_BOOST: Record<PersonalityPreset, number> = { clean: 1, draft: 1.4, sketch: 1.7 };

function group(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const boost = BOUNDARY_BOOST[ctx.preset];
  const rect = { x: 1, y: 1, w: node.width - 2, h: node.height - 2, r: 12 };
  const stroke: Stroke = { color: palette.line, width: 1.25, dash: [6, 5] };
  const shapes: Shape[] = [
    outlineShape(node.id, ctx, rect, { fill: ctx.theme.surface, opacity: 0.35, stroke }, boost),
  ];

  // Only the boldest primitive in the whole system gets both of these: a second,
  // independently-seeded retrace pass, and a corner-overshoot pass — "someone just circled this
  // part" reads as more than one confident stroke, corners included. Sketch only.
  if (profile.retrace) {
    // Same clamp `outlineShape` applies to the primary outline above — kept in step so the retrace
    // pass can never draw a rounder corner than the outline it's retracing at the schema's minimum
    // boundary size.
    const retraceRadius = Math.min(rect.r, rect.w / 2, rect.h / 2);
    shapes.push({
      t: 'path',
      d: roughRectPath(rect.x, rect.y, rect.w, rect.h, retraceRadius, `${node.id}:retrace`, profile.outline * boost, profile.bow * boost),
      fill: 'none',
      stroke: { ...stroke, width: 1 },
      opacity: 0.5,
    });
  }
  if (profile.overshoot > 0) {
    const d = roughRectOvershootPath(rect.x, rect.y, rect.w, rect.h, node.id, profile.outline * boost, profile.overshoot * boost);
    if (d) shapes.push({ t: 'path', d, fill: 'none', stroke });
  }

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
