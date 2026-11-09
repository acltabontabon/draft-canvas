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
    const all = skillsFor({ shapes: 4, flows, agent: true, commands: new Set(['straighten']), presentable: flows });
    expect(all.map((s) => s.slash)).toEqual(['across', 'down', 'follow-checkout', 'follow-checkout-2', 'roomy', 'snug', 'tidy', 'explain', 'risks', 'present']);
    // Each flow is followed by its own id, however alike their names.
    expect(all.filter((s) => s.run.kind === 'arrange' && s.run.preset.primaryFlow).map((s) => s.run.kind === 'arrange' && s.run.preset.primaryFlow)).toEqual(['f1', 'f2']);
    expect(skillsFor({ shapes: 4, flows: [], agent: false }).some((s) => s.group === 'Ask')).toBe(false);
  });

  it('offers a command or a presentation only when there is one to run', () => {
    // Straighten is the command behind /tidy; without it (no connectors, a shared copy) there is no /tidy.
    expect(skillsFor({ shapes: 4, flows, agent: false }).map((s) => s.slash)).not.toContain('tidy');
    expect(skillsFor({ shapes: 4, flows, agent: false, commands: new Set(['straighten']) }).find((s) => s.slash === 'tidy')?.run).toEqual({ kind: 'command', id: 'straighten' });
    // A flow with nothing to play isn't presentable; the first that is gets /present.
    expect(skillsFor({ shapes: 4, flows, agent: false, presentable: [] }).map((s) => s.slash)).not.toContain('present');
    expect(skillsFor({ shapes: 4, flows, agent: false, presentable: [flows[1]!] }).find((s) => s.slash === 'present')?.run).toEqual({ kind: 'present', flowId: 'f2' });
  });

  it('offers no layout on a diagram that can’t be changed', () => {
    const shared = skillsFor({ shapes: 4, flows, agent: true, readOnly: true, presentable: flows });
    expect(shared.some((s) => s.run.kind === 'arrange')).toBe(false);
    expect(shared.map((s) => s.slash)).toEqual(['explain', 'risks', 'present']);
  });

  it('reads the query after the slash, and matches the slash first, then any word', () => {
    expect(skillQuery('/')).toBe('');
    expect(skillQuery('/Ro')).toBe('ro');
    expect(skillQuery('/roomy please')).toBeNull();
    expect(skillQuery('what /')).toBeNull();
    const all = skillsFor({ shapes: 4, flows, agent: true, commands: new Set(['straighten']), presentable: flows });
    expect(matchSkills(all, 'd').map((s) => s.slash)[0]).toBe('down');
    // "room" starts a slash; "space" only a hint's word.
    expect(matchSkills(all, 'room').map((s) => s.slash)).toEqual(['roomy']);
    expect(matchSkills(all, 'space').map((s) => s.slash)).toEqual(['roomy']);
    expect(matchSkills(all, 'zzz')).toEqual([]);
  });
});
