/**
 * The page's side of an AI agent's request (desktop only): what the shell's bridge carries in as an
 * `agent-request` event, answered through `agentRespond`.
 *
 * Loaded on the first request, so the editor never pays for it otherwise. The work is `src/agent/`'s
 * (validation, layout, the diagram model); this module is the choreography around the document:
 *
 * 1. **Acknowledge** at once, so the shell can tell a slow request from a page that isn't running.
 * 2. **Serialize** with the person's own actions (the controller's turn), so an agent never lands
 *    between a Save and its dialog, or halfway through an open.
 * 3. **Check the revision** against the document as it stands, work out the change, then ask the
 *    shell's **commit gate** — a request that timed out or was cancelled while its layout ran is
 *    refused there — and commit.
 *
 * Where the change lands depends on the diagram, never on which one happens to be on screen:
 *
 * - **Open in the editor** — committed through the store (which checks the revision once more in the
 *   same breath) as one undo step, then saved if the document had no unsaved edits of the person's;
 *   one that had some is left for them to save (its recovery copy covers it), and the receipt says so.
 * - **Not open** — worked out from the file's text and handed back for the shell to write, under the
 *   stamp it read, so an edit made on disk meanwhile turns into a conflict. What the person is looking
 *   at is never switched; a notice offers to show the change, and opening the file then has the change
 *   as one undo step (`agentWrites.ts`). `activate: true` still opens it first, as it always did.
 *
 * A saved change is identified by its file revision (`f:…`), which stays valid when the document is
 * closed, reopened or the app restarts; only a change left unsaved carries the editor's revision.
 */

import { capabilities } from '../agent/capabilities';
import { gate } from '../agent/compile';
import { AgentError, toAgentError } from '../agent/errors';
import type { JobResult } from '../agent/jobs';
import { runOffThread, type Progress } from '../agent/offThread';
import { STAGE_TEXT } from '../agent/progress';
import { readDiagram, viewPathOf } from '../agent/read';
import { viewOf } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { deserializeDocument } from '../export/project';
import type { AgentEditorReply, AgentEditorRequest } from '../host/agentBridge';
import { agentActivity } from './agentActivity';
import { forgetPendingWrite, rememberPendingWrite } from './agentWrites';
import type { AgentContext, DesktopApi, Handle, HostEvent } from './api';

/** What the handler needs from the controller — kept narrow so this stays testable on its own. */
export interface AgentHost {
  /** The open file's handle and stamp, when a file is open. */
  openFile(): { handle: Handle; stamp: string; readOnly: boolean } | null;
  /** No unsaved changes of the person's in the open document. */
  isClean(): boolean;
  /** Runs `work` after everything already queued on the open document. */
  inTurn<T>(work: () => Promise<T>): Promise<T>;
  /** Asks the editor (see `host/agentBridge.ts`). */
  askEditor(request: AgentEditorRequest): Promise<AgentEditorReply>;
  flush(): Promise<void>;
  /** Makes `handle` the open document without asking anything — or says why it won't. */
  openQuietly(handle: Handle): Promise<{ opened: true } | { opened: false; reason: string }>;
  /** Saves the open file without any dialog. */
  saveQuietly(): Promise<{ saved: true } | { saved: false; reason: string }>;
  /** Draft Canvas holds unsaved changes to this file from an earlier session (a recovery copy). */
  hasRecoveryFor(displayPath: string): Promise<boolean>;
  /**
   * Whether a new diagram may take the screen while it is made (and open when written): when that
   * replaces nothing — Home, or a draft nobody has drawn on — or when the person asked to see it
   * (`requested`) and what is open has no unsaved changes.
   */
  canReveal(requested: boolean): boolean;
  notify(message: string): void;
}

type Request = Extract<HostEvent, { type: 'agent-request' }>;

/** How long a change waits for a drag, typing or a presentation to end before answering `BUSY`. */
export const agentTiming = { busyWaitMs: 8_000, busyPollMs: 250 };

/** The file revision a stamp (`v1:<mtime>:<size>:<sha256>`) stands for — the shell's own rule. */
export function fileRevision(stamp: string): string {
  const sha = stamp.slice(stamp.lastIndexOf(':') + 1);
  return `f:${sha.slice(0, 16)}`;
}

