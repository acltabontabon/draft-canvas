import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Panel, useReactFlow } from '@xyflow/react';
import { applyOutageFix, outageFixLabel } from '../commands/outage';
import { displayNameFor } from '../document/factory';
import type { DraftNode } from '../document/types';
import { motionMs } from '../lib/motion';
import { familyOf } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import { createRng } from '../render/roughness/seed';
import { useEditorStore } from '../store/editorStore';
import { outageIn, runtimeOf } from '../store/outage';
import { useUiStore } from '../store/uiStore';
import type { Outage, OutageNote } from '../traffic';
import { outageSummary } from '../traffic/outage';
import { arrowFor, placeSketches, type Rect, type SketchRequest } from '../traffic/sketchLayout';
import { markerArrow, markerLoop } from './sketchPaths';

/**
 * An outage walk, told on the canvas — the way someone reviewing the diagram would mark up a
 * whiteboard.
 *
 * What is down is struck out. Above the diagram, one handwritten line says what went down and what
 * carries on. Beside each shape the outage reaches: a marker loop, a few words ("calls fail — no
 * fallback drawn", "holds messages until it's back") and an arrow flicked from one to the other, in
 * the order the consequence travels. Tap a note and it unfolds, in place, into the full sentence.
 *
 * A question — something the drawing leaves open — carries its answers under it: the edit that
 * would settle it, where one exists, and "Keep as open point", which leaves the question on that
 * shape in the file. Both are ordinary edits the person makes; the walk reads the diagram again as
 * soon as one lands, so drawing an answer shows what it changes.
 *
 * Drawn in flow space, so it pans with the shapes. Chrome, not content: nothing here is saved,
 * undone, shared or exported, and nothing can be dragged. The notes are buttons, so a keyboard
 * reaches each one, and the walk is announced as it changes. Every stroke draws itself on in turn;
 * under reduced motion it is simply there.
 */

/** A glance, not a report: past this many notes the canvas would be written over. */
const MAX_NOTES = 7;
const LINE_HEIGHT = 21;
/**
 * Handwriting is the accent, so it is rationed. Up to this many notes are written by hand beside
 * what they circle; past it the canvas would be more marker than drawing, and the notes are set in
 * the plain face instead — smaller, quieter, and quicker to read seven of. The headline stays
 * handwritten either way: one line of it is what says "this was written on the diagram".
 */
const HANDWRITTEN_NOTES = 4;
const PLAIN_LINE_HEIGHT = 18;
const FIRST_STROKE_MS = 260;
const STROKE_STAGGER_MS = 380;
const FRAME_MARGIN = 40;
/** The toolbar floats over the top of the canvas; the headline must clear it. */
const TOP_CLEARANCE = 76;
const BOTTOM_CLEARANCE = 76;
/** Room under a question's words for its answers. */
const ACTION_ROOM = 27;
const ACTION_WIDTH = { one: 136, two: 300 };

