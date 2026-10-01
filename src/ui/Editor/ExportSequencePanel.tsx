import { useMemo } from 'react';
import { SOURCE_FORMAT_INFO, SOURCE_FORMATS, type SourceFamily, type SourceFormat } from '../../export';
import { SegmentedControl } from '../common/SegmentedControl';

interface SequencePanelProps {
  format: SourceFormat;
  onFormatChange: (format: SourceFormat) => void;
  playableFlowCount: number;
  /** The text the export will write, exactly — `null` when there is nothing to write yet. */
  source: string | null;
}

/** Past this many lines the preview stops and says how many more there are: the file is the product. */
const PREVIEW_LINES = 200;

const FAMILY_FORMATS: Record<SourceFamily, SourceFormat[]> = {
  sequence: SOURCE_FORMATS.filter((id) => SOURCE_FORMAT_INFO[id].family === 'sequence'),
  architecture: SOURCE_FORMATS.filter((id) => SOURCE_FORMAT_INFO[id].family === 'architecture'),
};

/** The first format of a family — what switching to it lands on. */
function defaultFormatFor(family: SourceFamily): SourceFormat {
  return FAMILY_FORMATS[family][0]!;
}

/**
 * Two questions, asked in order: what the source reads (a Flow's telling, or the architecture
 * itself), then which dialect — rather than one row of six pills. The preview underneath is the
 * generated text itself, so what you see is what the file and the clipboard get.
 */
export function ExportSequencePanel({ format, onFormatChange, playableFlowCount, source }: SequencePanelProps) {
  const family = SOURCE_FORMAT_INFO[format].family;
  const empty = family === 'sequence' && playableFlowCount === 0;
  const preview = useMemo(() => {
    if (source === null) return null;
    const lines = source.replace(/\n$/, '').split('\n');
    if (lines.length <= PREVIEW_LINES) return { text: lines.join('\n'), more: 0 };
    return { text: lines.slice(0, PREVIEW_LINES).join('\n'), more: lines.length - PREVIEW_LINES };
  }, [source]);

  return (
    <div className="dc-export-panel">
      <p className="dc-export-panel-description">
        {family === 'sequence'
          ? empty
            ? 'Add a Flow to export sequence diagram source.'
            : 'Sequence diagram source generated from your Flows.'
          : 'The architecture — shapes, boundaries and connectors — as source other tools read.'}
      </p>
      <div className="dc-export-row">
        <SegmentedControl
          name="source-family"
          legend="Source of"
          value={family}
          onChange={(next) => onFormatChange(defaultFormatFor(next))}
          options={[
            { value: 'sequence', label: 'Flows' },
            { value: 'architecture', label: 'Architecture' },
          ]}
        />
        <SegmentedControl
          name="sequence-format"
          legend="Diagram source format"
          value={format}
          onChange={onFormatChange}
          disabled={empty}
          options={FAMILY_FORMATS[family].map((id) => ({ value: id, label: SOURCE_FORMAT_INFO[id].pick, name: SOURCE_FORMAT_INFO[id].label }))}
        />
      </div>
      {preview && (
        <div className="dc-export-preview" data-testid="export-source-preview">
          <pre tabIndex={0} aria-label={`${SOURCE_FORMAT_INFO[format].label} source`}>
            {preview.text}
          </pre>
          {preview.more > 0 && <span className="dc-export-preview-more">… {preview.more} more lines</span>}
        </div>
      )}
    </div>
  );
}
