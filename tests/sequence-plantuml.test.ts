import { describe, expect, it } from 'vitest';
import { toPlantUml } from '../src/sequence/plantuml';
import type { SequenceModel } from '../src/sequence/types';

function model(overrides: Partial<SequenceModel> = {}): SequenceModel {
  return { flowId: 'f1', flowTitle: 'Test', participants: [], messages: [], ...overrides };
}

describe('toPlantUml', () => {
  it('emits a valid, minimal skeleton for an empty model', () => {
    expect(toPlantUml(model())).toBe('@startuml\n@enduml\n');
  });

  it('declares each participant kind with its own PlantUML keyword', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'Customer', category: 'actor', kind: 'actor', sourceNodeId: 'n1' },
        { id: 'P2', label: 'Order API', category: 'service', kind: 'participant', sourceNodeId: 'n2' },
        { id: 'P3', label: 'Orders DB', category: 'database', kind: 'database', sourceNodeId: 'n3' },
        { id: 'P4', label: 'Order Events', category: 'topic', kind: 'queue', sourceNodeId: 'n4' },
      ],
    });
    const out = toPlantUml(m);
    expect(out).toContain('actor "Customer" as P1');
    expect(out).toContain('participant "Order API" as P2');
    expect(out).toContain('database "Orders DB" as P3');
    expect(out).toContain('queue "Order Events" as P4');
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
    const out = toPlantUml(m);
    expect(out).toContain('P1 -> P2: Call');
    expect(out).toContain('P2 --> P1: OK');
    expect(out).toContain('P1 ->> P2: Publish');
  });

  it('does not need to escape a literal colon in a message label', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
        { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
      ],
      messages: [
        { order: 0, from: 'P1', to: 'P2', label: 'HTTP 200: OK', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] },
      ],
    });
    expect(toPlantUml(m)).toContain('P1 -> P2: HTTP 200: OK');
  });

  it('never emits an empty message label', () => {
    const m = model({
      participants: [
        { id: 'P1', label: 'A', category: 'service', kind: 'participant', sourceNodeId: 'a' },
        { id: 'P2', label: 'B', category: 'service', kind: 'participant', sourceNodeId: 'b' },
      ],
      messages: [{ order: 0, from: 'P1', to: 'P2', label: '  ', interaction: 'sync', sourceEdgeIds: [], sourceStepIds: [] }],
    });
    expect(toPlantUml(m)).toContain(': Message');
  });

  it('escapes a double quote in a participant name', () => {
    const m = model({
      participants: [{ id: 'P1', label: 'The "Gateway"', category: 'service', kind: 'participant', sourceNodeId: 'a' }],
    });
    expect(toPlantUml(m)).toContain('participant "The \\"Gateway\\"" as P1');
  });
});
