import { describe, expect, it } from 'vitest';
import { AgentError, Problems } from '../../src/agent/errors';

describe('Problems.throwIfAny', () => {
  it('collects every id when every problem is a DUPLICATE_ID', () => {
    const problems = new Problems();
    problems.add('DUPLICATE_ID', '/a', 'id "a" is already used', { id: 'a' });
    problems.add('DUPLICATE_ID', '/b', 'id "b" is already used', { id: 'b' });
    try {
      problems.throwIfAny();
      expect.unreachable('expected to throw');
    } catch (error) {
      expect((error as AgentError).details?.conflictingIds).toEqual(['a', 'b']);
    }
  });

  it('never populates conflictingIds when the problems are a mix of codes', () => {
    const problems = new Problems();
    problems.add('DUPLICATE_ID', '/a', 'id "a" is already used', { id: 'a' });
    problems.add('INVALID_REFERENCE', '/b', 'no such id');
    try {
      problems.throwIfAny();
      expect.unreachable('expected to throw');
    } catch (error) {
      expect((error as AgentError).details?.conflictingIds).toBeUndefined();
    }
  });

  it('never populates conflictingIds when the list was truncated at MAX, even if every kept problem is a DUPLICATE_ID', () => {
    // A batch with more than `Problems.MAX` duplicate ids, plus one further, different problem that
    // never made it into the list because it was truncated first — a homogeneous first 20 must not
    // be trusted as proof the 21st (dropped) problem doesn't exist and isn't a different kind, since
    // that's exactly what a crash-recovery caller (`looksAlreadyApplied`) relies on `conflictingIds`
    // meaning "the *only* obstacle was ids this proposal declared."
    const problems = new Problems();
    for (let i = 0; i < Problems.MAX; i++) {
      problems.add('DUPLICATE_ID', `/${i}`, `id "n${i}" is already used`, { id: `n${i}` });
    }
    problems.add('INVALID_REFERENCE', '/overflow', 'no such id'); // dropped by MAX, not counted
    try {
      problems.throwIfAny();
      expect.unreachable('expected to throw');
    } catch (error) {
      expect((error as AgentError).details?.conflictingIds).toBeUndefined();
    }
  });

  it('does nothing when nothing was added', () => {
    expect(() => new Problems().throwIfAny()).not.toThrow();
  });
});
