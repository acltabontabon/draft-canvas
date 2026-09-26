import { vi } from 'vitest';
import type { CommandContext } from '../src/commands/types';
import type { FlowPlaybackController } from '../src/presentation/useFlowPlayback';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/** Shared stand-ins for the parts of a `CommandContext` that need a live canvas. */
export function stubPlayback(overrides: Partial<FlowPlaybackController> = {}): FlowPlaybackController {
  return {
    flows: [],
    flow: null,
    flowIndex: -1,
    steps: [],
    step: 0,
    current: null,
    active: false,
    picking: false,
    stage: 'step',
    atEnd: false,
    canStart: false,
    start: vi.fn(),
    pickFlow: vi.fn(),
    stop: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    goTo: vi.fn(),
    first: vi.fn(),
    last: vi.fn(),
    replay: vi.fn(),
    overview: vi.fn(),
    resumeFraming: vi.fn(),
    nextFlow: vi.fn(),
    previousFlow: vi.fn(),
    ...overrides,
  };
}

export function stubContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const editor = useEditorStore.getState();
  return {
    editor,
    ui: useUiStore.getState(),
    camera: {
      fitView: vi.fn(async () => true),
      zoomIn: vi.fn(async () => true),
      zoomOut: vi.fn(async () => true),
      zoomTo: vi.fn(async () => true),
      screenToFlowPosition: vi.fn((p: { x: number; y: number }) => p),
      setViewport: vi.fn(async () => true),
      viewWidth: 1200,
      viewHeight: 800,
    },
    playback: stubPlayback(),
    onPresent: vi.fn(),
    createAt: (preset, position) =>
      useEditorStore.getState().addNode({
        type: preset.type,
        x: position.x,
        y: position.y,
        text: preset.text ?? '',
        accent: preset.accent,
      }),
    createAtPointer: (preset) =>
      useEditorStore.getState().addNode({ type: preset.type, x: 0, y: 0, text: preset.text ?? '' }),
    ...overrides,
  };
}

