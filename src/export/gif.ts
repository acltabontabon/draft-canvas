/**
 * Phase 4.3 — Animated Flow Export (GIF). Captures Presentation Mode's
 * existing playback (per-step camera, opacity tiers, connector pulse) to
 * frames, headlessly — see `render/svg/flowFrame.ts` for the per-frame
 * renderer this walks step by step. Not a general media pipeline: GIF only,
 * fixed frame size, and the only knobs are speed and loop, per the roadmap.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { findFlow } from '../document/flow';
import type { DraftDocument, DraftViewport } from '../document/types';
import { resolveFlowStep, resolveStepViewport, type FlowPlaybackStep } from '../presentation/useFlowPlayback';
import { renderFlowFrameSvg } from '../render/svg/flowFrame';
import { rasterizeSvgToPixels } from '../render/png/rasterize';
import { themeFor, type ThemeName } from '../render/theme/tokens';
import { downloadBlob } from './download';
import { fileNameFor } from './project';

export type GifSpeed = 'slow' | 'normal' | 'fast';

export interface GifExportOptions {
  speed?: GifSpeed;
  /** Loop continuously (default) or play once. */
  loop?: boolean;
  theme?: ThemeName;
}

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
          delayMs: FRAME_INTERVAL_MS,
        });
      }
    }

    for (let f = 0; f < holdFrames; f += 1) {
      frames.push({
        step: step.step,
        camera,
        pulsePhase: ((f * FRAME_INTERVAL_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS,
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
  const background = themeFor(theme).canvas;

  const gif = GIFEncoder();
  const repeat = options.loop === false ? -1 : 0;

  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]!;
    const { svg } = renderFlowFrameSvg(
      document,
      flow,
      frame.step,
      frame.camera,
      CANVAS_SIZE,
      frame.pulsePhase,
      { theme },
    );
    const { data, width, height } = await rasterizeSvgToPixels(svg, {
      width: CANVAS_SIZE.width,
      height: CANVAS_SIZE.height,
      background,
    });

    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, {
      palette,
      delay: frame.delayMs,
      ...(i === 0 ? { repeat } : {}),
    });
  }

  gif.finish();
  const blob = new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
  downloadBlob(blob, fileNameFor(document.metadata.title, '.gif'));
}
