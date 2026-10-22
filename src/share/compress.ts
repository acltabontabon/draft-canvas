import { prepareShareData } from './compact';
import { shareStream, transformShareBytes } from './streams';
import type { ShareStart } from './link';

export type ShareStage = 'preparing' | 'compressing' | 'protecting' | 'copying';
export interface ShareOptions {
  signal?: AbortSignal;
  onProgress?: (stage: ShareStage) => void;
}
type Compressed = { bytes: Uint8Array<ArrayBuffer>; start?: ShareStart };
type WorkerReply = { stage: 'compressing' } | { bytes: ArrayBuffer; start?: ShareStart } | { error: true };

export function checkShareCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Link creation cancelled.', 'AbortError');
}

function inWorker(json: string, protectedLink: boolean, options: ShareOptions): Promise<Compressed> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./compression.worker.ts', import.meta.url), { type: 'module', name: 'draft-canvas-share' });
    const cleanup = () => { worker.terminate(); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Link creation cancelled.', 'AbortError')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if ('stage' in data) { options.onProgress?.(data.stage); return; }
      cleanup();
      if ('error' in data) reject(new Error('Could not compress the diagram.'));
      else resolve({ bytes: new Uint8Array(data.bytes), start: data.start });
    };
    worker.onerror = (event) => { event.preventDefault(); cleanup(); reject(new Error('The compression worker is unavailable.')); };
    try { worker.postMessage({ json, protectedLink }); }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Heavy packing and compression run off the UI thread; blocked workers use native async streams. */
export async function compressShare(json: string, protectedLink: boolean, options: ShareOptions = {}): Promise<Compressed> {
  checkShareCancelled(options.signal);
  if (typeof Worker !== 'undefined') {
    try { return await inWorker(json, protectedLink, options); }
    catch { checkShareCancelled(options.signal); }
  }
  const prepared = prepareShareData(json, protectedLink);
  options.onProgress?.('compressing');
  const bytes = await transformShareBytes(prepared.bytes, shareStream('CompressionStream'), Number.MAX_SAFE_INTEGER);
  checkShareCancelled(options.signal);
  return { bytes, start: prepared.start };
}
