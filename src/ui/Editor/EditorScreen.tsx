import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AttachmentPopover } from '../../canvas/AttachmentPopover';
import { Canvas } from '../../canvas/Canvas';
import { ContextMenu } from '../../canvas/ContextMenu';
import { EdgeInspectorPopover } from '../../canvas/EdgeInspectorPopover';
import { ElementInspectorPopover } from '../../canvas/ElementInspectorPopover';
import { presetForShortcut, type Preset } from '../../canvas/presets';
import { QuickConnectMenu } from '../../canvas/QuickConnectMenu';
import { contextMenuCommandsFor } from '../../commands/contextMenu';
import type { Command } from '../../commands/types';
import { useCommandContext } from '../../commands/useCommandContext';
import { createEdge, createNode } from '../../document/factory';
import { boundsOf } from '../../document/operations';
import { naturalCodeSize, describeContext } from '../../nodes/describe';
import { isEditableTarget } from '../../lib/isEditableTarget';
import { logDiagnostic } from '../../lib/diagnostics';
import { useEditorStore } from '../../store/editorStore';
import { pointer, useUiStore, type ContextMenuTarget } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { useFlowPlayback } from '../../presentation/useFlowPlayback';
import { useThemeValue } from '../theme/useTheme';
import { EditingFlowBanner } from './EditingFlowBanner';
import { EmptyState } from './EmptyState';
import { FlowBar } from './FlowBar';
import { FlowPanel } from './FlowPanel';
import { FocusIndicator } from './FocusIndicator';
import { CanvasSettingsDialog } from './CanvasSettingsDialog';
import { CommandPalette } from './CommandPalette';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { ShortcutSheet } from './ShortcutSheet';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { Button } from '../common/Button';
import { ErrorBoundary } from '../common/ErrorBoundary';

/** Sample content for a fresh code card, so it is never a blank grey box. */
const CODE_SAMPLES: Record<string, string> = {
  json: '{\n  "accountId": "123",\n  "status": "CANCELLED"\n}',
};

