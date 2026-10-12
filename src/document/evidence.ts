import type { SourceEvidence } from './types';

export const EVIDENCE_LIMIT = 8;
export const EVIDENCE_FIELDS = ['path', 'basis', 'symbol', 'commit', 'line', 'explanation'] as const;

/** A reference names code relative to a repository; it grants no filesystem access. */
export function isEvidence(value: unknown): value is SourceEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  // oxlint-disable-next-line no-control-regex -- references must not contain hidden control characters
  const text = (field: string, max: number, required = false) => item[field] === undefined ? !required : typeof item[field] === 'string' && !!String(item[field]).trim() && [...String(item[field])].length <= max && !/[\u0000-\u001f\u007f]/.test(String(item[field]));
  return Object.keys(item).every((key) => (EVIDENCE_FIELDS as readonly string[]).includes(key)) && text('path', 500, true) && !/^(?:[/\\]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(String(item.path)) && !String(item.path).split(/[/\\]/).includes('..') && (item.basis === 'observed' || item.basis === 'inferred') && text('symbol', 200) && text('commit', 80) && text('explanation', 300) && (item.line === undefined || (Number.isSafeInteger(item.line) && Number(item.line) > 0));
}

export function parseEvidence(value: unknown): SourceEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(isEvidence).slice(0, EVIDENCE_LIMIT).map((entry) => ({ ...entry }));
  return entries.length ? entries : undefined;
}
