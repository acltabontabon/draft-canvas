import { useTrafficReplay } from './TrafficReplayContext';
import { MAX_REPLAY_MESSAGES, recoveryArrivals } from '../traffic/recovery';
import { TrafficRecovery } from './TrafficRecovery';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { displayNameFor } from '../document/factory';
import { familyOf } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { DraftNode } from '../document/types';
import { motionMs } from '../lib/motion';
import { createRng } from '../render/roughness/seed';
import { useEditorStore, viewLevel } from '../store/editorStore';
import { trafficOf, trafficScenarioOf } from '../store/traffic';
import { useUiStore } from '../store/uiStore';
import type { TrafficAnalysis, TrafficInsight } from '../traffic';
import { arrowFor, placeSketches, type Rect, type SketchRequest } from '../traffic/sketchLayout';
import { markerArrow, markerLoop } from './trafficSketchPaths';
import { trafficCalloutFor } from './trafficCallout';
import { placeCallout } from '../traffic/calloutLayout';

/**
 * Traffic, told on the canvas — the way someone reviewing the diagram would mark up a whiteboard.
 *
 * At a glance: a handwritten headline above the diagram, and beside the shapes that matter a marker
 * loop, a few words ("no fallback!", "3 services, one store", "only way in") and an arrow flicked
 * from one to the other, with the hops of the longest wait numbered along the way. On demand: tap a
 * note and it unfolds, in place, into the whole explanation in quiet type; tap the headline's
 * "+N open questions" for what the diagram leaves unsaid; select a shape and its blast radius is
 * written beside it. Nothing else — no panel competing with the drawing.
 *
 * Drawn in flow space, so it pans with the shapes; the selected shape's field note keeps a readable
 * type size at every zoom. Only shown while traffic shows. Chrome,
 * not content: nothing here is saved, undone, shared or exported, and nothing can be dragged. The
 * notes are buttons, so a keyboard reaches each one, and the findings are announced as they appear.
 * Every stroke draws itself on in turn after the traffic has spread; under reduced motion it is
 * simply there.
 */

/** A glance, not a report: past this many notes the canvas would be written over. */
const MAX_SKETCHES = 7;
const LINE_HEIGHT = 21;
/** The traffic wave has spread by then (`.dc-traffic-flow`'s per-hop delay). */
const FIRST_STROKE_MS = 1100;
const STROKE_STAGGER_MS = 520;
const FRAME_MARGIN = 40;
/** The toolbar floats over the top of the canvas; the headline must clear it. */
const TOP_CLEARANCE = 76;
const BOTTOM_CLEARANCE = 76;

