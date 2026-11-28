/**
 * Whether the evidence a diagram cites is still where it says: the file exists, the cited line is
 * in it, the cited name is in it.
 *
 * What this can honestly say is narrow, and the findings keep to it. A name found in a file means
 * the anchor is intact. It does not mean the code defines, calls or handles anything, and nothing
 * here says a relationship is verified. A name no longer found means the evidence no longer
 * supports what it was attached to; whether the architecture changed or only the code moved is for
 * a person to say, so a file found under the same name elsewhere is offered, never assumed.
 */

import type { DraftDocument, DraftEdge, DraftNode, SourceEvidence } from '../../document/types';
import { roomsOf } from '../../depth/tree';
import { finding, type Finding, type Severity } from '../finding';
import { normalizeRepoPath, REPO_LIMITS, type ReadResult, type RepoListing, type RepoReader } from './reader';

/** A name still in the file but this many lines or more from where it was cited has moved. */
const LINE_SLACK = 40;

interface Cited {
  /** Shape or connector id. */
  id: string;
  /** How a sentence names it. */
  label: string;
  room: readonly string[];
  evidence: SourceEvidence;
  index: number;
}

export interface AnchorReport {
  findings: Finding[];
  /** Evidence entries looked at. */
  checked: number;
  /** Entries whose file, line and name were all found. */
  intact: number;
}

export async function checkAnchors(file: DraftDocument, reader: RepoReader, listing?: RepoListing): Promise<AnchorReport> {
  const cited = citedIn(file);
  const findings: Finding[] = [];
  if (cited.length === 0) return { findings, checked: 0, intact: 0 };

  const files = listing ?? (await reader.list());
  const byName = new Map<string, string[]>();
  for (const path of files.paths) {
    const name = baseName(path);
    const list = byName.get(name);
    if (list) list.push(path);
    else byName.set(name, [path]);
  }

  const reads = new Map<string, ReadResult>();
  let budget = REPO_LIMITS.maxReads;
  let outOfBudget = 0;
  let intact = 0;

  for (const entry of cited) {
    const where = entry.room.length ? { room: [...entry.room] } : {};
    const path = normalizeRepoPath(entry.evidence.path);
    const base = { subjects: [entry.id], selector: `${entry.index}:${entry.evidence.path}`, ...where };
    const ref = (at?: number) => [{ path: path ?? entry.evidence.path, ...(entry.evidence.symbol ? { symbol: entry.evidence.symbol } : {}), ...(at ? { line: at } : entry.evidence.line ? { line: entry.evidence.line } : {}) }];
    // An inference a person never confirmed is not grounds for failing a build.
    const strong: Severity = entry.evidence.basis === 'observed' ? 'error' : 'warning';

    if (!path) {
      findings.push(finding({ ...base, rule: 'evidence/unsupported-path', class: 'unsupported', severity: 'info', message: `Evidence for ${entry.label} names a path that is not inside the repository, so it was not read.` }));
      continue;
    }

    let result = reads.get(path);
    if (!result) {
      if (budget <= 0) {
        outOfBudget += 1;
        continue;
      }
      budget -= 1;
      result = await reader.read(path);
      reads.set(path, result);
    }

    if (result.status === 'missing') {
      const elsewhere = (byName.get(baseName(path)) ?? []).filter((other) => other !== path);
      if (files.truncated) {
        findings.push(finding({ ...base, rule: 'evidence/missing-file', class: 'potential-drift', severity: 'warning', message: `Evidence for ${entry.label}: ${path} was not found, but the repository was not listed in full, so it may only have moved.`, evidence: ref() }));
      } else if (elsewhere.length === 0) {
        findings.push(finding({ ...base, rule: 'evidence/missing-file', class: 'drift', severity: strong, message: `Evidence for ${entry.label}: ${path} is no longer in the repository.`, evidence: ref() }));
      } else if (elsewhere.length === 1) {
        findings.push(finding({ ...base, rule: 'evidence/moved-file', class: 'potential-drift', severity: 'warning', message: `Evidence for ${entry.label}: ${path} is gone, and a file of the same name is at ${elsewhere[0]}. It may have moved.`, evidence: ref() }));
      } else {
        findings.push(finding({ ...base, rule: 'evidence/moved-file', class: 'ambiguous', severity: 'warning', message: `Evidence for ${entry.label}: ${path} is gone, and ${elsewhere.length} files share its name (${elsewhere.slice(0, 3).join(', ')}${elsewhere.length > 3 ? ', …' : ''}). Which one it became can't be told.`, evidence: ref() }));
      }
      continue;
    }
    if (result.status !== 'ok') {
      const why = result.status === 'too-large' ? 'is larger than is read' : result.status === 'binary' ? 'is not text' : result.status === 'outside' ? 'leads outside the repository' : 'could not be read';
      findings.push(
        finding({
          ...base,
          rule: 'evidence/unread-file',
          class: result.status === 'unreadable' ? 'tool-error' : 'unsupported',
          severity: result.status === 'unreadable' ? 'warning' : 'info',
          message: `Evidence for ${entry.label}: ${path} ${why}, so it was not checked.`,
          evidence: ref(),
        }),
      );
      continue;
    }

    const lines = result.text.split('\n');
    const { symbol, line } = entry.evidence;
    if (symbol) {
      const found = linesNaming(lines, symbol);
      if (found.length === 0) {
        findings.push(finding({ ...base, rule: 'evidence/missing-symbol', class: 'drift', severity: strong, message: `Evidence for ${entry.label}: "${clip(symbol)}" is no longer in ${path}.`, evidence: ref() }));
        continue;
      }
      if (line !== undefined && !found.some((at) => Math.abs(at - line) < LINE_SLACK)) {
        const nearest = found.reduce((best, at) => (Math.abs(at - line) < Math.abs(best - line) ? at : best));
        findings.push(finding({ ...base, rule: 'evidence/moved-symbol', class: 'stale', severity: 'info', message: `Evidence for ${entry.label}: "${clip(symbol)}" is still in ${path}, now at line ${nearest} rather than ${line}.`, evidence: ref(nearest) }));
        continue;
      }
    } else if (line !== undefined && line > lines.length) {
      findings.push(finding({ ...base, rule: 'evidence/line-out-of-range', class: 'stale', severity: 'info', message: `Evidence for ${entry.label}: ${path} now has ${lines.length} line${lines.length === 1 ? '' : 's'}, and line ${line} was cited.`, evidence: ref() }));
      continue;
    }
    intact += 1;
  }

  if (outOfBudget > 0) {
    findings.push(finding({ rule: 'evidence/incomplete', class: 'tool-error', severity: 'warning', subjects: [], message: `${outOfBudget} evidence ${outOfBudget === 1 ? 'entry was' : 'entries were'} not checked: more than ${REPO_LIMITS.maxReads} files would have had to be read.` }));
  }
  return { findings, checked: cited.length, intact };
}

