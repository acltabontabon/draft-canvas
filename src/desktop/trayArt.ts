import type { StarterShape } from '../ui/Library/starterShapes';
import { logDiagnostic } from '../lib/diagnostics';
import type { DesktopApi, TrayArt } from './api';
import type { DesktopController } from './controller';
import type { DesktopStore } from './store';
import { loadThumbnail } from './thumbnails';
import { TRAY_GLYPHS } from './tray/glyphs';

/**
 * The tray menu, drawn by the page: every recent file and waiting draft as a tiny silhouette of the
 * diagram it is — the same shapes as Home's tiles, at menu size — and the actions as line icons in
 * the app's own hand. The shell only arranges them (`src-tauri/src/tray.rs`); the page draws because
 * it already holds every diagram's shape and knows whether the menus are light or dark right now.
 *
 * Nothing here runs on a timer. It redraws when Home's lists change or the appearance does, and only
 * sends the shell a new set when what it would send has changed.
 */

/** 18pt, drawn at 2x: what a menu row holds on a Retina display. */
const SIZE = 36;
const RECENTS = 12;
const DRAFTS = 5;
const SETTLE_MS = 300;

type Ink = { stroke: string; faint: string };

function inkFor(dark: boolean): Ink {
  // The menu's own text colour, near enough, so an icon reads as part of its line.
  return dark ? { stroke: 'rgba(255,255,255,0.86)', faint: 'rgba(255,255,255,0.42)' } : { stroke: 'rgba(0,0,0,0.8)', faint: 'rgba(0,0,0,0.36)' };
}

function canvas(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const element = document.createElement('canvas');
  element.width = SIZE;
  element.height = SIZE;
  return element.getContext('2d');
}

function png(context: CanvasRenderingContext2D): string {
  return context.canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
}

/**
 * A diagram's silhouette at menu size: its boxes as the tiles draw them — dashed boundaries, round
 * actors, pill-shaped queues — joined by right-angled connectors, fitted to the square with a little air.
 */
function silhouette(shape: StarterShape, ink: Ink): string | null {
  const context = canvas();
  if (!context || shape.boxes.length === 0) return null;
  const { bounds } = shape;
  const pad = 3;
  const scale = Math.min((SIZE - pad * 2) / Math.max(bounds.width, 1), (SIZE - pad * 2) / Math.max(bounds.height, 1));
  const ox = (SIZE - bounds.width * scale) / 2 - bounds.x * scale;
  const oy = (SIZE - bounds.height * scale) / 2 - bounds.y * scale;
  const at = (x: number, y: number) => [ox + x * scale, oy + y * scale] as const;
  const boxes = shape.boxes.map((box) => {
    const [x, y] = at(box.x, box.y);
    return { kind: box.kind, x, y, w: Math.max(2.5, box.w * scale), h: Math.max(2.5, box.h * scale) };
  });

  context.lineCap = 'round';
  context.lineJoin = 'round';

  // Connectors first, then each box cleared and outlined over them, so a line never runs through a box.
  context.strokeStyle = ink.faint;
  context.lineWidth = 1.2;
  for (const [from, to] of shape.shape.edges) {
    const a = boxes[from];
    const b = boxes[to];
    if (!a || !b) continue;
    const [ax, ay, bx, by] = [a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2];
    context.beginPath();
    context.moveTo(ax, ay);
    if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
      const mid = (ax + bx) / 2;
      context.lineTo(mid, ay);
      context.lineTo(mid, by);
    } else {
      const mid = (ay + by) / 2;
      context.lineTo(ax, mid);
      context.lineTo(bx, mid);
    }
    context.lineTo(bx, by);
    context.stroke();
  }

  for (const box of boxes) {
    const path = new Path2D();
    const r = box.kind === 'queue' || box.kind === 'topic' ? box.h / 2 : Math.min(1.5, box.h / 3);
    if (box.kind === 'actor' || box.kind === 'junction') {
      const radius = box.kind === 'junction' ? 1.4 : Math.min(box.w, box.h) / 2;
      path.arc(box.x + box.w / 2, box.y + box.h / 2, radius, 0, Math.PI * 2);
    } else {
      path.roundRect(box.x, box.y, box.w, box.h, r);
    }
    if (box.kind !== 'boundary') {
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.fill(path);
      context.restore();
    }
    context.setLineDash(box.kind === 'boundary' ? [1.6, 1.6] : []);
    context.strokeStyle = box.kind === 'boundary' ? ink.faint : ink.stroke;
    context.lineWidth = box.kind === 'boundary' ? 1 : 1.6;
    context.stroke(path);
  }
  return png(context);
}

