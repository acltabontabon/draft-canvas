import { useId, useMemo, useRef } from 'react';
import { resolveScene, stepStarts } from '../../learn/frames';
import { SCENE_HEIGHT, SCENE_WIDTH, type Scene } from '../../learn/types';
import { usePersonality } from '../personality/usePersonality';
import { useThemeValue } from '../theme/useTheme';
import { Icon } from '../common/Icon';
import { Cursor, Overlay } from './SceneOverlays';
import { at } from './stage';
import { renderScene } from './sceneRender';
import { useSceneClock } from './useSceneClock';

/** How far outside a node its selection ring sits — the canvas's own `inset: -4px`. */
const RING = 4;

/**
 * A recipe's living diagram: real Draft Canvas shapes, choreographed. Show first — the step chips
 * underneath are the explanation, synced to the beat, and double as the way to step through by hand
 * (and as the whole story when motion is off).
 *
 * Remount per recipe (`key`), which is what resets the clock.
 */
export function SceneView({ scene }: { scene: Scene }) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  const key = useId().replace(/[^a-zA-Z0-9]/g, '');
  const rootRef = useRef<HTMLDivElement>(null);

  const resolved = useMemo(() => resolveScene(scene), [scene]);
  const rendered = useMemo(() => renderScene(resolved.frames, { theme, preset, key }), [resolved, theme, preset, key]);
  const durations = useMemo(() => resolved.frames.map((frame) => frame.ms), [resolved]);
  const starts = useMemo(() => stepStarts(resolved), [resolved]);

  const clock = useSceneClock(durations, rootRef);
  const frame = resolved.frames[clock.frame]!;
  const drawn = rendered.frames[clock.frame]!;
  const previous = clock.frame > 0 ? resolved.frames[clock.frame - 1] : undefined;
  const isNew = (id: string, list: 'nodes' | 'edges') =>
    previous !== undefined && !previous[list].some((item) => item.id === id);

  const nodeById = new Map(frame.nodes.map((node) => [node.id, node]));
  // Which way a new connector draws in: from its source toward its target.
  const directionOf = (source: string, target: string) => {
    const a = nodeById.get(source);
    const b = nodeById.get(target);
    if (!a || !b) return undefined;
    const dx = b.x + b.width / 2 - (a.x + a.width / 2);
    const dy = b.y + b.height / 2 - (a.y + a.height / 2);
    return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'r' : 'l') : dy >= 0 ? 'd' : 'u';
  };

  const stateOf = (id: string) => (frame.ghost.has(id) ? 'ghost' : frame.dim.has(id) ? 'dim' : undefined);
  const handleNode = frame.handles ? nodeById.get(frame.handles) : undefined;

  return (
    <figure className="dc-learn-scene" ref={rootRef}>
      <div
        className="dc-learn-stage"
        data-playing={clock.playing ? 'true' : undefined}
        data-reduced={clock.reduced ? 'true' : undefined}
      >
        {/* The picture is the image; the Pause button beside it stays a button a screen reader can reach
            (inside `role="img"`, everything is presentational). */}
        <div className="dc-learn-stage-inner" key={clock.loop} role="img" aria-label={scene.label}>
          <svg viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} aria-hidden="true" focusable="false">
            <defs dangerouslySetInnerHTML={{ __html: rendered.defs }} />
            {drawn.backdrops.map(({ node, html }) => (
              <g
                key={node.id}
                className="dc-learn-node"
                data-enter={isNew(node.id, 'nodes') ? 'true' : undefined}
                data-state={stateOf(node.id)}
                style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
              >
                <g dangerouslySetInnerHTML={{ __html: html }} />
              </g>
            ))}
            {drawn.edges.map(({ edge, lineHtml }) => (
              <g
                key={edge.id}
                className="dc-learn-edge"
                data-enter={isNew(edge.id, 'edges') ? 'true' : undefined}
                data-dir={directionOf(edge.source, edge.target)}
                data-state={stateOf(edge.id)}
                data-selected={frame.selection.has(edge.id) ? 'true' : undefined}
                dangerouslySetInnerHTML={{ __html: lineHtml }}
              />
            ))}
            {drawn.nodes.map(({ node, html }) => (
              <g
                key={node.id}
                className="dc-learn-node"
                data-enter={isNew(node.id, 'nodes') ? 'true' : undefined}
                data-state={stateOf(node.id)}
                style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
              >
                <g dangerouslySetInnerHTML={{ __html: html }} />
              </g>
            ))}
            {drawn.edges.map(({ edge, overlayHtml }) => (
              <g
                key={edge.id}
                className="dc-learn-edge-overlay"
                data-enter={isNew(edge.id, 'edges') ? 'true' : undefined}
                data-state={stateOf(edge.id)}
                dangerouslySetInnerHTML={{ __html: overlayHtml }}
              />
            ))}
            {frame.nodes
              .filter((node) => frame.selection.has(node.id))
              .map((node) =>
                node.type === 'ellipse' ? (
                  <ellipse
                    key={`ring-${node.id}`}
                    className="dc-learn-ring"
                    cx={node.x + node.width / 2}
                    cy={node.y + node.height / 2}
                    rx={node.width / 2 + RING}
                    ry={node.height / 2 + RING}
                  />
                ) : (
                  <rect
                    key={`ring-${node.id}`}
                    className="dc-learn-ring"
                    x={node.x - RING}
                    y={node.y - RING}
                    width={node.width + RING * 2}
                    height={node.height + RING * 2}
                    rx={11}
                  />
                ),
              )}
            {handleNode &&
              [
                [handleNode.x + handleNode.width / 2, handleNode.y],
                [handleNode.x + handleNode.width, handleNode.y + handleNode.height / 2],
                [handleNode.x + handleNode.width / 2, handleNode.y + handleNode.height],
                [handleNode.x, handleNode.y + handleNode.height / 2],
              ].map(([cx, cy], i) => <circle key={`handle-${i}`} className="dc-learn-handle" cx={cx} cy={cy} r={4.5} />)}
          </svg>

          <div className="dc-learn-stage-ui" aria-hidden="true">
            {Object.entries(frame.chips).map(([hostId, kinds]) => {
              const host = nodeById.get(hostId);
              const edge = host ? undefined : frame.edges.find((candidate) => candidate.id === hostId);
              const point = host
                ? { x: host.x + host.width - 14, y: host.y - 2 }
                : edge
                  ? midpoint(nodeById.get(edge.source), nodeById.get(edge.target))
                  : undefined;
              if (!point || kinds.length === 0) return null;
              return (
                <span key={`chip-${hostId}`} className="dc-learn-chip" data-on={host ? 'node' : 'edge'} style={at(point)}>
                  {kinds.map((kind, i) => (
                    <Icon key={`${kind}-${i}`} name={kind === 'code' ? 'code' : 'pencil'} size={10} />
                  ))}
                  {kinds.length === 1 ? (kinds[0] === 'code' ? 'Code' : 'Note') : kinds.length}
                </span>
              );
            })}
            {frame.overlay && <Overlay key={`${frame.overlay.kind}-${frame.step}`} overlay={frame.overlay} />}
            {frame.cursor && <Cursor cursor={frame.cursor} beat={clock.frame} />}
          </div>
        </div>

        {!clock.reduced && (
          <button
            type="button"
            className="dc-learn-playpause"
            onClick={clock.togglePaused}
            aria-label={clock.paused ? 'Play animation' : 'Pause animation'}
          >
            {clock.paused ? (
              <Icon name="play" size={12} />
            ) : (
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path d="M3.5 2.5v7M8.5 2.5v7" />
              </svg>
            )}
          </button>
        )}
      </div>

      <figcaption>
        <ol className="dc-learn-steps" aria-label="Steps">
          {resolved.steps.map((step, i) => (
            <li key={step}>
              <button
                type="button"
                className="dc-learn-step"
                aria-current={frame.step === i ? 'step' : undefined}
                onClick={() => clock.goTo(starts[i] ?? 0)}
              >
                <span className="dc-learn-step-index" aria-hidden="true">
                  {i + 1}
                </span>
                {step}
              </button>
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

function midpoint(a: { x: number; y: number; width: number; height: number } | undefined, b: typeof a) {
  if (!a || !b) return undefined;
  // Just under the line, clear of the label that sits above it.
  return { x: (a.x + a.width / 2 + b.x + b.width / 2) / 2, y: (a.y + a.height / 2 + b.y + b.height / 2) / 2 + 20 };
}