/** Every evidence entry in the file, room by room, shapes before connectors. */
function citedIn(file: DraftDocument): Cited[] {
  const out: Cited[] = [];
  for (const room of roomsOf(file)) {
    const byId = new Map(room.graph.nodes.map((node) => [node.id, node]));
    for (const node of room.graph.nodes) {
      node.evidence?.forEach((evidence, index) => out.push({ id: node.id, label: nodeLabel(node), room: room.path, evidence, index }));
    }
    for (const edge of room.graph.edges) {
      edge.evidence?.forEach((evidence, index) => out.push({ id: edge.id, label: edgeLabel(edge, byId), room: room.path, evidence, index }));
    }
  }
  return out;
}

function nodeLabel(node: DraftNode | undefined): string {
  const text = node?.text?.split('\n')[0]?.trim();
  if (text) return `"${clip(text)}"`;
  return node ? `an unnamed ${node.type === 'group' ? 'boundary' : node.type === 'ellipse' ? 'junction' : node.type}` : 'a missing shape';
}

function edgeLabel(edge: DraftEdge, byId: ReadonlyMap<string, DraftNode>): string {
  return `the connector from ${nodeLabel(byId.get(edge.source))} to ${nodeLabel(byId.get(edge.target))}`;
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The 1-based lines that name `symbol` as a whole token: not as part of a longer identifier. A
 * symbol that starts or ends with punctuation (`POST /orders`, `Orders.place()`) is matched as
 * written at that end.
 */
export function linesNaming(lines: readonly string[], symbol: string): number[] {
  const needle = symbol.trim();
  if (!needle) return [];
  const word = /[A-Za-z0-9_$]/;
  const before = word.test(needle[0]!) ? '(?<![A-Za-z0-9_$])' : '';
  const after = word.test(needle[needle.length - 1]!) ? '(?![A-Za-z0-9_$])' : '';
  const pattern = new RegExp(before + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + after);
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (pattern.test(line)) found.push(index + 1);
  });
  return found;
}
