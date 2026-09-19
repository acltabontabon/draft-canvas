import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { AttachmentPopover } from '../../canvas/AttachmentPopover';
import { PresentationCalloutLayer } from '../../canvas/presentation/PresentationCalloutLayer';
import { Canvas, type CanvasProps } from '../../canvas/Canvas';
import { ContextMenu } from '../../canvas/ContextMenu';
import { EdgeInspectorPopover } from '../../canvas/EdgeInspectorPopover';
import { ElementInspectorPopover } from '../../canvas/ElementInspectorPopover';
import { canvasBounds, canvasCenter } from '../../canvas/canvasFrame';
import { presetForShortcut, type Preset } from '../../canvas/presets';
import { nearestInDirection, nextRelationshipNeighbor, type Direction } from '../../canvas/spatialNav';
import { QuickConnectMenu } from '../../canvas/QuickConnectMenu';
import { offerFor, quickConnectItems, type QuickConnectItem } from '../../canvas/quickConnectItems';
import { stepContinuation } from '../../canvas/stepContinuation';
import { contextMenuCommandsFor } from '../../commands/contextMenu';
import { starterCommands } from '../../commands/registry';
import type { Command } from '../../commands/types';
import { useCommandContext } from '../../commands/useCommandContext';
import type { StarterId } from '../../starters';
import { defaultSizeFor } from '../../document/factory';
import { DEFAULTS } from '../../document/limits';
import { boundsOf, placeNear } from '../../document/operations';
import { naturalCodeSize, describeContext } from '../../nodes/describe';
import { isActivatableTarget, isEditableTarget, isInOwnKeyboardRegion } from '../../lib/isEditableTarget';
import { centerOf } from '../../lib/math';
import { logDiagnostic } from '../../lib/diagnostics';
import { flowFitViewNodes, roomFor, useEditorStore, viewLevel } from '../../store/editorStore';
import { pointer, useUiStore, type ContextMenuTarget } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { useFlowPlayback } from '../../presentation/useFlowPlayback';
import { presentationScope, revealIn } from '../../presentation/presentationAttachments';
import { useThemeValue } from '../theme/useTheme';
import { backOut, lookInside } from './depthNavigation';
import { CAPTURE_ACTION_KEY } from '../../takeaways/capture';
import { TakeawaysPanel } from './TakeawaysPanel';
import { DepthAnnouncer, DepthStack } from './DepthStack';
import { DepthTransition } from './DepthTransition';
import { EmptyState } from './EmptyState';
import { FlowBar } from './FlowBar';
import { FlowPanel } from './FlowPanel';
import { FocusIndicator } from './FocusIndicator';
import { CanvasSettingsDialog } from './CanvasSettingsDialog';
import { CommandPalette } from './CommandPalette';
import { Inspector } from './Inspector';
import { ShortcutSheet } from './ShortcutSheet';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { Button } from '../common/Button';
import { ClipboardPermissionDialog } from '../common/ClipboardPermissionDialog';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { PanelBoundary } from '../common/PanelBoundary';
import { retryableLazy } from '../common/retryableLazy';
import { motionMs } from '../../lib/motion';
import { embeddedHost } from '../../host/embeddedHost';
import { PRODUCT } from '../../product';

// Export (its panels, previews, and exporters) is a sizeable slice of the editor that most sessions
// never open — fetched the first time it is, then kept mounted so its in-session choices survive.
const ExportDialogChunk = retryableLazy(() => import('./ExportDialog').then((module) => ({ default: module.ExportDialog })));
// Learn and every one of its scenes arrive the first time it's opened, and stay mounted after — so
// the editor itself carries nothing but the recipe titles its palette can search.
const LearnDrawerChunk = retryableLazy(() => import('../learn/LearnDrawer').then((module) => ({ default: module.LearnDrawer })));

/** Whether a modal dialog (`Modal`'s `aria-modal` panel) is up — the editor's shortcuts stand down. */
function modalIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** A modal other than Learn's sheet. Learn covers the canvas on a narrow window but still teaches its
 *  ⌘ chords ("press ⌘K"), so those keep working over it; everything else stands down as for any modal. */
function dialogIsOpen(): boolean {
  return document.querySelector('[aria-modal="true"]:not(.dc-learn)') !== null;
}

/** Whether this ⌘C/⌘X/⌘A belongs to the page's own text — reading Learn, or text selected in it —
 *  rather than to the canvas selection. */
function isTextChord(event: KeyboardEvent): boolean {
  if (isInOwnKeyboardRegion(event.target)) return true;
  // Clicking plain text (not a control) leaves focus on the page itself.
  if (event.target !== document.body) return false;
  const selected = window.getSelection();
  return Boolean(selected && !selected.isCollapsed && selected.anchorNode?.parentElement?.closest('[data-dc-keyboard-region]'));
}

/** Whether keyboard focus is on the canvas itself (or nowhere in particular) rather than on a
 *  control around it — the only place a bare Tab may mean "accept the suggestion". */
function focusIsOnCanvas(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  // `.dc-canvas` (not `.react-flow`) is the check now that it — not any individual node/edge —
  // is the canvas's one real Tab stop; `.react-flow` is always a descendant of it, so this still
  // covers anything inside React Flow's own tree too, not just the wrapper itself.
  return active.closest('.dc-canvas, .dc-ghost') !== null;
}

/** Sample content for a fresh code card, so it is never a blank grey box. */
const CODE_SAMPLES: Record<string, string> = {
  json: '{\n  "accountId": "123",\n  "status": "CANCELLED"\n}',
};

/** The editor as the app shell mounts it: React Flow's provider travels with the editor's own
 *  chunk, so the Library never loads React Flow at all. */
export function EditorRoute({ session }: { session: DocumentSession }) {
  return (
    <ReactFlowProvider>
      <EditorScreen session={session} />
    </ReactFlowProvider>
  );
}

