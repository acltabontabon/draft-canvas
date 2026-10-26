import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { renderDocumentSvg } from '../src/render/svg/document';
import { clearRoomImages, createRoomImage } from '../src/ui/Editor/depthImage';

vi.mock('../src/nodes/technology', () => ({ loadTechnologyIcons: vi.fn(async () => {}) }));
vi.mock('../src/render/svg/document', () => ({
  renderDocumentSvg: vi.fn(() => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><g transform="translate(-100 40)"><text>Room 雪</text></g></svg>',
    width: 600,
    height: 400,
    origin: { x: 100, y: -40 },
  })),
}));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('Image', function Image() {
    const image = document.createElement('img');
    image.decode = vi.fn(async () => {});
    let source = '';
    Object.defineProperty(image, 'src', {
      get: () => source,
      set: (value: string) => {
        source = value;
        queueMicrotask(() => image.dispatchEvent(new Event('load')));
      },
    });
    return image;
  });
});

afterEach(() => {
  clearRoomImages();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-personality');
});

it('reuses two prepared cameras, then evicts the oldest and clears on a file switch', async () => {
  const room = createDocument('Cached');
  const pane = { width: 800, height: 600 };
  const first = await createRoomImage(room, { x: 0, y: 0, zoom: 1 }, pane);
  first.style.opacity = '0';
  const again = await createRoomImage(room, { x: 0, y: 0, zoom: 1 }, pane);
  expect(again.style.opacity).toBe('');
  await createRoomImage(room, { x: 0.0001, y: -0.0001, zoom: 1.00000001 }, pane);
  expect(renderDocumentSvg).toHaveBeenCalledTimes(1);
  await createRoomImage(room, { x: 10, y: 0, zoom: 1 }, pane);
  await createRoomImage(room, { x: 20, y: 0, zoom: 1 }, pane);
  await createRoomImage(room, { x: 0, y: 0, zoom: 1 }, pane);
  expect(renderDocumentSvg).toHaveBeenCalledTimes(4);
  await createRoomImage(createDocument('Other file'), { x: 0, y: 0, zoom: 1 }, pane);
  await createRoomImage(room, { x: 0, y: 0, zoom: 1 }, pane);
  expect(renderDocumentSvg).toHaveBeenCalledTimes(6);
});

it('freezes vector scaling into a bounded bitmap when canvas rasterization is available', async () => {
  const drawImage = vi.fn();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cGljdHVyZQ==');
  const image = await createRoomImage(createDocument('Bitmap'), { x: 0, y: 0, zoom: 1 }, { width: 4000, height: 3000 });
  expect(image.src).toBe('data:image/png;base64,cGljdHVyZQ==');
  expect(drawImage).toHaveBeenCalledOnce();
  const canvas = encode.mock.instances[0] as HTMLCanvasElement;
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_000_000);
});

it('crops the shared SVG into the camera without changing document geometry', async () => {
  const room = createDocument('Room');
  const image = await createRoomImage(room, { x: 20, y: -30, zoom: 2 }, { width: 1000, height: 600 });
  const svg = decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1));
  expect(svg).toContain('width="1000" height="600" viewBox="-110 55 500 300"');
  expect(svg).toContain('<g transform="translate(-100 40)"><text>Room 雪</text></g>');
  expect(image.decode).toHaveBeenCalledOnce();
  expect(image.style.width).toBe('1000px');
  expect(image.style.height).toBe('600px');
  expect(renderDocumentSvg).toHaveBeenCalledWith(room, expect.objectContaining({
    transparent: true,
    includeBackground: false,
    openPointKey: false,
  }));
});

it('uses the live theme and personality, while allowing an explicit flow and appearance', async () => {
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.personality = 'sketch';
  const room = createDocument('Room');
  await createRoomImage(room, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
  expect(renderDocumentSvg).toHaveBeenLastCalledWith(room, expect.objectContaining({ theme: 'light', preset: 'sketch' }));
  await createRoomImage(room, { x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }, {
    theme: 'dark', preset: 'draft', selectedFlowId: 'request',
  });
  expect(renderDocumentSvg).toHaveBeenLastCalledWith(room, expect.objectContaining({
    theme: 'dark', preset: 'draft', selectedFlowId: 'request',
  }));
});
