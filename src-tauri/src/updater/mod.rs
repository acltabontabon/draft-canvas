//! Updating Draft Canvas from inside Draft Canvas.
//!
//! Three things are kept apart on purpose:
//!
//! * **What the updater plugin does** — fetch the manifest, download a package, verify its signature,
//!   replace the application — sits behind [`Backend`]. Nothing else touches the plugin, and the page
//!   is given no permission to.
//! * **Whether it is safe to replace the application now** sits behind [`Host`], and is answered by
//!   the same conversation a quit has with the page (`quit.rs`): anything unsaved is kept first, and a
//!   file with changes is asked about, exactly as quitting would. Choosing to keep working leaves the
//!   update ready for later.
//! * **What state an update is in, and which transitions are allowed** is [`Updater`], a small state
//!   machine that is the only thing the page talks to. It is Tauri-free, so all of it is tested here
//!   against a mock backend and a mock host.
//!
//! A failure is not a state: it is a note ([`Failure`]) beside the state the updater fell back to, so a
//! failed download leaves the update available and one click from being tried again, and a failed check
//! leaves whatever was known before.
//!
//! A downloaded package is kept in memory only. After a restart the update is found and downloaded
//! again, so "ready to install" is never shown for a file nothing has re-verified.

mod backend;

use crate::util::lock;
use semver::Version;
use serde::Serialize;
use std::cmp::Ordering;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub use backend::{start, CheckWake};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Whether `remote` is offered to an installation running `current`: only something newer, by semver
/// precedence (never as text), and never a prerelease to an installation that isn't one. Applied
/// inside the plugin's check and again on whatever it returns, so neither side alone can widen it.
pub fn is_offered(current: &Version, remote: &Version) -> bool {
    if current.pre.is_empty() && !remote.pre.is_empty() {
        return false;
    }
    remote.cmp_precedence(current) == Ordering::Greater
}

/// What a release is, as far as the page needs to say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// The release's section of the changelog.
    pub notes: Option<String>,
}

/// What the backend found.
#[derive(Debug, Clone)]
pub struct Remote {
    pub version: Version,
    pub notes: Option<String>,
}

impl Remote {
    fn info(&self) -> UpdateInfo {
        UpdateInfo {
            version: self.version.to_string(),
            notes: self.notes.clone().filter(|notes| !notes.trim().is_empty()),
        }
    }
}

/// Everything that can go wrong at the plugin's boundary, sorted by what a person can do about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    Offline,
    Timeout,
    /// An answer that is not a manifest Draft Canvas understands.
    BadManifest,
    /// A manifest with nothing for this operating system and architecture.
    NoPlatform,
    /// The download did not verify against the public key compiled into the app.
    BadSignature,
    Interrupted,
    InstallFailed(String),
    /// Updates can't work for this copy at all: not installed, or no signing key in this build.
    Unavailable(String),
    Other(String),
}

impl UpdateError {
    /// What to tell the person: what happened, and what didn't.
    pub fn message(&self) -> String {
        match self {
            UpdateError::Offline => {
                "Draft Canvas couldn't reach the update server. Check the connection and try again."
                    .into()
            }
            UpdateError::Timeout => "The update server took too long to answer.".into(),
            UpdateError::BadManifest => {
                "The update information wasn't something Draft Canvas could read, so it did nothing."
                    .into()
            }
            UpdateError::NoPlatform => {
                "No update has been published for this kind of computer yet.".into()
            }
            UpdateError::BadSignature => {
                "The download didn't pass Draft Canvas's signature check, so it was thrown away. \
                 Nothing was installed."
                    .into()
            }
            UpdateError::Interrupted => {
                "The download stopped partway. Nothing was installed, and it can be tried again."
                    .into()
            }
            UpdateError::InstallFailed(why) => format!(
                "The update couldn't be installed, and Draft Canvas is still running. {why}"
            )
            .trim()
            .to_string(),
            UpdateError::Unavailable(why) | UpdateError::Other(why) => why.clone(),
        }
    }
}

