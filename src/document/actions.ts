/**
 * Canvas-level actions — what the meeting decided somebody has to do next.
 *
 * The same shape as `flow.ts`: pure functions over a `DraftDocument`, each returning a new
 * document that reuses everything it didn't touch, and each returning the *same* document when
 * it changed nothing so the store's no-op guard keeps working. Nothing here knows about React,
 * the store, or how any of it is drawn.
 *
 * Unlike flows, actions are root-only (`DraftDocument.actions`, with no counterpart on
 * `DraftInside`). A document handed to these functions while the editor is inside a room is the
 * room's view, which carries the root's `actions` array by way of `depth/tree.ts`'s `viewOf` —
 * and `embed` carries it back out again. So capture works at any depth without anything here
 * having to know what depth is.
 */

import { createId } from './ids';
import { LIMITS } from './limits';
import type { DraftAction, DraftDocument } from './types';

/** The id prefix actions use, kept here so `validate.ts` and the factory agree. */
export const ACTION_ID_PREFIX = 'a';

function withActions(doc: DraftDocument, actions: DraftAction[]): DraftDocument {
  return actions === doc.actions ? doc : { ...doc, actions };
}

/**
 * What an action's text becomes once it is committed.
 *
 * Single-line by construction: an action is one thing said out loud, and a capture line that
 * accepted newlines would be a note with a checkbox. Anything a paste drags in — line breaks,
 * tabs, runs of spaces — collapses to one space rather than being refused.
 */
export function normalizeActionText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxActionLength).trim();
}

export function createAction(text: string, anchor?: DraftAction['anchor']): DraftAction | null {
  const normalized = normalizeActionText(text);
  if (!normalized) return null;
  const action: DraftAction = { id: createId(ACTION_ID_PREFIX), text: normalized };
  if (anchor) action.anchor = { ...anchor };
  return action;
}

export function findAction(doc: DraftDocument, actionId: string): DraftAction | undefined {
  return doc.actions.find((action) => action.id === actionId);
}

export function openActions(doc: DraftDocument): DraftAction[] {
  return doc.actions.filter((action) => !action.done);
}

export function doneActions(doc: DraftDocument): DraftAction[] {
  return doc.actions.filter((action) => action.done);
}

/**
 * Appends an action. Refuses past `LIMITS.maxActions` rather than dropping the oldest — losing
 * something a person said out loud, silently, to make room for something else they said out
 * loud, is the one behaviour this list must never have.
 */
export function addAction(doc: DraftDocument, action: DraftAction): DraftDocument {
  if (doc.actions.length >= LIMITS.maxActions) return doc;
  return withActions(doc, [...doc.actions, action]);
}

export function updateActionText(doc: DraftDocument, actionId: string, text: string): DraftDocument {
  const normalized = normalizeActionText(text);
  // An action edited down to nothing is a removal said a different way — the alternative is an
  // empty row that can only be fixed by deleting it.
  if (!normalized) return removeAction(doc, actionId);
  let changed = false;
  const actions = doc.actions.map((action) => {
    if (action.id !== actionId || action.text === normalized) return action;
    changed = true;
    return { ...action, text: normalized };
  });
  return changed ? withActions(doc, actions) : doc;
}

export function setActionDone(doc: DraftDocument, actionId: string, done: boolean): DraftDocument {
  let changed = false;
  const actions = doc.actions.map((action) => {
    if (action.id !== actionId || Boolean(action.done) === done) return action;
    changed = true;
    // Absent, not `false`: "open" is the absence of the field everywhere else in this model, and
    // writing `done: false` would put a key in the file for every action that was never ticked.
    const next = { ...action };
    if (done) next.done = true;
    else delete next.done;
    return next;
  });
  return changed ? withActions(doc, actions) : doc;
}

/** Clears an action's architecture context without touching what it says. */
export function clearActionAnchor(doc: DraftDocument, actionId: string): DraftDocument {
  let changed = false;
  const actions = doc.actions.map((action) => {
    if (action.id !== actionId || !action.anchor) return action;
    changed = true;
    const next = { ...action };
    delete next.anchor;
    return next;
  });
  return changed ? withActions(doc, actions) : doc;
}

export function removeAction(doc: DraftDocument, actionId: string): DraftDocument {
  const actions = doc.actions.filter((action) => action.id !== actionId);
  return actions.length === doc.actions.length ? doc : withActions(doc, actions);
}

export function clearDoneActions(doc: DraftDocument): DraftDocument {
  const actions = doc.actions.filter((action) => !action.done);
  return actions.length === doc.actions.length ? doc : withActions(doc, actions);
}

/**
 * Drops anchors that point at something no longer in the file.
 *
 * Deliberately *not* called on every edit: an anchor is resolved by lookup when a row is drawn,
 * so one pointing at a deleted shape already reads as "no context" without anything being
 * rewritten. This exists for the one place where leaving it would be a lie on disk — see
 * `validate.ts`, which runs it across a whole imported file once every room is in.
 *
 * The action always survives. It is the thing somebody has to do; the architecture it came from
 * is a bonus, and dropping the row would lose the part that mattered.
 */
export function pruneActionAnchors(doc: DraftDocument, known: (anchor: NonNullable<DraftAction['anchor']>) => boolean): DraftDocument {
  let changed = false;
  const actions = doc.actions.map((action) => {
    if (!action.anchor || known(action.anchor)) return action;
    changed = true;
    const next = { ...action };
    delete next.anchor;
    return next;
  });
  return changed ? withActions(doc, actions) : doc;
}
