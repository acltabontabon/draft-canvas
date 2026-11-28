/**
 * The headless commands. Each takes parsed arguments and returns what to print and the exit code,
 * so a test calls the same function the terminal does.
 *
 * Exit codes are part of the interface:
 *
 * - `0`: it ran, and nothing was found at or above the threshold.
 * - `1`: it ran, and findings reached the threshold (`check`).
 * - `2`: the input was wrong: an unknown option, a file that is not a diagram.
 * - `3`: it could not finish: a folder that can't be read, an output that can't be written.
 *
 * No command changes a diagram. `render` writes only the output file it is given.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkDiagram, builtinFindings, countBySeverity, impactOf, reaches, sortFindings, SEVERITIES, type CheckReport, type Finding, type Severity } from '../src/checks';
import { viewOf } from '../src/depth/tree';
import { LIMITS } from '../src/document/limits';
import { CURRENT_VERSION, type DraftDocument } from '../src/document/types';
import { realRepairs } from '../src/document/validate';
import { describe } from '../src/evolution/summary';
import { isEmptyDiff, semanticDiff } from '../src/evolution/diff';
import { deserializeDocument } from '../src/export/project';
import { labelOf, modelOf, type ArchModel } from '../src/model';
import { renderDocumentSvg } from '../src/render/svg/document';
import { fileSystemReader, RepoError } from './repo';

export const EXIT = { ok: 0, findings: 1, usage: 2, failed: 3 } as const;

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

class UsageError extends Error {}
class Failure extends Error {}

const out = (stdout: string, code: number = EXIT.ok): Outcome => ({ code, stdout: stdout.endsWith('\n') ? stdout : `${stdout}\n`, stderr: '' });

/** Runs one command, turning what goes wrong into the documented exit codes. */
export async function run(command: string, args: Args, version: string): Promise<Outcome> {
  try {
    switch (command) {
      case 'inspect':
        return inspect(args, version);
      case 'check':
        return await check(args, version);
      case 'diff':
        return diff(args, version);
      case 'impact':
        return impact(args, version);
      case 'render':
        return render(args);
      default:
        throw new UsageError(`Unknown command "${command}". Try: inspect, check, impact, diff, render.`);
    }
  } catch (error) {
    if (error instanceof UsageError) return { code: EXIT.usage, stdout: '', stderr: `${error.message}\n` };
    if (error instanceof Failure || error instanceof RepoError) return { code: EXIT.failed, stdout: '', stderr: `${error.message}\n` };
    return { code: EXIT.failed, stdout: '', stderr: `draftcanvas could not finish: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

interface Loaded {
  path: string;
  document: DraftDocument;
  /** What had to be put right to open it. An older format brought up to date is not one. */
  repairs: string[];
}

function load(path: string | undefined, what = 'a diagram'): Loaded {
  if (!path) throw new UsageError(`Name ${what}: a .draftcanvas file.`);
  let text: string;
  try {
    if (statSync(path).size > LIMITS.maxFileBytes) throw new UsageError(`${path} is too large to be a diagram.`);
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${path} could not be read.`);
  }
  const parsed = deserializeDocument(text);
  if (!parsed.ok) throw new UsageError(`${path}: ${parsed.error}`);
  return { path, document: parsed.document, repairs: realRepairs(parsed.repairs) };
}

function only(args: Args, allowed: readonly string[]): void {
  for (const flag of Object.keys(args.flags)) if (!allowed.includes(flag)) throw new UsageError(`Unknown option --${flag}.`);
}

function text(args: Args, flag: string): string | undefined {
  const value = args.flags[flag];
  if (value === true) throw new UsageError(`--${flag} needs a value.`);
  return value;
}

function write(args: Args, input: string, content: string): Outcome {
  const target = text(args, 'output');
  if (!target) return out(content);
  if (resolve(target) === resolve(input)) throw new UsageError('The output would overwrite the diagram.');
  try {
    writeFileSync(target, content);
  } catch {
    throw new Failure(`${target} could not be written.`);
  }
  return { code: EXIT.ok, stdout: '', stderr: '' };
}

