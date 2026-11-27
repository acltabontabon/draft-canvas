import { isRecord } from '../lib/isRecord';
import { isGlyphComponentKind, isGlyphServiceKind } from './dataStoreGeometry';
import { isFiniteNumber } from '../lib/math';
import { cleanText } from './sanitize';
import {
  ACCENTS,
  ACTOR_KINDS,
  ARTIFACT_KINDS,
  BOUNDARY_PRESETS,
  COMPONENT_KINDS,
  DATABASE_KINDS,
  NODE_TYPES,
  NOTE_KINDS,
  QUEUE_KINDS,
  SERVICE_KINDS,
  TEXT_ROLES,
  type Accent,
  type DraftNode,
  type DraftNodeType,
} from './types';
import { oneOfOptional } from './validationValues';

/**
 * How a diagram is drawn, as data. This module is the file model's side of it: names, shapes and
 * the checks that make an untrusted style safe to keep. `render/style/resolve.ts` turns it into
 * what the renderers read.
 *
 * There is no typeface here, on purpose. A typeface changes how wide words are, and with that how
 * big a shape must be to hold its name; a style may never change a shape's size.
 *
 * A style restyles how a shape looks, never what it is: every key here is a shape type or one of
 * its kinds, and nothing in a style can change a shape's size, where a connector attaches, or what
 * the diagram means.
 */

/** The built-in drawing hands. Clean is today's exact appearance, byte-for-byte unchanged. */
export const HAND_PRESETS = ['clean', 'draft', 'sketch'] as const;
export type HandPreset = (typeof HAND_PRESETS)[number];

export const STYLE_WOBBLES = ['calm', 'lively'] as const;
export type StyleWobble = (typeof STYLE_WOBBLES)[number];

/** How heavy an outline is drawn. `regular` is the built-in weight. */
export const STYLE_WEIGHTS = ['fine', 'regular', 'bold'] as const;
export type StyleWeight = (typeof STYLE_WEIGHTS)[number];

/** How round a box's corners are. `soft` is the built-in rounding. */
export const STYLE_CORNERS = ['sharp', 'soft', 'round'] as const;
export type StyleCorners = (typeof STYLE_CORNERS)[number];

/** An arrowhead's shape. Both fit the same box, so a route never depends on the choice. */
export const STYLE_HEADS = ['nib', 'triangle'] as const;
export type StyleHead = (typeof STYLE_HEADS)[number];

/** What colours a connector nobody has coloured: its source shape's (`source`) or the plain line colour. */
export const STYLE_EDGE_COLOURS = ['source', 'plain'] as const;
export type StyleEdgeColour = (typeof STYLE_EDGE_COLOURS)[number];

export const STYLE_FITS = ['contain', 'stretch'] as const;
export type StyleFit = (typeof STYLE_FITS)[number];

/** How strongly the canvas's backdrop is drawn. `regular` is as its drawing was made. */
export const BACKDROP_STRENGTHS = ['faint', 'regular', 'strong'] as const;
export type BackdropStrength = (typeof BACKDROP_STRENGTHS)[number];

/** How large one tile of the backdrop is. `regular` is a unit of the drawing to a canvas pixel. */
export const BACKDROP_SCALES = ['small', 'regular', 'large'] as const;
export type BackdropScale = (typeof BACKDROP_SCALES)[number];

export const ACCENT_ROLES = ['fill', 'line', 'text', 'chip'] as const;
export type AccentRole = (typeof ACCENT_ROLES)[number];

export const STYLE_LIMITS = {
  maxNameLength: 60,
  /** Drawings in one style. Every shape kind that can take one is 35; this leaves room to vary. */
  maxAssets: 64,
  /** Path data in one drawing, in characters. */
  maxAssetChars: 8_192,
  maxAssetPaths: 48,
  /** Drawing commands in one drawing, across its paths. */
  maxAssetCommands: 3_000,
  /** Path data across every drawing in a style: what a file, and a collaborator's copy, can carry. */
  maxAssetsChars: 262_144,
  /** A drawing's own width and height, in its own units. */
  maxArtUnits: 1_000,
  /** How far outside its own box a drawing's coordinates may reach. */
  minArtCoordinate: -1_000,
  maxArtCoordinate: 2_000,
  maxArtStrokeWidth: 64,
} as const;

