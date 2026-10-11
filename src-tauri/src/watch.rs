//! Notifications are hints. Stamp checks on focus and before writes remain authoritative.
use crate::state::{AppState, HostEvent};
use crate::util::lock;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Manager;

pub struct Watches {
    watcher: RecommendedWatcher,
    paths: HashSet<PathBuf>,
}

impl Watches {
    pub fn add(&mut self, path: &Path) {
        // Never recursively subscribe to a repository's dependency/build trees. Project scans
        // register only directories containing diagrams, under a fixed native-watch budget.
        if self.paths.len() >= 32 || self.paths.contains(path) {
            return;
        }
        if self
            .watcher
            .watch(path, RecursiveMode::NonRecursive)
            .is_ok()
        {
            self.paths.insert(path.to_path_buf());
        }
    }
}

pub fn start(app: &tauri::AppHandle) {
    let (tx, rx) = mpsc::sync_channel(1);
    let Ok(watcher) = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event
            .as_ref()
            .map_or(true, |e| !matches!(e.kind, notify::EventKind::Access(_)))
        {
            let _ = tx.try_send(());
        }
    }) else {
        return;
    };
    *lock(&app.state::<AppState>().watches) = Some(Watches {
        watcher,
        paths: HashSet::new(),
    });
    let app = app.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(1)
                && rx.recv_timeout(Duration::from_millis(150)).is_ok()
            {}
            app.state::<AppState>().events.emit(HostEvent::DiskChanged);
        }
    });
}
