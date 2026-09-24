/**
 * An agent's request through the desktop controller, against the real editor store: the ack, the
 * turn, the revision check, the commit gate, one undo step, and save-if-clean — with the shell faked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { handleAgentRequest as answerInEditor, currentRevision } from '../../src/host/agentBridge';
import { deserializeDocument, serializeDocument } from '../../src/export/project';
import { __resetInteraction, fileOf, useEditorStore } from '../../src/store/editorStore';
import type { CommandMessage } from '../../src/host/embeddedHost';
import type { HostEvent } from '../../src/desktop/api';
import { agentTiming } from '../../src/desktop/agent';
import { __resetAgentWrites } from '../../src/desktop/agentWrites';
import { agentActivity } from '../../src/desktop/agentActivity';
import { useUiStore } from '../../src/store/uiStore';
import { createHarness, decoder, type Harness } from './harness';

const diagramText = () =>
  compose(
    {
      title: 'Orders',
      nodes: [
        { id: 'api', type: 'api', label: 'Orders API' },
        { id: 'db', type: 'database', label: 'Orders DB' },
      ],
      relationships: [{ id: 'd', from: 'api', to: 'db' }],
    },
    'd_orders000001',
  ).text;

/** The harness's app, made to answer agent questions with the real store. */
function withEditor(h: Harness) {
  const deliver = h.link.deliver;
  h.link.deliver = (message) => {
    const typed = message as Omit<CommandMessage, 'type'> & { type: string; text?: string };
    if (typed.type === 'draft-canvas:load' && typed.text) {
      const parsed = deserializeDocument(typed.text);
      if (parsed.ok) useEditorStore.getState().setDocument(parsed.document);
    }
    if (typed.type === 'draft-canvas:command' && typed.command === 'agent' && typed.request && typed.id !== undefined) {
      const reply = answerInEditor(typed.request);
      queueMicrotask(() => {
        if (reply.kind === 'committed') h.edit(serializeDocument(fileOf(useEditorStore.getState())));
        h.link.onMessage({ type: 'draft-canvas:agent', id: typed.id!, reply });
      });
      return;
    }
    deliver(message);
  };
}

let h: Harness;
let nextId = 1;

async function request(tool: string, args: Record<string, unknown>, context: Record<string, unknown> = {}) {
  const id = nextId++;
  const event: HostEvent = { type: 'agent-request', id, tool, args, context };
  await h.hostEvent(event);
  for (let i = 0; i < 1000 && !h.agent.responses.has(id); i += 1) await new Promise((r) => setTimeout(r, 5));
  return h.agent.responses.get(id) as { ok: boolean; value?: Record<string, unknown>; error?: { code: string }; applied?: boolean };
}

async function openOrders() {
  const handle = h.addFile('Orders', diagramText());
  await h.controller.openHandle(handle);
  await h.settle();
  return handle;
}

const addMailer = (expectedRevision: string, extra: Record<string, unknown> = {}) => ({
  requestId: `r${nextId}`,
  diagramId: 'd_orders000001',
  expectedRevision,
  ops: [{ op: 'add', nodes: [{ id: 'mail', type: 'worker', label: 'Mailer' }], relationships: [{ id: 'm', from: 'api', to: 'mail' }] }],
  ...extra,
});

beforeEach(async () => {
  __resetInteraction();
  __resetAgentWrites();
  agentTiming.busyWaitMs = 8_000;
  agentTiming.busyPollMs = 250;
  h = createHarness();
  withEditor(h);
  await h.controller.start();
});

