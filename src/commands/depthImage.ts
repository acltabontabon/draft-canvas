import type { DraftDocument, DraftViewport } from '../document/types';
import { loadTechnologyIcons } from '../nodes/technology';
import { renderDocumentSvg, type ExportOptions } from '../render/svg/document';
import type { ThemeName } from '../render/theme/tokens';
import type { PersonalityPreset } from '../theme/usePersonality';

export type RoomImageOptions = Pick<ExportOptions, 'theme' | 'preset' | 'selectedFlowId'>;

/** Two decoded cameras cover the usual in/out pair without retaining a visited-room gallery. */
const pictures = new Map<string, Promise<HTMLImageElement>>();
let fileId: string | null = null;

export function clearRoomImages(): void {
  pictures.clear();
  fileId = null;
}

/**
 * A camera-sized bitmap drawn by the same renderer as canvas/export. Freezing the shared SVG
 * isolates both font layout and vector rasterization from the compositor's changing scale.
 */
export async function createRoomImage(
  room: DraftDocument,
  camera: DraftViewport,
  pane: { width: number; height: number },
  options: RoomImageOptions = {},
): Promise<HTMLImageElement> {
  const root = document.documentElement;
  const theme: ThemeName = root.dataset.theme === 'light' ? 'light' : 'dark';
  const personality = root.dataset.personality;
  const preset: PersonalityPreset = personality === 'draft' || personality === 'sketch' ? personality : 'clean';
  if (fileId !== room.metadata.id) {
    clearRoomImages();
    fileId = room.metadata.id;
  }
  // Inside rooms are not drawn by this renderer. Their viewport saves otherwise invalidate the
  // parent's picture on every round trip, even though its visible architecture is unchanged.
  const key = JSON.stringify([
    room.nodes.map(({ inside: _inside, ...node }) => node), room.edges, room.flows,
    room.openPoints, room.settings.showSequence,
    // Computed CSS matrices round the landed camera; treat subpixel serialization noise as the
    // same picture when a fitted arrival becomes the outgoing room on the return trip.
    [Math.round(camera.x * 100) / 100, Math.round(camera.y * 100) / 100, Math.round(camera.zoom * 1_000_000) / 1_000_000],
    pane.width, pane.height,
    options.theme ?? theme, options.preset ?? preset, options.selectedFlowId,
  ]);
  let prepared = pictures.get(key);
  const reused = prepared !== undefined;
  if (!prepared) {
    prepared = prepareImage(room, camera, pane, { theme, preset, ...options });
    pictures.set(key, prepared);
    if (pictures.size > 2) pictures.delete(pictures.keys().next().value!);
    void prepared.catch(() => {
      if (pictures.get(key) === prepared) pictures.delete(key);
    });
  }
  const source = await prepared;
  const image = new Image();
  image.alt = '';
  image.draggable = false;
  image.dataset.depthCached = String(reused);
  image.style.cssText = source.style.cssText;
  image.src = source.src;
  await image.decode();
  return image;
}

async function prepareImage(
  room: DraftDocument,
  camera: DraftViewport,
  pane: { width: number; height: number },
  options: RoomImageOptions,
): Promise<HTMLImageElement> {
  await loadTechnologyIcons(room.nodes);
  const rendered = renderDocumentSvg(room, {
    ...options,
    transparent: true,
    includeBackground: false,
    openPointKey: false,
    idScope: 'depth-picture',
  });
  const width = Math.max(1, pane.width);
  const height = Math.max(1, pane.height);
  const viewBox = [
    -camera.x / camera.zoom - rendered.origin.x,
    -camera.y / camera.zoom - rendered.origin.y,
    width / camera.zoom,
    height / camera.zoom,
  ].join(' ');
  // Only the generated root tag changes; content coordinates, SVG references and all drawing
  // remain the shared renderer's. Avoid constructing a second, large SVG DOM just to crop it.
  const svg = rendered.svg.replace(/^<svg\b[^>]*>/, (tag) => tag
    .replace(/\bwidth="[^"]*"/, `width="${width}"`)
    .replace(/\bheight="[^"]*"/, `height="${height}"`)
    .replace(/\bviewBox="[^"]*"/, `viewBox="${viewBox}"`));
  const image = new Image();
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  image.style.display = 'block';
  // A data URI survives cloneNode and carries no object URL lifetime to coordinate when a flight
  // is interrupted, replaced, or discarded while the image is still being decoded.
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The room picture could not be decoded.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  image.onload = null;
  image.onerror = null;
  await image.decode();
  // SVG images isolate document layout, but the browser can still re-rasterize their vector
  // contents at each larger scale. Freeze that work once, with at most four million pixels.
  const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  try {
    const context = canvas.getContext('2d');
    if (context) {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.src = canvas.toDataURL('image/png');
      await image.decode();
    }
  } catch {
    // A browser that refuses SVG rasterization still has the decoded SVG image to fly.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
  }
  return image;
}