interface Placed {
  note: OutageNote;
  delay: number;
  loops: { key: string; d: string }[];
  arrows: { shaft: string; head: string }[];
  x: number;
  y: number;
  tilt: number;
  label: Rect & { lines: string[] };
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const PICK = 'Pick a service, queue, data store or boundary to take down.';

export const OutageLayer = memo(function OutageLayer() {
  const analysis = useEditorStore(runtimeOf);
  const outage = useEditorStore(outageIn);
  const down = useEditorStore((state) => state.outage.down);
  const live = useEditorStore((state) => state.document.nodes);
  const openPoints = useEditorStore((state) => state.document.openPoints);
  // While a shape is being dragged the notes hold still (faded) and are placed again on release:
  // laying them out sixty times a second would be work nobody can read.
  const moving = useUiStore((state) => state.interactionActive);
  const [nodes, setNodes] = useState(live);
  useEffect(() => {
    // Synchronising with the gesture, which lives in another store: hold the last layout while it runs.
    // oxlint-disable-next-line react/set-state-in-effect
    if (!moving) setNodes(live);
  }, [live, moving]);
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // Clicking a shape to take it down also selects it; the ring and handles would then sit on top of
  // the strike-through. Dropped once per shape taken down, so selecting it afterwards still works.
  const selectedId = useEditorStore((state) => (state.selection.nodes.length === 1 && state.selection.edges.length === 0 ? state.selection.nodes[0]! : null));
  const cleared = useRef<string | null>(null);
  useEffect(() => {
    if (!down) cleared.current = null;
    else if (cleared.current !== down && selectedId === down) {
      cleared.current = down;
      useEditorStore.getState().setSelection({ nodes: [], edges: [] });
    }
  }, [down, selectedId]);

  // A tap anywhere else folds an unfolded note away again.
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  const headline = useMemo(() => {
    if (outage) return outage.headline;
    if (!down) return PICK;
    const gone = nodes.find((node) => node.id === down);
    return `${gone ? displayNameFor(gone) || 'That shape' : 'That shape'} takes no part in anything that runs here. Pick another.`;
  }, [outage, down, nodes]);
  const drawn = useMemo(() => layout(outage, nodes, headline), [outage, nodes, headline]);
  useFrameNotes(drawn?.extent ?? null, outage ? `${outage.target}:${outage.instances ? 'one' : 'all'}` : '');

  if (!analysis || !drawn) return null;
  const toggle = (id: string) => setOpen((current) => (current === id ? null : id));
  const onKey = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape' || open !== id) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(null);
  };
  // Pressing a note must not start a selection box or a pan underneath it.
  const hold = (event: PointerEvent) => event.stopPropagation();
  const kept = (note: OutageNote) => !!note.ask && (openPoints ?? []).some((point) => point.context === note.ask && point.targets.some((target) => target.id === note.focus[0]));
  const keep = (note: OutageNote) => {
    if (!note.ask || !note.focus[0]) return;
    useEditorStore.getState().addOpenPoint('awaiting', [{ kind: 'node', id: note.focus[0] }], note.ask);
  };
  const struck = outage ? nodes.filter((node) => (outage.instances ? node.id === outage.target : outage.lost.includes(node.id))) : [];

  return (
    <>
      <svg className="dc-outage-sketches" data-moving={moving || undefined} width={1} height={1} aria-hidden="true">
        {struck.map((node) => (
          <g key={`down:${node.id}:${outage!.instances ? 'one' : 'all'}`} className="dc-outage-sketch dc-outage-cross" style={{ '--dc-sketch-delay': '0ms' } as CSSProperties}>
            <path className="dc-sketch-stroke" pathLength={1} d={`M ${node.x + 6} ${node.y + 4} Q ${node.x + node.width * 0.46} ${node.y + node.height * 0.58} ${node.x + node.width - 4} ${node.y + node.height - 5}`} />
            {/* One instance of several is one stroke; the whole shape is struck out twice. */}
            {!outage!.instances && (
              <path className="dc-sketch-stroke dc-sketch-arrow" pathLength={1} d={`M ${node.x + node.width - 7} ${node.y + 5} Q ${node.x + node.width * 0.55} ${node.y + node.height * 0.44} ${node.x + 5} ${node.y + node.height - 4}`} />
            )}
          </g>
        ))}
        {drawn.notes.map((placed) => (
          <g key={placed.note.id} className="dc-outage-sketch" data-tone={placed.note.tone} style={{ '--dc-sketch-delay': `${placed.delay}ms` } as CSSProperties}>
            {placed.loops.map((loop) => (
              <path key={loop.key} className="dc-sketch-stroke dc-sketch-loop" d={loop.d} pathLength={1} />
            ))}
            {placed.arrows.map((arrow, index) => (
              <g key={index}>
                <path className="dc-sketch-stroke dc-sketch-arrow" d={arrow.shaft} pathLength={1} />
                <path className="dc-sketch-stroke dc-sketch-head" d={arrow.head} pathLength={1} />
              </g>
            ))}
          </g>
        ))}
      </svg>

      <div ref={root} className="dc-outage-notes" data-moving={moving || undefined} style={{ fontFamily: familyOf('hand') }}>
        <p
          className="dc-outage-headline dc-hand nodrag nopan nowheel"
          title={headline}
          style={{ transform: `translate(${drawn.headline.x}px, ${drawn.headline.y}px) rotate(-1deg)` }}
          onPointerDown={hold}
        >
          {drawn.headline.lines.map((line, index) => <Line key={index} className="dc-outage-headline-line" text={line} />)}
        </p>

        {drawn.notes.map((placed) => {
          const { note } = placed;
          const unfolded = open === note.id;
          return (
            <button
              key={note.id}
              type="button"
              className="dc-outage-note dc-hand nodrag nopan nowheel"
              data-tone={note.tone}
              data-plain={drawn.plain || undefined}
              data-up={placed.y > (drawn.extent.minY + drawn.extent.maxY) / 2 || undefined}
              aria-expanded={unfolded}
              style={
                {
                  transform: `translate(${placed.x}px, ${placed.y}px) rotate(${placed.tilt.toFixed(2)}deg)`,
                  '--dc-sketch-delay': `${placed.delay + 380}ms`,
                  '--dc-note-height': `${placed.label.height - (note.ask ? ACTION_ROOM : 0)}px`,
                  // The face the words were measured in (`layout`): set here, not inherited.
                  fontFamily: drawn.plain ? familyOf('sans') : undefined,
                } as CSSProperties
              }
              onPointerDown={hold}
              onClick={() => toggle(note.id)}
              onKeyDown={onKey(note.id)}
            >
              <span className="dc-outage-note-mark">
                {placed.label.lines.map((line, index) => <Line key={index} className="dc-outage-note-line" text={line} />)}
              </span>
              {unfolded && <span className="dc-outage-note-more">{note.text}</span>}
            </button>
          );
        })}

        {/* A question's answers sit under its words — siblings of the note, not buttons inside one. */}
        {drawn.notes.filter((placed) => placed.note.ask).map((placed) => {
          const { note } = placed;
          return (
            <div
              key={`answers:${note.id}`}
              className="dc-outage-actions nodrag nopan nowheel"
              role="group"
              aria-label={note.ask}
              style={
                {
                  transform: `translate(${placed.x + 4}px, ${placed.y + placed.label.height - ACTION_ROOM + 4}px)`,
                  fontFamily: familyOf('sans'),
                  '--dc-sketch-delay': `${placed.delay + 700}ms`,
                } as CSSProperties
              }
              onPointerDown={hold}
            >
              {note.fix && (
                <button type="button" data-primary="" onClick={() => applyOutageFix(note.fix!)}>
                  {outageFixLabel(note.fix)}
                </button>
              )}
              <button type="button" disabled={kept(note)} onClick={() => keep(note)}>
                {kept(note) ? 'Kept as open point' : 'Keep as open point'}
              </button>
            </div>
          );
        })}
      </div>

      <p className="dc-sr-only" role="status">
        {outage ? outageSummary(outage).join(' ') : headline}
      </p>
    </>
  );
});

