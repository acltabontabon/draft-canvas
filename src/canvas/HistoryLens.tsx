import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import { viewOf } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { motionMs, prefersReducedMotion } from '../lib/motion';
import { PRESENTATION_INSETS } from '../presentation/useFlowPlayback';
import { frameRevision } from '../presentation/revisionFraming';
import { renderDocumentSvg } from '../render/svg/document';
import { closeLens } from '../store/evolution/historyView';
import { useEvolutionStore } from '../store/evolution/evolutionStore';
import { deviceStyle } from '../store/styleStore';
import { usePersonality } from '../theme/usePersonality';
import { useTheme } from '../theme/useTheme';
import { ViewportLayer } from './ViewportLayer';

/**
 * The history lens: a past revision drawn where the live diagram is, privately and read-only.
 *
 * It is drawn by the shared scene renderer (`renderDocumentSvg`) — the display lists the canvas and
 * every export share (`nodes/describe.ts`, `edges/describe.ts`), with the revision's own style and
 * routing — so a revision looks as it did, never as a ghost of it. The live layers are hidden while
 * it is up (`.react-flow:has(.dc-history-lens)` in canvas.css) and keep receiving changes underneath.
 *
 * Moving between revisions is a transition, not a swap: shapes in both glide from where they were,
 * new ones arrive, removed ones fade from the outgoing picture. A newer step cancels the one in
 * flight, and reduced motion shows each revision at once.
 */

const GLIDE_MS = 420;
const FADE_MS = 360;

interface Painted {
  html: string;
  origin: { x: number; y: number };
  view: DraftDocument;
}

function paint(view: DraftDocument, themeName: 'light' | 'dark', preset: ReturnType<typeof usePersonality>['preset'], scope: string): Painted {
  const rendered = renderDocumentSvg(view, {
    theme: themeName,
    deviceStyle: deviceStyle(),
    preset,
    transparent: true,
    identifyElements: true,
    idScope: scope,
    openPointKey: false,
    legend: false,
    padding: 0,
  });
  return { html: rendered.svg, origin: rendered.origin, view };
}

