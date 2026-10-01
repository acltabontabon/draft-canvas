import type {
  CodeShape,
  DisplayList,
  EllipseShape,
  PathShape,
  RectShape,
  Shape,
  Stroke,
  TextShape,
} from '../displayList';
import { colorForScope } from '../code/theme';
import { familyOf } from '../text/fonts';
import { baselineOf } from '../text/layout';
import { el, n, type SvgEl } from './element';
import { scopedId } from './ids';

const SHADOW_FILTER_ID = 'dc-shadow';

let clipCounter = 0;
let clipScope = 'g';

/**
 * Clip-path ids are resolved against the whole HTML document, not against the
 * `<svg>` they appear in — so every node on the canvas would otherwise fight
 * over `#dc-clip-1`. Each render declares a scope (a node id on the canvas, a
 * constant for an export) to keep them apart.
 *
 * Other characters are spelled out, not dropped: an imported id can hold anything, and stripping
 * made `api.gw` and `apigw` — or any two ids written entirely in another script — the same scope,
 * so one card clipped to the other's rectangle. `.` never survives on its own, so the spelling
 * can't collide with an id that happens to read like one.
 */
export function beginClipScope(scope: string): void {
  clipScope = scope.replace(/[^a-zA-Z0-9_-]/gu, (char) => `.${char.codePointAt(0)!.toString(36)}.`) || 'g';
  clipCounter = 0;
}

function strokeAttrs(stroke: Stroke | undefined): Record<string, string | number | undefined> {
  if (!stroke) return { stroke: 'none' };
  return {
    stroke: stroke.color,
    'stroke-width': n(stroke.width),
    'stroke-dasharray': stroke.dash?.map(n).join(' '),
    'stroke-linecap': stroke.linecap,
    'stroke-linejoin': 'round',
  };
}

function emitRect(shape: RectShape): SvgEl {
  return el('rect', {
    x: n(shape.x),
    y: n(shape.y),
    width: n(shape.w),
    height: n(shape.h),
    rx: shape.r === undefined ? undefined : n(shape.r),
    ry: shape.r === undefined ? undefined : n(shape.r),
    fill: shape.fill ?? 'none',
    opacity: shape.opacity,
    filter: shape.shadow ? `url(#${scopedId(SHADOW_FILTER_ID)})` : undefined,
    ...strokeAttrs(shape.stroke),
  });
}

function emitEllipse(shape: EllipseShape): SvgEl {
  return el('ellipse', {
    cx: n(shape.cx),
    cy: n(shape.cy),
    rx: n(shape.rx),
    ry: n(shape.ry),
    fill: shape.fill ?? 'none',
    opacity: shape.opacity,
    filter: shape.shadow ? `url(#${scopedId(SHADOW_FILTER_ID)})` : undefined,
    ...strokeAttrs(shape.stroke),
  });
}

function emitPath(shape: PathShape): SvgEl {
  return el('path', {
    d: shape.d,
    fill: shape.fill ?? 'none',
    opacity: shape.opacity,
    filter: shape.shadow ? `url(#${scopedId(SHADOW_FILTER_ID)})` : undefined,
    'marker-end': shape.markerEnd,
    'marker-start': shape.markerStart,
    ...strokeAttrs(shape.stroke),
  });
}

/**
 * One `<text>` per pre-computed line.
 *
 * `textLength` pins each line to the width it was laid out at. Without it, an
 * exported SVG opened on a machine with different font metrics reflows and
 * spills out of its box; with it, the glyphs stretch imperceptibly instead and
 * the diagram still reads correctly anywhere.
 */
/** `start`/`end` name the reading direction's ends: in right-to-left text they swap, so keeping the
 *  text where the layout put it (a left-aligned note stays left-aligned) means swapping them back. */
const RTL_ANCHOR = { start: 'end', middle: 'middle', end: 'start' } as const;

function emitText(shape: TextShape): SvgEl[] {
  const rtl = shape.layout.direction === 'rtl';
  const anchor = rtl ? RTL_ANCHOR[shape.align] : shape.align;
  return shape.layout.lines.map((line, index) =>
    el(
      'text',
      {
        x: n(shape.x),
        y: n(shape.y + baselineOf(shape.layout, index)),
        fill: shape.fill,
        'font-family': familyOf(shape.font.stack),
        'font-size': n(shape.font.size),
        'font-weight': shape.font.weight,
        'font-style': shape.font.italic ? 'italic' : undefined,
        'text-anchor': anchor === 'start' ? undefined : anchor,
        direction: rtl ? 'rtl' : undefined,
        'letter-spacing': 0,
        opacity: shape.opacity,
        textLength: line.width > 0 ? n(line.width) : undefined,
        lengthAdjust: line.width > 0 ? 'spacingAndGlyphs' : undefined,
        'xml:space': 'preserve',
      },
      undefined,
      line.text,
    ),
  );
}

