import { refractor } from 'refractor/core';
import bash from 'refractor/bash';
import http from 'refractor/http';
import java from 'refractor/java';
import javascript from 'refractor/javascript';
import json from 'refractor/json';
import markup from 'refractor/markup';
import sql from 'refractor/sql';
import typescript from 'refractor/typescript';
import yaml from 'refractor/yaml';
import type { RootContent, Root as HastRoot } from 'hast';
import { Lru } from '../../lib/lru';
import type { CodeLanguage } from '../../document/types';

/**
 * Syntax highlighting for code cards.
 *
 * Only the languages a developer actually pastes into an architecture
 * discussion are registered — importing `refractor/all` would add roughly half
 * a megabyte for languages nobody will use here.
 *
 * Highlighting is synchronous by design: an async highlighter makes code cards
 * flash unstyled on every pan, and blocks the canvas on large documents.
 */
refractor.register(bash);
refractor.register(http);
refractor.register(java);
refractor.register(javascript);
refractor.register(json);
refractor.register(markup);
refractor.register(sql);
refractor.register(typescript);
refractor.register(yaml);

/** Maps our language ids onto Prism grammar names. */
const GRAMMARS: Record<CodeLanguage, string | null> = {
  plaintext: null,
  java: 'java',
  javascript: 'javascript',
  typescript: 'typescript',
  json: 'json',
  yaml: 'yaml',
  xml: 'markup',
  sql: 'sql',
  bash: 'bash',
  http: 'http',
  log: null,
};

export const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  plaintext: 'Text',
  java: 'Java',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  bash: 'Shell',
  http: 'HTTP',
  log: 'Log',
};

/** A scope is the Prism token class we colour by, e.g. `keyword` or `string`. */
export type TokenScope = string;

export interface CodeToken {
  text: string;
  scope: TokenScope | null;
}

export type CodeLine = CodeToken[];

/** Above this, highlighting costs more than it is worth; the card renders plain. */
const MAX_HIGHLIGHT_LINES = 2000;

const cache = new Lru<string, CodeLine[]>(200);

export function tokenizeCode(code: string, language: CodeLanguage): CodeLine[] {
  const key = `${language}:${code.length}:${cheapHash(code)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  return cache.set(key, computeLines(code, language));
}

function computeLines(code: string, language: CodeLanguage): CodeLine[] {
  const rawLines = code.split('\n');
  if (rawLines.length > MAX_HIGHLIGHT_LINES) {
    return rawLines.map((line) => [{ text: expandTabs(line), scope: null }]);
  }
  if (language === 'log') return rawLines.map(highlightLogLine);

  const grammar = GRAMMARS[language];
  if (!grammar) return rawLines.map((line) => [{ text: expandTabs(line), scope: null }]);

  let tree: HastRoot;
  try {
    tree = refractor.highlight(code, grammar);
  } catch {
    // An unregistered or failing grammar must never take the canvas down.
    return rawLines.map((line) => [{ text: expandTabs(line), scope: null }]);
  }
  return flattenToLines(tree);
}

/**
 * Flattens refractor's hast tree into one array of tokens per line.
 *
 * This is the step that makes SVG export possible at all: a nested element tree
 * cannot become `<tspan>`s, but a flat list of `{ text, scope }` per line can be
 * rendered identically as DOM spans and as SVG tspans.
 */
export function flattenToLines(root: HastRoot): CodeLine[] {
  const lines: CodeLine[] = [[]];

  const visit = (node: RootContent, scope: TokenScope | null): void => {
    if (node.type === 'text') {
      const parts = node.value.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) lines.push([]);
        if (part !== '') lines[lines.length - 1]!.push({ text: expandTabs(part), scope });
      });
      return;
    }
    if (node.type !== 'element') return;
    const classes = node.properties?.className;
    const next = scopeFrom(classes) ?? scope;
    for (const child of node.children) visit(child as RootContent, next);
  };

  for (const child of root.children) visit(child as RootContent, null);
  return lines;
}

/**
 * Prism emits `class="token keyword"`. The meaningful part is whatever follows
 * `token`; the most specific class wins.
 */
function scopeFrom(className: unknown): TokenScope | null {
  if (!Array.isArray(className)) return null;
  const names = className.filter((c): c is string => typeof c === 'string' && c !== 'token');
  return names.length > 0 ? names[names.length - 1]! : null;
}

const LOG_LEVEL = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\b/;
const LOG_TIMESTAMP =
  /^\s*\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?/;

/**
 * Logs are not a Prism grammar, but they are one of the things developers most
 * often paste into a debugging discussion, so they get a small dedicated pass:
 * timestamp, level, and the rest.
 */
function highlightLogLine(line: string): CodeLine {
  const expanded = expandTabs(line);
  const tokens: CodeLine = [];
  let rest = expanded;

  const stamp = LOG_TIMESTAMP.exec(rest);
  if (stamp) {
    tokens.push({ text: stamp[0], scope: 'log-timestamp' });
    rest = rest.slice(stamp[0].length);
  }

  const level = LOG_LEVEL.exec(rest);
  if (level && level.index !== undefined) {
    const before = rest.slice(0, level.index);
    if (before) tokens.push({ text: before, scope: null });
    tokens.push({ text: level[0], scope: `log-${level[0].toLowerCase()}` });
    rest = rest.slice(level.index + level[0].length);
  }

  if (rest) tokens.push({ text: rest, scope: null });
  return tokens.length > 0 ? tokens : [{ text: expanded, scope: null }];
}

const TAB_WIDTH = 2;

/**
 * Tabs are expanded at tokenize time. Monospace geometry is then exactly
 * `charWidth * length`, which is what lets the exporter place code without
 * measuring anything.
 */
function expandTabs(text: string): string {
  if (!text.includes('\t')) return text;
  let out = '';
  for (const ch of text) {
    if (ch === '\t') out += ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH) || TAB_WIDTH);
    else out += ch;
  }
  return out;
}

function cheapHash(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return hash;
}

export function clearHighlightCache(): void {
  cache.clear();
}
