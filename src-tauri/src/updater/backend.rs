//! The real backend (`tauri-plugin-updater`), the host that asks the page before the app is replaced,
//! and the timer that looks for updates.
//!
//! Everything here is glue that needs a packaged app, a signed release and a network to run. The parts
//! that decide anything — policy, the state machine, the conversation with the page — are tested
//! elsewhere; the parts that only *do* — download, verify, replace, relaunch — are the plugin's.

use super::{
    is_offered, Backend, BoxFuture, Host, Publish, Remote, Snapshot, UpdateError, Updater,
};
use crate::state::{AppState, HostEvent};
use crate::util::{lock, now_ms};
use semver::Version;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Error as PluginError, Update, UpdaterExt};
use tokio::sync::Notify;

/// Long enough after launch that starting Draft Canvas is never slower or noisier for it.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
/// Then about once a day, for as long as the app keeps running (it lives in the tray).
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// The manifest is a few hundred bytes; longer than this is a hung connection.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// What `tauri.conf.json` holds until a real key is put there. A build with it can't verify anything,
/// so it doesn't try: updates are reported as unavailable, not as a failure that looks like an attack.
const UNSET_PREFIX: &str = "UNSET";

#[derive(Default)]
struct Staged {
    /// What the last check found, kept so a failed download can be retried without another check.
    found: Option<Update>,
    /// The verified package, in memory only.
    package: Option<Vec<u8>>,
}

struct PluginBackend {
    app: AppHandle,
    staged: Mutex<Staged>,
}

impl PluginBackend {
    fn updater(&self) -> Result<tauri_plugin_updater::Updater, UpdateError> {
        let config = self.app.config().plugins.0.get("updater").ok_or_else(|| {
            UpdateError::Unavailable("Updates aren't set up in this build.".into())
        })?;
        let pubkey = config
            .get("pubkey")
            .and_then(|key| key.as_str())
            .unwrap_or_default()
            .trim();
        if pubkey.is_empty() || pubkey.starts_with(UNSET_PREFIX) {
            return Err(UpdateError::Unavailable(
                "This build has no update signing key, so it can't check for updates.".into(),
            ));
        }
        let channel = channel_for(&self.app.package_info().version);
        self.app
            .updater_builder()
            .endpoints(endpoints(config, channel)?)
            .map_err(|error| UpdateError::Unavailable(unavailable_reason(&error)))?
            .timeout(CHECK_TIMEOUT)
            .version_comparator(|current, remote| is_offered(&current, &remote.version))
            .build()
            // Not an installed copy (a development run has no bundle to replace), or a machine nothing
            // is published for.
            .map_err(|error| UpdateError::Unavailable(unavailable_reason(&error)))
    }
}

/// Which manifest an installation reads, from the version it is — there's no setting to get wrong. A
/// prerelease reads `alpha.json`, which carries the newest release of any kind, so an alpha moves on
/// to newer alphas and then to the release they led up to. Everything else reads `stable.json`, which
/// never carries a prerelease.
pub fn channel_for(version: &Version) -> &'static str {
    if version.pre.is_empty() {
        "stable"
    } else {
        "alpha"
    }
}

/// The endpoints from the plugin's own configuration with the channel filled in, read from where the
/// plugin reads them, so a test build can point elsewhere with an ordinary config overlay.
fn endpoints(config: &serde_json::Value, channel: &str) -> Result<Vec<tauri::Url>, UpdateError> {
    let urls: Vec<tauri::Url> = config
        .get("endpoints")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .filter_map(|template| tauri::Url::parse(&template.replace("{{channel}}", channel)).ok())
        .collect();
    if urls.is_empty() {
        return Err(UpdateError::Unavailable(
            "This build has nowhere to look for updates.".into(),
        ));
    }
    Ok(urls)
}

fn unavailable_reason(error: &PluginError) -> String {
    match error {
        PluginError::FailedToDetermineExtractPath => {
            "Updates are for an installed copy of Draft Canvas, and this one isn't installed."
                .into()
        }
        PluginError::UnsupportedArch | PluginError::UnsupportedOs => {
            "Updates aren't available for this kind of computer.".into()
        }
        other => format!("Updates aren't available: {other}"),
    }
}

