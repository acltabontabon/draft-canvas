import type {
  BoundaryPreset,
  ComponentKind,
  DatabaseKind,
  DraftNode,
  NoteKind,
  QueueKind,
  ServiceKind,
  TextAlign,
  TextRole,
} from '../document/types';
import type { DisplayList, Shape, Stroke } from '../render/displayList';
import { tokenizeCode } from '../render/code/highlight';
import { CODE_THEMES } from '../render/code/theme';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { DS_GLYPH_HEIGHT, DS_GLYPH_TOP, dataStoreScale } from '../document/dataStoreGeometry';
import { roughenPath } from '../render/roughness/roughPath';
import { bowControlPoint, roughEllipsePath, roughRectOvershootPath, roughRectPath } from '../render/roughness/roughRect';
import { jitter } from '../render/roughness/seed';
import { accentOf, boundaryLine, type AccentPalette, type Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS, TEXT_SIZES, type FontSpec } from '../render/text/fonts';
import { baselineOf, fitLabel, layoutText, type TextLayout } from '../render/text/layout';
import { getMeasurer, type TextMeasurer } from '../render/text/measure';
import type { PersonalityPreset } from '../ui/personality/usePersonality';
import { clamp } from '../lib/math';

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
  /** Intentional Roughness. Defaults to `'clean'`, today's exact
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
/** Vertical inset of a note's content from its top and bottom edge. */
const NOTE_PADDING_TOP = 10;
const NOTE_PADDING_BOTTOM = 8;
/**
 * Where a note stops growing on its own as its text gets longer (see `naturalNoteHeight`). Past
 * this the box stays put and the text is truncated with an ellipsis in read mode — a note that
 * kept growing with every line would push the architecture around it off the screen, which is
 * exactly backwards for an annotation. The user can always drag it taller by hand.
 */
export const NOTE_AUTO_MAX_HEIGHT = 320;

/** Notes are colour-coded by intent — the whole point of having four kinds. Exported so an edge
 *  attachment (`AttachmentChipRow` in `AttachmentPresentation.tsx`) can match a note's own look exactly
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

/**
 * How each boundary kind says what it is — through its outline, its header and a small marker,
 * never through colour alone (colour is the user's, and every kind wears every accent). The six
 * are one family: the same corner, inset, header row and type sizes, differing only in these few
 * deliberate places.
 *
 * - `dash`: the outline's stroke pattern (`undefined` = solid). Group's near-zero dash with round
 *   caps draws dots — the lightest line in the family. Network's dash-dot is the long-standing
 *   map notation for a perimeter.
 * - `header`: `plain` sets the title on the header row; `tab` puts it in a corner tab (Domain —
 *   the name *is* the point); `band` rules the header off from the contents (Deployment — a
 *   runtime scope reads as infrastructure with a label plate).
 * - `caption`: the kind, after the title and quieter than it. The generic Boundary and Group have
 *   none — one means "no stated meaning", the other wants the least chrome possible.
 */
interface BoundaryStyle {
  dash?: number[];
  width: number;
  /** Group only — its outline sits back from the rest of the family on purpose. */
  strokeOpacity?: number;
  header: 'plain' | 'tab' | 'band';
  marker?: 'system' | 'network' | 'deployment';
  caption?: string;
  /** Group only — the title is muted along with the outline. */
  quietTitle?: boolean;
}

export const BOUNDARY_STYLES: Record<BoundaryPreset, BoundaryStyle> = {
  boundary: { dash: [6, 4], width: 1.25, header: 'plain' },
  group: { dash: [0.01, 4], width: 1.75, strokeOpacity: 0.85, header: 'plain', quietTitle: true },
  system: { width: 1.25, header: 'plain', marker: 'system', caption: 'SYSTEM' },
  domain: { dash: [9, 4], width: 1.25, header: 'tab', caption: 'DOMAIN' },
  network: { dash: [10, 4, 0.01, 4], width: 1.25, header: 'plain', marker: 'network', caption: 'NETWORK' },
  deployment: { width: 1, header: 'band', marker: 'deployment', caption: 'DEPLOYMENT' },
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
  scheduler: 'SCHEDULER',
  gateway: 'GATEWAY',
};
const DATABASE_KIND_LABELS: Partial<Record<DatabaseKind, string>> = {
  sql: 'SQL',
  nosql: 'NOSQL',
  cache: 'CACHE',
  'file-system': 'FILE SYSTEM',
  'object-storage': 'OBJECT STORAGE',
  'search-index': 'SEARCH INDEX',
  table: 'TABLE',
};
const QUEUE_KIND_LABELS: Record<QueueKind, string> = {
  queue: 'QUEUE',
  topic: 'TOPIC',
  stream: 'STREAM',
};

/**
 * The vertical room a `variantCaption` tag takes at the bottom of a node — its own line, its
 * bottom inset, and a little daylight above it. A tagged node's name is centred in the space
 * *above* this row, never in the whole box: centring in the whole box parks a long name ("Integration
 * Service", "External System") right on top of its own WORKER/EXTERNAL tag, the two a few pixels
 * apart and overlapping horizontally, so they read as one crowded line instead of a title and a
 * small tag beneath it. Reserving the row also means a name that would wrap into that row is
 * kept to one line instead (`centredLabel`'s `maxLines` follows the available height).
 */
const TAG_ROW_GAP = 2;
function tagRow(inset = 5): number {
  return FONTS.variantTag.size * LINE_HEIGHTS.label + inset + TAG_ROW_GAP;
}

/**
 * A small, muted corner tag — the one shared visual for every node variant. `inset` only exists
 * for a shape whose own silhouette intrudes on the default bottom-right corner (Adapter's notch);
 * every other caller keeps the plain 7/5 default.
 */
function variantCaption(
  node: DraftNode,
  ctx: DescribeContext,
  label: string,
  color: string,
  inset: { right?: number; bottom?: number } = {},
): Shape[] {
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
      x: node.width - (inset.right ?? 7),
      y: node.height - layout.height - (inset.bottom ?? 5),
      layout,
      font: FONTS.variantTag,
      fill: color,
      align: 'end',
    },
  ];
}

/* ------------------------------------------------------------ C4 detail -- */

/** Space between a name and the C4 detail under it, and between the detail's own two parts. */
const C4_NAME_GAP = 3;
const C4_PART_GAP = 2;
/** Room above and below a centred name-and-detail block. */
const C4_BLOCK_PAD = 14;

function hasC4Text(node: DraftNode): boolean {
  return Boolean(node.technology || node.description);
}

/**
 * A shape's C4 detail — `[technology]`, then the description — laid out for `maxWidth`, keeping to
 * `maxHeight`. The description gives up lines first (then ellipsis); the technology line, one line
 * by definition, only goes when there is no room for it at all. `null` when the node has neither.
 */
interface C4Detail {
  height: number;
  place(x: number, y: number, align: 'middle' | 'start'): Shape[];
}

function c4Detail(node: DraftNode, ctx: DescribeContext, maxWidth: number, maxHeight: number): C4Detail | null {
  if (!hasC4Text(node)) return null;
  const techFont = FONTS.nodeTechnology;
  const bodyFont = FONTS.nodeDescription;
  const techLineHeight = techFont.size * LINE_HEIGHTS.label;
  const bodyLineHeight = bodyFont.size * LINE_HEIGHTS.label;
  const tech =
    node.technology && maxHeight >= techLineHeight
      ? layoutText(`[${node.technology}]`, {
          font: techFont,
          maxWidth,
          lineHeight: techLineHeight,
          maxLines: 1,
          measurer: ctx.measurer,
        })
      : undefined;
  const used = tech ? tech.height + (node.description ? C4_PART_GAP : 0) : 0;
  const bodyLines = Math.floor((maxHeight - used) / bodyLineHeight);
  const body =
    node.description && bodyLines >= 1
      ? layoutText(node.description, {
          font: bodyFont,
          maxWidth,
          lineHeight: bodyLineHeight,
          maxLines: bodyLines,
          measurer: ctx.measurer,
        })
      : undefined;
  if (!tech && !body) return null;
  const height = (tech?.height ?? 0) + (tech && body ? C4_PART_GAP : 0) + (body?.height ?? 0);
  return {
    height,
    place(x, y, align) {
      const shapes: Shape[] = [];
      if (tech) shapes.push({ t: 'text', x, y, layout: tech, font: techFont, fill: ctx.theme.textMuted, align });
      if (body) {
        const top = y + (tech ? tech.height + C4_PART_GAP : 0);
        shapes.push({ t: 'text', x, y: top, layout: body, font: bodyFont, fill: ctx.theme.textMuted, align });
      }
      return shapes;
    },
  };
}

/**
 * How much height the C4 detail would like, uncapped — what a name is kept clear of before it may
 * take a second line. One description line is always claimed for when there is a description, so a
 * long name can never crowd it out entirely.
 */
function c4Reserve(node: DraftNode): number {
  if (!hasC4Text(node)) return 0;
  const tech = node.technology ? FONTS.nodeTechnology.size * LINE_HEIGHTS.label : 0;
  const body = node.description ? FONTS.nodeDescription.size * LINE_HEIGHTS.label : 0;
  return C4_NAME_GAP + tech + (tech && body ? C4_PART_GAP : 0) + body;
}

/**
 * Name + kind, stacked as two lines pinned a fixed gap under a compact glyph
 * — the same treatment `queue()` has always given Queue/Topic/Stream,
 * factored out so the Data Store family's own compact-glyph kinds (NoSQL,
 * Cache, Search/Index) can share it. Unlike a band-centred caption, a
 * missing name still shows the kind alone — every one of this pattern's
 * kinds is "equally specific" the way Queue's three are, with no "generic,
 * unspecified" placeholder to fall back to.
 */
