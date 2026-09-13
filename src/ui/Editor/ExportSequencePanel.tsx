import type { SequenceFormat } from '../../export';
import { useUiStore } from '../../store/uiStore';
import { SegmentedControl } from '../common/SegmentedControl';
import { LearnLink } from '../learn/LearnLink';

interface SequencePanelProps {
  format: SequenceFormat;
  onFormatChange: (format: SequenceFormat) => void;
  playableFlowCount: number;
}

export function ExportSequencePanel({ format, onFormatChange, playableFlowCount }: SequencePanelProps) {
  const empty = playableFlowCount === 0;
  const setExportOpen = useUiStore((state) => state.setExportOpen);

  return (
    <div className="dc-export-panel">
      <p className="dc-export-panel-description">
        {empty
          ? 'Add a Flow to export sequence diagram source.'
          : 'Sequence diagram source generated from your Flows.'}
        {/* Above the choice, not between it and Export: the format and its action stay one Tab apart.
            Closes Export first — Learn opens beside the canvas, never underneath a dialog. */}
        <LearnLink recipeId="export-sequence" className="dc-learn-link-inline" onOpen={() => setExportOpen(false)} />
      </p>
      <SegmentedControl
        name="sequence-format"
        legend="Diagram source format"
        value={format}
        onChange={onFormatChange}
        disabled={empty}
        options={[
          { value: 'mermaid', label: 'Mermaid' },
          { value: 'plantuml', label: 'PlantUML' },
        ]}
      />
    </div>
  );
}
