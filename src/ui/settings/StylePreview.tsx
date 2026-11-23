import { useId, useMemo, type CSSProperties } from 'react';
import { createDocument, createEdge, createNode } from '../../document/factory';
import { addEdges, addNodes } from '../../document/operations';
import type { DocumentStyle } from '../../document/style';
import type { DraftDocument, DraftNode } from '../../document/types';
import { backdropTile } from '../../render/style/backdrop';
import { resolveStyle } from '../../render/style/resolve';
import { renderDocumentSvg } from '../../render/svg/document';
import type { ThemeName } from '../../render/theme/tokens';

/**
 * A style, shown by drawing a small diagram in it.
 *
 * Not a picture of what a style might look like: it is `renderDocumentSvg`, the renderer every
 * export uses and the canvas shares its shapes with, given a sample diagram and the style. So a
 * preview cannot drift from the real thing, and a property this page learns to change needs no
 * second drawing here. Each preview keeps its own arrowheads and shadow (`idScope`), so one on a
 * dialog never disturbs the canvas behind it. The frame it sits in is the style's own canvas:
 * its colour, and its backdrop when it has one (`backdropTile`, the canvas's own).
 */

type Sample = Pick<DraftNode, 'type' | 'text'> & Partial<DraftNode>;

function diagram(title: string, nodes: DraftNode[], edges: [string, string, boolean?][]): DraftDocument {
  const document = addEdges(
    addNodes(createDocument(title), nodes),
    edges.map(([source, target, async], index) => createEdge({ id: `preview-edge-${index}`, source, target, ...(async ? { async: true } : {}) })),
  );
  return { ...document, metadata: { ...document.metadata, id: `style-preview-${title}` } };
}

/** Shapes side by side on one centre line, whatever size each comes in, with a line from each to the next. */
function row(title: string, shapes: Sample[], gap: number, asyncAt = -1): DraftDocument {
  let x = 0;
  const nodes = shapes.map((shape, index) => {
    const node = createNode({ id: `preview-${index}`, x: 0, y: 0, ...shape });
    const placed = { ...node, x, y: -node.height / 2 };
    x += node.width + gap;
    return placed;
  });
  return diagram(
    title,
    nodes,
    nodes.slice(1).map((node, index) => [nodes[index]!.id, node.id, index === asyncAt] as [string, string, boolean]),
  );
}

/**
 * The diagram a style is judged by, in one row so it stays in view above the controls: a person,
 * the way in, a service, what it announces and where that is kept. One line is asynchronous, so a
 * style's line can be seen both solid and dashed, and the shapes wear four colours between them.
 */
const SAMPLE = row(
  'sample',
  [
    { type: 'actor', text: 'Customer' },
    { type: 'service', serviceKind: 'gateway', text: 'Gateway', accent: 'violet' },
    { type: 'service', serviceKind: 'api', text: 'Orders', accent: 'teal' },
    { type: 'queue', text: 'Events', accent: 'amber' },
    { type: 'database', databaseKind: 'sql', text: 'Ledger', accent: 'blue' },
  ],
  72,
  2,
);

/** What a card has room for: who asks, what answers, where it is kept. */
const CARD = row(
  'card',
  [
    { type: 'actor', text: 'Customer' },
    { type: 'service', text: 'Orders', accent: 'teal', width: 132, height: 60 },
    { type: 'database', text: 'Ledger', accent: 'blue' },
  ],
  38,
);

interface StylePreviewProps {
  style: DocumentStyle;
  theme: ThemeName;
  /** `card` is the picture a style is chosen by; `stage` the one it is edited against. */
  size?: 'card' | 'stage';
  /** One shape on its own, in place of the sample diagram. */
  shape?: Pick<DraftNode, 'type'> & Partial<DraftNode>;
  label?: string;
}

export function StylePreview({ style, theme, size = 'stage', shape, label }: StylePreviewProps) {
  const scope = useId().replace(/[^a-zA-Z0-9]/g, '');
  const resolved = resolveStyle(style);
  const markup = useMemo(() => {
    const document = shape ? diagram('shape', [createNode({ id: 'preview-shape', x: 0, y: 0, text: 'Name', accent: 'teal', ...shape })], []) : size === 'card' ? CARD : SAMPLE;
    return renderDocumentSvg(document, {
      style: resolved,
      theme,
      idScope: `style-preview-${scope}`,
      padding: size === 'card' ? 10 : 22,
      includeBackground: false,
      openPoints: false,
    }).svg;
  }, [resolved, theme, size, shape, scope]);

  // The style's own canvas around the picture, so a wide frame is one surface, not a letterbox.
  const tile = backdropTile(resolved, theme);
  const surface: CSSProperties = { backgroundColor: resolved.theme(theme).canvas };
  if (tile) {
    // A card shows the diagram at about half size; its paper is drawn to match.
    const scale = size === 'card' ? 0.5 : shape ? 0.6 : 0.8;
    surface.backgroundImage = tile.uri;
    surface.backgroundSize = `${tile.width * scale}px ${tile.height * scale}px`;
  }

  return (
    <div
      className="dc-style-preview"
      data-size={shape ? 'shape' : size}
      role="img"
      aria-label={label ?? 'A sample diagram drawn in this style'}
      style={surface}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
