import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { ROOT_ROOM } from '../collab/changes';
import { viewOf } from '../depth/tree';
import type { DraftDocument, DraftNode } from '../document/types';
import type { ElementChange } from '../evolution/diff';
import { motionMs } from '../lib/motion';
import { renderDocumentSvg } from '../render/svg/document';
import { visibleChanges } from '../store/evolution/compare';
import { useEvolutionStore } from '../store/evolution/evolutionStore';
import { deviceStyle } from '../store/styleStore';
import { usePersonality } from '../theme/usePersonality';
import { useTheme } from '../theme/useTheme';
import { ViewportLayer } from './ViewportLayer';
import '../styles/compare.css';

/**
 * Compare, drawn on the canvas over the history lens.
 *
 * Overlay: the side being looked at is the lens's picture; this marks on it what differs from the
 * other side — a mark and a glyph for every change, never colour alone: `+` added, `−` removed
 * (drawn faintly where it was), `•` changed, and a dashed outline where a moved shape used to be.
 * What did not change recedes.
 *
 * Side by side: both versions, each in half of the canvas, following the one camera, so panning
 * or zooming either moves both.
 */

type Mark = 'added' | 'removed' | 'changed' | 'moved';

interface Placed {
  key: string;
  mark: Mark;
  box: { x: number; y: number; width: number; height: number };
  was?: { x: number; y: number; width: number; height: number };
  label: string;
}

const GLYPH: Record<Mark, string> = { added: '+', removed: '−', changed: '•', moved: '↦' };

function roomId(path: readonly string[]): string {
  return path.length === 0 ? ROOT_ROOM : path[path.length - 1]!;
}

