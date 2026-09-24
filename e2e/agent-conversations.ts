/**
 * Scripted agent conversations against a running Draft Canvas desktop app, through the real MCP
 * sidecar — the same five public tools an agent sees, over stdio, with no SDK in between.
 *
 * For each tool call it records what an agent pays for it (request and response bytes, latency) and
 * what it did (error codes, the diagram ids touched), plus how many `.draftcanvas` files the project
 * folder holds afterwards — so "one diagram, edited in place" is a count, not an impression.
 *
 *   npx tsx e2e/agent-conversations.ts --sidecar <path/to/draft-canvas-mcp> --agent-dir <app agent dir> \
 *     --project-dir <enabled folder> [--only <scenario>] [--out report.json]
 *
 * `--agent-dir` is the app's `agent` folder (it holds `agent.json`); a dev build with its own
 * identifier keeps its own, which is how this runs beside another Draft Canvas without touching it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

type Json = Record<string, unknown>;

export interface CallRecord {
  session: string;
  tool: string;
  ms: number;
  requestBytes: number;
  responseBytes: number;
  isError: boolean;
  code?: string;
  diagramId?: string;
  revision?: string;
  progress: string[];
}

/** A minimal MCP client over stdio: initialize, list tools, call tools, collect progress. */
export class McpSession {
  readonly records: CallRecord[] = [];
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Json) => void>();
  private readonly progress = new Map<string, string[]>();
  schemaBytes = 0;
  instructionsBytes = 0;
  readonly name: string;

  constructor(name: string, sidecar: string, agentDir: string) {
    this.name = name;
    this.child = spawn(sidecar, [], { env: { ...process.env, DRAFT_CANVAS_AGENT_DIR: agentDir } });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim();
        this.buffer = this.buffer.slice(at + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Json;
        if (message.method === 'notifications/progress') {
          const params = message.params as { progressToken: string; message?: string };
          this.progress.get(String(params.progressToken))?.push(params.message ?? '');
          continue;
        }
        const resolve = this.waiting.get(message.id as number);
        if (resolve) {
          this.waiting.delete(message.id as number);
          resolve(message);
        }
      }
    });
    this.child.stderr.on('data', () => {});
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-conversations', version: '1' },
    });
    const result = init.result as { instructions?: string };
    this.instructionsBytes = (result.instructions ?? '').length;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await this.request('tools/list', {});
    this.schemaBytes = JSON.stringify((tools.result as { tools: unknown[] }).tools).length;
  }

  /** One tool call. `args.requestId` is filled in for the two tools that need one, unless given. */
  async call(tool: string, args: Json = {}): Promise<{ ok: boolean; value: Json; record: CallRecord }> {
    const needsId = tool === 'create_diagram' || tool === 'update_diagram';
    const full = needsId && !args.requestId ? { requestId: randomUUID(), ...args } : args;
    const token = randomUUID();
    this.progress.set(token, []);
    const started = performance.now();
    const reply = await this.request('tools/call', { name: tool, arguments: full, _meta: { progressToken: token } });
    const ms = Math.round(performance.now() - started);
    const result = reply.result as { structuredContent?: Json; isError?: boolean } | undefined;
    const value = result?.structuredContent ?? { protocolError: reply.error };
    const isError = result?.isError === true || !result;
    const error = (value.error ?? {}) as { code?: string };
    const record: CallRecord = {
      session: this.name,
      tool,
      ms,
      requestBytes: JSON.stringify(full).length,
      responseBytes: JSON.stringify(value).length,
      isError,
      ...(error.code ? { code: error.code } : {}),
      ...(typeof value.diagramId === 'string' ? { diagramId: value.diagramId } : {}),
      ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
      progress: this.progress.get(token) ?? [],
    };
    this.progress.delete(token);
    this.records.push(record);
    return { ok: !isError, value, record };
  }

  stop(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

export function diagramFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.draftcanvas'));
}

export interface ScenarioContext {
  sidecar: string;
  agentDir: string;
  projectDir: string;
  session(name: string): Promise<McpSession>;
  /** Opens a file in the running app the way the OS does (a second launch forwards it), as a person would. */
  openInApp(file: string): Promise<void>;
  log(line: string, data?: unknown): void;
  expect(condition: unknown, what: string): void;
}

export type Scenario = (ctx: ScenarioContext) => Promise<void>;

async function main() {
  const sidecar = flag('sidecar');
  const agentDir = flag('agent-dir');
  const projectDir = flag('project-dir');
  if (!sidecar || !agentDir || !projectDir) throw new Error('--sidecar, --agent-dir and --project-dir are required');
  const only = flag('only');
  const out = flag('out');
  const { SCENARIOS } = await import('./agent-scenarios');
  const report: Json[] = [];
  let failed = 0;
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (only && !only.split(',').includes(name)) continue;
    const sessions: McpSession[] = [];
    const lines: unknown[] = [];
    const failures: string[] = [];
    const filesBefore = diagramFiles(projectDir).length;
    const started = performance.now();
    const ctx: ScenarioContext = {
      sidecar,
      agentDir,
      projectDir,
      session: async (label) => {
        const s = new McpSession(label, sidecar, agentDir);
        await s.start();
        sessions.push(s);
        return s;
      },
      openInApp: async (file) => {
        const app = flag('app');
        if (!app) throw new Error('--app (the desktop binary) is needed to open files in it');
        spawn(app, [join(projectDir, file)], { stdio: 'ignore', detached: true }).unref();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      },
      log: (line, data) => lines.push(data === undefined ? line : { [line]: data }),
      expect: (condition, what) => {
        if (!condition) failures.push(what);
      },
    };
    try {
      await scenario(ctx);
    } catch (error) {
      failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
    }
    const records = sessions.flatMap((s) => s.records);
    const entry = {
      scenario: name,
      passed: failures.length === 0,
      failures,
      ms: Math.round(performance.now() - started),
      calls: records.length,
      mutations: records.filter((r) => r.tool === 'create_diagram' || r.tool === 'update_diagram').length,
      errors: records.filter((r) => r.isError).map((r) => `${r.tool}:${r.code ?? '?'}`),
      requestBytes: records.reduce((sum, r) => sum + r.requestBytes, 0),
      responseBytes: records.reduce((sum, r) => sum + r.responseBytes, 0),
      schemaBytes: sessions[0]?.schemaBytes ?? 0,
      instructionsBytes: sessions[0]?.instructionsBytes ?? 0,
      filesAdded: diagramFiles(projectDir).length - filesBefore,
      records,
      log: lines,
    };
    for (const s of sessions) s.stop();
    if (!entry.passed) failed += 1;
    report.push(entry);
    process.stdout.write(`${entry.passed ? 'PASS' : 'FAIL'} ${name}: ${entry.calls} calls, ${entry.mutations} mutations, +${entry.filesAdded} files, ${entry.ms} ms${failures.length ? `\n  - ${failures.join('\n  - ')}` : ''}\n`);
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && join(process.argv[1]).endsWith('agent-conversations.ts')) void main();
