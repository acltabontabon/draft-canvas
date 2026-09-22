//! The Recent list as the page sees it: entries with handles, never paths.

use super::{recents_changed, run_blocking};
use crate::errors::AppError;
use crate::grants::Handle;
use crate::paths::display_path;
use crate::recents::RecentKind;
use crate::state::AppState;
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    pub handle: Handle,
    pub kind: RecentKind,
    pub name: String,
    pub display_path: String,
    pub last_opened_ms: u64,
}

/// Newest first, with a handle minted for each. An entry that can no longer be granted (the file grew
/// past the size limit, say) is left out of this list rather than failing the whole call. The flag says
/// whether entries for vanished files were dropped, so the tray can be refreshed.
fn recent_items(state: &AppState) -> Result<(Vec<RecentItem>, bool), AppError> {
    let listing = state.recents.list()?;
    let items = listing
        .items
        .into_iter()
        .filter_map(|e| {
            let path = Path::new(&e.path);
            let handle = match e.kind {
                RecentKind::File => state.grant_file(path),
                RecentKind::Project => state.grant_project(path),
            }
            .ok()?;
            Some(RecentItem {
                handle,
                kind: e.kind,
                name: e.name,
                display_path: display_path(path),
                last_opened_ms: e.last_opened_ms,
            })
        })
        .collect();
    Ok((items, listing.pruned))
}

/// The path behind a handle the page holds, whether it names a file or a project.
fn path_of(state: &AppState, handle: &str) -> Result<std::path::PathBuf, AppError> {
    state
        .file(handle)
        .map(|g| g.path)
        .or_else(|_| state.project(handle).map(|g| g.root))
}

#[tauri::command]
pub async fn recents_list(app: AppHandle) -> Result<Vec<RecentItem>, AppError> {
    run_blocking(&app, |app, state| {
        let (items, pruned) = recent_items(state)?;
        if pruned {
            // The page asked and gets the corrected list; only the tray still shows the old one.
            crate::tray::refresh(app);
        }
        Ok(items)
    })
    .await
}

#[tauri::command]
pub async fn recents_remove(app: AppHandle, handle: String) -> Result<(), AppError> {
    run_blocking(&app, move |app, state| {
        state.recents.remove(&path_of(state, &handle)?)?;
        recents_changed(app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn recents_clear(app: AppHandle) -> Result<(), AppError> {
    run_blocking(&app, |app, state| {
        state.recents.clear()?;
        recents_changed(app);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::remember_file;
    use crate::commands::testing::{doc, test_state};
    use crate::docio::MAX_DOC_BYTES;
    use crate::errors::ErrorKind;
    use serde_json::json;
    use std::fs::{self, File};

    #[test]
    fn entries_come_back_newest_first_with_handles_for_files_and_projects() {
        let (dir, state) = test_state();
        let file = doc(&dir, "a.draftcanvas", "{}");
        let folder = dir.path().join("proj");
        fs::create_dir(&folder).unwrap();
        remember_file(&state, &dunce::canonicalize(&file).unwrap(), "a");
        std::thread::sleep(std::time::Duration::from_millis(3));
        // Projects no longer go into Recent (they have their own list), but a Recent written by an
        // earlier version has them, and they still come back usable.
        state
            .recents
            .add(
                RecentKind::Project,
                &dunce::canonicalize(&folder).unwrap(),
                "proj",
                crate::util::now_ms(),
            )
            .unwrap();

        let (items, pruned) = recent_items(&state).unwrap();
        assert!(!pruned);
        assert_eq!(
            items
                .iter()
                .map(|i| (i.kind, i.name.as_str()))
                .collect::<Vec<_>>(),
            [(RecentKind::Project, "proj"), (RecentKind::File, "a")]
        );
        assert!(state.project(&items[0].handle).is_ok());
        assert!(state.file(&items[1].handle).is_ok());
        assert!(
            state.file(&items[0].handle).is_err(),
            "a project handle is not a file handle"
        );
        assert!(items[1].display_path.ends_with("a.draftcanvas"));
    }

    #[test]
    fn asking_again_gives_the_same_handles() {
        let (dir, state) = test_state();
        let file = doc(&dir, "a.draftcanvas", "{}");
        remember_file(&state, &dunce::canonicalize(&file).unwrap(), "a");
        let first = recent_items(&state).unwrap().0;
        let second = recent_items(&state).unwrap().0;
        assert_eq!(first[0].handle, second[0].handle);
    }

    #[test]
    fn vanished_files_are_pruned_and_reported() {
        let (dir, state) = test_state();
        let gone = doc(&dir, "gone.draftcanvas", "{}");
        let kept = doc(&dir, "kept.draftcanvas", "{}");
        remember_file(&state, &dunce::canonicalize(&gone).unwrap(), "gone");
        remember_file(&state, &dunce::canonicalize(&kept).unwrap(), "kept");
        fs::remove_file(&gone).unwrap();
        let (items, pruned) = recent_items(&state).unwrap();
        assert!(pruned);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "kept");
    }

    #[test]
    fn an_entry_that_cannot_be_granted_is_skipped_not_fatal() {
        let (dir, state) = test_state();
        let big = dir.path().join("big.draftcanvas");
        File::create(&big)
            .unwrap()
            .set_len(MAX_DOC_BYTES + 1)
            .unwrap();
        let ok = doc(&dir, "ok.draftcanvas", "{}");
        remember_file(&state, &dunce::canonicalize(&big).unwrap(), "big");
        remember_file(&state, &dunce::canonicalize(&ok).unwrap(), "ok");
        let (items, _) = recent_items(&state).unwrap();
        assert_eq!(
            items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
            ["ok"]
        );
    }

    #[test]
    fn a_handle_finds_its_path_whether_file_or_project() {
        let (dir, state) = test_state();
        let file = doc(&dir, "a.draftcanvas", "{}");
        let fh = state.grant_file(&file).unwrap();
        let ph = state.grant_project(dir.path()).unwrap();
        assert_eq!(
            path_of(&state, &fh).unwrap(),
            dunce::canonicalize(&file).unwrap()
        );
        assert_eq!(
            path_of(&state, &ph).unwrap(),
            dunce::canonicalize(dir.path()).unwrap()
        );
        assert_eq!(
            path_of(&state, "h_unknown").err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
    }

    #[test]
    fn removing_by_handle_drops_the_entry() {
        let (dir, state) = test_state();
        let file = doc(&dir, "a.draftcanvas", "{}");
        remember_file(&state, &dunce::canonicalize(&file).unwrap(), "a");
        let (items, _) = recent_items(&state).unwrap();
        state
            .recents
            .remove(&path_of(&state, &items[0].handle).unwrap())
            .unwrap();
        assert!(recent_items(&state).unwrap().0.is_empty());
    }

    #[test]
    fn the_wire_shape_matches_the_typescript_type() {
        let item = RecentItem {
            handle: "h_1".into(),
            kind: RecentKind::Project,
            name: "P".into(),
            display_path: "~/P".into(),
            last_opened_ms: 9,
        };
        assert_eq!(
            serde_json::to_value(item).unwrap(),
            json!({"handle": "h_1", "kind": "project", "name": "P", "displayPath": "~/P", "lastOpenedMs": 9})
        );
    }
}