function repairFindings(repairs: readonly string[]): Finding[] {
  if (repairs.length === 0) return [];
  return [
    {
      id: 'file-repaired',
      rule: 'file/repaired',
      class: 'advisory',
      severity: 'warning',
      subjects: [],
      message: `The file needed ${repairs.length} repair${repairs.length === 1 ? '' : 's'} to open: ${repairs.slice(0, 3).join(' ')}${repairs.length > 3 ? ' …' : ''}`,
    },
  ];
}

// --- inspect ---------------------------------------------------------------------------------

function modelJson(model: ArchModel) {
  return {
    views: model.rooms.map((room) => ({ path: room.path, level: room.level ?? null, parts: room.entities.length, boundaries: room.boundaries.length, relations: room.relations.length })),
    parts: [...model.entities.values()],
    boundaries: [...model.boundaries.values()],
    relations: model.relations,
    unread: model.unread,
  };
}

function inspect(args: Args, version: string): Outcome {
  only(args, ['json']);
  const { path, document } = load(args.positional[0]);
  const model = modelOf(document);
  if (args.flags.json) {
    return out(JSON.stringify({ schema: 'draftcanvas.inspect/1', tool: { name: 'draftcanvas', version }, diagram: { path, title: document.metadata.title, format: CURRENT_VERSION }, ...modelJson(model) }, null, 2));
  }
  const lines = [`${document.metadata.title} — ${path}`, `${plural(model.rooms.length, 'view')} · ${plural(model.entities.size, 'part')} · ${plural(model.boundaries.size, 'boundary', 'boundaries')} · ${plural(model.relations.length, 'relation')}`, ''];
  for (const room of model.rooms) {
    const owner = room.path.length ? model.entities.get(room.path[room.path.length - 1]!) : undefined;
    lines.push(`${room.path.length ? `Inside ${owner ? labelOf(owner) : room.path.join('/')}` : 'Top view'}${room.level ? ` (${room.level})` : ''}`);
    for (const id of room.entities) {
      const part = model.entities.get(id)!;
      const role = part.c4 && part.c4.role !== 'unspecified' ? `, ${part.c4.role}` : '';
      lines.push(`  ${labelOf(part)}  [${part.category}${role}]${part.technology ? `  ${part.technology}` : ''}`);
    }
    for (const relation of model.relations) {
      if (!room.relations.includes(relation.id)) continue;
      const end = (id: string) => {
        const part = model.entities.get(id) ?? model.boundaries.get(id);
        return part ? labelOf(part) : id;
      };
      lines.push(`  ${end(relation.from)} ${relation.directed ? '→' : '—'} ${end(relation.to)}${relation.semantic ? `  ${relation.semantic}` : ''}${relation.async ? ' (async)' : ''}`);
    }
    lines.push('');
  }
  if (model.unread.length) lines.push(`${plural(model.unread.length, 'connector')} not read as a relation.`);
  return out(lines.join('\n').trimEnd());
}

// --- check -----------------------------------------------------------------------------------

async function check(args: Args, version: string): Promise<Outcome> {
  only(args, ['json', 'repo', 'fail-on']);
  const threshold = text(args, 'fail-on') ?? 'error';
  if (threshold !== 'never' && !(SEVERITIES as readonly string[]).includes(threshold)) throw new UsageError('--fail-on takes error, warning, info or never.');
  const { path, document, repairs } = load(args.positional[0]);
  const folder = text(args, 'repo');
  const report = await checkDiagram(document, folder ? { repo: fileSystemReader(folder) } : {});
  const findings = sortFindings([...repairFindings(repairs), ...report.findings]);
  const counts = countBySeverity(findings);
  const failed = threshold !== 'never' && reaches(findings, threshold as Severity);
  // A check that could not read what it was asked to has not passed, whatever the threshold.
  const broken = findings.some((entry) => entry.rule === 'evidence/reader-failed');
  const code = broken ? EXIT.failed : failed ? EXIT.findings : EXIT.ok;

  if (args.flags.json) {
    return out(JSON.stringify({ schema: 'draftcanvas.check/1', tool: { name: 'draftcanvas', version }, diagram: { path, title: document.metadata.title, format: CURRENT_VERSION }, checked: report.checked, counts, findings }, null, 2), code);
  }
  return out(checkText(document, path, { ...report, findings, counts }, !!folder), code);
}

