import { describe, expect, it } from 'vitest';
import { computeSequenceLayout } from '../src/sequence/layout';
import type { SequenceModel } from '../src/sequence/types';

function model(overrides: Partial<SequenceModel> = {}): SequenceModel {
  return { flowId: 'f1', flowTitle: 'Test', participants: [], messages: [], ...overrides };
}

describe('computeSequenceLayout', () => {
  it('produces a sane, non-NaN layout for an empty model', () => {
    const layout = computeSequenceLayout(model());
    expect(layout.participants).toHaveLength(0);
    expect(layout.messages).toHaveLength(0);
    expect(Number.isNaN(layout.width)).toBe(false);
    expect(Number.isNaN(layout.height)).toBe(false);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('a single participant (e.g. a self-loop) lays out without crashing', () => {
    const layout = computeSequenceLayout(
      model({
        participants: [{ id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' }],
        messages: [{ order: 0, from: 'P1', to: 'P1', label: 'Retry', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] }],
      }),
    );
    expect(layout.participants).toHaveLength(1);
    expect(layout.messages[0]!.fromX).toBe(layout.messages[0]!.toX);
    expect(Number.isNaN(layout.messages[0]!.fromX)).toBe(false);
  });

  it('column widths grow to fit a long participant label', () => {
    const short = computeSequenceLayout(
      model({ participants: [{ id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' }] }),
    );
    const long = computeSequenceLayout(
      model({
        participants: [
          {
            id: 'P1',
            label: 'A Very Long Participant Name Indeed',
            category: 'service',
            kind: 'participant',
            sourceNodeId: 'a',
          },
        ],
      }),
    );
    expect(long.participants[0]!.boxWidth).toBeGreaterThan(short.participants[0]!.boxWidth);
  });

  it('message rows stack top to bottom with stable, monotonic spacing', () => {
    const layout = computeSequenceLayout(
      model({
        participants: [
          { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
          { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
        ],
        messages: [
          { order: 0, from: 'P1', to: 'P2', label: 'One', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] },
          { order: 1, from: 'P2', to: 'P1', label: 'Two', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] },
          { order: 2, from: 'P1', to: 'P2', label: 'Three', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] },
        ],
      }),
    );
    const ys = layout.messages.map((m) => m.y);
    expect(ys[1]! - ys[0]!).toBe(ys[2]! - ys[1]!);
    expect(ys[0]!).toBeLessThan(ys[1]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
  });

  it('widens the gap between two adjacent columns when their message label needs more room', () => {
    const narrow = computeSequenceLayout(
      model({
        participants: [
          { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
          { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
        ],
        messages: [{ order: 0, from: 'P1', to: 'P2', label: 'Go', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] }],
      }),
    );
    const wide = computeSequenceLayout(
      model({
        participants: [
          { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
          { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
        ],
        messages: [
          {
            order: 0,
            from: 'P1',
            to: 'P2',
            label: 'A very long message label that needs a lot of horizontal room',
            interaction: 'sync',
            sourceEdgeIds: [],
            sourceStepIds: [],
          },
        ],
      }),
    );
    const narrowGap = narrow.participants[1]!.x - narrow.participants[0]!.x;
    const wideGap = wide.participants[1]!.x - wide.participants[0]!.x;
    expect(wideGap).toBeGreaterThan(narrowGap);
  });
});
