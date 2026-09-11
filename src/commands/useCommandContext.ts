import { useCallback } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { Preset } from '../canvas/presets';
import type { DraftNode } from '../document/types';
import type { FlowPlaybackController } from '../presentation/useFlowPlayback';
import { flowFitViewNodes, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useTheme } from '../ui/theme/useTheme';
import type { CommandContext } from './types';

export interface UseCommandContextParams {
  createAt: (preset: Preset, position: { x: number; y: number }, autoEdit?: boolean) => DraftNode;
  createAtPointer: (preset: Preset) => DraftNode;
  playback: FlowPlaybackController;
}

/**
 * Assembles a `CommandContext` from live hooks — extracted from `CommandPalette.tsx`'s original
 * private `buildContext` closure so a second surface (the right-click context menu) can build the
 * exact same context without hand-copying it a second time. Returns a stable callback, not the
 * context itself: every call reads fresh store state via `getState()`, so a command always acts on
 * whatever is true the instant it runs, not whatever was true when the menu opened.
 */
export function useCommandContext({ createAt, createAtPointer, playback }: UseCommandContextParams): () => CommandContext {
  const { fitView, zoomIn, zoomOut, screenToFlowPosition, setViewport } = useReactFlow();
  // Selected separately, as `useFlowPlayback` does: an object literal from a store selector is a
  // new identity every time and would re-render forever.
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);
  const { toggle: toggleTheme } = useTheme();

  return useCallback(
    (): CommandContext => {
      const editor = useEditorStore.getState();
      return {
        editor,
        ui: useUiStore.getState(),
        camera: {
          fitView: (options) => fitView({ ...options, nodes: options?.nodes ?? flowFitViewNodes(editor) }),
          zoomIn,
          zoomOut,
          screenToFlowPosition,
          setViewport,
          viewWidth,
          viewHeight,
        },
        playback,
        createAt,
        createAtPointer,
        toggleTheme,
      };
    },
    [
      createAt,
      createAtPointer,
      fitView,
      playback,
      screenToFlowPosition,
      setViewport,
      toggleTheme,
      viewHeight,
      viewWidth,
      zoomIn,
      zoomOut,
    ],
  );
}
