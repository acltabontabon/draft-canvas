/**
 * Animated Flow Export (GIF). Captures Presentation Mode's existing playback
 * (per-step camera, opacity tiers, connector pulse) to frames, headlessly —
 * see `render/svg/flowFrame.ts` for the per-frame renderer this walks step by
 * step. Not a general media pipeline: GIF only, fixed frame size, and the
 * only knobs are speed and loop.
 */
import { findFlow } from '../document/flow';
import type { DraftDocument, DraftViewport } from '../document/types';
import { clamp } from '../lib/math';
import { resolveFlowStep, resolveStepViewport, type FlowPlaybackStep } from '../presentation/useFlowPlayback';
import { RESPONSE_PHASE_DELAY_MS } from '../presentation/responsePhase';
import { renderFlowFrameSvg } from '../render/svg/flowFrame';
import { rasterizeSvgToPixels } from '../render/png/rasterize';
import { themeFor, type ThemeName } from '../render/theme/tokens';
import { resolveExportBackground } from './background';
import { downloadBlob } from './download';
import { fileNameFor } from './project';
import type { PersonalityPreset } from '../ui/personality/usePersonality';

export type GifSpeed = 'slow' | 'normal' | 'fast';

/** Mirrors `Canvas.tsx`'s live Presentation Mode dim — a GIF is always a
 *  captured presentation, so it always applies. */
const PRESENTATION_EXTRA_DIM = 0.2;

export interface GifExportOptions {
  speed?: GifSpeed;
  /** Loop continuously (default) or play once. */
  loop?: boolean;
  theme?: ThemeName;
  /** Whether to draw a configured background. Defaults to `true`. */
  includeBackground?: boolean;
  /** Phase 5.2 — Intentional Roughness preset. Defaults to `'clean'`. */
  preset?: PersonalityPreset;
  /** Stops the export between frames; the returned promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called after each encoded frame, with how many are done out of how many in total. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Hands the main thread back between frames. Each frame's palette quantization is synchronous and
 * a long flow is thousands of frames, so without this the tab can't paint progress, respond to
 * Cancel, or do anything else until the whole GIF is done. The fallback is a `MessageChannel` post,
 * not `setTimeout(0)`: chained timers in a background tab are throttled to about one a second,
 * which would stretch a few-seconds export into minutes the moment the user switches tabs.
 */
function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Work between yields: long enough that the yields themselves cost nothing measurable, short
 *  enough that Cancel and the progress bar still respond within a few frames. */
const YIELD_BUDGET_MS = 40;

/** Not user-configurable — a fixed, reasonable size for a ticket/Slack embed. */
const CANVAS_SIZE = { width: 960, height: 600 };

const HOLD_MS: Record<GifSpeed, number> = { slow: 1600, normal: 1100, fast: 700 };
/** ~10fps: enough to read the pulse as motion without bloating frame count. */
const FRAME_INTERVAL_MS = 100;
/** Mirrors live Presentation Mode's 380ms pan/zoom transition (`useFlowPlayback.ts`). */
const TRANSITION_MS = 360;
/** `dc-flow-pulse`'s loop period in `canvas.css`. */
const PULSE_PERIOD_MS = 900;

function resolveSteps(document: DraftDocument, flowId: string): FlowPlaybackStep[] {
  const flow = findFlow(document, flowId);
  if (!flow) throw new Error('That flow no longer exists.');

  const edgesById = new Map(document.edges.map((e) => [e.id, e]));
  const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
  const steps: FlowPlaybackStep[] = [];
  flow.steps.forEach((entry, entryIndex) => {
    const resolved = resolveFlowStep(entry, entryIndex, steps.length + 1, edgesById, nodesById);
    if (resolved) steps.push(resolved);
  });
  if (steps.length === 0) throw new Error('This flow has no steps to export.');
  return steps;
}

function lerpViewport(a: DraftViewport, b: DraftViewport, t: number): DraftViewport {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, zoom: a.zoom + (b.zoom - a.zoom) * t };
}

/** Exported for testing — the full per-frame plan (camera + pulse phase) without any rendering. */
export interface GifFramePlan {
  step: number;
  camera: DraftViewport;
  pulsePhase: number;
  /** Which of a request/response connector's two lines this frame's pulse animates — see
   *  `FlowPlaybackState.phase`. Always `'request'` for a step whose edge has no `hasResponse`, i.e.
   *  identical to every frame plan from before this field existed. */
  phase: 'request' | 'response';
  delayMs: number;
}

