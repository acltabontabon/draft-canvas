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
import { advisoriesReceipt, gate, legibilityReceipt, qualityReceipt } from '../agent/compile';
import { AgentError, toAgentError } from '../agent/errors';
import type { JobResult } from '../agent/jobs';
import { runOffThread, type Progress } from '../agent/offThread';
import { STAGE_TEXT } from '../agent/progress';
import { readDiagram, viewPathOf } from '../agent/read';
import { buildImplementationContext } from '../agent/context';
import type { PreparedProposal } from '../agent/proposal';
import { readSelectionContext } from '../agent/selection';
import { viewOf } from '../depth/tree';
import type { DraftDocument } from '../document/types';
import { deserializeDocument } from '../export/project';
import { countPlayableFlows, sequenceSourceFor, type SequenceFormat } from '../export/sequence';
import { c4PlantUmlSource } from '../export/source/c4plantuml';
import type { AgentEditorReply, AgentEditorRequest } from '../host/agentBridge';
import { withPhysChunk } from '../render/png/phys';
import { fittedScale, rasterizeSvg } from '../render/png/rasterize';
import { renderDocumentSvg } from '../render/svg/document';
import { themeFor, type ThemeName } from '../render/theme/tokens';
import { agentActivity } from './agentActivity';
import { forgetPendingWrite, rememberPendingWrite } from './agentWrites';
import type { AgentContext, DesktopApi, Handle, HostEvent } from './api';
import { BaseSnapshots, overlapOf } from '../agent/rebase';

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
  /**
   * Brings the open document up to date with its file: reloads it when it changed on disk and holds no
   * unsaved edits. `changed` and `missing` mean it couldn't — unsaved edits sit on top of an outside
   * change, or the file is gone.
   */
  syncWithDisk(): Promise<'unchanged' | 'reloaded' | 'changed' | 'missing'>;
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
    case 'render_diagram':
      return render(host, args, context);
    case 'read_selection':
      return readSelection(host, context);
    case 'get_implementation_context':
      return implementationContext(host, args, context);
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
    case 'submit_proposal':
      return host.inTurn(() => submitProposal(host, event));
    default:
      throw new AgentError('UNSUPPORTED', `Draft Canvas doesn't know the tool ${event.tool}.`);
  }
}

/**
 * The diagram a read-only tool asks about, as it stands: the open document (brought in step with
 * its file, and past whatever edit is in flight), or the file's text as the shell read it.
 */
async function fileFor(host: AgentHost, context: AgentContext): Promise<{ file: DraftDocument; revision: string }> {
  if (context.open) {
    const snapshot = await host.inTurn(async () => {
      await host.syncWithDisk();
      await host.flush();
      return host.askEditor({ kind: 'snapshot' });
    });
    if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
    return { file: snapshot.file, revision: handOut(host, snapshot) };
  }
  if (context.text === undefined || context.stamp === undefined) throw new AgentError('NOT_FOUND', 'That diagram could not be read.');
  const parsed = deserializeDocument(context.text);
  if (!parsed.ok) throw new AgentError('UNSUPPORTED', `That file can't be read as a diagram: ${parsed.error}`);
  return { file: parsed.document, revision: fileRevision(context.stamp) };
}

/** `raw` as one of `allowed`, `fallback` when left out; anything else is the agent's mistake, named. */
function oneOf<T extends string | number>(raw: unknown, allowed: readonly T[], fallback: T, path: string): T {
  if (raw === undefined) return fallback;
  if ((allowed as readonly unknown[]).includes(raw)) return raw as T;
  throw new AgentError('INVALID_INPUT', `${path.slice(1)} must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}.`, { path });
}

const READ_FORMATS = ['draft', 'mermaid', 'plantuml', 'c4'] as const;

