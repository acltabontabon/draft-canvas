import { describe, expect, it } from 'vitest';
import { schemaProblems, validateToolInput } from '../../src/agent/contract';
import { FULL_TOOLS } from '../../src/agent/schema';

const update = FULL_TOOLS.find((tool) => tool.name === 'update_diagram')!.inputSchema;
const request = (ops: unknown) => ({ requestId: 'r', diagramId: 'd', expectedRevision: 'f:1', ops });

describe('schema problems name what to fix', () => {
  it('points at the field of the op that was meant, not at "no shape matched"', () => {
    const problems = schemaProblems(update, request([{ op: 'update', id: 'a', set: { lable: 'x' } }]));
    expect(problems).toEqual(['/ops/0/set/lable: unknown field']);
  });

  it('lists the allowed values of a short enum, and counts a long one', () => {
    const colour = schemaProblems(update, request([{ op: 'update', id: 'a', set: { color: 'mauve' } }]));
    expect(colour.join(' ')).toMatch(/must be one of .*blue/);
    const level = schemaProblems(update, request([{ op: 'setLevel', level: 'galaxy' }]));
    expect(level.join(' ')).toMatch(/context/);
  });

  it('says which of ops or previewId is missing', () => {
    expect(schemaProblems(update, { requestId: 'r', diagramId: 'd', expectedRevision: 'f:1' }).join(' ')).toMatch(/is required/);
  });

  it('accepts a type the app resolves from a spelling the enum does not list', () => {
    expect(schemaProblems(update, request([{ op: 'update', id: 'a', set: { type: 'Postgres' } }]))).toEqual([]);
  });

  it('checks a preview or a proposal against the full op schema although the tool list only points at update_diagram', () => {
    expect(() => validateToolInput('preview_diagram', { diagramId: 'd', expectedRevision: 'f:1', ops: [{ op: 'update', id: 'a', set: { lable: 'x' } }] })).toThrow(/lable/);
    expect(() => validateToolInput('submit_proposal', { requestId: 'r', diagramId: 'd', expectedRevision: 'f:1', summary: 's', ops: [{ op: 'explode' }] })).toThrow();
    expect(() => validateToolInput('preview_diagram', { diagramId: 'd', expectedRevision: 'f:1', ops: [{ op: 'arrange' }] })).not.toThrow();
  });
});
