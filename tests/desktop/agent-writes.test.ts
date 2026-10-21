import { beforeEach, describe, expect, it } from 'vitest';
import { __resetAgentWrites, confirmWrite, rememberPendingWrite } from '../../src/desktop/agentWrites';

/** Half the 16M-character budget, as before+after text. */
const half = { title: 'T', before: 'a'.repeat(4 * 1024 * 1024), after: 'b'.repeat(4 * 1024 * 1024) };

beforeEach(() => __resetAgentWrites());

describe('agent writes', () => {
  it('bounds pending writes by their total size, dropping the oldest first', () => {
    rememberPendingWrite(1, half);
    rememberPendingWrite(2, half);
    // A third would take the pending writes past the budget in all: the oldest goes.
    rememberPendingWrite(3, half);
    expect(confirmWrite(1, '~/a.draftcanvas', 's1')).toBeUndefined();
    expect(confirmWrite(2, '~/b.draftcanvas', 's2')).toBeDefined();
    expect(confirmWrite(3, '~/c.draftcanvas', 's3')).toBeDefined();
  });

  it('keeps small pending writes up to the entry limit', () => {
    for (let id = 1; id <= 8; id += 1) rememberPendingWrite(id, { title: 'T', before: 'x', after: 'y' });
    for (let id = 1; id <= 8; id += 1) expect(confirmWrite(id, `~/${id}.draftcanvas`, 's')).toBeDefined();
  });
});
