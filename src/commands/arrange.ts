/**
 * Starting Arrange and Tidy up. Every way in — the palette, the context menu, the toolbar, the
 * desktop menu, Nodi's layout skills — goes through here, so every one of them gets the same answer:
 * a preview to decide on (`ArrangeBar`, `TidyBar`), never a diagram that changed under the person's
 * hands. Only `editorStore.commitArrange` and `commitTidy` apply one.
 *
 * The work is run off the page's thread (`editorStore.planArrange`, `planTidy`), so while it runs the
 * editor says so — `uiStore.layoutBusy`, drawn by `LayoutBusyBar` — and Cancel stops it.
 */

import type { ArrangePreset } from '../agent/layoutPlan';
import { fixesList, type ArrangeFix } from '../lib/arrangeFixes';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type ArrangeDirection, type ArrangePreview, type LayoutBusy, type TidyNothing } from '../store/uiStore';
import { ARRANGE_FAILED, notifyLoadFailure } from '../ui/common/notifyLoadFailure';

/** The parts of the editor a start needs: a command's own context, or the live stores. */
export interface LayoutHost {
  editor: Pick<ReturnType<typeof useEditorStore.getState>, 'planArrange' | 'planTidy'>;
  ui: Pick<ReturnType<typeof useUiStore.getState>, 'notify' | 'setArrangePreview' | 'setTidyPreview'>;
}

const live = (): LayoutHost => ({ editor: useEditorStore.getState(), ui: useUiStore.getState() });

/** What a start came to, for a caller that has more to say (Nodi). */
export type LayoutOutcome = 'preview' | 'unchanged' | 'no-room' | 'nothing';

/** The failure toast: a layout that ran past its limit says so; anything else is the load failure. */
function failed(error: unknown): void {
  if (error instanceof Error && (error as { code?: unknown }).code === 'LAYOUT_FAILED') useUiStore.getState().notify(error.message, 'error');
  else notifyLoadFailure(error, ARRANGE_FAILED);
}

/**
 * Runs `work` with the editor marked busy and a Cancel that stops it, one layout at a time: a second
 * start while one is running is ignored. Resolves `null` when it was cancelled or refused.
 */
async function busy<T>(kind: LayoutBusy['kind'], scoped: boolean, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const ui = useUiStore.getState();
  if (ui.layoutBusy) return null;
  const controller = new AbortController();
  const mine: LayoutBusy = { kind, scoped, cancel: () => controller.abort() };
  ui.setLayoutBusy(mine);
  try {
    return await work(controller.signal);
  } finally {
    if (useUiStore.getState().layoutBusy === mine) useUiStore.getState().setLayoutBusy(null);
  }
}

/**
 * Arrange diagram (and, with `selection`, Arrange selection): the view laid out again from scratch,
 * shown first as a preview with its reading direction to choose (`ArrangeBar`), applied only on
 * Apply. A `preset` is a layout skill's ask (a direction kept as asked, a spacing, a flow in a line).
 */
export async function startArrange(options: { selection?: boolean; preset?: ArrangePreset } = {}, host: LayoutHost = live()): Promise<LayoutOutcome> {
  try {
    const plan = await busy('arrange', Boolean(options.selection), (signal) => host.editor.planArrange(options.selection ?? false, { ...(options.preset ? { preset: options.preset } : {}), signal }));
    if (plan === null) return 'nothing';
    if (plan === 'no-room') {
      host.ui.notify('There is not enough room. Arrange a larger selection or the whole diagram.');
      return 'no-room';
    }
    if (plan === 'unchanged') {
      host.ui.notify('Already arranged.');
      return 'unchanged';
    }
    host.ui.setArrangePreview(options.preset ? { ...plan, motion: true } : plan);
    return 'preview';
  } catch (error) {
    failed(error);
    return 'nothing';
  }
}

/**
 * Check layout: what reads badly as the diagram stands (names stacked into columns, captions with no
 * room, top-heavy boundaries, an overview too small to read), reported only where laying the view out
 * again fixes it — and then as that arrangement's own preview, the fixes named in its bar and inked
 * on the sheet. Nothing to fix says so, rather than opening a preview of a change nobody needs.
 */
export async function startCheckLayout(host: LayoutHost = live()): Promise<void> {
  try {
    const plan = await busy('arrange', false, (signal) => host.editor.planArrange(false, { signal }));
    if (plan === null) return;
    const fixing = fixingPlan(plan);
    if (fixing) host.ui.setArrangePreview(fixing);
    else host.ui.notify('Nothing to fix: names, captions and spacing read well.');
  } catch (error) {
    failed(error);
  }
}

/** An Arrange plan that fixes something `agent/proportion.ts` checks, opened on the direction that
 *  does (the suggested one first); `null` for a plan that fixes none of it, or no plan at all. */
function fixingPlan(plan: ArrangePreview | 'unchanged' | 'no-room' | null): ArrangePreview | null {
  if (plan === null || typeof plan !== 'object') return null;
  const fixes = (direction: ArrangeDirection) => plan.fixes?.[direction]?.length ?? 0;
  if (fixes(plan.direction)) return plan;
  const other: ArrangeDirection = plan.direction === 'right' ? 'down' : 'right';
  return fixes(other) ? { ...plan, direction: other } : null;
}

/**
 * Tidy up (selection when `scoped`): the gentle cleanup, shown as a preview first. When there is
 * nothing to tidy, the toast says so — and, since tidy as drawn is not the same as easy to read, what
 * reads badly all the same (`TidyNothing.reads`), with Rearrange one click away.
 */
export async function startTidy(scoped: boolean, host: LayoutHost = live()): Promise<void> {
  try {
    const outcome = await busy('tidy', scoped, (signal) => host.editor.planTidy({ signal }));
    if (outcome === null) return;
    if ('nothing' in outcome) nothingToTidy(host, scoped, outcome);
    else host.ui.setTidyPreview(outcome);
  } catch (error) {
    failed(error);
  }
}

function nothingToTidy(host: LayoutHost, scoped: boolean, nothing: TidyNothing): void {
  if (useUiStore.getState().readOnly) return;
  const rearrange = () => void startArrange({}, host);
  if (nothing.stopped) {
    host.ui.notify('Tidy up stopped early on a large diagram before it found anything to change. Select part of it and tidy that.', 'info', scoped ? undefined : { label: 'Rearrange', run: rearrange });
    return;
  }
  const reads: readonly ArrangeFix[] = scoped ? [] : nothing.reads;
  const list = fixesList(reads);
  if (!list) {
    host.ui.notify('Already tidy.', 'info', { label: 'Rearrange', run: rearrange });
    return;
  }
  // Said as "may": this is what reads badly now, not an arrangement that was tried; the preview the
  // button opens is the answer, and names what it really fixes.
  host.ui.notify(`Already tidy. Rearranging may fix ${list}.`, 'info', { label: 'Show fix', run: () => void startCheckLayout(host) });
}