function positions(view: DraftDocument): Map<string, { x: number; y: number }> {
  return new Map(view.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

export function HistoryLens() {
  const lens = useEvolutionStore((state) => state.lens);
  const focus = useEvolutionStore((state) => state.playback.focus);
  const { name: themeName } = useTheme();
  const { preset } = usePersonality();
  const flow = useReactFlow();
  const incoming = useRef<HTMLDivElement>(null);
  const outgoing = useRef<HTMLDivElement>(null);
  const running = useRef<Animation[]>([]);

  const view = useMemo(() => (lens ? (viewOf(lens.file, lens.path) ?? lens.file) : null), [lens]);
  const previousView = useMemo(() => (lens?.previous ? (viewOf(lens.previous, lens.path) ?? null) : null), [lens]);
  const current = useMemo(() => (view && lens ? paint(view, themeName, preset, `history-lens-${lens.step}`) : null), [view, lens, themeName, preset]);
  const before = useMemo(() => (previousView && lens ? paint(previousView, themeName, preset, `history-lens-out-${lens.step}`) : null), [previousView, lens, themeName, preset]);

  // The transition, once per step: everything from the last one is cancelled first.
  useLayoutEffect(() => {
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const into = incoming.current;
    const out = outgoing.current;
    if (!lens || !current || !into) return;
    const reduced = prefersReducedMotion();
    if (out) out.style.opacity = '0';
    if (reduced || !before) {
      if (lens.oid === 'live') closeLens();
      return;
    }
    const was = positions(before.view);
    const now = positions(current.view);
    const play = (element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = element.animate(frames, { fill: 'backwards', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', ...options });
      running.current.push(animation);
      return animation;
    };
    for (const element of into.querySelectorAll<SVGGElement>('[data-diagram-node]')) {
      const id = element.getAttribute('data-diagram-node')!;
      const from = was.get(id);
      const to = now.get(id);
      if (!from) {
        // `translate`/`scale`, not `transform`: a shape's group is placed by its own transform attribute,
        // which the individual properties compose with and `transform` would replace.
        play(element, [{ opacity: 0, scale: '0.97' }, { opacity: 1, scale: '1' }], { duration: GLIDE_MS, delay: 80 });
        element.style.transformBox = 'fill-box';
        element.style.transformOrigin = 'center';
      } else if (to && (from.x !== to.x || from.y !== to.y)) {
        play(element, [{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: '0px 0px' }], { duration: GLIDE_MS });
      }
    }
    const oldEdges = new Set(before.view.edges.map((edge) => edge.id));
    for (const element of into.querySelectorAll<SVGGElement>('[data-diagram-edge], [data-diagram-edge-labels]')) {
      const id = element.getAttribute('data-diagram-edge') ?? element.getAttribute('data-diagram-edge-labels')!;
      // Connectors redraw once their shapes have settled: new ones arrive, moved ones reappear.
      const moved = !oldEdges.has(id) || current.view.edges.some((edge) => edge.id === id && (was.get(edge.source)?.x !== now.get(edge.source)?.x || was.get(edge.target)?.x !== now.get(edge.target)?.x || was.get(edge.source)?.y !== now.get(edge.source)?.y || was.get(edge.target)?.y !== now.get(edge.target)?.y));
      if (moved) play(element, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, delay: GLIDE_MS * 0.6 });
    }
    if (out) {
      // The outgoing picture keeps only what is gone, fading out where it was.
      const keep = new Set([...now.keys(), ...current.view.edges.map((edge) => edge.id)]);
      for (const element of out.querySelectorAll<SVGGElement>('[data-diagram-node], [data-diagram-edge], [data-diagram-edge-labels]')) {
        const id = element.getAttribute('data-diagram-node') ?? element.getAttribute('data-diagram-edge') ?? element.getAttribute('data-diagram-edge-labels')!;
        element.style.visibility = keep.has(id) ? 'hidden' : 'visible';
      }
      out.style.opacity = '1';
      play(out, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' });
    }
    // Every element ends where it belongs even where animations are throttled (a background tab):
    // the transition is decoration, never the only way the picture gets right.
    const settle = window.setTimeout(() => {
      for (const animation of running.current) animation.finish();
      if (out) out.style.opacity = '0';
      if (lens.oid === 'live') closeLens();
    }, GLIDE_MS + FADE_MS + 80);
    return () => window.clearTimeout(settle);
  }, [lens, current, before]);

  // The camera follows the change when asked to, calmly (`revisionFraming.ts`).
  const lastStep = useRef(0);
  useEffect(() => {
    if (!lens || !view || lens.step === lastStep.current) return;
    lastStep.current = lens.step;
    if (!focus || !previousView) return;
    const container = document.querySelector('.dc-editor-canvas');
    const rect = container?.getBoundingClientRect();
    if (!rect) return;
    const frame = frameRevision(previousView, view, flow.getViewport(), { width: rect.width, height: rect.height }, PRESENTATION_INSETS);
    if (frame.kind !== 'stay') void flow.setViewport(frame.camera, { duration: motionMs(frame.kind === 'fit' ? 520 : 320) });
  }, [lens, view, previousView, focus, flow]);

  useEffect(() => () => running.current.forEach((animation) => animation.cancel()), []);

  if (!lens || !current) return null;
  return (
    <ViewportLayer>
      <div className="dc-history-lens" data-live={lens.oid === 'live' ? 'true' : undefined} aria-hidden="true">
        {before && (
          <div ref={outgoing} className="dc-history-lens-scene" data-out="true" style={{ left: before.origin.x, top: before.origin.y }} dangerouslySetInnerHTML={{ __html: before.html }} />
        )}
        <div ref={incoming} className="dc-history-lens-scene" style={{ left: current.origin.x, top: current.origin.y }} dangerouslySetInnerHTML={{ __html: current.html }} />
      </div>
    </ViewportLayer>
  );
}