export function EditorScreen({ session }: { session: DocumentSession }) {
  const store = useEditorStore;
  const title = useEditorStore((state) => state.document.metadata.title);
  const mode = useEditorStore((state) => state.mode);
  const rename = useEditorStore((state) => state.rename);
  const setMode = useEditorStore((state) => state.setMode);

  const armed = useUiStore((state) => state.armed);
  const arm = useUiStore((state) => state.arm);
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const quickConnect = useUiStore((state) => state.quickConnect);
  const setQuickConnect = useUiStore((state) => state.setQuickConnect);
  const reconnecting = useUiStore((state) => state.reconnectDragActive);
  const contextMenu = useUiStore((state) => state.contextMenu);
  const setContextMenu = useUiStore((state) => state.setContextMenu);
  // Memoized so `QuickConnectMenu`/`ContextMenu`'s own listener-cleanup effects (keyed on
  // `onDismiss`) don't tear down and re-register on every unrelated `EditorScreen` re-render
  // while the menu is open — a fresh inline arrow here would give them a new identity every time.
  const dismissQuickConnect = useCallback(() => setQuickConnect(null), [setQuickConnect]);
  const dismissContextMenu = useCallback(() => setContextMenu(null), [setContextMenu]);
  // Reactive only so the menu's own contents stay correct if the world changes underneath it while
  // it's open (e.g. an undo from elsewhere) — read live via `getState()` inside `buildContext`/
  // `contextMenuCommandsFor` otherwise, same split `CommandPalette.tsx` uses.
  const selection = useEditorStore((state) => state.selection);
  const editorDocument = useEditorStore((state) => state.document);

  const theme = useThemeValue();
  const playback = useFlowPlayback();
  const { fitView, screenToFlowPosition } = useReactFlow();

  // Bumped to force a clean remount of the boundary + Canvas below, e.g. from
  // the "Reload canvas" recovery action — a fresh `key` discards whatever
  // local component state the crashed instance was carrying.
  const [canvasInstanceKey, setCanvasInstanceKey] = useState(0);

  const createAt = useCallback(
    (preset: Preset, position: { x: number; y: number }) => {
      const code = preset.type === 'code' ? (CODE_SAMPLES[preset.language ?? ''] ?? '') : undefined;
      const size =
        preset.type === 'code' && code
          ? naturalCodeSize(code, describeContext(theme))
          : undefined;

      const node = store.getState().addNode({
        type: preset.type,
        x: Math.round(position.x),
        y: Math.round(position.y),
        width: size?.width,
        height: size?.height,
        text: preset.text ?? '',
        accent: preset.accent,
        noteKind: preset.noteKind,
        language: preset.language,
        code,
      });
      arm(null);
      return node;
    },
    [arm, store, theme],
  );

  /**
   * Creates the chosen type at the Quick Connect drop point. Also wires it
   * to `quickConnect.source` when present — absent means this menu was
   * opened by a plain double-click-to-create, not a connector drop.
   */
  const onQuickConnectSelect = useCallback(
    (preset: Preset) => {
      if (!quickConnect) return;
      if (!quickConnect.source) {
        createAt(preset, quickConnect.flowPosition);
        setQuickConnect(null);
        return;
      }
      const created = createNode({
        type: preset.type,
        x: quickConnect.flowPosition.x,
        y: quickConnect.flowPosition.y,
        text: preset.text ?? '',
        accent: preset.accent,
      });
      const edge = createEdge({
        source: quickConnect.source,
        target: created.id,
        sourceAnchor: quickConnect.sourceSide
          ? { side: quickConnect.sourceSide, offset: quickConnect.sourceOffset ?? 0.5 }
          : undefined,
      });
      store.getState().addNodesWithEdges([created], [edge], 'Connect to new node');
      setQuickConnect(null);
    },
    [createAt, quickConnect, setQuickConnect, store],
  );

  /** Places a new element under the cursor, or in the middle of the view. */
  const createAtPointer = useCallback(
    (preset: Preset) => {
      const position = pointer.known
        ? { x: pointer.x - 88, y: pointer.y - 34 }
        : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      return createAt(preset, position);
    },
    [createAt, screenToFlowPosition],
  );

  useKeyboard({ createAtPointer, playback });

  const buildCommandContext = useCommandContext({ createAt, createAtPointer, playback });

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

  const onFit = useCallback(() => {
    void fitView({ padding: 0.2, duration: 320 });
  }, [fitView]);

  const onPresent = useCallback(() => {
    setMode('present');
    if (playback.canStart) playback.start();
    void fitView({ padding: 0.18, duration: 320 });
  }, [playback, fitView, setMode]);

  const presenting = mode === 'present';

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
          onBack={() => void session.closeDocument()}
          onFit={onFit}
          onPresent={onPresent}
          onExport={() => setExportOpen(true)}
        />
      )}

      <div className="dc-editor-canvas">
        <ErrorBoundary
          key={canvasInstanceKey}
          scope="canvas"
          message="Something went wrong while rendering this canvas."
          actions={[
            { label: 'Reload canvas', onClick: () => setCanvasInstanceKey((k) => k + 1) },
            {
              label: 'Restore last-known-good',
              onClick: () => {
                void session.openDocument(session.openId!).then(() => setCanvasInstanceKey((k) => k + 1));
              },
            },
            { label: 'Return home', onClick: () => void session.closeDocument() },
          ]}
          onError={(error, componentStack) =>
            logDiagnostic(error, { operation: 'canvas-render', documentId: session.openId }, componentStack)
          }
        >
          <Canvas
            onCreateAt={(position) => armed && createAt(armed, position)}
            onQuickConnectMenu={(source, sourceSide, sourceOffset, flowPosition, screenPosition) =>
              setQuickConnect({ source, sourceSide, sourceOffset, flowPosition, screenPosition })
            }
            onEmptyCanvasMenu={(flowPosition, screenPosition) =>
              setQuickConnect({ flowPosition, screenPosition })
            }
          />
        </ErrorBoundary>
        {quickConnect && (
          <QuickConnectMenu
            screenPosition={quickConnect.screenPosition}
            onSelect={onQuickConnectSelect}
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
        {!presenting && <ElementInspectorPopover />}
        <EmptyState />
        {!presenting && <Inspector />}
        {!presenting && <FlowPanel playback={playback} />}
        <FlowBar playback={playback} />
        <FocusIndicator />
        {!presenting && <EditingFlowBanner />}

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

      {!presenting && <StatusBar durable={session.durable} />}

      <ShortcutSheet />
      <ExportDialog />
      <CanvasSettingsDialog />
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
 * Keyboard handling for the whole editor.
 *
 * Anything typed into a field belongs to that field, so the handler bails out
 * the moment focus is inside an input — otherwise pressing "n" while renaming a
 * node would spawn a note.
 */
function useKeyboard({
  createAtPointer,
  playback,
}: {
  createAtPointer: (preset: Preset) => void;
  playback: ReturnType<typeof useFlowPlayback>;
}) {
  const store = useEditorStore;
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const arm = useUiStore((state) => state.arm);
  const setFlowSwitcherOpen = useUiStore((state) => state.setFlowSwitcherOpen);
  const setCommandPaletteOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const { fitView, zoomIn, zoomOut, screenToFlowPosition, flowToScreenPosition } = useReactFlow();

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
    const state = store.getState();
    const { nodes, edges } = state.selection;
    let flowPoint: { x: number; y: number } | undefined;
    let target: ContextMenuTarget | undefined;

    if (nodes.length === 1 && edges.length === 0) {
      const node = state.document.nodes.find((n) => n.id === nodes[0]);
      if (node) {
        flowPoint = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
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
        ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
        // An edges-only multi-selection has no node bounds to anchor to — the viewport center is a
        // reasonable, simple fallback; the menu's own content is correct regardless of where it opens.
        : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      target = { kind: 'selection' };
    }

    if (!flowPoint || !target) return;
    useUiStore.getState().setContextMenu({
      target,
      screenPosition: flowToScreenPosition(flowPoint),
      flowPosition: flowPoint,
    });
  }, [flowToScreenPosition, screenToFlowPosition, store]);

  // Best-effort pickup of whatever's on the OS clipboard whenever the tab
  // regains focus, so it's already fresh by the time the user presses ⌘V —
  // `paste()` itself stays synchronous and never waits on this.
  useEffect(() => {
    const onFocus = () => {
      void store.getState().syncClipboardFromSystem();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [store]);

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

      const meta = event.metaKey || event.ctrlKey;
      const state = store.getState();

      if (meta) {
        switch (event.key.toLowerCase()) {
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
            event.preventDefault();
            state.copySelection();
            return;
          case 'x':
            event.preventDefault();
            state.cutSelection();
            return;
          case 'v':
            event.preventDefault();
            // Pull the freshest OS-clipboard content in first (best-effort —
            // falls back to whatever's already in the in-memory clipboard),
            // then paste around wherever the pointer is, same placement
            // `createAtPointer` uses for a freshly created node.
            void (async () => {
              await store.getState().syncClipboardFromSystem();
              const target = pointer.known
                ? { x: pointer.x, y: pointer.y }
                : screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
              store.getState().paste(target);
            })();
            return;
          case 'd':
            event.preventDefault();
            state.duplicateSelection();
            return;
          case 'e':
            event.preventDefault();
            setExportOpen(true);
            return;
          case 'k':
            // The command palette (Phase 8). Only opens from here — while it's open its own
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
            state.setMode(state.mode === 'present' ? 'edit' : 'present');
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
          default:
            return;
        }
      }

      switch (event.key) {
        case 'Backspace':
        case 'Delete':
          event.preventDefault();
          state.deleteSelection();
          return;
        case 'Escape':
          arm(null);
          if (state.focus.active) state.exitFocus();
          else if (state.flowEdit.active) state.exitFlowEdit();
          else if (playback.active) playback.stop();
          else state.setSelection({ nodes: [], edges: [] });
          return;
        case '?':
          setShortcutsOpen(true);
          return;
        case 'ContextMenu':
          event.preventDefault();
          openContextMenuFromKeyboard();
          return;
        case 'F10':
          if (!event.shiftKey) break; // plain F10 is unclaimed; only the Shift chord opens the menu
          event.preventDefault();
          openContextMenuFromKeyboard();
          return;
        case 'f':
          // Plain F only — Cmd/Ctrl+F already returned above via the `meta`
          // branch; Shift+F falls through unhandled rather than toggling.
          if (event.shiftKey || event.altKey) break;
          event.preventDefault();
          setFlowSwitcherOpen(!useUiStore.getState().flowSwitcherOpen);
          return;
        case '!':
          // Shift+1 — the conventional fit-to-view chord.
          event.preventDefault();
          void fitView({ padding: 0.2, duration: 320 });
          return;
        case '+':
        case '=':
          void zoomIn();
          return;
        case '-':
          void zoomOut();
          return;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (state.selection.nodes.length === 0) return;
          event.preventDefault();
          const magnitude = event.shiftKey ? 10 : 1;
          const dx = event.key === 'ArrowLeft' ? -magnitude : event.key === 'ArrowRight' ? magnitude : 0;
          const dy = event.key === 'ArrowUp' ? -magnitude : event.key === 'ArrowDown' ? magnitude : 0;
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
            if (!target || target.type === 'group') return;
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
        createAtPointer(preset);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    arm,
    createAtPointer,
    openContextMenuFromKeyboard,
    playback,
    fitView,
    screenToFlowPosition,
    setCommandPaletteOpen,
    setExportOpen,
    setFlowSwitcherOpen,
    setShortcutsOpen,
    store,
    zoomIn,
    zoomOut,
  ]);
}