function nodeBox(node: DraftNode) {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/** The marks for one room, as drawn on the side being shown (`after` or `before`). */
function placements(changes: ElementChange[], shown: DraftDocument, other: DraftDocument, side: 'after' | 'before', room: string): Placed[] {
  const here = new Map(shown.nodes.map((node) => [node.id, node]));
  const there = new Map(other.nodes.map((node) => [node.id, node]));
  const out: Placed[] = [];
  for (const change of changes) {
    if (change.kind !== 'node' || change.room !== room) continue;
    const appears = side === 'after' ? change.change === 'added' : change.change === 'removed';
    const vanishes = side === 'after' ? change.change === 'removed' : change.change === 'added';
    const node = here.get(change.id);
    const ghost = there.get(change.id);
    if (vanishes && ghost) {
      out.push({ key: change.id, mark: side === 'after' ? 'removed' : 'added', box: nodeBox(ghost), label: change.label });
    } else if (node) {
      const old = ghost;
      const moved = !appears && old && (old.x !== node.x || old.y !== node.y);
      const onlyMoved = moved && change.categories.length === 1 && change.categories[0] === 'layout';
      out.push({
        key: change.id,
        mark: appears ? (side === 'after' ? 'added' : 'removed') : onlyMoved ? 'moved' : 'changed',
        box: nodeBox(node),
        ...(moved && old ? { was: nodeBox(old) } : {}),
        label: change.label,
      });
    }
  }
  return out;
}

export function CompareOverlay() {
  const compare = useEvolutionStore((state) => state.compare);
  const lens = useEvolutionStore((state) => state.lens);
  const { name: themeName } = useTheme();
  const { preset } = usePersonality();
  const flow = useReactFlow();

  const scene = useMemo(() => {
    if (!compare || !lens || compare.mode !== 'overlay') return null;
    const shownFile = compare.side === 'after' ? compare.target.file : compare.base.file;
    const otherFile = compare.side === 'after' ? compare.base.file : compare.target.file;
    const shown = viewOf(shownFile, lens.path) ?? shownFile;
    const other = viewOf(otherFile, lens.path) ?? otherFile;
    const changes = visibleChanges(compare);
    const room = roomId(lens.path);
    const marks = placements(changes, shown, other, compare.side, room);
    // What exists only on the other side, drawn faintly where it was.
    const gone = new Set(
      changes
        .filter((change) => change.room === room && (compare.side === 'after' ? change.change === 'removed' : change.change === 'added'))
        .map((change) => change.id),
    );
    const ghost =
      gone.size > 0
        ? renderDocumentSvg(other, { theme: themeName, deviceStyle: deviceStyle(), preset, transparent: true, idScope: `compare-ghost-${lens.step}`, only: gone, openPointKey: false, legend: false, padding: 0, ink: false })
        : null;
    const edgeMarks = new Map<string, Mark>();
    for (const change of changes) {
      if (change.kind !== 'edge' || change.room !== room) continue;
      // A connector only on the other side is not in this picture; its ghost is.
      edgeMarks.set(change.id, change.change === 'modified' ? 'changed' : change.change);
    }
    return { marks, ghost, edgeMarks, nodeMarks: new Map(marks.map((mark) => [mark.key, mark.mark])) };
  }, [compare, lens, themeName, preset]);

  // Marks on the lens's own picture: changed elements stand out, the rest recede.
  useLayoutEffect(() => {
    const picture = document.querySelector('.dc-history-lens-scene:not([data-out])');
    if (!picture) return;
    for (const element of picture.querySelectorAll<SVGElement>('[data-change]')) element.removeAttribute('data-change');
    const lensRoot = picture.closest('.dc-history-lens');
    if (!scene) {
      lensRoot?.removeAttribute('data-compare');
      return;
    }
    lensRoot?.setAttribute('data-compare', 'true');
    for (const element of picture.querySelectorAll<SVGElement>('[data-diagram-node]')) {
      const mark = scene.nodeMarks.get(element.getAttribute('data-diagram-node')!);
      if (mark) element.setAttribute('data-change', mark);
    }
    for (const element of picture.querySelectorAll<SVGElement>('[data-diagram-edge], [data-diagram-edge-labels]')) {
      const mark = scene.edgeMarks.get(element.getAttribute('data-diagram-edge') ?? element.getAttribute('data-diagram-edge-labels')!);
      if (mark) element.setAttribute('data-change', mark);
    }
    return () => lensRoot?.removeAttribute('data-compare');
  }, [scene, lens?.step]);

  // The camera to the change chosen in the list.
  const focused = compare?.focused ?? null;
  useEffect(() => {
    if (!focused || !scene) return;
    const id = focused.split(':')[1];
    const mark = scene.marks.find((candidate) => candidate.key === id);
    if (!mark) return;
    const box = mark.was
      ? {
          x: Math.min(mark.box.x, mark.was.x),
          y: Math.min(mark.box.y, mark.was.y),
          width: Math.max(mark.box.x + mark.box.width, mark.was.x + mark.was.width) - Math.min(mark.box.x, mark.was.x),
          height: Math.max(mark.box.y + mark.box.height, mark.was.y + mark.was.height) - Math.min(mark.box.y, mark.was.y),
        }
      : mark.box;
    void flow.fitBounds(box, { padding: 0.6, duration: motionMs(420), maxZoom: 1.4 } as Parameters<typeof flow.fitBounds>[1]);
  }, [focused, scene, flow]);

  if (!scene) return null;
  return (
    <ViewportLayer>
      <div className="dc-compare" aria-hidden="true">
        {scene.ghost && (
          <div className="dc-compare-ghost" style={{ left: scene.ghost.origin.x, top: scene.ghost.origin.y }} dangerouslySetInnerHTML={{ __html: scene.ghost.svg }} />
        )}
        {scene.marks.map((mark) => (
          <div key={mark.key}>
            {mark.was && <div className="dc-compare-was" style={{ left: mark.was.x, top: mark.was.y, width: mark.was.width, height: mark.was.height }} />}
            <div
              className="dc-compare-mark"
              data-mark={mark.mark}
              data-focused={focused === `node:${mark.key}` ? 'true' : undefined}
              style={{ left: mark.box.x - 6, top: mark.box.y - 6, width: mark.box.width + 12, height: mark.box.height + 12 }}
            >
              <span className="dc-compare-glyph">{GLYPH[mark.mark]}</span>
            </div>
          </div>
        ))}
      </div>
    </ViewportLayer>
  );
}

/** Both versions side by side, under one camera. Drawn over the canvas; the pane underneath still pans and zooms. */
export function CompareSplit() {
  const compare = useEvolutionStore((state) => state.compare);
  const lens = useEvolutionStore((state) => state.lens);
  const viewport = useViewport();
  const { name: themeName } = useTheme();
  const { preset } = usePersonality();

  const panes = useMemo(() => {
    if (!compare || !lens || compare.mode !== 'split') return null;
    const paint = (file: DraftDocument, scope: string) =>
      renderDocumentSvg(viewOf(file, lens.path) ?? file, { theme: themeName, deviceStyle: deviceStyle(), preset, transparent: true, idScope: scope, openPointKey: false, legend: false, padding: 0 });
    return [
      { label: compare.base.label, side: 'before', picture: paint(compare.base.file, 'compare-before') },
      { label: compare.target.label, side: 'after', picture: paint(compare.target.file, 'compare-after') },
    ];
  }, [compare, lens, themeName, preset]);

  if (!panes) return null;
  return (
    <div className="dc-compare-split" aria-label="Before and after, side by side">
      {panes.map((pane) => (
        <div key={pane.side} className="dc-compare-pane" data-side={pane.side}>
          <span className="dc-compare-pane-label">{pane.side === 'before' ? 'Before' : 'After'} · {pane.label}</span>
          <div className="dc-compare-pane-world" style={{ transform: `translate(calc(${viewport.x}px - 25cqw), ${viewport.y}px) scale(${viewport.zoom})` }}>
            <div className="dc-compare-pane-picture" style={{ left: pane.picture.origin.x, top: pane.picture.origin.y }} dangerouslySetInnerHTML={{ __html: pane.picture.svg }} />
          </div>
        </div>
      ))}
    </div>
  );
}