const ACTIONS = TRAY_GLYPHS;

function actionIcon(name: keyof TrayArt['actions'], ink: Ink): string | null {
  const context = canvas();
  if (!context) return null;
  const spec = ACTIONS[name];
  context.scale(SIZE / 24, SIZE / 24);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = 1.5;
  context.strokeStyle = ink.stroke;
  for (const d of spec.lines) context.stroke(new Path2D(d));
  context.lineWidth = 1.25;
  context.strokeStyle = ink.faint;
  for (const d of spec.faint ?? []) context.stroke(new Path2D(d));
  return png(context);
}

/** Keeps the tray's drawings in step with Home's lists and the appearance, for as long as the app runs. */
export function startTrayArt(api: DesktopApi, store: DesktopStore, controller: DesktopController): () => void {
  const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sent = '';
  let running = false;
  let again = false;

  const paint = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const { recents, recovery } = store.getSnapshot();
      const ink = inkFor(Boolean(scheme?.matches));
      const files = recents.filter((item) => item.kind === 'file').slice(0, RECENTS);
      const drafts = recovery.slice(0, DRAFTS);
      const drawn = async (key: string, load: () => Promise<string | null>) => {
        const thumbnail = await loadThumbnail(key, load);
        return thumbnail?.state === 'drawn' ? silhouette(thumbnail.shape, ink) : null;
      };
      const art: TrayArt = {
        actions: Object.fromEntries(
          (Object.keys(ACTIONS) as (keyof TrayArt['actions'])[]).flatMap((name) => {
            const icon = actionIcon(name, ink);
            return icon ? [[name, icon]] : [];
          }),
        ),
        files: (
          await Promise.all(
            files.map(async (item) => {
              // The same key as the Home tile's, so a file drawn for one isn't read again for the other.
              const icon = await drawn(`${item.displayPath}:${item.lastOpenedMs}`, () => controller.peek({ kind: 'recent', handle: item.handle }));
              return icon ? [{ handle: item.handle, png: icon }] : [];
            }),
          )
        ).flat(),
        drafts: await Promise.all(
          drafts.map(async (entry) => {
            const icon = await drawn(`draft:${entry.id}:${entry.updatedAt}`, () => controller.peek({ kind: 'draft', id: entry.id }));
            return {
              id: entry.id,
              title: entry.origin.kind === 'file' ? `${entry.origin.name} — unsaved changes` : entry.title,
              ...(icon ? { png: icon } : {}),
            };
          }),
        ),
      };
      const next = JSON.stringify(art);
      if (next !== sent) {
        sent = next;
        await api.trayDecorate(art);
      }
    } catch (error) {
      // The tray still works without its drawings; only the pictures are missing.
      logDiagnostic(error, { operation: 'desktop-tray-art' });
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void paint();
    }, SETTLE_MS);
  };

  let last = store.getSnapshot();
  const unsubscribe = store.subscribe(() => {
    const now = store.getSnapshot();
    if (now.recents !== last.recents || now.recovery !== last.recovery) schedule();
    last = now;
  });
  scheme?.addEventListener('change', schedule);
  schedule();

  return () => {
    unsubscribe();
    scheme?.removeEventListener('change', schedule);
    if (timer !== null) clearTimeout(timer);
  };
}