async function read(host: AgentHost, args: Record<string, unknown>, context: AgentContext) {
  const diagramId = context.diagramId ?? '';
  const format = oneOf(args.format, READ_FORMATS, 'draft', '/format');
  const { file, revision } = await fileFor(host, context);
  if (format === 'draft') return readDiagram(file, args, revision, diagramId);
  // The architecture itself as C4-PlantUML — the same text the Source export writes.
  if (format === 'c4') return { diagramId, title: file.metadata.title, revision, format, source: c4PlantUmlSource(file) };
  // The flows as sequence-diagram source — the same text the app's own export writes, every view
  // included, so an agent never has to walk the rooms itself.
  return {
    diagramId,
    title: file.metadata.title,
    revision,
    format,
    flows: countPlayableFlows(file),
    source: sequenceSourceFor(file, format as SequenceFormat),
  };
}

/** The largest image handed back; past it the picture is better asked for as svg, or one view at a time. */
export const RENDER_MAX_BYTES = 8 * 1024 * 1024;
const RENDER_SCALES = [1, 2, 3] as const;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * `render_diagram`: one view drawn by the same renderer the app exports with, on the page itself —
 * the SVG needs the page's text measurer and the PNG a `<canvas>`, neither of which the agent worker
 * has. Refused outright, never silently shrunk, when the picture would not fit the canvas the app
 * can draw or `RENDER_MAX_BYTES`: an agent reading a quietly down-scaled image would trust text it
 * can no longer read.
 */
async function render(host: AgentHost, args: Record<string, unknown>, context: AgentContext) {
  const diagramId = context.diagramId ?? '';
  const format = oneOf(args.format, ['png', 'svg'] as const, 'png', '/format');
  const theme: ThemeName = oneOf(args.theme, ['light', 'dark'] as const, 'light', '/theme');
  const scale = oneOf(args.scale, RENDER_SCALES, 1, '/scale');
  const { file, revision } = await fileFor(host, context);
  const path = viewPathOf(file, args.view);
  const view = path.length ? viewOf(file, path) : file;
  if (!view) throw new AgentError('NOT_FOUND', 'That view no longer exists.');

  const rendered = renderDocumentSvg(view, { theme, includeBackground: false, idScope: path.length ? `agent-${path.join('.')}` : 'agent' });
  const base = { diagramId, title: file.metadata.title, revision, ...(path.length ? { view: { path } } : {}) };
  const tooLarge = (what: string, hint: string) =>
    new AgentError('LIMIT_EXCEEDED', `${what} Nothing was rendered.`, { hint, details: { width: rendered.width, height: rendered.height, maxBytes: RENDER_MAX_BYTES } });

  if (format === 'svg') {
    if (rendered.svg.length > RENDER_MAX_BYTES) throw tooLarge('The SVG of this view is larger than 8 MB.', 'Render one view at a time (view.inside), or read it with read_diagram instead.');
    return { ...base, format: 'svg', mimeType: 'image/svg+xml', width: rendered.width, height: rendered.height, svg: rendered.svg };
  }

  // The app's own canvas limits (`fittedScale` is what the Export dialog quotes): asked beyond them,
  // say so and name the scale that fits rather than hand back a smaller picture than was asked for.
  const fitted = fittedScale(rendered.width, rendered.height, scale);
  if (fitted < scale) {
    const largest = Math.floor(fitted);
    throw tooLarge(
      `At scale ${scale} the image would be ${Math.round(rendered.width * scale)}×${Math.round(rendered.height * scale)} px, more than the canvas Draft Canvas can draw.`,
      largest >= 1 ? `Ask for scale ${largest}, or for format "svg".` : 'Ask for format "svg", or render one view at a time (view.inside).',
    );
  }
  const blob = await rasterizeSvg(rendered.svg, { width: rendered.width, height: rendered.height, scale, background: themeFor(theme).canvas });
  const png = withPhysChunk(new Uint8Array(await blob.arrayBuffer()), scale);
  if (png.byteLength > RENDER_MAX_BYTES) {
    throw tooLarge(`The PNG at scale ${scale} is ${(png.byteLength / (1024 * 1024)).toFixed(1)} MB, more than 8 MB.`, scale > 1 ? `Ask for scale ${scale - 1}, or for format "svg".` : 'Ask for format "svg", or render one view at a time (view.inside).');
  }
  return {
    ...base,
    format: 'png',
    mimeType: 'image/png',
    width: Math.round(rendered.width * scale),
    height: Math.round(rendered.height * scale),
    scale,
    bytes: png.byteLength,
    data: toBase64(png),
  };
}

