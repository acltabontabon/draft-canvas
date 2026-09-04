import { useMemo } from 'react';
import { createEdge, createNode } from '../../document/factory';
import type { DraftNode } from '../../document/types';
import { describeEdge } from '../../edges/describe';
import { describeContext, describeNode } from '../../nodes/describe';
import { beginClipScope, emitDisplayList } from '../../render/svg/emit';
import { el, serialize } from '../../render/svg/element';
import type { Theme } from '../../render/theme/tokens';
import type { PersonalityPreset } from './usePersonality';

const WIDTH = 96;
const HEIGHT = 36;
const NODE_WIDTH = 30;
const NODE_HEIGHT = 18;
const NODE_Y = (HEIGHT - NODE_HEIGHT) / 2;

/**
 * A tiny two-service-and-a-connector scene, rendered through the exact same `describeNode`/
 * `describeEdge` + `emitDisplayList`/`serialize` pipeline `SvgSurface`/the exporter use — never a
 * hand-faked decorative SVG. This is what makes the preview structurally unable to drift from
 * what the preset actually looks like on a real canvas: it isn't a second, similar-looking
 * implementation, it's the real one called with small fixed coordinates.
 */
export function PersonalityPreview({ preset, theme }: { preset: PersonalityPreset; theme: Theme }) {
  const markup = useMemo(() => {
    beginClipScope(`personality-preview-${preset}`);
    const ctx = describeContext(theme, preset);

    const a: DraftNode = createNode({
      type: 'service',
      id: `personality-preview-${preset}-a`,
      x: 4,
      y: NODE_Y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
    const b: DraftNode = createNode({
      type: 'service',
      id: `personality-preview-${preset}-b`,
      x: WIDTH - NODE_WIDTH - 4,
      y: NODE_Y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
    const edge = createEdge({
      id: `personality-preview-${preset}-edge`,
      source: a.id,
      target: b.id,
      routing: 'straight',
    });
    const nodes = new Map([
      [a.id, a],
      [b.id, b],
    ]);

    const described = describeEdge(edge, nodes, {
      theme,
      measurer: ctx.measurer,
      showSequence: false,
      preset,
    });
    const edgeEls = described ? emitDisplayList({ width: 0, height: 0, shapes: [...described.line, ...described.overlay] }) : [];

    // `describeNode` only ever reads `width`/`height` — its shapes are local to a node's own
    // 0,0 origin, positioned here the same way `document.ts`'s exporter does.
    const nodeEls = [a, b].map((node) =>
      el('g', { transform: `translate(${node.x} ${node.y})` }, emitDisplayList(describeNode(node, ctx))),
    );

    // Edges paint underneath nodes, same order every other renderer uses.
    return [...edgeEls, ...nodeEls].map(serialize).join('');
  }, [preset, theme]);

  return (
    <svg
      className="dc-personality-preview"
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
