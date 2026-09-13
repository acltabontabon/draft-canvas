// Checks a packaged VSIX before it goes anywhere: exactly the expected files, a sane size, the
// Marketplace identity, and the `.draftcanvas` editor registration.
//
//   node scripts/check-vsix.mjs draft-canvas-0.1.0.vsix
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const vsix = process.argv[2];
if (!vsix) {
  console.error('Usage: node scripts/check-vsix.mjs <path to .vsix>');
  process.exit(2);
}

const EXPECTED_FILES = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.txt',
  'extension/changelog.md',
  'extension/media/icon.png',
  'extension/out/extension.js',
  'extension/package.json',
  'extension/readme.md',
];
// The extension is a thin host around the hosted app, about 20 KB packed. Well past this means
// something got packaged by accident.
const MAX_BYTES = 100 * 1024;

const problems = [];
const files = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
const unexpected = files.filter((file) => !EXPECTED_FILES.includes(file));
const missing = EXPECTED_FILES.filter((file) => !files.includes(file));
if (unexpected.length) problems.push(`unexpected files: ${unexpected.join(', ')}`);
if (missing.length) problems.push(`missing files: ${missing.join(', ')}`);

const size = statSync(vsix).size;
if (size > MAX_BYTES) problems.push(`${size} bytes is over the ${MAX_BYTES}-byte limit`);

const manifest = JSON.parse(execFileSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' }));
if (manifest.publisher !== 'acltabontabon' || manifest.name !== 'draft-canvas') {
  problems.push(`identity is ${manifest.publisher}.${manifest.name}, not acltabontabon.draft-canvas`);
}
const editor = manifest.contributes?.customEditors?.find((entry) => entry.viewType === 'draftCanvas.editor');
if (!editor?.selector?.some((selector) => selector.filenamePattern === '*.draftcanvas')) {
  problems.push('the draftCanvas.editor custom editor for *.draftcanvas is not registered');
}
if (!manifest.contributes?.commands?.some((command) => command.command === 'draftCanvas.newDiagram')) {
  problems.push('the draftCanvas.newDiagram command is not contributed');
}

const changelog = execFileSync('unzip', ['-p', vsix, 'extension/changelog.md'], { encoding: 'utf8' });
if (!changelog.includes('Draft Canvas for VS Code')) problems.push("changelog.md isn't the extension's own changelog");

if (problems.length) {
  console.error(`${vsix} failed its checks:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
process.stdout.write(`${vsix}: ${files.length} files, ${size} bytes, ${manifest.publisher}.${manifest.name}@${manifest.version}, .draftcanvas editor registered.\n`);