/// Sorts the plugin's errors by what can be done about them.
fn classify(error: &PluginError) -> UpdateError {
    match error {
        PluginError::Reqwest(inner) if inner.is_timeout() => UpdateError::Timeout,
        PluginError::Reqwest(inner) if inner.is_connect() || inner.is_request() => {
            UpdateError::Offline
        }
        PluginError::Reqwest(inner) if inner.is_decode() => UpdateError::BadManifest,
        PluginError::Reqwest(_) | PluginError::Network(_) => UpdateError::Interrupted,
        PluginError::ReleaseNotFound => UpdateError::Other(
            "Draft Canvas couldn't find any update information. Nothing may have been published yet."
                .into(),
        ),
        PluginError::Serialization(_) | PluginError::Semver(_) | PluginError::Http(_) => {
            UpdateError::BadManifest
        }
        PluginError::TargetNotFound(_)
        | PluginError::TargetsNotFound(_)
        | PluginError::UnsupportedArch
        | PluginError::UnsupportedOs => UpdateError::NoPlatform,
        // Wrong, unreadable, absent, or made for another version than the manifest says: in every case
        // the package isn't to be trusted.
        PluginError::Minisign(_)
        | PluginError::Base64(_)
        | PluginError::SignatureUtf8(_)
        | PluginError::SignedVersionMismatch { .. }
        | PluginError::MissingSignedVersion => UpdateError::BadSignature,
        other => UpdateError::Other(other.to_string()),
    }
}

/// On macOS the plugin replaces the bundle in place, and when it can't it asks the system for an
/// administrator's password. Draft Canvas doesn't go looking for that: a copy it can't replace as an
/// ordinary user is one that's updated by hand.
#[cfg(target_os = "macos")]
fn can_replace_bundle() -> Result<(), UpdateError> {
    use std::os::unix::ffi::OsStrExt;
    let exe = std::env::current_exe().map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
    // …/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas
    let Some(folder) = exe.ancestors().nth(4) else {
        return Ok(());
    };
    let path = std::ffi::CString::new(folder.as_os_str().as_bytes())
        .map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
    // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
    if unsafe { libc::access(path.as_ptr(), libc::W_OK) } != 0 {
        return Err(UpdateError::InstallFailed(
            "It's in a folder this account can't change, and Draft Canvas doesn't ask for an \
             administrator's password to update itself. Download the new version and install it by hand."
                .into(),
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn can_replace_bundle() -> Result<(), UpdateError> {
    Ok(())
}

impl Backend for PluginBackend {
    fn check(&self) -> BoxFuture<'_, Result<Option<Remote>, UpdateError>> {
        Box::pin(async move {
            let updater = self.updater()?;
            let found = updater.check().await.map_err(|error| classify(&error))?;
            let mut staged = lock(&self.staged);
            // Whatever was downloaded belongs to the previous answer.
            staged.package = None;
            let Some(update) = found else {
                staged.found = None;
                return Ok(None);
            };
            let version = Version::parse(&update.version).map_err(|_| UpdateError::BadManifest)?;
            let remote = Remote {
                version,
                notes: update.body.clone(),
            };
            staged.found = Some(update);
            Ok(Some(remote))
        })
    }

    fn download<'a>(
        &'a self,
        progress: &'a (dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> BoxFuture<'a, Result<(), UpdateError>> {
        Box::pin(async move {
            let update = {
                let mut staged = lock(&self.staged);
                staged.package = None;
                staged.found.clone()
            }
            .ok_or_else(|| UpdateError::Other("There's no update to download.".into()))?;
            // The plugin checks the signature before it hands the bytes back, and returns an error
            // instead when they don't verify. There's no way from here to `package` that skips it.
            let bytes = update
                .download(|chunk, total| progress(chunk as u64, total), || {})
                .await
                .map_err(|error| classify(&error))?;
            lock(&self.staged).package = Some(bytes);
            Ok(())
        })
    }

    fn install(&self) -> BoxFuture<'_, Result<(), UpdateError>> {
        Box::pin(async move {
            let (update, package) = {
                let mut staged = lock(&self.staged);
                (staged.found.clone(), staged.package.take())
            };
            let (Some(update), Some(package)) = (update, package) else {
                return Err(UpdateError::InstallFailed(
                    "There's no verified download to install.".into(),
                ));
            };
            can_replace_bundle()?;
            // On Windows the plugin starts the installer and ends this process, so a successful call
            // never returns there. The page has already kept everything by now.
            match tauri::async_runtime::spawn_blocking(move || update.install(&package)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return Err(UpdateError::InstallFailed(error.to_string())),
                Err(error) => return Err(UpdateError::InstallFailed(error.to_string())),
            }
            #[cfg(not(windows))]
            {
                // The relaunched app would otherwise find this one's single-instance socket still open
                // and take itself for a second copy.
                tauri_plugin_single_instance::destroy(&self.app);
                self.app.restart()
            }
            #[cfg(windows)]
            Ok(())
        })
    }

    fn discard(&self) {
        lock(&self.staged).package = None;
    }
}

/// Before the app is replaced, the page is asked exactly what a quit asks it.
struct AppHost(AppHandle);

impl Host for AppHost {
    fn prepare(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let (gate, answer) = tokio::sync::oneshot::channel();
            if !crate::quit::request_update(&self.0, gate) {
                return Err("Draft Canvas is already closing.".into());
            }
            match answer.await {
                Ok(true) => Ok(()),
                _ => Err(
                    "You kept working, so Draft Canvas didn't restart. The update is ready whenever you are."
                        .into(),
                ),
            }
        })
    }

    fn resume(&self) {
        crate::quit::resume(&self.0);
    }
}

