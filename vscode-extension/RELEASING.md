# Releasing Draft Canvas for VS Code

This repository ships two products, each on its own schedule:

| Tag | Releases | Version | Changelog | Workflow |
| --- | --- | --- | --- | --- |
| `vX.Y.Z` | Draft Canvas web app: GitHub Release, Pages, Docker | root `package.json` | `CHANGELOG.md` | `release.yml`, `pages.yml` |
| `extension-vX.Y.Z` | Draft Canvas for VS Code: Marketplace, then a GitHub Release with the VSIX | `vscode-extension/package.json` | `vscode-extension/CHANGELOG.md` | `vscode-release.yml` |

Neither tag triggers the other lane, and the two versions never need to match. Don't use a `vscode-v…`
tag or any other tag starting with `v` for the extension: `v…` tags release the web app.

## Releasing a new version

1. Merge the extension changes to `main`.
2. Bump the version: `cd vscode-extension && npm version 0.1.4 --no-git-tag-version` (updates the lockfile too).
3. In `vscode-extension/CHANGELOG.md`, move the `[Unreleased]` entries under `## [0.1.4] - YYYY-MM-DD`.
4. Optional, before pushing: `node vscode-extension/scripts/check-release.mjs extension-v0.1.4 --marketplace`.
5. Commit, push to `main`, and wait for the **VS Code extension** workflow to pass.
6. Tag the commit on `main` and push the tag:

   ```bash
   git tag extension-v0.1.4
   git push origin extension-v0.1.4
   ```

That's all. **VS Code extension release** then runs:

1. **verify:** the run is from an `extension-vX.Y.Z` tag on `main`; the tag matches `package.json`; the
   identity, Marketplace metadata and dated changelog section are there; the live site serves host mode;
   and the version is newer than the Marketplace's newest (or already listed, see below).
2. **package:** compile, package the VSIX, check its files and size, install it in a fresh VS Code and
   run the smoke suite (`vscode-extension.yml`).
3. **publish:** in the `vscode-marketplace` environment, check that the `VSCE_PAT` token may publish as
   `acltabontabon`, publish that exact VSIX with `vsce publish`, and wait until the Marketplace lists it.
4. **github-release:** "Draft Canvas for VS Code 0.1.4", with notes from the extension changelog and
   the published VSIX attached. It isn't marked Latest, which stays with the web app.

Nothing is deployed to Pages or Docker, and the root changelog and version are untouched. Nothing is
published if any earlier step fails.

