import { beforeEach, describe, expect, it } from 'vitest';
import {
  addAction,
  clearActionAnchor,
  clearDoneActions,
  createAction,
  normalizeActionText,
  removeAction,
  setActionDone,
  updateActionText,
} from '../src/document/actions';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { LIMITS } from '../src/document/limits';
import { CURRENT_VERSION } from '../src/document/types';
import type { DraftDocument } from '../src/document/types';
import { serializeDocument } from '../src/export/project';
import { parseDocument } from '../src/document/validate';
import { embed, viewOf } from '../src/depth/tree';
import { captureAnchorFor } from '../src/takeaways/capture';
import { isEmpty, openCount, takeawaysFor } from '../src/takeaways/collect';
import { takeawaysMarkdown } from '../src/takeaways/markdown';

function doc(): DraftDocument {
  return createDocument('Payments Platform');
}

function withAction(base: DraftDocument, text: string, anchor?: { kind: 'node' | 'edge'; id: string }) {
  const action = createAction(text, anchor);
  if (!action) throw new Error('expected an action');
  return { doc: addAction(base, action), id: action.id };
}

describe('action text', () => {
  it('is one line — an action is one thing somebody said', () => {
    expect(normalizeActionText('  Confirm\n the   timeout\t ')).toBe('Confirm the timeout');
  });

  it('refuses to become an empty row', () => {
    expect(createAction('   ')).toBeNull();
    expect(createAction('\n\n')).toBeNull();
  });

  it('clamps to the limit rather than rejecting', () => {
    const action = createAction('x'.repeat(LIMITS.maxActionLength + 50));
    expect(action?.text).toHaveLength(LIMITS.maxActionLength);
  });
});

describe('operations', () => {
  it('returns the same document when nothing changed, so no dead undo step is made', () => {
    const base = withAction(doc(), 'Check DLQ retention');
    expect(updateActionText(base.doc, base.id, 'Check DLQ retention')).toBe(base.doc);
    expect(setActionDone(base.doc, base.id, false)).toBe(base.doc);
    expect(removeAction(base.doc, 'nope')).toBe(base.doc);
    expect(clearDoneActions(base.doc)).toBe(base.doc);
    expect(clearActionAnchor(base.doc, base.id)).toBe(base.doc);
  });

  it('writes `done` as absent rather than false', () => {
    const base = withAction(doc(), 'Add monitoring');
    const ticked = setActionDone(base.doc, base.id, true);
    expect(ticked.actions[0]!.done).toBe(true);
    const untickedAgain = setActionDone(ticked, base.id, false);
    expect(Object.hasOwn(untickedAgain.actions[0]!, 'done')).toBe(false);
  });

  it('treats an edit down to nothing as a removal, not an empty row', () => {
    const base = withAction(doc(), 'Add monitoring');
    expect(updateActionText(base.doc, base.id, '   ').actions).toHaveLength(0);
  });

  it('refuses past the cap instead of dropping the oldest', () => {
    let full = doc();
    for (let index = 0; index < LIMITS.maxActions; index += 1) {
      full = withAction(full, `Action ${index}`).doc;
    }
    const refused = withAction(full, 'One too many');
    expect(refused.doc.actions).toHaveLength(LIMITS.maxActions);
    expect(refused.doc.actions[0]!.text).toBe('Action 0');
  });

  it('clears only the anchor, never the text', () => {
    const base = withAction(doc(), 'Confirm timeout', { kind: 'edge', id: 'e1' });
    const cleared = clearActionAnchor(base.doc, base.id);
    expect(cleared.actions[0]!.text).toBe('Confirm timeout');
    expect(cleared.actions[0]!.anchor).toBeUndefined();
  });
});

