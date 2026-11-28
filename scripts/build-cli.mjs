// Builds the headless CLI into one file: `dist-cli/draftcanvas.mjs`, with everything it needs
// inside it. The same source the editor is built from, so there is one implementation of reading,
// checking and drawing a diagram.
import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';

mkdirSync('dist-cli', { recursive: true });
const result = await build({
  entryPoints: ['cli/bin.ts'],
  outfile: 'dist-cli/draftcanvas.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // A dependency built as CommonJS asks for Node's own modules with `require`, which an ES module
  // does not have until it is made.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  // Build-time constants the editor's modules read; the CLI is neither the desktop app nor a dev build.
  define: { __DESKTOP__: 'false', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"production"' },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
chmodSync('dist-cli/draftcanvas.mjs', 0o755);
const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`dist-cli/draftcanvas.mjs  ${(bytes / 1024).toFixed(0)} KB`);