interface Note {
  insight: TrafficInsight;
  delay: number;
  loops: { key: string; d: string }[];
  arrows: { shaft: string; head: string }[];
  x: number;
  y: number;
  tilt: number;
  label: Rect & { lines: string[] };
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function boundsOf(nodes: readonly DraftNode[]): Bounds | null {
  if (nodes.length === 0) return null;
  return {
    minX: Math.min(...nodes.map((node) => node.x)),
    minY: Math.min(...nodes.map((node) => node.y)),
    maxX: Math.max(...nodes.map((node) => node.x + node.width)),
    maxY: Math.max(...nodes.map((node) => node.y + node.height)),
  };
}

export function TrafficSketches() {
  const analysis = useEditorStore(trafficOf);
  const edges = useEditorStore((state) => state.document.edges);
  const trafficScope = useEditorStore((state) => state.traffic.flowId);
  const scenario = useEditorStore(trafficScenarioOf);
  const live = useEditorStore((state) => (state.traffic.active ? state.document.nodes : null));
  const level = useEditorStore(viewLevel);
  const selectedId = useEditorStore((state) =>
    state.selection.nodes.length === 1 && state.selection.edges.length === 0 ? state.selection.nodes[0]! : null,
  );
  const selectedEdgeId = useEditorStore((state) => state.selection.edges.length === 1 && state.selection.nodes.length === 0 ? state.selection.edges[0]! : null);
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
  const { replay, setReplay, revision: replayRevision } = useTrafficReplay();
  // Selection only opens a reading. Keep the scenario until Traffic closes or its graph changes.
  const activeReplay = replay?.analysis === analysis ? replay : null;
  const root = useRef<HTMLDivElement>(null);


  // A tap anywhere else folds an unfolded note away again.
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  const headline = analysis && nodes ? headlineOf(analysis, level, nodes) : '';
  const drawn = useMemo(() => (analysis && nodes ? layout(analysis, nodes, headline) : null), [analysis, nodes, headline]);
  useFrameNotes(drawn?.extent ?? null);
  const camera = useStore((state) => state.transform);
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const visible = useMemo(() => {
    const [x, y, zoom] = camera;
    return canvasWidth > 32 && canvasHeight > TOP_CLEARANCE + 24 ? {
      x: (16 - x) / zoom,
      y: (TOP_CLEARANCE - y) / zoom,
      width: (canvasWidth - 32) / zoom,
      height: (canvasHeight - TOP_CLEARANCE - 24) / zoom,
    } : undefined;
  }, [camera, canvasWidth, canvasHeight]);
  const availableWidth = canvasWidth > 32 ? canvasWidth - 32 : undefined;
  const content = useMemo(
    () => {
      if (!analysis || !nodes || !drawn) return null;
      const anchorId = selectedId ?? edges.find((edge) => edge.id === selectedEdgeId)?.source;
      return anchorId ? trafficCalloutFor(analysis, nodes, anchorId, drawn.obstacles, availableWidth, selectedId ? scenario?.get(selectedId) : undefined, edges, selectedEdgeId ?? undefined) : null;
    },
    [analysis, nodes, drawn, selectedId, selectedEdgeId, availableWidth, scenario, edges],
  );
  const dlqNotes = useMemo(() => {
    if (!analysis || !nodes) return [];
    return nodes.filter((node) => node.deliveryRole === 'dead-letter').map((node) => {
      const hasRoute = analysis.interactions.some((item) => item.from === node.id && item.workload);
      const count = node.id === activeReplay?.id ? activeReplay.count : null;
      const valid = count !== null && count !== undefined && Number.isSafeInteger(count) && count >= 0 && count <= MAX_REPLAY_MESSAGES;
      const label = !hasRoute ? 'No replay path drawn.' : !valid ? 'Work waits here until replayed.'
        : count === 0 ? 'Nothing to replay in this example.' : `${count.toLocaleString('en-US')} ${count === 1 ? 'message' : 'messages'} to replay.`;
      return { node, label, text: layoutText(label, { font: { stack: 'hand', size: 14, weight: 400 }, maxWidth: 260, lineHeight: 19 }) };
    });
  }, [analysis, nodes, activeReplay]);
  const replayBadges = useMemo(() => {
    if (!analysis || !nodes || !activeReplay || activeReplay.count === null) return [];
    const counts = recoveryArrivals(analysis, activeReplay.plan, activeReplay.count);
    if (counts.size === 0) return [];
    return nodes.flatMap((node) => {
      const count = counts.get(node.id);
      const baseline = scenario?.get(node.id);
      if (!count && !baseline) return [];
      const amount = !count ? null : count.definite === count.possible ? count.possible.toLocaleString('en-US') : `${count.definite.toLocaleString('en-US')}–${count.possible.toLocaleString('en-US')}`;
      const label = !count ? baseline! : `Replay +${amount} ${analysis.nodes.get(node.id)?.role === 'data' ? 'data ops' : 'arrivals'} total`;
      return [{ node, label, baseline: count ? baseline : undefined, recovery: !!count, text: layoutText(label, { font: { stack: 'sans', size: 12, weight: 600 }, maxWidth: node.width - 12, lineHeight: 16 }) }];
    });
  }, [analysis, nodes, activeReplay, scenario]);
  const sharedWork = useMemo(() => {
    if (!content || !selectedId || !activeReplay || activeReplay.count === null
      || !Number.isSafeInteger(activeReplay.count) || activeReplay.count <= 0 || activeReplay.count > MAX_REPLAY_MESSAGES
      || !activeReplay.plan.shared.includes(selectedId)) return null;
    return layoutText('Replay and normal traffic can use this resource.', {
      font: { stack: 'sans', size: 12, weight: 400 }, maxWidth: content.width - 66, lineHeight: 18,
    });
  }, [content, selectedId, activeReplay]);
  const callout = useMemo(
    () => {
      if (!content) return null;
      // This is reading chrome. Its type stays readable when the drawing is zoomed out, while its
      // footprint is converted back to flow space for the same collision checks as the findings.
      const scale = 1 / camera[2];
      const controlWidth = Math.min(360, canvasWidth - 32);
      const controls = { x: (16 - camera[0]) * scale, y: (canvasHeight - BOTTOM_CLEARANCE - camera[1]) * scale, width: controlWidth * scale, height: BOTTOM_CLEARANCE * scale };
      const obstacles = [...content.obstacles, controls, ...dlqNotes.map(({ node, text }) => ({ x: node.x, y: node.y + node.height + 10, width: 260, height: text.height }))];
      // Let the field note unfold when there is room; on crowded canvases try shorter scrollable
      // notes before allowing an overlap. Reserve its expanded height to avoid a jump when opened.
      const workHeight = content.work ? content.work.items.reduce((sum, item) => sum + item.height + 6, 0) + content.work.detail.height + 30 : 0;
      const desired = Math.min(content.height + (sharedWork ? sharedWork.height + 45 : 0) + workHeight + (content.databaseNote ? 160 : 0) + (content.recovery ? 220 : 0), visible ? visible.height / scale : 420);
      const heights = [...new Set([desired, Math.min(desired, 420), Math.min(desired, 360), Math.min(desired, 300), Math.min(desired, 270)])];
      let maxHeight = heights[heights.length - 1]!;
      let at = placeCallout(content.anchor, content.width * scale, maxHeight * scale, obstacles, visible);
      for (const height of heights) {
        const candidate = placeCallout(content.anchor, content.width * scale, height * scale, obstacles, visible);
        if (![content.anchor, ...obstacles].every((rect) => candidate.x + candidate.width <= rect.x - 6 || candidate.x >= rect.x + rect.width + 6 || candidate.y + candidate.height <= rect.y - 6 || candidate.y >= rect.y + rect.height + 6)) continue;
        at = candidate;
        maxHeight = height;
        break;
      }
      return { ...content, x: at.x, y: at.y, scale, maxHeight };
    },
    [content, visible, camera, canvasWidth, canvasHeight, dlqNotes, sharedWork],
  );

  if (!analysis || !nodes || !drawn) return null;
  const toggle = (id: string) => setOpen((current) => (current === id ? null : id));
  const onKey = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape' || open !== id) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(null);
  };
  // Pressing a note must not start a selection box or a pan underneath it.
  const hold = (event: PointerEvent) => event.stopPropagation();
  const questions = analysis.insights.filter((insight) => insight.severity === 'unknown' && !drawn.notes.some((note) => note.insight.id === insight.id));

