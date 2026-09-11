import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ViewportPortal, useInternalNode, useReactFlow } from '@xyflow/react';
import { primaryCommandsFor } from '../commands/registry';
import type { CommandContext } from '../commands/types';
import {
  ACCENTS,
  BOUNDARY_PRESETS,
  CODE_LANGUAGES,
  NOTE_KINDS,
  TEXT_ALIGNS,
  TEXT_ROLES,
  type ActorKind,
  type BoundaryPreset,
  type CodeLanguage,
  type ComponentKind,
  type DatabaseKind,
  type DraftNode,
  type NoteKind,
  type QueueKind,
  type ServiceKind,
  type TextAlign,
  type TextRole,
} from '../document/types';
import { MOD_SYMBOL } from '../lib/platform';
import { effectiveTextRole } from '../nodes/describe';
import { LANGUAGE_LABELS } from '../render/code/highlight';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { nodeIndex } from '../store/selectors';
import { useThemeValue } from '../ui/theme/useTheme';
import { Button } from '../ui/common/Button';
import { BOUNDARY_PRESET_OPTION_LABELS, NOTE_LABELS, TEXT_ROLE_OPTION_LABELS } from '../ui/Editor/nodeKindLabels';
import { ACTOR_ICON_OPTIONS } from './actorOptions';
import { COMPONENT_ICON_OPTIONS } from './componentOptions';
import { DATABASE_ICON_OPTIONS } from './dataStoreOptions';
import { rectOfInternal } from './edgeGeometry';
import { HintStrip } from './HintStrip';
import { InspectorSelect, type InspectorSelectOption } from './InspectorSelect';
import { usePopoverKeyboard } from './usePopoverKeyboard';
import { QUEUE_ICON_OPTIONS } from './queueOptions';
import { SERVICE_ICON_OPTIONS } from './serviceOptions';
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
const SERVICE_OPTIONS: InspectorSelectOption[] = SERVICE_ICON_OPTIONS;
const DATABASE_OPTIONS: InspectorSelectOption[] = DATABASE_ICON_OPTIONS;
const QUEUE_OPTIONS: InspectorSelectOption[] = QUEUE_ICON_OPTIONS;
const ACTOR_OPTIONS: InspectorSelectOption[] = ACTOR_ICON_OPTIONS;
const COMPONENT_OPTIONS: InspectorSelectOption[] = COMPONENT_ICON_OPTIONS;
const BOUNDARY_OPTIONS: InspectorSelectOption[] = BOUNDARY_PRESETS.map((preset) => ({
  value: preset,
  label: BOUNDARY_PRESET_OPTION_LABELS[preset],
}));
const TEXT_ROLE_OPTIONS: InspectorSelectOption[] = TEXT_ROLES.map((role) => ({
  value: role,
  label: TEXT_ROLE_OPTION_LABELS[role],
}));
const ALIGN_ICONS: Record<TextAlign, 'alignLeft' | 'alignCenter' | 'alignRight'> = {
  left: 'alignLeft',
  center: 'alignCenter',
  right: 'alignRight',
};

/** A slightly longer tooltip than the button's own visible label, for the quick-actions row —
 *  keyed by command id, same ids `primaryCommandsFor` (`commands/registry.ts`) returns. Falls back
 *  to the command's own title for anything not listed here. */