function checkText(document: DraftDocument, path: string, report: CheckReport, withRepo: boolean): string {
  const { checked } = report;
  const cited = modelOf(document);
  const anyEvidence = [...cited.entities.values()].some((part) => part.evidence.length) || cited.relations.some((relation) => relation.evidence.length);
  const lines = [`${document.metadata.title} — ${path}`];
  lines.push(
    `${plural(checked.views, 'view')} · ${plural(checked.parts, 'part')} · ${plural(checked.relations, 'relation')}` +
      (checked.evidence ? ` · ${plural(checked.evidence.cited, 'evidence entry', 'evidence entries')}, ${checked.evidence.intact} intact` : ''),
  );
  if (!withRepo && anyEvidence) lines.push('Evidence was not checked: name the repository with --repo.');
  lines.push('');
  for (const entry of report.findings) {
    lines.push(`${entry.severity.padEnd(7)} ${entry.rule}`);
    lines.push(`        ${entry.message}`);
    if (entry.scope) lines.push(`        ${entry.scope}`);
  }
  if (report.findings.length) lines.push('');
  const { error, warning, info } = report.counts;
  lines.push(report.findings.length === 0 ? 'Nothing found.' : `${plural(error, 'error')}, ${plural(warning, 'warning')}, ${plural(info, 'note')}.`);
  return lines.join('\n');
}

// --- diff ------------------------------------------------------------------------------------

function diff(args: Args, version: string): Outcome {
  only(args, ['json']);
  const before = load(args.positional[0], 'the earlier diagram');
  const after = load(args.positional[1], 'the later diagram');
  const changes = semanticDiff(before.document, after.document);
  const description = describe(changes);
  const was = new Map(builtinFindings(before.document).map((entry) => [entry.id, entry]));
  const now = new Map(builtinFindings(after.document).map((entry) => [entry.id, entry]));
  const introduced = sortFindings([...now.values()].filter((entry) => !was.has(entry.id)));
  const resolved = sortFindings([...was.values()].filter((entry) => !now.has(entry.id)));

  if (args.flags.json) {
    return out(
      JSON.stringify(
        {
          schema: 'draftcanvas.diff/1',
          tool: { name: 'draftcanvas', version },
          before: { path: before.path, title: before.document.metadata.title },
          after: { path: after.path, title: after.document.metadata.title },
          summary: isEmptyDiff(changes) ? 'No changes.' : description.summary,
          categories: changes.categories,
          elements: changes.elements,
          file: changes.file,
          findings: { introduced, resolved },
        },
        null,
        2,
      ),
    );
  }
  // An unchanged diagram has a summary too (it is worded for a history entry); say the plain thing.
  const lines = isEmptyDiff(changes) ? ['No changes.'] : [description.summary, ...description.body.map((line) => `  ${line}`)];
  if (introduced.length) lines.push('', 'New findings', ...introduced.map((entry) => `  ${entry.severity.padEnd(7)} ${entry.message}`));
  if (resolved.length) lines.push('', 'No longer found', ...resolved.map((entry) => `  ${entry.message}`));
  return out(lines.join('\n'));
}

// --- impact ----------------------------------------------------------------------------------

