import { describe, expect, it } from 'vitest';
import { toMermaid } from '../src/sequence/mermaid';
import { toPlantUml } from '../src/sequence/plantuml';
import type { SequenceModel } from '../src/sequence/types';

/**
 * Mermaid and PlantUML must consume the SAME `SequenceModel` and agree on meaning — never
 * independently re-derive semantics. These tests build one hand-crafted model (a sync call, its
 * response, an async publish, and a note) and check both renderers for structural agreement:
 * same message count/order, same note, same single group boundary — each in its own native
 * syntax, never by string-diffing Mermaid against PlantUML directly.
 */
function buildParityModel(): SequenceModel {
  return {
    title: 'Parity Check',
    participants: [
      { id: 'P1', alias: 'Customer', label: 'Customer', category: 'actor', kind: 'actor', sourceNodeId: 'a' },
      { id: 'P2', alias: 'OrderAPI', label: 'Order API', category: 'service', kind: 'participant', sourceNodeId: 'b' },
      { id: 'P3', alias: 'PaymentService', label: 'Payment Service', category: 'service', kind: 'participant', sourceNodeId: 'c' },
      { id: 'P4', alias: 'OrderEvents', label: 'Order Events', category: 'topic', kind: 'queue', sourceNodeId: 'd' },
    ],
    elements: [
      {
        kind: 'group',
        id: 'f1',
        label: 'Happy Path',
        sourceFlowId: 'f1',
        children: [
          { kind: 'message', order: 0, from: 'P1', to: 'P2', label: 'Place Order', interaction: 'sync', sourceFlowId: 'f1', sourceEdgeIds: [], sourceStepIds: [] },
          { kind: 'message', order: 1, from: 'P2', to: 'P3', label: 'Charge Card', interaction: 'sync', sourceFlowId: 'f1', sourceEdgeIds: [], sourceStepIds: [] },
          { kind: 'message', order: 2, from: 'P3', to: 'P2', label: 'Approved', interaction: 'response', isResponse: true, sourceFlowId: 'f1', sourceEdgeIds: [], sourceStepIds: [] },
          { kind: 'message', order: 3, from: 'P2', to: 'P4', label: 'OrderPlaced', interaction: 'async', sourceFlowId: 'f1', sourceEdgeIds: [], sourceStepIds: [] },
          { kind: 'note', order: 4, participantIds: ['P3'], text: 'Idempotent', noteKind: 'note', sourceFlowId: 'f1' },
        ],
      },
    ],
  };
}

describe('Mermaid/PlantUML parity — both renderers consume the same SequenceModel', () => {
  it('carry the same message labels, each exactly once, in the same relative order', () => {
    const model = buildParityModel();
    const mermaid = toMermaid(model);
    const plantUml = toPlantUml(model);
    const labels = ['Place Order', 'Charge Card', 'Approved', 'OrderPlaced'];

    for (const label of labels) {
      expect(mermaid.split(label)).toHaveLength(2); // exactly one occurrence
      expect(plantUml.split(label)).toHaveLength(2);
    }
    const mermaidPositions = labels.map((l) => mermaid.indexOf(l));
    const plantUmlPositions = labels.map((l) => plantUml.indexOf(l));
    expect(mermaidPositions).toEqual([...mermaidPositions].sort((a, b) => a - b));
    expect(plantUmlPositions).toEqual([...plantUmlPositions].sort((a, b) => a - b));
  });

  it('carry the same note text, exactly once each', () => {
    const model = buildParityModel();
    expect(toMermaid(model).split('Idempotent')).toHaveLength(2);
    expect(toPlantUml(model).split('Idempotent')).toHaveLength(2);
  });

  it('wrap the one flow in exactly one group boundary, each in its own native syntax', () => {
    const model = buildParityModel();
    const mermaid = toMermaid(model);
    const plantUml = toPlantUml(model);

    expect(mermaid.split('rect rgb(240, 240, 240)')).toHaveLength(2);
    expect(plantUml.split(/^group /m)).toHaveLength(2);
  });

  it('reference every participant alias in both outputs', () => {
    const model = buildParityModel();
    const mermaid = toMermaid(model);
    const plantUml = toPlantUml(model);

    for (const alias of ['Customer', 'OrderAPI', 'PaymentService', 'OrderEvents']) {
      expect(mermaid).toContain(alias);
      expect(plantUml).toContain(alias);
    }
  });
});
