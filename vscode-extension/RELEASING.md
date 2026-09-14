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
3. **publish:** in the `vscode-marketplace` environment, sign in to Microsoft Entra ID with GitHub's
   OIDC token, check that the identity may publish as `acltabontabon`, publish that exact VSIX with
   `vsce publish --azure-credential`, and wait until the Marketplace lists it.
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

Publishing signs in as a Microsoft Entra app that trusts one GitHub environment in this repository.
No password, token or certificate is stored anywhere: each run exchanges GitHub's short-lived OIDC
token for a short-lived Entra token. Do these steps once, in order.

### 1. A Microsoft Entra directory

Needed only if your Microsoft account doesn't have one. At <https://entra.microsoft.com>, an account
without a directory sees a GUID under its name and can't register apps.

1. Sign up at <https://azure.microsoft.com/free> with your Microsoft account. It asks for phone and card
   verification. This creates a directory ("Default Directory").
2. Nothing here needs the Azure subscription: the app below lives in the directory, and the workflow signs
   in with `allow-no-subscriptions`. Don't create any Azure resources.

### 2. The app registration

At <https://entra.microsoft.com>, in that directory:

1. **Entra ID → App registrations → New registration.**
   - Name: `draft-canvas-vscode-publisher`
   - Supported account types: **Single tenant only**
   - Redirect URI: leave empty. Select **Register**.
2. On its **Overview**, copy **Application (client) ID** and **Directory (tenant) ID**. These are
   identifiers, not secrets.
3. **Certificates & secrets → Federated credentials → Add credential.**
   - Federated credential scenario: **GitHub Actions deploying Azure resources**
   - Organization: `acltabontabon`
   - Repository: `draft-canvas`
   - Entity type: **Environment**, GitHub environment name: `vscode-marketplace`
   - Name: `github-vscode-marketplace`
   - Check that **Subject identifier** reads `repo:acltabontabon/draft-canvas:environment:vscode-marketplace`,
     the issuer `https://token.actions.githubusercontent.com` and the audience `api://AzureADTokenExchange`.
     Select **Add**.
4. Don't add a client secret or certificate, and don't grant API permissions or roles. The app needs none.

### 3. The GitHub environment

At <https://github.com/acltabontabon/draft-canvas/settings/environments>:

1. **New environment** named `vscode-marketplace`.
2. **Deployment branches and tags → Selected branches and tags**, then add:
   - a **branch** rule `main` (for the identity helper below)
   - a **tag** rule `extension-v*` (for releases)
3. **Environment variables** (variables, not secrets, since neither is a credential):

   | Name | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | the Application (client) ID |
   | `AZURE_TENANT_ID` | the Directory (tenant) ID |

4. Leave **Required reviewers** off for one-step releases, or add yourself to approve every publication.

The workflows need no repository secrets. `vscode-release.yml` asks for `id-token: write` only in its
**publish** job, and `contents: write` only in **github-release**; everything else is `contents: read`.

### 4. Make the identity a publisher member

1. Merge the workflows to `main` if they aren't there yet.
2. Run **Actions → VS Code Marketplace identity → Run workflow** from `main`. Its summary shows a
   **Marketplace member ID** (a GUID). It signs in, prints that ID and publishes nothing.
3. At <https://marketplace.visualstudio.com/manage/publishers/acltabontabon>, open **Members → Add**,
   paste that ID, choose **Contributor**, and add it. Use this ID only; the client, tenant and object IDs
   aren't recognised there.

### 5. Recommended: restrict who can create release tags

Anyone who can push an `extension-v*` tag to `main` can publish. At **Settings → Rules → Rulesets →
New tag ruleset**: target `extension-v*`, enable **Restrict creations**, **Restrict updates** and
**Restrict deletions**, and add **Repository admin** to the bypass list.

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

Nothing here can publish: publishing needs the Entra sign-in that only the `vscode-marketplace`
environment gets.

## Troubleshooting

### Authentication

| Where it fails | What it means | Fix |
| --- | --- | --- |
| **The publishing identity is configured** | `AZURE_CLIENT_ID`/`AZURE_TENANT_ID` missing or not GUIDs. | Add them as *environment* variables of `vscode-marketplace` (step 3). |
| Job waits or fails with "not allowed to deploy to vscode-marketplace" | The environment's branch/tag rules don't allow this ref. | Add the `extension-v*` tag rule (and `main` for the helper). |
| **Sign in**: `AADSTS700213` / `AADSTS70021` "No matching federated identity record found for presented assertion subject …" | Entra doesn't trust the subject GitHub sent. The error prints it. | Make the federated credential's subject exactly `repo:acltabontabon/draft-canvas:environment:vscode-marketplace`. |
| **Sign in**: `AADSTS700016` application not found in the directory | Client ID or tenant ID is wrong, or from another directory. | Copy both again from the app's Overview. |
| **Sign in**: "No subscriptions found" | `allow-no-subscriptions` was removed. | Put it back. |
| **The identity can publish** fails (401/403). It says "Personal Access Token verification" even with Entra. | The identity isn't a member of `acltabontabon`, or isn't a Contributor. | Run the identity helper and add its ID as Contributor (step 4). |

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

## Changing or rotating authentication

- **Revoke publishing now:** delete the federated credential (or the app registration), or remove the
  member from the publisher's Members page. Releases then fail at sign-in or at the permission check.
- **Replace the identity:** register a new app (step 2), update the two environment variables, run the
  identity helper, add the new member ID and remove the old one.
- **If Microsoft changes the mechanism:** only the **publish** job of `vscode-release.yml` and the identity
  helper know how publishing authenticates. For example, the Marketplace's own trusted publishing
  (`vsce publish --oidc`) is in `vsce` pre-releases but not yet enabled on the Marketplace. Once it is:
  configure the policy for this repository on the Marketplace, upgrade `@vscode/vsce` in
  `vscode-extension/package.json`, replace the sign-in, permission-check and publish steps with
  `npx vsce publish --oidc --packagePath "$VSIX"`, delete the identity helper, the environment variables
  and the app registration, and remove the member from the publisher.
- Personal Access Tokens aren't an option: the global PATs that Marketplace publishing needs stop
  working on 2026-12-01.