async function implementationContext(host: AgentHost, args: Record<string, unknown>, context: AgentContext) {
  const diagramId = context.diagramId ?? '';
  const focus = (args.focus ?? {}) as { flow?: unknown; nodes?: unknown };
  if (context.open) {
    const snapshot = await host.inTurn(async () => {
      await host.syncWithDisk();
      await host.flush();
      return host.askEditor({ kind: 'snapshot' });
    });
    if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
    const path = viewPathOf(snapshot.file, args.view);
    return buildImplementationContext(snapshot.file, path, handOut(host, snapshot), diagramId, focus);
  }
  if (context.text === undefined || context.stamp === undefined) throw new AgentError('NOT_FOUND', 'That diagram could not be read.');
  const parsed = deserializeDocument(context.text);
  if (!parsed.ok) throw new AgentError('UNSUPPORTED', `That file can't be read as a diagram: ${parsed.error}`);
  const path = viewPathOf(parsed.document, args.view);
  return buildImplementationContext(parsed.document, path, fileRevision(context.stamp), diagramId, focus);
}

/** Only the open diagram has a selection; the broker already refused otherwise via `context.open`. */
async function readSelection(host: AgentHost, context: AgentContext) {
  const diagramId = context.diagramId ?? '';
  if (!context.open) throw new AgentError('NOT_ACTIVE', 'That diagram is not open, so nothing is selected.', { hint: 'Ask the person to open it and select what to change, or read the whole view with read_diagram.' });
  const snapshot = await host.inTurn(async () => {
    await host.syncWithDisk();
    await host.flush();
    return host.askEditor({ kind: 'snapshot' });
  });
  if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
  return readSelectionContext(snapshot.file, snapshot.path, snapshot.selection, handOut(host, snapshot), diagramId);
}

/**
 * The revision to hand out for the open document: its file revision while it has no unsaved edits
 * (valid wherever the diagram goes next), the editor's own once it has.
 */
function revisionOfOpen(host: AgentHost, editorRevision: string): string {
  const open = host.openFile();
  return open && host.isClean() ? fileRevision(open.stamp) : editorRevision;
}

/** What each recently handed-out revision of the open document looked like — see `agent/rebase.ts`. */
const bases = new BaseSnapshots();

/** `revisionOfOpen`, remembering the document it names so a later `onConflict: "rebase"` can see it. */
function handOut(host: AgentHost, snapshot: { revision: string; file: DraftDocument }): string {
  const revision = revisionOfOpen(host, snapshot.revision);
  bases.remember(revision, snapshot.file);
  return revision;
}

/** Test seam. */
export function __resetAgentBases(): void {
  bases.clear();
}

/** "The current diagram": its title, revision and the view the person is in — not its contents. */
async function activeContext(host: AgentHost) {
  const snapshot = await host.inTurn(async () => {
    await host.syncWithDisk();
    return host.askEditor({ kind: 'snapshot' });
  });
  if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
  const owner = snapshot.path.length ? ownerOf(snapshot.file, snapshot.path) : undefined;
  return {
    title: snapshot.file.metadata.title,
    revision: handOut(host, snapshot),
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
    ...advisoriesReceipt(result.advisories, 5),
    quality: qualityReceipt('touched', result.quality),
    ...(result.legibility ? { legibility: legibilityReceipt(result.legibility) } : {}),
  };
}

function layoutConstrained(result: Extract<JobResult, { kind: 'update' }>) {
  return new AgentError('LAYOUT_CONSTRAINED', `The change would leave the diagram unreadable: ${result.problems[0]}`, {
    hint: 'Nothing changed. Existing shapes are only moved by an arrange op: add {op:"arrange"} (for the view, or a scope) to the same request, or shorten long text. Don\'t create a replacement diagram.',
    details: { problems: result.problems.slice(0, 10), ...(result.suggestedOp ? { suggestedOp: result.suggestedOp } : {}) },
  });
}

