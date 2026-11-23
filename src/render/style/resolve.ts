import {
  STYLE_KINDS,
  shapeKey,
  shapeKindOf,
  type DocumentStyle,
  type HandPreset,
  type ShapeStyle,
  type StyleAsset,
  type StyleCorners,
  type StyleEdgeColour,
  type StyleFit,
  type StyleHead,
  type StyleWeight,
} from '../../document/style';
import { NODE_TYPES, type DraftNode, type DraftNodeType } from '../../document/types';
import { PERSONALITY_PROFILES, type PersonalityProfile } from '../roughness/presets';
import { THEMES, type Theme, type ThemeName } from '../theme/tokens';
import { pinnedTheme, styleThemes } from './scheme';

/** How one shape type or kind is drawn, with every inherited value filled in. */
export interface ResolvedShape {
  /** What every outline's width is multiplied by. 1 is the built-in weight. */
  readonly weight: number;
  readonly corners: StyleCorners;
  /** `false` draws the shape flat. `true` keeps whatever shadow the shape has always had. */
  readonly shadow: boolean;
  /** The drawing that stands in for the built-in one, when the style gives this shape one. */
  readonly art?: StyleAsset;
  /** How the drawing fills its place, when the style says. Otherwise it follows what it replaces. */
  readonly fit?: StyleFit;
  /** Nothing here differs from the built-in look, so a renderer has nothing to do. */
  readonly plain: boolean;
}

export interface ResolvedConnector {
  readonly lineWidth: number;
  readonly head: StyleHead;
  readonly colour: StyleEdgeColour;
}

export interface ResolvedBackdrop {
  readonly art: StyleAsset;
  /** What the drawing's own opacity is multiplied by. */
  readonly opacity: number;
  /** Canvas pixels to one unit of the drawing. */
  readonly scale: number;
}

/** What a backdrop's own opacity is multiplied by. */
export const BACKDROP_OPACITY = { faint: 0.5, regular: 1, strong: 1.7 } as const;
export const BACKDROP_SCALE = { small: 0.66, regular: 1, large: 1.5 } as const;

/** A shape, as far as its look is concerned: its type and whichever kind field that type reads. */
export type StyledNode = Pick<DraftNode, 'type'> & Partial<DraftNode>;

/**
 * Everything a renderer needs to know about how a diagram is drawn, worked out once.
 *
 * Canvas and export read this and nothing else about style, so the two cannot disagree. A value is
 * shared and never rebuilt for the same input: it is safe as a memo dependency and as a cache key.
 */
export interface ResolvedStyle {
  /** How a line is drawn: steady, or with a hand's wobble. */
  readonly hand: PersonalityProfile;
  /** How a shape is drawn, by what it is. Two lookups: nothing is worked out per shape. */
  shape(node: StyledNode): ResolvedShape;
  readonly connector: ResolvedConnector;
  /** The colours to draw in, given the device's light or dark setting. The built-in theme itself
   *  when the style has no colours of its own. */
  theme(device: ThemeName): Theme;
  /** Set when the style is always drawn in one theme, whatever the device prefers. */
  readonly pinned?: ThemeName;
  /** The drawing repeated on the canvas behind the diagram, when the style has one. */
  readonly backdrop?: ResolvedBackdrop;
  /** Short and stable, for caches and memo keys that cannot hold the object. */
  readonly key: string;
}

/** What an outline's built-in width is multiplied by. */
export const WEIGHTS: Record<StyleWeight, number> = { fine: 0.8, regular: 1, bold: 1.3 };
/** A connector's line, a hair finer than a shape's outline at every weight (see `CONNECTOR_STYLE`). */
export const CONNECTOR_WIDTHS: Record<StyleWeight, number> = { fine: 1.4, regular: 1.8, bold: 2.4 };
/** What a corner's built-in radius is multiplied by. */
export const CORNER_SCALE: Record<StyleCorners, number> = { sharp: 0.2, soft: 1, round: 1.8 };

export const PLAIN_SHAPE: ResolvedShape = Object.freeze({ weight: 1, corners: 'soft', shadow: true, plain: true });
const PLAIN_CONNECTOR: ResolvedConnector = Object.freeze({ lineWidth: CONNECTOR_WIDTHS.regular, head: 'nib', colour: 'source' });

function builtin(preset: HandPreset): ResolvedStyle {
  return Object.freeze({
    hand: PERSONALITY_PROFILES[preset],
    shape: () => PLAIN_SHAPE,
    connector: PLAIN_CONNECTOR,
    theme: (device: ThemeName) => THEMES[device],
    key: preset,
  });
}

const BUILTIN: Record<HandPreset, ResolvedStyle> = { clean: builtin('clean'), draft: builtin('draft'), sketch: builtin('sketch') };