/**
 * The walk's own strip, at the canvas edge and outside the zooming drawing: what the colours mean,
 * how much of a Service with several instances is down, and the way out.
 */
export function OutageStrip() {
  const outage = useEditorStore(outageIn);
  const whole = useEditorStore((state) => state.outage.whole);
  const instances = useEditorStore((state) => {
    const node = state.outage.down ? state.document.nodes.find((item) => item.id === state.outage.down) : undefined;
    return node?.type === 'service' ? (node.replicas ?? 1) : 1;
  });
  const editor = useEditorStore.getState;
  return (
    <Panel position="bottom-left" className="dc-outage-strip nodrag nopan nowheel" aria-label="Outage walk" data-dc-keyboard-region="">
      <span className="dc-outage-strip-title">Outage</span>
      {outage ? (
        <>
          <ul className="dc-outage-legend" aria-label="What the colours mean">
            <li data-key="fails">fails</li>
            <li data-key="absorbs">absorbs it</li>
            <li data-key="quiet">goes quiet</li>
          </ul>
          {instances >= 2 && (
            <span className="dc-outage-extent" role="group" aria-label="How much of it is down">
              <button type="button" aria-pressed={!whole} onClick={() => editor().takeDown(outage.target, false)}>One instance</button>
              <button type="button" aria-pressed={whole} onClick={() => editor().takeDown(outage.target, true)}>All {instances}</button>
            </span>
          )}
          <span>Click another shape to take it down instead</span>
        </>
      ) : (
        <span>Read from the drawing alone: no load or timing is assumed</span>
      )}
      <button type="button" onClick={() => editor().endOutage()}>{outage ? 'Bring it back up' : 'Done'}</button>
    </Panel>
  );
}

/** One measured line. The space after it is invisible between block lines, but keeps the words
 *  apart in what a screen reader says and what is copied. */
function Line({ className, text }: { className: string; text: string }) {
  return (
    <>
      <span className={className}>{text}</span>{' '}
    </>
  );
}

function boundsOf(nodes: readonly DraftNode[]): Bounds | null {
  if (nodes.length === 0) return null;
  return {
    minX: Math.min(...nodes.map((node) => node.x)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxX: Math.max(...nodes.map((node) => node.x + node.width)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height)),
  };
}

