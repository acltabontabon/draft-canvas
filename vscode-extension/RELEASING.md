# Releasing Draft Canvas for VS Code

This repository ships two products, each on its own schedule:

| Tag | Releases | Version | Changelog | Workflow |
| --- | --- | --- | --- | --- |
| `vX.Y.Z` | Draft Canvas: GitHub Release, Pages, Docker and the desktop app | root `package.json` | `CHANGELOG.md` | `release.yml`, `pages.yml`, `desktop-release.yml` |
| `desktop-vX.Y.Z-alpha.N` | A desktop preview ahead of a `vX.Y.Z` release | the tag | `CHANGELOG.md` | `desktop-release.yml` |
| `extension-vX.Y.Z` | Draft Canvas for VS Code: GitHub Release with the VSIX, then a Marketplace upload by hand | `vscode-extension/package.json` | `vscode-extension/CHANGELOG.md` | `vscode-release.yml` |

Neither tag triggers the other lane, and the two versions never need to match. Don't use a
`vscode-v…` tag or any other tag starting with `v` for the extension.

## How the extension depends on the web app

The extension doesn't bundle Draft Canvas. It opens `https://acltabontabon.com/draft-canvas/?host=vscode`
in the editor tab, and the app's host mode (`src/host/`) takes it from there. So:

- Changes in `vscode-extension/` ship with an extension release alone.
- Changes to the editor itself, host mode included, reach VS Code users when the **web app** is
  released. No extension release is needed.
- Any change to the messages between them (`src/host/embeddedHost.ts` ↔ `vscode-extension/src/extension.ts`)
  must stay backward compatible, because the site and installed extensions update at different
  times. Add messages; don't change or remove existing ones.

The release workflow checks that the live site serves host mode before it packages anything.

## Releasing a new version

1. Merge the extension changes.
2. Bump `version` in `vscode-extension/package.json` (and its lockfile) with
   `cd vscode-extension && npm version 0.1.1 --no-git-tag-version`.
3. In `vscode-extension/CHANGELOG.md`, move `[Unreleased]` entries under `## [0.1.1] - YYYY-MM-DD`.
4. Commit and push to `main`, then wait for the **VS Code extension** workflow to pass.
5. Tag and push:

   ```bash
   git tag extension-v0.1.1
   git push origin extension-v0.1.1
   ```

6. **VS Code extension release** runs:
   1. **verify:** the tag matches `package.json`, the identity is `acltabontabon.draft-canvas`, the
      changelog has a dated section, and the live site supports host mode.
   2. **package:** compile, package the VSIX, check its files, size and `.draftcanvas` registration,
      then install it in a fresh VS Code and run the smoke suite.
   3. **github-release:** creates "Draft Canvas for VS Code 0.1.1", with notes from the extension
      changelog and the tested VSIX attached. It isn't marked Latest, which stays with the web app.
7. **Upload it to the Marketplace.** Download `draft-canvas-0.1.1.vsix` from that release (the run's
   summary links it). Then, at <https://marketplace.visualstudio.com/manage/publishers/acltabontabon>,
   open **Draft Canvas → ⋯ → Update** and upload it. It's listed once Marketplace verification
   finishes, usually within minutes.

Nothing is deployed to Pages or Docker, and the root changelog and version are untouched.

## If a release fails

- **Before the GitHub Release** (bad tag, failed check or smoke test): nothing was released. Fix it on
  `main`, then move the tag: `git tag -d extension-v0.1.1 && git push origin :refs/tags/extension-v0.1.1`,
  re-tag the fixed commit, and push.
- **Re-running a release:** re-run the failed jobs from the Actions run. If that version is already on
  the Marketplace, its GitHub Release attaches the package the Marketplace serves, not a rebuild.
- A version on the Marketplace is final. Never try to replace `0.1.1` with different bits; fix
  forward with `0.1.2`.

## Testing a package locally

```bash
cd vscode-extension
npm ci
npm run compile
npx vsce package
node scripts/check-vsix.mjs draft-canvas-0.1.1.vsix
node test/smoke/run.mjs draft-canvas-0.1.1.vsix   # downloads VS Code into .vscode-test/
code --install-extension draft-canvas-0.1.1.vsix  # or Extensions → … → Install from VSIX…
```

## Why the Marketplace upload is manual

Nothing in this repository or its GitHub settings holds Marketplace credentials: no PAT, no
secret, no publishing identity. That's deliberate, to keep a free side project free.

- **Personal Access Tokens aren't an option.** Publishing needs a global Azure DevOps PAT, and those
  stop working on 2026-12-01.
- **Automation would need an Entra directory.** Microsoft's supported unattended route is
  `vsce publish --azure-credential` after `azure/login`, signed in through GitHub OIDC as an Entra
  app registration trusted for this repo's release environment. The federation itself is on Entra's
  free tier. But the publisher's Microsoft account has no Entra directory, and Microsoft only creates
  one through an Azure account signup (a Free Trial subscription with card verification).
- **If that ever changes:** create the app registration and a federated credential for
  `repo:acltabontabon/draft-canvas:environment:<name>`, add the identity to the publisher as a
  **Contributor**, and add a publish job that runs `vsce verify-pat --azure-credential` then
  `vsce publish --packagePath <vsix> --azure-credential --skip-duplicate`.