describe('agent requests on desktop', () => {
  it('applies to the open, clean document as one undo step and saves it', async () => {
    const handle = await openOrders();
    const before = currentRevision();
    const out = await request('update_diagram', addMailer(before), { handle, open: true, diagramId: 'd_orders000001' });
    expect(out.ok).toBe(true);
    expect(out.value).toMatchObject({ applied: true, persisted: true, state: 'saved' });
    expect(h.agent.acks).toContain(nextId - 1);
    expect(h.agent.gates).toContain(nextId - 1);
    expect(decoder.decode(new TextEncoder().encode(h.files.get(handle)!.text))).toContain('"mail"');
    useEditorStore.getState().undo();
    expect(fileOf(useEditorStore.getState()).nodes.map((n) => n.id)).not.toContain('mail');
    expect(currentRevision()).not.toBe(out.value!.revision);
  });

  it('accepts the file revision for a clean document, and refuses a stale one without touching anything', async () => {
    const handle = await openOrders();
    const stale = await request('update_diagram', addMailer('o:elsewhere.9'), { handle, open: true });
    expect(stale.error?.code).toBe('REVISION_CONFLICT');
    expect(fileOf(useEditorStore.getState()).nodes.map((n) => n.id)).not.toContain('mail');
    const byFile = await request('update_diagram', addMailer('f:1'), { handle, open: true });
    expect(byFile.ok).toBe(true);
  });

  it('leaves a document with the person\'s own unsaved edits for them to save', async () => {
    const handle = await openOrders();
    useEditorStore.getState().apply('Rename', (doc) => ({ ...doc, nodes: doc.nodes.map((n) => (n.id === 'db' ? { ...n, text: 'Orders store' } : n)) }));
    h.edit(serializeDocument(fileOf(useEditorStore.getState())));
    const saves = h.api.saveDocument.mock.calls.length;
    const out = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(out.value).toMatchObject({ applied: true, persisted: false, state: 'applied-unsaved' });
    expect(h.api.saveDocument.mock.calls.length).toBe(saves);
  });

  it('changes nothing when the gate is closed (the request expired while it was prepared)', async () => {
    const handle = await openOrders();
    h.agent.gateOpen = false;
    const out = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(out.ok).toBe(false);
    expect(out.applied).toBeUndefined();
    expect(fileOf(useEditorStore.getState()).nodes.map((n) => n.id)).not.toContain('mail');
  });

  it('waits out a drag rather than joining it — and says BUSY only if it outlasts the wait', async () => {
    const handle = await openOrders();
    agentTiming.busyWaitMs = 2_000;
    agentTiming.busyPollMs = 20;
    useEditorStore.getState().beginInteraction('Move');
    setTimeout(() => useEditorStore.getState().endInteraction(), 100);
    const waited = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(waited.value).toMatchObject({ applied: true, state: 'saved' });

    agentTiming.busyWaitMs = 60;
    useEditorStore.getState().beginInteraction('Move');
    const out = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(out.error?.code).toBe('BUSY');
    useEditorStore.getState().endInteraction();
  });

  it('says when a save after the change failed, so the change is not sent again', async () => {
    const handle = await openOrders();
    h.files.get(handle)!.version += 1; // changed on disk behind the app's back
    const out = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(out.value).toMatchObject({ applied: true, persisted: false, state: 'save-failed' });
  });

  /** What the shell tells the page about a diagram that isn't open. */
  const closedContext = (handle: string) => {
    const file = h.files.get(handle)!;
    return { handle, open: false, text: file.text, stamp: `v1:${file.version}`, displayPath: file.displayPath, diagramId: 'd_orders000001' };
  };

  it('changes a diagram that is not open in its file, without switching what is on screen', async () => {
    await openOrders();
    const onScreen = JSON.stringify(fileOf(useEditorStore.getState()));
    const other = h.addFile('Other', diagramText());
    const out = await request('update_diagram', addMailer('f:1'), closedContext(other));
    expect(out.ok).toBe(true);
    expect(out.value).toMatchObject({ applied: true, where: 'file', undo: 'on-open', title: 'Orders', added: 2 });
    // The shell writes `write.text` under the stamp it read; the page never writes a file itself.
    const written = deserializeDocument(String((out.value!.write as { text: string }).text));
    expect(written.ok && written.document.nodes.map((n) => n.id)).toContain('mail');
    expect(JSON.stringify(fileOf(useEditorStore.getState()))).toBe(onScreen);
  });

  it('still opens it first when asked to (activate), and refuses to over unsaved changes', async () => {
    await openOrders();
    const other = h.addFile('Other', diagramText());
    useEditorStore.getState().apply('Rename', (doc) => ({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, text: `${n.text}!` })) }));
    h.edit(serializeDocument(fileOf(useEditorStore.getState())));
    const busy = await request('update_diagram', addMailer('f:1', { activate: true }), closedContext(other));
    expect(busy.error?.code).toBe('DOCUMENT_BUSY');
  });

  it('refuses a stale revision for a closed file, and a file with unsaved changes held for recovery', async () => {
    const other = h.addFile('Other', diagramText());
    const stale = await request('update_diagram', addMailer('f:0'), closedContext(other));
    expect(stale.error?.code).toBe('REVISION_CONFLICT');
    expect((stale.error as { details?: { currentRevision?: string } }).details?.currentRevision).toBe('f:1');
    h.recovery.set('r1', {
      entry: { id: 'r1', origin: { kind: 'file', displayPath: h.files.get(other)!.displayPath }, title: 'Other', updatedAt: Date.now() } as never,
      text: diagramText(),
    });
    const held = await request('update_diagram', addMailer('f:1'), closedContext(other));
    expect(held.error?.code).toBe('DOCUMENT_BUSY');
  });

  it('shows a background change as one undo step when that file is opened as the agent left it', async () => {
    const other = h.addFile('Other', diagramText());
    const out = await request('update_diagram', addMailer('f:1'), closedContext(other));
    const file = h.files.get(other)!;
    // The shell's write.
    file.text = String((out.value!.write as { text: string }).text);
    file.version += 1;
    const id = nextId - 1;
    await h.hostEvent({ type: 'agent-file-written', id, handle: other, displayPath: file.displayPath, stamp: `v1:${file.version}`, created: false });
    const notice = h.notices.find((n) => n.includes('updated'));
    expect(notice).toContain('Orders');
    h.noticeActions.get(notice!)!();
    for (let i = 0; i < 100 && !fileOf(useEditorStore.getState()).nodes.some((n) => n.id === 'mail'); i += 1) await new Promise((r) => setTimeout(r, 5));
    await h.settle();
    expect(fileOf(useEditorStore.getState()).nodes.map((n) => n.id)).toContain('mail');
    expect(h.store.getSnapshot().doc).toMatchObject({ kind: 'file', dirty: false });
    useEditorStore.getState().undo();
    expect(fileOf(useEditorStore.getState()).nodes.map((n) => n.id)).not.toContain('mail');
  });

  it('answers a saved change with the file revision, which a later request can use', async () => {
    const handle = await openOrders();
    const first = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(first.value).toMatchObject({ state: 'saved', revision: `f:${h.files.get(handle)!.version}` });
    const second = await request(
      'update_diagram',
      { requestId: 'rename', diagramId: 'd_orders000001', expectedRevision: first.value!.revision, ops: [{ op: 'update', id: 'mail', set: { label: 'Mail Sender' } }] },
      { handle, open: true },
    );
    expect(second.value).toMatchObject({ applied: true, state: 'saved' });
  });

  it('describes the open diagram — title, revision, the view the person is in — without its contents', async () => {
    const handle = await openOrders();
    const out = await request('active_context', {}, {});
    expect(out.value).toEqual({ title: 'Orders', revision: `f:${h.files.get(handle)!.version}`, view: { path: [] } });
  });

  it('refuses an edit whose growth would run into a neighbour, and moves nothing', async () => {
    const handle = h.addFile(
      'Crowded',
      compose(
        {
          title: 'Crowded',
          nodes: [
            { id: 'api', type: 'api', label: 'Orders API' },
            { id: 'db', type: 'database', label: 'Orders DB' },
          ],
          relationships: [{ id: 'd', from: 'api', to: 'db' }],
          notes: [{ id: 'n', text: 'Owned by the payments team.', near: 'api' }],
        },
        'd_orders000001',
      ).text,
    );
    await h.controller.openHandle(handle);
    await h.settle();
    const before = JSON.stringify(fileOf(useEditorStore.getState()).nodes);
    const long = 'Validates, prices and records every order, then publishes the result for fulfilment, billing and analytics.';
    const out = await request(
      'update_diagram',
      { requestId: 'grow', diagramId: 'd_orders000001', expectedRevision: currentRevision(), ops: [{ op: 'update', id: 'api', set: { description: long, technology: 'Spring Boot 3, Kotlin, PostgreSQL driver' } }] },
      { handle, open: true },
    );
    if (out.ok) {
      // Room was found by growing into free space: then nothing else may have moved.
      const after = fileOf(useEditorStore.getState()).nodes.filter((n) => n.id !== 'api');
      expect(JSON.stringify(after)).toBe(JSON.stringify(JSON.parse(before).filter((n: { id: string }) => n.id !== 'api')));
    } else {
      expect(out.error?.code).toBe('LAYOUT_CONSTRAINED');
      expect(JSON.stringify(fileOf(useEditorStore.getState()).nodes)).toBe(before);
    }
  });

  it('turns a manual edit made while the change was prepared into a conflict: nothing overwritten, nothing left on screen', async () => {
    const handle = await openOrders();
    // The person renames a shape just as the agent's change reaches its gate.
    h.api.agentGate.mockImplementationOnce(async () => {
      useEditorStore.getState().apply('Rename', (doc) => ({ ...doc, nodes: doc.nodes.map((n) => (n.id === 'api' ? { ...n, text: 'Mine' } : n)) }));
      return true;
    });
    const out = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(out.error?.code).toBe('REVISION_CONFLICT');
    const doc = fileOf(useEditorStore.getState());
    expect(doc.nodes.find((n) => n.id === 'api')?.text).toBe('Mine');
    expect(doc.nodes.map((n) => n.id)).not.toContain('mail');
    expect(agentActivity.snapshot()).toEqual([]);
    expect(useUiStore.getState().agentPreview).toBeNull();
  });

  it('changes nothing when the person cancels before the gate — for an edit and for a new diagram', async () => {
    const handle = await openOrders();
    const before = JSON.stringify(fileOf(useEditorStore.getState()));
    h.agent.cancelled.add(nextId);
    const edit = await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    expect(edit.error?.code).toBe('CANCELLED');
    expect(JSON.stringify(fileOf(useEditorStore.getState()))).toBe(before);
    h.agent.cancelled.add(nextId);
    const created = await request('create_diagram', { requestId: 'cx', title: 'New', nodes: [{ id: 'a', type: 'service', label: 'A' }] }, { diagramId: 'd_minted000002' });
    expect(created.error?.code).toBe('CANCELLED');
    expect(agentActivity.snapshot()).toEqual([]);
  });

  it('tells the requesting agent each stage once, and leaves no activity behind', async () => {
    const handle = await openOrders();
    const id = nextId;
    await request('update_diagram', addMailer(currentRevision()), { handle, open: true });
    const stages = h.agent.progress.filter((p) => p.id === id).map((p) => p.message);
    expect(stages[0]).toBe('Preparing diagram');
    expect(new Set(stages).size).toBe(stages.length);
    expect(agentActivity.snapshot()).toEqual([]);
    expect(useUiStore.getState().agentPreview).toBeNull();
  });

  it('opens a new diagram once written only when that replaces nothing, or the person asked to see it', async () => {
    const fresh = await request('create_diagram', { requestId: 'c1', title: 'First', nodes: [{ id: 'a', type: 'service', label: 'A' }] }, { diagramId: 'd_minted000003' });
    expect(fresh.value).toMatchObject({ openAfter: true });
    await openOrders();
    useEditorStore.getState().apply('Rename', (doc) => ({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, text: `${n.text}!` })) }));
    h.edit(serializeDocument(fileOf(useEditorStore.getState())));
    const busy = await request('create_diagram', { requestId: 'c2', title: 'Second', open: true, nodes: [{ id: 'a', type: 'service', label: 'A' }] }, { diagramId: 'd_minted000004' });
    expect(busy.ok).toBe(true);
    expect(busy.value!.openAfter).toBeUndefined();
  });

  it('composes a new diagram under the id the shell minted, and never writes it itself', async () => {
    const writes = h.api.saveDocument.mock.calls.length;
    const out = await request('create_diagram', { requestId: 'c', title: 'New', nodes: [{ id: 'a', type: 'service', label: 'A' }] }, { diagramId: 'd_minted000001' });
    expect(out.ok).toBe(true);
    expect(String(out.value!.text)).toContain('d_minted000001');
    expect(h.api.saveDocument.mock.calls.length).toBe(writes);
  });
});