describe('the file format', () => {
  it('omits an empty list, so existing diagrams keep the bytes they had', () => {
    expect(serializeDocument(doc())).not.toContain('actions');
  });

  it('round-trips actions, done state and anchors', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, text: 'Payments' });
    let base = { ...doc(), nodes: [node] };
    base = withAction(base, 'Confirm timeout @Kevin', { kind: 'node', id: node.id }).doc;
    const ticked = setActionDone(base, base.actions[0]!.id, true);

    const result = parseDocument(serializeDocument(ticked));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.actions).toHaveLength(1);
    expect(result.document.actions[0]!.text).toBe('Confirm timeout @Kevin');
    expect(result.document.actions[0]!.done).toBe(true);
    expect(result.document.actions[0]!.anchor).toEqual({ kind: 'node', id: node.id });
    expect(result.document.version).toBe(CURRENT_VERSION);
  });

  it('keeps the action and drops the anchor when what it pointed at is gone', () => {
    const base = withAction(doc(), 'Confirm timeout', { kind: 'edge', id: 'e_missing' }).doc;
    const result = parseDocument(serializeDocument(base));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.actions).toHaveLength(1);
    expect(result.document.actions[0]!.anchor).toBeUndefined();
    expect(result.repairs.join(' ')).toContain('no longer here');
  });

  it('keeps an anchor that points into a room, which is validated after the root', () => {
    const inner = createNode({ type: 'service', x: 10, y: 10, text: 'Auth' });
    const owner = {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Payments API' }),
      inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } },
    };
    let base: DraftDocument = { ...doc(), nodes: [owner] };
    base = withAction(base, 'Check the token store', { kind: 'node', id: inner.id }).doc;

    const result = parseDocument(serializeDocument(base));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.actions[0]!.anchor).toEqual({ kind: 'node', id: inner.id });
  });

  it('drops an empty action and repairs rather than rejecting the file', () => {
    const raw = JSON.stringify({
      ...JSON.parse(serializeDocument(doc())),
      actions: [{ id: 'a1', text: '   ' }, { id: 'a2', text: 'Real one' }, 'nonsense'],
    });
    const result = parseDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.actions.map((action) => action.text)).toEqual(['Real one']);
  });

  it('ignores an actions list smuggled into a room — the meeting is the file', () => {
    const inner = createNode({ type: 'service', x: 10, y: 10, text: 'Auth' });
    const file = JSON.parse(serializeDocument(doc())) as Record<string, unknown>;
    const owner = {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Payments API' }),
      inside: {
        nodes: [inner],
        edges: [],
        flows: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        actions: [{ id: 'a_room', text: 'Should not surface' }],
      },
    };
    file.nodes = [owner];

    const result = parseDocument(JSON.stringify(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.actions).toEqual([]);
  });
});

describe('depth', () => {
  /*
   * The trap this whole feature is most likely to fall into: `viewOf` hands a room every
   * root-level field through a spread, so an action captured inside one appears to work — and
   * `embed` would drop it on the way back out unless it carries `actions` home too.
   */
  it('carries an action captured inside a room back out to the file', () => {
    const inner = createNode({ type: 'service', x: 10, y: 10, text: 'Auth' });
    const owner = {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Payments API' }),
      inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } },
    };
    const file: DraftDocument = { ...doc(), nodes: [owner] };

    const room = viewOf(file, [owner.id]);
    expect(room).toBeDefined();
    if (!room) return;
    const edited = withAction(room, 'Check the token store').doc;

    const backOut = embed(file, [owner.id], edited);
    expect(backOut.actions.map((action) => action.text)).toEqual(['Check the token store']);
  });
});

describe('the anchor rule', () => {
  const nothing = { nodes: [], edges: [] };

  it('keeps the single selected element, and nothing when several are selected', () => {
    expect(captureAnchorFor({ presenting: false, selection: { nodes: ['n1'], edges: [] } })).toEqual({
      kind: 'node',
      id: 'n1',
    });
    expect(captureAnchorFor({ presenting: false, selection: { nodes: [], edges: ['e1'] } })).toEqual({
      kind: 'edge',
      id: 'e1',
    });
    expect(captureAnchorFor({ presenting: false, selection: { nodes: ['n1', 'n2'], edges: [] } })).toBeUndefined();
    expect(captureAnchorFor({ presenting: false, selection: { nodes: ['n1'], edges: ['e1'] } })).toBeUndefined();
    expect(captureAnchorFor({ presenting: false, selection: nothing })).toBeUndefined();
  });

  it('while presenting, takes the step over anything else', () => {
    expect(
      captureAnchorFor({ presenting: true, selection: { nodes: ['n9'], edges: [] }, stepEdgeId: 'e3' }),
    ).toEqual({ kind: 'edge', id: 'e3' });
    // A frame step holds up shapes rather than a connection.
    expect(captureAnchorFor({ presenting: true, selection: nothing, stepNodeId: 'n4' })).toEqual({
      kind: 'node',
      id: 'n4',
    });
    expect(captureAnchorFor({ presenting: true, selection: nothing })).toBeUndefined();
  });
});

