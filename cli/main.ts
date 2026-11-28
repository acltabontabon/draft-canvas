/**
 * `draftcanvas`: the headless side of Draft Canvas. It reads `.draftcanvas` files with the same
 * code the editor does (the same migrations, validation, model and renderer), prints what it
 * finds, and never changes a diagram. It has no network code and runs no other program.
 */

import pkg from '../package.json' with { type: 'json' };
import { StaticTextMeasurer, setMeasurer } from '../src/render/text/measure';
import { EXIT, run, type Args } from './commands';

const HELP = `draftcanvas ${pkg.version}

Usage
  draftcanvas inspect <diagram> [--json]
      What the diagram describes: its parts, boundaries and relations, every view.
  draftcanvas check <diagram> [--repo <folder>] [--fail-on error|warning|info|never] [--json]
      What the diagram itself says is unfinished, and, with --repo, whether the evidence it
      cites is still where it says. Reads only; exits 1 when findings reach --fail-on (error).
  draftcanvas impact <diagram> <part> [--json]
      What a change to one part touches: what it reaches and is reached by, what it shares and
      crosses, which flows run over it, and what the drawing says fails if it stops.
  draftcanvas diff <before> <after> [--json]
      What changed between two versions, in the diagram's own terms.
  draftcanvas render <diagram> [--output <file.svg>] [--theme light|dark] [--view <ids>] [--transparent]
      The diagram as SVG. The same bytes on every machine.

Exit codes
  0 done   1 findings at or above --fail-on   2 wrong input   3 could not finish
`;

/** Options that take the next argument as their value. */
const VALUED = new Set(['repo', 'fail-on', 'output', 'theme', 'view']);
const SHORT: Record<string, string> = { o: 'output', h: 'help', v: 'version' };

export function parseArgs(argv: readonly string[]): { command?: string; args: Args; error?: string } {
  const args: Args = { positional: [], flags: {} };
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      args.positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const [raw, inline] = arg.replace(/^--?/, '').split(/=(.*)/s, 2) as [string, string | undefined];
      const name = arg.startsWith('--') ? raw : (SHORT[raw] ?? raw);
      if (VALUED.has(name)) {
        const value = inline ?? argv[++index];
        if (value === undefined) return { command, args, error: `--${name} needs a value.` };
        args.flags[name] = value;
      } else {
        args.flags[name] = true;
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      args.positional.push(arg);
    }
  }
  return { command, args };
}

export async function main(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { command, args, error } = parseArgs(argv);
  if (error) return { code: EXIT.usage, stdout: '', stderr: `${error}\n` };
  if (args.flags.version) return { code: EXIT.ok, stdout: `${pkg.version}\n`, stderr: '' };
  if (!command || args.flags.help || command === 'help') return { code: command || args.flags.help ? EXIT.ok : EXIT.usage, stdout: HELP, stderr: '' };
  // No browser here, so text is measured from a fixed table: the same widths on every machine.
  setMeasurer(new StaticTextMeasurer());
  return run(command, args, pkg.version);
}