export function planGifFrames(
  document: DraftDocument,
  flowId: string,
  speed: GifSpeed = 'normal',
): GifFramePlan[] {
  const steps = resolveSteps(document, flowId);
  const nodesById = new Map(document.nodes.map((n) => [n.id, n]));
  const fallback: DraftViewport = { x: 0, y: 0, zoom: 1 };
  const viewports = steps.map(
    (step) =>
      resolveStepViewport(step, nodesById, CANVAS_SIZE.width, CANVAS_SIZE.height) ?? fallback,
  );

  const holdMs = HOLD_MS[speed];
  const holdFrames = Math.max(1, Math.round(holdMs / FRAME_INTERVAL_MS));
  const transitionFrames = Math.max(1, Math.round(TRANSITION_MS / FRAME_INTERVAL_MS));

  const frames: GifFramePlan[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const camera = viewports[i]!;

    if (i > 0) {
      const previous = viewports[i - 1]!;
      for (let t = 1; t <= transitionFrames; t += 1) {
        frames.push({
          step: step.step,
          camera: lerpViewport(previous, camera, t / transitionFrames),
          pulsePhase: 0,
          phase: 'request',
          delayMs: FRAME_INTERVAL_MS,
        });
      }
    }

    // A step whose primary edge has `hasResponse` splits its hold into a request run followed by a
    // response run, at the same proportion the live `useFlowPlayback` timer uses
    // (`RESPONSE_PHASE_DELAY_MS`) — a step with no response line keeps every frame `'request'`, i.e.
    // byte-identical to this function's behavior from before this feature existed. Each phase's own
    // pulse restarts from 0, mirroring how the live CSS animation restarts fresh on whichever line
    // newly starts matching `[data-flow-active]` rather than continuing the other line's timeline.
    const requestFrames = step.edge?.hasResponse
      ? clamp(Math.round((RESPONSE_PHASE_DELAY_MS / holdMs) * holdFrames), 1, holdFrames)
      : holdFrames;

    for (let f = 0; f < holdFrames; f += 1) {
      const phase: 'request' | 'response' = step.edge?.hasResponse && f >= requestFrames ? 'response' : 'request';
      const elapsedInPhase = (phase === 'response' ? f - requestFrames : f) * FRAME_INTERVAL_MS;
      frames.push({
        step: step.step,
        camera,
        pulsePhase: (elapsedInPhase % PULSE_PERIOD_MS) / PULSE_PERIOD_MS,
        phase,
        delayMs: FRAME_INTERVAL_MS,
      });
    }
  }
  return frames;
}

export async function exportFlowGifFile(
  document: DraftDocument,
  flowId: string,
  options: GifExportOptions = {},
): Promise<void> {
  const flow = findFlow(document, flowId);
  if (!flow) throw new Error('That flow no longer exists.');

  const frames = planGifFrames(document, flowId, options.speed ?? 'normal');
  const theme = options.theme ?? 'dark';
  const canvasColor = themeFor(theme).canvas;
  // Resolved once, not per-frame: every frame reuses the same data URI.
  const resolvedBackground = await resolveExportBackground(document, options.includeBackground !== false);

  // Loaded only when a GIF is actually exported — the encoder is dead weight on every other load.
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const gif = GIFEncoder();
  const repeat = options.loop === false ? -1 : 0;
  let lastYield = performance.now();

  for (let i = 0; i < frames.length; i += 1) {
    options.signal?.throwIfAborted();
    const frame = frames[i]!;
    const { svg } = renderFlowFrameSvg(
      document,
      flow,
      frame.step,
      frame.camera,
      CANVAS_SIZE,
      frame.pulsePhase,
      frame.phase,
      { theme, background: resolvedBackground, extraDim: PRESENTATION_EXTRA_DIM, preset: options.preset },
    );
    const { data, width, height } = await rasterizeSvgToPixels(svg, {
      width: CANVAS_SIZE.width,
      height: CANVAS_SIZE.height,
      background: canvasColor,
    });

    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, {
      palette,
      delay: frame.delayMs,
      ...(i === 0 ? { repeat } : {}),
    });
    options.onProgress?.(i + 1, frames.length);
    if (performance.now() - lastYield >= YIELD_BUDGET_MS) {
      await yieldToBrowser();
      lastYield = performance.now();
    }
  }

  options.signal?.throwIfAborted();
  gif.finish();
  const blob = new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
  downloadBlob(blob, fileNameFor(document.metadata.title, '.gif'));
}
