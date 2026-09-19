import { useCallback } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { Preset } from '../canvas/presets';
import type { DraftNode } from '../document/types';
import type { FlowPlaybackController } from '../presentation/useFlowPlayback';
import { flowFitViewNodes, useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import type { CommandContext } from './types';
import { motionMs } from '../lib/motion';

export interface UseCommandContextParams {
  createAt: (preset: Preset, position: { x: number; y: number }, autoEdit?: boolean) => DraftNode | null;
  createAtPointer: (preset: Preset) => DraftNode | null;
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
  const { fitView, zoomIn, zoomOut, zoomTo, screenToFlowPosition, setViewport } = useReactFlow();
  // Selected separately, as `useFlowPlayback` does: an object literal from a store selector is a
  // new identity every time and would re-render forever.
  const viewWidth = useStore((state) => state.width);
  const viewHeight = useStore((state) => state.height);
  return useCallback(
    (): CommandContext => {
      const editor = useEditorStore.getState();
      return {
        editor,
        ui: useUiStore.getState(),
        camera: {
          // Every command's camera move honours reduced motion here, once, rather than per command.
          fitView: (options) => fitView({ ...calm(options), nodes: options?.nodes ?? flowFitViewNodes(editor) }),
          zoomIn: (options) => zoomIn(calm(options)),
          zoomOut: (options) => zoomOut(calm(options)),
          zoomTo: (zoomLevel, options) => zoomTo(zoomLevel, calm(options)),
          screenToFlowPosition,
          setViewport: (viewport, options) => setViewport(viewport, calm(options)),
          viewWidth,
          viewHeight,
        },
        playback,
        createAt,
        createAtPointer,
      };
    },
    [
      createAt,
      createAtPointer,
      fitView,
      playback,
      screenToFlowPosition,
      setViewport,
      viewHeight,
      viewWidth,
      zoomIn,
      zoomOut,
      zoomTo,
    ],
  );
}

/** A camera move's options with its duration dropped to an instant jump under reduced motion. */
function calm<T extends { duration?: number }>(options: T | undefined): T | undefined {
  return options?.duration === undefined ? options : { ...options, duration: motionMs(options.duration) };
}
