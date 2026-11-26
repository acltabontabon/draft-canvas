/**
 * isomorphic-git reads a global `Buffer` (its code: "fix usage in bundlers before Buffer dependency
 * is removed #1855"). The history worker imports this first, before isomorphic-git loads; nothing
 * on the editor's thread does, so the page's globals are never touched (ADR-1).
 */
import { Buffer } from 'buffer';

const scope = globalThis as { Buffer?: unknown };
scope.Buffer ??= Buffer;
