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

export const SHADOW_FILTER_ID = 'dc-shadow';

let clipCounter = 0;
let clipScope = 'g';

/**
 * Clip-path ids are resolved against the whole HTML document, not against the
 * `<svg>` they appear in — so every node on the canvas would otherwise fight
 * over `#dc-clip-1`. Each render declares a scope (a node id on the canvas, a
 * constant for an export) to keep them apart.
 */
export function beginClipScope(scope: string): void {
  clipScope = scope.replace(/[^a-zA-Z0-9_-]/g, '') || 'g';
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
    filter: shape.shadow ? `url(#${SHADOW_FILTER_ID})` : undefined,
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
    filter: shape.shadow ? `url(#${SHADOW_FILTER_ID})` : undefined,
    ...strokeAttrs(shape.stroke),
  });
}

function emitPath(shape: PathShape): SvgEl {
  return el('path', {
    d: shape.d,
    fill: shape.fill ?? 'none',
    opacity: shape.opacity,
    filter: shape.shadow ? `url(#${SHADOW_FILTER_ID})` : undefined,
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
function emitText(shape: TextShape): SvgEl[] {
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
        'text-anchor': shape.align === 'start' ? undefined : shape.align,
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
      if (shape.translate) {
        attrs.transform = `translate(${n(shape.translate.x)} ${n(shape.translate.y)})`;
      }

      if (!shape.clip) return [el('g', attrs, children)];

      clipCounter += 1;
      const clipId = `dc-${clipScope}-clip-${clipCounter}`;
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

/** The one shadow in the design system, shared by every surface that has one. */
export function shadowFilter(color: string): SvgEl {
  return el(
    'filter',
    { id: SHADOW_FILTER_ID, x: '-20%', y: '-20%', width: '140%', height: '140%' },
    [
      el('feDropShadow', {
        dx: 0,
        dy: 1,
        stdDeviation: 2,
        'flood-color': color,
        'flood-opacity': 1,
      }),
    ],
  );
}