/**
 * Code is monospace, so every token's x position is `charWidth * columnIndex` —
 * no measurement, and byte-identical between the canvas and the export.
 */
function emitCode(shape: CodeShape): SvgEl[] {
  const out: SvgEl[] = [];
  const halfLeading = (shape.lineHeight - (shape.ascent + shape.descent)) / 2;

  for (let index = shape.firstLine; index <= shape.lastLine; index += 1) {
    const line = shape.lines[index];
    if (!line || line.length === 0) continue;

    const y = shape.y + index * shape.lineHeight + halfLeading + shape.ascent;
    let column = 0;
    const spans: SvgEl[] = [];

    for (const token of line) {
      if (token.text === '') continue;
      spans.push(
        el(
          'tspan',
          {
            x: n(shape.x + column * shape.charWidth),
            y: n(y),
            fill: colorForScope(shape.theme, token.scope),
            // A viewer with a different monospace font would otherwise let the tokens of one line
            // drift apart or overlap; pinning each to its share of the character grid keeps the
            // columns where the editor had them.
            textLength: n(token.text.length * shape.charWidth),
            lengthAdjust: 'spacingAndGlyphs',
          },
          undefined,
          token.text,
        ),
      );
      column += token.text.length;
    }
    if (spans.length === 0) continue;

    out.push(
      el('text', {
        'font-family': familyOf(shape.font.stack),
        'font-size': n(shape.font.size),
        'font-weight': shape.font.weight,
        'xml:space': 'preserve',
      }, spans),
    );
  }
  return out;
}

export function emitShape(shape: Shape): SvgEl[] {
  switch (shape.t) {
    case 'rect':
      return [emitRect(shape)];
    case 'ellipse':
      return [emitEllipse(shape)];
    case 'path':
      return [emitPath(shape)];
    case 'text':
      return emitText(shape);
    case 'code':
      return emitCode(shape);
    case 'group': {
      const children = shape.children.flatMap(emitShape);
      const attrs: Record<string, string | number | undefined> = {};
      if (shape.opacity !== undefined) attrs.opacity = shape.opacity;
      const transforms: string[] = [];
      if (shape.translate) transforms.push(`translate(${n(shape.translate.x)} ${n(shape.translate.y)})`);
      if (shape.scale !== undefined && shape.scale !== 1) transforms.push(`scale(${n(shape.scale)})`);
      if (transforms.length > 0) attrs.transform = transforms.join(' ');

      if (!shape.clip) return [el('g', attrs, children)];

      clipCounter += 1;
      const clipId = scopedId(`dc-${clipScope}-clip-${clipCounter}`);
      const { x, y, w, h, r } = shape.clip;
      return [
        el('clipPath', { id: clipId }, [
          el('rect', {
            x: n(x),
            y: n(y),
            width: n(w),
            height: n(h),
            rx: r === undefined ? undefined : n(r),
          }),
        ]),
        el('g', { ...attrs, 'clip-path': `url(#${clipId})` }, children),
      ];
    }
  }
}

export function emitDisplayList(list: DisplayList): SvgEl[] {
  return list.shapes.flatMap(emitShape);
}

/**
 * The one shadow in the design system, shared by every surface that has one. Spelled out as the
 * SVG 1.1 primitives (blur the alpha, offset it, colour it, lay the source on top) rather than
 * `feDropShadow`: that shorthand is Filter Effects 1, and the tools an exported diagram ends up in
 * — Inkscape, older Illustrator, LibreOffice, ImageMagick, a wiki's sanitiser — draw a shape with
 * no shadow at all, or nothing, when they meet it. Every browser draws the long form the same way.
 */
export function shadowFilter(color: string): SvgEl {
  return el(
    'filter',
    { id: scopedId(SHADOW_FILTER_ID), x: '-20%', y: '-20%', width: '140%', height: '140%' },
    [
      el('feGaussianBlur', { in: 'SourceAlpha', stdDeviation: 2, result: 'blur' }),
      el('feOffset', { in: 'blur', dx: 0, dy: 1, result: 'offset' }),
      el('feFlood', { 'flood-color': color, 'flood-opacity': 1, result: 'color' }),
      el('feComposite', { in: 'color', in2: 'offset', operator: 'in', result: 'shadow' }),
      el('feMerge', {}, [el('feMergeNode', { in: 'shadow' }), el('feMergeNode', { in: 'SourceGraphic' })]),
    ],
  );
}
