/**
 * What an element is in C4 terms, derived — never stored — from what the document already says: the
 * shape's own kind, the level of the view it sits in, and whether it sits inside a room or a system
 * boundary. Draft Canvas has no separate C4 model and this doesn't invent one; it reads the native
 * one out loud, for the agent bridge and anything else that needs to say "container" rather than
 * "service in a container-level room".
 *
 * Two things are kept apart because they are different questions:
 *
 * - **role** — what kind of element this is (`person`, `software-system`, `container`, `component`).
 * - **scope** — whether it belongs to the thing the view is about (`internal`) or is outside it
 *   (`external`). An external system in a component view is still a software system.
 *
 * Where the native model can't settle either one, the answer is `unspecified`, with the reason — a
 * service drawn in a component view might be a supporting container or a component somebody drew as
 * a service, and guessing would put words in the diagram's mouth.
 */

import type { DraftNode, ViewLevel } from '../document/types';

export type C4Role = 'person' | 'software-system' | 'container' | 'component' | 'unspecified';
export type C4Scope = 'internal' | 'external' | 'unspecified';

export interface C4Classification {
  role: C4Role;
  scope: C4Scope;
  /** Always true: nothing here is stored; it follows from the fields named in `basis`. */
  derived: true;
  /** Why, in a few words — the native facts the answer rests on. */
  basis: string;
}

export interface C4Context {
  /** The view's level — its own, or the one it inherits (see `depth/level.ts`'s `effectiveLevel`). */
  level: ViewLevel | undefined;
  /** The room is the inside of another shape (a drill-down), so its contents belong to that shape. */
  insideOwner?: DraftNode;
  /** The `system` boundary the node sits in, if any (via `parentId`, not geometry). */
  systemBoundary?: DraftNode;
}

/** Architecture elements only — boundaries, notes, text, code and junctions aren't C4 elements. */
export function isC4Element(node: DraftNode): boolean {
  return node.type === 'service' || node.type === 'database' || node.type === 'queue' || node.type === 'actor' || node.type === 'component';
}

function isExternal(node: DraftNode): boolean {
  if (node.type === 'service') return node.serviceKind === 'external';
  if (node.type === 'actor') return node.actorKind === 'thirdParty' || node.actorKind === 'system';
  return false;
}

export function classify(node: DraftNode, context: C4Context): C4Classification | undefined {
  if (!isC4Element(node)) return undefined;
  const level = context.level && context.level !== 'none' ? context.level : undefined;
  const role = roleOf(node, level);
  let scope: C4Scope = 'unspecified';
  let scopeBasis = '';
  if (isExternal(node)) {
    scope = 'external';
    scopeBasis = node.type === 'service' ? 'external-system kind' : `${node.actorKind} actor`;
  } else if (context.systemBoundary) {
    scope = 'internal';
    scopeBasis = `inside system boundary "${context.systemBoundary.text ?? context.systemBoundary.id}"`;
  } else if (context.insideOwner && node.type !== 'actor') {
    scope = 'internal';
    scopeBasis = `inside "${context.insideOwner.text ?? context.insideOwner.id}"`;
  }
  return {
    role: role.role,
    scope,
    derived: true,
    basis: [role.basis, scopeBasis].filter(Boolean).join('; '),
  };
}

function roleOf(node: DraftNode, level: Exclude<ViewLevel, 'none'> | undefined): { role: C4Role; basis: string } {
  const at = level ? `${level} level` : 'no level set';
  switch (node.type) {
    case 'actor': {
      const kind = node.actorKind ?? 'human';
      if (kind === 'human' || kind === 'group') return { role: 'person', basis: `${kind} actor` };
      if (kind === 'device') return { role: 'unspecified', basis: 'a device has no C4 role' };
      return level ? { role: 'software-system', basis: `${kind} actor at ${at}` } : { role: 'unspecified', basis: `${kind} actor, ${at}` };
    }
    case 'service':
      if (node.serviceKind === 'external') return level ? { role: 'software-system', basis: `external system at ${at}` } : { role: 'unspecified', basis: 'external system, no level set' };
      if (level === 'context') return { role: 'software-system', basis: `service at ${at}` };
      if (level === 'container') return { role: 'container', basis: `service at ${at}` };
      // A component view may show supporting containers; a service there could be either.
      return { role: 'unspecified', basis: level ? `service at ${at}: container or component can't be told apart` : 'no level set' };
    case 'database':
    case 'queue':
      if (level === 'container' || level === 'component') return { role: 'container', basis: `${node.type === 'database' ? 'data store' : 'message broker'} at ${at}` };
      return { role: 'unspecified', basis: level ? `${node.type} at ${at}` : 'no level set' };
    case 'component':
      if (level === 'component') return { role: 'component', basis: `component at ${at}` };
      return { role: 'unspecified', basis: level ? `component shape at ${at}` : 'no level set' };
    default:
      return { role: 'unspecified', basis: '' };
  }
}

/**
 * Remarks about a view's mix of levels — never a refusal. Mixed abstraction is sometimes exactly what
 * a person means to draw; this only says out loud what a reader will notice.
 */
export function levelAdvisories(nodes: readonly DraftNode[], level: ViewLevel | undefined): string[] {
  if (!level || level === 'none') return [];
  const out: string[] = [];
  const components = nodes.filter((n) => n.type === 'component').length;
  const stores = nodes.filter((n) => n.type === 'database' || n.type === 'queue').length;
  if (level === 'context' && components > 0) out.push(`${components} component shape(s) in a system-context view; components usually belong in a component view inside a container.`);
  if (level === 'context' && stores > 0) out.push(`${stores} data store/queue shape(s) in a system-context view; those are usually containers, shown one level in.`);
  if (level === 'container' && components > 0) out.push(`${components} component shape(s) in a container view; components usually live inside a container's own view.`);
  return out;
}
