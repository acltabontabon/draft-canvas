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
    /// The open document's folder, never given up to make room: two projects' scans each claiming
    /// their share could otherwise push it out, and the open file stopped hearing about changes.
    pinned: Option<PathBuf>,
}

impl Watches {
    /// Keeps `folder` (the open document's) watched whatever else asks for the budget.
    pub fn pin(&mut self, folder: Option<&Path>) {
        if self.pinned.as_deref() == folder {
            return;
        }
        self.pinned = folder.map(Path::to_path_buf);
        if let Some(folder) = folder {
            self.add(folder);
        }
    }

    pub fn add(&mut self, path: &Path) {
        self.add_all([path]);
    }

    /// Watches every path in one change. On macOS each change to the watched set stops the event stream
    /// and starts it again, so adding folders one at a time (a scan's, or fifty projects' at launch)
    /// paid for a restart each; one batch pays once.
    ///
    /// Never recursively subscribes to a repository's dependency/build trees. Project scans register
    /// only directories containing diagrams, under a fixed native-watch budget.
    pub fn add_all<'a>(&mut self, wanted: impl IntoIterator<Item = &'a Path>) {
        let Watches {
            watcher,
            paths,
            pinned,
        } = self;
        // Folders already watched only move up the recency order. Opening the batch at all restarts
        // the stream, so a grant or scan that adds nothing new — most of them — must not open it.
        let mut fresh: Vec<&Path> = Vec::new();
        for path in wanted {
            if let Some(at) = paths.iter().position(|p| p == path) {
                let used = paths.remove(at);
                paths.push(used);
            } else if !fresh.contains(&path) {
                fresh.push(path);
            }
        }
        if fresh.is_empty() {
            return;
        }
        let mut batch = watcher.paths_mut();
        for path in fresh {
            if paths.len() >= BUDGET {
                let at = paths
                    .iter()
                    .position(|p| Some(p) != pinned.as_ref())
                    .unwrap_or(0);
                let oldest = paths.remove(at);
                let _ = batch.remove(&oldest);
            }
            if batch.add(path, RecursiveMode::NonRecursive).is_ok() {
                paths.push(path.to_path_buf());
            }
        }
        let _ = batch.commit();
    }

    /// Stops watching `root` and every folder inside it — a project taken off the list. In one batch,
    /// for the same reason as `add_all`.
    pub fn remove_under(&mut self, root: &Path) {
        let Watches { watcher, paths, .. } = self;
        if !paths.iter().any(|path| path.starts_with(root)) {
            return;
        }
        let mut batch = watcher.paths_mut();
        paths.retain(|path| {
            let inside = path.starts_with(root);
            if inside {
                let _ = batch.remove(path);
            }
            !inside
        });
        let _ = batch.commit();
    }
}

/// Whether an event could change what the page shows: a diagram or its background image appearing,
/// going or changing, or a folder being created, removed or renamed. A watched folder is whatever the
/// person keeps files in (Downloads, a repository root), so everything else it sees — browser
/// downloads, `.git` lock files, build output, our own temp files — would otherwise wake the page into
/// a stamp check, and on Home a rescan of every project, again and again, even from the tray.
fn relevant(event: &notify::Event) -> bool {
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use notify::EventKind::{Access, Create, Modify, Remove};
    if matches!(event.kind, Access(_)) {
        return false;
    }
    if event.paths.is_empty() {
        return true;
    }
    let folder_change = matches!(
        event.kind,
        Create(CreateKind::Folder | CreateKind::Any)
            | Remove(RemoveKind::Folder | RemoveKind::Any)
            | Modify(ModifyKind::Name(_))
    );
    let is_folder_event = matches!(
        event.kind,
        Create(CreateKind::Folder) | Remove(RemoveKind::Folder)
    );
    event.paths.iter().any(|path| {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return true;
        };
        if name.contains(".dctmp-") {
            return false;
        }
        let name = name.to_ascii_lowercase();
        let dot = format!(".{}", crate::paths::DOC_EXT);
        if name.ends_with(&dot) || name.contains(&format!("{dot}.background.")) {
            return true;
        }
        // A name with no extension is taken for a folder. That missed `v2.0/` or `docs.old/` being
        // removed or renamed, so a backend that says it was a folder, or a renamed path that is one
        // now, is believed instead.
        folder_change
            && !name.starts_with('.')
            && (path.extension().is_none()
                || is_folder_event
                || (matches!(event.kind, Modify(ModifyKind::Name(_))) && path.is_dir()))
    })
}

