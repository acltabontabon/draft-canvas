type StreamPair = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
type StreamCtor = new (format: 'deflate-raw') => StreamPair;

export function shareStream(name: 'CompressionStream' | 'DecompressionStream'): StreamPair {
  const ctor = (globalThis as unknown as Record<string, StreamCtor | undefined>)[name];
  if (!ctor) throw new Error(`${name} is not available in this browser.`);
  return new ctor('deflate-raw');
}

/** Bound decompression before validation so a small hostile link cannot inflate without limit. */
export async function transformShareBytes(bytes: Uint8Array, stream: StreamPair, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  let writeError: unknown;
  const written = (async () => { await writer.write(bytes); await writer.close(); })().catch((error: unknown) => { writeError = error; });
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('That link holds more than a diagram can.');
    }
    chunks.push(value);
  }
  await written;
  if (writeError) throw writeError;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