export interface SurfaceStyle {
  weight?: StyleWeight;
  corners?: StyleCorners;
  shadow?: boolean;
}

/** How far a shape's shadow lifts it. `soft` is the built-in shadow, barely there by design. */
export const STYLE_DEPTHS = ['soft', 'deep'] as const;
export type StyleDepth = (typeof STYLE_DEPTHS)[number];

/** What every shape shares. The shadow's depth is said once, here: a diagram has one light. */
export interface GeneralStyle extends SurfaceStyle {
  depth?: StyleDepth;
}

export interface ShapeStyle extends SurfaceStyle {
  /** The id of a drawing in `DocumentStyle.assets` that stands in for the built-in one. */
  art?: string;
  fit?: StyleFit;
  /** "Keep the built-in drawing", said out loud: it stops a drawing set on the whole type from
   *  reaching this kind. */
  builtin?: true;
}

export interface ConnectorStyle {
  weight?: StyleWeight;
  head?: StyleHead;
  colour?: StyleEdgeColour;
}

/**
 * What is drawn on the canvas behind the diagram: one drawing, repeated edge to edge. It is paint
 * and nothing else: no shape is placed, sized or routed by it, and it is never selected.
 */
export interface StyleBackdrop {
  /** The id of a drawing in `DocumentStyle.assets`: one tile. */
  art: string;
  strength?: BackdropStrength;
  scale?: BackdropScale;
}

export type AccentColours = Record<AccentRole, string>;

/** The canvas's own colours in one theme. Each is `#rrggbb`; whatever is absent keeps the built-in. */
export interface StyleScheme {
  canvas?: string;
  grid?: string;
  text?: string;
  textMuted?: string;
  edge?: string;
  edgeText?: string;
  edgeLabelBg?: string;
  codeBg?: string;
  codeBorder?: string;
  /** The one colour that marks what is chosen and what to press: a brand's own, say. */
  selection?: string;
  accents?: Partial<Record<Accent, AccentColours>>;
}

export const SCHEME_COLOURS = ['canvas', 'grid', 'text', 'textMuted', 'edge', 'edgeText', 'edgeLabelBg', 'codeBg', 'codeBorder'] as const satisfies readonly (keyof StyleScheme)[];

/**
 * What paints one path of a drawing: a role of the shape's own colour (so the drawing follows a
 * recolour and the theme), a role of a named colour, or a literal colour that never changes.
 */
export type ArtPaint = AccentRole | 'canvas' | `${Accent}:${AccentRole}` | `#${string}`;

export interface ArtPath {
  /** Absolute `M`, `L`, `C` and `Z` only, numbers to two decimals: nothing else is ever stored. */
  d: string;
  fill?: ArtPaint;
  stroke?: ArtPaint;
  /** Stroke width, in the drawing's own units. */
  sw?: number;
  /** Opacity, 0 to 1. */
  o?: number;
  rule?: 'evenodd';
}

/** One drawing, held as inert geometry: no markup, no references, no text. */
export interface StyleAsset {
  id: string;
  w: number;
  h: number;
  paths: ArtPath[];
}

export interface DocumentStyle {
  v: 1;
  /** What the person called it. For display only: nothing ever looks a style up by name. */
  name?: string;
  hand: { base: HandPreset; wobble?: StyleWobble; retrace?: boolean };
  general?: GeneralStyle;
  /**
   * The canvas's colours. With both, the diagram follows the device's light or dark setting; with
   * one, it is always drawn in that one; with neither, it keeps the built-in colours.
   */
  schemes?: { light?: StyleScheme; dark?: StyleScheme };
  /** Per shape, by `STYLE_SHAPE_KEYS`: `service`, or `service:gateway` for one kind of it. */
  shapes?: Record<string, ShapeStyle>;
  connectors?: ConnectorStyle;
  backdrop?: StyleBackdrop;
  assets?: StyleAsset[];
}

/* ----------------------------------------------------------------- shapes -- */

/**
 * The kinds of each shape type. The first is what a shape with no kind of its own is drawn as.
 * Keyed by every type, so a new shape type does not compile until it is listed here.
 */
