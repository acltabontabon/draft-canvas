import type { Proposal } from '../api';

/**
 * How a revised proposal got here: its version, and what each earlier one said, oldest first, so a
 * refined design reads as one that evolved. Nothing for a first version.
 */
export function ProposalHistory({ proposal }: { proposal: Pick<Proposal, 'version' | 'history'> }) {
  const history = proposal.history ?? [];
  if (history.length === 0) return null;
  return (
    <details className="dc-proposal-history">
      <summary>
        Version {proposal.version} · {history.length === 1 ? 'revised once' : `revised ${history.length} times`}
      </summary>
      <ol>
        {history.map((revision) => (
          <li key={revision.version}>
            <span className="dc-proposal-history-version">v{revision.version}</span> {revision.summary}
          </li>
        ))}
      </ol>
    </details>
  );
}
