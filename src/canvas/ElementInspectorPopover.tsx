import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ViewportPortal, useInternalNode, useReactFlow } from '@xyflow/react';
import {
  ACCENTS,
  ACTOR_KINDS,
  BOUNDARY_PRESETS,
  CODE_LANGUAGES,
  DATABASE_KINDS,
  NOTE_KINDS,
  QUEUE_KINDS,
  SERVICE_KINDS,
  type ActorKind,
  type BoundaryPreset,
  type CodeLanguage,
  type DatabaseKind,
  type DraftNode,
  type NoteKind,
  type QueueKind,
  type ServiceKind,
} from '../document/types';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { nodeIndex } from '../store/selectors';
import { useThemeValue } from '../ui/theme/useTheme';
import { Button } from '../ui/common/Button';
import {
  ACTOR_KIND_OPTION_LABELS,
  BOUNDARY_PRESET_OPTION_LABELS,
  DATABASE_KIND_OPTION_LABELS,
  NOTE_LABELS,
  QUEUE_KIND_OPTION_LABELS,
  SERVICE_KIND_OPTION_LABELS,
} from '../ui/Editor/nodeKindLabels';
import { rectOfInternal } from './edgeGeometry';
import { useHints } from '../learning/useHints';
import { HintStrip } from './HintStrip';
import { InspectorSelect, type InspectorSelectOption } from './InspectorSelect';
import type { HintId } from '../learning/hints';
import {
  anchorsForRect,
  placementTransform,
  resolvePlacement,
  type Placement,
  type PlacementClearances,
} from './popoverPlacement';

const NOTE_OPTIONS: InspectorSelectOption[] = NOTE_KINDS.map((kind) => ({
  value: kind,
  label: NOTE_LABELS[kind],
}));
const CODE_OPTIONS: InspectorSelectOption[] = CODE_LANGUAGES.map((language) => ({
  value: language,
  label: LANGUAGE_LABELS[language],
}));
const SERVICE_OPTIONS: InspectorSelectOption[] = SERVICE_KINDS.map((kind) => ({
  value: kind,
  label: SERVICE_KIND_OPTION_LABELS[kind],
}));
const DATABASE_OPTIONS: InspectorSelectOption[] = DATABASE_KINDS.map((kind) => ({
  value: kind,
  label: DATABASE_KIND_OPTION_LABELS[kind],
}));
const QUEUE_OPTIONS: InspectorSelectOption[] = QUEUE_KINDS.map((kind) => ({
  value: kind,
  label: QUEUE_KIND_OPTION_LABELS[kind],
}));
const ACTOR_OPTIONS: InspectorSelectOption[] = ACTOR_KINDS.map((kind) => ({
  value: kind,
  label: ACTOR_KIND_OPTION_LABELS[kind],
}));
const BOUNDARY_OPTIONS: InspectorSelectOption[] = BOUNDARY_PRESETS.map((preset) => ({
  value: preset,
  label: BOUNDARY_PRESET_OPTION_LABELS[preset],
}));

/** Must match this component's own `dc-element-inspector-*` CSS animation duration. */
const POPOVER_EXIT_MS = 120;

/** Clears the 7px resize handles (which protrude ~3.5px past the node's own edge) plus the
 *  selection outline, so the popover reads as clearly outside the element, not touching it. */
const GAP = 14;

/** Same basis as `EdgeInspectorPopover`'s `TOOLBAR_CLEARANCE` (`--dc-bar-height: 46px` + margin).
 *  Kept as an independent constant rather than imported, so this file can never regress the
 *  connector popover and vice versa. */
const TOP_CLEARANCE = 56;
/** `--dc-status-height: 32px` + margin — the status bar shows whenever this popover can. */
const BOTTOM_CLEARANCE = 44;
/** No left rail exists; just a small screen-edge margin. */
const LEFT_CLEARANCE = 12;
/** `FlowPanel`'s fixed 300px width + a 12px gap, only while it's actually open (`flowPanelOpen`
 *  in `uiStore` — it's dismissible, not always on screen); otherwise just the same small margin
 *  as the left edge. */
const RIGHT_CLEARANCE_WITH_FLOW_PANEL = 312;

