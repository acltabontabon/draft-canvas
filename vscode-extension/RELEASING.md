# Releasing Draft Canvas for VS Code

This repository ships two products, each on its own schedule:

| Tag | Releases | Version | Changelog | Workflow |
| --- | --- | --- | --- | --- |
| `vX.Y.Z` | Draft Canvas web app: GitHub Release, Pages, Docker | root `package.json` | `CHANGELOG.md` | `release.yml`, `pages.yml` |
| `extension-vX.Y.Z` | Draft Canvas for VS Code: Marketplace, GitHub Release with the VSIX | `vscode-extension/package.json` | `vscode-extension/CHANGELOG.md` | `vscode-release.yml` |

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

The release workflow checks that the live site serves host mode before publishing.

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
   3. **publish:** the tested VSIX goes to the Marketplace via Microsoft Entra ID (OIDC, no stored
      secret), in the `vscode-marketplace` environment.
   4. **github-release:** creates "Draft Canvas for VS Code 0.1.1", with notes from the extension
      changelog and the VSIX attached. It isn't marked Latest, which stays with the web app.

Nothing is deployed to Pages or Docker, and the root changelog and version are untouched.

## If a release fails

- **Before publish** (bad tag, failed check or smoke test): nothing reached the Marketplace. Fix it
  on `main`, then move the tag: `git tag -d extension-v0.1.1 && git push origin :refs/tags/extension-v0.1.1`,
  re-tag the fixed commit, and push.
- **At or after publish:** re-run the failed jobs from the Actions run. Publishing uses
  `--skip-duplicate`, so a version that already made it is left alone, and the GitHub Release step
  just runs again.
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

## One-time setup for automated publishing

The publish job signs in as a Microsoft Entra identity that GitHub vouches for through OIDC.
Microsoft recommends this for Marketplace publishing, because global Azure DevOps PATs stop working on
2026-12-01.

1. **Create the identity.** In the [Azure portal](https://portal.azure.com), create a
   *user-assigned managed identity* (for example `draft-canvas-marketplace`). Note its **Client ID**
   and **Tenant ID**.
2. **Trust GitHub.** On that identity, open **Settings → Federated credentials → Add credential**
   and choose *GitHub Actions deploying Azure resources*. Enter organization `acltabontabon`,
   repository `draft-canvas`, entity type **Environment**, environment `vscode-marketplace`.
3. **Point the GitHub environment at it.** The `vscode-marketplace` environment already exists, and
   only `extension-v*` tags and `main` can deploy to it. Under **Settings → Environments →
   vscode-marketplace**, add the variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. Optionally add
   yourself as a required reviewer, so each publication waits for your approval.
4. **Let the identity publish.** The Marketplace only recognizes the identity's Azure DevOps profile
   ID. Run the **VS Code Marketplace identity** workflow once from the Actions tab; it prints that
   ID. At <https://marketplace.visualstudio.com/manage/publishers/acltabontabon>, open **Members →
   Add**, paste the ID and give it the **Contributor** role.