describe('takeaways', () => {
  let file: DraftDocument;
  let edgeId: string;

  beforeEach(() => {
    const payments = createNode({ type: 'service', x: 0, y: 0, text: 'Payment Service' });
    const settlement = createNode({ type: 'service', x: 300, y: 0, text: 'Settlement Service' });
    const decision = {
      ...createNode({ type: 'note', x: 0, y: 200, text: 'Use asynchronous processing' }),
      noteKind: 'decision' as const,
    };
    const question = {
      ...createNode({ type: 'note', x: 0, y: 300, text: 'Who owns retry?' }),
      noteKind: 'question' as const,
    };
    const warning = {
      ...createNode({ type: 'note', x: 0, y: 400, text: 'This path is unbounded' }),
      noteKind: 'warning' as const,
    };
    edgeId = 'e_settle';
    file = {
      ...doc(),
      nodes: [payments, settlement, decision, question, warning],
      edges: [createEdge({ id: edgeId, source: payments.id, target: settlement.id })],
    };
  });

  it('reads decisions and questions off notes already on the canvas, and leaves warnings alone', () => {
    const takeaways = takeawaysFor(file);
    expect(takeaways.decisions.map((note) => note.text)).toEqual(['Use asynchronous processing']);
    expect(takeaways.questions.map((note) => note.text)).toEqual(['Who owns retry?']);
    expect(isEmpty(takeaways)).toBe(false);
  });

  it('is empty for a canvas that decided nothing', () => {
    expect(isEmpty(takeawaysFor(doc()))).toBe(true);
    expect(openCount(takeawaysFor(doc()))).toBe(0);
  });

  it('names a connector the way the rest of the product names one', () => {
    const withIt = withAction(file, 'Confirm timeout', { kind: 'edge', id: edgeId }).doc;
    const takeaways = takeawaysFor(withIt);
    expect(takeaways.actions[0]!.context?.label).toBe('Payment Service → Settlement Service');
  });

  it('counts only what is still open', () => {
    let withThem = withAction(file, 'Confirm timeout').doc;
    withThem = withAction(withThem, 'Check DLQ retention').doc;
    withThem = setActionDone(withThem, withThem.actions[0]!.id, true);
    expect(openCount(takeawaysFor(withThem))).toBe(1);
  });

  it('finds a decision written inside a room, and says which room', () => {
    const decision = {
      ...createNode({ type: 'note', x: 0, y: 0, text: 'Cache tokens for 5 minutes' }),
      noteKind: 'decision' as const,
    };
    const owner = {
      ...createNode({ type: 'service', x: 600, y: 0, text: 'Payments API' }),
      inside: { nodes: [decision], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } },
    };
    const nested = { ...file, nodes: [...file.nodes, owner] };
    const found = takeawaysFor(nested).decisions.find((note) => note.text.startsWith('Cache'));
    expect(found?.target.room).toBe('Payments API');
    expect(found?.target.path).toEqual([owner.id]);
  });

  it('finds a decision folded into a shape as an attachment, pointing at its host', () => {
    const host = createNode({ type: 'service', x: 900, y: 0, text: 'Ledger' });
    const hosted = {
      ...host,
      attachments: [{ id: 'at1', type: 'note' as const, text: 'Ledger stays synchronous', noteKind: 'decision' as const }],
    };
    const withHost = { ...file, nodes: [...file.nodes, hosted] };
    const found = takeawaysFor(withHost).decisions.find((note) => note.text.startsWith('Ledger'));
    expect(found?.target).toMatchObject({ kind: 'node', id: host.id, label: 'Ledger' });
  });
});

describe('markdown', () => {
  it('is empty when there is nothing to say, so nothing is copied', () => {
    expect(takeawaysMarkdown(takeawaysFor(doc()), 'Untitled canvas')).toBe('');
  });

  it('writes task-list syntax, carries context, and keeps a mention inline', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, text: 'Payments' });
    let base: DraftDocument = { ...doc(), nodes: [node] };
    base = withAction(base, 'Confirm timeout @Kevin', { kind: 'node', id: node.id }).doc;
    base = withAction(base, 'Check DLQ retention').doc;
    base = setActionDone(base, base.actions[1]!.id, true);

    const markdown = takeawaysMarkdown(takeawaysFor(base), 'Payments Platform');
    expect(markdown).toContain('## Payments Platform');
    expect(markdown).toContain('- [ ] Confirm timeout @Kevin — Payments');
    expect(markdown).toContain('- [x] Check DLQ retention');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('escapes text that would otherwise become markup', () => {
    const decision = {
      ...createNode({ type: 'note', x: 0, y: 0, text: '- use * for the wildcard' }),
      noteKind: 'decision' as const,
    };
    const base: DraftDocument = { ...doc(), nodes: [decision] };
    const markdown = takeawaysMarkdown(takeawaysFor(base), 'Escaping');
    expect(markdown).toContain('- \\- use \\* for the wildcard');
  });

  it('does not let a leading list marker of either flavour start a nested list', () => {
    const decide = (text: string) => ({
      ...createNode({ type: 'note', x: 0, y: 0, text }),
      noteKind: 'decision' as const,
    });
    const base: DraftDocument = { ...doc(), nodes: [decide('1. pick a broker'), decide('2) then size it')] };
    const markdown = takeawaysMarkdown(takeawaysFor(base), 'Lists');
    expect(markdown).toContain('- 1\\. pick a broker');
    expect(markdown).toContain('- 2\\) then size it');
  });

  it('flattens a multi-line note into the bullet it belongs to', () => {
    const decision = {
      ...createNode({ type: 'note', x: 0, y: 0, text: 'Worker owns retry\nand the backoff' }),
      noteKind: 'decision' as const,
    };
    const base: DraftDocument = { ...doc(), nodes: [decision] };
    const markdown = takeawaysMarkdown(takeawaysFor(base), 'Wrapping');
    expect(markdown).toContain('- Worker owns retry and the backoff');
  });
});
