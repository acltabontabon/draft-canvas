import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha = /^[a-f0-9]{40}$/;
const rootDocs = new Set(['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md']);
// CHANGELOG.md is compiled into the editor. Unknown files (including code under docs/) require CI.
const isDocumentation = (path) => rootDocs.has(path)
  || /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path)
  || /^docs\/media\/.+\.(?:png|jpe?g|webp|gif|svg|mp4)$/.test(path);

// Keep native runners for changes that can affect the desktop app. Workflow/planner changes
// also exercise the integration; unknown comparison history conservatively enables both scopes.
const isDesktop = (path) => /^(?:src|src-tauri)\//.test(path)
  || /^(?:tests|e2e)\/desktop\//.test(path)
  || /^\.github\/workflows\//.test(path)
  || /^(?:package(?:-lock)?\.json|vite\.config\.ts|vitest[^/]*\.ts|tsconfig[^/]*\.json|index\.html|tray\.html)$/.test(path)
  || /^playwright\.desktop\.config\.ts$/.test(path)
  || /^scripts\/(?:check-desktop-version|build-sidecar|desktop-[^/]+|ci-plan|ci-reuse|verify-source)\.mjs$/.test(path)
  || /^tests\/ci-(?:plan|reuse)\.test\.ts$/.test(path);

try {
  const revision = process.env.SOURCE_REVISION;
  if (!sha.test(revision ?? '')) throw new Error('An exact source revision is required.');
  const lock = JSON.parse(git('show', `${revision}:package-lock.json`));
  const version = lock.packages['node_modules/@playwright/test'].version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Unsupported Playwright version.');

  let full = true;
  let desktop = true;
  // Reusable release verification and manual runs always perform all checks, even for docs tags.
  if (process.env.FORCE_FULL !== 'true') {
    try {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const before = process.env.GITHUB_EVENT_NAME === 'pull_request'
        ? event.pull_request.base.sha
        : process.env.GITHUB_EVENT_NAME === 'push' && event.ref === `refs/heads/${process.env.DEFAULT_BRANCH}`
          ? event.before : undefined;
      if (sha.test(before ?? '') && !/^0+$/.test(before)) {
        git('fetch', '--no-tags', '--depth=1', '--', 'origin', before);
        // Compare the actual tested merge revision with its base, including deleted/renamed paths.
        const paths = git('diff', '--no-renames', '--name-only', '-z', before, revision, '--')
          .split('\0').filter(Boolean);
        full = paths.length === 0 || !paths.every(isDocumentation);
        desktop = paths.length === 0 || paths.some(isDesktop);
      }
    } catch (error) {
      // Missing history or event metadata must never accidentally bypass app verification.
      console.warn(`Could not classify changes; running full CI: ${error.message}`);
    }
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\ndesktop=${desktop}\nplaywright-image=mcr.microsoft.com/playwright:v${version}-noble\n`);
  console.log(`CI scope: ${full ? 'all checks' : 'documentation checks'}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
