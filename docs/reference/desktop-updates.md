# Desktop updates

How Draft Canvas Desktop updates itself, and the one-time setup a maintainer does before the first
release that can be updated from. For what a person sees, see [Draft Canvas Desktop](../guides/desktop.md#updates).

## How it works

<!-- Drawn in Draft Canvas: ../media/reference/desktop-updates.json, rendered by e2e/og-diagram.ts. -->
![The updater inside Draft Canvas Desktop reads the channel manifest from the update feed on GitHub Releases, offers you a newer version, and when you choose Update and restart asks the quit conversation before replacing the app.](../media/reference/desktop-updates.png)

1. **Look.** 15 seconds after launch, then daily, the updater reads
   `github.com/…/releases/download/desktop-updates/<channel>.json`.
2. **Offer.** If it lists something newer — and, for a stable install, not a prerelease — the update
   is *Available*. Otherwise the app is up to date.
3. **Download.** *Download* fetches it and checks its signature; it is then *Ready*.
4. **Restart.** *Update and restart* starts the quit conversation: anything unsaved is kept, and a
   file with changes is asked about. *Cancel* keeps working, and the update stays ready.
5. **Replace.** The app is replaced and relaunched.

The rules behind it:

- **Looking is all it does on its own.** Downloading and installing are always asked for. Settings has
  *Check for updates automatically* (on by default) and *Check for updates*.
- **Everything is in Rust** (`src-tauri/src/updater/`). The page has no updater permission in its
  capability file; it calls five commands (`update_status`, `update_check`, `update_download`,
  `update_install`, `update_dismiss`) and draws the snapshot they return.
- **Nothing unsaved is lost to a restart.** Installing asks the page exactly what quitting asks it
  (`quit.rs`, `Purpose::Update`), and a quit that arrives while the app is being replaced waits.
- **A downloaded update lives in memory only.** After a restart it is found and downloaded again, so
  "ready" is never shown for a file nothing re-verified.
- **Who is offered what.** Only something newer, compared by semver precedence; nobody is ever
  downgraded. There's no channel setting: an install's channel follows from its own version.

| Installed                 | Reads         | Is offered                                                    |
| ------------------------- | ------------- | ------------------------------------------------------------- |
| a prerelease (`-alpha.1`, `-beta.2` — any suffix) | `alpha.json`  | the newest release of any kind: a newer alpha, or the release it led up to |
| a release                 | `stable.json` | newer releases only, never a prerelease                       |

Windows updates use the signed NSIS `.exe` directly, and macOS updates use `.app.tar.gz`. The
updater's optional legacy `zip` feature is disabled: neither format needs it, and it would pull in
vulnerable ZIP extraction code. Keep `rustls-tls` and `system-proxy` enabled.

## Versions

The desktop app ships in every Draft Canvas release: tag `vX.Y.Z`, where `X.Y.Z` is `package.json`'s — one
version for the web app and desktop, one GitHub release. A desktop preview ahead of a release is tagged
`desktop-vX.Y.Z-alpha.N`, and may lead `package.json` — `desktop-v1.10.0-alpha.1` while the web app is at 1.9.4
— though its `X.Y.Z` can't be older. The release workflow builds the app as the tag's version either way. Every
version needs a dated `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md`, previews included.

## The three kinds of signing

1. **Update signing (Tauri / minisign)** — what this document is about: a keypair we generate. The
   private half signs every update package in CI; the public half is compiled into the app, which refuses
   any package that doesn't verify against it or wasn't signed for the version the manifest announces
   (`requireSignedVersion`).
2. **macOS code signing / notarization** — ad-hoc signed and not notarized today. The release workflow
   is ready for the real thing: with the secrets below in place, `desktop-release.yml`'s "Prepare OS
   signing" step names the identity to the bundler and `tauri-action` imports the certificate and
   notarizes. Needed (an Apple Developer Program membership, paid): `APPLE_CERTIFICATE` (a Developer ID
   Application certificate exported as base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY` (`Developer ID Application: Name (TEAMID)`), and for notarization
   `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.
3. **Windows Authenticode** — unsigned today. With `WINDOWS_CERTIFICATE` (a code-signing certificate as
   base64 `.pfx`) and `WINDOWS_CERTIFICATE_PASSWORD` set, the same step imports it on the runner and
   the bundler signs the installer by thumbprint (SHA-256, DigiCert timestamp). An OV or EV certificate
   is bought from a CA; SmartScreen reputation still builds up over time.

Neither is configured. Nothing in the workflow disables a check when the secrets are missing: the
build is then exactly what it always was. Once either set exists, the sentence in
`scripts/release-notes.mjs` and the README that says installers are unsigned has to change with it.

Because the app downloads the package itself, an update doesn't meet the Gatekeeper or SmartScreen
prompt a first manual install does. That is how the file arrives, not something bypassed.

## Setting it up (once)

**1. Generate the keypair.**

```bash
npx tauri signer generate -w ~/.tauri/draft-canvas-updater.key
```

Choose a password. This writes the private key and `draft-canvas-updater.key.pub`.

**2. Back both up** — the private key file *and* its password, somewhere offline and durable. Lose
either and no future release can be signed with this key; because the public key is compiled into
every installed copy, **no installed copy would ever accept an update signed with another one**, and
everyone would have to reinstall by hand. Never commit it or paste it anywhere public.

**3. Put the public key in the app.** Paste the contents of `draft-canvas-updater.key.pub` into
`src-tauri/tauri.conf.json` as `plugins.updater.pubkey`, replacing the `UNSET: …` placeholder, and
commit it. Until then, builds say updates are unavailable, and the release workflow refuses to run.

**4. Give CI the private key.** Repository → *Settings → Secrets and variables → Actions*:

| Secret                               | Value                              |
| ------------------------------------ | ---------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | the contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1           |

`node scripts/update-manifest.mjs check-config` says whether the checkout is ready.

## What a release does

`desktop-release.yml` — called by `release.yml` for a `vX.Y.Z` release, after it has created the release,
or run by a `desktop-vX.Y.Z-alpha.N` tag, which makes its own prerelease:

1. **verify** — the tag, version and changelog agree; the signing secret exists; the key in
   `tauri.conf.json` is real, the endpoint is the channel template, and `requireSignedVersion` is on.
2. **build** — with `src-tauri/tauri.updater.conf.json`: the installers **and** the signed update
   packages (`Draft-Canvas_X.Y.Z_macOS_arm64.app.tar.gz`, its `_macOS_x64` twin, and the Windows
   installer, each with a `.sig`).
   Each signature is checked on the machine that made it, against the app's key and this version.
3. **publish** — `latest.json` is built from the signatures and verified against the packages
   themselves: every platform, every address this release's, every signature valid for the exact bytes.
   Only then is it uploaded (and a preview's draft made public).
4. **channels** (`desktop-update-pointer.yml`) — downloads `latest.json` and every package from the
   public addresses installed copies will use, verifies them again, and only then copies it to the rolling
   `desktop-updates` release as `stable.json` and `alpha.json` (a release) or `alpha.json` only (a
   prerelease) — and only where it's newer than what's there.

### If the channels job fails

The release is out and its installers work, but nobody is offered it yet. Fix the cause and run
**Actions → Desktop update channels → Run workflow** with the tag. No rebuild.

### Withdrawing a bad release

Run **Desktop update channels** with an older tag and *force*. Further checks then see that release. It
doesn't downgrade anyone already on the bad one — nothing is ever downgraded — so the real fix is a
newer release.

## Testing an update locally

With a throwaway key and a local server; nothing is published.

1. `npx tauri signer generate --ci -p "" -w /tmp/dc-e2e.key`
2. An overlay config outside the repository, `e2e.conf.json`, with `"version"` set to an old version,
   `plugins.updater.pubkey` the throwaway public key, `endpoints` `["http://127.0.0.1:8787/{{channel}}.json"]`,
   `dangerousInsecureTransportProtocol: true`, and `bundle.createUpdaterArtifacts: true`. Use another
   `identifier` and `productName` so it can't touch a real install.
3. Build it (`TAURI_SIGNING_PRIVATE_KEY=/tmp/dc-e2e.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD= npx tauri
   build --bundles app --config e2e.conf.json`), copy the `.app` to a writable folder, then build again
   with a newer `"version"`.
4. Put the newer build's `.app.tar.gz` and `.sig` in a folder under the release names (copy the `.sig`
   under the Windows name too — the builder wants every platform), then
   `node scripts/update-manifest.mjs build <newer> <folder> --base-url http://127.0.0.1:8787 > <folder>/stable.json`
   (name it `alpha.json` when the older build is a prerelease)
   and `python3 -m http.server 8787 --bind 127.0.0.1 --directory <folder>`.
5. Open the older copy. About 15 seconds later the chip says *Update available*; Download, then
   *Update and restart*, and it reopens as the newer version.

## Homebrew releases

The Release orchestrator calls `.github/workflows/homebrew.yml` after stable desktop publication.
Drafts and prereleases do not update the cask. Pages and updater channels run independently;
a Homebrew failure does not retract a release.

The job verifies both published DMGs against `SHA256SUMS.txt`, runs Homebrew style and audit
checks, then updates only `Casks/draft-canvas.rb` in
[the shared tap](https://github.com/acltabontabon/homebrew-tap). Other casks are untouched.
Older versions are refused, concurrent pushes are retried, and identical output creates no commit.

### Credentials

1. Create a dedicated Ed25519 deploy key for Draft Canvas.
2. Add its public key to `acltabontabon/homebrew-tap` as a write-enabled deploy key.
3. Save its private key as the `HOMEBREW_TAP_DEPLOY_KEY` Actions secret on
   `acltabontabon/draft-canvas`. Pass it only to the Homebrew reusable workflow.

The normal `GITHUB_TOKEN` cannot push to the tap. Missing credentials fail the workflow.
Never commit private keys or secret values.

### Retry and recovery

Run **Actions → Homebrew** with the published stable tag, including after a manual desktop rebuild.
The workflow uses its current source and can refresh same-version installer checksums.
It preserves newer casks and skips releases older than the latest published stable version.

Fix verification or audit failures before retrying. Do not bypass checksum or Gatekeeper checks.
Withdrawals and intentional rollbacks need a reviewed tap correction; they do not downgrade
installed copies. See [release recovery](reliability.md#withdrawal-and-recovery-procedure).
