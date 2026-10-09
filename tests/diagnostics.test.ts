import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('local diagnostic reports', () => {
  it('excludes private data even when an error, operation or identifier contains it', async () => {
    const { logDiagnostic, diagnosticReport } = await import('../src/lib/diagnostics');
    vi.stubEnv('DEV', false);
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = '/Users/customer/secret-project/customer-password';
    const error = new Error(secret);
    error.name = secret;
    logDiagnostic(error, { operation: secret, documentId: secret, flowId: secret, nodeIds: [secret], edgeIds: [secret, secret] }, secret);
    const report = diagnosticReport();
    expect(report).not.toContain(secret);
    expect(JSON.parse(report).events[0]).toMatchObject({ operation: 'other', errorType: 'UnknownError', nodeCount: 1, edgeCount: 2 });
    expect(JSON.stringify(output.mock.calls)).not.toContain(secret);
    output.mockRestore();
    vi.unstubAllEnvs();
  });

  it('retains only the latest twenty failures and returns an independent snapshot', async () => {
    const { logDiagnostic, diagnosticReport } = await import('../src/lib/diagnostics');
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = diagnosticReport();
    for (let i = 0; i < 25; i++) logDiagnostic(new TypeError('not exported'), { operation: 'autosave', nodeIds: Array.from({ length: i }, () => 'private-id') });
    const events = JSON.parse(diagnosticReport()).events;
    expect(JSON.parse(before).events).toEqual([]);
    expect(events).toHaveLength(20);
    expect(events[0].nodeCount).toBe(5);
    expect(events[19].nodeCount).toBe(24);
    output.mockRestore();
  });
});
