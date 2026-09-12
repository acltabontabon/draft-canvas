import type { SequenceFormat } from '../../export';
import { SegmentedControl } from '../common/SegmentedControl';

interface SequencePanelProps {
  format: SequenceFormat;
  onFormatChange: (format: SequenceFormat) => void;
  playableFlowCount: number;
}

export function ExportSequencePanel({ format, onFormatChange, playableFlowCount }: SequencePanelProps) {
  const empty = playableFlowCount === 0;

  return (
    <div className="dc-export-panel">
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
      <p className="dc-export-panel-description">
        {empty
          ? 'Add a Flow to export sequence diagram source.'
          : 'Sequence diagram source generated from your Flows.'}
      </p>
    </div>
  );
}
