/**
 * `draftcanvas review`: what a branch changes about the architecture, for a pull request.
 *
 * It compares every `.draftcanvas` file in the working tree with the same file at a base revision
 * and reports, per diagram, what changed in the architecture and which findings the change brought
 * in or settled. The base revision is read straight from the repository's object store with a Git
 * library: no `git` program is run, so no hook, filter or configuration in the repository has any
 * say, and nothing is fetched.
 *
 * The report is Markdown meant for a job summary or a comment, so every name in it is escaped:
 * a label in a diagram from a fork is someone else's text, and must not be able to add a link, an
 * image, a mention or markup to a page other people read.
 */

import * as fs from 'node:fs';
import { resolve } from 'node:path';
import git from 'isomorphic-git';
import { builtinFindings, sortFindings, type Finding } from '../src/checks';
import { LIMITS } from '../src/document/limits';
import type { DraftDocument } from '../src/document/types';
import { deserializeDocument } from '../src/export/project';
import { architectureChanges, modelOf, type ArchChange } from '../src/model';
import { fileSystemReader } from './repo';

/** Diagrams compared in one review; the rest are counted. */
const MAX_DIAGRAMS = 200;
/** Lines of each kind listed for one diagram. */
const MAX_LINES = 40;

export class ReviewError extends Error {}

export interface DiagramReview {
  path: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged' | 'unreadable';
  /** Why it could not be read, when it could not. */
  problem?: string;
  architecture: ArchChange[];
  introduced: Finding[];
  resolved: Finding[];
}

export interface Review {
  base: string;
  /** The commit `base` resolved to. */
  commit: string;
  diagrams: DiagramReview[];
  /** Diagrams left out because there were more than are compared. */
  skipped: number;
  /** The folder has more files than are listed, so a diagram that is new may have been missed. */
  incomplete: boolean;
}

function parse(text: string): DraftDocument | string {
  if (text.length > LIMITS.maxFileBytes) return 'it is too large to be a diagram';
  const parsed = deserializeDocument(text);
  return parsed.ok ? parsed.document : parsed.error;
}

export async function review(folder: string, base: string): Promise<Review> {
  const dir = resolve(folder);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(base) || base.includes('..')) throw new ReviewError('--base takes a branch, tag or commit.');
  let gitdir: fs.Stats;
  try {
    gitdir = fs.lstatSync(resolve(dir, '.git'));
  } catch {
    throw new ReviewError(`${folder} is not the top of a Git repository.`);
  }
  // A linked worktree or a submodule keeps its history elsewhere; following that pointer would
  // read outside the folder the person named.
  if (!gitdir.isDirectory()) throw new ReviewError(`${folder} keeps its Git history somewhere else (a linked worktree or a submodule). Run the review in the main checkout, or compare two files with diff.`);

  let commit: string;
  let atBase: string[];
  try {
    commit = await git.resolveRef({ fs, dir, ref: base }).catch(() => git.expandOid({ fs, dir, oid: base }));
    atBase = (await git.listFiles({ fs, dir, ref: commit })).filter((path) => path.endsWith('.draftcanvas'));
  } catch {
    throw new ReviewError(`"${base}" is not a revision this checkout has. In CI, check out with enough history to include the base branch.`);
  }

  const reader = fileSystemReader(dir);
  // The listing only finds diagrams that are new. Whether one from the base is still here is
  // asked of the file itself: a listing that stopped at its limit must never read as "removed".
  const listing = await reader.list();
  const listed = listing.paths.filter((path) => path.endsWith('.draftcanvas'));
  const all = [...new Set([...atBase, ...listed])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const diagrams: DiagramReview[] = [];

  for (const path of all.slice(0, MAX_DIAGRAMS)) {
    const empty = { architecture: [], introduced: [], resolved: [] };
    let beforeText: string | undefined;
    if (atBase.includes(path)) {
      try {
        const { blob } = await git.readBlob({ fs, dir, oid: commit, filepath: path });
        if (blob.byteLength > LIMITS.maxFileBytes) {
          diagrams.push({ path, status: 'unreadable', problem: 'the earlier version is too large to be a diagram', ...empty });
          continue;
        }
        beforeText = Buffer.from(blob).toString('utf8');
      } catch {
        diagrams.push({ path, status: 'unreadable', problem: 'the earlier version could not be read from the repository', ...empty });
        continue;
      }
    }
    const read = await reader.read(path);
    const now = read.status === 'missing' ? undefined : read;
    if (now && now.status !== 'ok') {
      diagrams.push({ path, status: 'unreadable', problem: now.status === 'too-large' ? 'it is too large to be a diagram' : 'it could not be read', ...empty });
      continue;
    }
    const afterText = now?.text;
    if (beforeText !== undefined && beforeText === afterText) {
      diagrams.push({ path, status: 'unchanged', ...empty });
      continue;
    }
    const before = beforeText === undefined ? undefined : parse(beforeText);
    const after = afterText === undefined ? undefined : parse(afterText);
    if (typeof before === 'string' || typeof after === 'string') {
      diagrams.push({ path, status: 'unreadable', problem: typeof after === 'string' ? after : `the earlier version: ${before as string}`, ...empty });
      continue;
    }
    if (!after) {
      diagrams.push({ path, status: 'removed', ...empty });
      continue;
    }
    const was = new Map((before ? builtinFindings(before) : []).map((entry) => [entry.id, entry]));
    const is = new Map(builtinFindings(after).map((entry) => [entry.id, entry]));
    diagrams.push({
      path,
      status: before ? 'changed' : 'added',
      // A new diagram's parts are all new; listing every one as a change would say nothing.
      architecture: before ? architectureChanges(modelOf(before), modelOf(after)) : [],
      introduced: sortFindings([...is.values()].filter((entry) => !was.has(entry.id))),
      resolved: sortFindings([...was.values()].filter((entry) => !is.has(entry.id))),
    });
  }
  return { base, commit, diagrams, skipped: Math.max(0, all.length - MAX_DIAGRAMS), incomplete: listing.truncated };
}

