import { useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AttachmentPopover } from '../../canvas/AttachmentPopover';
import { Canvas } from '../../canvas/Canvas';
import { EdgeInspectorPopover } from '../../canvas/EdgeInspectorPopover';
import { ElementInspectorPopover } from '../../canvas/ElementInspectorPopover';
import { presetForShortcut, type Preset } from '../../canvas/presets';
import { QuickConnectMenu } from '../../canvas/QuickConnectMenu';
import { createEdge, createNode } from '../../document/factory';
import { naturalCodeSize, describeContext } from '../../nodes/describe';
import { useEditorStore } from '../../store/editorStore';
import { pointer, useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { useFlowPlayback } from '../../presentation/useFlowPlayback';
import { useThemeValue } from '../theme/useTheme';
import { EditingFlowBanner } from './EditingFlowBanner';
import { EmptyState } from './EmptyState';
import { FlowBar } from './FlowBar';
import { FlowPanel } from './FlowPanel';
import { FocusIndicator } from './FocusIndicator';
import { CanvasSettingsDialog } from './CanvasSettingsDialog';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { ShortcutSheet } from './ShortcutSheet';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { Button } from '../common/Button';

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

  const theme = useThemeValue();
  const playback = useFlowPlayback();
  const { fitView, screenToFlowPosition } = useReactFlow();

  const createAt = useCallback(
    (preset: Preset, position: { x: number; y: number }) => {
      const code = preset.type === 'code' ? (CODE_SAMPLES[preset.language ?? ''] ?? '') : undefined;
      const size =
        preset.type === 'code' && code
          ? naturalCodeSize(code, describeContext(theme))
          : undefined;

      store.getState().addNode({
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
      createAt(preset, position);
    },
    [createAt, screenToFlowPosition],
  );

  useKeyboard({ createAtPointer, playback });

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
        <Canvas
          onCreateAt={(position) => armed && createAt(armed, position)}
          onQuickConnectMenu={(source, sourceSide, sourceOffset, flowPosition, screenPosition) =>
            setQuickConnect({ source, sourceSide, sourceOffset, flowPosition, screenPosition })
          }
          onEmptyCanvasMenu={(flowPosition, screenPosition) =>
            setQuickConnect({ flowPosition, screenPosition })
          }
        />
        {quickConnect && (
          <QuickConnectMenu
            screenPosition={quickConnect.screenPosition}
            onSelect={onQuickConnectSelect}
            onDismiss={() => setQuickConnect(null)}
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
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }

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
            state.copySelection();
            return;
          case 'v':
            state.paste();
            return;
          case 'd':
            event.preventDefault();
            state.duplicateSelection();
            return;
          case 'e':
            event.preventDefault();
            setExportOpen(true);
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
    playback,
    fitView,
    setExportOpen,
    setFlowSwitcherOpen,
    setShortcutsOpen,
    store,
    zoomIn,
    zoomOut,
  ]);
}
