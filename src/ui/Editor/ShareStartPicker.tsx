import { useState } from 'react';
import { fileWithLiveViewport, useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { copyShareLink } from '../../share';
import type { ShareStart } from '../../share/link';
import { collectRooms } from '../../export/rooms';
import { flowIsPlayable } from '../../document/flow';
import { displayNameFor } from '../../document/factory';
import { Button } from '../common/Button';

export function ShareStartPicker() {
  const state = useEditorStore.getState();
  const file = fileWithLiveViewport(state);
  const choices: { key: string; label: string; start?: ShareStart }[] = [
    { key: 'overview', label: 'Diagram overview' },
    { key: 'current', label: 'Current level', start: { path: [...state.path] } },
  ];
  for (const room of collectRooms(file)) {
    const path = room.owners.map((node) => node.id);
    const location = room.owners.map(displayNameFor).join(' / ') || 'Diagram overview';
    for (const flow of room.document.flows) {
      if (flowIsPlayable(room.document, flow)) choices.push({ key: flow.id, label: `${flow.title} — ${location}`, start: { path, flowId: flow.id } });
    }
  }
  const [selected, setSelected] = useState(() => choices.some((choice) => choice.key === state.selectedFlowId) ? state.selectedFlowId! : state.path.length ? 'current' : 'overview');
  return <div className="dc-export-share">
    <label>Start at <select aria-label="Start at" value={selected} onChange={(event) => setSelected(event.target.value)}>{choices.map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select></label>
    <Button icon="copy" onClick={() => void copyShareLink(fileWithLiveViewport(useEditorStore.getState()), useUiStore.getState().notify, choices.find((choice) => choice.key === selected)?.start)}>Copy share link</Button>
    <p className="dc-export-panel-description">The starting point changes where reading begins. The whole diagram is in the link; anyone with it can read every level. Nothing is uploaded.</p>
  </div>;
}
