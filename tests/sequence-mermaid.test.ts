import { describe, expect, it } from 'vitest';
import { toMermaid } from '../src/sequence/mermaid';
import type { SequenceModel } from '../src/sequence/types';

function model(overrides: Partial<SequenceModel> = {}): SequenceModel {
  return { flowId: 'f1', flowTitle: 'Test', participants: [], messages: [], ...overrides };
}

describe('toMermaid', () => {
  it('emits a valid, minimal skeleton for an empty model', () => {
    expect(toMermaid(model())).toBe('sequenceDiagram\n');
  });

  it('declares each participant with the right keyword and an aliased, quoted name', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'Customer', category: 'actor', kind: 'actor', sourceNodeId: 'n1' },
        { id: 'P2', label: 'Order API', category: 'service', kind: 'participant', sourceNodeId: 'n2' },
        { id: 'P3', label: 'Orders DB', category: 'database', kind: 'database', sourceNodeId: 'n3' },
      ],
    });
    const out = toMermaid(m);
    expect(out).toContain('actor P1 as "Customer"');
    expect(out).toContain('participant P2 as "Order API"');
    // Mermaid has no `database` keyword — falls back to plain participant.
    expect(out).toContain('participant P3 as "Orders DB"');
  });

  it('uses the sync/response/async arrow for each interaction kind', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
        { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
      ],
      messages: [
        { order: 0, from: 'P1', to: 'P2', label: 'Call', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] },
        {
          order: 1,
          from: 'P2',
          to: 'P1',
          label: 'OK',
          interaction: 'response',
          isResponse: true,
          sourceEdgeIds: [],
          sourceStepIds: [],
        },
        { order: 2, from: 'P1', to: 'P2', label: 'Publish', interaction: 'async', sourceEdgeIds: [], sourceStepIds: [] },
      ],
    });
    const out = toMermaid(m);
    expect(out).toContain('P1->>P2: Call');
    expect(out).toContain('P2-->>P1: OK');
    expect(out).toContain('P1-)P2: Publish');
  });

  it('guards a literal colon in a message label', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
        { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
      ],
      messages: [
        { order: 0, from: 'P1', to: 'P2', label: 'HTTP 200: OK', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] },
      ],
    });
    expect(toMermaid(m)).toContain('HTTP 200- OK');
  });

  it('never emits an empty message label', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
        { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
      ],
      messages: [{ order: 0, from: 'P1', to: 'P2', label: '  ', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] }],
    });
    expect(toMermaid(m)).toContain(': Message');
  });

  it('escapes a double quote and disambiguated duplicate names cleanly', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'Service', category: 'service', kind: 'participant', sourceNodeId: 'a' },
        { id: 'P2', label: 'Service (2)', category: 'service', kind: 'participant', sourceNodeId: 'b' },
        { id: 'P3', label: 'The "Gateway"', category: 'service', kind: 'participant', sourceNodeId: 'c' },
      ],
    });
    const out = toMermaid(m);
    expect(out).toContain('participant P1 as "Service"');
    expect(out).toContain('participant P2 as "Service (2)"');
    expect(out).toContain('participant P3 as "The \\"Gateway\\""');
  });
});