/**
 * The contextual control for a single selected element — anchored right at its own rendered
 * bounds instead of docked at the bottom of the screen (the thing `Inspector.tsx`'s bottom bar
 * did for every selection, single or multi). Mounted only while exactly one node, and no edge, is
 * selected; `Inspector` itself no longer renders anything for that case, so this is the only
 * element UI a single-element selection shows — mirroring how `EdgeInspectorPopover` already
 * owns single-connector selection.
 *
 * Placement prefers above the element, then below, then right, then left — whichever the
 * viewport actually has room for — and clamps the cross-axis position so the popover never clips
 * off-screen even right at a corner. It only changes placement when the current one genuinely
 * stops fitting, so it doesn't flip mid-drag or mid-resize.
 */
export function ElementInspectorPopover() {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  const { isRetired, isDismissedThisSession } = useHints();
  const store = useEditorStore;
  const theme = useThemeValue();
  const { flowToScreenPosition, screenToFlowPosition } = useReactFlow();
  const rightClearance = flowPanelOpen ? RIGHT_CLEARANCE_WITH_FLOW_PANEL : LEFT_CLEARANCE;

  const nodeId = selection.nodes.length === 1 && selection.edges.length === 0 ? selection.nodes[0] : null;
  const node = nodeId ? nodeIndex(document.nodes).get(nodeId) : undefined;
  const internal = useInternalNode(nodeId ?? '');

  const open = mode !== 'present' && Boolean(node && internal);

  // Same delayed-unmount fade `EdgeInspectorPopover`/`AttachmentPopover` use: the popover stays
  // mounted one more tick after `open` flips false so `canvas.css` can play the reverse animation
  // instead of the DOM node vanishing mid-frame.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>('above');

  // Self-measured, not guessed: fit checks depend on the popover's own current width and height,
  // which change as sections open/close. Re-measures after every render — cheap (one
  // `getBoundingClientRect` read) and guarded so it only ever triggers a re-render when the size
  // actually changed.
  //
  // Rounded to whole pixels before comparing: `getBoundingClientRect` returns sub-pixel floats
  // that can differ by less than a thousandth of a pixel between two renders of the same
  // genuinely-settled layout (observed directly: 106.3280029296875 vs 106.32806396484375 vs
  // 106.32794189453125 for one popover that never visibly changed size) — often while a resize or
  // zoom is also driving `useReactFlow()`'s viewport transform. An exact `!==` on that noise never
  // reaches a fixed point: each render's `setMeasuredSize` triggers another render, which measures
  // a new sub-pixel value, which triggers another `setMeasuredSize`, chaining into React's
  // "Maximum update depth exceeded" crash. Whole pixels are the coarsest resolution anything here
  // is ever laid out or visually distinguishable at, so rounding away that noise costs nothing.
  const [measuredSize, setMeasuredSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width > 0 && height > 0 && (width !== measuredSize.width || height !== measuredSize.height)) {
      setMeasuredSize({ width, height });
    }
  });

  // Cached so the popover keeps rendering the element it was showing while it fades out, instead
  // of going blank the instant selection changes.
  const lastNodeRef = useRef(node);
  const lastInternalRef = useRef(internal);
  if (open) {
    lastNodeRef.current = node;
    lastInternalRef.current = internal;
  }

  // Selecting a *different* element while the colour palette is open must close it.
  useEffect(() => {
    setPaletteOpen(false);
  }, [nodeId]);

  useEffect(() => {
    if (open) {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setClosing(false);
      setMounted(true);
      return;
    }
    setPaletteOpen(false);
    if (!mounted) return;
    setClosing(true);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hideTimer.current = window.setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
        hideTimer.current = null;
      },
      reduceMotion ? 0 : POPOVER_EXIT_MS,
    );
    return () => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
    // mounted intentionally excluded — see EdgeInspectorPopover's identical comment.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes the open colour palette first, without touching the selection. Click-away
  // closes it the same way, but never deselects.
  useEffect(() => {
    if (!paletteOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPaletteOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [paletteOpen]);

  // All of the following must stay above any conditional `return` — React Hooks (the `useEffect`
  // below) can never be called conditionally — so `rect`/`anchors` are null-safe rather than
  // guarded by an early return.
  const displayNode = open ? node : lastNodeRef.current;
  const displayInternal = open ? internal : lastInternalRef.current;
  const rect = displayInternal ? rectOfInternal(displayInternal) : null;

  // Measured, not guessed: the toolbar wraps to two rows below 720px (see app.css's
  // `@media (max-width: 720px)` block), and a long diagram title can force that wrap even above
  // it — a static constant can't account for either. `TOP_CLEARANCE` stays as the fallback for
  // the (rare) frame where `.dc-toolbar` isn't in the DOM yet.
  const measuredToolbarHeight = window.document.querySelector('.dc-toolbar')?.getBoundingClientRect().height;
  const toolbarClearance = measuredToolbarHeight ? measuredToolbarHeight + 10 : TOP_CLEARANCE;

  const clearances: PlacementClearances = {
    gap: GAP,
    top: toolbarClearance,
    bottom: BOTTOM_CLEARANCE,
    left: LEFT_CLEARANCE,
    right: rightClearance,
  };
  const anchors: Record<Placement, { x: number; y: number }> | null = rect ? anchorsForRect(rect) : null;

  // Stable by construction: only search for a new placement when the current one has genuinely
  // stopped fitting, instead of re-picking the "best" one every render — that's what keeps this
  // from flipping back and forth mid-drag or mid-resize. Runs every render deliberately (no
  // element is selected on the very first render, so there's no single dependency list that
  // covers "recompute whenever the resolved placement disagrees with stored state"); the
  // `effectivePlacement !== placement` guard is what keeps it from looping.
  const effectivePlacement = anchors
    ? resolvePlacement(placement, anchors, flowToScreenPosition, measuredSize, clearances)
    : placement;
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (effectivePlacement !== placement) setPlacement(effectivePlacement);
  });

  if (!mounted) return null;
  if (!displayNode || !displayInternal || !rect || !anchors) return null;

  // Phase 7.1 — at most one hint per node, decided by its type alone (never falls through to a
  // second, near-duplicate message once the first no longer applies): a Service node always
  // teaches attachments via its own framing; any other non-group node with nothing attached yet
  // gets the generic nudge. Both retire together (Phase 7.2) — see `hasAnyAttachment` below —
  // since they teach the same underlying capability.
  const hasAnyAttachment =
    document.nodes.some((n) => n.attachments?.length) || document.edges.some((e) => e.attachments?.length);
  const primaryHint: HintId | null =
    displayNode.type === 'service'
      ? 'service-node'
      : displayNode.type !== 'group' && !displayNode.attachments?.length
        ? 'attachment-slot'
        : null;
  // Phase 8 — once the element's own hint is learned or dismissed (or it never had one), the same
  // slot teaches the palette instead: a selected element is exactly the moment "connect, spotlight,
  // start a flow here" becomes a question. Learn mode keeps showing the element's own hint first,
  // since resurfacing those is the whole point of that mode.
  const primaryDone =
    primaryHint === null ||
    hasAnyAttachment ||
    isRetired(primaryHint) ||
    isDismissedThisSession(primaryHint);
  const hintId: HintId | null =
    learnModeActive && primaryHint ? primaryHint : primaryDone ? 'command-palette' : primaryHint;
  const hintLearned = hintId === 'command-palette' ? false : hasAnyAttachment;

  // A dropdown inside this popover should open away from the element, not toward it — mirror
  // whichever side the popover itself placed on. Left/right placement has no above/below
  // relationship to the element at all, so 'down' (today's only direction) is the sensible
  // default there; `InspectorSelect`'s own collision check (below) is what actually keeps a
  // dropdown uncovered/unclipped in that case, and as a backstop when the preferred side turns
  // out too cramped even for an 'above' or 'below' popover.
  const menuDirection: 'up' | 'down' = effectivePlacement === 'above' ? 'up' : 'down';
  // The element's own screen-space vertical bounds, so a dropdown can shrink/flip rather than
  // cover it even when the popover itself barely had room to fit on its preferred side.
  const menuAvoidRect = {
    top: flowToScreenPosition({ x: rect.x, y: rect.y }).y,
    bottom: flowToScreenPosition({ x: rect.x, y: rect.y + rect.height }).y,
  };

  const transform = placementTransform(
    effectivePlacement,
    anchors,
    measuredSize,
    clearances,
    flowToScreenPosition,
    screenToFlowPosition,
  );

  return (
    <ViewportPortal>
      <div
        ref={panelRef}
        className="dc-element-inspector"
        role="toolbar"
        aria-label="Element options"
        aria-hidden={closing || undefined}
        data-closing={closing ? 'true' : undefined}
        style={{ transform }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="dc-element-inspector-inner">
          {hintId && <HintStrip id={hintId} learned={hintLearned} />}
          <ElementInspectorRow
            node={displayNode}
            paletteOpen={paletteOpen}
            setPaletteOpen={setPaletteOpen}
            menuDirection={menuDirection}
            menuAvoidRect={menuAvoidRect}
            theme={theme}
            store={store}
          />
        </div>
      </div>
    </ViewportPortal>
  );
}