/// Every snapshot goes to the page as a host event.
struct PagePublisher(AppHandle);

impl Publish for PagePublisher {
    fn publish(&self, snapshot: &Snapshot) {
        self.0.state::<AppState>().events.emit(HostEvent::Update {
            snapshot: snapshot.clone(),
        });
    }
}

/// Wakes the daily check early, when the setting is turned on.
#[derive(Default)]
pub struct CheckWake(Notify);

impl CheckWake {
    pub fn wake(&self) {
        self.0.notify_waiters();
    }
}

/// Builds the updater, hands it to Tauri as managed state, and starts the background checks. Returns at
/// once: nothing here waits on the network.
pub fn start(app: &AppHandle) {
    let current = app.package_info().version.clone();
    let updater = Updater::new(
        Arc::new(PluginBackend {
            app: app.clone(),
            staged: Mutex::default(),
        }),
        Arc::new(AppHost(app.clone())),
        Arc::new(PagePublisher(app.clone())),
        current,
        now_ms,
    );
    let wake = Arc::new(CheckWake::default());
    app.manage(updater.clone());
    app.manage(Arc::clone(&wake));
    tauri::async_runtime::spawn(checks(app.clone(), updater, wake));
}

/// One look shortly after launch and one a day after that, each only if the setting is on when the
/// time comes. Looking is all it does: downloading and installing are always asked for.
async fn checks(app: AppHandle, updater: Updater, wake: Arc<CheckWake>) {
    tokio::time::sleep(FIRST_CHECK_DELAY).await;
    loop {
        let wanted = app.state::<AppState>().settings.get().auto_check_updates;
        if wanted && !updater.installing() {
            // Said to nobody on screen (Settings shows it), but kept where a bug report can find it.
            if let Some(failure) = updater.check(false).await.error {
                eprintln!("Draft Canvas: update check failed: {}", failure.message);
            }
        }
        let _ = tokio::time::timeout(CHECK_EVERY, wake.0.notified()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrong_or_unreadable_signature_is_never_anything_but_a_bad_signature() {
        for error in [
            PluginError::SignatureUtf8("not base64".into()),
            PluginError::MissingSignedVersion,
            PluginError::SignedVersionMismatch {
                signed: "1.9.4".into(),
                announced: "9.9.9".into(),
            },
        ] {
            assert_eq!(classify(&error), UpdateError::BadSignature, "{error}");
        }
        assert!(classify(&PluginError::MissingSignedVersion)
            .message()
            .contains("Nothing was installed"));
    }

    #[test]
    fn metadata_it_cannot_read_is_a_bad_manifest() {
        let broken = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(
            classify(&PluginError::Serialization(broken)),
            UpdateError::BadManifest
        );
    }

    #[test]
    fn a_manifest_with_nothing_for_this_machine_says_so() {
        assert_eq!(
            classify(&PluginError::TargetNotFound("darwin-aarch64".into())),
            UpdateError::NoPlatform
        );
    }

    #[test]
    fn the_channel_follows_the_installed_version() {
        assert_eq!(channel_for(&Version::parse("1.10.0").unwrap()), "stable");
        assert_eq!(
            channel_for(&Version::parse("1.10.0-alpha.1").unwrap()),
            "alpha"
        );
        assert_eq!(
            channel_for(&Version::parse("1.10.0+build.3").unwrap()),
            "stable"
        );
    }

    #[test]
    fn the_channel_is_filled_into_the_endpoint() {
        let config = serde_json::json!({ "endpoints": ["https://example.test/{{channel}}.json"] });
        assert_eq!(
            endpoints(&config, "alpha").unwrap()[0].as_str(),
            "https://example.test/alpha.json"
        );
        assert_eq!(
            endpoints(&config, "stable").unwrap()[0].as_str(),
            "https://example.test/stable.json"
        );
        for broken in [
            serde_json::json!({}),
            serde_json::json!({ "endpoints": [] }),
            serde_json::json!({ "endpoints": ["not a url"] }),
        ] {
            assert!(matches!(
                endpoints(&broken, "stable"),
                Err(UpdateError::Unavailable(_))
            ));
        }
    }

    #[test]
    fn the_shipped_endpoint_is_a_channel_template() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            endpoints(updater, "alpha").unwrap()[0].as_str(),
            "https://github.com/acltabontabon/draft-canvas/releases/download/desktop-updates/alpha.json"
        );
    }

    #[test]
    fn a_dropped_download_is_interrupted_not_a_verification_failure() {
        assert_eq!(
            classify(&PluginError::Network("connection reset".into())),
            UpdateError::Interrupted
        );
    }
}
