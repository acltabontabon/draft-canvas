/**
 * `compose` is the agent's, so what it throws is written for an agent: ids, JSON pointers, "the
 * composed diagram would be altered on its next open". A flowchart pasted by a person reads none of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../src/agent/errors';

afterEach(() => {
  vi.doUnmock('../src/agent/compile');
  vi.resetModules();
});

async function importFailing(error: unknown) {
  vi.resetModules();
  vi.doMock('../src/agent/compile', () => ({
    compose: () => {
      throw error;
    },
  }));
  const { importMermaid } = await import('../src/import/mermaid');
  return importMermaid('flowchart LR\n A --> B\n', 'x');
}

const internal = /\/[a-z]+\/\d|\bn\d+\b|"n\d|composed diagram|next open|JSON|merge the labels|INTERNAL|ordinary relationship/;

describe('a layout failure on import', () => {
  it.each([
    ['an invalid request with a JSON pointer', new AgentError('UNSUPPORTED', '/relationships/1: an ordinary relationship already runs from "n1" to "n2"; merge the labels, or draw the reverse direction', { path: '/relationships/1' })],
    ['the composed file would change when reopened', new AgentError('INTERNAL', 'The composed diagram would be altered on its next open.', { details: { repairs: ['Removed 8 invalid grouping link(s).'] } })],
    ['the composed file did not read back', new AgentError('INTERNAL', 'The composed diagram did not read back.')],
    ['an unexpected error', new TypeError('Cannot read properties of undefined (reading "x")')],
    ['something thrown that is not an error', 'boom'],
  ])('says nothing internal when %s', async (_label, error) => {
    const result = await importFailing(error);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(internal);
    expect(result.error).toMatch(/^That flowchart couldn’t be turned into a diagram\./);
  });

  it('keeps the kind of failure: unreadable layouts and slow ones are said as what they are', async () => {
    const unreadable = await importFailing(new AgentError('LAYOUT_FAILED', 'The arranged diagram still has 3 readability problem(s) after 4 repair attempt(s).'));
    expect(unreadable).toEqual({ ok: false, error: expect.stringMatching(/couldn’t be arranged into a readable diagram/) });
    const slow = await importFailing(new AgentError('CANCELLED', 'The layout ran out of time.'));
    expect(slow).toEqual({ ok: false, error: expect.stringMatching(/took too long/) });
  });
});