export const STYLE_KINDS: Record<DraftNodeType, readonly string[]> = {
  ellipse: [],
  text: TEXT_ROLES,
  note: NOTE_KINDS,
  code: [],
  group: BOUNDARY_PRESETS,
  service: SERVICE_KINDS,
  database: DATABASE_KINDS,
  queue: QUEUE_KINDS,
  actor: ACTOR_KINDS,
  component: COMPONENT_KINDS,
  sequence: [],
  artifact: ARTIFACT_KINDS,
};

export const shapeKey = (type: DraftNodeType, kind?: string): string => (kind === undefined ? type : `${type}:${kind}`);

/** Every key a style may give a look to: each type, then each of its kinds. */
export const STYLE_SHAPE_KEYS: readonly string[] = NODE_TYPES.flatMap((type) => [type, ...STYLE_KINDS[type].map((kind) => shapeKey(type, kind))]);

const SHAPE_KEYS = new Set(STYLE_SHAPE_KEYS);

/** The field each shape type keeps its kind in. A type with no kinds has none. */
export const KIND_FIELDS = {
  service: 'serviceKind',
  database: 'databaseKind',
  queue: 'queueKind',
  actor: 'actorKind',
  component: 'componentKind',
  artifact: 'artifactKind',
  group: 'boundaryPreset',
  note: 'noteKind',
  text: 'textRole',
} as const satisfies Partial<Record<DraftNodeType, keyof DraftNode>>;

type KindFields = Pick<
  DraftNode,
  'type' | 'serviceKind' | 'databaseKind' | 'queueKind' | 'actorKind' | 'componentKind' | 'artifactKind' | 'boundaryPreset' | 'noteKind' | 'textRole' | 'annotation'
>;

/** The kind a shape is drawn as, within its own type. `undefined` for a type with no kinds. */
export function shapeKindOf(node: KindFields): string | undefined {
  switch (node.type) {
    case 'service':
      return node.serviceKind ?? 'generic';
    case 'database':
      return node.databaseKind ?? 'generic';
    case 'queue':
      return node.queueKind ?? 'queue';
    case 'actor':
      return node.actorKind ?? 'human';
    case 'component':
      return node.componentKind ?? 'generic';
    case 'artifact':
      return node.artifactKind ?? 'file';
    case 'group':
      return node.boundaryPreset ?? 'boundary';
    case 'note':
      return node.noteKind ?? 'note';
    case 'text':
      return node.textRole ?? (node.annotation ? 'label' : 'body');
    default:
      return undefined;
  }
}

/**
 * Where a drawing goes on a shape. A `glyph` shape is a picture with its name beneath, and the
 * drawing replaces the picture. A `body` shape is a box with its name inside, and the drawing
 * replaces the box. Text, notes, code, sequences and boundaries hold their own content and take
 * no drawing at all, and neither does External: its dashed outline is what says the system is
 * outside ours, and a drawing in place of the box would take that away.
 */
export type ArtSlot = 'glyph' | 'body';

export function artSlotOf(type: DraftNodeType, kind: string | undefined): ArtSlot | null {
  switch (type) {
    case 'database':
    case 'artifact':
    case 'actor':
      return 'glyph';
    case 'service':
      if (kind === 'external') return null;
      return isGlyphServiceKind(kind) ? 'glyph' : 'body';
    case 'component':
      return isGlyphComponentKind(kind) ? 'glyph' : 'body';
    case 'queue':
    case 'ellipse':
      return 'body';
    default:
      return null;
  }
}

/**
 * Drawings a style keeps for a shape this app no longer draws one on. External was a glyph before
 * document format 33, and a style made then (every gallery pack among them) draws one. The app
 * that still draws it as a glyph reads the same file, gallery packs included, so its drawing is
 * kept, unread here, rather than lost when a style is opened and saved again.
 */
const KEPT_UNDRAWN: ReadonlySet<string> = new Set(['service:external']);

function keyTakesArt(key: string): boolean {
  const [type, kind] = key.split(':') as [DraftNodeType, string | undefined];
  return artSlotOf(type, kind) !== null || KEPT_UNDRAWN.has(key);
}

/* ------------------------------------------------------------- validation -- */

