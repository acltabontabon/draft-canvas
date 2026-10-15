//! Notifications are hints. Stamp checks on focus and before writes remain authoritative.
use crate::state::{AppState, HostEvent};
use crate::util::lock;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Native watches held at once. The folders used most recently keep theirs: a budget that only
/// filled up left every file opened after the 32nd folder without live updates until a restart.
pub const BUDGET: usize = 32;

/// How many of a project's diagram folders one scan may watch, so that a single large project
/// can't take the whole budget from the file that's open.
pub const SCAN_SHARE: usize = 16;

pub struct Watches {
    watcher: RecommendedWatcher,
    /// Least recently used first.
    paths: Vec<PathBuf>,
}

impl Watches {
    pub fn add(&mut self, path: &Path) {
        // Never recursively subscribe to a repository's dependency/build trees. Project scans
        // register only directories containing diagrams, under a fixed native-watch budget.
        if let Some(at) = self.paths.iter().position(|p| p == path) {
            let used = self.paths.remove(at);
            self.paths.push(used);
            return;
        }
        if self.paths.len() >= BUDGET {
            let oldest = self.paths.remove(0);
            let _ = self.watcher.unwatch(&oldest);
        }
        if self
            .watcher
            .watch(path, RecursiveMode::NonRecursive)
            .is_ok()
        {
            self.paths.push(path.to_path_buf());
        }
    }

    /// Stops watching `root` and every folder inside it — a project taken off the list.
    pub fn remove_under(&mut self, root: &Path) {
        let watcher = &mut self.watcher;
        self.paths.retain(|path| {
            let inside = path.starts_with(root);
            if inside {
                let _ = watcher.unwatch(path);
            }
            !inside
        });
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
        paths: Vec::new(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn watches() -> Watches {
        Watches {
            watcher: notify::recommended_watcher(|_: notify::Result<notify::Event>| {}).unwrap(),
            paths: Vec::new(),
        }
    }

    #[test]
    fn the_budget_keeps_the_folders_used_most_recently() {
        let root = tempfile::tempdir().unwrap();
        let dirs: Vec<PathBuf> = (0..BUDGET + 2)
            .map(|i| {
                let dir = root.path().join(format!("d{i}"));
                std::fs::create_dir(&dir).unwrap();
                dir
            })
            .collect();
        let mut watches = watches();
        for dir in &dirs[..BUDGET] {
            watches.add(dir);
        }
        // Using the first folder again keeps it when the budget is full.
        watches.add(&dirs[0]);
        watches.add(&dirs[BUDGET]);
        watches.add(&dirs[BUDGET + 1]);
        assert_eq!(watches.paths.len(), BUDGET);
        assert!(watches.paths.contains(&dirs[0]));
        assert!(watches.paths.contains(&dirs[BUDGET + 1]));
        assert!(!watches.paths.contains(&dirs[1]));
        assert!(!watches.paths.contains(&dirs[2]));
    }

    #[test]
    fn a_forgotten_project_stops_being_watched() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let inside = project.join("docs");
        let elsewhere = root.path().join("elsewhere");
        for dir in [&inside, &elsewhere] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let mut watches = watches();
        watches.add(&project);
        watches.add(&inside);
        watches.add(&elsewhere);
        watches.remove_under(&project);
        assert_eq!(watches.paths, vec![elsewhere]);
    }
}
