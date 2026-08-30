import type { ThemeName } from '../theme/tokens';
import type { TokenScope } from './highlight';

/**
 * Token colours, as literal hex.
 *
 * Both renderers read from this map and inline the result — `style.color` in
 * the DOM, `fill` in SVG. Going through CSS classes instead would mean the SVG
 * exporter had to duplicate a stylesheet, which is exactly the kind of drift
 * this design exists to prevent.
 */
export type CodeTheme = {
  plain: string;
  scopes: Record<string, string>;
};

const DARK_CODE: CodeTheme = {
  plain: '#c9d1da',
  scopes: {
    comment: '#5d6673',
    prolog: '#5d6673',
    doctype: '#5d6673',
    cdata: '#5d6673',
    punctuation: '#8b95a3',
    property: '#7fc4f0',
    tag: '#7fc4f0',
    constant: '#e0aa3e',
    symbol: '#e0aa3e',
    deleted: '#e2687f',
    boolean: '#e0aa3e',
    number: '#e0aa3e',
    selector: '#8fdda8',
    'attr-name': '#c0abf2',
    string: '#8fdda8',
    char: '#8fdda8',
    builtin: '#5fd6c9',
    inserted: '#8fdda8',
    operator: '#8b95a3',
    entity: '#5fd6c9',
    url: '#5fd6c9',
    variable: '#f0a1b0',
    atrule: '#c0abf2',
    'attr-value': '#8fdda8',
    keyword: '#c0abf2',
    function: '#7fc4f0',
    'class-name': '#5fd6c9',
    regex: '#e0aa3e',
    important: '#e2687f',
    annotation: '#e0aa3e',
    namespace: '#98a1b0',
    'log-timestamp': '#6d7885',
    'log-error': '#e2687f',
    'log-fatal': '#e2687f',
    'log-severe': '#e2687f',
    'log-warn': '#e0aa3e',
    'log-warning': '#e0aa3e',
    'log-info': '#5fd6c9',
    'log-debug': '#98a1b0',
    'log-trace': '#6d7885',
  },
};

const LIGHT_CODE: CodeTheme = {
  plain: '#2b313b',
  scopes: {
    comment: '#8b939f',
    prolog: '#8b939f',
    doctype: '#8b939f',
    cdata: '#8b939f',
    punctuation: '#6a7382',
    property: '#1b5f9e',
    tag: '#1b5f9e',
    constant: '#8a5a08',
    symbol: '#8a5a08',
    deleted: '#b23350',
    boolean: '#8a5a08',
    number: '#8a5a08',
    selector: '#1f6237',
    'attr-name': '#5b41a8',
    string: '#1f6237',
    char: '#1f6237',
    builtin: '#0d6f66',
    inserted: '#1f6237',
    operator: '#6a7382',
    entity: '#0d6f66',
    url: '#0d6f66',
    variable: '#a03350',
    atrule: '#5b41a8',
    'attr-value': '#1f6237',
    keyword: '#5b41a8',
    function: '#1b5f9e',
    'class-name': '#0d6f66',
    regex: '#8a5a08',
    important: '#b23350',
    annotation: '#8a5a08',
    namespace: '#6a7382',
    'log-timestamp': '#8b939f',
    'log-error': '#b23350',
    'log-fatal': '#b23350',
    'log-severe': '#b23350',
    'log-warn': '#8a5a08',
    'log-warning': '#8a5a08',
    'log-info': '#0d6f66',
    'log-debug': '#6a7382',
    'log-trace': '#8b939f',
  },
};

export const CODE_THEMES: Record<ThemeName, CodeTheme> = {
  dark: DARK_CODE,
  light: LIGHT_CODE,
};

export function colorForScope(theme: CodeTheme, scope: TokenScope | null): string {
  if (!scope) return theme.plain;
  return theme.scopes[scope] ?? theme.plain;
}
