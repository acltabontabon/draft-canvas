import { serializeDocument } from '../export/project';
import type { DraftDocument } from '../document/types';
import type { DepthPath } from '../depth/tree';
import type { JobResult } from '../agent/jobs';
import { AgentError } from '../agent/errors';

type UpdateResult = Extract<JobResult, { kind: 'update' }>;
interface Preview {
  diagramId: string;
  session: string;
  revision: string;
  path: DepthPath;
  result: UpdateResult;
  baseFingerprint: string;
  expiresAt: number;
  bytes: number;
}
const previews = new Map<string, Preview>();
const TTL = 10 * 60_000;
const MAX_BYTES = 64 * 1024 * 1024;

/** Ephemeral candidates never enter the store, history, recovery copy or proposal journal. */
export function holdPreview(value: Omit<Preview, 'expiresAt' | 'bytes' | 'baseFingerprint'> & { baseFile: DraftDocument }): string {
  for (const [id, preview] of previews) if (preview.expiresAt <= Date.now()) previews.delete(id);
  const baseFingerprint = serializeDocument(value.baseFile);
  const bytes = new TextEncoder().encode(JSON.stringify(value.result.file) + baseFingerprint).length;
  if (bytes > MAX_BYTES) throw new AgentError('LIMIT_EXCEEDED', 'This candidate is too large to keep in memory.');
  while (previews.size >= 4 || [...previews.values()].reduce((n, p) => n + p.bytes, 0) + bytes > MAX_BYTES) previews.delete(previews.keys().next().value!);
  const id = crypto.randomUUID();
  const { baseFile: _baseFile, ...held } = value;
  previews.set(id, { ...held, baseFingerprint, bytes, expiresAt: Date.now() + TTL });
  return id;
}

export function readPreview(id: unknown, diagramId: string, session: string, revision: string, path?: DepthPath, file?: DraftDocument): Preview {
  const preview = typeof id === 'string' ? previews.get(id) : undefined;
  if (!preview || preview.expiresAt <= Date.now() || preview.session !== session || preview.diagramId !== diagramId) {
    if (preview?.expiresAt && preview.expiresAt <= Date.now()) previews.delete(String(id));
    throw new AgentError('NOT_FOUND', 'That candidate expired or does not belong to this session and diagram. Preview the change again.');
  }
  if ((file && serializeDocument(file) !== preview.baseFingerprint) || preview.revision !== revision || (path && JSON.stringify(path) !== JSON.stringify(preview.path))) throw new AgentError('REVISION_CONFLICT', 'The diagram or target view changed since this candidate was prepared. Preview the change again.');
  return preview;
}

export function clearPreviews(): void { previews.clear(); }