/** One of the three built-in looks. The same object every time. */
export function builtinStyle(preset: HandPreset): ResolvedStyle {
  return BUILTIN[preset];
}

/** A built-in look by name, or a style already resolved. */
export type StyleInput = HandPreset | ResolvedStyle;

export function styleFrom(input: StyleInput = 'clean'): ResolvedStyle {
  return typeof input === 'string' ? BUILTIN[input] : input;
}

/** A hand's wobble turned down or up. Clean has none to turn. */
function handOf(hand: DocumentStyle['hand']): PersonalityProfile {
  const base = PERSONALITY_PROFILES[hand.base];
  if (hand.base === 'clean' || (hand.wobble === undefined && hand.retrace === undefined)) return base;
  const by = hand.wobble === 'calm' ? 0.6 : hand.wobble === 'lively' ? 1.35 : 1;
  const retrace = hand.retrace ?? base.retrace;
  return {
    ...base,
    outline: base.outline * by,
    bow: base.bow * by,
    overshoot: base.overshoot * by,
    arrowJitter: base.arrowJitter * by,
    retrace,
    strokes: retrace ? 2 : 1,
  };
}

function shapeOf(style: DocumentStyle, assets: Map<string, StyleAsset>, type: DraftNodeType, kind: string | undefined): ResolvedShape {
  const own: ShapeStyle = (kind === undefined ? undefined : style.shapes?.[shapeKey(type, kind)]) ?? {};
  const family: ShapeStyle = style.shapes?.[type] ?? {};
  const general = style.general ?? {};
  const weight = WEIGHTS[own.weight ?? family.weight ?? general.weight ?? 'regular'];
  const corners = own.corners ?? family.corners ?? general.corners ?? 'soft';
  const shadow = own.shadow ?? family.shadow ?? general.shadow ?? true;
  // A kind that says "built-in" keeps its drawing even when the whole type has one.
  const source = own.art !== undefined || own.builtin ? own : family;
  const art = source.art === undefined ? undefined : assets.get(source.art);
  if (weight === 1 && corners === 'soft' && shadow && !art) return PLAIN_SHAPE;
  return { weight, corners, shadow, ...(art ? { art, ...(source.fit ? { fit: source.fit } : {}) } : {}), plain: false };
}

let serial = 0;

function resolve(style: DocumentStyle): ResolvedStyle {
  const assets = new Map((style.assets ?? []).map((asset) => [asset.id, asset]));
  // Every type and kind, filled once: a describe call reads, it never resolves.
  const table = new Map<DraftNodeType, { own: ResolvedShape; kinds: Map<string, ResolvedShape> }>();
  for (const type of NODE_TYPES) {
    table.set(type, {
      own: shapeOf(style, assets, type, undefined),
      kinds: new Map(STYLE_KINDS[type].map((kind) => [kind, shapeOf(style, assets, type, kind)])),
    });
  }
  const themes = styleThemes(style);
  const pinned = pinnedTheme(style);
  const connectors = style.connectors ?? {};
  const tile = style.backdrop ? assets.get(style.backdrop.art) : undefined;
  const backdrop: ResolvedBackdrop | undefined = tile
    ? { art: tile, opacity: BACKDROP_OPACITY[style.backdrop!.strength ?? 'regular'], scale: BACKDROP_SCALE[style.backdrop!.scale ?? 'regular'] }
    : undefined;
  serial += 1;
  return Object.freeze({
    hand: handOf(style.hand),
    shape(node: StyledNode): ResolvedShape {
      const entry = table.get(node.type);
      if (!entry) return PLAIN_SHAPE;
      const kind = shapeKindOf(node);
      return (kind === undefined ? undefined : entry.kinds.get(kind)) ?? entry.own;
    },
    connector: {
      lineWidth: CONNECTOR_WIDTHS[connectors.weight ?? 'regular'],
      head: connectors.head ?? 'nib',
      colour: connectors.colour ?? 'source',
    },
    theme: (device: ThemeName) => themes[device],
    ...(pinned ? { pinned } : {}),
    ...(backdrop ? { backdrop } : {}),
    key: `s${serial}`,
  });
}

const RESOLVED = new WeakMap<DocumentStyle, ResolvedStyle>();

/**
 * How a diagram is drawn. A diagram that carries a style is drawn in it on every device; one that
 * carries none follows the device's own drawing hand, exactly as every diagram did before a style
 * was part of the file.
 */
export function resolveStyle(style: DocumentStyle | undefined, device: HandPreset = 'clean'): ResolvedStyle {
  if (!style) return BUILTIN[device];
  let resolved = RESOLVED.get(style);
  if (!resolved) {
    resolved = resolve(style);
    RESOLVED.set(style, resolved);
  }
  return resolved;
}