const HEX = /^#[0-9a-f]{6}$/;
const ASSET_ID = /^a[0-9a-z]{8,16}$/;
const NUMBER = /^-?\d{1,4}(?:\.\d{1,2})?$/;
const ARITY: Record<string, number> = { M: 2, L: 2, C: 6, Z: 0 };

function colour(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return HEX.test(lower) ? lower : undefined;
}

const ACCENT_PAINTS = new Set<string>(ACCENTS.flatMap((accent) => ACCENT_ROLES.map((role) => `${accent}:${role}`)));

function paint(value: unknown): ArtPaint | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'canvas' || (ACCENT_ROLES as readonly string[]).includes(value) || ACCENT_PAINTS.has(value)) return value as ArtPaint;
  return colour(value) as ArtPaint | undefined;
}

/**
 * How many drawing commands `d` holds, or `null` when it is anything but the stored form: absolute
 * `M`, `L`, `C` and `Z`, each with exactly its numbers, every number short and inside the drawing's
 * reach. Checked character by character because this is the one string in a style that is drawn.
 */
export function pathCommands(d: string): number | null {
  if (d.length === 0 || d[0] !== 'M') return null;
  let commands = 0;
  let at = 0;
  while (at < d.length) {
    const arity = ARITY[d[at]!];
    if (arity === undefined) return null;
    let end = at + 1;
    while (end < d.length && ARITY[d[end]!] === undefined) end += 1;
    const body = d.slice(at + 1, end);
    if (arity === 0) {
      if (body !== '') return null;
    } else {
      const numbers = body.split(' ');
      if (numbers.length !== arity) return null;
      for (const entry of numbers) {
        if (!NUMBER.test(entry)) return null;
        const value = Number(entry);
        if (value < STYLE_LIMITS.minArtCoordinate || value > STYLE_LIMITS.maxArtCoordinate) return null;
      }
    }
    commands += 1;
    at = end;
  }
  return commands;
}

function bounded(value: unknown, min: number, max: number): number | undefined {
  return isFiniteNumber(value) && value >= min && value <= max ? Math.round(value * 100) / 100 : undefined;
}

/** One drawing, checked. `null` when any part of it is not the stored form: a drawing is kept whole or not at all. */
export function normalizeAsset(raw: unknown): StyleAsset | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ASSET_ID.test(raw.id)) return null;
  const w = bounded(raw.w, 1, STYLE_LIMITS.maxArtUnits);
  const h = bounded(raw.h, 1, STYLE_LIMITS.maxArtUnits);
  if (w === undefined || h === undefined || !Array.isArray(raw.paths)) return null;
  if (raw.paths.length === 0 || raw.paths.length > STYLE_LIMITS.maxAssetPaths) return null;
  const paths: ArtPath[] = [];
  let chars = 0;
  let commands = 0;
  for (const candidate of raw.paths) {
    if (!isRecord(candidate) || typeof candidate.d !== 'string') return null;
    chars += candidate.d.length;
    if (chars > STYLE_LIMITS.maxAssetChars) return null;
    const count = pathCommands(candidate.d);
    if (count === null) return null;
    commands += count;
    if (commands > STYLE_LIMITS.maxAssetCommands) return null;
    const fill = paint(candidate.fill);
    const stroke = paint(candidate.stroke);
    // A path that paints nothing is not a smaller drawing, it is a mistake somewhere upstream.
    if (!fill && !stroke) return null;
    const path: ArtPath = { d: candidate.d };
    if (fill) path.fill = fill;
    if (stroke) {
      path.stroke = stroke;
      path.sw = bounded(candidate.sw, 0.1, STYLE_LIMITS.maxArtStrokeWidth) ?? 1.5;
    }
    const opacity = bounded(candidate.o, 0, 1);
    if (opacity !== undefined && opacity < 1) path.o = opacity;
    if (candidate.rule === 'evenodd') path.rule = 'evenodd';
    paths.push(path);
  }
  return { id: raw.id, w, h, paths };
}

