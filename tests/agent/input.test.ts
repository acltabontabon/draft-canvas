import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/errors';
import { readCreate } from '../../src/agent/input';

function refusal(raw: unknown): AgentError {
  try {
    readCreate(raw);
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const problems = (error: AgentError) => (error.details?.problems as { code: string; path: string; message: string }[]) ?? [];

describe('reading a create_diagram request', () => {
  it('maps agent type words onto native types and kinds', () => {
    const spec = readCreate({
      title: 'T',
      nodes: [
        { id: 'a', type: 'api', label: 'A' },
        { id: 't', type: 'topic', label: 'T' },
        { id: 'p', type: 'person', label: 'P' },
        { id: 'x', type: 'external-system', label: 'X' },
        { id: 'r', type: 'redis', label: 'Cache' },
      ],
    });
    expect(spec.nodes.map((n) => n.shape)).toEqual([
      { type: 'service', serviceKind: 'api' },
      { type: 'queue', queueKind: 'topic' },
      { type: 'actor', actorKind: 'human' },
      { type: 'service', serviceKind: 'external' },
      { type: 'database', databaseKind: 'cache' },
    ]);
  });

  it('refuses an unknown type with suggestions, and reports every problem with its path at once', () => {
    const error = refusal({
      title: 'T',
      nodes: [
        { id: 'a', type: 'servce', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
      ],
      relationships: [{ id: 'e', from: 'b', to: 'missing' }],
    });
    expect(error.code).toBe('UNSUPPORTED_TYPE');
    const list = problems(error);
    expect(list[0]).toMatchObject({ path: '/nodes/0/type' });
    expect(list[0]?.message).toContain('"service"');
    expect(list.some((p) => p.code === 'INVALID_REFERENCE' && p.path === '/relationships/0/to')).toBe(true);
  });

  it('draws unknown types as the fallback only when asked to', () => {
    const spec = readCreate({ title: 'T', fallbackType: 'service', nodes: [{ id: 'a', type: 'mainframe', label: 'Mainframe' }] });
    expect(spec.nodes[0]?.shape.type).toBe('service');
  });

  it('refuses duplicate ids, self-loops, and a second same-direction relationship that is not a compensation', () => {
    const error = refusal({
      title: 'T',
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'a', type: 'service', label: 'Again' },
        { id: 'b', type: 'service', label: 'B' },
      ],
      relationships: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'a', to: 'b' },
        { id: 'e3', from: 'b', to: 'b' },
      ],
    });
    const codes = problems(error).map((p) => `${p.code} ${p.path}`);
    expect(codes).toContain('DUPLICATE_ID /nodes/1/id');
    expect(codes).toContain('UNSUPPORTED /relationships/1');
    expect(codes).toContain('UNSUPPORTED /relationships/2');
  });

  it('allows the reverse direction and a compensation twin', () => {
    const spec = readCreate({
      title: 'T',
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
      ],
      relationships: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'a' },
        { id: 'e3', from: 'a', to: 'b', semantic: 'compensates' },
      ],
    });
    expect(spec.relationships).toHaveLength(3);
  });

  it('refuses a containment cycle and a reference to a group that is not there', () => {
    const error = refusal({
      title: 'T',
      groups: [
        { id: 'g1', label: 'One', parent: 'g2' },
        { id: 'g2', label: 'Two', parent: 'g1' },
      ],
      nodes: [{ id: 'a', type: 'service', label: 'A', group: 'nope' }],
    });
    const codes = problems(error).map((p) => p.code);
    expect(codes).toContain('CONTAINMENT_CYCLE');
    expect(codes).toContain('INVALID_REFERENCE');
  });

  it('enforces text limits instead of truncating, and counts characters not bytes', () => {
    const long = 'x'.repeat(121);
    expect(problems(refusal({ title: 'T', nodes: [{ id: 'a', type: 'service', label: long }] }))[0]?.code).toBe('LIMIT_EXCEEDED');
    const unicode = '日本語のサービス名'.repeat(13); // 117 characters, well over 120 bytes
    expect(readCreate({ title: 'T', nodes: [{ id: 'a', type: 'service', label: unicode }] }).nodes[0]?.label).toBe(unicode);
  });

  it('refuses a flow that visits one relationship twice (a native flow visits each once)', () => {
    const error = refusal({
      title: 'T',
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
      ],
      relationships: [{ id: 'e', from: 'a', to: 'b' }],
      flows: [{ id: 'f', title: 'Loop', steps: ['e', 'e'] }],
    });
    expect(problems(error)[0]).toMatchObject({ code: 'UNSUPPORTED', path: '/flows/0/steps/1' });
  });

  it('only lets service-like elements and components hold an inside view, at most three deep', () => {
    expect(refusal({ title: 'T', nodes: [{ id: 'd', type: 'database', label: 'DB', inside: { nodes: [{ id: 'x', type: 'table', label: 'X' }] } }] }).code).toBe('UNSUPPORTED');
    const deep = (depth: number): Record<string, unknown> =>
      depth === 0 ? { id: `leaf`, type: 'component', label: 'Leaf' } : { id: `s${depth}`, type: 'service', label: `S${depth}`, inside: { nodes: [deep(depth - 1)] } };
    expect(() => readCreate({ title: 'T', nodes: [deep(3)] })).not.toThrow();
    expect(refusal({ title: 'T', nodes: [deep(4)] }).code).toBe('LIMIT_EXCEEDED');
  });

  it('knows a starter\'s ids (prefix + key) before the request\'s own relationships refer to them', () => {
    const spec = readCreate({
      title: 'T',
      starter: { id: 'event-driven', prefix: 'ed-' },
      nodes: [{ id: 'audit', type: 'worker', label: 'Audit' }],
      relationships: [{ id: 'x', from: 'ed-topic', to: 'audit' }],
    });
    expect(spec.relationships[0]).toMatchObject({ from: 'ed-topic', to: 'audit' });
  });
});
