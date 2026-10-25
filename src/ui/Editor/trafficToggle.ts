import { lensFlow, useEditorStore } from '../../store/editorStore';

/**
 * Showing traffic from anywhere — the status bar chip, ⌘K, the canvas menu. The flow in view, if
 * one is lit, is what traffic starts scoped to: that is the story being looked at.
 */
export function showTraffic(): void {
  const editor = useEditorStore.getState();
  editor.showTraffic(lensFlow(editor)?.id ?? null);
}

export function toggleTraffic(): void {
  if (useEditorStore.getState().traffic.active) useEditorStore.getState().hideTraffic();
  else showTraffic();
}
