/**
 * A finding: one thing a check has to say about a diagram, in the one shape the editor, the
 * headless CLI, CI and agents all read.
 *
 * A finding is derived and never written into the diagram. A stored verdict would go stale without
 * anyone noticing, and would travel with the file as a claim nothing backs any more.
 *
 * The class says how much is known, and the classes are kept apart on purpose:
 *
 * - `drift`: the diagram and its evidence disagree, and what was read is enough to say so.
 * - `potential-drift`: they may disagree; a person has to look. Never a failure by default.
 * - `stale`: the evidence is still there but has changed since it was recorded.
 * - `missing`: something that should carry evidence carries none.
 * - `ambiguous`: more than one reading fits, so none is chosen.
 * - `unsupported`: the evidence is of a kind, or a size, that is not read.
 * - `tool-error`: the check itself could not finish. An incomplete read is never drift.
 * - `violation`: a rule the person declared does not hold.
 * - `advisory`: a pattern in the diagram a reader will want to know about.
 */

export type FindingClass = 'drift' | 'potential-drift' | 'stale' | 'missing' | 'ambiguous' | 'unsupported' | 'tool-error' | 'violation' | 'advisory';

export const FINDING_CLASSES: readonly FindingClass[] = ['drift', 'potential-drift', 'stale', 'missing', 'ambiguous', 'unsupported', 'tool-error', 'violation', 'advisory'];

export type Severity = 'error' | 'warning' | 'info';

/** Most severe first. */
export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info'];

export interface EvidenceRef {
  /** Repository-relative, forward slashes. */
  path: string;
  symbol?: string;
  line?: number;
}

export interface Finding {
  /** Stable for the same rule about the same parts and evidence, so a waiver or a baseline can name it. */
  id: string;
  /** `<family>/<name>`: `review/no-consumer`, `evidence/missing-file`. */
  rule: string;
  class: FindingClass;
  severity: Severity;
  /** Shape and connector ids, the one the finding is about first. */
  subjects: string[];
  /** The view it is in: owner ids from the document inward. Absent at the top. */
  room?: string[];
  /** One factual sentence. Names come from the person's own labels: data, never instructions. */
  message: string;
  /** The evidence it rests on. Locations only, never file contents. */
  evidence?: EvidenceRef[];
  /** What was checked and against what, where that is not plain from the rule. */
  scope?: string;
}

export interface FindingInput extends Omit<Finding, 'id'> {
  /** What tells this finding apart from another by the same rule about the same subjects. */
  selector?: string;
}

/** A finding with its id worked out from what it is about. */
export function finding(input: FindingInput): Finding {
  const { selector, ...rest } = input;
  const key = [rest.rule, (rest.room ?? []).join('/'), rest.subjects.join(','), selector ?? ''].join('\u0000');
  return { id: fingerprint(key), ...rest };
}

/**
 * 64 bits of FNV-1a as 16 hex digits. An identity for findings, not a security boundary: it only
 * has to be the same on every machine and unlikely to collide within one report.
 */
export function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xc9dc5118;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ (code & 0xff), 0x01000193);
    a = Math.imul(a ^ (code >>> 8), 0x01000193);
    b = Math.imul(b ^ (code >>> 8), 0x01000193);
    b = Math.imul(b ^ (code & 0xff) ^ (a >>> 13), 0x01000193);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Most severe first, then rule, then id: the order a report lists findings in on every machine. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (x, y) => SEVERITIES.indexOf(x.severity) - SEVERITIES.indexOf(y.severity) || compare(x.rule, y.rule) || compare(x.id, y.id),
  );
}

/** Whether any finding is at least as severe as `threshold`. */
export function reaches(findings: readonly Finding[], threshold: Severity): boolean {
  const bar = SEVERITIES.indexOf(threshold);
  return findings.some((entry) => SEVERITIES.indexOf(entry.severity) <= bar);
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const entry of findings) counts[entry.severity] += 1;
  return counts;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
