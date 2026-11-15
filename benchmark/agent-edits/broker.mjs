import { isDeepStrictEqual } from 'node:util';
import { expect } from '@playwright/test';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSession } from '../../e2e/agent-conversations.ts';


/** A real stdio MCP client and sidecar joined to the real browser editor. Only the OS broker/disk
 *  are faked here; native admission, journaling and access checks have their Rust integration tests. */
export async function connect(page, handle, sidecar) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-mcp-'));
  const endpoint = join(dir, 'bridge.sock');
  const token = 'test-only-token'.repeat(5);
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ v: 1, endpoint, token, pid: process.pid }), { mode: 0o600 });
  const calls = [];
  let authorized = null;
  const opened = Boolean(handle);
  let nextId = 1000;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let session = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (frame.type === 'hello') {
          if (frame.token !== token) { socket.destroy(); return; }
          session = String(frame.session);
          socket.write(`${JSON.stringify({ type: 'welcome', bridge: 1, app: 'test' })}\n`);
        } else if (frame.type === 'call') {
          void (async () => {
            const tool = String(frame.tool);
            const args = frame.args;
            if (['update_diagram','submit_proposal'].includes(tool) && (tool !== authorized?.tool || !isDeepStrictEqual(args, authorized?.args))) {
              socket.write(`${JSON.stringify({ type:'result',id:frame.id,ok:false,error:{code:'DEFERRED_EDIT',message:'Return the edit as your final structured response.'} })}\n`); return;
            }
            if (tool === 'get_proposal') {
              const value = await page.evaluate((id) => window.__shell.proposal(id), String(args.proposalId));
              socket.write(`${JSON.stringify({ type: 'result', id: frame.id, ok: true, value })}\n`);
              return;
            }
            const id = nextId++;
            const file = !opened && handle ? await page.evaluate((handle) => window.__shell.file(handle), handle) : undefined;
            const context = tool === 'get_capabilities' ? {} : { handle, open: opened, diagramId: 'd_mcp00000001', session,...(file ? {text:file.text,stamp:'v1:' + file.version} : {}) };
            await page.evaluate(({ id, tool, args, context }) => window.__shell.emit({ type: 'agent-request', id, tool, args, context }), { id, tool, args, context });
            await expect.poll(() => page.evaluate((id) => !!window.__shell.agentResponse(id), id)).toBe(true);
            const outcome = await page.evaluate((id) => window.__shell.agentResponse(id), id);
            let value = outcome.value;
            if (tool === 'create_diagram' && outcome.ok) {
              // The real worker composes the file; only native disk persistence is mocked.
              handle = await page.evaluate(value => window.__shell.addFile(String(value.title), String(value.text)), value);
              value = {...(value.receipt), diagramId: 'd_mcp00000001', revision: 'f:1' };
            }
            if (tool === 'submit_proposal' && outcome.ok) {
              const proposalId = `p_${id}`;
              await page.evaluate(({ value, proposalId }) => {
                window.__shell.addProposal({...value, proposalId, version: 1, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null, stale: false });
                window.__shell.emit({ type: 'agent-changed' });
              }, { value: value, proposalId });
              value = { proposalId, diagramId: value.diagramId, revision: value.baseRevision, counts: value.counts, status: 'pending' };
            }
            const result = outcome.ok ? value : outcome.error;
            const payload = result && typeof result === 'object' ? result : {};
            calls.push({ tool, args, proposalId: value?.proposalId, bytes: Buffer.byteLength(JSON.stringify(result ?? null)), images: typeof payload.data === 'string' && payload.mimeType === 'image/png' ? 1 : 0, ok: outcome.ok });
            socket.write(`${JSON.stringify({ type: 'result', id: frame.id, ok: outcome.ok,...(outcome.ok ? { value } : { error: outcome.error }) })}\n`);
          })().catch((error) => socket.destroy(error instanceof Error ? error : new Error(String(error))));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  const client = new McpSession('browser-mcp', sidecar, dir);
  await client.start();
  return { authorize: (tool, args) => { authorized = {tool,args:structuredClone(args)}; }, client, dir, calls, file: () => page.evaluate((handle) => window.__shell.file(handle), handle), close: async () => {
    client.stop();
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  } };
}