pub fn start(app: &tauri::AppHandle) {
    let (tx, rx) = mpsc::sync_channel(1);
    let Ok(watcher) = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.as_ref().map_or(true, relevant) {
            let _ = tx.try_send(());
        }
    }) else {
        return;
    };
    *lock(&app.state::<AppState>().watches) = Some(Watches {
        watcher,
        paths: Vec::new(),
        pinned: None,
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
            pinned: None,
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
    fn the_open_documents_folder_is_never_given_up() {
        let root = tempfile::tempdir().unwrap();
        let dirs: Vec<PathBuf> = (0..BUDGET + 1)
            .map(|i| {
                let dir = root.path().join(format!("d{i}"));
                std::fs::create_dir(&dir).unwrap();
                dir
            })
            .collect();
        let mut watches = watches();
        watches.pin(Some(&dirs[0]));
        watches.add_all(dirs[1..].iter().map(PathBuf::as_path));
        assert_eq!(watches.paths.len(), BUDGET);
        assert!(watches.paths.contains(&dirs[0]));
        assert!(!watches.paths.contains(&dirs[1]));
    }

    fn event(kind: notify::EventKind, path: &str) -> notify::Event {
        notify::Event::new(kind).add_path(PathBuf::from(path))
    }

    #[test]
    fn only_changes_the_page_could_show_wake_it() {
        use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind, RenameMode};
        use notify::EventKind::{Access, Create, Modify, Remove};
        let data = Modify(ModifyKind::Data(notify::event::DataChange::Any));
        // A diagram, its background, and a folder appearing, going or being renamed.
        assert!(relevant(&event(data, "/p/plan.draftcanvas")));
        assert!(relevant(&event(
            Create(CreateKind::File),
            "/p/Plan.DraftCanvas"
        )));
        assert!(relevant(&event(data, "/p/plan.draftcanvas.background.png")));
        assert!(relevant(&event(Create(CreateKind::Folder), "/p/docs")));
        assert!(relevant(&event(Remove(RemoveKind::Folder), "/p/docs")));
        assert!(relevant(&event(
            Modify(ModifyKind::Name(RenameMode::Any)),
            "/p/old"
        )));
        // A folder whose name has a dot in it.
        assert!(relevant(&event(Remove(RemoveKind::Folder), "/p/v2.0")));
        let dotted = tempfile::tempdir().unwrap();
        let renamed = dotted.path().join("docs.old");
        std::fs::create_dir(&renamed).unwrap();
        assert!(relevant(
            &notify::Event::new(Modify(ModifyKind::Name(RenameMode::To))).add_path(renamed)
        ));
        assert!(!relevant(&event(
            Modify(ModifyKind::Name(RenameMode::Any)),
            "/p/notes.txt"
        )));
        // Everything else a folder like Downloads or a repository root sees.
        assert!(!relevant(&event(
            Create(CreateKind::File),
            "/p/movie.crdownload"
        )));
        assert!(!relevant(&event(data, "/p/.git/index.lock")));
        assert!(!relevant(&event(Create(CreateKind::Folder), "/p/.cache")));
        assert!(!relevant(&event(data, "/p/.plan.draftcanvas.dctmp-1-abcd")));
        assert!(!relevant(&event(
            Access(AccessKind::Any),
            "/p/plan.draftcanvas"
        )));
        // No path to judge by: assume it matters.
        assert!(relevant(&notify::Event::new(data)));
    }

    #[test]
    fn a_batch_of_watches_keeps_the_budget_and_the_order() {
        let root = tempfile::tempdir().unwrap();
        let dirs: Vec<PathBuf> = (0..BUDGET + 3)
            .map(|i| {
                let dir = root.path().join(format!("d{i}"));
                std::fs::create_dir(&dir).unwrap();
                dir
            })
            .collect();
        let mut watches = watches();
        watches.add_all(dirs[..BUDGET].iter().map(PathBuf::as_path));
        watches.add_all(
            std::iter::once(dirs[0].as_path()).chain(dirs[BUDGET..].iter().map(PathBuf::as_path)),
        );
        assert_eq!(watches.paths.len(), BUDGET);
        assert!(watches.paths.contains(&dirs[0]));
        assert!(watches.paths.contains(&dirs[BUDGET + 2]));
        assert!(!watches.paths.contains(&dirs[1]));
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