export async function handleAgentRequest(api: DesktopApi, host: AgentHost, event: Request): Promise<void> {
  await api.agentAck(event.id).catch(() => {});
  let outcome: unknown;
  try {
    outcome = { ok: true, value: await run(api, host, event) };
  } catch (error) {
    forgetPendingWrite(event.id);
    const applied = error instanceof AppliedButFailed;
    outcome = { ok: false, error: toAgentError(applied ? error.cause : error), ...(applied ? { applied: true } : {}) };
  } finally {
    // However it ended, what it showed goes: no stale preview outlives its request.
    agentActivity.end(event.id);
  }
  await api.agentRespond(event.id, outcome).catch(() => {});
}

/** Past the gate (`agentGate`): tell the person it's being applied — too late to cancel, Undo after. */
async function passGate(api: DesktopApi, id: number): Promise<void> {
  if (!(await api.agentGate(id))) {
    throw new AgentError('CANCELLED', 'The request was cancelled or timed out before it was applied. Nothing changed.', {
      hint: 'If the person cancelled it, ask before sending it again.',
    });
  }
  agentActivity.applying(id);
}

/**
 * Where a request's heavy half is: to the person (the status line and preview) with every report, and
 * to the agent that sent it — as MCP progress, when its client asked — only when the stage changes.
 */
const progressOf = (api: DesktopApi, id: number) => {
  let told: string | undefined;
  return (progress: Progress) => {
    agentActivity.progress(id, progress);
    if (progress.stage === told) return;
    told = progress.stage;
    void api.agentProgress(id, STAGE_TEXT[progress.stage]).catch(() => {});
  };
};

/** A failure after the document had already changed — the caller must not mistake it for nothing done. */
class AppliedButFailed extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('applied');
    this.cause = cause;
  }
}

function composed(result: JobResult) {
  if (result.kind !== 'compose') throw new AgentError('INTERNAL', 'The diagram could not be composed.');
  return result.composed;
}

async function run(api: DesktopApi, host: AgentHost, event: Request): Promise<unknown> {
  const { args, context } = event;
  switch (event.tool) {
    case 'get_capabilities':
      return capabilities(args);
    case 'read_diagram':
      return read(host, args, context);
    case 'active_context':
      return activeContext(host);
    case 'create_diagram': {
      if (!context.diagramId) throw new AgentError('INTERNAL', 'No id was assigned to the new diagram.');
      // The generation view opens by itself only where it replaces nothing (Home, an untouched draft)
      // or the agent said the person wants to see it; otherwise the status line offers it.
      const reveal = host.canReveal(args.open === true);
      agentActivity.begin({ id: event.id, tool: 'create_diagram', title: typeof args.title === 'string' ? args.title : 'New diagram', target: 'new', path: [] }, reveal);
      // Composed here (on a worker thread), written by the shell: the page never writes a file of its
      // own accord.
      const result = composed(await runOffThread({ kind: 'compose', raw: args, diagramId: context.diagramId }, progressOf(api, event.id)));
      await passGate(api, event.id);
      // Shown as it was made, so it opens when written (the shell's `open_created`) — unless the
      // person has since opened something else, which is then theirs and stays.
      return { ...result, ...(reveal && host.canReveal(false) ? { openAfter: true } : {}) };
    }
    case 'open_created':
      return host.inTurn(async () => {
        if (!context.handle) return { opened: false, reason: 'Nothing to open.' };
        const result = await host.openQuietly(context.handle);
        if (!result.opened) return { opened: false, reason: result.reason };
        return { opened: true };
      });
    case 'update_diagram':
      return host.inTurn(() => update(api, host, event));
    default:
      throw new AgentError('UNSUPPORTED', `Draft Canvas doesn't know the tool ${event.tool}.`);
  }
}

async function read(host: AgentHost, args: Record<string, unknown>, context: AgentContext) {
  const diagramId = context.diagramId ?? '';
  if (context.open) {
    const snapshot = await host.inTurn(async () => {
      await host.flush();
      return host.askEditor({ kind: 'snapshot' });
    });
    if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
    return readDiagram(snapshot.file, args, revisionOfOpen(host, snapshot.revision), diagramId);
  }
  if (context.text === undefined || context.stamp === undefined) throw new AgentError('NOT_FOUND', 'That diagram could not be read.');
  const parsed = deserializeDocument(context.text);
  if (!parsed.ok) throw new AgentError('UNSUPPORTED', `That file can't be read as a diagram: ${parsed.error}`);
  return readDiagram(parsed.document, args, fileRevision(context.stamp), diagramId);
}

/**
 * The revision to hand out for the open document: its file revision while it has no unsaved edits
 * (valid wherever the diagram goes next), the editor's own once it has.
 */
