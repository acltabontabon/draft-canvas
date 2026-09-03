import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDiagnostic } from '../src/lib/diagnostics';
import { ErrorBoundary } from '../src/ui/common/ErrorBoundary';

function Bomb(): ReactNode {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children normally when nothing throws', () => {
    const { getByText } = render(
      <ErrorBoundary scope="test" message="Something went wrong." actions={[]}>
        <p>safe content</p>
      </ErrorBoundary>,
    );
    expect(getByText('safe content')).toBeTruthy();
  });

  it('renders the fallback message and actions instead of the crashed child', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getByText, queryByText } = render(
      <ErrorBoundary scope="test" message="Something went wrong." actions={[{ label: 'Retry', onClick: () => {} }]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(getByText('Something went wrong.')).toBeTruthy();
    expect(getByText('Retry')).toBeTruthy();
    expect(queryByText('boom')).toBeNull();
  });

  it("fires each action's onClick", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onClick = vi.fn();
    const { getByText } = render(
      <ErrorBoundary scope="test" message="Something went wrong." actions={[{ label: 'Reload', onClick }]}>
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(getByText('Reload'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('calls onError exactly once with the thrown error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary scope="test" message="Something went wrong." actions={[]} onError={onError}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [error] = onError.mock.calls[0] as [Error, string];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
  });
});

describe('logDiagnostic', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('logs the raw error and full context in development', () => {
    vi.stubEnv('DEV', true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    logDiagnostic(error, { operation: 'test-op', documentId: 'doc-1' }, 'component stack here');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toContain(error);
    expect(spy.mock.calls[0]).toContain('component stack here');
  });

  it('logs only ids and counts, never node/edge content, in production', () => {
    vi.stubEnv('DEV', false);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    logDiagnostic(error, {
      operation: 'test-op',
      documentId: 'doc-1',
      flowId: 'flow-1',
      nodeIds: ['secret node text n1', 'n2'],
      edgeIds: ['e1'],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [message, meta] = spy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('boom');
    expect(message).not.toContain('secret node text');
    expect(JSON.stringify(meta)).not.toContain('secret node text');
    expect(meta).toEqual({
      documentId: 'doc-1',
      flowId: 'flow-1',
      nodeCount: 2,
      edgeCount: 1,
      schemaVersion: expect.any(Number),
    });
  });
});
