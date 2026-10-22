import { deflateSync } from 'fflate';
import { prepareShareData } from './compact';
import { shareStream, transformShareBytes } from './streams';

const scope = self as unknown as { onmessage: ((event: MessageEvent<{ json: string; protectedLink: boolean }>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
scope.onmessage = async ({ data }) => {
  try {
    const prepared = prepareShareData(data.json, data.protectedLink);
    scope.postMessage({ stage: 'compressing' });
    let bytes = new Uint8Array(deflateSync(prepared.bytes, { level: 9 }));
    // Native encoders and maximum-level deflate win on different diagrams. Keep the smaller
    // complete stream, never a second layer of compression or a change to the document format.
    try {
      const native = await transformShareBytes(prepared.bytes, shareStream('CompressionStream'), Number.MAX_SAFE_INTEGER);
      if (native.length < bytes.length) bytes = native;
    } catch { /* The bundled encoder also works when a webview has no compression streams. */ }
    scope.postMessage({ bytes: bytes.buffer, start: prepared.start }, [bytes.buffer]);
  } catch {
    scope.postMessage({ error: true });
  }
};
