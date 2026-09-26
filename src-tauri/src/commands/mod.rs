//! What the page can ask for. Each command is a thin async wrapper: it checks its arguments, moves the
//! real work onto a blocking thread (a disk or a dialog can take arbitrarily long, and neither may hold
//! up the threads that answer other requests), and turns any failure into an `AppError`. The work
//! itself lives in plain functions over `&AppState`, which the tests drive directly.

pub mod agent;
pub mod documents;
pub mod host;
pub mod peek;
pub mod projects;
pub mod raw;
pub mod recents;
pub mod recovery;
pub mod updates;

use crate::errors::AppError;
use crate::recents::RecentKind;
use crate::settings::LastProject;
use crate::state::{AppState, HostEvent};
use crate::util::now_ms;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Runs `work` on the blocking pool with the app state in hand.
pub(crate) async fn run_blocking<T, F>(app: &AppHandle, work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle, &AppState) -> Result<T, AppError> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        work(&app, state.inner())
    })
    .await
    .map_err(|_| AppError::internal())?
}

/// Called after anything changed the Recent list: the page is told to look again.
pub(crate) fn recents_changed(app: &AppHandle) {
    app.state::<AppState>()
        .events
        .emit(HostEvent::RecentsChanged);
}

/// Where a file dialog should start: the folder the last file was picked from, if it still exists.
pub(crate) fn last_dir(state: &AppState) -> Option<PathBuf> {
    state
        .settings
        .get()
        .last_dir
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
}

// Remembering is a convenience. A recents or settings file that can't be written must never turn
// "open this file" or "save this file" into a failure, so the errors below are dropped on purpose.

pub(crate) fn remember_dir(state: &AppState, dir: Option<&Path>) {
    let Some(dir) = dir.and_then(|d| d.to_str()) else {
        return;
    };
    if state.settings.get().last_dir.as_deref() != Some(dir) {
        let _ = state
            .settings
            .update(|s| s.last_dir = Some(dir.to_string()));
    }
}

pub(crate) fn remember_file(state: &AppState, path: &Path, name: &str) {
    let _ = state.recents.add(RecentKind::File, path, name, now_ms());
    remember_dir(state, path.parent());
}

/// A project picked or opened goes to the front of the project list (Recent is for files; the list is
/// where projects live), and its folder is where the next dialog starts.
pub(crate) fn remember_project(state: &AppState, root: &Path, name: &str) {
    if let Some(path) = root.to_str() {
        let project = LastProject {
            path: path.to_string(),
            name: name.to_string(),
            agent: false,
        };
        let _ = state.settings.update(|s| {
            s.remember_project(project);
            s.last_dir = Some(path.to_string());
        });
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use crate::state::AppState;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::{tempdir, TempDir};

    /// An app state whose stores live in a scratch folder that is also where test documents go.
    pub fn test_state() -> (TempDir, AppState) {
        let dir = tempdir().unwrap();
        let state = AppState::new(&dir.path().join("config"), &dir.path().join("data"));
        (dir, state)
    }

    pub fn doc(dir: &TempDir, name: &str, text: &str) -> PathBuf {
        let path = dir.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, text).unwrap();
        path
    }
}
