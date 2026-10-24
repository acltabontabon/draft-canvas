import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProposalHistory } from '../../src/desktop/ui/ProposalHistory';

/** A revised proposal reads as one that evolved: its version, and what each earlier one said. */

describe('a proposal’s history', () => {
  it('lists earlier versions, oldest first', () => {
    const { container } = render(
      <ProposalHistory
        proposal={{
          version: 3,
          history: [
            { version: 1, summary: 'A cache', updatedAt: 1 },
            { version: 2, summary: 'Redis, explicit invalidation', updatedAt: 2 },
          ],
        }}
      />,
    );
    expect(container.querySelector('summary')?.textContent).toBe('Version 3 · revised 2 times');
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['v1 A cache', 'v2 Redis, explicit invalidation']);
  });

  it('says nothing about a first version', () => {
    expect(render(<ProposalHistory proposal={{ version: 1 }} />).container.innerHTML).toBe('');
  });
});
