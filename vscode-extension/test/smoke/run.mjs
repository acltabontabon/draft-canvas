// Smoke-tests a packaged VSIX in a real, freshly downloaded VS Code: installs it like a user would,
// then runs `suite.cjs` inside that VS Code against the fixture workspace.
//
//   node test/smoke/run.mjs draft-canvas-0.1.0.vsix
//
// On Linux CI this needs a display: `xvfb-run -a node test/smoke/run.mjs …`.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));
const vsix = process.argv[2] && resolve(process.argv[2]);
if (!vsix) {
  console.error('Usage: node test/smoke/run.mjs <path to .vsix>');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));

// Everything lives in a throwaway directory: no settings, extensions or backups from anywhere else.
const root = mkdtempSync(join(tmpdir(), 'draft-canvas-smoke-'));
const userDataDir = join(root, 'user-data');
const extensionsDir = join(root, 'extensions');
const workspace = join(root, 'workspace');
cpSync(join(here, 'workspace'), workspace, { recursive: true });

const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
const installed = spawnSync(
  cli,
  [...cliArgs, `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, '--install-extension', vsix],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
if (installed.status !== 0) {
  console.error('Installing the VSIX failed.');
  process.exit(1);
}

try {
  await runTests({
    vscodeExecutablePath,
    // VS Code needs a development extension to run tests from; this folder is an empty one, so the
    // extension under test is the installed VSIX, exactly as a user gets it.
    extensionDevelopmentPath: join(here, 'host'),
    extensionTestsPath: join(here, 'suite.cjs'),
    extensionTestsEnv: { DRAFT_CANVAS_EXPECTED_VERSION: version },
    launchArgs: [workspace, `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
  });
} catch (error) {
  console.error('Smoke test failed.', error);
  process.exit(1);
}
