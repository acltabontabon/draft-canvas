import { ReactFlowProvider } from '@xyflow/react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { useKeyboard } from '../src/ui/Editor/EditorScreen';
import { useFlowPlayback } from '../src/presentation/useFlowPlayback';
import { shortcutFor } from '../src/commands/shortcutLookup';
import { MOD_SYMBOL } from '../src/lib/platform';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * `shortcutLookup.ts`'s own catalog (exercised by `tests/shortcut-catalog.test.ts`) only proves
 * `registry.ts`'s hand-typed `Command.shortcut` strings agree with `ShortcutSheet.tsx` — neither
 * of those is ever checked against `EditorScreen.tsx`'s `useKeyboard`, the one place a key is
 * actually bound to an action (see its own header comment). This file closes that gap: it fires
 * real `keydown` events at the real dispatch switch (via `useKeyboard`, exported for exactly this)
 * and confirms both that the expected effect happens *and* that the combo used is the one the
 * palette/menu/sheet display for that command — so a changed binding here fails loudly instead of
 * silently drifting from what the UI tells the user to press.
 */

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Keyboard dispatch'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
  useUiStore.setState({
    armed: null,
    exportOpen: false,
    quickConnect: null,
    contextMenu: null,
    interactionActive: false,
    commandPaletteOpen: false,
  });
}

function mount() {
  return renderHook(
    () => {
      const playback = useFlowPlayback();
      useKeyboard({ createAtPointer: () => null, playback });
      return playback;
    },
    { wrapper: ({ children }) => <ReactFlowProvider>{children}</ReactFlowProvider> },
  );
}

/** `EditorScreen`'s guards read `document.activeElement`/`document.querySelector` — dispatching on
 *  `window` with no dialog in the test's (empty) DOM matches how these chords actually fire once
 *  focus is anywhere on the app shell, not inside a text field or an open dialog. */
const press = (key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init }));
  });
};

function addNode(type: 'service' = 'service') {
  return useEditorStore.getState().addNode({ type, x: 0, y: 0, text: 'A' });
}

describe('keyboard dispatch — matches the shortcuts the UI displays', () => {
  beforeEach(reset);

  it('undo/redo (⌘Z / ⌘⇧Z) actually undo and redo, and match their displayed shortcuts', () => {
    mount();
    expect(shortcutFor('undo')).toBe(`${MOD_SYMBOL} Z`);
    expect(shortcutFor('redo')).toBe(`${MOD_SYMBOL} Shift Z`);

    addNode();
    expect(useEditorStore.getState().document.nodes).toHaveLength(1);

    press('z', { metaKey: true });
    expect(useEditorStore.getState().document.nodes).toHaveLength(0);

    press('z', { metaKey: true, shiftKey: true });
    expect(useEditorStore.getState().document.nodes).toHaveLength(1);
  });

  it('duplicate (⌘D) adds a copy of the selection, matching its displayed shortcut', () => {
    mount();
    expect(shortcutFor('duplicate')).toBe(`${MOD_SYMBOL} D`);
    const node = addNode();
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });

    press('d', { metaKey: true });
    expect(useEditorStore.getState().document.nodes).toHaveLength(2);
  });

  it('delete (Backspace) removes the selection, matching its displayed shortcut', () => {
    mount();
    expect(shortcutFor('delete')).toBe('Backspace');
    const node = addNode();
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });

    press('Backspace');
    expect(useEditorStore.getState().document.nodes).toHaveLength(0);
  });

  it('select-all (⌘A) selects every node, matching its displayed shortcut', () => {
    mount();
    expect(shortcutFor('select-all')).toBe(`${MOD_SYMBOL} A`);
    addNode();
    addNode();

    press('a', { metaKey: true });
    expect(useEditorStore.getState().selection.nodes).toHaveLength(2);
  });

  it('group/ungroup (⌘G / ⌘⇧G) wrap and unwrap a boundary, matching their displayed shortcuts', () => {
    mount();
    expect(shortcutFor('group')).toBe(`${MOD_SYMBOL} G`);
    expect(shortcutFor('ungroup')).toBe(`${MOD_SYMBOL} Shift G`);
    const a = addNode();
    const b = addNode();
    useEditorStore.getState().setSelection({ nodes: [a.id, b.id], edges: [] });

    press('g', { metaKey: true });
    const grouped = useEditorStore.getState().document.nodes;
    expect(grouped.some((n) => n.type === 'group')).toBe(true);
    expect(useEditorStore.getState().selection.nodes).toHaveLength(1);

    press('g', { metaKey: true, shiftKey: true });
    expect(useEditorStore.getState().document.nodes.some((n) => n.type === 'group')).toBe(false);
  });

  it('present toggle (⌘Enter) flips edit/present mode, matching its displayed shortcut', () => {
    mount();
    expect(shortcutFor('present')).toBe(`${MOD_SYMBOL} Enter`);
    expect(useEditorStore.getState().mode).toBe('edit');

    press('Enter', { metaKey: true });
    expect(useEditorStore.getState().mode).toBe('present');

    press('Enter', { metaKey: true });
    expect(useEditorStore.getState().mode).toBe('edit');
  });

  it('export (⌘⇧E) opens the export dialog, matching its displayed shortcut', () => {
    mount();
    expect(shortcutFor('export')).toBe(`${MOD_SYMBOL} Shift E`);
    expect(useUiStore.getState().exportOpen).toBe(false);

    press('e', { metaKey: true, shiftKey: true });
    expect(useUiStore.getState().exportOpen).toBe(true);
  });

  it('⌘K opens the command palette', () => {
    mount();
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);

    press('k', { metaKey: true });
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
  });

  it('fit view (Shift+1) and zoom in/out/reset (⌘=/⌘-/⌘0) are handled, matching their displayed shortcuts', () => {
    mount();
    expect(shortcutFor('fit')).toBe('Shift 1');
    expect(shortcutFor('zoom-in')).toBe(`${MOD_SYMBOL} +`);
    expect(shortcutFor('zoom-out')).toBe(`${MOD_SYMBOL} −`);
    expect(shortcutFor('zoom-reset')).toBe(`${MOD_SYMBOL} 0`);

    // No mounted `.react-flow` pane in this hook-only fixture to assert a viewport change against —
    // `event.defaultPrevented` is this suite's proof the switch actually matched the key, the same
    // signal `tests/host-document.test.tsx` uses for its own dispatch-only chords.
    // Matched by the physical key (`event.code`), not the character `event.key` produces — see the
    // matching comment in `EditorScreen.tsx` above its own `Digit1`/`Slash` checks.
    const fit = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', shiftKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(fit));
    expect(fit.defaultPrevented).toBe(true);

    const zoomIn = new KeyboardEvent('keydown', { key: '=', metaKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(zoomIn));
    expect(zoomIn.defaultPrevented).toBe(true);

    const zoomOut = new KeyboardEvent('keydown', { key: '-', metaKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(zoomOut));
    expect(zoomOut.defaultPrevented).toBe(true);

    const zoomReset = new KeyboardEvent('keydown', { key: '0', metaKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(zoomReset));
    expect(zoomReset.defaultPrevented).toBe(true);
  });
});