/// The updater plugin, as far as the state machine cares. Stateful on the far side: the real one keeps
/// what `check` found and the bytes `download` verified, so an unverified package can't reach `install`.
pub trait Backend: Send + Sync {
    /// `Ok(None)` is "nothing newer", which is not an error.
    fn check(&self) -> BoxFuture<'_, Result<Option<Remote>, UpdateError>>;
    /// Download what `check` found and verify it. `progress` gets each chunk's size and, when the server
    /// said, the total.
    fn download<'a>(
        &'a self,
        progress: &'a (dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> BoxFuture<'a, Result<(), UpdateError>>;
    /// Replace the application with the verified package and relaunch. On success it doesn't return.
    fn install(&self) -> BoxFuture<'_, Result<(), UpdateError>>;
    /// Forget a downloaded package.
    fn discard(&self);
}

/// The app, from the updater's side.
pub trait Host: Send + Sync {
    /// Put everything somewhere safe before the app is replaced — the quit conversation, with the
    /// same questions. `Err` (in words for a person) when they chose to keep working, or the app is
    /// already on its way out.
    fn prepare(&self) -> BoxFuture<'_, Result<(), String>>;
    /// The install failed after `prepare` succeeded: carry on as if nothing had been asked.
    fn resume(&self);
}

/// Where snapshots go: the page, or a vector in tests.
pub trait Publish: Send + Sync {
    fn publish(&self, snapshot: &Snapshot);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Phase {
    /// Nothing has been looked for yet.
    Idle,
    Checking,
    UpToDate {
        checked_ms: u64,
    },
    Available {
        info: UpdateInfo,
    },
    Downloading {
        info: UpdateInfo,
        received: u64,
        /// `None` when the server didn't say: the page shows movement, not a percentage that lies.
        total: Option<u64>,
    },
    /// Downloaded and verified, in memory.
    Ready {
        info: UpdateInfo,
    },
    /// Asking the page to keep everything, then replacing the application.
    Installing {
        info: UpdateInfo,
    },
    /// Updates don't work for this copy at all.
    Unavailable {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Check,
    Download,
    Install,
}

/// The last thing that went wrong, beside the state rather than as one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub stage: Stage,
    pub message: String,
    /// A person asked for this. A background check that fails isn't worth interrupting anyone for.
    pub manual: bool,
}

/// Everything the page needs, in one piece: sent whole on every change and returned whole from every
/// command, so nothing has to be pieced together from events missed while the window was hidden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub current_version: String,
    pub state: Phase,
    /// The person said "Later" to the version in `state` during this run.
    pub dismissed: bool,
    /// Why the last install didn't go ahead (they chose to keep working), if it just happened.
    pub held: Option<String>,
    pub error: Option<Failure>,
}

struct Machine {
    phase: Phase,
    dismissed_version: Option<String>,
    held: Option<String>,
    error: Option<Failure>,
}

struct Shared {
    backend: Arc<dyn Backend>,
    host: Arc<dyn Host>,
    publisher: Arc<dyn Publish>,
    current: Version,
    machine: Mutex<Machine>,
    now_ms: fn() -> u64,
}

/// The updater. Cheap to clone; every clone is the same updater.
#[derive(Clone)]
pub struct Updater {
    shared: Arc<Shared>,
}

impl Updater {
    pub fn new(
        backend: Arc<dyn Backend>,
        host: Arc<dyn Host>,
        publisher: Arc<dyn Publish>,
        current: Version,
        now_ms: fn() -> u64,
    ) -> Updater {
        Updater {
            shared: Arc::new(Shared {
                backend,
                host,
                publisher,
                current,
                machine: Mutex::new(Machine {
                    phase: Phase::Idle,
                    dismissed_version: None,
                    held: None,
                    error: None,
                }),
                now_ms,
            }),
        }
    }