/** The part `wanted` names: by id, or by its label when exactly one part carries it. */
function partFor(model: ArchModel, wanted: string | undefined): string {
  if (!wanted) throw new UsageError('Name the part: its id, or its label in quotes.');
  if (model.entities.has(wanted) || model.boundaries.has(wanted)) return wanted;
  const all = [...model.entities.values(), ...model.boundaries.values()];
  const plain = (name: string) => name.trim().toLowerCase();
  const named = all.filter((part) => part.name && plain(part.name) === plain(wanted));
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new UsageError(`${named.length} parts are called "${wanted}". Use an id: ${named.map((part) => part.id).join(', ')}.`);
  throw new UsageError(`No part has the id or the label "${wanted}". See inspect for what the diagram holds.`);
}

function impact(args: Args, version: string): Outcome {
  only(args, ['json']);
  const { path, document } = load(args.positional[0]);
  const model = modelOf(document);
  const report = impactOf(document, partFor(model, args.positional[1]), model)!;
  if (args.flags.json) {
    return out(JSON.stringify({ schema: 'draftcanvas.impact/1', tool: { name: 'draftcanvas', version }, diagram: { path, title: document.metadata.title, format: CURRENT_VERSION }, ...report }, null, 2));
  }
  const name = (id: string) => {
    const part = model.entities.get(id) ?? model.boundaries.get(id);
    return part ? labelOf(part) : id;
  };
  const listed = (ids: readonly string[], total = ids.length) => (ids.length ? `${ids.slice(0, 12).map(name).join(', ')}${total > 12 ? ` and ${total - 12} more` : ''}` : 'nothing');
  const lines = [`${report.name} — ${report.kind === 'boundary' ? 'boundary' : 'part'} in ${document.metadata.title}`, report.basis, ''];
  if (report.inside.length) lines.push(`Inside:      ${listed(report.inside)}`);
  if (report.contains.length) lines.push(`Contains:    ${listed(report.contains)}`);
  lines.push(`Reaches:     ${listed(report.downstream.ids, report.downstream.total)}${report.downstream.truncated ? ' (and possibly more)' : ''}`);
  lines.push(`Reached by:  ${listed(report.upstream.ids, report.upstream.total)}${report.upstream.truncated ? ' (and possibly more)' : ''}`);
  for (const crossing of report.crossings) lines.push(`Crosses:     ${listed(crossing.boundaries)} to ${name(crossing.other)}`);
  for (const shared of report.shares) lines.push(`Shares:      ${name(shared.id)} with ${listed(shared.with)}`);
  if (report.flows.length) lines.push(`Flows:       ${report.flows.map((flow) => flow.title || 'Untitled flow').join(', ')}`);
  if (report.openPoints.length) lines.push(`Open points: ${report.openPoints.length}`);
  if (report.outage) {
    lines.push('', 'If it stops', `  ${report.outage.headline}`);
    for (const note of report.outage.notes.slice(0, 12)) lines.push(`  ${note.tone === 'question' ? '?' : note.tone === 'shield' ? '+' : '-'} ${note.text}`);
    for (const flow of report.outage.flows) if (flow.state !== 'unaffected') lines.push(`  ${flow.title || 'Untitled flow'}: ${flow.note}`);
  } else {
    lines.push('', 'The drawing says nothing about what happens if it stops.');
  }
  return out(lines.join('\n'));
}

// --- render ----------------------------------------------------------------------------------

/** The view `--view` names: owner ids from the top, joined with `/`. */
function viewFor(document: DraftDocument, args: Args): DraftDocument {
  const path = text(args, 'view');
  if (!path) return document;
  const view = viewOf(document, path.split('/').filter(Boolean));
  if (!view || view.nodes.length === 0) throw new UsageError(`No view at "${path}". Views are named by the ids of the shapes that own them (see inspect --json).`);
  return view;
}

function render(args: Args): Outcome {
  only(args, ['output', 'theme', 'view', 'transparent']);
  const { path, document } = load(args.positional[0]);
  const theme = text(args, 'theme') ?? 'light';
  if (theme !== 'light' && theme !== 'dark') throw new UsageError('--theme takes light or dark.');
  const view = viewFor(document, args);
  const { svg } = renderDocumentSvg(view, { theme, transparent: args.flags.transparent === true, idScope: text(args, 'view') ?? 'root' });
  return write(args, path, svg);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