  return (
    <>
      <svg className="dc-traffic-sketches" data-moving={moving || undefined} width={1} height={1} aria-hidden="true" style={{ fontFamily: familyOf('hand') }}>
        {drawn.marks.map((mark, index) => (
          <g key={mark.id} className="dc-traffic-sketch dc-traffic-hop" style={{ '--dc-sketch-delay': `${FIRST_STROKE_MS + index * 120}ms` } as CSSProperties}>
            <path className="dc-sketch-stroke" d={mark.loop} pathLength={1} />
            <text className="dc-sketch-text dc-sketch-hop" x={mark.x} y={mark.y} textAnchor="middle" dominantBaseline="central">
              {mark.n}
            </text>
          </g>
        ))}
        {drawn.notes.map((note) => (
          <g
            key={note.insight.id}
            className="dc-traffic-sketch"
            data-tone={note.insight.severity}
            data-open={open === note.insight.id || undefined}
            style={{ '--dc-sketch-delay': `${note.delay}ms` } as CSSProperties}
          >
            {note.loops.map((loop) => (
              <path key={loop.key} className="dc-sketch-stroke dc-sketch-loop" d={loop.d} pathLength={1} />
            ))}
            {note.arrows.map((arrow, index) => (
              <g key={index}>
                <path className="dc-sketch-stroke dc-sketch-arrow" d={arrow.shaft} pathLength={1} />
                <path className="dc-sketch-stroke dc-sketch-head" d={arrow.head} pathLength={1} />
              </g>
            ))}
          </g>
        ))}
      </svg>

      <div ref={root} className="dc-traffic-notes" data-moving={moving || undefined} style={{ fontFamily: familyOf('hand') }}>
        <div
          className="dc-traffic-headline-note nodrag nopan nowheel"
          style={{ transform: `translate(${drawn.headline.x}px, ${drawn.headline.y}px) rotate(-1deg)` }}
          onPointerDown={hold}
        >
          <p className="dc-hand dc-hand-title" title={headline}>
            {drawn.headline.lines.map((line, index) => <span key={index} className="dc-hand-title-line">{line}</span>)}
          </p>
          {questions.length > 0 && (
            <>
              <button
                type="button"
                className="dc-hand dc-hand-link"
                aria-expanded={open === 'questions'}
                onClick={() => toggle('questions')}
                onKeyDown={onKey('questions')}
              >
                + {questions.length} {questions.length === 1 ? 'open question' : 'open questions'}
              </button>
              {open === 'questions' && (
                <ul className="dc-hand dc-hand-list">
                  {questions.map((insight) => (
                    <li key={insight.id}>{insight.text}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {dlqNotes.map(({ node, label, text }) => (
          <div key={node.id} className="dc-traffic-dlq-note" aria-label={label} style={{ transform: `translate(${node.x}px, ${node.y + node.height + 10}px)`, width: 260 }}>
            {text.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line.text}{' '}</span>)}
          </div>
        ))}
        {replayBadges.map(({ node, label, text, baseline, recovery }) => (
          <div key={node.id} className={recovery ? "dc-traffic-replay-badge" : "dc-traffic-baseline-chip"} aria-label={baseline ? `${baseline}; ${label}` : label} style={{ fontFamily: familyOf('sans'), transform: `translate(${node.x + 6}px, ${node.y - 12}px)`, width: node.width }}>
            {baseline && <span className="dc-traffic-chip-normal">{baseline}</span>}
            {text.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line.text}{' '}</span>)}
          </div>
        ))}
        {drawn.notes.map((note) => {
          const unfolded = open === note.insight.id;
          return (
            <button
              key={note.insight.id}
              type="button"
              className="dc-traffic-note dc-hand nodrag nopan nowheel"
              data-tone={note.insight.severity}
              // In the lower half of what is written, the rest of the thought goes up, not off the board.
              data-up={note.y > (drawn.extent.minY + drawn.extent.maxY) / 2 || undefined}
              aria-expanded={unfolded}
              style={
                {
                  transform: `translate(${note.x}px, ${note.y}px) rotate(${note.tilt.toFixed(2)}deg)`,
                  '--dc-sketch-delay': `${note.delay + 380}ms`,
                  '--dc-note-height': `${note.label.height}px`,
                } as CSSProperties
              }
              onPointerDown={hold}
              onClick={() => toggle(note.insight.id)}
              onKeyDown={onKey(note.insight.id)}
            >
              <span className="dc-traffic-note-mark">
                {note.label.lines.map((line, index) => <span key={index} className="dc-traffic-note-line">{line}</span>)}
              </span>
              {unfolded && <span className="dc-traffic-note-more">{note.insight.text}</span>}
            </button>
          );
        })}

        {callout && (
          <div
            className="dc-traffic-callout nodrag nopan nowheel"
            style={{ transform: `translate(${callout.x}px, ${callout.y}px) scale(${callout.scale})`, width: callout.width, maxHeight: callout.maxHeight }}
            onPointerDown={hold}
            role="note"
            tabIndex={0}
            data-dc-keyboard-region=""
            aria-label={callout.description}
            onKeyDown={(event) => {
              if (event.target instanceof HTMLInputElement && event.key !== 'Escape') return;
              // On WebKit, Backspace on a focused read-only surface can navigate browser history.
              if (event.key === 'Backspace' || event.key === 'Delete') {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              useEditorStore.getState().setSelection({ nodes: [], edges: [] });
              event.currentTarget.closest<HTMLElement>('.dc-canvas')?.focus();
            }}
          >
            <div className="dc-traffic-callout-heading">
              <div className="dc-traffic-callout-title" title={callout.title.text}>
                {callout.title.lines.map((line, index) => <span key={index} className="dc-traffic-callout-line">{line}</span>)}
              </div>
              <span className="dc-traffic-callout-kicker">{selectedId && scenario?.has(selectedId) ? 'Example' : 'Traffic'}</span>
            </div>
            <div className="dc-traffic-callout-metric" style={{ fontFamily: familyOf('hand'), fontSize: callout.metricSize }}>
              {callout.metric}
              <svg width="72" height="7" viewBox="0 0 72 7" aria-hidden="true"><path d="M2 4 Q27 1 68 3 M6 6 Q33 4 54 5" /></svg>
            </div>
            {callout.summary && <p className="dc-traffic-callout-summary">{callout.summary.lines.map((line, index) => <span key={index} className="dc-traffic-callout-line">{line}</span>)}</p>}
            {sharedWork && (
              <section className="dc-traffic-shared-work" aria-label="Shared workload">
                <h3 style={{ fontFamily: familyOf('hand') }}>Shared workload</h3>
                <p>{sharedWork.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line.text}{' '}</span>)}</p>
              </section>
            )}
            {callout.sources.length > 0 && (
              <ul className="dc-traffic-callout-sources" aria-label="Rate breakdown" data-rates={callout.work ? true : undefined}>
                {callout.sources.map((source, index) => (
                  <li key={index}>
                    <span title={source.name.text}>{source.name.lines.map((line, index) => <span key={index} className="dc-traffic-callout-line">{line}</span>)}</span>
                    <span className="dc-traffic-callout-count">{source.count}</span>
                  </li>
                ))}
                {callout.moreSources > 0 && <li className="dc-traffic-callout-more">+ {callout.moreSources} more connections</li>}
              </ul>
            )}
            {callout.crossingNote && (
              <section className="dc-traffic-crossings" aria-label="Boundary crossings">
                <h3 style={{ fontFamily: familyOf('hand') }}>Across boundaries</h3>
                {callout.crossingNote.rows.length === 0 && <p>No boundary crossing drawn.</p>}
                {callout.crossingNote.rows.map((row, index) => (
                  <div className="dc-traffic-crossing" key={index}>
                    <strong title={row.route.text}>{row.route.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}{' '}</span>)}</strong>
                    <p>{row.detail.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}{' '}</span>)}</p>
                    {row.boundaries && <p title={row.boundaries.text}>{row.boundaries.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}{' '}</span>)}</p>}
                  </div>
                ))}
                {callout.crossingNote.more > 0 && <p>+ {callout.crossingNote.more} more routes</p>}
              </section>
            )}
            {callout.databaseNote && (
              <details className="dc-traffic-work dc-traffic-database" key={`database:${selectedId}`}>
                <summary style={{ fontFamily: familyOf('hand') }}>Database work</summary>
                <div className="dc-traffic-work-paper">
                  <ul aria-label="Database work">
                    {callout.databaseNote.items.map((item, index) => <li key={index}>{item.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</li>)}
                  </ul>
                  <p>{callout.databaseNote.detail.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</p>
                </div>
              </details>
            )}
            {callout.work && (
              <details className="dc-traffic-work" key={selectedId}>
                <summary style={{ fontFamily: familyOf('hand') }}>{callout.work.heading}</summary>
                <div className="dc-traffic-work-paper">
                  <ul aria-label="Work per arrival">
                    {callout.work.items.map((item, index) => <li key={index}>{item.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</li>)}
                  </ul>
                  <p>{callout.work.detail.lines.map((line, index) => <span className="dc-traffic-callout-line" key={index}>{line}</span>)}</p>
                </div>
              </details>
            )}
            {callout.recovery && <TrafficRecovery key={`${selectedId}:${trafficScope}:${replayRevision}`} analysis={analysis} nodes={nodes} plan={callout.recovery} initialCount={activeReplay?.id === selectedId ? activeReplay.count ?? 1 : 1} onExplore={(count) => setReplay({ id: selectedId!, analysis, plan: callout.recovery!, count })} width={callout.width - 46} />}
            {callout.sections.map((section) => (
              <section key={section.label} className="dc-traffic-callout-section" data-tone={section.tone} aria-label={section.label}>
                <h3>{section.label}</h3>
                {section.detail && <p className="dc-traffic-callout-detail">{section.detail.lines.map((line, index) => <span key={index} className="dc-traffic-callout-line">{line}</span>)}</p>}
                <ul>
                  {section.items.map((item, index) => <li key={index} title={item.text}>{item.lines.map((line, index) => <span key={index} className="dc-traffic-callout-line">{line}</span>)}</li>)}
                  {section.more > 0 && <li className="dc-traffic-callout-more">+ {section.more} more</li>}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <p className="dc-sr-only" role="status">
        {[headline, ...drawn.notes.map((note) => note.insight.text)].join(' ')}
      </p>
    </>
  );
}

/** Where the notes go: the finding's own few words, beside what it circles, clear of the shapes. */
function layout(analysis: TrafficAnalysis, nodes: readonly DraftNode[], title: string) {
  if (nodes.length === 0) return null;
  const rects = new Map<string, Rect>(nodes.map((node) => [node.id, { x: node.x, y: node.y, width: node.width, height: node.height }]));
  const obstacles = nodes.filter((node) => node.type !== 'group').map((node) => rects.get(node.id)!);
  const bounds = boundsOf(nodes)!;

  const chosen = analysis.insights.filter((insight) => insight.note && insight.focus?.some((id) => rects.has(id))).slice(0, MAX_SKETCHES);
  const requests: SketchRequest[] = [];
  const labelFor = (insight: TrafficInsight) => {
    const text = layoutText(insight.note!, {
      font: { stack: 'hand', size: 17, weight: insight.severity === 'unknown' ? 600 : 700 },
      maxWidth: 244,
      lineHeight: LINE_HEIGHT,
      maxLines: 3,
    });
    return { width: Math.ceil(text.width) + 8, height: text.height + 2, lines: text.lines.map((line) => line.text) };
  };
  const numbered: { id: string; at: Rect; n: number }[] = [];
  chosen.forEach((insight, index) => {
    const focus = insight.focus!.filter((id) => rects.has(id));
    if (insight.kind === 'sync-chain') {
      // The chain is numbered hop by hop; its note points at where the wait ends.
      focus.forEach((id, hop) => numbered.push({ id: `${insight.id}:${id}`, at: rects.get(id)!, n: hop + 1 }));
      requests.push({ id: insight.id, targets: [rects.get(focus[focus.length - 1]!)!], label: labelFor(insight), priority: index });
      return;
    }
    requests.push({ id: insight.id, targets: focus.map((id) => rects.get(id)!), label: labelFor(insight), priority: index });
  });
  // The headline's own corner is taken before any note is placed.
  const titleLayout = layoutText(title, {
    font: { stack: 'hand', size: 22, weight: 700 },
    maxWidth: 560,
    lineHeight: 26.4,
    maxLines: 3,
  });
  const questions = analysis.insights.filter((insight) => insight.severity === 'unknown' && !chosen.some((note) => note.id === insight.id)).length;
  const linkWidth = questions > 0 ? layoutText(`+ ${questions} ${questions === 1 ? 'open question' : 'open questions'}`, {
    font: { stack: 'hand', size: 15, weight: 700 },
    maxWidth: 560,
    lineHeight: 21,
  }).width : 0;
  const headlineHeight = titleLayout.height + (questions > 0 ? 25 : 0);
  const headline = {
    x: bounds.minX,
    y: bounds.minY - Math.max(104, headlineHeight + 24),
    lines: titleLayout.lines.map((line) => line.text),
  };
  const headlineRect = { x: headline.x, y: headline.y, width: Math.ceil(Math.max(titleLayout.width, linkWidth)), height: headlineHeight };
  const placed = placeSketches(requests, [...obstacles, headlineRect], {
    gap: 30,
  });

  // One loop per shape: a second finding about the same shape points at the loop already there.
  const looped = new Set<string>();
  const byId = new Map(chosen.map((insight) => [insight.id, insight]));
  const notes: Note[] = placed.map((sketch, order) => {
    const rng = createRng(`note:${sketch.id}`);
    const loops: Note['loops'] = [];
    sketch.rings.forEach((ring, index) => {
      const place = `${ring.x}:${ring.y}`;
      if (looped.has(place)) return;
      looped.add(place);
      loops.push({ key: `${sketch.id}:${index}`, d: markerLoop(ring, `${sketch.id}:${index}`) });
    });
    return {
      insight: byId.get(sketch.id)!,
      delay: FIRST_STROKE_MS + order * STROKE_STAGGER_MS,
      loops,
      // A note about several shapes points at every one of them: a loop with no words beside it reads
      // as a different finding, or none.
      arrows: [
        markerArrow(sketch.arrow, sketch.id),
        ...sketch.rings.slice(1).map((ring, index) => markerArrow(arrowFor(sketch.label, ring), `${sketch.id}:${index + 1}`)),
      ],
      x: sketch.label.x,
      y: sketch.label.y,
      tilt: (rng() - 0.5) * 4,
      label: sketch.label,
    };
  });
  const marks = numbered.map(({ id, at, n }) => ({
    id,
    n,
    x: at.x - 6,
    y: at.y - 6,
    loop: markerLoop({ x: at.x - 17, y: at.y - 17, width: 22, height: 22 }, id),
  }));
  // Everything written, shapes included: what the camera has to show for the notes to be read.
  const extent = { ...bounds, minY: headline.y, maxX: Math.max(bounds.maxX, headlineRect.x + headlineRect.width) };
  for (const note of notes) {
    extent.minX = Math.min(extent.minX, note.x);
    extent.minY = Math.min(extent.minY, note.y);
    extent.maxX = Math.max(extent.maxX, note.x + note.label.width);
    extent.maxY = Math.max(extent.maxY, note.y + note.label.height);
  }
  return { notes, marks, headline, extent, obstacles: [headlineRect, ...notes.map((note) => note.label)] };
}

function listOf(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} +${rest}`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} & ${shown[shown.length - 1]}`;
}

function headlineOf(analysis: TrafficAnalysis, level: ReturnType<typeof viewLevel>, nodes: readonly DraftNode[]): string {
  const name = (id: string) => {
    const node = nodes.find((item) => item.id === id);
    return node ? displayNameFor(node) : 'Untitled';
  };
  if (analysis.status === 'nothing-to-analyze') {
    return level === 'component'
      ? 'These are the parts inside one service — step out to see traffic between services.'
      : 'Nothing here carries traffic yet — connect services, queues and data stores.';
  }
  if (analysis.status === 'recovery-only') return 'Recovery paths only — select a DLQ or compensation source to follow the work.';
  if (analysis.status === 'no-entry') return 'Everything is reached from something else — draw what starts the traffic.';
  const top = analysis.hotspots.filter((id) => analysis.nodes.get(id)?.tier === 'top');
  if (top.length === 0) return 'Traffic doesn’t pile up anywhere — every part is reached by one path.';
  return `Most paths meet at ${listOf(top.map(name))}`;
}

/**
 * Showing traffic writes on the diagram, so the diagram — and the room its notes need — has to be in
 * view: once, as traffic turns on, the camera eases out just enough when it isn't. Never zooms in,
 * never moves again on its own.
 */
function useFrameNotes(extent: Bounds | null) {
  const { getViewport, setViewport } = useReactFlow();
  const once = useRef(false);
  useEffect(() => {
    if (once.current || !extent) return;
    const frame = requestAnimationFrame(() => {
      const pane = window.document.querySelector('.dc-canvas')?.getBoundingClientRect();
      if (!pane) return;
      // Spent only once it has actually looked: a render that cancels this frame must not use it up.
      once.current = true;
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
  }, [extent, getViewport, setViewport]);
}