function pinnedCaption(
  node: DraftNode,
  ctx: DescribeContext,
  options: { top: number; kindLabel: string; nameColor: string },
): Shape[] {
  const maxWidth = Math.max(16, node.width - PADDING * 2);
  const kindFont = FONTS.variantTag;
  const kindLayout = layoutText(options.kindLabel, {
    font: kindFont,
    maxWidth,
    lineHeight: kindFont.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer: ctx.measurer,
  });
  const text = node.text ?? '';
  const nameGap = 2;
  if (!text.trim()) {
    return [
      {
        t: 'text',
        x: node.width / 2,
        y: options.top,
        layout: kindLayout,
        font: kindFont,
        fill: ctx.theme.textMuted,
        align: 'middle',
      },
    ];
  }
  // Pinned, not centred: the caption grows down from `top` rather than filling a band with a
  // known bottom, so the fit ceiling is simply whatever room is left to the node's own edge.
  const bottomMargin = 4;
  const available = Math.max(0, node.height - options.top - bottomMargin);
  const { layout: nameLayout, font: nameFont } = fitLabel(text, {
    font: FONTS.nodeLabel,
    minFontSize: TEXT_SIZES.nodeLabelMin,
    maxWidth,
    maxHeight: Math.max(0, available - nameGap - kindLayout.height - c4Reserve(node)),
    lineHeightRatio: LINE_HEIGHTS.label,
    measurer: ctx.measurer,
  });
  const kindTop = options.top + nameLayout.height + nameGap;
  const detailTop = kindTop + kindLayout.height + C4_NAME_GAP;
  const detail = c4Detail(node, ctx, maxWidth, node.height - bottomMargin - detailTop);
  return [
    {
      t: 'text',
      x: node.width / 2,
      y: options.top,
      layout: nameLayout,
      font: nameFont,
      fill: options.nameColor,
      align: 'middle',
      role: 'label',
    },
    {
      t: 'text',
      x: node.width / 2,
      y: kindTop,
      layout: kindLayout,
      font: kindFont,
      fill: ctx.theme.textMuted,
      align: 'middle',
    },
    ...(detail ? detail.place(node.width / 2, detailTop, 'middle') : []),
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
    case 'component':
      return component(node, ctx);
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
  options: { top: number; bottom: number; color: string; left?: number; right?: number } = {
    top: 0,
    bottom: 0,
    color: '',
  },
): Shape[] {
  const text = node.text ?? '';
  if (!text.trim()) return [];

  const palette = accentOf(ctx.theme, node.accent);
  // `left`/`right` carve horizontal room out of the label's band without moving the node's own
  // geometry — what a kind with a left-hand glyph (Service's cube, Component's plug) needs so the
  // name centres in the space *beside* the icon rather than sliding underneath it.
  const left = options.left ?? 0;
  const right = options.right ?? 0;
  const maxWidth = Math.max(16, node.width - PADDING * 2 - left - right);
  // A name with C4 detail under it is a block that can fill the shape: kept clear of the kind's own
  // chrome at the top (a cap, window dots) and of the bottom edge.
  const pad = hasC4Text(node) ? C4_BLOCK_PAD : 0;
  const available = node.height - options.top - options.bottom - pad * 2;

  const { layout, font } = fitLabel(text, {
    font: FONTS.nodeLabel,
    minFontSize: TEXT_SIZES.nodeLabelMin,
    maxWidth,
    maxHeight: available - c4Reserve(node),
    lineHeightRatio: LINE_HEIGHTS.label,
    measurer: ctx.measurer,
  });
  // With C4 detail, name and detail are one block, centred together in the band.
  const detail = c4Detail(node, ctx, maxWidth, available - layout.height - C4_NAME_GAP);
  const blockHeight = layout.height + (detail ? C4_NAME_GAP + detail.height : 0);
  const x = left + (node.width - left - right) / 2;
  const top = options.top + pad + (available - blockHeight) / 2;

  return [
    {
      t: 'text',
      x,
      y: top,
      layout,
      font,
      fill: options.color || palette.text,
      align: 'middle',
      role: 'label',
    },
    ...(detail ? detail.place(x, top + layout.height + C4_NAME_GAP, 'middle') : []),
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

/**
 * A hand-built closed outline (a notch, a socket, a chevron — silhouettes `outlineShape`'s rounded
 * rect can't express) put through the same wobble every other node gets, so at Draft and Sketch it
 * doesn't sit crisp among shapes that were drawn by hand. A no-op at Clean.
 */
function roughOutline(d: string, seedId: string, ctx: DescribeContext): string {
  const profile = PERSONALITY_PROFILES[ctx.preset];
  return roughenPath(d, seedId, profile.outline, profile.bow);
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

/* ----------------------------------------------------------- shape marks -- */

/** How far a corner mark sits in from a card's own edge. */
const MARK_INSET = 12;

/**
 * A short row of dots in a card's top-right corner — the window-chrome cue that says "a running
 * thing," and the one mark the Service and Component families share. Filled, not stroked: at this
 * size a hairline ring reads as mush.
 *
 * This is deliberately all that is left of a larger experiment. Every kind used to carry a
 * left-hand line-art glyph as well (a cube for a Service, a gear for a Worker, a plug for an
 * Adapter); they were dropped because the silhouettes already do that work — a notch is an API, a
 * double card is a Worker, a dashed outline is a Port — and a row of icon-and-label cards read as
 * a stock icon set rather than as this library.
 */
function dotsGlyph(rightX: number, cy: number, count: number, color: string): Shape {
  const r = 1.7;
  const gap = 5;
  const dots: Shape[] = Array.from({ length: count }, (_, i) => ({
    t: 'ellipse',
    cx: rightX - i * gap,
    cy,
    rx: r,
    ry: r,
    fill: color,
  }));
  return { t: 'group', children: dots };
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
  switch (node.serviceKind) {
    case 'api':
      return serviceApi(node, ctx);
    case 'worker':
      return serviceWorker(node, ctx);
    case 'external':
      return serviceExternal(node, ctx);
    case 'scheduler':
      return serviceScheduler(node, ctx);
    case 'gateway':
      return serviceGateway(node, ctx);
    default:
      return serviceGeneric(node, ctx);
  }
}

/** Generic: the family's neutral baseline — a rounded card with a coloured
 *  cap. Every other kind's silhouette is a deliberate departure from this
 *  one, so its own shape never changes once a kind gets its own function. */
function serviceGeneric(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const capHeight = 4;
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
    // Window-chrome dots, top-right: the family's "this is a running thing" cue. Generic gets the
    // full three; Worker gets two, so the two kinds stay distinguishable by the mark as well as
    // by the silhouette.
    dotsGlyph(node.width - MARK_INSET, capHeight + 9, 3, palette.chip),
    ...centredLabel(node, ctx, { top: capHeight, bottom: 0, color: palette.text }),
  ];
}

/**
 * API: the card's own outline carries an inward notch on its left edge —
 * a socket cut into the side, reading as "an exposed interface" without
 * drawing a protocol-specific glyph (no HTTP badge, no globe). The notch
 * sits at vertical mid-height, well clear of the top cap band, so the cap
 * is identical to Generic's and stays a plain clipped rect.
 */
function serviceApi(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const capHeight = 4;
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const x = 0.75;
  const y = 0.75;
  const r = 8;
  const notchH = h * 0.34;
  const notchDepth = Math.min(8, w * 0.1);
  const notchTop = y + (h - notchH) / 2;
  const notchBottom = notchTop + notchH;
  const nr = 3;

  const d = [
    `M${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h - r}`,
    `Q${x + w},${y + h} ${x + w - r},${y + h}`,
    `L${x + r},${y + h}`,
    `Q${x},${y + h} ${x},${y + h - r}`,
    `L${x},${notchBottom}`,
    `L${x + notchDepth - nr},${notchBottom}`,
    `Q${x + notchDepth},${notchBottom} ${x + notchDepth},${notchBottom - nr}`,
    `L${x + notchDepth},${notchTop + nr}`,
    `Q${x + notchDepth},${notchTop} ${x + notchDepth - nr},${notchTop}`,
    `L${x},${notchTop}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    'Z',
  ].join(' ');

  return [
    { t: 'path', d: roughOutline(d, node.id, ctx), fill: palette.fill, stroke: { color: palette.line, width: 1.5 }, shadow: true },
    {
      t: 'group',
      clip: { x, y, w, h, r },
      children: [{ t: 'rect', x, y, w, h: capHeight, fill: palette.chip }],
    },
    // No glyph, deliberately: API's whole identity is the socket cut into its own outline, and the
    // reference sheet leaves this one card iconless for exactly that reason — the silhouette has
    // already said it.
    ...centredLabel(node, ctx, { top: capHeight, bottom: tagRow(), color: palette.text }),
    ...variantCaption(node, ctx, SERVICE_KIND_LABELS.api!, ctx.theme.textMuted),
  ];
}

/**
 * Worker: two stacked cards — a plain back layer peeking out bottom-right,
 * a front layer (with the usual cap) drawn on top. Reads as "a layered
 * process," distinct from Cache's internal slabs (those sit inside one box;
 * these two layers are the whole node) and deliberately silent about
 * *which* async work it does — nothing here implies queue-only consumption.
 */
function serviceWorker(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const capHeight = 4;
  const offset = 6;
  const stroke: Stroke = { color: palette.line, width: 1.5 };
  const back = { x: 0.75 + offset, y: 0.75 + offset, w: node.width - 1.5 - offset, h: node.height - 1.5 - offset, r: 8 };
  const front = { x: 0.75, y: 0.75, w: node.width - 1.5 - offset, h: node.height - 1.5 - offset, r: 8 };
  return [
    outlineShape(`${node.id}:back`, ctx, back, { fill: palette.fill, stroke }),
    outlineShape(node.id, ctx, front, { fill: palette.fill, stroke, shadow: true }),
    {
      t: 'group',
      clip: { x: front.x, y: front.y, w: front.w, h: capHeight, r: front.r },
      children: [{ t: 'rect', x: front.x, y: front.y, w: front.w, h: capHeight, fill: palette.chip }],
    },
    // Two dots rather than Generic's three, so the mark itself distinguishes the two kinds. Kept
    // in the top-right corner: the bottom-right is where this kind's own `WORKER` caption sits,
    // and a dot cluster there would land on top of it.
    dotsGlyph(front.x + front.w - MARK_INSET, front.y + capHeight + 9, 2, palette.chip),
    ...centredLabel(node, ctx, {
      top: capHeight,
      bottom: Math.max(offset, tagRow()),
      color: palette.text,
      right: offset,
    }),
    ...variantCaption(node, ctx, SERVICE_KIND_LABELS.worker!, ctx.theme.textMuted),
  ];
}

/**
 * External: a dashed, detached outer frame around an inset inner card —
 * double outline, a visible gap, and an interrupted boundary all from one
 * small change (`Stroke.dash` on a second `outlineShape` call), so a glance
 * distinguishes "ours" from "outside our ownership" without reading the
 * caption.
 */
function serviceExternal(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const capHeight = 4;
  const inset = 6;
  const outer = { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 8 };
  const inner = {
    x: 0.75 + inset,
    y: 0.75 + inset,
    w: node.width - 1.5 - inset * 2,
    h: node.height - 1.5 - inset * 2,
    r: 6,
  };
  return [
    outlineShape(`${node.id}:frame`, ctx, outer, {
      fill: 'none',
      stroke: { color: palette.line, width: 1.25, dash: [4, 3] },
    }),
    outlineShape(node.id, ctx, inner, { fill: palette.fill, stroke: { color: palette.line, width: 1.5 }, shadow: true }),
    {
      t: 'group',
      clip: { x: inner.x, y: inner.y, w: inner.w, h: capHeight, r: inner.r },
      children: [{ t: 'rect', x: inner.x, y: inner.y, w: inner.w, h: capHeight, fill: palette.chip }],
    },
    ...centredLabel(node, ctx, {
      top: inset + capHeight,
      bottom: Math.max(inset, tagRow()),
      color: palette.text,
      left: inset,
      right: inset,
    }),
    ...variantCaption(node, ctx, SERVICE_KIND_LABELS.external!, ctx.theme.textMuted),
  ];
}

/**
 * Scheduler: a calendar glyph on the left, and — instead of Generic's one continuous cap — a short
 * cluster of three ticks hanging off the top-right corner, like the binding of a torn-off page.
 * Deliberately clustered and short rather than evenly spaced across the full width: five
 * evenly-spaced dashes spanning the whole top edge reads as a perforation (spiral-notebook
 * binding, tear-off ticket). A few marks confined to one corner reads as a rhythm accent instead,
 * and sitting opposite the glyph keeps the two details from crowding each other.
 */
function serviceScheduler(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const capHeight = 4;
  const outer = { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 8 };
  const tickCount = 3;
  const tickW = 3;
  const gap = 4;
  const tickH = 9;
  // Right-aligned: the cluster ends a fixed inset from the card's right edge and grows leftward,
  // so it stays pinned to that corner at every node width.
  const endX = outer.x + outer.w - MARK_INSET;
  const ticks: Shape[] = Array.from({ length: tickCount }, (_, i) => ({
    t: 'rect',
    x: endX - tickW - i * (tickW + gap),
    y: outer.y,
    w: tickW,
    h: tickH,
    r: 1.5,
    fill: palette.chip,
  }));
  return [
    outlineShape(node.id, ctx, outer, { fill: palette.fill, stroke: { color: palette.line, width: 1.5 }, shadow: true }),
    // Clipped to the card so the ticks stop at its own top edge rather than overhanging it.
    { t: 'group', clip: outer, children: ticks },
    ...centredLabel(node, ctx, { top: capHeight, bottom: tagRow(), color: palette.text }),
    ...variantCaption(node, ctx, SERVICE_KIND_LABELS.scheduler!, ctx.theme.textMuted),
  ];
}

/**
 * Gateway: Generic's card with its whole left edge folded into one deep chevron pointing inward —
 * a banner, not a nicked rectangle. An earlier revision cut a small arrowhead at mid-height only;
 * at a glance across a full diagram that read as a blemish on a plain card rather than a direction.
 * Taken to full height it becomes the silhouette: everything arrives on this edge and is routed
 * onward. Its cap is dropped for the same reason — a chevron with a straight band pinned across
 * its top fights itself — so the top edge stays clean and the glyph carries the accent instead.
 */
function serviceGateway(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const x = 0.75;
  const y = 0.75;
  const r = 8;
  // Deep enough to read as a chevron at a glance, capped so a narrow node doesn't lose its body.
  const chevron = Math.min(22, w * 0.18);
  const midY = y + h / 2;

  const d = [
    `M${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h - r}`,
    `Q${x + w},${y + h} ${x + w - r},${y + h}`,
    `L${x + r},${y + h}`,
    `Q${x},${y + h} ${x},${y + h - r}`,
    // The notch is cut *into* the left edge: both outer corners stay at the card's own left edge
    // and the apex pushes inward, to the right. (Putting the apex on the outside instead turns the
    // card into a pennant pointing away from the traffic it receives — which is backwards.)
    `L${x + chevron},${midY + 1.5}`,
    `Q${x + chevron + 1.5},${midY} ${x + chevron},${midY - 1.5}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    'Z',
  ].join(' ');

  return [
    { t: 'path', d: roughOutline(d, node.id, ctx), fill: palette.fill, stroke: { color: palette.line, width: 1.5 }, shadow: true },
    // The label clears the chevron cut into the left edge.
    ...centredLabel(node, ctx, { top: 0, bottom: tagRow(), color: palette.text, left: chevron }),
    ...variantCaption(node, ctx, SERVICE_KIND_LABELS.gateway!, ctx.theme.textMuted),
  ];
}

const COMPONENT_KIND_LABELS: Partial<Record<ComponentKind, string>> = {
  module: 'MODULE',
  adapter: 'ADAPTER',
  port: 'PORT',
};
/** Same dash array a Boundary's outline and a generated DLQ already use — "dashed = not a concrete
 *  thing" is an established meaning in this app, and a Port is exactly that: a contract. */
const PORT_DASH = [6, 5];

/**
 * Component's own stroke — a shade thinner than every other primitive's shared 1.5px
 * (`surfaceStroke`). One of the two deliberate "weighs less than Service" cues that aren't just an
 * absent cap or a quieter accent: a Component-family box should read as lighter even reduced to a
 * silhouette in monochrome, not only through colour.
 */
function componentStroke(ctx: DescribeContext, node: DraftNode): Stroke {
  return { color: accentOf(ctx.theme, node.accent ?? 'neutral').line, width: 1.25 };
}

/**
 * Component earns a distinct silhouette per kind now, the same discipline Service's own kinds
 * follow — but restrained on purpose: where a Service kind sometimes changes the *whole* body
 * (Worker's stacked cards, External's double outline), every Component kind keeps exactly the same
 * plain rounded body and departs from it with only a small mark or two (Module: one, on the top
 * edge; Adapter: two, mirrored left/right — see its own comment for why), because a Component is
 * still meant to read as *contained within* something else, never a peer of the Services around
 * it. `generic` gets no mark at all (and no corner caption — the same "unspecified means unmarked"
 * convention Service's own default kind follows).
 */
function component(node: DraftNode, ctx: DescribeContext): Shape[] {
  switch (node.componentKind) {
    case 'module':
      return componentModule(node, ctx);
    case 'adapter':
      return componentAdapter(node, ctx);
    case 'port':
      return componentPort(node, ctx);
    default:
      return componentGeneric(node, ctx);
  }
}

/**
 * Port: Generic's body drawn as a dashed outline — the one Component kind that isn't a thing
 * doing work but the shape of an agreement, so it borrows the "not concrete" dash a Boundary and a
 * DLQ already speak rather than inventing a glyph. Its `PORT` tag sits centred *under* the name (a
 * queue's name-over-kind stacking) instead of in the corner every other kind uses: a port is meant
 * to be small, and at the width a one-word port name needs, a corner tag would sit on top of the
 * name itself. The name is held above the tag by exactly the tag's own line plus its inset, so the
 * two never touch at any height a port is likely to be drawn at.
 */
function componentPort(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const portRect = { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 8 };
  return [
    outlineShape(node.id, ctx, portRect, {
      fill: palette.fill,
      stroke: { ...componentStroke(ctx, node), dash: PORT_DASH },
      shadow: true,
    }),
    ...centredLabel(node, ctx, { top: 0, bottom: tagRow(), color: '' }),
    // The shared bottom-right tag, like every other captioned kind. This used to centre its tag
    // under the name instead, on the reasoning that a Port is an agreement rather than a component
    // and could afford its own arrangement; sitting beside an Adapter or a Module it just looked
    // like the one shape whose caption had slipped out of place.
    ...variantCaption(node, ctx, COMPONENT_KIND_LABELS.port!, ctx.theme.textMuted),
  ];
}

/** Generic: the family's neutral baseline — a plain rounded box, no cap, no notch, `neutral`
 *  accent, Component's own thinner stroke. Every other kind is a deliberate, restrained departure
 *  from this one. */
function componentGeneric(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const rect = { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 8 };
  return [
    outlineShape(node.id, ctx, rect, { fill: palette.fill, stroke: componentStroke(ctx, node), shadow: true }),
    dotsGlyph(node.width - MARK_INSET, 10, 3, palette.chip),
    ...centredLabel(node, ctx, { top: 0, bottom: 0, color: '' }),
  ];
}

/**
 * Module: Generic's body with one small tab stepping up from the top edge, near the left corner —
 * a "labelled unit in a set" cue, the same idea as a file/sheet tab. Built as one continuous
 * outline (the technique `serviceApi`/`serviceGateway` already use for their own notches) rather
 * than a second stacked shape (`serviceWorker`'s technique, which reads as *layers*, not a *tab*).
 * Deliberately short and one-sided — a tab spanning the full width would just be Service's own cap
 * band, the one silhouette Component exists specifically not to have.
 */
function componentModule(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const x = 0.75;
  const y = 0.75;
  const r = 8;
  const tabX = x + 12;
  const tabW = Math.min(30, w * 0.32);
  const tabH = 7;
  const tr = 2;

  const d = [
    `M${x + r},${y}`,
    `L${tabX},${y}`,
    `L${tabX},${y - tabH + tr}`,
    `Q${tabX},${y - tabH} ${tabX + tr},${y - tabH}`,
    `L${tabX + tabW - tr},${y - tabH}`,
    `Q${tabX + tabW},${y - tabH} ${tabX + tabW},${y - tabH + tr}`,
    `L${tabX + tabW},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h - r}`,
    `Q${x + w},${y + h} ${x + w - r},${y + h}`,
    `L${x + r},${y + h}`,
    `Q${x},${y + h} ${x},${y + h - r}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    'Z',
  ].join(' ');

  return [
    { t: 'path', d: roughOutline(d, node.id, ctx), fill: palette.fill, stroke: componentStroke(ctx, node), shadow: true },
    ...centredLabel(node, ctx, { top: 0, bottom: tagRow(), color: '' }),
    ...variantCaption(node, ctx, COMPONENT_KIND_LABELS.module!, ctx.theme.textMuted),
  ];
}

/**
 * Adapter: Generic's body with a small rectangular notch cut into *both* vertical edges — the same
 * cut-rectangle language `serviceApi`'s own notch already speaks, just mirrored onto each side
 * rather than one.
 *
 * An earlier revision cut the notch into the right edge only, on the reasoning that "Draft Canvas
 * reads left to right, so the side facing onward is the one that bridges toward infrastructure."
 * That baked in a global assumption this starter's own composition disproves: `Persistence
 * Adapter`/`Integration Adapter` face infrastructure on their right, but an inbound adapter (a
 * `REST Adapter` fronting the same core from the left, say) faces infrastructure on its *left* —
 * there is no side of an Adapter that is always the outward one. Fixing that properly means
 * orienting the notch from the node's actual connections, but `describeNode` takes only a node and
 * a theme — deliberately pure, so the same function produces byte-identical output for the canvas
 * and the static exporter — and has no view of the document's edges to orient from. Threading edge
 * direction through it would mean recomputing a node's silhouette every time an edge nearby is
 * dragged, reconnected, undone, or redone, and risks the exact "shape flip-flops while the user is
 * still drawing" failure a directional rule invites. So instead the silhouette itself stays valid
 * regardless of which way the Adapter faces: a notch on *each* vertical edge, bilaterally
 * symmetric, reads as "interfaces on both sides" — true of every Adapter, in either orientation,
 * with no context required and nothing to get wrong while dragging.
 */
function componentAdapter(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const x = 0.75;
  const y = 0.75;
  const r = 8;
  const notchH = h * 0.34;
  const notchDepth = Math.min(8, w * 0.1);
  const notchTop = y + (h - notchH) / 2;
  const notchBottom = notchTop + notchH;
  const nr = 3;

  const d = [
    `M${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${notchTop}`,
    `L${x + w - notchDepth + nr},${notchTop}`,
    `Q${x + w - notchDepth},${notchTop} ${x + w - notchDepth},${notchTop + nr}`,
    `L${x + w - notchDepth},${notchBottom - nr}`,
    `Q${x + w - notchDepth},${notchBottom} ${x + w - notchDepth + nr},${notchBottom}`,
    `L${x + w},${notchBottom}`,
    `L${x + w},${y + h - r}`,
    `Q${x + w},${y + h} ${x + w - r},${y + h}`,
    `L${x + r},${y + h}`,
    `Q${x},${y + h} ${x},${y + h - r}`,
    `L${x},${notchBottom}`,
    `L${x + notchDepth - nr},${notchBottom}`,
    `Q${x + notchDepth},${notchBottom} ${x + notchDepth},${notchBottom - nr}`,
    `L${x + notchDepth},${notchTop + nr}`,
    `Q${x + notchDepth},${notchTop} ${x + notchDepth - nr},${notchTop}`,
    `L${x},${notchTop}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    'Z',
  ].join(' ');

  // The default corner inset (7px from the right edge) sits inside the right notch's own x-range
  // whenever a notch is this deep — the caption and the silhouette would visually crowd the same
  // corner. Pushed out exactly as far as the notch itself cuts in, plus a small fixed gap, so the
  // two never compete regardless of node width.
  const captionInset = { right: notchDepth + 5 };

  return [
    { t: 'path', d: roughOutline(d, node.id, ctx), fill: palette.fill, stroke: componentStroke(ctx, node), shadow: true },
    // The label clears the sockets cut into both vertical edges.
    ...centredLabel(node, ctx, { top: 0, bottom: tagRow(), color: '', left: notchDepth, right: notchDepth }),
    ...variantCaption(node, ctx, COMPONENT_KIND_LABELS.adapter!, ctx.theme.textMuted, captionInset),
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

/**
 * Data Store's silhouette varies by kind — see the module comment on why
 * that matters ("silhouette, not iconography"). Generic and SQL keep the
 * classic vertical cylinder (`dataStoreCylinder`, unchanged from before this
 * kind family existed) since both are explicitly meant to still read as an
 * ordinary database; the other five kinds each get their own outline that
 * fills the node the same way the cylinder does.
 */
function database(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const scale = dataStoreScale(node);
  return [...scaledGlyph(dataStoreGlyph(node, ctx), scale, node.width / 2), ...dataStoreCaption(node, ctx, palette, scale)];
}

/**
 * A glyph, drawn at its normal size around the box's centre line, grown by `scale` about the top
 * of the box — so a bigger Data Store gets a bigger shape, not just more empty box around the same
 * one. Strokes keep their weight: the group scales them, so they are divided back here. At the
 * normal size (`scale` 1, every box up to the default) the shapes are returned untouched.
 */
function scaledGlyph(shapes: Shape[], scale: number, centreX: number): Shape[] {
  if (scale === 1) return shapes;
  const unscaled = (stroke: Stroke | undefined): Stroke | undefined =>
    stroke && { ...stroke, width: stroke.width / scale, dash: stroke.dash?.map((length) => length / scale) };
  const restore = (shape: Shape): Shape => {
    switch (shape.t) {
      case 'rect':
      case 'ellipse':
      case 'path':
        return shape.stroke ? { ...shape, stroke: unscaled(shape.stroke) } : shape;
      case 'group':
        return { ...shape, children: shape.children.map(restore) };
      default:
        return shape;
    }
  };
  return [{ t: 'group', children: shapes.map(restore), scale, translate: { x: centreX * (1 - scale), y: 0 } }];
}

/** A Data Store's glyph alone, at its normal size — see `database` for what goes around it. */
function dataStoreGlyph(node: DraftNode, ctx: DescribeContext): Shape[] {
  switch (node.databaseKind) {
    case 'nosql':
      return dataStoreNoSql(node, ctx);
    case 'cache':
      return dataStoreCache(node, ctx);
    case 'file-system':
      return dataStoreFileSystem(node, ctx);
    case 'object-storage':
      return dataStoreObjectStorage(node, ctx);
    case 'search-index':
      return dataStoreSearchIndex(node, ctx);
    case 'table':
      return dataStoreTable(node, ctx);
    default:
      return dataStoreCylinder(node, ctx);
  }
}

/**
 * Every Data Store kind is drawn the same way: one compact glyph anchored to the top of the node,
 * its name and kind stacked underneath — the Queue family's arrangement, applied here too.
 *
 * The alternative (which several of these kinds used to use) was to stretch the silhouette to the
 * node's full box and put the name *inside* it. That reads fine for a cylinder and badly for
 * everything else: a folder, a bucket and a card stack all have interior detail of their own, and
 * a name laid over it collides with the very thing that identifies the kind. Anchoring every kind
 * the same way is also what lets eight quite different silhouettes still read as one family.
 */
const DS_GLYPH_BOTTOM = DS_GLYPH_TOP + DS_GLYPH_HEIGHT;
const DS_CAPTION_GAP = 5;

/** The caption under a Data Store's glyph. `generic` has no kind label of its own — it's the
 *  family's baseline, so it carries just the name. */
function dataStoreCaption(node: DraftNode, ctx: DescribeContext, palette: AccentPalette, scale = 1): Shape[] {
  const kindLabel = DATABASE_KIND_LABELS[node.databaseKind ?? 'generic'];
  const top = DS_GLYPH_BOTTOM * scale + DS_CAPTION_GAP;
  if (kindLabel) {
    return pinnedCaption(node, ctx, { top, kindLabel, nameColor: palette.text });
  }
  const text = node.text ?? '';
  if (!text.trim()) return [];
  const maxWidth = Math.max(16, node.width - PADDING * 2);
  const { layout, font } = fitLabel(text, {
    font: FONTS.nodeLabel,
    minFontSize: TEXT_SIZES.nodeLabelMin,
    maxWidth,
    maxHeight: Math.max(0, node.height - top - 4 - c4Reserve(node)),
    lineHeightRatio: LINE_HEIGHTS.label,
    measurer: ctx.measurer,
  });
  const detailTop = top + layout.height + C4_NAME_GAP;
  const detail = c4Detail(node, ctx, maxWidth, node.height - 4 - detailTop);
  return [
    { t: 'text', x: node.width / 2, y: top, layout, font, fill: palette.text, align: 'middle', role: 'label' },
    ...(detail ? detail.place(node.width / 2, detailTop, 'middle') : []),
  ];
}

/**
 * Generic and SQL: a vertical cylinder.
 *
 * Generic adds three dots down the right of the barrel — "there is something in here" without
 * committing to what. SQL stacks two disc seams across it instead, the classic layered-database
 * read. SQL's reference sheet also hangs a small "SQL" badge off the barrel; that word is already
 * the caption directly underneath, so the seams carry the kind here and the badge is left off
 * rather than printing "SQL" twice in one node.
 */
function dataStoreCylinder(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = Math.min(54, node.width - PADDING * 2);
  const x = node.width / 2 - w / 2;
  const y = DS_GLYPH_TOP;
  const h = DS_GLYPH_HEIGHT;
  const ry = Math.min(8, h * 0.19);
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const stroke: Stroke = { color: palette.line, width: 1.5 };

  const { body, lid } = cylinderPaths(x, y, w, h, ry, node.id, profile.outline, profile.bow);
  const shapes: Shape[] = [
    { t: 'path', d: body, fill: palette.fill, stroke },
    { t: 'path', d: lid, fill: 'none', stroke },
  ];

  if (profile.retrace) {
    const retrace = cylinderPaths(x, y, w, h, ry, `${node.id}:retrace`, profile.outline, profile.bow);
    shapes.push(
      { t: 'path', d: retrace.body, fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.5 },
      { t: 'path', d: retrace.lid, fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.5 },
    );
  }

  if (node.databaseKind === 'sql') {
    // Two more disc seams, evenly down the barrel and drawn as the same ellipse arc the lid is,
    // so the whole thing reads as discs stacked in a housing rather than a tube with rings on it.
    for (const t of [0.42, 0.68]) {
      const seamY = y + ry + (h - ry * 2) * t;
      shapes.push({
        t: 'path',
        d: `M${x},${seamY} a${w / 2},${ry} 0 0 0 ${w},0`,
        fill: 'none',
        stroke: { color: palette.line, width: 1.2 },
        opacity: 0.75,
      });
    }
  } else {
    // Generic's three dots, down the right of the barrel. One path of three discs rather than
    // three `ellipse` shapes: the cylinder families are built entirely from paths (it's what lets
    // the Sketch retrace pass stay a clean body+lid pair), and this keeps that true.
    const dotX = x + w * 0.74;
    const midY = y + h / 2 + ry * 0.3;
    const dotR = 1.7;
    const disc = (cy: number) =>
      `M${dotX - dotR},${cy} a${dotR},${dotR} 0 1 0 ${dotR * 2},0 a${dotR},${dotR} 0 1 0 ${-dotR * 2},0`;
    shapes.push({
      t: 'path',
      d: [-7, 0, 7].map((dy) => disc(midY + dy)).join(' '),
      fill: palette.chip,
    });
  }

  return shapes;
}

/**
 * File System: a folder — a tab stepping up from the top-left of a body, with two ruled lines
 * inside it. One closed outline, not a body plus a separate tab, so the silhouette stays a single
 * shape at every roughness preset.
 */
function dataStoreFileSystem(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = Math.min(56, node.width - PADDING * 2);
  const x = node.width / 2 - w / 2;
  const h = DS_GLYPH_HEIGHT;
  const r = 5;
  const tabW = w * 0.44;
  const tabH = 8;
  const y = DS_GLYPH_TOP + tabH;

  const d = [
    `M${x + r},${y - tabH}`,
    `L${x + tabW - r},${y - tabH}`,
    `Q${x + tabW},${y - tabH} ${x + tabW + 2},${y - tabH + 3}`,
    `L${x + tabW + 5},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h - tabH - r}`,
    `Q${x + w},${y + h - tabH} ${x + w - r},${y + h - tabH}`,
    `L${x + r},${y + h - tabH}`,
    `Q${x},${y + h - tabH} ${x},${y + h - tabH - r}`,
    `L${x},${y - tabH + r}`,
    `Q${x},${y - tabH} ${x + r},${y - tabH}`,
    'Z',
  ].join(' ');

  const bodyMid = y + (h - tabH) / 2;
  const lineX = x + 11;
  return [
    { t: 'path', d: roughOutline(d, node.id, ctx), fill: palette.fill, stroke: { color: palette.line, width: 1.5 } },
    {
      t: 'path',
      d: `M${lineX},${bodyMid - 4} h${w - 22} M${lineX},${bodyMid + 3} h${w - 30}`,
      fill: 'none',
      stroke: { color: palette.chip, width: 1.4, linecap: 'round' },
    },
  ];
}

/**
 * NoSQL: two document cards, the front one offset down-right of the back one, with a small field
 * of dots in its corner — "stacked documents, shape not fixed." Deliberately the opposite of
 * Cache's neat aligned stack.
 */
function dataStoreNoSql(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const stroke: Stroke = { color: palette.line, width: 1.5 };
  const cardW = Math.min(44, (node.width - PADDING * 2) * 0.8);
  const cardH = 27;
  const offset = 9;
  const totalW = cardW + offset;
  const x = node.width / 2 - totalW / 2;
  const y = DS_GLYPH_TOP + (DS_GLYPH_HEIGHT - (cardH + offset)) / 2;

  const back = { x, y, w: cardW, h: cardH, r: 5 };
  const front = { x: x + offset, y: y + offset, w: cardW, h: cardH, r: 5 };

  const dots: Shape[] = [];
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      dots.push({
        t: 'ellipse',
        cx: front.x + front.w - 20 + col * 6,
        cy: front.y + front.h - 12 + row * 6,
        rx: 1.5,
        ry: 1.5,
        fill: palette.chip,
      });
    }
  }

  return [
    outlineShape(`${node.id}:back`, ctx, back, { fill: palette.fill, stroke }),
    outlineShape(node.id, ctx, front, { fill: palette.fill, stroke }),
    { t: 'group', children: dots },
  ];
}

/**
 * Cache: three isometric chips stacked with air between them — layers you can drop and rebuild,
 * which is the whole point of a cache. Rhombuses rather than the flat slabs this used to draw:
 * flat bars read as Search Index's rows, and these need to be unmistakably a different family of
 * mark from those.
 */
function dataStoreCache(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const stroke: Stroke = { color: palette.line, width: 1.5 };
  const chipW = Math.min(48, node.width - PADDING * 2);
  const chipH = 15;
  const gap = 5;
  const cx = node.width / 2;
  const stackH = chipH + (chipH + gap - chipH) + (chipH / 2) * 2 + gap * 2;
  const top = DS_GLYPH_TOP + (DS_GLYPH_HEIGHT - stackH) / 2 + chipH / 2;

  const chip = (cy: number): Shape => ({
    t: 'path',
    d: roughOutline(
      [
        `M${cx},${cy - chipH / 2}`,
        `L${cx + chipW / 2},${cy}`,
        `L${cx},${cy + chipH / 2}`,
        `L${cx - chipW / 2},${cy}`,
        'Z',
      ].join(' '),
      `${node.id}:chip${cy}`,
      ctx,
    ),
    fill: palette.fill,
    stroke,
  });

  // Back to front, so each chip's outline sits cleanly on the one below it.
  const step = chipH / 2 + gap;
  return [
    chip(top + step * 2),
    chip(top + step),
    chip(top),
  ];
}

/**
 * Object Storage: a bucket — an elliptical rim over a body that tapers to a smaller base, a
 * handle on one side, and a few loose geometric objects inside. Abstract on purpose: objects of
 * whatever shape, dropped in a container, with no vendor's logo anywhere near it.
 */
function dataStoreObjectStorage(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const stroke: Stroke = { color: palette.line, width: 1.5 };
  const topW = Math.min(50, node.width - PADDING * 2);
  const bottomW = topW * 0.66;
  const cx = node.width / 2;
  const y = DS_GLYPH_TOP + 3;
  const h = DS_GLYPH_HEIGHT - 6;
  const ry = 6;
  const topLeft = cx - topW / 2;
  const topRight = cx + topW / 2;
  const bottomLeft = cx - bottomW / 2;
  const bottomRight = cx + bottomW / 2;
  const bottomY = y + h;
  const cornerR = 4;

  const body = [
    `M${topLeft},${y}`,
    `L${bottomLeft + cornerR * 0.4},${bottomY - cornerR}`,
    `Q${bottomLeft + cornerR * 0.6},${bottomY} ${bottomLeft + cornerR + 1},${bottomY}`,
    `L${bottomRight - cornerR - 1},${bottomY}`,
    `Q${bottomRight - cornerR * 0.6},${bottomY} ${bottomRight - cornerR * 0.4},${bottomY - cornerR}`,
    `L${topRight},${y}`,
  ].join(' ');

  // The rim is the cylinder family's "lid" convention, reused — an open container, seen slightly
  // from above.
  const rim = `M${topLeft},${y} a${topW / 2},${ry} 0 0 0 ${topW},0 a${topW / 2},${ry} 0 0 0 ${-topW},0`;
  // One small handle, so the silhouette isn't symmetrical and reads as a pail rather than a cup.
  const handle = `M${topRight - 2},${y + 9} q6,3 4,10`;

  const markY = bottomY - 13;
  const tri = (mx: number, my: number, s: number) =>
    `M${mx},${my - s} L${mx + s},${my + s * 0.8} L${mx - s},${my + s * 0.8} Z`;

  return [
    { t: 'path', d: roughOutline(body, node.id, ctx), fill: palette.fill, stroke },
    { t: 'path', d: rim, fill: 'none', stroke },
    { t: 'path', d: handle, fill: 'none', stroke: { color: palette.line, width: 1.3 } },
    {
      t: 'path',
      d: `${tri(cx - 1, markY - 7, 3.4)} ${tri(cx - 6, markY, 3.4)}`,
      fill: palette.chip,
    },
    { t: 'rect', x: cx + 2, y: markY - 3, w: 6, h: 6, r: 1.5, fill: palette.chip },
  ];
}

/**
 * Search / Index: rows with a lens over them.
 *
 * An earlier revision drew tabbed catalogue cards and explicitly refused a magnifying glass, on
 * the grounds that a lens says "search the UI" rather than "a search index." Between a card
 * catalogue nobody under forty has used and the universal mark for looking something up, the lens
 * wins: the rows underneath are what say "an index," and the lens says what is done to them.
 */
function dataStoreSearchIndex(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const stroke: Stroke = { color: palette.line, width: 1.5 };
  const rowW = Math.min(48, node.width - PADDING * 2);
  const rowH = 8;
  const gap = 5;
  const x = node.width / 2 - rowW / 2;
  const stackH = rowH * 3 + gap * 2;
  const y = DS_GLYPH_TOP + (DS_GLYPH_HEIGHT - stackH) / 2;

  const rows: Shape[] = [0, 1, 2].map((i) => ({
    t: 'rect',
    x,
    y: y + i * (rowH + gap),
    w: rowW,
    h: rowH,
    r: 3,
    fill: palette.fill,
    stroke,
  }));

  // Bottom-right, overlapping the last row — the lens sits *on* the index it searches.
  const lensR = 7.5;
  const lensCx = x + rowW - 4;
  const lensCy = y + stackH - 2;
  return [
    ...rows,
    // Filled with the shape's own surface colour, not the canvas colour: the lens overlaps the
    // bottom row and has to hide it, but a Data Store often sits on a tinted Boundary, where a
    // canvas-coloured disc would read as a hole punched through the shape.
    { t: 'ellipse', cx: lensCx, cy: lensCy, rx: lensR, ry: lensR, fill: palette.fill, stroke },
    {
      t: 'path',
      d: `M${lensCx + lensR * 0.7},${lensCy + lensR * 0.7} l4,4`,
      fill: 'none',
      stroke: { color: palette.line, width: 1.8, linecap: 'round' },
    },
  ];
}

/**
 * Table: a grid — a card with a filled header row and ruled columns. A logical table (or
 * collection) *inside* a store, not a store: two of these in one boundary must read as two tables
 * of one database, never as two physical stores in a distributed transaction.
 */
function dataStoreTable(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = Math.min(54, node.width - PADDING * 2);
  const x = node.width / 2 - w / 2;
  const y = DS_GLYPH_TOP + 2;
  const h = DS_GLYPH_HEIGHT - 4;
  const r = 4;
  const headerH = 9;
  const cols = 3;
  const rows = 3;

  const rules: string[] = [];
  for (let i = 1; i < cols; i += 1) {
    const gx = x + (w * i) / cols;
    rules.push(`M${gx},${y} L${gx},${y + h}`);
  }
  for (let i = 1; i < rows; i += 1) {
    const gy = y + headerH + ((h - headerH) * i) / rows;
    rules.push(`M${x},${gy} L${x + w},${gy}`);
  }

  return [
    outlineShape(node.id, ctx, { x, y, w, h, r }, { fill: palette.fill, stroke: { color: palette.line, width: 1.5 } }),
    // Header row, clipped to the card's own rounded top the same way a Service's cap is.
    {
      t: 'group',
      clip: { x, y, w, h, r },
      children: [{ t: 'rect', x, y, w, h: headerH, fill: palette.chip }],
    },
    {
      t: 'group',
      clip: { x, y, w, h, r },
      children: [
        { t: 'path', d: rules.join(' '), fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.6 },
      ],
    },
  ];
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

/** Same dash array `group()`'s boundary outline already uses — "dashed = subordinate" is an
 *  established visual meaning in this app, not a new one invented for the DLQ treatment. */
const DLQ_DASH = [6, 5];
/** Reduced visual weight for a generated DLQ's tube/icon shapes — never applied to its caption
 *  text, which must stay fully legible at small zoom and in exports. */
const DLQ_OPACITY = 0.75;

function queue(node: DraftNode, ctx: DescribeContext): Shape[] {
  const isDlq = node.deliveryRole === 'dead-letter';
  const palette = accentOf(ctx.theme, node.accent ?? 'neutral');
  const w = node.width - 1.5;
  const h = node.height - 1.5;
  const x = 0.75;
  const y = 0.75;
  // The tube is a compact glyph, not the whole node — like an actor's head
  // and shoulders, it doesn't grow to fill the box. The name and its kind
  // subtext live below it, stacked, in the full-width space that leaves —
  // kept small enough that even a pre-existing (shorter) queue node has room
  // for both lines without them running into the tube.
  // `document/queueGeometry.ts`'s `queueTubeSpan` mirrors this `y`/`tubeH` arithmetic
  // for anything placing a connector on the tube ahead of rendering — keep the two in step.
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

  // Stream: records rather than envelopes — three small document tiles, each ruled with two short
  // lines, separated by chevrons showing the direction of travel. A plain stack of blank blocks
  // (the previous glyph) read as "three things"; ruled tiles read as "structured records moving
  // through," which is what distinguishes a stream from a queue of messages.
  function streamIcons(): string {
    const segCount = 3;
    const segW = 15;
    const segH = 15;
    const segGap = 9;
    const baseY = y + tubeH / 2 - segH / 2;
    const startX = x + (w - (segW * segCount + segGap * (segCount - 1))) / 2;
    const parts: string[] = [];
    for (let i = 0; i < segCount; i += 1) {
      const sx = startX + i * (segW + segGap);
      parts.push(`M${sx},${baseY} h${segW} v${segH} h${-segW} Z`);
      // Two rules inside each tile, inset so they never touch its border.
      parts.push(`M${sx + 3},${baseY + segH * 0.36} h${segW - 6}`);
      parts.push(`M${sx + 3},${baseY + segH * 0.64} h${segW - 7}`);
      if (i < segCount - 1) {
        const gx = sx + segW + segGap / 2;
        const gy = y + tubeH / 2;
        parts.push(`M${gx - 1.8},${gy - 2.6} L${gx + 1.4},${gy} L${gx - 1.8},${gy + 2.6}`);
      }
    }
    return parts.join(' ');
  }

  /** Where the DLQ's envelope pair starts, so the solid one here and the dashed one added after
   *  the icon path is built stay centred as a single group. */
  const DLQ_ICON_W = 17;
  const DLQ_ICON_H = 13;
  const DLQ_ICON_GAP = 7;
  const dlqStartX = x + (w - (DLQ_ICON_W * 2 + DLQ_ICON_GAP)) / 2;

  // DLQ: one delivered envelope and, trailing it, one that didn't make it (dashed, added
  // separately since a single path can't carry two dash patterns) — not a queue of things waiting
  // their turn. Centred as a pair exactly where the other kinds' icon clusters sit.
  function dlqIcon(): string {
    return envelope(dlqStartX, y + tubeH / 2 - DLQ_ICON_H / 2, DLQ_ICON_W, DLQ_ICON_H);
  }

  const icons = isDlq
    ? dlqIcon()
    : node.queueKind === 'topic'
      ? topicIcons()
      : node.queueKind === 'stream'
        ? streamIcons()
        : queueIcons();

  const dlqOpacity = isDlq ? DLQ_OPACITY : undefined;
  const shapes: Shape[] = [
    { t: 'path', d: body, fill: palette.fill, stroke: { color: palette.line, width: 1.5 }, opacity: dlqOpacity },
    { t: 'path', d: lid, fill: 'none', stroke: { color: palette.line, width: 1.5 }, opacity: dlqOpacity },
    { t: 'path', d: icons, fill: 'none', stroke: { color: palette.line, width: 1.2 }, opacity: dlqOpacity },
  ];
  // A DLQ's dash belongs on the undelivered message, not on the pipe: the queue itself is a real,
  // working queue, and what's exceptional about it is the message sitting in it. So the tube stays
  // solid (only slightly dimmed) and a second, dashed envelope trails the solid one — "one that
  // made it, one that didn't." The whole-tube dash this used to carry said the infrastructure was
  // hypothetical, which was never the intent.
  if (isDlq) {
    shapes.push({
      t: 'path',
      d: envelope(dlqStartX + DLQ_ICON_W + DLQ_ICON_GAP, y + tubeH / 2 - DLQ_ICON_H / 2, DLQ_ICON_W, DLQ_ICON_H),
      fill: 'none',
      stroke: { color: palette.line, width: 1.2, dash: DLQ_DASH },
      opacity: dlqOpacity,
    });
  }

  // Same "special opportunity" retrace pass as `database()` — Sketch only, independently
  // seeded. The icon glyphs above never retrace; they're small, identifying, and text-adjacent.
  if (profile.retrace) {
    const retrace = tubePaths(x, y, w, tubeH, rx, `${node.id}:retrace`, profile.outline, profile.bow);
    shapes.push(
      { t: 'path', d: retrace.body, fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.5 },
      { t: 'path', d: retrace.lid, fill: 'none', stroke: { color: palette.line, width: 1 }, opacity: 0.5 },
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

  // Anchored right under the tube (not centred in whatever height the node
  // happens to be) — the tube is a small fixed-size glyph, not something that
  // grows to fill a resized node, so the caption stays close to the shape it
  // labels instead of drifting toward the middle of a tall box. Deliberately
  // tight (not a generic paragraph gap) so the icon and its caption read as
  // one element, not an icon plus a detached line of text underneath it.
  const top = tubeH + 2;
  shapes.push(...pinnedCaption(node, ctx, { top, kindLabel, nameColor: palette.text }));

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
 * System: a computer — a wide monitor with an inset screen, standing on a neck and foot.
 *
 * This is the participant that isn't a person: a service account, a machine identity, an
 * integration acting on someone's behalf. A monitor says "a machine" at a glance, and its wide,
 * landscape proportion keeps it clear of Device's tall, pocket-sized silhouette.
 */
function systemGlyph(
  node: DraftNode,
  cx: number,
  stroke: Stroke,
  ctx: DescribeContext,
): { shapes: Shape[]; glyphBottom: number } {
  const monitorW = 58;
  const monitorH = 31;
  const monitorX = cx - monitorW / 2;
  const monitorY = GLYPH_TOP;
  const screenInset = 4;
  const neckTop = monitorY + monitorH;
  const neckBottom = neckTop + 8;
  const footY = neckBottom + 1;
  const footHalf = 14;

  return {
    shapes: [
      outlineShape(`${node.id}:actor-glyph`, ctx, { x: monitorX, y: monitorY, w: monitorW, h: monitorH, r: 4 }, { fill: 'none', stroke }),
      // The screen — restrained relative to the outer silhouette, like Device's.
      outlineShape(
        `${node.id}:actor-glyph-screen`,
        ctx,
        { x: monitorX + screenInset, y: monitorY + screenInset, w: monitorW - screenInset * 2, h: monitorH - screenInset * 2, r: 2 },
        { fill: stroke.color, opacity: 0.08 },
        0.6,
      ),
      // A tapered neck and a flat foot — what turns a rectangle into a desktop monitor.
      {
        t: 'path',
        d: `M${cx - 4},${neckTop} L${cx - 6},${neckBottom} M${cx + 4},${neckTop} L${cx + 6},${neckBottom}`,
        fill: 'none',
        stroke,
      },
      { t: 'path', d: `M${cx - footHalf},${footY} L${cx + footHalf},${footY}`, fill: 'none', stroke },
    ],
    glyphBottom: footY + 1,
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
 * Group: three of Human's own bust silhouettes at reduced scale, overlapping — several people
 * acting together, not a new pictogram. The centre bust is drawn last (full size, full strength)
 * on top of two smaller, partially-hidden ones behind it, the same "who's in front" layering every
 * people-group icon uses. Deliberately reuses Human's construction (head + closed-shoulder torso)
 * rather than inventing a second body shape, so Group reads as "Human, but several" at a glance.
 */
function groupGlyph(
  node: DraftNode,
  cx: number,
  stroke: Stroke,
  ctx: DescribeContext,
): { shapes: Shape[]; glyphBottom: number } {
  const bottom = GLYPH_BOTTOM;
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const outlineAmp = profile.outline;
  const bowAmp = profile.bow;
  const bodyFill = 0.12;

  const bust = (seedSuffix: string, bustCx: number, headR: number, torsoRx: number, capRy: number, opacity: number): Shape[] => {
    const headCy = GLYPH_TOP + headR + (13 - headR);
    const peakY = headCy + headR - 2;
    const shoulderTopY = peakY + capRy;
    const left = bustCx - torsoRx;
    const right = bustCx + torsoRx;
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
      const j = (i: number) => jitter(`${node.id}:${seedSuffix}`, i, outlineAmp);
      const lb = { x: left + j(0), y: bottom + j(1) };
      const lt = { x: left + j(2), y: shoulderTopY + j(3) };
      const rt = { x: right + j(4), y: shoulderTopY + j(5) };
      const rb = { x: right + j(6), y: bottom + j(7) };
      const wall = (a: { x: number; y: number }, b: { x: number; y: number }, index: number) => {
        if (bowAmp === 0) return `L${b.x},${b.y}`;
        const c = bowControlPoint(a, b, `${node.id}:${seedSuffix}`, index, bowAmp);
        return `Q${c.x},${c.y} ${b.x},${b.y}`;
      };
      torso = [`M${lb.x},${lb.y}`, wall(lb, lt, 20), `A${(rt.x - lt.x) / 2},${capRy} 0 0 1 ${rt.x},${rt.y}`, wall(rt, rb, 22), 'Z'].join(' ');
    }
    const headOutline: Shape =
      outlineAmp === 0 && bowAmp === 0
        ? { t: 'ellipse', cx: bustCx, cy: headCy, rx: headR, ry: headR, fill: 'none', stroke, opacity }
        : {
            t: 'path',
            d: roughEllipsePath(bustCx, headCy, headR, headR, `${node.id}:${seedSuffix}:head`, outlineAmp, bowAmp),
            fill: 'none',
            stroke,
            opacity,
          };
    return [
      { t: 'path', d: torso, fill: stroke.color, opacity: bodyFill * (opacity === 1 ? 1 : 0.8) },
      { t: 'path', d: torso, fill: 'none', stroke, opacity },
      headOutline,
    ];
  };

  // Back two are smaller and dimmer, side two are drawn first so the centre bust's outline sits
  // cleanly on top of their overlap.
  const shapes: Shape[] = [
    ...bust('left', cx - 19, 9, 15, 6, 0.55),
    ...bust('right', cx + 19, 9, 15, 6, 0.55),
    ...bust('centre', cx, 12, 22, 7, 1),
  ];
  return { shapes, glyphBottom: bottom };
}

/**
 * Third Party: an office building — a tower with a lower wing beside it, windows and a door.
 *
 * A third party is an organisation outside this system's own ownership (a vendor, a partner), and
 * a building is the shorthand every diagramming vocabulary already uses for "a company." It keeps
 * clear of Human's bust and System's monitor, so the three read apart even at a glance.
 */
function thirdPartyGlyph(
  node: DraftNode,
  cx: number,
  stroke: Stroke,
  ctx: DescribeContext,
): { shapes: Shape[]; glyphBottom: number } {
  const bottom = GLYPH_BOTTOM;
  // The tower sits left of centre and the wing right of it, so the pair as a whole is centred.
  const towerW = 30;
  const towerH = GLYPH_SLOT;
  const towerX = cx - 24;
  const towerY = bottom - towerH;
  const wingW = 18;
  const wingH = 24;
  const wingX = towerX + towerW;
  const wingY = bottom - wingH;
  const windowFill = { fill: stroke.color, opacity: 0.55 };
  const win = (x: number, y: number): Shape => ({ t: 'rect', x, y, w: 4, h: 4, r: 0.8, ...windowFill });

  const windows: Shape[] = [];
  for (const row of [0, 1, 2]) {
    for (const col of [0, 1, 2]) {
      windows.push(win(towerX + 6 + col * 7, towerY + 6 + row * 8));
    }
  }
  for (const row of [0, 1]) windows.push(win(wingX + 7, wingY + 5 + row * 8));

  const doorW = 7;
  const doorH = 8;
  return {
    shapes: [
      outlineShape(`${node.id}:actor-glyph-wing`, ctx, { x: wingX, y: wingY, w: wingW, h: wingH, r: 2 }, { fill: 'none', stroke }),
      outlineShape(`${node.id}:actor-glyph`, ctx, { x: towerX, y: towerY, w: towerW, h: towerH, r: 2 }, { fill: 'none', stroke }),
      ...windows,
      {
        t: 'path',
        d: `M${towerX + towerW / 2 - doorW / 2},${bottom} v${-doorH} h${doorW} v${doorH}`,
        fill: 'none',
        stroke,
      },
    ],
    glyphBottom: bottom,
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

  const card = { x: 0.75, y: 0.75, w: node.width - 1.5, h: node.height - 1.5, r: 10 };
  const container = outlineShape(node.id, ctx, card, { fill: palette.fill, stroke });

  // The family's signature: one short bar straddling the top edge, near the left corner. It is
  // the whole Actor family's shared mark — every kind carries it, at the same size and offset, so
  // a row of participants reads as a set even when their glyphs are as different as a bust and a
  // phone. Drawn over the outline rather than inside it, so it reads as part of the edge.
  const barW = Math.min(34, card.w * 0.26);
  const topBar: Shape = {
    t: 'rect',
    x: card.x + 13,
    y: card.y - 1.5,
    w: barW,
    h: 3,
    r: 1.5,
    fill: palette.chip,
  };

  const { shapes: glyphShapes, glyphBottom } =
    kind === 'system'
      ? systemGlyph(node, cx, stroke, ctx)
      : kind === 'device'
        ? deviceGlyph(node, cx, stroke, ctx)
        : kind === 'group'
          ? groupGlyph(node, cx, stroke, ctx)
          : kind === 'thirdParty'
            ? thirdPartyGlyph(node, cx, stroke, ctx)
            : humanGlyph(node, cx, stroke, ctx);

  const shapes: Shape[] = [container, topBar, ...glyphShapes];

  // No on-shape kind caption ("HUMAN"/"SYSTEM"/"DEVICE") — unlike Service/Data Store/Queue, whose
  // silhouette is shared across every sub-kind, Actor's three kinds are already visually distinct
  // by shape; the only text this glyph needs is the participant's own name.
  const text = node.text ?? '';
  if (text.trim()) {
    const top = glyphBottom + GLYPH_LABEL_GAP;
    const maxWidth = Math.max(16, node.width - PADDING);
    const { layout, font } = fitLabel(text, {
      font: FONTS.nodeLabel,
      minFontSize: TEXT_SIZES.nodeLabelMin,
      maxWidth,
      maxHeight: Math.max(0, node.height - top - c4Reserve(node)),
      lineHeightRatio: LINE_HEIGHTS.label,
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: cx,
      y: top,
      layout,
      font,
      fill: palette.text,
      align: 'middle',
      role: 'label',
    });
    const detailTop = top + layout.height + C4_NAME_GAP;
    const detail = c4Detail(node, ctx, maxWidth, node.height - 6 - detailTop);
    if (detail) shapes.push(...detail.place(cx, detailTop, 'middle'));
  }
  return shapes;
}

/* ----------------------------------------------------------------- notes -- */

/**
 * The geometry a note's body text is laid out in — used by `note()` to draw it and by the
 * canvas's inline editor to overlay a textarea on exactly the same rectangle, so the text does not
 * shift by a pixel between reading and editing. One source for both is what keeps them in step.
 */
export interface NoteLayout {
  left: number;
  top: number;
  right: number;
  bottom: number;
  font: FontSpec;
  lineHeight: number;
  /** A plain note is the quiet default — tint, bar and body, nothing else. Question, Warning and
   *  Decision keep their uppercase tag because the word itself is the point. */
  tagShown: boolean;
  tagHeight: number;
}

export function noteLayout(node: Pick<DraftNode, 'noteKind'>): NoteLayout {
  const tagShown = (node.noteKind ?? 'note') !== 'note';
  const tagHeight = FONTS.presetTag.size * LINE_HEIGHTS.label;
  return {
    left: NOTE_BAR_WIDTH + 10,
    top: tagShown ? NOTE_PADDING_TOP + tagHeight + 5 : NOTE_PADDING_TOP,
    right: 10,
    bottom: NOTE_PADDING_BOTTOM,
    font: FONTS.noteBody,
    lineHeight: FONTS.noteBody.size * LINE_HEIGHTS.body,
    tagShown,
    tagHeight,
  };
}

/** How many whole body lines fit in a note of this height. The half-pixel slack absorbs the
 *  floating-point drift of `lines × lineHeight` so a note sized by `naturalNoteHeight` always
 *  shows exactly the lines it was sized for, never one fewer. */
function noteMaxLines(height: number, geo: NoteLayout): number {
  return Math.max(1, Math.floor((height - geo.top - geo.bottom + 0.5) / geo.lineHeight));
}

/**
 * The height a note needs to show all of `text` at `node.width` — at least one line, at most
 * `NOTE_AUTO_MAX_HEIGHT`. The canvas grows a note to this on commit and never shrinks it: a box
 * the user sized by hand stays that way as long as its text still fits, the same rule code cards
 * already follow. (A fresh note starts at `DEFAULTS.noteHeight`, not here.)
 */
export function naturalNoteHeight(
  node: Pick<DraftNode, 'noteKind' | 'width'>,
  text: string,
  ctx: Pick<DescribeContext, 'measurer'>,
): number {
  const geo = noteLayout(node);
  const lines = text.trim()
    ? layoutText(text, {
        font: geo.font,
        maxWidth: Math.max(16, node.width - geo.left - geo.right),
        lineHeight: geo.lineHeight,
        measurer: ctx.measurer,
      }).lines.length
    : 1;
  const needed = Math.ceil(geo.top + lines * geo.lineHeight + geo.bottom);
  return Math.min(NOTE_AUTO_MAX_HEIGHT, needed);
}

function note(node: DraftNode, ctx: DescribeContext): Shape[] {
  const kind = node.noteKind ?? 'note';
  const palette = accentOf(ctx.theme, node.accent ?? NOTE_ACCENTS[kind]);
  const geo = noteLayout(node);
  const shapes: Shape[] = [
    // No drop shadow, deliberately: a note is an annotation sitting flat on the canvas, and the
    // shadow is what says "architecture element" on a service or a data store.
    outlineShape(
      node.id,
      ctx,
      { x: 0.5, y: 0.5, w: node.width - 1, h: node.height - 1, r: 6 },
      // Flat, not the accent gradient the architecture families wear: a note is an annotation
      // sitting on the canvas, and the gradient is part of what says "this is a system element."
      { fill: palette.fill, stroke: { color: palette.line, width: 1 } },
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

  if (geo.tagShown) {
    const tagLayout = layoutText(NOTE_LABELS[kind], {
      font: FONTS.presetTag,
      maxWidth: node.width,
      lineHeight: geo.tagHeight,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: geo.left,
      y: NOTE_PADDING_TOP,
      layout: tagLayout,
      font: FONTS.presetTag,
      fill: palette.chip,
      align: 'start',
    });
  }

  const body = node.text ?? '';
  if (body.trim()) {
    const layout = layoutText(body, {
      font: geo.font,
      maxWidth: Math.max(16, node.width - geo.left - geo.right),
      lineHeight: geo.lineHeight,
      maxLines: noteMaxLines(node.height, geo),
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      x: geo.left,
      y: geo.top,
      layout,
      font: geo.font,
      fill: ctx.theme.text,
      align: 'start',
    });
  }
  return shapes;
}

/**
 * `textRole`'s base look, one `FontSpec` per role — the only place a role maps to a concrete
 * size/weight/stack. `body`/`label` are `FONTS.freeText`/`FONTS.connectorCaption` verbatim (not new
 * specs) so a node that never sets `textRole` — every node saved before this field existed —
 * renders byte-identical to before.
 */
const FONTS_BY_TEXT_ROLE: Record<TextRole, FontSpec> = {
  body: FONTS.freeText,
  label: FONTS.connectorCaption,
  heading: FONTS.freeTextHeading,
  title: FONTS.freeTextTitle,
  technical: FONTS.freeTextTechnical,
};

/**
 * A Text node's effective semantic role: an explicit `textRole` always wins; otherwise the legacy
 * `annotation` flag (still the only thing `src/starters/catalog.ts` ever sets) maps to `'label'`,
 * its one existing look. Absent of both is `'body'`. Shared by the renderer, the inline editor's
 * own CSS (`DraftNodeView.tsx`'s `editorStyle`), and the popover's role picker, so the three can
 * never disagree about what a node currently is.
 */
export function effectiveTextRole(node: Pick<DraftNode, 'textRole' | 'annotation'>): TextRole {
  return node.textRole ?? (node.annotation ? 'label' : 'body');
}

const TEXT_ALIGN_ANCHOR: Record<TextAlign, 'start' | 'middle' | 'end'> = {
  left: 'start',
  center: 'middle',
  right: 'end',
};

/**
 * The concrete `FontSpec` a Text node renders/measures/edits with: its role's base font, with
 * `textBold` forcing the heaviest weight and `textItalic` adding the style — independent toggles,
 * combinable with any role. Shared by `freeText` (the SVG renderer), `naturalTextHeight` (auto-grow
 * measurement), and `DraftNodeView.tsx`'s `editorStyle` (the live textarea overlay), so all three
 * can never disagree about what a styled Text node looks like. Byte-identical to the role's own
 * `FontSpec` object — not just equal, the same reference — whenever neither toggle is set, so a
 * node saved before these fields existed never picks up a stray `italic: false` key.
 */
export function fontForTextNode(
  node: Pick<DraftNode, 'textRole' | 'annotation' | 'textBold' | 'textItalic'>,
): FontSpec {
  const baseFont = FONTS_BY_TEXT_ROLE[effectiveTextRole(node)];
  return node.textBold || node.textItalic
    ? {
        ...baseFont,
        weight: node.textBold ? 700 : baseFont.weight,
        ...(node.textItalic ? { italic: true as const } : {}),
      }
    : baseFont;
}

/**
 * Blank text used to render nothing at all — an empty Text node was a real, selectable, saved
 * document entry with zero shapes, i.e. permanently invisible the moment it was deselected. A
 * quiet dashed outline instead means there is never an invisible canvas object: it flows through
 * this same display-list pipeline, so it's visible whether selected, exported, or dimmed by
 * Focus/Presentation, with no special-casing anywhere else. Deliberately a plain rect, not run
 * through `outlineShape`'s personality jitter — an "this is empty" affordance should read as quiet
 * chrome, not hand-drawn noise, in every personality mode.
 */
function emptyTextPlaceholder(node: DraftNode, ctx: DescribeContext): Shape[] {
  if (node.width < 2 || node.height < 2) return [];
  return [
    {
      t: 'rect',
      x: 0.5,
      y: 0.5,
      w: node.width - 1,
      h: node.height - 1,
      r: 4,
      stroke: { color: ctx.theme.border, width: 1, dash: [4, 4] },
    },
  ];
}

function freeText(node: DraftNode, ctx: DescribeContext): Shape[] {
  const body = node.text ?? '';
  if (!body.trim()) return emptyTextPlaceholder(node, ctx);
  const role = effectiveTextRole(node);
  const font = fontForTextNode(node);
  const palette = accentOf(ctx.theme, node.accent);
  const lineHeight = font.size * LINE_HEIGHTS.body;
  const layout = layoutText(body, {
    font,
    maxWidth: Math.max(16, node.width),
    lineHeight,
    maxLines: Math.max(1, Math.floor(node.height / lineHeight)),
    measurer: ctx.measurer,
  });
  const fill = role === 'label'
    ? ctx.theme.textFaint
    : node.accent && node.accent !== 'neutral'
      ? palette.chip
      : ctx.theme.text;
  const align = TEXT_ALIGN_ANCHOR[node.textAlign ?? 'left'];
  const x = align === 'middle' ? node.width / 2 : align === 'end' ? node.width : 0;
  return [
    {
      t: 'text',
      x,
      y: 0,
      layout,
      font,
      fill,
      align,
    },
  ];
}

/** Where a Text node stops growing on its own as its text gets longer — same idea as
 *  `NOTE_AUTO_MAX_HEIGHT`, independent constant since Text has no header/padding chrome eating
 *  into it. */
export const TEXT_AUTO_MAX_HEIGHT = 400;

/**
 * The height a Text node needs to show all of `text` at its current width, role and emphasis — at
 * least one line, at most `TEXT_AUTO_MAX_HEIGHT`. Mirrors `naturalNoteHeight`'s grow-only contract:
 * the canvas grows a Text box to this on commit and never shrinks it. Role/bold matter here, not
 * just width, because a heavier or larger font wraps at a different point than the body default.
 */
export function naturalTextHeight(
  node: Pick<DraftNode, 'width' | 'textRole' | 'annotation' | 'textBold' | 'textItalic'>,
  text: string,
  ctx: Pick<DescribeContext, 'measurer'>,
): number {
  const font = fontForTextNode(node);
  const lineHeight = font.size * LINE_HEIGHTS.body;
  const lines = text.trim()
    ? layoutText(text, {
        font,
        maxWidth: Math.max(16, node.width),
        lineHeight,
        measurer: ctx.measurer,
      }).lines.length
    : 1;
  const needed = Math.ceil(lines * lineHeight);
  return Math.min(TEXT_AUTO_MAX_HEIGHT, needed);
}

/** A boundary is explicitly meant to feel stronger than an ordinary node — "someone drawing a
 *  large boundary around several services... someone just circled this part" — so it boosts its
 *  own bow/outline over the plain per-node profile value, rather than reading identically to the
 *  services it contains. Clean stays 1 (no-op) so this never changes byte-identical output. */
const BOUNDARY_BOOST: Record<PersonalityPreset, number> = { clean: 1, draft: 1.4, sketch: 1.7 };

/**
 * The boundary header, laid out on one grid so every kind lines up with every other:
 *
 * - The row is `BOUNDARY_HEADER_HEIGHT` tall, measured from the outline's top edge (y 1); the
 *   Domain tab and the Deployment rule both end exactly there.
 * - The marker plate is centred in the row with the *same* gap above and to its left, and its
 *   corner radius is the outline's minus that gap — concentric with the boundary's own corner, so
 *   the plate reads as set into it rather than dropped near it.
 * - Every line of text is centred on the row by its cap height, so a title, a lone kind caption
 *   and the plate's glyph all share one optical centre line whatever is or isn't there.
 */
const BOUNDARY_RADIUS = 12;
const BOUNDARY_HEADER_HEIGHT = 32;
const BOUNDARY_ROW_MID = 1 + BOUNDARY_HEADER_HEIGHT / 2;
const BOUNDARY_PLATE = 20;
const BOUNDARY_PLATE_GAP = (BOUNDARY_HEADER_HEIGHT - BOUNDARY_PLATE) / 2;
const BOUNDARY_MARKER = 12;
/** Left inset of a header that starts with text; also the tab's padding on either side of it. */
const BOUNDARY_INSET_X = 12;
const BOUNDARY_TEXT_GAP = 8;
/** Cap height as a fraction of font size, for the system UI sans every export uses. */
const CAP_HEIGHT = 0.71;
/** Cubic control distance for a quarter circle, as a fraction of the radius. */
const KAPPA = 0.5523;

/** The outline's rounded top-left corner as a path start, so a tab or band fills it exactly. */
function topLeftCorner(): string {
  const k = 1 + BOUNDARY_RADIUS * (1 - KAPPA);
  return `M1 ${1 + BOUNDARY_RADIUS} C1 ${k} ${k} 1 ${1 + BOUNDARY_RADIUS} 1`;
}

function group(node: DraftNode, ctx: DescribeContext): Shape[] {
  const palette = accentOf(ctx.theme, node.accent);
  const style = BOUNDARY_STYLES[node.boundaryPreset ?? 'boundary'];
  const profile = PERSONALITY_PROFILES[ctx.preset];
  const boost = BOUNDARY_BOOST[ctx.preset];
  const rect = { x: 1, y: 1, w: node.width - 2, h: node.height - 2, r: BOUNDARY_RADIUS };
  const stroke: Stroke = {
    color: boundaryLine(ctx.theme, node.accent),
    width: style.width,
    dash: style.dash,
    // A near-zero dash is a dot, and a dot needs a round cap to exist at all.
    linecap: style.dash?.some((d) => d < 1) ? 'round' : undefined,
  };
  // Fill and outline are two shapes, deliberately. They used to be one element carrying
  // `opacity: 0.35` for the sake of a barely-there fill — which faded the outline, and with it
  // the user's chosen colour, to a third of its strength. The fill stays faint; the line doesn't.
  const shapes: Shape[] = [
    outlineShape(node.id, ctx, rect, {
      fill: node.accent && node.accent !== 'neutral' ? palette.fill : ctx.theme.surface,
      opacity: node.accent && node.accent !== 'neutral' ? 0.55 : 0.3,
    }, boost),
    outlineShape(node.id, ctx, rect, { fill: 'none', stroke, opacity: style.strokeOpacity }, boost),
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

  shapes.push(...boundaryHeader(node, ctx, style, palette));
  return shapes;
}

/**
 * One header row for every kind: [marker] Title  CAPTION. The title is the user's and always wins
 * the width — the kind caption only appears when it fits whole after it, and is dropped before the
 * title is ever shortened for it. The kind is never folded into the node's own `text`: a Domain
 * boundary named "Payments" still reads "Payments", not "Domain: Payments".
 */
/** Where a boundary's title starts: after its kind mark when it has one. The rename editor sits there
 *  even while the title is empty and no label shape exists to read it from. */
export function boundaryTitleX(node: DraftNode): number {
  return BOUNDARY_STYLES[node.boundaryPreset ?? 'boundary'].marker ? 1 + BOUNDARY_PLATE_GAP + BOUNDARY_PLATE + BOUNDARY_TEXT_GAP : BOUNDARY_INSET_X;
}

function boundaryHeader(node: DraftNode, ctx: DescribeContext, style: BoundaryStyle, palette: AccentPalette): Shape[] {
  const shapes: Shape[] = [];
  const bottom = 1 + BOUNDARY_HEADER_HEIGHT;
  // A tab holds its text with the same padding on both sides, and never reaches the far corner.
  const right = style.header === 'tab' ? node.width - 1 - BOUNDARY_RADIUS - BOUNDARY_INSET_X : node.width - BOUNDARY_INSET_X;

  const x = boundaryTitleX(node);
  if (style.marker) {
    // The glyph sits on a small plate tinted with the boundary's own colour — a stamped kind mark
    // rather than an icon floating in the corner, and the first place a recolour shows.
    const plate = 1 + BOUNDARY_PLATE_GAP;
    shapes.push({
      t: 'rect',
      x: plate,
      y: plate,
      w: BOUNDARY_PLATE,
      h: BOUNDARY_PLATE,
      r: BOUNDARY_RADIUS - BOUNDARY_PLATE_GAP,
      fill: palette.chip,
      opacity: ctx.theme.name === 'dark' ? 0.18 : 0.13,
    });
    const inset = (BOUNDARY_PLATE - BOUNDARY_MARKER) / 2;
    shapes.push(boundaryMarker(style.marker, plate + inset, plate + inset, palette.chip));
  }

  const title = (node.text ?? '').trim() ? (node.text ?? '') : '';
  // Shrinks (one step) but never wraps: the title sits above whatever children the boundary
  // contains, positioned independently of it, so a second line risks colliding with them —
  // unlike every other label here, a Boundary title stays single-line by design.
  const fitted = title
    ? fitLabel(title, {
        font: FONTS.groupTitle,
        minFontSize: TEXT_SIZES.groupTitleMin,
        maxWidth: Math.max(16, right - x),
        maxHeight: Math.max(0, node.height - 1),
        lineHeightRatio: LINE_HEIGHTS.label,
        maxLines: 1,
        measurer: ctx.measurer,
      })
    : null;
  const titleEnd = fitted ? x + fitted.layout.width : x;
  const captionX = fitted ? titleEnd + BOUNDARY_TEXT_GAP : x;

  let caption: TextLayout | null = null;
  if (style.caption) {
    const measured = layoutText(style.caption, {
      font: FONTS.presetTag,
      maxWidth: Number.POSITIVE_INFINITY,
      lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    if (!fitted?.layout.truncated && captionX + measured.width <= right) caption = measured;
  }
  const headerEnd = caption ? captionX + caption.width : titleEnd;

  if (style.header === 'tab') {
    // A corner tab cut from the boundary's own top-left corner: it shares the outline's top and
    // left edges, so only its right and bottom edges are drawn. Sized to what it holds, with the
    // same padding after the text as before it.
    const tabRight = Math.min(node.width - 1 - BOUNDARY_RADIUS, Math.max(headerEnd, BOUNDARY_INSET_X + 24) + BOUNDARY_INSET_X);
    const r = BOUNDARY_RADIUS - BOUNDARY_PLATE_GAP;
    // M/L/Q/C only — the command set `roughenPath` understands — so the edge wobbles with the
    // outline at Draft and Sketch instead of being dropped.
    const edge = `M${tabRight} 1 L${tabRight} ${bottom - r} Q${tabRight} ${bottom} ${tabRight - r} ${bottom} L1 ${bottom}`;
    shapes.push({
      t: 'path',
      d: `${topLeftCorner()} L${tabRight} 1 L${tabRight} ${bottom - r} Q${tabRight} ${bottom} ${tabRight - r} ${bottom} L1 ${bottom} Z`,
      fill: palette.chip,
      opacity: ctx.theme.name === 'dark' ? 0.16 : 0.1,
    });
    shapes.push({
      t: 'path',
      d: roughOutline(edge, `${node.id}:tab`, ctx),
      fill: 'none',
      stroke: { color: palette.chip, width: 1 },
      opacity: 0.75,
    });
  } else if (style.header === 'band') {
    // A label plate ruled off from the contents across the full width — faint tint above, one
    // hairline under — so the runtime scope reads as infrastructure without a heavy panel.
    const w = node.width;
    const k = BOUNDARY_RADIUS * (1 - KAPPA);
    shapes.push({
      t: 'path',
      d: `${topLeftCorner()} L${w - 1 - BOUNDARY_RADIUS} 1 C${w - 1 - k} 1 ${w - 1} ${1 + k} ${w - 1} ${1 + BOUNDARY_RADIUS} L${w - 1} ${bottom} L1 ${bottom} Z`,
      fill: palette.chip,
      opacity: ctx.theme.name === 'dark' ? 0.08 : 0.06,
    });
    shapes.push({
      t: 'path',
      d: roughOutline(`M1 ${bottom} L${w - 1} ${bottom}`, `${node.id}:rule`, ctx),
      fill: 'none',
      stroke: { color: palette.chip, width: 1 },
      opacity: 0.6,
    });
  }

  // One baseline for the row: the title's, cap-centred on the row — or, with no title, the
  // caption's own — so the caption never drifts toward the border and the pair reads as one line.
  const baseline = BOUNDARY_ROW_MID + (CAP_HEIGHT * (fitted ? fitted.font.size : FONTS.presetTag.size)) / 2;
  if (fitted) {
    shapes.push({
      t: 'text',
      x,
      y: baseline - baselineOf(fitted.layout, 0),
      layout: fitted.layout,
      font: fitted.font,
      fill: style.quietTitle ? ctx.theme.textMuted : ctx.theme.text,
      align: 'start',
      role: 'label',
    });
  }
  if (caption) {
    shapes.push({
      t: 'text',
      x: captionX,
      y: baseline - baselineOf(caption, 0),
      layout: caption,
      font: FONTS.presetTag,
      fill: ctx.theme.textFaint,
      align: 'start',
    });
  }
  return shapes;
}

/**
 * The small kind marker at the head of a boundary's header — 12 units square, drawn in the
 * accent's chip colour (the same colour the swatch shows), so a recolour is visible here first.
 * Literal and generic on purpose: a window for a system, a connected trio for a network, a
 * deployable unit for a runtime scope. None implies more than the kind itself says — no lock or
 * shield on a network, no server rack on a deployment.
 */
function boundaryMarker(marker: NonNullable<BoundaryStyle['marker']>, x: number, y: number, color: string): Shape {
  const s: Stroke = { color, width: 1.25, linecap: 'round' };
  const at = (px: number, py: number) => `${x + px} ${y + py}`;
  switch (marker) {
    case 'system':
      return {
        t: 'group',
        children: [
          { t: 'rect', x: x + 0.75, y: y + 1.25, w: 10.5, h: 9.5, r: 2, fill: 'none', stroke: s },
          { t: 'path', d: `M${at(0.75, 4.5)} H${x + 11.25}`, fill: 'none', stroke: s },
        ],
      };
    case 'network':
      return {
        t: 'group',
        children: [
          { t: 'path', d: `M${at(6, 2.5)} L${at(2, 9.5)} H${x + 10} Z`, fill: 'none', stroke: { ...s, width: 1 } },
          { t: 'ellipse', cx: x + 6, cy: y + 2.5, rx: 2, ry: 2, fill: color },
          { t: 'ellipse', cx: x + 2, cy: y + 9.5, rx: 2, ry: 2, fill: color },
          { t: 'ellipse', cx: x + 10, cy: y + 9.5, rx: 2, ry: 2, fill: color },
        ],
      };
    case 'deployment':
      return {
        t: 'path',
        d: `M${at(6, 0.75)} L${at(11.25, 3.5)} V${y + 8.75} L${at(6, 11.5)} L${at(0.75, 8.75)} V${y + 3.5} Z M${at(0.75, 3.5)} L${at(6, 6.25)} L${at(11.25, 3.5)} M${at(6, 6.25)} V${y + 11.5}`,
        fill: 'none',
        stroke: s,
      };
  }
}

/* ------------------------------------------------------------ code cards -- */

function codeMetrics(ctx: DescribeContext) {
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
    width: clamp(longest * metrics.charWidth + CODE_PADDING_X * 2 + 8, 260, 680),
    height: clamp(CODE_HEADER_HEIGHT + CODE_PADDING_Y * 2 + Math.min(lines.length, 40) * metrics.lineHeight, 110, 520),
  };
}

/**
 * The box an architecture shape needs for its name and C4 detail to show in full, starting from its
 * current size and only ever growing — the size an arranged diagram gives it, so nothing it was
 * told arrives with an ellipsis.
 *
 * Asks the renderer itself rather than restating each kind's insets (a cube glyph, a tag row, a
 * notch, a Data Store glyph that scales with its box): `describeNode` is the one authority on
 * where text goes, and a second copy of that geometry would drift from it. Width grows first, to at
 * most `maxWidth`, until the name sits at its full size in two lines or fewer; height then grows
 * until the detail fits. `fits` is false when even the largest box truncates something — the
 * caller reports that rather than accepting a clipped label silently.
 */
export function naturalArchitectureSize(
  node: DraftNode,
  ctx: DescribeContext,
  bounds: { maxWidth: number; maxHeight: number } = { maxWidth: 280, maxHeight: 320 },
): { width: number; height: number; fits: boolean } {
  const verdict = (width: number, height: number) => captionVerdict(describeNode({ ...node, width, height }, ctx).shapes, node);
  const start = verdict(node.width, node.height);
  if (start.fits) return { width: node.width, height: node.height, fits: true };

  // For each width (growing in steps), the least height at which everything shows — by bisection,
  // since more height never shows less. The first width whose shape comes out no taller than it is
  // wide wins; failing that, the one needing the least height. A one-line part (a long technology)
  // can only be helped by width, which is why width is searched and not just grown for the name.
  const WIDTH_STEP = 20;
  const minHeightAt = (width: number): number | undefined => {
    if (!verdict(width, bounds.maxHeight).fits) return undefined;
    let low = node.height;
    let high = bounds.maxHeight;
    if (verdict(width, low).fits) return low;
    while (high - low > 2) {
      const mid = Math.floor((low + high) / 2);
      if (verdict(width, mid).fits) high = mid;
      else low = mid;
    }
    return high;
  };
  // A Data Store's glyph grows with the smaller of its box's two growths (`dataStoreScale`), so a box
  // grown both ways draws a giant glyph: for one, the shortest box that fits wins outright.
  const shortest = node.type === 'database';
  let best: { width: number; height: number } | undefined;
  for (let width = node.width; ; width = Math.min(bounds.maxWidth, width + WIDTH_STEP)) {
    const height = minHeightAt(width);
    if (height !== undefined) {
      if (!shortest && height <= Math.max(node.height, width)) return { width, height, fits: true };
      if (!best || height < best.height) best = { width, height };
    }
    if (width >= bounds.maxWidth) break;
  }
  return best ? { ...best, fits: true } : { width: bounds.maxWidth, height: bounds.maxHeight, fits: false };
}

/** Whether every text in a shape's display list shows in full — the C4 detail drawn at all, not just
 *  not cut short, since a part with no room is left out rather than ellipsised — and whether the name
 *  shows at its own full size in at most two lines. */
function captionVerdict(shapes: Shape[], node: DraftNode): { fits: boolean; nameComfortable: boolean } {
  let fits = true;
  let nameComfortable = true;
  let technology = !node.technology;
  let description = !node.description;
  const visit = (shape: Shape) => {
    if (shape.t === 'group') {
      shape.children.forEach(visit);
      return;
    }
    if (shape.t !== 'text') return;
    if (shape.layout.truncated) fits = false;
    if (shape.font === FONTS.nodeTechnology) technology = true;
    if (shape.font === FONTS.nodeDescription) description = true;
    if (shape.role === 'label') {
      if (shape.layout.truncated || shape.font.size < TEXT_SIZES.nodeLabel || shape.layout.lines.length > 2) {
        nameComfortable = false;
      }
    }
  };
  shapes.forEach(visit);
  return { fits: fits && nameComfortable && technology && description, nameComfortable };
}

export const CODE_LAYOUT = {
  headerHeight: CODE_HEADER_HEIGHT,
  paddingX: CODE_PADDING_X,
  paddingY: CODE_PADDING_Y,
} as const;