/**
 * A change to the open document is made on what its file holds now. Reloaded when it can be; refused
 * when the person's unsaved edits sit on top of an outside change — applying it there would build on a
 * copy the file no longer is, and the next save would offer to overwrite what was checked out.
 */
async function requireInStepWithDisk(host: AgentHost): Promise<void> {
  const state = await host.syncWithDisk();
  if (state === 'changed') {
    throw new AgentError('DOCUMENT_BUSY', 'The file changed on disk while the person has unsaved changes to it in Draft Canvas. Nothing changed.', {
      hint: 'Ask the person to save (choosing which copy to keep) or discard their changes, then read the diagram again and retry.',
      retryable: true,
    });
  }
  if (state === 'missing') {
    throw new AgentError('NOT_FOUND', 'The open diagram was moved or deleted on disk. Nothing changed.', {
      hint: 'Ask the person where it went; list_diagrams shows what is on disk now.',
    });
  }
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
  await requireInStepWithDisk(host);
  open = host.openFile();
  if (!open) throw new AgentError('NOT_FOUND', 'That diagram is not open.');
  if (open.readOnly) throw new AgentError('READ_ONLY', 'That diagram is read-only on disk.');

  // 2. Where it stands now — once the person has let go of whatever they were dragging or typing.
  await host.flush();
  const snapshot = await calmSnapshot(host);
  if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
  if (snapshot.busy) throw new AgentError('BUSY', `${snapshot.busy} Nothing changed; try again in a moment with the same requestId.`, { retryable: true });
  const wasClean = host.isClean();
  const accepted = expected === snapshot.revision || (wasClean && expected === fileRevision(open.stamp));
  const path = viewPathOf(snapshot.file, args.view);
  let rebased = false;
  if (!accepted) {
    const current = handOut(host, snapshot);
    const base = args.onConflict === 'rebase' ? bases.get(expected) : undefined;
    if (!base) throw conflict(current);
    // Worked out against what the agent read, to see what it would change; applied below to what is
    // there now only if the person changed none of the same things since.
    const onBase = await runOffThread({ kind: 'update', file: base, path, ops: args.ops, layout: args.layout, scope: args.scope });
    if (onBase.kind !== 'update') throw new AgentError('INTERNAL', 'The edit could not be worked out.');
    const shared = overlapOf(base, snapshot.file, onBase.file);
    if (shared.length > 0) {
      throw new AgentError('REVISION_CONFLICT', 'The person changed some of the same elements since that revision. Nothing changed.', {
        hint: 'Read the diagram again and rebuild the change on the current revision. Don\'t create a replacement diagram.',
        details: { currentRevision: current, overlapping: shared.slice(0, 20) },
      });
    }
    rebased = true;
  }

  // 3. The change, worked out and checked in full (on a worker thread) before anything is touched.
  // The person may keep editing meanwhile; the commit below re-checks the revision, so an edit made
  // in the meantime turns this into a conflict rather than being overwritten.
  agentActivity.begin({ id: event.id, tool: 'update_diagram', title: snapshot.file.metadata.title, target: 'open', path });
  const result = await runOffThread({ kind: 'update', file: snapshot.file, path, ops: args.ops, layout: args.layout, scope: args.scope }, progressOf(api, event.id));
  if (result.kind !== 'update') throw new AgentError('INTERNAL', 'The edit could not be worked out.');
  if (result.problems.length) throw layoutConstrained(result);
  const title = result.file.metadata.title;
  const base = { diagramId: context.diagramId, title, ...(path.length ? { view: { path } } : {}), ...(rebased ? { rebased: true } : {}) };
  if (result.unchanged) {
    return { ...base, revision: handOut(host, snapshot), applied: false, persisted: wasClean, state: 'unchanged', ...receiptCounts(result) };
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
    bases.remember(committed.revision, result.file);
    return { ...receipt, revision: committed.revision, persisted: false, state: 'applied-unsaved', note: 'Applied in the editor. The person has unsaved changes of their own, so saving is theirs; a recovery copy covers it meanwhile.' };
  }
  try {
    const saved = await host.saveQuietly();
    const now = host.openFile();
    if (saved.saved && now) {
      bases.remember(fileRevision(now.stamp), result.file);
      return { ...receipt, revision: fileRevision(now.stamp), persisted: true, state: 'saved' };
    }
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
  const result = await runOffThread({ kind: 'update', file: parsed.document, path, ops: args.ops, layout: args.layout, scope: args.scope }, progressOf(api, event.id));
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

/**
 * `submit_proposal`: validates a batch of ops against the current document (open or not) exactly as
 * `update_diagram` would, but never commits — it hands the broker everything needed to persist a
 * `Proposal` for later native review (Phase 4b), and never reaches `passGate`/the commit path at all.
 * An empty `ops` is a "no architectural impact" finding, not an error.
 */
async function submitProposal(host: AgentHost, event: Request) {
  const { args, context } = event;
  const expected = typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined;
  if (!expected) throw new AgentError('INVALID_INPUT', 'expectedRevision is required: the revision from your last read or receipt.', { path: '/expectedRevision' });
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) throw new AgentError('INVALID_INPUT', 'summary is required: what this proposal does, or why it has no architectural impact.', { path: '/summary' });

  let file: DraftDocument;
  let revision: string;
  if (context.open) {
    // Already inside this request's turn (see `submit_proposal` above): taking another would queue
    // behind itself, and every later request and Open would wait on it for good.
    await host.syncWithDisk();
    await host.flush();
    const snapshot = await host.askEditor({ kind: 'snapshot' });
    if (snapshot.kind !== 'snapshot') throw new AgentError('INTERNAL', 'The editor did not answer.');
    file = snapshot.file;
    revision = handOut(host, snapshot);
  } else {
    if (context.text === undefined || context.stamp === undefined) throw new AgentError('NOT_FOUND', 'That diagram could not be read.');
    const parsed = deserializeDocument(context.text);
    if (!parsed.ok) throw new AgentError('UNSUPPORTED', `That file can't be read as a diagram: ${parsed.error}`);
    file = parsed.document;
    revision = fileRevision(context.stamp);
  }
  if (expected !== revision) throw conflict(revision);

  const path = viewPathOf(file, args.view);
  const opsGiven = Array.isArray(args.ops) ? args.ops : [];
  const noImpact = opsGiven.length === 0;
  // Not committed, ever: `applyUpdate`'s resulting file is discarded here — only its validation,
  // counts and preconditions survive, to be persisted as the proposal (see broker.rs). Worked out
  // off the main thread, under the same soft/hard budgets as `update_diagram` — a large `ops` batch
  // did the identical layout/repair work synchronously on the page before this, with no deadline.
  let prepared: PreparedProposal;
  if (noImpact) {
    prepared = { counts: { added: 0, updated: 0, removed: 0 }, advisories: [], preconditions: { nodes: {}, edges: {} } };
  } else {
    const result = await runOffThread({ kind: 'proposal', file, path, ops: args.ops, layout: args.layout, scope: args.scope });
    if (result.kind !== 'proposal') throw new AgentError('INTERNAL', 'The proposal could not be worked out.');
    prepared = result.prepared;
  }

  return {
    diagramId: context.diagramId,
    path: [...path],
    baseRevision: revision,
    ops: opsGiven,
    layout: args.layout ?? null,
    scope: args.scope ?? null,
    noImpact,
    counts: prepared.counts,
    advisories: prepared.advisories,
    preconditions: prepared.preconditions,
    summary,
    rationale: typeof args.rationale === 'string' ? args.rationale : '',
    assumptions: Array.isArray(args.assumptions) ? args.assumptions.filter((a): a is string => typeof a === 'string') : [],
    openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions.filter((a): a is string => typeof a === 'string') : [],
    sourceRef: args.sourceRef ?? null,
  };
}
