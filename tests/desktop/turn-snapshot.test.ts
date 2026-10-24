import { describe, expect, it } from 'vitest';
import { forgetTurnSnapshot, unchangedSinceLastTurn } from '../../src/desktop/turnSnapshot';

/** A follow-up turn on a diagram nobody has touched tells the agent not to read it again. */

describe('unchanged since the last turn', () => {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  const flows: unknown[] = [];
  const view = { nodes, edges, flows };

  it('is true only on a follow-up with the same parts, room and agent', () => {
    expect(unchangedSinceLastTurn('d_a', view, [], 'codex', false)).toBe(false);
    expect(unchangedSinceLastTurn('d_a', view, [], 'codex', true)).toBe(true);
    // A pan replaces the view, not its parts.
    expect(unchangedSinceLastTurn('d_a', { ...view }, [], 'codex', true)).toBe(true);
  });

  it('is false once anything it read could have moved on', () => {
    unchangedSinceLastTurn('d_b', view, [], 'codex', true);
    expect(unchangedSinceLastTurn('d_b', { ...view, nodes: [] }, [], 'codex', true)).toBe(false);
    expect(unchangedSinceLastTurn('d_b', view, ['n_api'], 'codex', true)).toBe(false);
    expect(unchangedSinceLastTurn('d_b', view, ['n_api'], 'claude-code', true)).toBe(false);
    // Not a follow-up: a new conversation always reads.
    expect(unchangedSinceLastTurn('d_b', view, ['n_api'], 'claude-code', false)).toBe(false);
    forgetTurnSnapshot('d_b');
    expect(unchangedSinceLastTurn('d_b', view, ['n_api'], 'claude-code', true)).toBe(false);
  });
  it('does not confuse room ids containing a path separator', () => {
    unchangedSinceLastTurn('d_rooms', view, ['a/b'], 'codex', false);
    expect(unchangedSinceLastTurn('d_rooms', view, ['a', 'b'], 'codex', true)).toBe(false);
  });

  it('forgets the oldest diagram when the cache reaches its limit', () => {
    unchangedSinceLastTurn('oldest', view, [], 'codex', false);
    for (let i = 0; i < 100; i += 1) unchangedSinceLastTurn(`cache-${i}`, view, [], 'codex', false);
    expect(unchangedSinceLastTurn('oldest', view, [], 'codex', true)).toBe(false);
  });

});