const QUICK_ACTION_HINTS: Record<string, string> = {
  'add-consumer': 'Add a service that consumes from this queue',
  'add-dead-letter-queue': 'Add a dead-letter queue for messages that fail delivery',
  'remove-dead-letter-queue': 'Remove this queue’s dead-letter queue',
  'add-subscriber': 'Add a queue subscriber that fans out from this topic',
  'add-data-store': 'Add a data store this service writes to',
  'add-routed-service': 'Add a service this gateway routes to',
  ungroup: 'Dissolve this boundary, keeping its contents',
};

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
export function ElementInspectorPopover({ buildCommandContext }: { buildCommandContext: () => CommandContext }) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const mode = useEditorStore((state) => state.mode);
  const flowPanelOpen = useUiStore((state) => state.flowPanelOpen);
  const learnModeActive = useUiStore((state) => state.learnModeActive);
  const interactionActive = useUiStore((state) => state.interactionActive);
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
  // One slot, not two independent booleans — a colour palette and a typography panel open from
  // the same row and would otherwise be able to stack under each other; this makes them mutually
  // exclusive for free and keeps the reset/Escape/click-away plumbing below written once.
  const [openPanel, setOpenPanel] = useState<'color' | 'typography' | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>('above');
  usePopoverKeyboard(panelRef);

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

  // Selecting a *different* element while the colour palette/typography panel is open must close it.
  useEffect(() => {
    setOpenPanel(null);
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
    setOpenPanel(null);
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

  // Escape closes the open colour palette/typography panel first, without touching the selection.
  // Click-away closes it the same way, but never deselects.
  useEffect(() => {
    if (!openPanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpenPanel(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpenPanel(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    const id = window.setTimeout(() => window.addEventListener('pointerdown', onPointerDown), 0);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.clearTimeout(id);
    };
  }, [openPanel]);

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
  //
  // Skipped entirely while a gesture is in flight (`interactionActive`, same field
  // `DraftEdgeView`'s obstacle avoidance skips for the same reason): a dragged or resized node's
  // `rect` moves every animation frame, and right at the boundary between two placements'
  // "fits" thresholds, that continuous motion can flip `fits('above')`/`fits('below')` back and
  // forth from one frame to the next — each flip calling `setPlacement`, which re-renders, which
  // reads the still-moving `rect` again, which can flip right back. That is a real, not
  // self-resolving, oscillation (unlike the sub-pixel noise `measuredSize` rounds away above), so
  // it can run past React's update-depth limit and crash the canvas. Freezing `placement` for the
  // duration of the gesture and resolving once more when it ends (this effect fires again as soon
  // as `interactionActive` flips back to false) keeps the popover on its last-good side while the
  // element is moving, then settles it in one shot against the final, still `rect`.
  const effectivePlacement = anchors && !interactionActive
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
  // Phase 8 — once the element's own hint is learned or dismissed (or it never had one), the
  // palette gets a turn instead. Hints only ever surface at all while Learn Draft Canvas mode is
  // on (`HintStrip`'s own gate) — nothing here shows outside a Learn mode review pass.
  const hintId: HintId | null = learnModeActive ? (primaryHint ?? 'command-palette') : null;
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
        className="dc-popover dc-element-inspector"
        role="toolbar"
        aria-label="Element options"
        aria-hidden={closing || undefined}
        data-closing={closing ? 'true' : undefined}
        data-dragging={interactionActive ? 'true' : undefined}
        data-placement={effectivePlacement}
        style={{ transform }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* The caret ties the popover to the element it belongs to — see `.dc-popover-caret`. */}
        <span className="dc-popover-caret" aria-hidden="true" />
        <div className="dc-popover-inner dc-element-inspector-inner">
          {hintId && <HintStrip id={hintId} learned={hintLearned} />}
          <ElementInspectorRow
            node={displayNode}
            openPanel={openPanel}
            setOpenPanel={setOpenPanel}
            menuDirection={menuDirection}
            menuAvoidRect={menuAvoidRect}
            theme={theme}
            store={store}
            buildCommandContext={buildCommandContext}
          />
        </div>
      </div>
    </ViewportPortal>
  );
}

function ElementInspectorRow({
  node,
  openPanel,
  setOpenPanel,
  menuDirection,
  menuAvoidRect,
  theme,
  store,
  buildCommandContext,
}: {
  node: DraftNode;
  openPanel: 'color' | 'typography' | null;
  setOpenPanel: (panel: 'color' | 'typography' | null) => void;
  menuDirection: 'up' | 'down';
  menuAvoidRect: { top: number; bottom: number };
  theme: ReturnType<typeof useThemeValue>;
  store: typeof useEditorStore;
  buildCommandContext: () => CommandContext;
}) {
  const currentAccentChip = node.accent !== undefined ? theme.accents[node.accent].chip : undefined;

  // Only a plain Queue can ever have a DLQ toggle, and the scan is skipped for every other kind —
  // cheap enough to run every render, but there's no reason to pay even that for a Service/Topic/
  // Junction/etc. selection.
  const hasDlqEdge =
    node.type === 'queue' && node.queueKind === 'queue' && node.deliveryRole !== 'dead-letter'
      ? store.getState().document.edges.some((edge) => edge.source === node.id && edge.semantic === 'deadLetters')
      : false;

  // The 0-3 shape-native quick actions for this node — memoized on the specific fields that can
  // change the result, never on `node` itself or `document` wholesale. `node` gets a new identity
  // every animation frame while it's being dragged or resized (this popover tracks live position
  // via `useInternalNode`), and recomputing/rebuilding this list on every one of those frames is
  // exactly the wasted work to avoid; none of `type`/`queueKind`/`deliveryRole`/`hasDlqEdge` change
  // just because the node moved.
  const primaryCommands = useMemo(
    () => primaryCommandsFor(buildCommandContext(), node),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [node.id, node.type, node.queueKind, node.deliveryRole, hasDlqEdge],
  );

  const typeControl = ((): {
    options: InspectorSelectOption[];
    value: string;
    ariaLabel: string;
    onChange: (value: string) => void;
    layout?: 'list' | 'grid';
  } | null => {
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
        // Grid, like Data Store: each of the six kinds now has its own real silhouette (see
        // `nodes/describe.ts`'s `serviceApi`/`serviceWorker`/`serviceExternal`/`serviceScheduler`/
        // `serviceGateway`), so the preview tiles are genuinely worth scanning visually rather than
        // reading as six copies of one shape with different text.
        return {
          options: SERVICE_OPTIONS,
          value: node.serviceKind ?? 'generic',
          ariaLabel: 'Service type',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { serviceKind: value as ServiceKind }, 'Change service type'),
          layout: 'grid',
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
          layout: 'grid',
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
      case 'component':
        return {
          options: COMPONENT_OPTIONS,
          value: node.componentKind ?? 'generic',
          ariaLabel: 'Component type',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { componentKind: value as ComponentKind }, 'Change component type'),
        };
      case 'text':
        return {
          options: TEXT_ROLE_OPTIONS,
          value: effectiveTextRole(node),
          ariaLabel: 'Text role',
          onChange: (value) =>
            store.getState().updateNodeById(node.id, { textRole: value as TextRole }, 'Change text role'),
        };
      default:
        return null;
    }
  })();

  return (
    <>
      {primaryCommands.length > 0 && (
        <div className="dc-popover-row dc-popover-primary dc-element-inspector-row dc-element-inspector-quickrow">
          {primaryCommands.map((command) => (
            <Button
              key={command.id}
              variant="quiet"
              className="dc-popover-action"
              // An "Add …" continuation leads with a plus glyph; a toggle-off or dissolve doesn't.
              data-adds={command.id.startsWith('add-') ? 'true' : undefined}
              title={QUICK_ACTION_HINTS[command.id] ?? command.title}
              onClick={() => command.run(buildCommandContext())}
            >
              {command.title}
            </Button>
          ))}
        </div>
      )}
      <div className="dc-popover-row dc-popover-config dc-element-inspector-row">
        <button
          type="button"
          className="dc-inspector-color-swatch"
          data-auto={currentAccentChip ? undefined : 'true'}
          aria-label="Element colour"
          title="Change colour"
          style={currentAccentChip ? { background: currentAccentChip } : undefined}
          onClick={() => setOpenPanel(openPanel === 'color' ? null : 'color')}
        />
        {node.type === 'text' && (
          <Button
            variant="quiet"
            active={openPanel === 'typography'}
            aria-label="Text style"
            title="Bold, italic, alignment"
            onClick={() => setOpenPanel(openPanel === 'typography' ? null : 'typography')}
          >
            Aa
          </Button>
        )}
        {typeControl && (
          <InspectorSelect
            ariaLabel={typeControl.ariaLabel}
            value={typeControl.value}
            options={typeControl.options}
            onChange={typeControl.onChange}
            preferredDirection={menuDirection}
            avoidRect={menuAvoidRect}
            layout={typeControl.layout}
          />
        )}
        <span className="dc-popover-divider" aria-hidden="true" />
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
          className="dc-popover-delete"
          aria-label="Delete selection"
          title="Delete (Backspace)"
          onClick={() => store.getState().deleteSelection()}
        />
      </div>

      {openPanel === 'color' && (
        <div className="dc-popover-panel dc-element-inspector-panel dc-swatches">
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
                setOpenPanel(null);
              }}
            />
          ))}
        </div>
      )}

      {openPanel === 'typography' && node.type === 'text' && (
        <div className="dc-popover-panel dc-element-inspector-panel dc-typography-panel">
          <div className="dc-emphasis-group">
            <Button
              variant="quiet"
              active={node.textBold}
              aria-pressed={Boolean(node.textBold)}
              aria-label="Bold"
              title={`Bold (${node.textBold ? 'on' : 'off'}, ${MOD_SYMBOL}B)`}
              style={{ fontWeight: 700 }}
              onClick={() => store.getState().updateNodeById(node.id, { textBold: !node.textBold }, 'Toggle bold')}
            >
              B
            </Button>
            <Button
              variant="quiet"
              active={node.textItalic}
              aria-pressed={Boolean(node.textItalic)}
              aria-label="Italic"
              title={`Italic (${node.textItalic ? 'on' : 'off'}, ${MOD_SYMBOL}I)`}
              style={{ fontStyle: 'italic' }}
              onClick={() =>
                store.getState().updateNodeById(node.id, { textItalic: !node.textItalic }, 'Toggle italic')
              }
            >
              I
            </Button>
          </div>
          <span className="dc-popover-divider" aria-hidden="true" />
          <div className="dc-align-group" role="group" aria-label="Text alignment">
            {TEXT_ALIGNS.map((align) => (
              <Button
                key={align}
                icon={ALIGN_ICONS[align]}
                variant="quiet"
                active={(node.textAlign ?? 'left') === align}
                aria-pressed={(node.textAlign ?? 'left') === align}
                aria-label={`Align ${align}`}
                title={`Align ${align}`}
                onClick={() => store.getState().updateNodeById(node.id, { textAlign: align }, 'Change alignment')}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
