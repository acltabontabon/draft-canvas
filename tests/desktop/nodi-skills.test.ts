import { describe, expect, it } from 'vitest';
import { matchSkills, skillQuery, skillsFor } from '../../src/desktop/ui/nodiSkills';

/** What `/` in Nodi's box offers: layouts for a diagram with something to lay out, questions with an agent. */

const flows = [
  { id: 'f1', title: 'Checkout' },
  { id: 'f2', title: 'Checkout' },
];

describe('Nodi’s skills', () => {
  it('offers layouts only with shapes to lay out, and questions only with an agent', () => {
    expect(skillsFor({ shapes: 1, flows: [], agent: false })).toEqual([]);
    const all = skillsFor({ shapes: 4, flows, agent: true });
    expect(all.map((s) => s.slash)).toEqual(['across', 'down', 'follow-checkout', 'follow-checkout-2', 'roomy', 'snug', 'tidy', 'explain', 'risks', 'present']);
    // Each flow is followed by its own id, however alike their names.
    expect(all.filter((s) => s.run.kind === 'arrange' && s.run.preset.primaryFlow).map((s) => s.run.kind === 'arrange' && s.run.preset.primaryFlow)).toEqual(['f1', 'f2']);
    expect(skillsFor({ shapes: 4, flows: [], agent: false }).some((s) => s.group === 'Ask')).toBe(false);
  });

  it('reads the query after the slash, and matches the slash first, then any word', () => {
    expect(skillQuery('/')).toBe('');
    expect(skillQuery('/Ro')).toBe('ro');
    expect(skillQuery('/roomy please')).toBeNull();
    expect(skillQuery('what /')).toBeNull();
    const all = skillsFor({ shapes: 4, flows, agent: true });
    expect(matchSkills(all, 'd').map((s) => s.slash)[0]).toBe('down');
    // "room" starts a slash; "space" only a hint's word.
    expect(matchSkills(all, 'room').map((s) => s.slash)).toEqual(['roomy']);
    expect(matchSkills(all, 'space').map((s) => s.slash)).toEqual(['roomy']);
    expect(matchSkills(all, 'zzz')).toEqual([]);
  });
});
