/**
 * The history worker: Canvas Evolution's heavy work, off the drawing thread. On the web it also
 * holds the histories (isomorphic-git over IndexedDB); on the desktop the shell does, and the worker
 * only computes. See `workerHost.ts` for what it answers.
 */
import './bufferGlobal';
import type { HistoryBackend } from './backend';
import { BrowserBackend } from './browser/backend';
import { IdbKv, deleteState, listState, readState, writeState } from './browser/historyDb';
import { KvFs } from './browser/kvfs';
import { webLocks } from './locks';
import { handle, serializeError, type Request } from './workerHost';

interface Envelope {
  id: number;
  request: Request;
}

const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<Envelope | { setup: { storage: boolean } }>) => void) | null;
};

let backend: HistoryBackend | undefined;

function browserBackend(): HistoryBackend {
  return new BrowserBackend(
    new KvFs(new IdbKv()),
    { get: readState, put: writeState, delete: deleteState, list: listState },
    webLocks,
  );
}

scope.onmessage = (event) => {
  const data = event.data;
  if ('setup' in data) {
    backend = data.setup.storage ? browserBackend() : undefined;
    return;
  }
  const { id, request } = data;
  handle(request, backend).then(
    (value) => {
      const transfer = value instanceof Uint8Array ? [value.buffer as ArrayBuffer] : [];
      scope.postMessage({ id, ok: true, value }, transfer);
    },
    (error: unknown) => scope.postMessage({ id, ok: false, error: serializeError(error) }),
  );
};