function surface(raw: Record<string, unknown>): SurfaceStyle {
  const out: SurfaceStyle = {};
  const weight = oneOfOptional<StyleWeight>(raw.weight, STYLE_WEIGHTS);
  if (weight) out.weight = weight;
  const corners = oneOfOptional<StyleCorners>(raw.corners, STYLE_CORNERS);
  if (corners) out.corners = corners;
  if (typeof raw.shadow === 'boolean') out.shadow = raw.shadow;
  return out;
}

function scheme(raw: unknown): StyleScheme | undefined {
  if (!isRecord(raw)) return undefined;
  const out: StyleScheme = {};
  for (const key of SCHEME_COLOURS) {
    const value = colour(raw[key]);
    if (value) out[key] = value;
  }
  const selection = colour(raw.selection);
  if (selection) out.selection = selection;
  if (isRecord(raw.accents)) {
    const accents: Partial<Record<Accent, AccentColours>> = {};
    for (const accent of ACCENTS) {
      const entry = raw.accents[accent];
      if (!isRecord(entry)) continue;
      const fill = colour(entry.fill);
      const line = colour(entry.line);
      const text = colour(entry.text);
      const chip = colour(entry.chip);
      // A colour is four values that were chosen together; three of them is not a colour.
      if (fill && line && text && chip) accents[accent] = { fill, line, text, chip };
    }
    if (Object.keys(accents).length > 0) out.accents = accents;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface NormalizedStyle {
  /** `undefined` when there is no style, or none that can be read. */
  style: DocumentStyle | undefined;
  repairs: string[];
}

/**
 * A style from anywhere (a file, a collaborator, a profile, a gallery pack), made safe to keep.
 *
 * Rebuilt from a whitelist, like the rest of a document: unknown keys are dropped, a bad value
 * falls back to "not set", and a drawing that is not exactly the stored form is dropped whole.
 * Pure string and number checks only, so it runs wherever a document is read, worker included.
 */
export function normalizeStyle(raw: unknown): NormalizedStyle {
  const repairs: string[] = [];
  if (raw === undefined || raw === null) return { style: undefined, repairs };
  if (!isRecord(raw) || raw.v !== 1) {
    return { style: undefined, repairs: ['The diagram’s style could not be read; it is drawn with the built-in look.'] };
  }
  const handRaw = isRecord(raw.hand) ? raw.hand : {};
  const hand: DocumentStyle['hand'] = { base: oneOfOptional<HandPreset>(handRaw.base, HAND_PRESETS) ?? 'clean' };
  const wobble = oneOfOptional<StyleWobble>(handRaw.wobble, STYLE_WOBBLES);
  if (wobble) hand.wobble = wobble;
  if (typeof handRaw.retrace === 'boolean') hand.retrace = handRaw.retrace;

  const name = typeof raw.name === 'string' ? cleanText(raw.name, STYLE_LIMITS.maxNameLength).trim() : '';
  const style: DocumentStyle = { v: 1, ...(name ? { name } : {}), hand };

  const general: GeneralStyle = isRecord(raw.general) ? surface(raw.general) : {};
  // Only what is not the default is said, and a depth means nothing with the shadows off.
  if (isRecord(raw.general) && raw.general.depth === 'deep' && general.shadow !== false) general.depth = 'deep';
  if (Object.keys(general).length > 0) style.general = general;

  if (isRecord(raw.schemes)) {
    const light = scheme(raw.schemes.light);
    const dark = scheme(raw.schemes.dark);
    if (light || dark) style.schemes = { ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
  }

  // Drawings first: a shape may only name one that survived. Only drawings something names count
  // toward the limits: replacing a shape's drawing near the limit once dropped the new one (the old
  // one still took its room), and then the old one too as unused, losing both.
  const named = new Set<string>();
  if (isRecord(raw.shapes)) {
    for (const entry of Object.values(raw.shapes)) {
      if (isRecord(entry) && entry.builtin !== true && typeof entry.art === 'string') named.add(entry.art);
    }
  }
  if (isRecord(raw.backdrop) && typeof raw.backdrop.art === 'string') named.add(raw.backdrop.art);
  const assets: StyleAsset[] = [];
  if (Array.isArray(raw.assets)) {
    let dropped = 0;
    let chars = 0;
    const seen = new Set<string>();
    for (const candidate of raw.assets) {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || !named.has(candidate.id)) continue;
      const asset = assets.length < STYLE_LIMITS.maxAssets ? normalizeAsset(candidate) : null;
      const size = asset ? asset.paths.reduce((sum, path) => sum + path.d.length, 0) : 0;
      if (!asset || seen.has(asset.id) || chars + size > STYLE_LIMITS.maxAssetsChars) {
        dropped += 1;
        continue;
      }
      seen.add(asset.id);
      chars += size;
      assets.push(asset);
    }
    if (dropped > 0) repairs.push(`Left out ${dropped} custom drawing(s) that could not be read or were too large.`);
  }
  const known = new Set(assets.map((asset) => asset.id));

  const used = new Set<string>();
  if (isRecord(raw.shapes)) {
    const shapes: Record<string, ShapeStyle> = {};
    // In the canonical order, not the file's, so the same style is always the same bytes.
    for (const key of STYLE_SHAPE_KEYS) {
      const entry = raw.shapes[key];
      if (!isRecord(entry)) continue;
      const shape: ShapeStyle = surface(entry);
      if (keyTakesArt(key)) {
        if (entry.builtin === true) shape.builtin = true;
        else if (typeof entry.art === 'string' && known.has(entry.art)) {
          shape.art = entry.art;
          used.add(entry.art);
          const fit = oneOfOptional<StyleFit>(entry.fit, STYLE_FITS);
          if (fit) shape.fit = fit;
        }
      }
      if (Object.keys(shape).length > 0) shapes[key] = shape;
    }
    if (Object.keys(shapes).length > 0) style.shapes = shapes;
    const unknown = Object.keys(raw.shapes).filter((key) => !SHAPE_KEYS.has(key)).length;
    if (unknown > 0) repairs.push(`Ignored the look of ${unknown} shape kind(s) this version does not know.`);
  }

  if (isRecord(raw.connectors)) {
    const connectors: ConnectorStyle = {};
    const weight = oneOfOptional<StyleWeight>(raw.connectors.weight, STYLE_WEIGHTS);
    if (weight) connectors.weight = weight;
    const head = oneOfOptional<StyleHead>(raw.connectors.head, STYLE_HEADS);
    if (head) connectors.head = head;
    const edgeColour = oneOfOptional<StyleEdgeColour>(raw.connectors.colour, STYLE_EDGE_COLOURS);
    if (edgeColour) connectors.colour = edgeColour;
    if (Object.keys(connectors).length > 0) style.connectors = connectors;
  }

  if (isRecord(raw.backdrop) && typeof raw.backdrop.art === 'string' && known.has(raw.backdrop.art)) {
    const backdrop: StyleBackdrop = { art: raw.backdrop.art };
    const strength = oneOfOptional<BackdropStrength>(raw.backdrop.strength, BACKDROP_STRENGTHS);
    if (strength && strength !== 'regular') backdrop.strength = strength;
    const scale = oneOfOptional<BackdropScale>(raw.backdrop.scale, BACKDROP_SCALES);
    if (scale && scale !== 'regular') backdrop.scale = scale;
    style.backdrop = backdrop;
    used.add(backdrop.art);
  }

  // A drawing nothing uses is dead weight in every copy of the file.
  const kept = assets.filter((asset) => used.has(asset.id));
  if (kept.length > 0) style.assets = kept;
  return { style, repairs };
}

const CANONICAL = new WeakMap<DocumentStyle, DocumentStyle | undefined>();

/**
 * `style` as a file holds it: checked, and with every key in the one order `normalizeStyle` writes
 * them, so the same look is always the same bytes however its object was put together. Remembered
 * per object, so saving a diagram does not re-check a style that has not changed.
 */
export function canonicalStyle(style: DocumentStyle): DocumentStyle | undefined {
  if (CANONICAL.has(style)) return CANONICAL.get(style);
  const { style: checked } = normalizeStyle(style);
  CANONICAL.set(style, checked);
  if (checked) CANONICAL.set(checked, checked);
  return checked;
}

/** The style without its drawings: what a share link falls back to when they do not fit. */
export function withoutAssets(style: DocumentStyle): DocumentStyle {
  if (!style.assets) return style;
  const { assets: _assets, ...rest } = style;
  return rest;
}
