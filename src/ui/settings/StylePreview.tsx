import { useId, useMemo } from 'react';
import { createDocument, createEdge, createNode } from '../../document/factory';
import { addEdges, addNodes } from '../../document/operations';
import type { DocumentStyle } from '../../document/style';
import type { DraftDocument, DraftNode } from '../../document/types';
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
 * dialog never disturbs the canvas behind it.
 */

function diagram(title: string, nodes: DraftNode[], edges: [string, string, boolean?][]): DraftDocument {
  const document = addEdges(
    addNodes(createDocument(title), nodes),
    edges.map(([source, target, async], index) => createEdge({ id: `preview-edge-${index}`, source, target, ...(async ? { async: true } : {}) })),
  );
  return { ...document, metadata: { ...document.metadata, id: `style-preview-${title}` } };
}

/**
 * The diagram a style is judged by, in one row so it stays in view above the controls: a person, a
 * service, what it announces and where that is kept. One line of the three is asynchronous, so a
 * style's line can be seen both solid and dashed.
 */
const SAMPLE = (() => {
  const actor = createNode({ id: 'preview-actor', type: 'actor', x: 0, y: 0, text: 'Customer' });
  const service = createNode({ id: 'preview-service', type: 'service', x: 0, y: 0, text: 'Orders', accent: 'teal' });
  const queue = createNode({ id: 'preview-queue', type: 'queue', x: 0, y: 0, text: 'Events', accent: 'amber' });
  const store = createNode({ id: 'preview-store', type: 'database', x: 0, y: 0, text: 'Ledger', accent: 'blue' });
  // Side by side on one centre line, whatever size each shape comes in.
  let x = 0;
  const row = [actor, service, queue, store].map((node) => {
    const placed = { ...node, x, y: -node.height / 2 };
    x += node.width + 84;
    return placed;
  });
  return diagram('sample', row, [
    ['preview-actor', 'preview-service'],
    ['preview-service', 'preview-queue', true],
    ['preview-queue', 'preview-store'],
  ]);
})();

/** The two shapes and one line a row has room for. */
const SMALL = diagram(
  'small',
  [
    createNode({ id: 'preview-a', type: 'service', x: 0, y: 0, width: 120, height: 56, text: 'Orders', accent: 'teal' }),
    createNode({ id: 'preview-b', type: 'service', x: 210, y: 0, width: 120, height: 56, text: 'Billing' }),
  ],
  [['preview-a', 'preview-b']],
);

interface StylePreviewProps {
  style: DocumentStyle;
  theme: ThemeName;
  /** `row` is the small picture beside a choice; `stage` the one a style is edited against. */
  size?: 'row' | 'stage';
  /** One shape on its own, in place of the sample diagram. */
  shape?: Pick<DraftNode, 'type'> & Partial<DraftNode>;
  label?: string;
}

export function StylePreview({ style, theme, size = 'stage', shape, label }: StylePreviewProps) {
  const scope = useId().replace(/[^a-zA-Z0-9]/g, '');
  const resolved = resolveStyle(style);
  const markup = useMemo(() => {
    const document = shape
      ? diagram('shape', [createNode({ id: 'preview-shape', x: 0, y: 0, text: 'Name', accent: 'teal', ...shape })], [])
      : size === 'row'
      ? SMALL
      : SAMPLE;
    return renderDocumentSvg(document, {
      style: resolved,
      theme,
      idScope: `style-preview-${scope}`,
      padding: size === 'row' ? 10 : 22,
      includeBackground: false,
      openPoints: false,
    }).svg;
  }, [resolved, theme, size, shape, scope]);

  return (
    <div
      className="dc-style-preview"
      data-size={shape ? 'shape' : size}
      role="img"
      aria-label={label ?? 'A sample diagram drawn in this style'}
      // The picture's own canvas colour around it, so a wide frame is one surface, not a letterbox.
      style={{ background: resolved.theme(theme).canvas }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
