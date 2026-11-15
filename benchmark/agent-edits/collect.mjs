import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { verify } from './verify.mjs';

// Recheck archived diagrams without paid model calls. Labels name samples; paths stay local.
// node benchmark/agent-edits/collect.mjs output.json before-direct=/tmp/baseline after-direct-a=/tmp/current
const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error('Supply output.json and sample-label=artifact-directory entries.');
const samples = [];
const runs = [];
for (const input of inputs) {
  const at = input.indexOf('=');
  if (at < 1) throw new Error('Each input must be sample-label=artifact-directory.');
  const sample = input.slice(0, at);
  const directory = input.slice(at + 1);
  const metadata = join(directory, 'run.json');
  if (existsSync(metadata)) runs.push({ sample, ...JSON.parse(readFileSync(metadata, 'utf8')) });
  for (const batch of readdirSync(directory).filter(name => name.startsWith('results-deferred-'))) {
    for (const name of readdirSync(join(directory, batch)).sort()) {
      const path = join(directory, batch, name);
      const read = file => JSON.parse(readFileSync(join(path, file), 'utf8'));
      try {
        const result = read('result.json');
        const before = read('before.draftcanvas');
        const candidate = read('candidate.draftcanvas');
        const checked = result.expected === 'clarification'
          ? { verified: Boolean(result.reply?.trim()) && !result.calls.some(call => ['update_diagram', 'submit_proposal'].includes(call.tool)), otherFieldsSame: isDeepStrictEqual(before, candidate) }
          : verify(before, candidate, result.task);
        const receipt = existsSync(join(path, 'receipt.jsonl')) ? readFileSync(join(path, 'receipt.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
        const failure = receipt.find(event => event.type === 'stopped' && event.reason?.kind === 'failed')?.reason.message;
        const completed = checked.verified && checked.otherFieldsSame && result.unchangedBeforeAccept !== false && !result.executionError;
        samples.push({ sample, client: result.client, model: result.model, prompt: result.task,
          ...(result.expected ? { expected: result.expected, reply: result.reply } : {}),
          turn: result.turn, priorTurns: result.priorTurns, input: result.usage?.input, cached: result.usage?.cached, cacheWrite: result.usage?.cacheWrite ?? 0, output: result.usage?.output,
          completed, ...checked, unchangedBeforeAccept: result.unchangedBeforeAccept,
          modelTools: result.modelTools, nativeTools: result.calls.map(call => ({ tool: call.tool, ok: call.ok })),
          planningSchemaBytes: result.planningSchemaBytes,
          promptSha256: createHash('sha256').update(readFileSync(join(path, 'prompt.txt'))).digest('hex'),
          ...(failure ? { failure } : {}),
          ...(result.executionError ? { executionError: result.executionError } : {}),
        });
      } catch (error) {
        samples.push({ sample, case: name, completed: false, artifactError: String(error) });
      }
    }
  }
}
writeFileSync(output, JSON.stringify({
  baseline: process.env.BENCH_BASELINE ?? 'ac13ee91e2ebb89037715c3071a02e1101cb25b1',
  fixture: 'tests/fixtures/agent/draft-canvas.request.json',
  prompts: 'benchmark/agent-edits/prompts.json',
  clients: Object.fromEntries(['codex', 'claude'].map(client => [client, execFileSync(client, ['--version'], { encoding: 'utf8' }).trim()])),
  effort: 'low',
  method: 'Fresh synthetic diagrams; run metadata identifies conversation strategy and turn count. Total reported input includes cached/cache-write tokens. No overhead subtracted. Serialized content is reverified with verify.mjs; review originals stay byte-identical. Failed attempts are retained, never counted as savings. Native broker/filesystem are mocked; native gates are separately tested.',
  runs,
  samples,
}, null, 2) + '\n');
console.log(`${samples.filter(sample => sample.completed).length}/${samples.length} samples completed and preserved unrelated content.`);