/** Where the notes go: each one's own few words, beside what it circles, clear of the shapes. */
function layout(outage: Outage | null, nodes: readonly DraftNode[], title: string) {
  const bounds = boundsOf(nodes);
  if (!bounds) return null;
  const rects = new Map<string, Rect>(nodes.map((node) => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
  const obstacles = nodes.filter((node) => node.type !== 'group').map((node) => rects.get(node.id)!);

  const chosen = (outage?.notes ?? []).filter((note) => note.focus.some((id) => rects.has(id))).slice(0, MAX_NOTES);
  const plain = chosen.length > HANDWRITTEN_NOTES;
  const labelFor = (note: OutageNote) => {
    const text = layoutText(note.note, {
      font: plain
        ? { stack: 'sans', size: 13, weight: note.tone === 'question' ? 500 : 600 }
        : { stack: 'hand', size: 17, weight: note.tone === 'question' ? 600 : 700 },
      maxWidth: 244,
      lineHeight: plain ? PLAIN_LINE_HEIGHT : LINE_HEIGHT,
      maxLines: 3,
    });
    const answers = note.ask ? (note.fix ? ACTION_WIDTH.two : ACTION_WIDTH.one) : 0;
    return {
      width: Math.max(Math.ceil(text.width) + 8, answers),
      height: text.height + 2 + (note.ask ? ACTION_ROOM : 0),
      lines: text.lines.map((line) => line.text),
    };
  };
  const requests: SketchRequest[] = chosen.map((note, index) => ({
    id: note.id,
    targets: note.focus.filter((id) => rects.has(id)).map((id) => rects.get(id)!),
    label: labelFor(note),
    priority: index,
  }));
  // The headline's own corner is taken before any note is placed.
  const titleLayout = layoutText(title, { font: { stack: 'hand', size: 22, weight: 700 }, maxWidth: 600, lineHeight: 26.4, maxLines: 3 });
  const headline = {
    x: bounds.minX,
    y: bounds.minY - Math.max(104, titleLayout.height + 24),
    lines: titleLayout.lines.map((line) => line.text),
  };
  const headlineRect = { x: headline.x, y: headline.y, width: Math.ceil(titleLayout.width), height: titleLayout.height };
  const placed = placeSketches(requests, [...obstacles, headlineRect], { gap: 30 });

  // One loop per shape: a second note about the same shape points at the loop already there.
  const looped = new Set<string>();
  const byId = new Map(chosen.map((note) => [note.id, note]));
  const notes: Placed[] = placed.map((sketch, order) => {
    const rng = createRng(`note:${sketch.id}`);
    const loops: Placed['loops'] = [];
    sketch.rings.forEach((ring, index) => {
      const place = `${ring.x}:${ring.y}`;
      if (looped.has(place)) return;
      looped.add(place);
      loops.push({ key: `${sketch.id}:${index}`, d: markerLoop(ring, `${sketch.id}:${index}`) });
    });
    return {
      note: byId.get(sketch.id)!,
      delay: FIRST_STROKE_MS + order * STROKE_STAGGER_MS,
      loops,
      // A note about several shapes points at every one of them: a loop with no words beside it
      // reads as a different note, or none.
      arrows: [
        markerArrow(sketch.arrow, sketch.id),
        ...sketch.rings.slice(1).map((ring, index) => markerArrow(arrowFor(sketch.label, ring), `${sketch.id}:${index + 1}`)),
      ],
      x: sketch.label.x,
      y: sketch.label.y,
      tilt: (rng() - 0.5) * 3,
      label: sketch.label,
    };
  });
  // Everything written, shapes included: what the camera has to show for the notes to be read.
  const extent = { ...bounds, minY: headline.y, maxX: Math.max(bounds.maxX, headlineRect.x + headlineRect.width) };
  for (const note of notes) {
    extent.minX = Math.min(extent.minX, note.x);
    extent.minY = Math.min(extent.minY, note.y);
    extent.maxX = Math.max(extent.maxX, note.x + note.label.width);
    extent.maxY = Math.max(extent.maxY, note.y + note.label.height);
  }
  return { notes, headline, extent, plain };
}

/**
 * A walk writes on the diagram, so the diagram — and the room its notes need — has to be in view:
 * once per shape taken down, the camera eases out just enough when it isn't. Never zooms in, and
 * never moves again until another shape is chosen.
 */
function useFrameNotes(extent: Bounds | null, key: string) {
  const { getViewport, setViewport } = useReactFlow();
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (framed.current === key || !extent) return;
    const frame = requestAnimationFrame(() => {
      const pane = window.document.querySelector('.dc-canvas')?.getBoundingClientRect();
      if (!pane) return;
      // Spent only once it has actually looked: a render that cancels this frame must not use it up.
      framed.current = key;
      const minX = extent.minX - 16;
      const minY = extent.minY - 8;
      const maxX = extent.maxX + 16;
      const maxY = extent.maxY + 16;
      const { x, y, zoom } = getViewport();
      const fits = x + minX * zoom >= 0 && y + minY * zoom >= TOP_CLEARANCE && x + maxX * zoom <= pane.width && y + maxY * zoom <= pane.height - BOTTOM_CLEARANCE;
      if (fits) return;
      const next = Math.max(0.1, Math.min(zoom, (pane.width - FRAME_MARGIN * 2) / (maxX - minX), (pane.height - TOP_CLEARANCE - BOTTOM_CLEARANCE - FRAME_MARGIN) / (maxY - minY)));
      void setViewport(
        {
          x: (pane.width - (maxX - minX) * next) / 2 - minX * next,
          y: TOP_CLEARANCE + (pane.height - TOP_CLEARANCE - BOTTOM_CLEARANCE - (maxY - minY) * next) / 2 - minY * next,
          zoom: next,
        },
        { duration: motionMs(420) },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [extent, key, getViewport, setViewport]);
}