/**
 * Text from a diagram or a path, made safe to put in Markdown other people will read: one line, of
 * bounded length, with nothing that Markdown or HTML would act on, and no `@` that could notify
 * someone.
 */
export function md(text: string, max = 200): string {
  // oxlint-disable-next-line no-control-regex -- control characters are removed, not matched for meaning
  const line = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  const clipped = line.length > max ? `${line.slice(0, max - 1)}…` : line;
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~-]/g, '\\$&')
    .replace(/@/g, '@\u200b')
    .replace(/:\/\//g, ':\u200b//');
}

export function reviewMarkdown(result: Review): string {
  const lines = ['## Architecture review', ''];
  const touched = result.diagrams.filter((diagram) => diagram.status !== 'unchanged');
  const partial = result.incomplete ? ['', 'The folder has more files than are listed, so a diagram added since the base may be missing here.'] : [];
  if (touched.length === 0) {
    lines.push(`No diagram differs from \`${md(result.base, 80)}\`.`, ...partial);
    return `${lines.join('\n')}\n`;
  }
  const list = <T>(items: readonly T[], line: (item: T) => string, more: string) => {
    for (const item of items.slice(0, MAX_LINES)) lines.push(line(item));
    if (items.length > MAX_LINES) lines.push(`- …and ${items.length - MAX_LINES} more ${more}`);
  };
  for (const diagram of touched) {
    lines.push(`### ${md(diagram.path)}`, '');
    if (diagram.status === 'unreadable') {
      lines.push(`Could not be reviewed: ${md(diagram.problem ?? 'it could not be read')}.`, '');
      continue;
    }
    if (diagram.status === 'removed') {
      lines.push('The diagram was removed.', '');
      continue;
    }
    if (diagram.status === 'added') lines.push('A new diagram.', '');
    else if (diagram.architecture.length === 0) lines.push('No change to the architecture: layout, style or annotation only.', '');
    else {
      lines.push('**What changed**', '');
      list(diagram.architecture, (change) => `- ${md(change.text, 400)}`, 'changes');
      lines.push('');
    }
    if (diagram.introduced.length) {
      lines.push('**New findings**', '');
      list(diagram.introduced, (entry) => `- ${entry.severity}: ${md(entry.message, 400)} \`${entry.id}\``, 'findings');
      lines.push('');
    }
    if (diagram.resolved.length) {
      lines.push('**No longer found**', '');
      list(diagram.resolved, (entry) => `- ${md(entry.message, 400)}`, 'findings');
      lines.push('');
    }
  }
  if (result.skipped) lines.push(`${result.skipped} more diagram${result.skipped === 1 ? ' was' : 's were'} not compared.`, '');
  if (partial.length) lines.push(partial[1]!, '');
  lines.push(`Compared with \`${md(result.base, 80)}\` (${result.commit.slice(0, 12)}). Read from the diagrams alone; nothing here was measured.`);
  return `${lines.join('\n')}\n`;
}
