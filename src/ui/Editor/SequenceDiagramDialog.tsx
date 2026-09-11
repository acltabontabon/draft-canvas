/**
 * A derived, read-only lens over the active Flow — never a second diagram to maintain. Opening it,
 * switching the flow it shows, or changing the source format never touches document history: the
 * only state involved is `uiStore.sequenceDiagramOpen` (session-only) and a `localStorage`
 * preference for the last-used export format, both plain UI state, exactly like
 * `editorStore.selectedFlowId` itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { findFlow, flowIsPlayable } from '../../document/flow';
import { readPreference, writePreference } from '../../lib/preferences';
import { buildSequenceModel, toMermaid, toPlantUml } from '../../sequence';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Modal } from '../common/Modal';
import { SequenceDiagramSvg } from './SequenceDiagramSvg';

type SourceFormat = 'mermaid' | 'plantuml';
const FORMAT_PREFERENCE_KEY = 'sequence-diagram-format';

function initialFormat(): SourceFormat {
  return readPreference(FORMAT_PREFERENCE_KEY) === 'plantuml' ? 'plantuml' : 'mermaid';
}

export function SequenceDiagramDialog() {
  const open = useUiStore((state) => state.sequenceDiagramOpen);
  const setOpen = useUiStore((state) => state.setSequenceDiagramOpen);
  const notify = useUiStore((state) => state.notify);
  const document = useEditorStore((state) => state.document);
  const selectedFlowId = useEditorStore((state) => state.selectedFlowId);
  const setSelectedFlowId = useEditorStore((state) => state.setSelectedFlowId);

  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [format, setFormat] = useState<SourceFormat>(initialFormat);

  const flow = selectedFlowId ? findFlow(document, selectedFlowId) : undefined;
  const playableFlows = useMemo(
    () => document.flows.filter((candidate) => flowIsPlayable(document, candidate)),
    [document],
  );

  // A derived view auto-closes rather than showing something stale — mirrors how Presentation
  // Mode reconciles itself when its own flow disappears mid-playback.
  useEffect(() => {
    if (open && (!flow || !flowIsPlayable(document, flow))) setOpen(false);
  }, [open, flow, document, setOpen]);

  if (!open || !flow) return null;

  const model = buildSequenceModel(document, flow);
  const formatName = format === 'mermaid' ? 'Mermaid' : 'PlantUML';
  const source = format === 'mermaid' ? toMermaid(model) : toPlantUml(model);

  function changeFormat(next: SourceFormat) {
    setFormat(next);
    writePreference(FORMAT_PREFERENCE_KEY, next);
  }

  function copySource() {
    navigator.clipboard
      .writeText(source)
      .then(() => notify(`Copied as ${formatName}`, 'info'))
      .catch(() => notify('Copy failed — check clipboard permissions.', 'error'));
  }

  return (
    <Modal
      title="Sequence Diagram"
      width={760}
      onClose={() => setOpen(false)}
      footer={
        view === 'source' ? (
          <Button variant="solid" onClick={copySource}>
            Copy {formatName}
          </Button>
        ) : undefined
      }
    >
      <ErrorBoundary
        scope="sequence-diagram"
        message="Something went wrong while building this sequence diagram."
        actions={[{ label: 'Close', onClick: () => setOpen(false) }]}
      >
        <div className="dc-sequence-dialog">
          <div className="dc-sequence-dialog-controls">
            {playableFlows.length > 1 && (
              <label className="dc-field dc-field-inline">
                <span>Flow</span>
                <select
                  className="dc-select"
                  value={flow.id}
                  onChange={(event) => setSelectedFlowId(event.target.value)}
                >
                  {playableFlows.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="dc-field dc-field-inline">
              <span>View</span>
              <select
                className="dc-select"
                value={view}
                onChange={(event) => setView(event.target.value as 'preview' | 'source')}
              >
                <option value="preview">Preview</option>
                <option value="source">Source</option>
              </select>
            </label>
            {view === 'source' && (
              <label className="dc-field dc-field-inline">
                <span>Format</span>
                <select
                  className="dc-select"
                  value={format}
                  onChange={(event) => changeFormat(event.target.value as SourceFormat)}
                >
                  <option value="mermaid">Mermaid</option>
                  <option value="plantuml">PlantUML</option>
                </select>
              </label>
            )}
          </div>

          {model.messages.length === 0 ? (
            <p className="dc-sequence-empty">This flow doesn't have enough interactions to build a sequence yet.</p>
          ) : view === 'preview' ? (
            <div className="dc-sequence-preview-scroll">
              <SequenceDiagramSvg model={model} />
            </div>
          ) : (
            <pre className="dc-sequence-source">
              <code>{source}</code>
            </pre>
          )}
        </div>
      </ErrorBoundary>
    </Modal>
  );
}