function EditorScreen({ session }: { session: DocumentSession }) {
  const title = useEditorStore((state) => state.document.metadata.title);
  const mode = useEditorStore((state) => state.mode);
  const rename = useEditorStore((state) => state.rename);
  const setMode = useEditorStore((state) => state.setMode);

  // Several open canvases (tabs, history, a screen reader's page title) can be told apart.
  useEffect(() => {
    document.title = `${title} — ${PRODUCT.name}`;
    return () => {
      document.title = PRODUCT.name;
    };
  }, [title]);

  const armed = useUiStore((state) => state.armed);
  const arm = useUiStore((state) => state.arm);
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const exportOpen = useUiStore((state) => state.exportOpen);
  const [exportMounted, setExportMounted] = useState(exportOpen);
  if (exportOpen && !exportMounted) setExportMounted(true);
  const learnOpen = useUiStore((state) => state.learnOpen);
  const [learnMounted, setLearnMounted] = useState(learnOpen);
  if (learnOpen && !learnMounted) setLearnMounted(true);
  // A panel that fails to load (or to render) closes with a toast rather than taking the editor down
  // with it — and unmounts, so the next open tries a fresh import.
  const onExportFailed = useCallback((error: Error, componentStack: string) => {
    logDiagnostic(error, { operation: 'export-panel' }, componentStack);
    ExportDialogChunk.reset();
    setExportMounted(false);
    const ui = useUiStore.getState();
    ui.setExportOpen(false);
    // Otherwise a later plain ⌘⇧E would open still forced to "Selection only".
    ui.requestExportSelection(false);
    ui.notify('Export couldn’t open. Check your connection and try again.', 'error');
  }, []);
  const onLearnFailed = useCallback((error: Error, componentStack: string) => {
    logDiagnostic(error, { operation: 'learn-panel' }, componentStack);
    LearnDrawerChunk.reset();
    setLearnMounted(false);
    const ui = useUiStore.getState();
    ui.closeLearn();
    ui.notify('Learn couldn’t open. Check your connection and try again.', 'error');
  }, []);
  const quickConnect = useUiStore((state) => state.quickConnect);
  const setQuickConnect = useUiStore((state) => state.setQuickConnect);
  const reconnecting = useUiStore((state) => state.reconnectDragActive);
  const contextMenu = useUiStore((state) => state.contextMenu);
  const setContextMenu = useUiStore((state) => state.setContextMenu);
  // Memoized so `QuickConnectMenu`/`ContextMenu`'s own listener-cleanup effects (keyed on
  // `onDismiss`) don't tear down and re-register on every unrelated `EditorScreen` re-render
  // while the menu is open — a fresh inline arrow here would give them a new identity every time.
  const setContinuation = useUiStore((state) => state.setContinuation);
  const dismissQuickConnect = useCallback(() => {
    setQuickConnect(null);
    // The menu owned that preview; it goes with the menu.
    if (useUiStore.getState().continuation?.trigger === 'drop') setContinuation(null);
  }, [setQuickConnect, setContinuation]);
  const dismissContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);
  // Reactive only so an open menu's own contents stay correct if the world changes underneath it
  // (e.g. an undo from elsewhere) — read live via `getState()` inside `buildContext`/
  // `contextMenuCommandsFor` otherwise, same split `CommandPalette.tsx` uses. Subscribed only while
  // a menu is actually open: otherwise every commit would re-render the whole editor.
  const menuOpen = quickConnect !== null || contextMenu !== null;
  const selection = useEditorStore((state) => (menuOpen ? state.selection : null));
  const editorDocument = useEditorStore((state) => (menuOpen ? state.document : null));

  const theme = useThemeValue();
  const playback = useFlowPlayback();
  const { fitView, screenToFlowPosition, flowToScreenPosition } = useReactFlow();

  // Bumped to force a clean remount of the boundary + Canvas below, e.g. from
  // the "Reload canvas" recovery action — a fresh `key` discards whatever
  // local component state the crashed instance was carrying.
  const [canvasInstanceKey, setCanvasInstanceKey] = useState(0);

  const createAt = useCallback(
    (preset: Preset, position: { x: number; y: number }, autoEdit = false) => {
      const code = preset.type === 'code' ? (CODE_SAMPLES[preset.language ?? ''] ?? '') : undefined;
      const size =
        preset.type === 'code' && code
          ? naturalCodeSize(code, describeContext(theme))
          : undefined;

      // Refused past the node cap, with a toast — the store's `addNode` itself stays unconditional.
      if (!roomFor(1, 0)) return null;
      const node = useEditorStore.getState().addNode({
        type: preset.type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        width: size?.width,
        height: size?.height,
        text: preset.text,
        accent: preset.accent,
        noteKind: preset.noteKind,
        language: preset.language,
        code,
      });
      arm(null);
      // A note exists to be typed into, so it opens ready for that regardless of how it was
      // created — a mouse-drawn service, by contrast, arrives already named, so `autoEdit` only
      // opts *in* the keyboard/command-driven creation paths (the double-click type picker and the
      // armed-tool click stay mouse gestures, never pass it): a keyboard user who just made
      // something should be able to start typing immediately, the same "create, then name" flow a
      // note already gets. Text gets the same treatment as Note, for the same reason: it has no
      // default label (`defaultTextFor('text')` is `''`), so it exists to be typed into too —
      // unlike Service/Actor/etc., which arrive pre-named and don't need this.
      if (node.type === 'note' || node.type === 'text' || autoEdit) useUiStore.getState().requestEdit(node.id);
      return node;
    },
    [arm, theme],
  );

  /**
   * The picker's rows for the current Quick Connect state — the engine's suggestions for the
   * source node first, then the standing presets. Recomputed only when the menu opens or the
   * document changes underneath it (same reasoning as `contextMenuEntries` below). The ranking
   * hint is read as the menu opens: it only changes on an accept, which closes the menu.
   */
  const quickConnectRows = useMemo(
    () =>
      quickConnect && editorDocument
        ? quickConnectItems(editorDocument, quickConnect, useUiStore.getState().continuationRecent, viewLevel(useEditorStore.getState()))
        : [],
    [quickConnect, editorDocument],
  );

  /**
   * Where the drop ghost sits on screen, so the menu can stand clear of it. Sized to the largest
   * default box any row previews (a Service), centred on the drop point, and measured once when
   * the menu opens — the menu itself is screen-fixed, so its anchor must be too.
   */
  const quickConnectAnchorRect = useMemo(() => {
    if (!quickConnect?.center) return undefined;
    const { center } = quickConnect;
    const topLeft = flowToScreenPosition({ x: center.x - DEFAULTS.nodeWidth / 2, y: center.y - DEFAULTS.nodeHeight / 2 });
    const bottomRight = flowToScreenPosition({ x: center.x + DEFAULTS.nodeWidth / 2, y: center.y + DEFAULTS.nodeHeight / 2 });
    return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    // Measured once per menu: `quickConnect` identity is the open/close signal.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [quickConnect]);

  /** The row under the highlight becomes the ghost on the canvas — a preview, not a creation. */
  const onQuickConnectHighlight = useCallback(
    (item: QuickConnectItem) => {
      if (!quickConnect?.source) return;
      const offer = offerFor(useEditorStore.getState().document, quickConnect, item);
      setContinuation(offer ?? null);
    },
    [quickConnect, setContinuation],
  );

  /**
   * Creates the chosen row at the Quick Connect drop point. With a `source` (a connector dropped
   * on empty canvas) the new node is wired to it through the very same materialized offer the
   * ghost was drawn from — one undoable step, matrix-inferred semantics, no second opinion.
   * Without one (a plain double-click-to-create) it is simply created at `flowPosition`.
   */
  const onQuickConnectSelect = useCallback(
    (item: QuickConnectItem) => {
      if (!quickConnect) return;
      if (!quickConnect.source) {
        if (item.kind === 'preset') createAt(item.preset, quickConnect.flowPosition);
        setQuickConnect(null);
        return;
      }
      const offer = offerFor(useEditorStore.getState().document, quickConnect, item);
      if (offer) {
        useEditorStore.getState().acceptContinuation(offer);
        if (offer.nodes[0]?.type === 'note') useUiStore.getState().requestEdit(offer.nodes[0].id);
      }
      setContinuation(null);
      setQuickConnect(null);
    },
    [createAt, quickConnect, setContinuation, setQuickConnect],
  );

  /**
   * Places a new element under the cursor, near the current selection, or in the middle of the
   * view — in that order. The middle tier exists for a keyboard-only sequence with no mouse
   * movement between creations (⌘K "Add X", "Add Y", "Add Z" with nothing in between to move
   * `pointer`): without it, every one of those lands on the exact same viewport-center point and
   * stacks perfectly on top of the last, since `pointer.known` never becomes true. Reusing
   * `placeNear` — the same collision-avoiding companion search Intent Continuation and
   * drag-to-attach's "detach" already use — means a keyboard-created run of elements fans out
   * sensibly instead, the same way related elements already do everywhere else in the app.
   */
  const createAtPointer = useCallback(
    (preset: Preset) => {
      const state = useEditorStore.getState();
      const { nodes: selectedNodes } = state.selection;
      const host = selectedNodes.length === 1 ? state.document.nodes.find((n) => n.id === selectedNodes[0]) : undefined;
      const position = pointer.known
        ? { x: pointer.x - 88, y: pointer.y - 34 }
        : host
          ? placeNear(state.document, host, defaultSizeFor(preset.type))
          : screenToFlowPosition(canvasCenter());
      // Both of this function's own call sites (the bare-letter shortcut, the palette's "Add
      // <type>") are keyboard/command-driven, never a mouse gesture — so unlike `createAt` itself,
      // this one always opens the new element ready to name.
      return createAt(preset, position, true);
    },
    [createAt, screenToFlowPosition],
  );

  // One way to start presenting, shared by the toolbar's Present button and the ⌘Enter chord, so
  // the chord does what the button (and the palette row that shows the same chord) does: start the
  // flow and frame it, not just flip the mode.
  const onPresent = useCallback(() => {
    // Read before `playback.start()` flips `flowPlayback.active` — otherwise the fit-view
    // guard would see playback as already active and skip scoping to the presented flow.
    const nodes = flowFitViewNodes(useEditorStore.getState());
    setMode('present');
    if (playback.canStart) playback.start();
    void fitView({ padding: 0.18, duration: motionMs(320), nodes });
  }, [playback, fitView, setMode]);

  useKeyboard({ createAtPointer, onPresent, playback });

  const buildCommandContext = useCommandContext({ createAt, createAtPointer, playback });

  // The empty canvas's starter row runs the palette's own command rather than calling the store
  // itself, so the two entry points can never drift apart — the same discipline the right-click
  // menu follows (`commands/contextMenu.ts`).
  const insertStarter = useCallback(
    (id: StarterId) => {
      const command = starterCommands().find((entry) => entry.id === `starter-${id}`);
      command?.run(buildCommandContext());
    },
    [buildCommandContext],
  );

  const contextMenuEntries = useMemo(() => {
    if (!contextMenu) return [];
    return contextMenuCommandsFor(buildCommandContext(), contextMenu.target, contextMenu.flowPosition);
    // `selection`/`editorDocument` aren't read directly here — they're what make this recompute
    // when the thing the menu is showing changes underneath it (see the effect right below).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu, buildCommandContext, selection, editorDocument]);

  // A target that stops resolving (its node/edge got deleted, or a multi-selection collapsed below
  // 2 members) makes its command list come back empty — closing then, rather than the menu itself
  // re-validating its own target, keeps all of "does this still make sense" in one place.
  useEffect(() => {
    if (contextMenu && contextMenuEntries.length === 0) setContextMenu(null);
  }, [contextMenu, contextMenuEntries, setContextMenu]);

  const runContextMenuCommand = useCallback(
    (command: Command) => {
      const ctx = buildCommandContext();
      setContextMenu(null);
      try {
        command.run(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : 'That command failed.', 'error');
      }
    },
    [buildCommandContext, setContextMenu],
  );

  const presenting = mode === 'present';

  // Stable, so the memoized `Canvas` (and React Flow under it) skips renders the editor makes for
  // its own chrome.
  const onCanvasCreateAt = useCallback(
    (position: { x: number; y: number }) => {
      if (armed) createAt(armed, position);
    },
    [armed, createAt],
  );
  const onQuickConnectMenu = useCallback<NonNullable<CanvasProps['onQuickConnectMenu']>>(
    (source, sourceSide, sourceOffset, flowPosition, screenPosition, center) =>
      setQuickConnect({ source, sourceSide, sourceOffset, flowPosition, screenPosition, center }),
    [setQuickConnect],
  );
  const onEmptyCanvasMenu = useCallback<NonNullable<CanvasProps['onEmptyCanvasMenu']>>(
    (flowPosition, screenPosition) => setQuickConnect({ flowPosition, screenPosition }),
    [setQuickConnect],
  );

  return (
    <div
      className="dc-editor"
      data-mode={mode}
      data-armed={armed ? 'true' : undefined}
      data-reconnecting={reconnecting ? 'true' : undefined}
    >
      {!presenting && (
        <Toolbar
          title={title}
          onTitleChange={rename}
          onBack={embeddedHost ? undefined : () => void session.closeDocument()}
          onPresent={onPresent}
          onExport={() => setExportOpen(true)}
        />
      )}

      <div className="dc-editor-body">
        <div className="dc-editor-canvas">
          <ErrorBoundary
            key={canvasInstanceKey}
            message="Something went wrong while rendering this canvas."
            actions={[
              { label: 'Reload canvas', onClick: () => setCanvasInstanceKey((k) => k + 1) },
              {
                label: 'Restore last-known-good',
                onClick: () => {
                  // Autosave has usually already written the state that crashed, so reloading from
                  // disk would crash again. Step back past the last change instead (redo keeps it);
                  // only with nothing to undo does the stored copy stand in.
                  const editor = useEditorStore.getState();
                  if (editor.history.past.length > 0) {
                    editor.undo();
                    setCanvasInstanceKey((k) => k + 1);
                    return;
                  }
                  void session.openDocument(session.openId!).then(() => setCanvasInstanceKey((k) => k + 1));
                },
              },
              ...(embeddedHost ? [] : [{ label: 'Return home', onClick: () => void session.closeDocument() }]),
            ]}
            onError={(error, componentStack) =>
              logDiagnostic(error, { operation: 'canvas-render', documentId: session.openId }, componentStack)
            }
          >
            <Canvas
              onCreateAt={onCanvasCreateAt}
              onQuickConnectMenu={onQuickConnectMenu}
              onEmptyCanvasMenu={onEmptyCanvasMenu}
            />
          </ErrorBoundary>
          {quickConnect && (
            <QuickConnectMenu
              screenPosition={quickConnect.screenPosition}
              anchorRect={quickConnectAnchorRect}
              items={quickConnectRows}
              onSelect={onQuickConnectSelect}
              onHighlight={onQuickConnectHighlight}
              onDismiss={dismissQuickConnect}
            />
          )}
          {!presenting && contextMenu && (
            <ContextMenu
              screenPosition={contextMenu.screenPosition}
              entries={contextMenuEntries}
              onSelect={runContextMenuCommand}
              onDismiss={dismissContextMenu}
            />
          )}
          {!presenting && <AttachmentPopover />}
          {!presenting && <EdgeInspectorPopover />}
          {!presenting && <ElementInspectorPopover buildCommandContext={buildCommandContext} />}
          <PresentationCalloutLayer />
          <EmptyState onInsertStarter={insertStarter} />
          {!presenting && <ContinuationAnnouncer />}
          {!presenting && <Inspector />}
          {!presenting && <FlowPanel playback={playback} />}
          {/* Ungated on purpose — the only surface here besides the flow bar that presentation
              lets through, and then only its one-line capture. See `TakeawaysPanel`. */}
          <TakeawaysPanel playback={playback} buildCommandContext={buildCommandContext} />
          <FlowBar playback={playback} />
          <FocusIndicator />
          <DepthStack />
          <DepthAnnouncer />
          <DepthTransition />

          {presenting && (
            <div className="dc-present-exit">
              {!playback.active && playback.canStart && (
                <Button variant="quiet" icon="play" onClick={playback.start}>
                  Present a flow
                </Button>
              )}
              <Button variant="quiet" icon="close" onClick={() => setMode('edit')}>
                Exit presentation
              </Button>
            </div>
          )}
        </div>

        {learnMounted && (
          <PanelBoundary onError={onLearnFailed}>
            <Suspense fallback={null}>
              <LearnDrawerChunk.Component />
            </Suspense>
          </PanelBoundary>
        )}
      </div>

      <StatusBar
        durable={session.durable}
        presenting={presenting}
        onResolveConflict={(choice) => void session.resolveConflict(choice)}
      />

      <ShortcutSheet />
      {exportMounted && (
        <PanelBoundary onError={onExportFailed}>
          <Suspense fallback={null}>
            <ExportDialogChunk.Component />
          </Suspense>
        </PanelBoundary>
      )}
      <CanvasSettingsDialog />
      <ClipboardPermissionDialog />
      <CommandPalette createAt={createAt} createAtPointer={createAtPointer} playback={playback} />

      {/* Hidden control kept reachable for screen readers in presentation mode. */}
      {presenting && (
        <button type="button" className="dc-sr-only" onClick={() => setShortcutsOpen(true)}>
          Keyboard shortcuts
        </button>
      )}
    </div>
  );
}

/**
 * The one screen-reader-facing signal Intent Continuation makes: a polite announcement when a new
 * offer appears — once per offer, never on a re-show — so a ghost that is only visual otherwise
 * is still discoverable without a pointer.
 */
function ContinuationAnnouncer() {
  const message = useUiStore((state) => {
    const offer = state.continuation;
    if (offer?.trigger !== 'select') return '';
    const ids = offer.alternatives ?? [];
    if (ids.length < 2) return `Suggested: ${offer.label}. Press Tab to add it.`;
    const position = `${ids.indexOf(offer.id) + 1} of ${ids.length}`;
    return `Suggested: ${offer.label}, ${position}. Press Tab to add it, or ] for the next.`;
  });
  return (
    <div className="dc-sr-only" aria-live="polite">
      {message}
    </div>
  );
}

/**
 * Keyboard handling for the whole editor.
 *
 * Anything typed into a field belongs to that field, so the handler bails out
 * the moment focus is inside an input — otherwise pressing "n" while renaming a
 * node would spawn a note.
 */
/** Exported only for `tests/keyboard-dispatch.test.tsx`, which renders this hook directly (via
 *  `renderHook`) to fire real `keydown` events against the actual dispatch switch below — so a
 *  binding changed here can't silently drift from what `shortcutLookup.ts` tells the palette and
 *  Shortcut Sheet to display. Not part of the app's own render path otherwise; `EditorScreen`
 *  below still calls it exactly as before. */
export function useKeyboard({
  createAtPointer,
  onPresent,
  playback,
}: {
  createAtPointer: (preset: Preset) => void;
  onPresent: () => void;
  playback: ReturnType<typeof useFlowPlayback>;
}) {
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const arm = useUiStore((state) => state.arm);
  const setFlowPanelOpen = useUiStore((state) => state.setFlowPanelOpen);
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const { fitView, zoomIn, zoomOut, zoomTo, screenToFlowPosition, flowToScreenPosition, setCenter, getZoom } =
    useReactFlow();

  // Relationship-navigation (Alt+Shift+Left/Right) cycle state — which node the cycle started
  // from, which direction it's cycling, and which of its neighbors was last landed on.
  // Deliberately *not* re-derived from the live selection: once a press selects a neighbor, that
  // neighbor *is* the selection, so the only way to tell "still mid-cycle from the original
  // anchor" apart from "the user selected this node some other way" is to remember it here. A
  // press whose live selection no longer matches `relCycleLastLanded` — or that switches direction, e.g.
  // Right then Left — starts a brand-new cycle/walk from whatever is selected now: switching
  // direction reads as "go back from here", not "keep exploring the original anchor's other
  // siblings", so it must not silently keep the old anchor.
  const relCycleAnchor = useRef<string | null>(null);
  const relCycleDirection = useRef<'outgoing' | 'incoming' | null>(null);
  const relCycleLastLanded = useRef<string | null>(null);

  /** Selects `nodeId` and pans (never zooms) it into view if it isn't comfortably on screen — a
   *  keyboard navigation that lands somewhere invisible would otherwise feel like it did nothing. */
  const selectAndReveal = useCallback(
    (nodeId: string) => {
      const state = useEditorStore.getState();
      const target = state.document.nodes.find((n) => n.id === nodeId);
      if (!target) return;
      state.setSelection({ nodes: [nodeId], edges: [] });
      const center = centerOf(target);
      const screen = flowToScreenPosition(center);
      const margin = 96; // clear of the toolbar and edges, not flush against them
      const { right, bottom } = canvasBounds();
      const onScreen = screen.x > margin && screen.x < right - margin && screen.y > margin && screen.y < bottom - margin;
      if (!onScreen) void setCenter(center.x, center.y, { zoom: getZoom(), duration: motionMs(200) });
    },
    [flowToScreenPosition, getZoom, setCenter],
  );

  /**
   * The keyboard-only path into the context menu (Shift+F10 / the Menu key, standard desktop
   * convention) — anchors the menu to the current selection instead of a click point, since there's
   * no pointer position to use. A single node/edge/multi-selection each resolve their own screen
   * anchor; nothing selected is a no-op, since there's no keyboard-native equivalent of "a point on
   * empty canvas" — the pane menu stays mouse-only, a deliberate scope boundary, not an oversight.
   * Presentation Mode is excluded for free: `selection` is always empty there (`setMode('present')`
   * clears it), so this always falls through to the no-op branch without needing its own check.
   */
  const openContextMenuFromKeyboard = useCallback(() => {
    const state = useEditorStore.getState();
    const { nodes, edges } = state.selection;
    let flowPoint: { x: number; y: number } | undefined;
    let target: ContextMenuTarget | undefined;

    if (nodes.length === 1 && edges.length === 0) {
      const node = state.document.nodes.find((n) => n.id === nodes[0]);
      if (node) {
        flowPoint = centerOf(node);
        target = { kind: 'node', id: node.id };
      }
    } else if (edges.length === 1 && nodes.length === 0) {
      const edge = state.document.edges.find((e) => e.id === edges[0]);
      const source = edge ? state.document.nodes.find((n) => n.id === edge.source) : undefined;
      const edgeTarget = edge ? state.document.nodes.find((n) => n.id === edge.target) : undefined;
      if (edge && source && edgeTarget) {
        // Same source/target-center-average heuristic `detachFromEdge` already uses for placement —
        // not the full routing engine, for the same "not worth the coupling" reason that op gives.
        flowPoint = {
          x: (source.x + source.width / 2 + edgeTarget.x + edgeTarget.width / 2) / 2,
          y: (source.y + source.height / 2 + edgeTarget.y + edgeTarget.height / 2) / 2,
        };
        target = { kind: 'edge', id: edge.id };
      }
    } else if (nodes.length + edges.length >= 2) {
      const bounds = boundsOf(state.document.nodes.filter((n) => nodes.includes(n.id)));
      flowPoint = bounds
        ? centerOf(bounds)
        // An edges-only multi-selection has no node bounds to anchor to — the viewport center is a
        // reasonable, simple fallback; the menu's own content is correct regardless of where it opens.
        : screenToFlowPosition(canvasCenter());
      target = { kind: 'selection' };
    }

    if (!flowPoint || !target) return;
    useUiStore.getState().setContextMenu({
      target,
      screenPosition: flowToScreenPosition(flowPoint),
      flowPosition: flowPoint,
    });
  }, [flowToScreenPosition, screenToFlowPosition]);

  // Cmd/Ctrl+V is a real OS paste gesture, so the browser fires a native `paste` event carrying
  // `clipboardData` synchronously — reading that needs no `navigator.clipboard` permission at all,
  // unlike `syncClipboardFromSystem()`'s async Clipboard API read. This is why plain ⌘V never
  // triggers a permission prompt; only the context-menu/palette "Paste" commands do (they have no
  // real `ClipboardEvent` to read from — see `requestClipboardRead` in `lib/clipboardPermission.ts`).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (useUiStore.getState().commandPaletteOpen) return;
      if (useUiStore.getState().contextMenu) return;
      // Nothing lands behind a dialog, and a presentation is read-only.
      if (modalIsOpen() || useEditorStore.getState().mode === 'present') return;
      // Nor mid-drag: it would fold into the gesture's own undo step.
      if (useUiStore.getState().interactionActive) return;
      event.preventDefault();
      // Best-effort adoption of whatever the OS clipboard actually handed us — foreign text, or
      // none at all (e.g. a blocked/failed clipboard write elsewhere), is not an error. `paste()`
      // always runs regardless, same as the old keydown handler did after its own best-effort
      // sync: same-tab paste must keep working off the in-memory clipboard even when nothing came
      // through here.
      const text = event.clipboardData?.getData('text/plain');
      if (text) useEditorStore.getState().applyExternalClipboardText(text);
      const target = pointer.known
        ? { x: pointer.x, y: pointer.y }
        : screenToFlowPosition(canvasCenter());
      useEditorStore.getState().paste(target);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [screenToFlowPosition]);

  // The same gesture's other half, for a copy/cut that isn't a keystroke: a browser's own Edit menu.
  // Its event can write `clipboardData` even where `navigator.clipboard` is refused. ⌘C/⌘X are
  // handled on keydown and never become this event.
  useEffect(() => {
    const onCopyOrCut = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      // Text selected on the page (a dialog, Learn) copies as text.
      const selected = window.getSelection();
      if (selected && !selected.isCollapsed) return;
      const ui = useUiStore.getState();
      if (ui.commandPaletteOpen || ui.contextMenu || ui.interactionActive || modalIsOpen()) return;
      const state = useEditorStore.getState();
      if (event.type === 'cut' && state.mode === 'present') return;
      const text = event.type === 'cut' ? state.cutSelection() : state.copySelection();
      if (text === null || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
    };
    window.addEventListener('copy', onCopyOrCut);
    window.addEventListener('cut', onCopyOrCut);
    return () => {
      window.removeEventListener('copy', onCopyOrCut);
      window.removeEventListener('cut', onCopyOrCut);
    };
  }, []);

  // Escape on a ghost, ahead of everyone else. React Flow deselects a focused node on Escape from
  // its own handler on the node element, and every popover has its own capture-phase Escape; a
  // capture-phase listener registered here runs before any of them, so one Escape means exactly
  // "wave the suggestion away" — the selection it was offered for stays put — and nothing else.
  useEffect(() => {
    const onEscapeCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isEditableTarget(event.target)) return;
      // An Escape meant for a dialog or for Learn is theirs, not the ghost's.
      if (isInOwnKeyboardRegion(event.target) || modalIsOpen()) return;
      const uiState = useUiStore.getState();
      if (uiState.continuation?.trigger !== 'select') return;
      if (uiState.quickConnect || uiState.contextMenu || uiState.commandPaletteOpen) return;
      // A panel open on the selected node's popover (colour, typography, a type dropdown, an
      // attachment card) closes first. Those listen on `window` in the capture phase too, where
      // `stopPropagation` can't hold them back, so one Escape would otherwise do both.
      if (uiState.openAttachmentDetail || document.querySelector('.dc-popover-panel, .dc-inspector-select-menu')) return;
      event.preventDefault();
      event.stopPropagation();
      uiState.dismissContinuation();
    };
    window.addEventListener('keydown', onEscapeCapture, true);
    return () => window.removeEventListener('keydown', onEscapeCapture, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      // While the command palette is up it owns the keyboard outright — even if focus has
      // somehow left its input, a stray "t" must never spawn a Text node behind it.
      if (useUiStore.getState().commandPaletteOpen) return;
      // Same reasoning for the context menu: it has its own capture-phase listener for
      // Escape/Arrows/Enter, but any other key (e.g. a shape shortcut) would otherwise fall
      // through to here and spawn a node behind an open menu.
      if (useUiStore.getState().contextMenu) return;
      // …and Quick Connect, which owns only Escape/arrows/Enter/Tab: a letter would drop a shape behind
      // it, and Backspace would delete the very node it is connecting from.
      if (useUiStore.getState().quickConnect) return;
      // A modal (Export, Settings, Shortcuts, About) focuses its own panel, which
      // `isEditableTarget` doesn't count — without this, Backspace deleted the selection
      // behind the dialog and letter keys dropped nodes under it. Its own Escape/Tab
      // handling is untouched. (Learn's sheet stops bare keys further down, after the ⌘ chords.)
      if (dialogIsOpen()) return;
      // Mid-gesture (a node dragged or resized, a connector end being repointed), commands wait:
      // Delete removes the node React Flow is dragging, which aborts the drag without its stop
      // callback and strands the undo bracket open; Escape or ⌘A rebuild the nodes under the drag;
      // ⌘Enter commits a move into a presentation. A repoint's own Escape has its own listener.
      if (useUiStore.getState().interactionActive) return;

      const meta = event.metaKey || event.ctrlKey;
      const state = useEditorStore.getState();
      // Presenting is read-only: the canvas already refuses pointer edits and the palette
      // offers present-only commands, so the keyboard must not be the one way to edit.
      const presenting = state.mode === 'present';

      // `]` / `[` step through Intent Continuation's alternatives — or, with nothing showing, ask
      // for them. Matched on the produced character, not the physical key, and ahead of the
      // Cmd/Ctrl branch because AltGr arrives as Ctrl+Alt on Windows (German `[` is AltGr+8, and
      // Option+5 on a Mac — hence Alt is allowed too). Cmd and plain Ctrl chords are left alone.
      if ((event.key === ']' || event.key === '[') && !event.metaKey && !(event.ctrlKey && !event.altKey)) {
        if (
          !event.repeat &&
          !presenting &&
          !playback.active &&
          !state.focus.active &&
          focusIsOnCanvas() &&
          !modalIsOpen() &&
          stepContinuation(state, event.key === ']' ? 1 : -1)
        ) {
          event.preventDefault();
        }
        return;
      }

      if (meta) {
        const key = event.key.toLowerCase();
        if (presenting && ['z', 'y', 'x', 'd', 'a', 'g', 'b', 'i'].includes(key)) return;
        if ((key === 'c' || key === 'x' || key === 'a') && !event.shiftKey && isTextChord(event)) return;
        switch (key) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) state.redo();
            else state.undo();
            return;
          case 'y':
            event.preventDefault();
            state.redo();
            return;
          case 'c':
          case 'x':
            event.preventDefault();
            if (key === 'c') state.copySelection();
            else state.cutSelection();
            return;
          case 'v': {
            // Framed by VS Code, a key pressed here never becomes a native paste event (nor Copy or
            // Cut, which is why those are handled above), so ⌘V pastes from here, reading the
            // clipboard through the host. Everywhere else the paste event does it — see `onPaste`.
            if (!embeddedHost || event.shiftKey || presenting || modalIsOpen()) return;
            event.preventDefault();
            const target = pointer.known ? { x: pointer.x, y: pointer.y } : screenToFlowPosition(canvasCenter());
            void state.syncClipboardFromSystem().then(() => {
              // The read is async: nothing lands if a gesture, a dialog or a presentation began meanwhile.
              if (useUiStore.getState().interactionActive || modalIsOpen()) return;
              if (useEditorStore.getState().mode === 'present') return;
              useEditorStore.getState().paste(target);
            });
            return;
          }
          case 'd':
            event.preventDefault();
            // Held down, key repeat would stamp out a copy per repeat tick.
            if (event.repeat) return;
            state.duplicateSelection();
            return;
          case 'e':
            // ⌘E and ⌘⇧E both (`key` is lowercased above). ⌘⇧E is the one shown everywhere: a
            // browser extension can claim a bare ⌘E before this page receives it.
            event.preventDefault();
            setExportOpen(true);
            return;
          case 'k':
            // The command palette. Only opens from here — while it's open its own
            // capture-phase listener owns every key, including the ⌘K that closes it again.
            event.preventDefault();
            setCommandPaletteOpen(true);
            return;
          case 'a': {
            event.preventDefault();
            state.setSelection({
              nodes: state.document.nodes.map((node) => node.id),
              edges: [],
            });
            return;
          }
          case 'g':
            event.preventDefault();
            if (event.shiftKey) state.ungroupSelection();
            else state.groupSelection();
            return;
          case 'enter':
            event.preventDefault();
            if (state.mode === 'present') state.setMode('edit');
            else onPresent();
            return;
          // The Finder chord, for the same two moves: open the thing you have, and go back out to
          // what contains it. Works while presenting too — stepping into a system mid-walkthrough
          // is the whole point.
          case 'arrowdown': {
            const { nodes, edges } = state.selection;
            if (event.shiftKey || event.altKey) return;
            if (nodes.length !== 1 || edges.length > 0) {
              // Only when something was selected: with nothing chosen, ⌘↓ is someone scrolling,
              // not someone asking to go somewhere, and a toast would be an answer to no question.
              if (nodes.length > 1) {
                event.preventDefault();
                useUiStore.getState().notify('Look inside one shape at a time.');
              }
              return;
            }
            event.preventDefault();
            void lookInside(nodes[0]!);
            return;
          }
          case 'arrowup':
            if (event.shiftKey || event.altKey || state.path.length === 0) return;
            // Held down, the key would climb all the way out one room per repeat.
            if (event.repeat) {
              event.preventDefault();
              return;
            }
            event.preventDefault();
            void backOut();
            return;
          case '=':
          case '+':
            event.preventDefault();
            void zoomIn();
            return;
          case '-':
            event.preventDefault();
            void zoomOut();
            return;
          case '0':
            // Reset-to-100%, the browser/VS Code/design-tool convention for this chord — keeps the
            // current viewport center rather than recentering on the document.
            event.preventDefault();
            void zoomTo(1);
            return;
          case 'b':
          case 'i': {
            // A whole-node toggle, not per-character formatting — only meaningful for exactly one
            // selected Text node. The same toggle also works mid-typing, wired separately in
            // `DraftNodeView.tsx`'s own textarea `onKeyDown` (this handler never fires there, since
            // `isEditableTarget` already returned above).
            const only =
              state.selection.nodes.length === 1 && state.selection.edges.length === 0
                ? state.document.nodes.find((n) => n.id === state.selection.nodes[0])
                : undefined;
            if (only?.type !== 'text') return;
            event.preventDefault();
            if (event.key.toLowerCase() === 'b') {
              state.updateNodeById(only.id, { textBold: !only.textBold }, 'Toggle bold');
            } else {
              state.updateNodeById(only.id, { textItalic: !only.textItalic }, 'Toggle italic');
            }
            return;
          }
          default:
            return;
        }
      }

      // Matched by `event.code` (the physical key) rather than `event.key` (the character a
      // layout produces for Shift+Digit1/Shift+Slash) — on a layout where Shift+1 doesn't type
      // '!', or Shift+/ doesn't type '?', matching the produced character would silently never
      // fire. Pulled out of the switch below since `switch (event.key)` can't express this.
      // `?` works from inside Learn too, which shows it as the key for the shortcut sheet.
      if (event.shiftKey && event.code === 'Slash') {
        // Otherwise the "?" that opened the sheet types itself into the sheet's own filter.
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Focus in Learn (docked beside a live canvas): its buttons and links own the bare keys — a
      // letter must not drop a shape behind it, nor Backspace delete the selection. ⌘ chords above
      // still reach the canvas. As a sheet over the canvas, Learn holds them wherever focus is.
      if (isInOwnKeyboardRegion(event.target) || modalIsOpen()) return;

      if (event.shiftKey && event.code === 'Digit1') {
        event.preventDefault();
        void fitView({ padding: 0.2, duration: motionMs(320), nodes: flowFitViewNodes(state) });
        return;
      }

      // Every bare key but Escape is dead while presenting — with exactly one exception, and it
      // earns it: capturing is the whole reason somebody would need a key mid-walkthrough
      // ("can we verify this?"), the step supplies the context for free, and presenting has no
      // text entry for it to collide with. Nothing else may join it here without the same case.
      const capturing =
        event.key.toUpperCase() === CAPTURE_ACTION_KEY && !event.shiftKey && !event.altKey;
      if (presenting && event.key !== 'Escape' && !capturing) return;
      // Handled ahead of the switch rather than as a case, since the key itself is a constant
      // (`takeaways/capture.ts`) and a computed `case` would hide which key this is. Same grammar
      // as the shape letters: one key, and what it makes opens ready to be typed into.
      if (capturing) {
        event.preventDefault();
        useUiStore.getState().setActionCaptureOpen(true);
        return;
      }
      // Enter and Space belong to a focused button, menu item or tab — they activate it.
      if ((event.key === 'Enter' || event.key === ' ') && isActivatableTarget(event.target)) return;

      switch (event.key) {
        case 'Backspace':
        case 'Delete':
          event.preventDefault();
          state.deleteSelection();
          return;
        case 'Escape': {
          // Mid endpoint drag, Escape cancels that drag (the handle's own listener) — and only that.
          if (useUiStore.getState().reconnectDragActive) return;
          arm(null);
          // Takeaways is a surface you opened, so it closes before anything you were doing on the
          // canvas does. The capture line handles its own Escape and stops it, so a press that
          // reaches here never has one open.
          //
          // Only when it is actually on screen: presentation hides the panel without closing it
          // (`TakeawaysPanel`), and consuming a press to shut something invisible would make the
          // first Escape of a walkthrough do nothing at all.
          if (useUiStore.getState().takeawaysOpen && state.mode !== 'present') {
            useUiStore.getState().setTakeawaysOpen(false);
            return;
          }
          // A presenter's reveal closes first — Escape backs out one thing, not the whole presentation.
          if (
            state.mode === 'present' &&
            revealIn(useUiStore.getState().presentationReveal, presentationScope(state.flowPlayback))
          ) {
            useUiStore.getState().setPresentationReveal(null);
            return;
          }
          if (state.focus.active) state.exitFocus();
          else if (playback.active) {
            playback.stop();
            if (state.mode === 'present') state.setMode('edit');
          } else if (state.mode === 'present') state.setMode('edit');
          // Last of all, and only with nothing selected: Escape steps back out of a shape, the way
          // it steps back out of everything else. Anything still selected is what Escape means
          // first — backing out of a room is never what someone wanted from their first press.
          else if (state.selection.nodes.length === 0 && state.selection.edges.length === 0 && state.path.length > 0) {
            void backOut();
          } else state.setSelection({ nodes: [], edges: [] });
          return;
        }
        case 'Tab': {
          // Tab accepts the ghost — and only then. With no offer showing, or with focus anywhere
          // but the canvas itself (a toolbar button, say), Tab stays the browser's: `isEditableTarget`
          // above only knows inputs, so this is the check that keeps focus traversal intact.
          if (event.shiftKey || event.altKey) break;
          if (playback.active || state.focus.active) break;
          const uiState = useUiStore.getState();
          const offer = uiState.continuation;
          if (!offer || offer.trigger !== 'select' || uiState.quickConnect || uiState.openAttachmentDetail) break;
          if (!focusIsOnCanvas()) break;
          event.preventDefault();
          state.acceptContinuation(offer);
          return;
        }
        case 'ContextMenu':
          event.preventDefault();
          openContextMenuFromKeyboard();
          return;
        case 'F10':
          if (!event.shiftKey) break; // plain F10 is unclaimed; only the Shift chord opens the menu
          event.preventDefault();
          openContextMenuFromKeyboard();
          return;
        case 'F': // Caps Lock on (Shift+F is turned away just below)
        case 'f':
          // Plain F only — Cmd/Ctrl+F already returned above via the `meta`
          // branch; Shift+F falls through unhandled rather than toggling.
          if (event.shiftKey || event.altKey) break;
          event.preventDefault();
          setFlowPanelOpen(!useUiStore.getState().flowPanelOpen);
          return;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          const direction: Direction =
            event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : event.key === 'ArrowUp' ? 'up' : 'down';

          if (event.altKey) {
            if (!focusIsOnCanvas()) return;
            event.preventDefault();

            // Alt+Shift+Left/Right: relationship-aware navigation — cycle through the selected
            // node's outgoing (Right) / incoming (Left) neighbors. Up/Down are left unbound here
            // (no equally natural graph meaning); Alt+Up/Down still falls through to plain spatial
            // navigation below.
            if (event.shiftKey && (direction === 'left' || direction === 'right')) {
              const { nodes: selected } = state.selection;
              if (selected.length !== 1) return;
              const selectedId = selected[0]!;
              const relDirection = direction === 'right' ? 'outgoing' : 'incoming';
              const continuingCycle =
                relCycleAnchor.current !== null &&
                relCycleDirection.current === relDirection &&
                relCycleLastLanded.current === selectedId;
              const anchorId = continuingCycle ? relCycleAnchor.current! : selectedId;
              if (!continuingCycle) {
                relCycleAnchor.current = anchorId;
                relCycleDirection.current = relDirection;
                relCycleLastLanded.current = null;
              }
              const next = nextRelationshipNeighbor(state.document, anchorId, relDirection, relCycleLastLanded.current);
              if (!next) return;
              relCycleLastLanded.current = next;
              selectAndReveal(next);
              return;
            }

            relCycleAnchor.current = null;
            relCycleDirection.current = null;
            relCycleLastLanded.current = null;
            const { nodes: selected } = state.selection;
            const originNode =
              selected.length === 1 ? state.document.nodes.find((n) => n.id === selected[0]) : undefined;
            const origin = originNode
              ? centerOf(originNode)
              : screenToFlowPosition(canvasCenter());
            const next = nearestInDirection(state.document.nodes, origin, direction, originNode?.id);
            if (!next) return;
            selectAndReveal(next);
            return;
          }

          if (state.selection.nodes.length === 0) return;
          event.preventDefault();
          const magnitude = event.shiftKey ? 10 : 1;
          const dx = direction === 'left' ? -magnitude : direction === 'right' ? magnitude : 0;
          const dy = direction === 'up' ? -magnitude : direction === 'down' ? magnitude : 0;
          state.nudgeSelection(dx, dy);
          return;
        }
        case 'Enter': {
          // Bare Enter only — and only when it is unambiguous what to edit,
          // and nothing else is already claiming keyboard input (the
          // walkthrough and Focus have their own controls; the Quick Connect
          // menu and an open attachment popover have their own Enter/Escape).
          if (event.shiftKey || event.altKey) return;
          if (playback.active || state.focus.active) return;
          const uiState = useUiStore.getState();
          if (uiState.quickConnect || uiState.openAttachmentDetail) return;
          const { nodes, edges } = state.selection;
          if (nodes.length === 1 && edges.length === 0) {
            const target = state.document.nodes.find((n) => n.id === nodes[0]);
            if (!target) return;
            event.preventDefault();
            uiState.requestEdit(target.id);
          } else if (edges.length === 1 && nodes.length === 0) {
            event.preventDefault();
            uiState.requestEdit(edges[0]!);
          }
          return;
        }
        default:
          break;
      }

      if (event.shiftKey || event.altKey) return;
      const preset = presetForShortcut(event.key);
      if (preset) {
        event.preventDefault();
        if (event.repeat) return;
        createAtPointer(preset);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    arm,
    createAtPointer,
    onPresent,
    openContextMenuFromKeyboard,
    playback,
    fitView,
    screenToFlowPosition,
    selectAndReveal,
    setCommandPaletteOpen,
    setExportOpen,
    setFlowPanelOpen,
    setShortcutsOpen,
    zoomIn,
    zoomOut,
    zoomTo,
  ]);
}
