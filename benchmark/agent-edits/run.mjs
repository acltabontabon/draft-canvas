import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, globSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { connect } from './broker.mjs';
import { verify } from './verify.mjs';

const root = resolve(process.env.BENCH_TREE ?? process.cwd());
const dir = process.env.BENCH_OUTPUT ? resolve(process.env.BENCH_OUTPUT) : mkdtempSync(join(tmpdir(), 'dc-agent-edits-'));
mkdirSync(join(dir, 'empty'), { recursive: true });
console.log('Benchmark artifacts:', dir);
process.env.DRAFT_CANVAS_RUN = '12345678-1234-1234-1234-123456789abc';
const repeat = process.env.BENCH_RUN ?? '1';
// Strip types without esbuild name helpers: Playwright serializes this callback into the page.
const shellSource = stripTypeScriptTypes(readFileSync(join(root, 'e2e/desktop/mockShell.ts'), 'utf8'));
const { installMockShell } = await import('data:text/javascript;base64,' + Buffer.from(shellSource).toString('base64'));
const { chooseWorkFile } = await import(join(root, 'e2e/desktop/explorer.ts'));
const title = 'Draft Canvas — verified architecture';
const id = 'd_mcp00000001';
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/agent/draft-canvas.request.json'), 'utf8'));
const actions = JSON.parse(readFileSync(new URL('./prompts.json', import.meta.url), 'utf8'));
const targets = Object.keys(actions);
const toolFeatures = readFileSync(join(root, 'src-tauri/src/companion/codex.rs'), 'utf8').split('const NOT_FOR_A_CANVAS')[1].split('];')[0];
const available = new Set(execFileSync('codex', ['features', 'list'], { encoding: 'utf8' }).split('\n').map(line => line.split(/\s+/)[0]));
const disable = [...toolFeatures.matchAll(/"([a-z0-9_]+)"/g), ['shell_tool','shell_tool']].map(m => m[1]).filter(s => available.has(s));
const variants = [{ name: 'current', tree: root, sidecar: process.env.BENCH_SIDECAR ?? join(root, 'src-tauri/target/debug/draft-canvas-mcp'), port: Number(process.env.BENCH_PORT ?? 5352) }];
const filter = process.argv[2] ?? '';
writeFileSync(join(dir, 'run.json'), JSON.stringify({
  startedAt: new Date().toISOString(), mode: process.env.BENCH_REVIEW ? 'review' : 'direct', repeat, filter,
  clients: Object.fromEntries(['codex', 'claude'].map(client => [client, execFileSync(client, ['--version'], { encoding: 'utf8' }).trim()])),
  source: Object.fromEntries(['src/agent/read.ts', 'src/agent/schema.ts', 'src-tauri/src/companion/mod.rs', 'src-tauri/src/companion/decision.rs', 'src-tauri/mcp/src/main.rs', 'tests/fixtures/agent/draft-canvas.request.json'].map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])),
}, null, 2));
// A dev-server reload discards the synthetic shell while a paid model call is in flight.
const servers = await Promise.all(variants.map(v => createServer({ root: v.tree, cacheDir: join(dir, 'cache-' + v.name), mode: 'desktop', server: {host: '127.0.0.1', port: v.port, strictPort:true, watch:null, fs:{allow:[v.tree, root, dir]}}, logLevel: 'error' })));
await Promise.all(servers.map(s => s.listen()));
const browser = await chromium.launch();
function measure(client, events) {
  if (client === 'codex') {
    const turns = events.filter(e => e.type === 'turn.completed').map(e => e.usage);
    const usage = turns.at(-1);
    if (!usage) return null;
    return { input: usage.input_tokens, cached: usage.cached_input_tokens, output: usage.output_tokens, reasoning: usage.reasoning_output_tokens };
  }
  const result = events.findLast(e => e.type === 'result');
  if (!result?.usage || result.is_error) return null;
  const u = result.usage;
  return { input: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, cached:u.cache_read_input_tokens, cacheWrite:u.cache_creation_input_tokens, output:u.output_tokens, reportedCost:result.total_cost_usd, model:Object.keys(result.modelUsage ?? {}).join(',') };
}
function modelCalls(client, events) {
  if (client !== 'codex') return events.flatMap(e => e.type === 'assistant' ? e.message.content.filter(c => c.type === 'tool_use' && c.name !== 'StructuredOutput').map(c => c.name) : []);
  // exec discovery can consume a whole inference yet be omitted from `codex exec --json`.
  // Read only this synthetic run's transcript, retaining tool names rather than personal context.
  const thread = events.find(e => e.type === 'thread.started')?.thread_id;
  if (!thread || !/^[a-f0-9-]+$/.test(thread)) throw new Error('Missing Codex thread for tool-call audit.');
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const paths = globSync(join(home, 'sessions', '*', '*', '*', `*${thread}.jsonl`));
  if (paths.length !== 1) throw new Error('Cannot audit this Codex transcript for hidden tool calls.');
  return readFileSync(paths[0], 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(e => e.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(e.payload.type)).map(e => e.payload.name);
}
async function run(client, task, v) {
  const name = [client, task, v.name].join('-');
  if (filter && !name.includes(filter)) return;
  const caseDir = join(dir, 'results-deferred-' + repeat, name);
  mkdirSync(caseDir, { recursive: true });
  const page = await browser.newPage();
  const started = Date.now();
  let connection;
  try {
    await installMockShell(page);
    await page.goto('http://127.0.0.1:' + v.port + '/');
    await page.getByRole('button', { name: 'New Quick Draft' }).waitFor({ timeout: 35000 });
    let handle = '';
    {
      handle = await page.evaluate(async ({ fixture, id, title }) => {
        const { compose } = await import('/src/agent/compile.ts');
        return window.__shell.addFile(title, compose(fixture, id).text);
      }, { fixture, id, title });
      await page.getByRole('button', { name: 'Open file…' }).click();
      await chooseWorkFile(page, title);
      await page.locator('.dc-editor').waitFor();
    }
    connection = await connect(page, handle, v.sidecar);
    const offered = (await connection.client.request('tools/list', {})).result.tools;
    const expectedTools = JSON.parse(readFileSync(join(root, 'src-tauri/mcp/planning-entry-tools.json'), 'utf8'));
    if (!isDeepStrictEqual(offered, expectedTools)) throw new Error('Sidecar tools do not match source: rebuild before benchmarking.');
    const pre = await connection.file();
    const capturedRevision = await page.evaluate(async () => (await import('/src/host/agentBridge.ts')).currentRevision());
    writeFileSync(join(caseDir, 'before.draftcanvas'), pre.text);
    const mcp = { command: v.sidecar, args: [], env: { DRAFT_CANVAS_AGENT_DIR: connection.dir, DRAFT_CANVAS_RUN: '12345678-1234-1234-1234-123456789abc' } };
    const contract = readFileSync(join(root, 'src-tauri/src/companion/decision.rs'), 'utf8');
    const schema = contract.match(/pub const SCHEMA: &str = r#"(.*?)"#;/s) [1];
    const common = JSON.parse(contract.match(/pub const INSTRUCTIONS: &str = (".*?");/s) [1]);
    const modeInstructions = JSON.parse(contract.match(process.env.BENCH_REVIEW ? /const REVIEW: &str = (".*?");/s : /const DIRECT: &str = (".*?");/s) [1]);
    const finalInstructions = modeInstructions + ' ' + common;
    const companion = readFileSync(join(root, 'src-tauri/src/companion/mod.rs'), 'utf8');
    const system = JSON.parse(companion.match(/pub const BRIEF: &str = (".*?");/s)[1].replace(/\\\r?\n\s*/g, ''));
    writeFileSync(join(caseDir,'reply.schema.json'), schema);
    writeFileSync(join(caseDir, 'instructions.md'), system);
    writeFileSync(join(caseDir, 'mcp.json'), JSON.stringify({mcpServers:{'draft-canvas':mcp}}));
    const args = client === 'codex' ? [
      'exec','--output-schema',join(caseDir,'reply.schema.json'),'--json','--skip-git-repo-check','--ignore-user-config','--ignore-rules',
      '-c','agents.enabled=false','-c','include_collaboration_mode_instructions=false','-c','tools.experimental_request_user_input.enabled=false','-c','skills.include_instructions=false','-c','skills.max_context_tokens=1','-c','features.code_mode={enabled=false,excluded_tool_namespaces=["functions"],direct_only_tool_namespaces=["mcp__draft-canvas","mcp__draft_canvas"]}','--sandbox','read-only','-m','gpt-6-luna','-c','model_reasoning_effort="low"',
      '-c','approval_policy="never"','-c','web_search="disabled"',
      ...disable.filter(name=>name!=='code_mode').flatMap(name=>['--disable',name]),
      ...(available.has('skip_host_skill_discovery') ? ['--enable','skip_host_skill_discovery'] : []),
      '-c', 'model_instructions_file=' + JSON.stringify(join(caseDir,'instructions.md')),
      '-c', `mcp_servers={"draft-canvas"={command=${JSON.stringify(mcp.command)},args=[],env={DRAFT_CANVAS_AGENT_DIR=${JSON.stringify(connection.dir)},DRAFT_CANVAS_RUN="12345678-1234-1234-1234-123456789abc"},required=true,tool_timeout_sec=45,default_tools_approval_mode="approve"}}`,
      '-'
    ] : [
      '-p','--json-schema',schema,'--output-format','stream-json','--verbose','--strict-mcp-config','--tools','',
      '--permission-prompts','none','--settings','{"disableAllHooks":true}','--setting-sources','',
      '--mcp-config',join(caseDir,'mcp.json'),'--allowedTools','mcp__draft-canvas__*',
      '--system-prompt-file',join(caseDir,'instructions.md'),'--no-session-persistence',
      '--model','sonnet','--effort','low','--max-budget-usd','1'
    ];
    const child = spawn(client, args, { cwd: join(dir,'empty'), env: {...process.env}, stdio:['pipe','pipe','pipe'] });
    let stdout='', stderr='';
    child.stdout.on('data', data=>stdout+=data);
    child.stderr.on('data', data=>stderr+=data);
    child.stdin.on('error', ()=>{});
    const userText = actions[task];
    const template = JSON.parse(companion.match(/("<draft-canvas-context>.*?"),\n/s)[1]);
    const changeContext = companion.split('let change = match request.mode {')[1].split('};')[0];
    const change = JSON.parse(changeContext.match(new RegExp('ApplyMode::' + (process.env.BENCH_REVIEW ? 'Proposal' : 'Direct') + ' =>\\s*(?:\\{\\s*)?("[^"\\n]*")'))[1]);
    const prompt = template.replace('{}', JSON.stringify(title)).replace('{}', JSON.stringify(id))
      .replace('{view}', 'the top level').replace('{selection}', 'nothing; the message is about the whole view')
      .replace('{change}', change).replace('{code}{unchanged}{snapshot}{waiting}', '').replace('{}', userText);
    writeFileSync(join(caseDir,'prompt.txt'), finalInstructions + '\n\n' + prompt);
    child.stdin.end(finalInstructions + '\n\n' + prompt);
    const timer = setTimeout(()=>child.kill('SIGTERM'), 180000);
    console.log(name, 'started');
    const exit = await new Promise((resolve, reject)=> { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    writeFileSync(join(caseDir,'events.jsonl'), stdout, {mode:0o600});
    writeFileSync(join(caseDir,'stderr.log'), stderr, {mode:0o600});
    const events = stdout.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const decision = client === 'codex'
      ? JSON.parse(events.findLast(e=>e.type==='item.completed'&&e.item.type==='agent_message')?.item.text ?? '{}')
      : events.findLast(e=>e.type==='result')?.structured_output;
    if (exit !== 0 || !decision) throw new Error('no successful final decision');
    let executionError;
    try {
      let planned = JSON.parse(decision.args);
      let tool = decision.tool;
      const isRename = tool === 'rename_element';
      const isIntent = tool === 'edit' || (planned.kind !== undefined && tool === (process.env.BENCH_REVIEW ? 'submit_proposal' : 'update_diagram'));
      if (isIntent) {
        const { view, revises, ...intent } = planned;
        planned = { intent, expectedRevision: capturedRevision, ...(view === undefined ? {} : { view }), ...(revises === undefined ? {} : { revises }) };
        if (process.env.BENCH_REVIEW) planned.summary = intent.kind + ': ' + [...(intent.target ?? intent.label ?? intent.from ?? '')].slice(0, 150).join('');
        tool = process.env.BENCH_REVIEW ? 'submit_proposal' : 'update_diagram';
      }
      if (isRename) {
        planned.rename={from:planned.from,to:planned.to};
        if (process.env.BENCH_REVIEW) planned.summary = 'Rename “' + [...planned.from].slice(0,150).join('') + '” to “' + [...planned.to].slice(0,150).join('') + '”';
        delete planned.from;delete planned.to;tool=process.env.BENCH_REVIEW ? 'submit_proposal' : 'update_diagram';
      }
      if (tool !== (process.env.BENCH_REVIEW ? 'submit_proposal' : 'update_diagram')) throw new Error('Unexpected final action: ' + tool);
      planned.diagramId=id;planned.requestId='deferred-benchmark-'+repeat;
      if (!isRename && (!isIntent || planned.intent.kind === 'add')) planned.view ??= {inside:[]};
      connection.authorize(tool, planned);
      const executor = spawn(v.sidecar, ['--apply-edit'], {env:{...process.env,DRAFT_CANVAS_AGENT_DIR:connection.dir,DRAFT_CANVAS_RUN:'12345678-1234-1234-1234-123456789abc'},stdio:['pipe','pipe','pipe']});
      let receipt='';executor.stdout.on('data',d=>receipt+=d);executor.stdin.end(JSON.stringify({tool,args:planned,text:decision.text}));
      await new Promise((resolve,reject)=>{executor.on('error',reject);executor.on('close',c=>c===0?resolve():reject(new Error('executor '+c)));});
      writeFileSync(join(caseDir,'receipt.jsonl'),receipt);
    } catch (error) { executionError = String(error); }
    const after = await connection.file();
    if (!after) throw new Error('Synthetic fixture disappeared before verification; inspect page reloads and receipt.jsonl.');
    const beforeDoc = JSON.parse(pre.text);
    let file = JSON.parse(after.text);
    let unchangedBeforeAccept = null;
    if (process.env.BENCH_REVIEW) {
      unchangedBeforeAccept = after.text === pre.text;
      const proposalId = connection.calls.findLast(c => c.tool === 'submit_proposal')?.proposalId;
      const proposal = await page.evaluate(id => window.__shell.proposal(id), proposalId);
      writeFileSync(join(caseDir,'proposal.json'),JSON.stringify(proposal ?? null,null,2));
      if (proposal?.status === 'pending') {
        file = await page.evaluate(async ({beforeDoc, proposal}) => {
          const {applyUpdate} = await import('/src/agent/patch.ts');
          return applyUpdate(beforeDoc,proposal.path,proposal.ops,proposal.layout ?? undefined,proposal.scope ?? undefined).file;
        }, {beforeDoc,proposal});
      }
    }
    writeFileSync(join(caseDir,'candidate.draftcanvas'),JSON.stringify(file));
    const { verified, otherFieldsSame } = verify(beforeDoc, file, task);
    if (after) writeFileSync(join(caseDir,'result.draftcanvas'), after.text);
    const init = events.find(e=>e.type==='system'&&e.subtype==='init');
    const calls = connection.calls;
    const modelTools = modelCalls(client, events);
    const result = {name, client, task, variant:v.name, exit, model:init?.model ?? (client==='codex'?'gpt-6-luna':null),
      usage:measure(client,events), calls, modelTools, unchangedBeforeAccept, verified:!!verified, otherFieldsSame, ms:Date.now()-started,
      planningSchemaBytes:Buffer.byteLength(JSON.stringify(JSON.parse(readFileSync(join(root,'src-tauri/mcp/planning-entry-tools.json'),'utf8')))),
      executionError,
      error:events.find(e=>e.type==='error'||e.type==='turn.failed')?.message ?? (exit ? stderr.trim().split('\n').at(-1) : undefined)};
    writeFileSync(join(caseDir,'result.json'), JSON.stringify(result,null,2));
    console.log(name, JSON.stringify({...result,calls:calls.map(c=>c.tool)}));
    if (!verified || !otherFieldsSame || unchangedBeforeAccept === false || executionError
      || (process.env.BENCH_MAX_INPUT && !(result.usage?.input < Number(process.env.BENCH_MAX_INPUT)))
      || (process.env.BENCH_NO_READS && modelTools.length !== 0)) process.exitCode = 1;
  } catch(error) {
    writeFileSync(join(caseDir,'harness-error.log'), String(error));
    console.error(name, String(error));
    process.exitCode = 1;
  } finally { await connection?.close(); await page.close(); }
}
try {
  // Fresh isolated diagram/conversation per case; never reuse user diagrams or conversation history.
  const jobs = targets.flatMap((task,i) => (i===1 ? [...variants].reverse() : variants).map(v=>({task,v})));
  await Promise.all(['codex','claude'].map(async client=>{
    for (const {task,v} of jobs) await run(client,task,v);
  }));
} finally { await browser.close(); await Promise.all(servers.map(s=>s.close())); }