    fn machine(&self) -> MutexGuard<'_, Machine> {
        lock(&self.shared.machine)
    }

    fn snapshot_of(&self, machine: &Machine) -> Snapshot {
        let shown = match &machine.phase {
            Phase::Available { info }
            | Phase::Downloading { info, .. }
            | Phase::Ready { info }
            | Phase::Installing { info } => Some(info.version.as_str()),
            _ => None,
        };
        Snapshot {
            current_version: self.shared.current.to_string(),
            state: machine.phase.clone(),
            dismissed: shown.is_some() && machine.dismissed_version.as_deref() == shown,
            held: machine.held.clone(),
            error: machine.error.clone(),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let machine = self.machine();
        self.snapshot_of(&machine)
    }

    /// Changes the machine and tells the page, in that order and with the lock let go in between.
    fn change(&self, edit: impl FnOnce(&mut Machine)) -> Snapshot {
        let snapshot = {
            let mut machine = self.machine();
            edit(&mut machine);
            self.snapshot_of(&machine)
        };
        self.shared.publisher.publish(&snapshot);
        snapshot
    }

    /// Whether an install has begun: the app may be about to be replaced.
    pub fn installing(&self) -> bool {
        matches!(self.machine().phase, Phase::Installing { .. })
    }

    /// Look for an update. A request while one is checking, downloading, ready or installing changes
    /// nothing: overlapping requests are absorbed, not queued.
    pub async fn check(&self, manual: bool) -> Snapshot {
        let before = {
            let mut machine = self.machine();
            match machine.phase {
                Phase::Checking
                | Phase::Downloading { .. }
                | Phase::Ready { .. }
                | Phase::Installing { .. }
                | Phase::Unavailable { .. } => return self.snapshot_of(&machine),
                Phase::Idle | Phase::UpToDate { .. } | Phase::Available { .. } => {}
            }
            let before = std::mem::replace(&mut machine.phase, Phase::Checking);
            machine.error = None;
            machine.held = None;
            if manual {
                // Asking again is asking to be told, whatever was dismissed.
                machine.dismissed_version = None;
            }
            let snapshot = self.snapshot_of(&machine);
            drop(machine);
            self.shared.publisher.publish(&snapshot);
            before
        };

        let outcome = self.shared.backend.check().await;
        let now = (self.shared.now_ms)();
        let current = self.shared.current.clone();
        self.change(|machine| match outcome {
            Ok(Some(remote)) if is_offered(&current, &remote.version) => {
                machine.phase = Phase::Available {
                    info: remote.info(),
                };
            }
            Ok(_) => machine.phase = Phase::UpToDate { checked_ms: now },
            Err(UpdateError::Unavailable(reason)) => machine.phase = Phase::Unavailable { reason },
            Err(error) => {
                // Whatever was known before is still known.
                machine.phase = before;
                machine.error = Some(Failure {
                    stage: Stage::Check,
                    message: error.message(),
                    manual,
                });
            }
        })
    }

    /// Download the update that was found. Only a download the backend verified becomes ready.
    pub async fn download(&self) -> Snapshot {
        let info = {
            let mut machine = self.machine();
            let Phase::Available { info } = &machine.phase else {
                return self.snapshot_of(&machine);
            };
            let info = info.clone();
            machine.phase = Phase::Downloading {
                info: info.clone(),
                received: 0,
                total: None,
            };
            machine.error = None;
            machine.held = None;
            let snapshot = self.snapshot_of(&machine);
            drop(machine);
            self.shared.publisher.publish(&snapshot);
            info
        };

        // Progress arrives per chunk; the page hears of it at most ten times a second.
        let last_sent = Mutex::new(Instant::now() - Duration::from_secs(1));
        let updater = self.clone();
        let progress = move |chunk: u64, total: Option<u64>| {
            let snapshot = {
                let mut machine = updater.machine();
                if let Phase::Downloading {
                    received,
                    total: known,
                    ..
                } = &mut machine.phase
                {
                    *received += chunk;
                    // A length of zero is a server that didn't know, not an empty download.
                    if let Some(total) = total.filter(|total| *total > 0) {
                        *known = Some(total);
                    }
                }
                updater.snapshot_of(&machine)
            };
            let mut last = lock(&last_sent);
            if last.elapsed() >= Duration::from_millis(100) {
                *last = Instant::now();
                drop(last);
                updater.shared.publisher.publish(&snapshot);
            }
        };

        let outcome = self.shared.backend.download(&progress).await;
        let backend = Arc::clone(&self.shared.backend);
        self.change(|machine| match outcome {
            Ok(()) => machine.phase = Phase::Ready { info },
            Err(error) => {
                // Still available, and nothing partial is kept.
                backend.discard();
                machine.phase = Phase::Available { info };
                machine.error = Some(Failure {
                    stage: Stage::Download,
                    message: error.message(),
                    manual: true,
                });
            }
        })
    }

    /// Install the downloaded update and restart into it. The order is the safety argument:
    ///
    /// 1. Only a verified, downloaded update can be installed at all.
    /// 2. The page is asked to keep everything, as for a quit. If the person keeps working instead,
    ///    the update stays ready and nothing else has changed.
    /// 3. The application is replaced. If that fails, the app carries on as it was, with the update
    ///    available again.
    pub async fn install(&self) -> Snapshot {
        let info = {
            let mut machine = self.machine();
            let Phase::Ready { info } = &machine.phase else {
                return self.snapshot_of(&machine);
            };
            let info = info.clone();
            machine.phase = Phase::Installing { info: info.clone() };
            machine.held = None;
            machine.error = None;
            let snapshot = self.snapshot_of(&machine);
            drop(machine);
            self.shared.publisher.publish(&snapshot);
            info
        };

        if let Err(why) = self.shared.host.prepare().await {
            return self.change(|machine| {
                machine.phase = Phase::Ready { info };
                machine.held = Some(why);
            });
        }

        match self.shared.backend.install().await {
            // The real backend doesn't return from a successful install; this process is on its way out.
            Ok(()) => self.snapshot(),
            Err(error) => {
                self.shared.backend.discard();
                self.shared.host.resume();
                self.change(|machine| {
                    machine.phase = Phase::Available { info };
                    machine.error = Some(Failure {
                        stage: Stage::Install,
                        message: error.message(),
                        manual: true,
                    });
                })
            }
        }
    }

    /// "Later": stop pushing the version on offer, until a newer one turns up or they ask again.
    pub fn dismiss(&self) -> Snapshot {
        self.change(|machine| {
            if let Phase::Available { info }
            | Phase::Downloading { info, .. }
            | Phase::Ready { info } = &machine.phase
            {
                machine.dismissed_version = Some(info.version.clone());
            }
        })
    }
}

