//! Home draws each recent file and each file in the open project as its own topology, which means
//! looking inside it. Looking is not opening: nothing here grants a new handle, touches Recent or
//! the last folder, and a file that can't be looked at (gone, unreadable, too large to be worth it
//! for a thumbnail) is simply `None` — the tile shows a blank sheet, and opening it for real still
//! reports whatever the problem is.

use super::run_blocking;
use crate::docio::read_document;
use crate::errors::AppError;
use crate::state::AppState;
use std::fs;
use std::path::Path;
use tauri::AppHandle;

/// Far above any diagram a person draws by hand, far below the 24 MiB a file may be: a thumbnail
/// is not worth reading tens of megabytes for.
pub const MAX_PEEK_BYTES: u64 = 2 * 1024 * 1024;

fn peek_path(path: &Path) -> Option<String> {
    let size = fs::metadata(path).ok().filter(|meta| meta.is_file())?.len();
    if size > MAX_PEEK_BYTES {
        return None;
    }
    read_document(path).ok().map(|doc| doc.text)
}

pub(crate) fn peek_file(state: &AppState, handle: &str) -> Option<String> {
    peek_path(&state.file(handle).ok()?.path)
}

pub(crate) fn peek_in_project(state: &AppState, project: &str, rel: &str) -> Option<String> {
    peek_path(&state.resolve_in_project(project, rel).ok()?)
}

#[tauri::command]
pub async fn peek_document(app: AppHandle, handle: String) -> Result<Option<String>, AppError> {
    run_blocking(&app, move |_, state| Ok(peek_file(state, &handle))).await
}

#[tauri::command]
pub async fn project_peek(
    app: AppHandle,
    project_handle: String,
    rel_path: String,
) -> Result<Option<String>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(peek_in_project(state, &project_handle, &rel_path))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::{doc, test_state};
    use std::fs;

    #[test]
    fn looks_inside_a_granted_file_without_opening_it() {
        let (dir, state) = test_state();
        let path = doc(&dir, "flow.draftcanvas", "{\"format\":\"draft-canvas\"}");
        let handle = state.grant_file(&path).unwrap();

        assert_eq!(
            peek_file(&state, &handle).as_deref(),
            Some("{\"format\":\"draft-canvas\"}")
        );
        // Opening puts a file in Recent and remembers its folder; looking does neither.
        assert!(state.recents.list().unwrap().items.is_empty());
        assert!(state.settings.get().last_dir.is_none());
    }

    #[test]
    fn is_nothing_for_a_handle_it_never_gave_out() {
        let (_dir, state) = test_state();
        assert_eq!(peek_file(&state, "h_not-a-handle"), None);
    }

    #[test]
    fn is_nothing_once_the_file_is_gone() {
        let (dir, state) = test_state();
        let path = doc(&dir, "gone.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(peek_file(&state, &handle), None);
    }

    #[test]
    fn skips_a_file_too_large_for_a_thumbnail() {
        let (dir, state) = test_state();
        let big = "x".repeat(MAX_PEEK_BYTES as usize + 1);
        let path = doc(&dir, "big.draftcanvas", &big);
        let handle = state.grant_file(&path).unwrap();
        assert_eq!(peek_file(&state, &handle), None);
    }

    #[test]
    fn looks_inside_a_project_file_by_its_relative_path_only() {
        let (dir, state) = test_state();
        let root = dir.path().join("payments");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("docs/flow.draftcanvas"), "{\"x\":1}").unwrap();
        fs::write(dir.path().join("outside.draftcanvas"), "{\"secret\":1}").unwrap();
        let project = state.grant_project(&root).unwrap();

        assert_eq!(
            peek_in_project(&state, &project, "docs/flow.draftcanvas").as_deref(),
            Some("{\"x\":1}")
        );
        // The same path checks as opening: nothing outside the folder, however it is spelled.
        assert_eq!(
            peek_in_project(&state, &project, "../outside.draftcanvas"),
            None
        );
        assert_eq!(peek_in_project(&state, &project, "docs/flow.txt"), None);
        assert!(state.recents.list().unwrap().items.is_empty());
    }
}
