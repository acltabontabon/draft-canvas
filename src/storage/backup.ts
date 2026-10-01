/**
 * Back up every diagram in the Library to one ZIP, and put a ZIP's diagrams back — into any
 * `DraftRepository`, so both halves run unchanged against `MemoryRepository` in tests.
 *
 * A backup is nothing but `.draftcanvas` files, one per stored document, exactly as Export writes
 * them: a backup you can't open any other way is a hostage, not a backup. `projects.json` beside
 * them carries the Library's project folders and which diagram sits in which, since a document
 * file doesn't say (the project is this browser's grouping, not part of the diagram).
 *
 * Restoring never overwrites. A diagram whose id is already stored comes back as a new copy —
 * `cloneDocumentAsNew`, the same rule an imported file follows — so restoring an old backup over
 * a library that has moved on loses nothing on either side.
 */

import { cloneDocumentAsNew } from '../document/factory';
import type { DraftDocument, Project } from '../document/types';
import { parseDocument } from '../document/validate';
import { fileNameFor, serializeDocument } from '../export/project';
import { unzipFiles, zipFiles } from '../export/zip';
import type { DraftRepository } from './DraftRepository';

/** The preference that remembers when the last backup was written (an ISO timestamp, 24 chars). */
export const LAST_BACKUP_PREFERENCE = 'last-backup-at';

const DOCUMENT_EXTENSION = '.draftcanvas';
const MANIFEST_NAME = 'projects.json';

interface Manifest {
  projects: Project[];
  /** Document id → project id, for every diagram that sat in a project when the backup was made. */
  membership: Record<string, string>;
}

export interface BackupResult {
  bytes: Uint8Array<ArrayBuffer>;
  /** Diagrams written. */
  count: number;
}

export interface RestoreResult {
  /** Diagrams now in the Library that weren't before — copies included. */
  restored: number;
  /** Of those, how many arrived as a new copy because their id was already taken. */
  renamed: number;
  /** Entries that couldn't be read as a diagram, by archive path. */
  skipped: string[];
}

/** `draft-canvas-backup-2026-10-01.zip` — the day, local time, so two backups a week apart sort. */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `draft-canvas-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

/** The archive path of one diagram: a slug of its title, then its id so two "Untitled" never collide. */
function entryNameFor(document: DraftDocument): string {
  const slug = fileNameFor(document.metadata.title, '');
  return `${slug}-${document.metadata.id}${DOCUMENT_EXTENSION}`;
}

/**
 * Every readable document in the repository as a ZIP. A document that fails to load is left out
 * rather than failing the whole backup — one unreadable row must not stop the other hundred from
 * being saved — and the count says how many made it.
 */
export async function buildBackup(repository: DraftRepository): Promise<BackupResult> {
  const summaries = await repository.list();
  const entries: { name: string; data: string }[] = [];
  const membership: Record<string, string> = {};
  for (const summary of summaries) {
    const document = await repository.load(summary.id).catch(() => null);
    if (!document) continue;
    entries.push({ name: entryNameFor(document), data: serializeDocument(document) });
    if (document.metadata.projectId) membership[document.metadata.id] = document.metadata.projectId;
  }
  const projects = await repository.listProjects().catch(() => [] as Project[]);
  const manifest: Manifest = { projects, membership };
  entries.push({ name: MANIFEST_NAME, data: `${JSON.stringify(manifest, null, 2)}\n` });
  return { bytes: zipFiles(entries), count: entries.length - 1 };
}

const decoder = new TextDecoder();

/** `projects.json` read defensively: a hand-edited or foreign archive must not throw. */
function readManifest(data: Uint8Array | undefined): Manifest {
  const empty: Manifest = { projects: [], membership: {} };
  if (!data) return empty;
  try {
    const raw = JSON.parse(decoder.decode(data)) as Partial<Manifest> | null;
    if (!raw || typeof raw !== 'object') return empty;
    const projects = Array.isArray(raw.projects)
      ? raw.projects.filter(
          (p): p is Project =>
            !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.createdAt === 'number' && typeof p.updatedAt === 'number',
        )
      : [];
    const membership: Record<string, string> = {};
    if (raw.membership && typeof raw.membership === 'object') {
      for (const [id, projectId] of Object.entries(raw.membership)) if (typeof projectId === 'string') membership[id] = projectId;
    }
    return { projects, membership };
  } catch {
    return empty;
  }
}

/**
 * Puts every diagram in `bytes` into the repository without overwriting anything there. Projects
 * named by the manifest are recreated when missing (an existing project with the same id is kept
 * as it is), and each restored diagram lands in the project the backup had it in, when that
 * project now exists; otherwise it is simply unorganized, never invisible.
 */
export async function restoreBackup(repository: DraftRepository, bytes: Uint8Array): Promise<RestoreResult> {
  const entries = unzipFiles(bytes);
  const manifest = readManifest(entries.find((entry) => entry.name === MANIFEST_NAME)?.data);

  const existing = new Set((await repository.listProjects().catch(() => [] as Project[])).map((project) => project.id));
  for (const project of manifest.projects) {
    if (existing.has(project.id)) continue;
    await repository.saveProject(project);
    existing.add(project.id);
  }

  const result: RestoreResult = { restored: 0, renamed: 0, skipped: [] };
  for (const entry of entries) {
    if (!entry.name.endsWith(DOCUMENT_EXTENSION)) continue;
    const parsed = parseDocument(decoder.decode(entry.data));
    if (!parsed.ok) {
      result.skipped.push(entry.name);
      continue;
    }
    let document = parsed.document;
    const wanted = manifest.membership[document.metadata.id];
    const metadata = { ...document.metadata };
    if (wanted && existing.has(wanted)) metadata.projectId = wanted;
    else delete metadata.projectId;
    document = { ...document, metadata };
    // Taken means stored under that id, readable or not — the same question an import asks.
    const taken = await repository.has(document.metadata.id).catch(() => true);
    if (taken) {
      document = cloneDocumentAsNew(document, document.metadata.title);
      result.renamed += 1;
    }
    await repository.save(document);
    result.restored += 1;
  }
  return result;
}

/** "Restored 12 diagrams (3 renamed as copies)" — what the toast says. */
export function describeRestore(result: RestoreResult): string {
  const diagrams = result.restored === 1 ? '1 diagram' : `${result.restored} diagrams`;
  const renamed = result.renamed === 0 ? '' : ` (${result.renamed} renamed as ${result.renamed === 1 ? 'a copy' : 'copies'})`;
  const skipped = result.skipped.length === 0 ? '' : `; ${result.skipped.length} ${result.skipped.length === 1 ? 'file' : 'files'} couldn't be read`;
  return `Restored ${diagrams}${renamed}${skipped}.`;
}

/** Whether the last backup is missing or older than `days` — what the Library's nudge asks. */
export function backupIsStale(lastBackupAt: string | null, now = Date.now(), days = 7): boolean {
  if (!lastBackupAt) return true;
  const at = Date.parse(lastBackupAt);
  if (Number.isNaN(at)) return true;
  return now - at > days * 24 * 60 * 60 * 1000;
}
