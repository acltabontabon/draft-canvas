# Desktop updates

How Draft Canvas Desktop updates itself, and the one-time setup a maintainer does before the first
release that can be updated from. For what a person sees, see [Draft Canvas Desktop](desktop.md#updates).

## How it works

```
launch ──15 s──▶ look ──(daily)──▶ look …
                   │
     read github.com/…/releases/download/desktop-updates/<channel>.json
                   │
         newer, and not a prerelease for a stable install?
             │                        │
            yes                       no ──▶ up to date
             ▼
   Available ── you: Download ──▶ Downloading ──▶ signature checked ──▶ Ready
                                                                          │
                     you: Update and restart ◀────────────────────────────┘
                                 │
       the quit conversation: anything unsaved is kept, a file with changes is asked about
                                 │  (Cancel keeps working; the update stays ready)
                                 ▼
                     replace the app · relaunch
```

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
| a prerelease (`-alpha.1`) | `alpha.json`  | the newest release of any kind: a newer alpha, or the release it led up to |
| a release                 | `stable.json` | newer releases only, never a prerelease                       |

## Versions

A release is the web app's version: tag `desktop-vX.Y.Z` where `X.Y.Z` is `package.json`'s. A prerelease
may lead it — `desktop-v1.10.0-alpha.1` while the web app is at 1.9.4 — since the desktop app's alphas come
before the version it ships in; its `X.Y.Z` can't be older than `package.json`'s. The release workflow builds
the app as the tag's version either way. Each prerelease needs a dated `## [X.Y.Z-alpha.N] - YYYY-MM-DD`
section in `src-tauri/CHANGELOG.md`, like a release.

## The three kinds of signing

1. **Update signing (Tauri / minisign)** — what this document is about: a keypair we generate. The
   private half signs every update package in CI; the public half is compiled into the app, which refuses
   any package that doesn't verify against it or wasn't signed for the version the manifest announces
   (`requireSignedVersion`).
2. **macOS code signing / notarization** — unchanged: ad-hoc signed, not notarized.
3. **Windows Authenticode** — unchanged: unsigned.

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

`desktop-release.yml`, on a `desktop-vX.Y.Z` tag:

1. **verify** — the tag, version and changelog agree; the signing secret exists; the key in
   `tauri.conf.json` is real, the endpoint is the channel template, and `requireSignedVersion` is on.
2. **build** — with `src-tauri/tauri.updater.conf.json`: the installers **and** the signed update
   packages (`Draft-Canvas_X.Y.Z_macOS_arm64.app.tar.gz` and the Windows installer, each with a `.sig`).
   Each signature is checked on the machine that made it, against the app's key and this version.
3. **publish** — `latest.json` is built from the signatures and verified against the packages
   themselves: every platform, every address this release's, every signature valid for the exact bytes.
   Only then does the release go public.
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
