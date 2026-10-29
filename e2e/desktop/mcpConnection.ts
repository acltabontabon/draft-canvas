import { expect, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSession } from '../agent-conversations';
import type {} from './mockShell';

/** A real stdio MCP client and sidecar joined to the real browser editor. Only the OS broker/disk
 *  are faked here; native admission, journaling and access checks have their Rust integration tests. */
export async function connect(page: Page, handle: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-mcp-'));
  const endpoint = join(dir, 'bridge.sock');
  const token = 'test-only-token'.repeat(5);
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ v: 1, endpoint, token, pid: process.pid }), { mode: 0o600 });
  let nextId = 1000;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let session = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        if (frame.type === 'hello') {
          session = String(frame.session);
          socket.write(`${JSON.stringify({ type: 'welcome', bridge: 1, app: 'test' })}\n`);
        } else if (frame.type === 'call') {
          void (async () => {
            const tool = String(frame.tool);
            const args = frame.args as Record<string, unknown>;
            if (tool === 'get_proposal') {
              const value = await page.evaluate((id) => window.__shell.proposal(id), String(args.proposalId));
              socket.write(`${JSON.stringify({ type: 'result', id: frame.id, ok: true, value })}\n`);
              return;
            }
            const id = nextId++;
            await page.evaluate(({ id, tool, args, handle, session }) => window.__shell.emit({ type: 'agent-request', id, tool, args, context: tool === 'get_capabilities' ? {} : { handle, open: true, diagramId: 'd_mcp00000001', session } }), { id, tool, args, handle, session });
            await expect.poll(() => page.evaluate((id) => !!window.__shell.agentResponse(id), id)).toBe(true);
            const outcome = await page.evaluate((id) => window.__shell.agentResponse(id), id) as { ok: boolean; value?: Record<string, unknown>; error?: unknown };
            let value = outcome.value;
            if (tool === 'create_diagram' && outcome.ok) {
              // The real worker composes the file; only native disk persistence is mocked.
              handle = await page.evaluate(value => window.__shell.addFile(String(value.title), String(value.text)), value!);
              value = { ...(value!.receipt as Record<string, unknown>), diagramId: 'd_mcp00000001', revision: 'f:1' };
            }
            if (tool === 'submit_proposal' && outcome.ok) {
              const proposalId = `p_${id}`;
              await page.evaluate(({ value, proposalId }) => {
                window.__shell.addProposal({ ...value, proposalId, version: 1, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null, stale: false });
                window.__shell.emit({ type: 'agent-changed' });
              }, { value: value!, proposalId });
              value = { proposalId, diagramId: value!.diagramId, revision: value!.baseRevision, counts: value!.counts, status: 'pending' };
            }
            socket.write(`${JSON.stringify({ type: 'result', id: frame.id, ok: outcome.ok, ...(outcome.ok ? { value } : { error: outcome.error }) })}\n`);
          })().catch((error: unknown) => socket.destroy(error instanceof Error ? error : new Error(String(error))));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const client = new McpSession('browser-mcp', process.env.DRAFT_CANVAS_MCP_BINARY ?? join(process.cwd(), 'src-tauri/target/debug/draft-canvas-mcp'), dir);
  await client.start();
  return { client, file: () => page.evaluate((handle) => window.__shell.file(handle), handle), close: async () => {
    client.stop();
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  } };
}