**Checking it worked:** the run's summary links both pages.
[The listing](https://marketplace.visualstudio.com/items?itemName=acltabontabon.draft-canvas) shows the
new version, and so does `npx --prefix vscode-extension vsce show acltabontabon.draft-canvas`.
VS Code picks the update up on its next extension check.

## Running a release by hand

**Actions → VS Code extension release → Run workflow**, then under **Use workflow from** pick the tag
(**Tags → extension-v0.1.4**), not a branch. A run from a branch stops at the first step. Use this to
retry a release; **Re-run failed jobs** on the original run works too.

A version already on the Marketplace is never published again. Re-running a release that did publish
skips **publish**, and the GitHub Release attaches the package the Marketplace serves.

## How the extension depends on the web app

The extension doesn't bundle Draft Canvas. It opens `https://acltabontabon.com/draft-canvas/?host=vscode`
in the editor tab, and the app's host mode (`src/host/`) takes it from there. So:

- Changes in `vscode-extension/` ship with an extension release alone.
- Changes to the editor itself, host mode included, reach VS Code users when the **web app** is
  released. No extension release is needed.
- Any change to the messages between them (`src/host/embeddedHost.ts` ↔ `vscode-extension/src/extension.ts`)
  must stay backward compatible, because the site and installed extensions update at different
  times. Add messages; don't change or remove existing ones. When an extension release relies on a
  new message, release the web app first.

## One-time setup

Publishing uses an Azure DevOps Personal Access Token (PAT), stored as a secret of one GitHub environment
that only extension release tags can deploy to.

> **This stops working on 2026-12-01.** Microsoft retires global PATs then, and Marketplace publishing
> needs a global one. Before that date, move to another method (see
> [Changing authentication](#changing-authentication)), or releases fail at **publish** and the VSIX
> from the run's `vsix` artifact has to be uploaded by hand again.

### 1. Create the token

Only a person can do this, signed in as a publisher owner (`me@acltabontabon.com`).

1. Open <https://dev.azure.com> and sign in with that account. If it asks you to create an organization
   first, create one (any name); the token isn't limited to it.
2. **User settings** (top right) **→ Personal access tokens → New Token.**
   - Name: `draft-canvas-vscode-marketplace`
   - Organization: **All accessible organizations** (a single organization gets 401 from the Marketplace)
   - Expiration: **Custom defined**, 2026-11-30
   - Scopes: **Custom defined → Show all scopes → Marketplace → Manage**, nothing else
3. **Create**, and copy the token. It's shown once.

### 2. Store it in GitHub

1. At <https://github.com/acltabontabon/draft-canvas/settings/environments>, open the `vscode-marketplace`
   environment (create it if it's missing). Under **Deployment branches and tags**, choose **Selected
   branches and tags** and allow only the **tag** rule `extension-v*`.
2. **Environment secrets → Add environment secret**: name `VSCE_PAT`, value the token.

   Or, from a terminal, so the token never lands in shell history:

   ```bash
   gh secret set VSCE_PAT --env vscode-marketplace --repo acltabontabon/draft-canvas
   ```

   It prompts for the value.
3. Leave **Required reviewers** off for one-step releases, or add yourself to approve every publication.

The token lives only in that environment, so only **publish** jobs on `extension-v*` tags can read it. It
is passed to the two `vsce` steps that need it and nowhere else; GitHub masks it in logs. The workflow
needs no other secrets or variables. `vscode-release.yml` asks for `contents: write` only in
**github-release**; everything else is `contents: read`.

### 3. Recommended: restrict who can create release tags

Anyone who can push an `extension-v*` tag can publish. At **Settings → Rules → Rulesets → New tag
ruleset**: target `extension-v*`, enable **Restrict creations**, **Restrict updates** and **Restrict
deletions**, and add **Repository admin** to the bypass list.

Then release as usual. The first release proves the setup.

## Testing a package locally, without publishing

```bash
cd vscode-extension
npm ci
node scripts/check-release.mjs extension-v0.1.4 --marketplace
npx vsce package --out draft-canvas-0.1.4.vsix
node scripts/check-vsix.mjs draft-canvas-0.1.4.vsix
node test/smoke/run.mjs draft-canvas-0.1.4.vsix   # downloads VS Code into .vscode-test/
code --install-extension draft-canvas-0.1.4.vsix  # or Extensions → … → Install from VSIX…
```

Nothing here can publish: publishing needs the token, which only the `vscode-marketplace` environment holds.

## Troubleshooting

### Authentication

| Where it fails | What it means | Fix |
| --- | --- | --- |
| **The Marketplace token is configured** | No `VSCE_PAT` secret in the `vscode-marketplace` environment. | Add it as an *environment* secret (step 2), not a repository secret. |
| Job waits or fails with "not allowed to deploy to vscode-marketplace" | The environment's tag rule doesn't allow this tag. | Add the `extension-v*` tag rule. |
| **The token can publish**: 401 | The token expired, was revoked, isn't for **All accessible organizations**, or (after 2026-12-01) global PATs are gone. | Create a new token (step 1) and replace the secret. After 2026-12-01, change authentication. |
| **The token can publish**: 403 | The token lacks **Marketplace (Manage)**, or its account isn't an owner or contributor of `acltabontabon`. | Recreate it with that scope, signed in as a publisher owner. |

### Marketplace publishing

- **verify says the version is older than the newest listed:** bump to a newer version and tag again.
- **vsce publish fails with a validation error** (manifest, README, icon): nothing was released. Fix it
  on `main`, bump the version, and tag again. You can instead move the tag to the fixed commit:
  `git tag -d extension-v0.1.4 && git push origin :refs/tags/extension-v0.1.4`, then re-tag and push.
- **"version already exists":** it was published meanwhile. Re-run the workflow; it skips publishing
  and creates the GitHub Release.
- **The listing wait ends with a warning:** the Marketplace accepted the package but is still verifying
  it. The manage page shows its status; the GitHub Release is still created.
- A version on the Marketplace is final. Never try to replace `0.1.4` with different bits; fix forward
  with `0.1.5`.

## Changing authentication

- **Revoke publishing now:** revoke the token at <https://dev.azure.com> (User settings → Personal access
  tokens), or delete the `VSCE_PAT` secret. Releases then fail at **publish**.
- **Rotate the token:** create a new one (step 1), replace the secret (step 2), revoke the old one.
- **Before 2026-12-01**, move off PATs. Only the **publish** job of `vscode-release.yml` knows how publishing
  authenticates, so either change stays there:
  - **Marketplace trusted publishing** (no secret, no Azure): `vsce publish --oidc` is in `vsce` pre-releases
    but not yet enabled on the Marketplace. Once it is: configure the trusted publishing policy for this
    repository and workflow on the Marketplace, upgrade `@vscode/vsce` in `vscode-extension/package.json`,
    give **publish** `id-token: write`, replace its token check, verify and publish steps with
    `npx vsce publish --oidc --packagePath "$VSIX"`, then delete the secret and revoke the token.
  - **Microsoft Entra ID** (works today, no stored secret, but needs an Entra directory, which for a personal
    Microsoft account means an Azure free account signup): an app registration with a GitHub federated
    credential for this environment, added to the publisher's Members as Contributor, then `azure/login` and
    `vsce publish --azure-credential`. See
    [Microsoft's guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace).