/// Whether an exit that was asked for should be put off: while the application is being replaced, a
/// Quit or a shutdown mustn't stop it halfway. The install's own restart (tagged with Tauri's restart
/// code) always goes through, or the app would sit in "installing" with nothing left to finish it.
pub fn defers_exit(installing: bool, code: Option<i32>) -> bool {
    installing && code != Some(tauri::RESTART_EXIT_CODE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[derive(Default)]
    struct MockBackend {
        checks: Mutex<VecDeque<Result<Option<Remote>, UpdateError>>>,
        downloads: Mutex<VecDeque<Result<(), UpdateError>>>,
        installs: Mutex<VecDeque<Result<(), UpdateError>>>,
        discarded: AtomicUsize,
        installed: AtomicUsize,
    }

    impl Backend for MockBackend {
        fn check(&self) -> BoxFuture<'_, Result<Option<Remote>, UpdateError>> {
            let next = lock(&self.checks).pop_front().unwrap_or(Ok(None));
            Box::pin(async move { next })
        }
        fn download<'a>(
            &'a self,
            progress: &'a (dyn Fn(u64, Option<u64>) + Send + Sync),
        ) -> BoxFuture<'a, Result<(), UpdateError>> {
            let next = lock(&self.downloads).pop_front().unwrap_or(Ok(()));
            Box::pin(async move {
                progress(10, Some(0));
                progress(30, Some(40));
                next
            })
        }
        fn install(&self) -> BoxFuture<'_, Result<(), UpdateError>> {
            self.installed.fetch_add(1, AtomicOrdering::SeqCst);
            let next = lock(&self.installs).pop_front().unwrap_or(Ok(()));
            Box::pin(async move { next })
        }
        fn discard(&self) {
            self.discarded.fetch_add(1, AtomicOrdering::SeqCst);
        }
    }

    #[derive(Default)]
    struct MockHost {
        answers: Mutex<VecDeque<Result<(), String>>>,
        prepared: AtomicUsize,
        resumed: AtomicUsize,
    }

    impl Host for MockHost {
        fn prepare(&self) -> BoxFuture<'_, Result<(), String>> {
            self.prepared.fetch_add(1, AtomicOrdering::SeqCst);
            let next = lock(&self.answers).pop_front().unwrap_or(Ok(()));
            Box::pin(async move { next })
        }
        fn resume(&self) {
            self.resumed.fetch_add(1, AtomicOrdering::SeqCst);
        }
    }

    #[derive(Default)]
    struct Sent(Mutex<Vec<Snapshot>>);

    impl Publish for Sent {
        fn publish(&self, snapshot: &Snapshot) {
            lock(&self.0).push(snapshot.clone());
        }
    }

    struct Rig {
        updater: Updater,
        backend: Arc<MockBackend>,
        host: Arc<MockHost>,
        sent: Arc<Sent>,
    }

    fn rigged(current: &str) -> Rig {
        let backend = Arc::new(MockBackend::default());
        let host = Arc::new(MockHost::default());
        let sent = Arc::new(Sent::default());
        let updater = Updater::new(
            backend.clone(),
            host.clone(),
            sent.clone(),
            v(current),
            || 1_000,
        );
        Rig {
            updater,
            backend,
            host,
            sent,
        }
    }

    fn offer(rig: &Rig, version: &str) {
        lock(&rig.backend.checks).push_back(Ok(Some(Remote {
            version: v(version),
            notes: Some("### Added\n- Things".into()),
        })));
    }

    fn run<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn versions_are_compared_by_precedence_and_prereleases_stay_with_prereleases() {
        assert!(is_offered(&v("1.9.4"), &v("1.10.0")));
        assert!(!is_offered(&v("1.10.0"), &v("1.9.4")));
        assert!(!is_offered(&v("1.9.4"), &v("1.9.4")));
        assert!(!is_offered(&v("1.9.4"), &v("2.0.0-beta.1")));
        assert!(is_offered(&v("2.0.0-beta.1"), &v("2.0.0-beta.2")));
        assert!(is_offered(&v("2.0.0-beta.9"), &v("2.0.0")));
        assert!(!is_offered(&v("1.9.4"), &v("1.9.4+other")));
    }

    #[test]
    fn a_newer_release_is_available_and_nothing_newer_is_up_to_date() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        let snapshot = run(rig.updater.check(false));
        assert!(matches!(&snapshot.state, Phase::Available { info } if info.version == "1.10.0"));

        let rig = rigged("1.9.4");
        let snapshot = run(rig.updater.check(false));
        assert_eq!(snapshot.state, Phase::UpToDate { checked_ms: 1_000 });
    }

    #[test]
    fn what_the_plugin_offers_is_checked_again() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.9.3");
        assert!(matches!(
            run(rig.updater.check(false)).state,
            Phase::UpToDate { .. }
        ));
    }

    #[test]
    fn a_failed_check_keeps_what_was_known_and_says_whether_anyone_asked() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        lock(&rig.backend.checks).push_back(Err(UpdateError::Offline));
        let snapshot = run(rig.updater.check(true));
        assert!(matches!(snapshot.state, Phase::Available { .. }));
        let error = snapshot.error.unwrap();
        assert_eq!(error.stage, Stage::Check);
        assert!(error.manual);
    }

    #[test]
    fn a_copy_that_cannot_update_says_so_and_stops_checking() {
        let rig = rigged("1.9.4");
        lock(&rig.backend.checks).push_back(Err(UpdateError::Unavailable("no key".into())));
        let snapshot = run(rig.updater.check(false));
        assert_eq!(
            snapshot.state,
            Phase::Unavailable {
                reason: "no key".into()
            }
        );
        offer(&rig, "2.0.0");
        assert!(matches!(
            run(rig.updater.check(true)).state,
            Phase::Unavailable { .. }
        ));
    }

    #[test]
    fn a_download_reports_progress_and_only_a_verified_one_is_ready() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        let snapshot = run(rig.updater.download());
        assert!(matches!(snapshot.state, Phase::Ready { .. }));
        // The first chunk is sent at once (the second lands inside the throttle window). Its server
        // said a length of zero, which is "unknown", not an empty download.
        let progress: Vec<_> = lock(&rig.sent.0)
            .iter()
            .filter_map(|s| match s.state {
                Phase::Downloading {
                    received, total, ..
                } if received > 0 => Some((received, total)),
                _ => None,
            })
            .collect();
        assert_eq!(progress, vec![(10, None)]);
    }

    #[test]
    fn a_download_that_fails_its_signature_is_thrown_away_and_can_be_tried_again() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        lock(&rig.backend.downloads).push_back(Err(UpdateError::BadSignature));
        let snapshot = run(rig.updater.download());
        assert!(matches!(snapshot.state, Phase::Available { .. }));
        assert!(snapshot
            .error
            .unwrap()
            .message
            .contains("Nothing was installed"));
        assert_eq!(rig.backend.discarded.load(AtomicOrdering::SeqCst), 1);
        assert!(matches!(
            run(rig.updater.download()).state,
            Phase::Ready { .. }
        ));
    }

    #[test]
    fn nothing_is_installed_that_was_not_downloaded() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        assert!(matches!(
            run(rig.updater.install()).state,
            Phase::Available { .. }
        ));
        assert_eq!(rig.host.prepared.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(rig.backend.installed.load(AtomicOrdering::SeqCst), 0);
    }

    #[test]
    fn installing_asks_the_page_first_and_keeping_working_leaves_it_ready() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        run(rig.updater.download());
        lock(&rig.host.answers).push_back(Err("You kept working.".into()));
        let snapshot = run(rig.updater.install());
        assert!(matches!(snapshot.state, Phase::Ready { .. }));
        assert_eq!(snapshot.held.as_deref(), Some("You kept working."));
        assert_eq!(rig.backend.installed.load(AtomicOrdering::SeqCst), 0);

        // Asked again, and this time it goes ahead.
        let snapshot = run(rig.updater.install());
        assert!(matches!(snapshot.state, Phase::Installing { .. }));
        assert_eq!(rig.host.prepared.load(AtomicOrdering::SeqCst), 2);
        assert_eq!(rig.backend.installed.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn a_failed_install_gives_the_app_back_and_offers_the_update_again() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        run(rig.updater.download());
        lock(&rig.backend.installs).push_back(Err(UpdateError::InstallFailed("disk".into())));
        let snapshot = run(rig.updater.install());
        assert!(matches!(snapshot.state, Phase::Available { .. }));
        assert_eq!(snapshot.error.unwrap().stage, Stage::Install);
        assert_eq!(rig.host.resumed.load(AtomicOrdering::SeqCst), 1);
        assert!(!rig.updater.installing());
    }

    #[test]
    fn later_hides_the_version_until_a_person_asks_again() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        assert!(rig.updater.dismiss().dismissed);
        // A background check doesn't bring it back…
        offer(&rig, "1.10.0");
        assert!(run(rig.updater.check(false)).dismissed);
        // …asking does, and so would a newer version.
        offer(&rig, "1.10.0");
        assert!(!run(rig.updater.check(true)).dismissed);
    }

    #[test]
    fn checking_while_busy_changes_nothing() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        run(rig.updater.check(false));
        run(rig.updater.download());
        offer(&rig, "1.11.0");
        let snapshot = run(rig.updater.check(true));
        assert!(matches!(&snapshot.state, Phase::Ready { info } if info.version == "1.10.0"));
    }

    #[test]
    fn a_quit_during_an_install_waits_but_its_own_restart_does_not() {
        assert!(defers_exit(true, None));
        assert!(defers_exit(true, Some(0)));
        assert!(!defers_exit(true, Some(tauri::RESTART_EXIT_CODE)));
        assert!(!defers_exit(false, None));
    }

    #[test]
    fn the_snapshot_is_what_api_ts_reads() {
        let rig = rigged("1.9.4");
        offer(&rig, "1.10.0");
        let snapshot = run(rig.updater.check(false));
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["currentVersion"], "1.9.4");
        assert_eq!(json["state"]["phase"], "available");
        assert_eq!(json["state"]["info"]["version"], "1.10.0");
        let json = serde_json::to_value(Phase::UpToDate { checked_ms: 5 }).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "phase": "up-to-date", "checkedMs": 5 })
        );
    }
}
