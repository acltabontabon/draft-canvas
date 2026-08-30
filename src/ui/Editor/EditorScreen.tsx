import { useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Canvas } from '../../canvas/Canvas';
import { CARD_PRESET, presetForShortcut, type Preset } from '../../canvas/presets';
import { naturalCodeSize, describeContext } from '../../nodes/describe';
import { useEditorStore } from '../../store/editorStore';
import { pointer, useUiStore } from '../../store/uiStore';
import type { DocumentSession } from '../../store/useDocumentSession';
import { useExplain } from '../../presentation/useExplain';
import { useThemeValue } from '../theme/useTheme';
import { EmptyState } from './EmptyState';
import { ExplainBar } from './ExplainBar';
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

  const theme = useThemeValue();
  const explain = useExplain();
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

  useKeyboard({ createAtPointer, explain });

  const onFit = useCallback(() => {
    void fitView({ padding: 0.2, duration: 320 });
  }, [fitView]);

  const onPresent = useCallback(() => {
    setMode('present');
    if (explain.canStart) explain.start();
    void fitView({ padding: 0.18, duration: 320 });
  }, [explain, fitView, setMode]);

  const presenting = mode === 'present';

  return (
    <div className="dc-editor" data-mode={mode} data-armed={armed ? 'true' : undefined}>
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
        <Canvas onCreateAt={(position) => createAt(armed ?? CARD_PRESET, position)} />
        <EmptyState />
        {!presenting && <Inspector />}
        <ExplainBar explain={explain} />

        {presenting && (
          <div className="dc-present-exit">
            {!explain.active && explain.canStart && (
              <Button variant="quiet" icon="play" onClick={explain.start}>
                Walk through
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
  explain,
}: {
  createAtPointer: (preset: Preset) => void;
  explain: ReturnType<typeof useExplain>;
}) {
  const store = useEditorStore;
  const setExportOpen = useUiStore((state) => state.setExportOpen);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const arm = useUiStore((state) => state.arm);
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
          if (explain.active) explain.stop();
          else state.setSelection({ nodes: [], edges: [] });
          return;
        case '?':
          setShortcutsOpen(true);
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
  }, [arm, createAtPointer, explain, fitView, setExportOpen, setShortcutsOpen, store, zoomIn, zoomOut]);
}