function revisionOfOpen(host: AgentHost, editorRevision: string): string {
  const open = host.openFile();
  return open && host.isClean() ? fileRevision(open.stamp) : editorRevision;
}

/** "The current diagram": its title, revision and the view the person is in — not its contents. */
async function activeContext(host: AgentHost) {
  const snapshot = await host.askEditor({ kind: 'snapshot' });
  if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
  const owner = snapshot.path.length ? ownerOf(snapshot.file, snapshot.path) : undefined;
  return {
    title: snapshot.file.metadata.title,
    revision: revisionOfOpen(host, snapshot.revision),
    view: { path: snapshot.path, ...(owner ? { owner } : {}) },
  };
}

function ownerOf(file: DraftDocument, path: readonly string[]) {
  const outer = path.length > 1 ? viewOf(file, path.slice(0, -1)) : file;
  const node = outer?.nodes.find((n) => n.id === path[path.length - 1]);
  return node ? { id: node.id, label: node.text ?? '' } : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A snapshot taken once the person has stopped dragging or typing — or the last one, still busy. */
async function calmSnapshot(host: AgentHost) {
  const until = Date.now() + agentTiming.busyWaitMs;
  let snapshot = await host.askEditor({ kind: 'snapshot' });
  while (snapshot.kind === 'snapshot' && snapshot.busy && Date.now() < until) {
    await sleep(agentTiming.busyPollMs);
    await host.flush();
    snapshot = await host.askEditor({ kind: 'snapshot' });
  }
  return snapshot;
}

function receiptCounts(result: Extract<JobResult, { kind: 'update' }>) {
  return {
    added: result.counts.added,
    updated: result.counts.updated,
    removed: result.counts.removed,
    ...(result.counts.arranged ? { arranged: result.counts.arranged } : {}),
    ...(result.advisories.length ? { advisories: result.advisories.slice(0, 5) } : {}),
  };
}

function layoutConstrained(result: Extract<JobResult, { kind: 'update' }>) {
  return new AgentError('LAYOUT_CONSTRAINED', `The change would leave the diagram unreadable: ${result.problems[0]}`, {
    hint: 'Nothing changed. Existing shapes are only moved by an arrange op: add {op:"arrange"} (for the view, or a scope) to the same request, or shorten long text. Don\'t create a replacement diagram.',
    details: { problems: result.problems.slice(0, 10), ...(result.suggestedOp ? { suggestedOp: result.suggestedOp } : {}) },
  });
}

const conflict = (currentRevision: string) =>
  new AgentError('REVISION_CONFLICT', 'The diagram changed since that revision. Nothing changed.', {
    hint: 'Read the diagram again (a focused read is enough) and rebuild the change on the current revision. Don\'t create a replacement diagram.',
    details: { currentRevision },
  });

async function update(api: DesktopApi, host: AgentHost, event: Request) {
  const { args, context } = event;
  const expected = typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined;
  if (!expected) throw new AgentError('INVALID_INPUT', 'expectedRevision is required: the revision from your last read or receipt.', { path: '/expectedRevision' });
  if (!context.handle) throw new AgentError('NOT_FOUND', 'That diagram could not be found.');

  let open = host.openFile();
  if (open?.handle !== context.handle) {
    if (args.activate !== true) return updateFile(api, host, event, expected);
    const opened = await host.openQuietly(context.handle);
    if (!opened.opened) throw new AgentError('DOCUMENT_BUSY', opened.reason, { hint: 'Leave out activate to change the file without opening it, or ask the person to save or close what they have open.', retryable: true });
    open = host.openFile();
  }
  if (!open) throw new AgentError('NOT_FOUND', 'That diagram is not open.');
  if (open.readOnly) throw new AgentError('READ_ONLY', 'That diagram is read-only on disk.');

  // 2. Where it stands now — once the person has let go of whatever they were dragging or typing.
  await host.flush();
  const snapshot = await calmSnapshot(host);
  if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
  if (snapshot.busy) throw new AgentError('BUSY', `${snapshot.busy} Nothing changed; try again in a moment with the same requestId.`, { retryable: true });
  const wasClean = host.isClean();
  const accepted = expected === snapshot.revision || (wasClean && expected === fileRevision(open.stamp));
  if (!accepted) throw conflict(revisionOfOpen(host, snapshot.revision));

  // 3. The change, worked out and checked in full (on a worker thread) before anything is touched.
  // The person may keep editing meanwhile; the commit below re-checks the revision, so an edit made
  // in the meantime turns this into a conflict rather than being overwritten.
  const path = viewPathOf(snapshot.file, args.view);
  agentActivity.begin({ id: event.id, tool: 'update_diagram', title: snapshot.file.metadata.title, target: 'open', path });
  const result = await runOffThread({ kind: 'update', file: snapshot.file, path, ops: args.ops, layout: args.layout }, progressOf(api, event.id));
  if (result.kind !== 'update') throw new AgentError('INTERNAL', 'The edit could not be worked out.');
  if (result.problems.length) throw layoutConstrained(result);
  const title = result.file.metadata.title;
  const base = { diagramId: context.diagramId, title, ...(path.length ? { view: { path } } : {}) };
  if (result.unchanged) {
    return { ...base, revision: revisionOfOpen(host, snapshot.revision), applied: false, persisted: wasClean, state: 'unchanged', ...receiptCounts(result) };
  }

  // 4. The gate, then the commit (which re-checks the revision in the same step as the change).
  await passGate(api, event.id);
  const committed = await host.askEditor({ kind: 'commit', expectedRevision: snapshot.revision, file: result.file, label: 'Agent edit' });
  if (committed.kind === 'refused') {
    if (committed.code === 'BUSY') throw new AgentError('BUSY', `${committed.reason ?? 'The editor is busy.'} Nothing changed.`, { retryable: true });
    throw conflict(committed.revision);
  }
  if (committed.kind !== 'committed') throw new AgentError('INTERNAL', 'The editor did not answer.');

  // 5. Durability.
  const receipt = { ...base, applied: true, where: 'editor', undo: 'editor', ...receiptCounts(result) };
  if (!wasClean) {
    return { ...receipt, revision: committed.revision, persisted: false, state: 'applied-unsaved', note: 'Applied in the editor. The person has unsaved changes of their own, so saving is theirs; a recovery copy covers it meanwhile.' };
  }
  try {
    const saved = await host.saveQuietly();
    const now = host.openFile();
    if (saved.saved && now) return { ...receipt, revision: fileRevision(now.stamp), persisted: true, state: 'saved' };
    return { ...receipt, revision: committed.revision, persisted: false, state: 'save-failed', note: `Applied in the editor but not saved: ${saved.saved ? 'the file is gone' : saved.reason} Do not re-send it.` };
  } catch (error) {
    throw new AppliedButFailed(error);
  }
}

/**
 * A change to a diagram that isn't open: worked out from the file as the shell read it, and handed
 * back for the shell to write under that same stamp. Nothing on screen changes.
 */
async function updateFile(api: DesktopApi, host: AgentHost, event: Request, expected: string) {
  const { args, context } = event;
  if (context.text === undefined || context.stamp === undefined) throw new AgentError('NOT_FOUND', 'That diagram could not be read.');
  if (context.displayPath && (await host.hasRecoveryFor(context.displayPath))) {
    throw new AgentError('DOCUMENT_BUSY', 'Draft Canvas is holding unsaved changes to that diagram from an earlier session.', {
      hint: 'Ask the person to open it in Draft Canvas and decide what to keep, then retry with the same requestId.',
      retryable: true,
    });
  }
  const parsed = deserializeDocument(context.text);
  if (!parsed.ok) throw new AgentError('UNSUPPORTED', `That file can't be read as a diagram: ${parsed.error}`);
  const current = fileRevision(context.stamp);
  if (expected !== current) throw conflict(current);

  const path = viewPathOf(parsed.document, args.view);
  agentActivity.begin({ id: event.id, tool: 'update_diagram', title: parsed.document.metadata.title, target: 'file', path });
  const result = await runOffThread({ kind: 'update', file: parsed.document, path, ops: args.ops, layout: args.layout }, progressOf(api, event.id));
  if (result.kind !== 'update') throw new AgentError('INTERNAL', 'The edit could not be worked out.');
  if (result.problems.length) throw layoutConstrained(result);
  const title = result.file.metadata.title;
  const base = { diagramId: context.diagramId, title, ...(path.length ? { view: { path } } : {}) };
  if (result.unchanged) return { ...base, revision: current, applied: false, persisted: true, state: 'unchanged', ...receiptCounts(result) };
  const text = gate(result.file);

  await passGate(api, event.id);
  rememberPendingWrite(event.id, { title, before: context.text, after: text });
  // `write` is the shell's to carry out; it fills in the new revision and removes `write` itself.
  return { ...base, applied: true, where: 'file', undo: 'on-open', ...receiptCounts(result), write: { text } };
}
