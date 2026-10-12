import type { SourceEvidence } from '../document/types';

export function SourceEvidenceDetails({ sources }: { sources?: SourceEvidence[] }) {
  if (!sources?.length) return null;
  return (
    <details className="dc-source-evidence">
      <summary tabIndex={0}>Source evidence ({sources.length})</summary>
      <ol>
        {sources.map((source, index) => (
          <li key={index}>
            <strong>{source.basis === 'observed' ? 'Observed' : 'Inferred'}</strong>
            <code>{source.path}{source.line ? `:${source.line}` : ''}</code>
            {source.symbol && <span>{source.symbol}</span>}
            {source.commit && <code>{source.commit}</code>}
            {source.explanation && <span>{source.explanation}</span>}
          </li>
        ))}
      </ol>
      <p>References supplied by the author; check them against the repository.</p>
    </details>
  );
}