function ElementInspectorRow({
  node,
  paletteOpen,
  setPaletteOpen,
  menuDirection,
  menuAvoidRect,
  theme,
  store,
}: {
  node: DraftNode;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  menuDirection: 'up' | 'down';
  menuAvoidRect: { top: number; bottom: number };
  theme: ReturnType<typeof useThemeValue>;
  store: typeof useEditorStore;
}) {
  const currentAccentChip = node.accent !== undefined ? theme.accents[node.accent].chip : undefined;

  const typeControl = ((): { options: InspectorSelectOption[]; value: string; ariaLabel: string; onChange: (value: string) => void } | null => {
    switch (node.type) {
      case 'note':
        return {
          options: NOTE_OPTIONS,
          value: node.noteKind ?? 'note',
          ariaLabel: 'Note kind',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { noteKind: value as NoteKind }, 'Change note kind'),
        };
      case 'code':
        return {
          options: CODE_OPTIONS,
          value: node.language ?? 'plaintext',
          ariaLabel: 'Code language',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { language: value as CodeLanguage }, 'Change language'),
        };
      case 'service':
        return {
          options: SERVICE_OPTIONS,
          value: node.serviceKind ?? 'generic',
          ariaLabel: 'Service type',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { serviceKind: value as ServiceKind }, 'Change service type'),
        };
      case 'database':
        return {
          options: DATABASE_OPTIONS,
          value: node.databaseKind ?? 'generic',
          ariaLabel: 'Data Store type',
          onChange: (value) =>
            store
              .getState()
              .updateNodeById(node.id, { databaseKind: value as DatabaseKind }, 'Change data store type'),
        };
      case 'queue':
        return {
          options: QUEUE_OPTIONS,
          value: node.queueKind ?? 'queue',
          ariaLabel: 'Queue type',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { queueKind: value as QueueKind }, 'Change queue type'),
        };
      case 'group':
        return {
          options: BOUNDARY_OPTIONS,
          value: node.boundaryPreset ?? 'boundary',
          ariaLabel: 'Boundary preset',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { boundaryPreset: value as BoundaryPreset }, 'Change boundary preset'),
        };
      case 'actor':
        return {
          options: ACTOR_OPTIONS,
          value: node.actorKind ?? 'human',
          ariaLabel: 'Actor type',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { actorKind: value as ActorKind }, 'Change actor type'),
        };
      default:
        return null;
    }
  })();

  return (
    <>
      <div className="dc-element-inspector-row">
        <button
          type="button"
          className="dc-inspector-color-swatch"
          data-auto={currentAccentChip ? undefined : 'true'}
          aria-label="Element colour"
          title="Change colour"
          style={currentAccentChip ? { background: currentAccentChip } : undefined}
          onClick={() => setPaletteOpen(!paletteOpen)}
        />
        {typeControl && (
          <InspectorSelect
            ariaLabel={typeControl.ariaLabel}
            value={typeControl.value}
            options={typeControl.options}
            onChange={typeControl.onChange}
            preferredDirection={menuDirection}
            avoidRect={menuAvoidRect}
          />
        )}
        {node.type === 'group' && (
          <Button variant="quiet" onClick={() => store.getState().ungroupSelection()}>
            Ungroup
          </Button>
        )}
        <Button
          variant="quiet"
          title="Fade everything else, to focus on this while explaining (Esc to exit)"
          onClick={() => store.getState().enterFocus([node.id], [])}
        >
          Focus
        </Button>
        <Button
          icon="trash"
          variant="quiet"
          aria-label="Delete selection"
          title="Delete (Backspace)"
          onClick={() => store.getState().deleteSelection()}
        />
      </div>

      {paletteOpen && (
        <div className="dc-element-inspector-panel dc-swatches">
          {ACCENTS.map((accent) => (
            <button
              key={accent}
              type="button"
              className="dc-swatch"
              title={accent}
              aria-label={`Colour ${accent}`}
              style={{ background: theme.accents[accent].chip }}
              onClick={() => {
                store.getState().updateNodeById(node.id, { accent }, 'Recolour');
                setPaletteOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}
