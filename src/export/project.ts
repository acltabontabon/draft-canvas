import { LIMITS } from '../document/limits';
import { CURRENT_VERSION, DRAFT_FORMAT, type DraftDocument } from '../document/types';
import { parseDocument, type NormalizeResult } from '../document/validate';

export const FILE_EXTENSION = '.draftcanvas';
export const FILE_MIME = 'application/json';

/**
 * Serializes a document to the portable `.draftcanvas` format.
 *
 * The file is plain JSON on purpose: it can be diffed, put in a repository, and
 * read by a human. Field order is fixed so that saving an unchanged document
 * twice produces identical bytes.
 */
export function serializeDocument(document: DraftDocument): string {
  const payload = {
    format: DRAFT_FORMAT,
    version: CURRENT_VERSION,
    metadata: {
      id: document.metadata.id,
      title: document.metadata.title,
      createdAt: document.metadata.createdAt,
      updatedAt: document.metadata.updatedAt,
    },
    nodes: document.nodes,
    edges: document.edges,
    viewport: document.viewport,
    settings: document.settings,
    flows: document.flows,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function deserializeDocument(text: string): NormalizeResult {
  return parseDocument(text);
}

/** Turns a title into something safe to hand to a file system. */
export function fileNameFor(title: string, extension = FILE_EXTENSION): string {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'draft-canvas';
  return `${base}${extension}`;
}

export async function readProjectFile(file: File): Promise<NormalizeResult> {
  if (file.size > LIMITS.maxFileBytes) {
    return {
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Draft Canvas opens files up to ${LIMITS.maxFileBytes / 1024 / 1024} MB.`,
    };
  }
  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'That file could not be read.',
    };
  }
  return deserializeDocument(text);
}
