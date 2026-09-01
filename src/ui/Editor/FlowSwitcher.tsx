import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';

/**
 * The always-visible, compact indicator of which flow (if any) is the
 * active lens — "Flows" (a quiet, fixed label) beside "Checkout Flow ▾" (the
 * actual selectable mode) — and the primary way to switch it. Replaces the
 * old icon-only "Flows" toolbar button, which only opened
 * the full `FlowPanel` drawer and gave no at-a-glance answer to "what am I
 * looking at right now?" "Diagram" is a real, first-class row here, not an
 * absence — selecting it is exactly how you leave a flow's lens.
 *
 * Deliberately not a management surface: renaming, reordering, and per-step
 * editing all stay in `FlowPanel`, reached here via "Manage flows…". Present
 * is a separate, explicit action next to this control (see `Toolbar.tsx`) —
 * choosing a flow here never starts presenting it.
 */
export function FlowSwitcher() {
  const flows = useEditorStore((state) => state.document.flows);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const setSelectedFlowId = useEditorStore((state) => state.setSelectedFlowId);
  const createFlow = useEditorStore((state) => state.createFlow);
  const open = useUiStore((state) => state.flowSwitcherOpen);
  const setOpen = useUiStore((state) => state.setFlowSwitcherOpen);
  const setFlowPanelOpen = useUiStore((state) => state.setFlowPanelOpen);
  const enterFlowEdit = useEditorStore((state) => state.enterFlowEdit);

  const rootRef = useRef<HTMLDivElement>(null);
  // Rows reachable by arrow keys: "Diagram" first, then each flow in order —
  // "New flow"/"Manage flows…" stay mouse-only, they're actions, not states
  // to switch between.
  const rowIds: (string | null)[] = [null, ...flows.map((flow) => flow.id)];
  const [highlight, setHighlight] = useState(() => Math.max(0, rowIds.indexOf(selectedFlowId)));
  // The keydown listener below is deliberately not recreated on every `highlight` change (see its
  // own comment), so its Enter/Space branch can't read `highlight` directly — that closure only
  // ever sees the value from whenever the listener was last (re)registered. This ref is what it
  // reads instead, kept current independently of when the listener itself was created.
  const highlightRef = useRef(highlight);
  useEffect(() => {
    highlightRef.current = highlight;
  }, [highlight]);

  const current = selectedFlowId ? flows.find((flow) => flow.id === selectedFlowId) : undefined;
  const label = current ? current.title : 'Diagram';

  useEffect(() => {
    if (open) setHighlight(Math.max(0, rowIds.indexOf(selectedFlowId)));
    // Only re-sync when the menu opens — while it's open, arrow keys own `highlight`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((index) => Math.min(rowIds.length - 1, index + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((index) => Math.max(0, index - 1));
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        // The nested "Edit" button owns its own Enter/Space activation while it holds focus —
        // this handler must not also select the row underneath it.
        if ((event.target as HTMLElement).closest('.dc-flow-switcher-row-edit')) return;
        event.preventDefault();
        setSelectedFlowId(rowIds[highlightRef.current] ?? null);
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
    // rowIds is derived fresh each render from `flows`/`selectedFlowId` and would
    // otherwise retrigger this effect every render; `highlight` is read, not
    // depended on, so ArrowUp/Down updates don't tear down and re-add listeners.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setOpen, setSelectedFlowId]);

  return (
    <div className="dc-flow-switcher" ref={rootRef}>
      <Button
        variant="ghost"
        active={open}
        title="Switch flows (F)"
        onClick={() => setOpen(!open)}
      >
        <span className="dc-flow-switcher-label">Flows</span>
        <span>{label} ▾</span>
      </Button>
      {open && (
        <div className="dc-flow-switcher-menu" role="menu" aria-label="Flows">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!current}
            className="dc-flow-switcher-row"
            data-highlighted={highlight === 0 ? 'true' : undefined}
            data-selected={!current ? 'true' : undefined}
            onFocus={() => setHighlight(0)}
            onClick={() => {
              setSelectedFlowId(null);
              setOpen(false);
            }}
          >
            Diagram
          </button>
          {flows.map((flow, index) => (
            <div
              key={flow.id}
              role="menuitemradio"
              tabIndex={0}
              aria-checked={flow.id === selectedFlowId}
              className="dc-flow-switcher-row"
              data-highlighted={highlight === index + 1 ? 'true' : undefined}
              data-selected={flow.id === selectedFlowId ? 'true' : undefined}
              onFocus={() => setHighlight(index + 1)}
              onClick={() => {
                setSelectedFlowId(flow.id);
                setOpen(false);
              }}
            >
              <span className="dc-flow-switcher-row-title">{flow.title}</span>
              <span className="dc-muted dc-flow-switcher-row-count">{flow.steps.length} steps</span>
              <button
                type="button"
                className="dc-flow-switcher-row-edit"
                aria-label={`Edit ${flow.title}`}
                title={`Edit ${flow.title} — enables safe connector-membership changes`}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedFlowId(flow.id);
                  enterFlowEdit(flow.id);
                  setOpen(false);
                }}
              >
                Edit
              </button>
            </div>
          ))}
          <span className="dc-flow-switcher-divider" />
          <button
            type="button"
            className="dc-flow-switcher-action"
            onClick={() => {
              const id = createFlow();
              setSelectedFlowId(id);
              setOpen(false);
            }}
          >
            + New flow
          </button>
          <button
            type="button"
            className="dc-flow-switcher-action"
            onClick={() => {
              setFlowPanelOpen(true);
              setOpen(false);
            }}
          >
            Manage flows…
          </button>
        </div>
      )}
    </div>
  );
}
