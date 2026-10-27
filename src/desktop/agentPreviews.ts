import { serializeDocument } from '../export/project';
import type { DraftDocument, DraftInside } from '../document/types';
import type { DepthPath } from '../depth/tree';
import type { JobResult } from '../agent/jobs';
import { AgentError } from '../agent/errors';

type UpdateResult = Extract<JobResult, { kind: 'update' }>;
interface Preview {
  diagramId: string;
  session: string;
  /** Every revision that named the diagram as it was prepared from: the one handed out and, for the
   *  open document, its editor revision — the same state answers to both once the person saves. */
  revision: string | readonly string[];
  path: DepthPath;
  result: UpdateResult;
  baseFingerprint: string;
  expiresAt: number;
  bytes: number;
}
const previews = new Map<string, Preview>();
const TTL = 10 * 60_000;
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * What a candidate was prepared from. Where the person has panned or zoomed is not part of the
 * diagram: with it in, a pan between preview and apply (or render) refused the candidate as a
 * changed diagram while the revision was identical, and the agent could only preview again.
 */
function fingerprint(file: DraftDocument): string {
  const still = { x: 0, y: 0, zoom: 1 };
  const room = <R extends DraftDocument | DraftInside>(value: R): R => ({
    ...value,
    viewport: still,
    nodes: value.nodes.some((node) => node.inside) ? value.nodes.map((node) => (node.inside ? { ...node, inside: room(node.inside) } : node)) : value.nodes,
  });
  return serializeDocument(room(file));
}

/** Ephemeral candidates never enter the store, history, recovery copy or proposal journal. */
export function holdPreview(value: Omit<Preview, 'expiresAt' | 'bytes' | 'baseFingerprint'> & { baseFile: DraftDocument }): string {
  for (const [id, preview] of previews) if (preview.expiresAt <= Date.now()) previews.delete(id);
  const baseFingerprint = fingerprint(value.baseFile);
  const bytes = new TextEncoder().encode(JSON.stringify(value.result.file) + baseFingerprint).length;
  if (bytes > MAX_BYTES) throw new AgentError('LIMIT_EXCEEDED', 'This candidate is too large to keep in memory.');
  while (previews.size >= 4 || [...previews.values()].reduce((n, p) => n + p.bytes, 0) + bytes > MAX_BYTES) previews.delete(previews.keys().next().value!);
  const id = crypto.randomUUID();
  const { baseFile: _baseFile, ...held } = value;
  previews.set(id, { ...held, baseFingerprint, bytes, expiresAt: Date.now() + TTL });
  return id;
}

/** Whether two revision lists name one state: any revision in common. */
function sameState(a: string | readonly string[], b: string | readonly string[]): boolean {
  const ours = typeof a === 'string' ? [a] : a;
  return (typeof b === 'string' ? [b] : b).some((revision) => ours.includes(revision));
}

/** `revision`: the revisions the diagram answers to now (see `Preview.revision`). Saving between the
 *  preview and its apply moves what is handed out (`o:` to `f:`) but not the diagram, and used to
 *  refuse the candidate as changed. */
export function readPreview(id: unknown, diagramId: string, session: string, revision: string | readonly string[], path?: DepthPath, file?: DraftDocument): Preview {
  const preview = typeof id === 'string' ? previews.get(id) : undefined;
  if (!preview || preview.expiresAt <= Date.now() || preview.session !== session || preview.diagramId !== diagramId) {
    if (preview?.expiresAt && preview.expiresAt <= Date.now()) previews.delete(String(id));
    throw new AgentError('NOT_FOUND', 'That candidate expired or does not belong to this session and diagram. Preview the change again.');
  }
  if ((file && fingerprint(file) !== preview.baseFingerprint) || !sameState(preview.revision, revision) || (path && JSON.stringify(path) !== JSON.stringify(preview.path))) throw new AgentError('REVISION_CONFLICT', 'The diagram or target view changed since this candidate was prepared. Preview the change again.');
  return preview;
}

export function clearPreviews(): void { previews.clear(); }
