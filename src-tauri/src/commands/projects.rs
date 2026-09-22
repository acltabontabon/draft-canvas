//! A project is a folder the person picked: its `.draftcanvas` files are listed and opened through
//! handles, and new canvases can be created in it.

use super::documents::{opened_doc, OpenedDoc, SavedAs};
use super::raw::raw_request;
use super::{last_dir, recents_changed, remember_file, remember_project, run_blocking};
use crate::dialogs;
use crate::docio::{create_new_atomic, ensure_document_size, unique_name};
use crate::errors::AppError;
use crate::grants::Handle;
use crate::paths::{display_path, sanitize_stem, DOC_EXT};
use crate::project::{scan, Limits, Scan};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::ipc::Request;
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub handle: Handle,
    pub name: String,
    pub display_path: String,
}

/// The project as the page sees it, without the side effects of opening it.
pub(crate) fn project_info(state: &AppState, root: &Path) -> Result<ProjectInfo, AppError> {
    let handle = state.grant_project(root)?;
    let grant = state.project(&handle)?;
    Ok(ProjectInfo {
        handle,
        display_path: display_path(&grant.root),
        name: grant.name,
    })
}

/// Opening a project is also remembering it: it goes into Recent, and it is where the next launch
/// offers to pick up.
fn open_project_at(state: &AppState, root: &Path) -> Result<ProjectInfo, AppError> {
    let info = project_info(state, root)?;
    remember_project(state, &state.project(&info.handle)?.root, &info.name);
    Ok(info)
}

#[tauri::command]
pub async fn pick_project(app: AppHandle) -> Result<Option<ProjectInfo>, AppError> {
    run_blocking(&app, |app, state| {
        let Some(folder) = dialogs::pick_folder(app, last_dir(state)) else {
            return Ok(None);
        };
        let info = open_project_at(state, &folder)?;
        recents_changed(app);
        Ok(Some(info))
    })
    .await
}

/// Re-opens a project from a Recent entry's handle; it may have been deleted since it was listed.
#[tauri::command]
pub async fn open_project(app: AppHandle, handle: String) -> Result<ProjectInfo, AppError> {
    run_blocking(&app, move |app, state| {
        let root = state.project(&handle)?.root;
        let info = open_project_at(state, &root)?;
        recents_changed(app);
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn project_scan(app: AppHandle, handle: String) -> Result<Scan, AppError> {
    run_blocking(&app, move |_, state| {
        scan(&state.project(&handle)?.root, &Limits::default())
    })
    .await
}

#[tauri::command]
pub async fn project_open_file(
    app: AppHandle,
    project_handle: String,
    rel_path: String,
) -> Result<OpenedDoc, AppError> {
    run_blocking(&app, move |app, state| {
        let path = state.resolve_in_project(&project_handle, &rel_path)?;
        let doc = opened_doc(state, &path)?;
        recents_changed(app);
        Ok(doc)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewInProjectMeta {
    project_handle: Handle,
    name: String,
}

/// Creates a new document in the project folder under the first free name ("Untitled canvas",
/// "Untitled canvas 2", …). The page suggests a name; it never chooses a place.
fn create_in_project(
    state: &AppState,
    project_handle: &str,
    name: &str,
    bytes: &[u8],
) -> Result<SavedAs, AppError> {
    ensure_document_size(bytes.len())?;
    let root = state.project(project_handle)?.root;
    let file = unique_name(&root, &sanitize_stem(name), &format!(".{DOC_EXT}"));
    let target = root.join(file);
    let stamp = create_new_atomic(&target, bytes)?;
    let handle = state.grant_file(&target)?;
    let grant = state.file(&handle)?;
    remember_file(state, &grant.path, &grant.name);
    Ok(SavedAs {
        handle,
        display_path: display_path(&grant.path),
        name: grant.name,
        stamp,
    })
}

#[tauri::command]
pub async fn project_save_new(app: AppHandle, request: Request<'_>) -> Result<SavedAs, AppError> {
    let (meta, bytes) = raw_request::<NewInProjectMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |app, state| {
        let saved = create_in_project(state, &meta.project_handle, &meta.name, &bytes)?;
        recents_changed(app);
        Ok(saved)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::{doc, test_state};
    use crate::docio::{check_stamp, StampCheck};
    use crate::errors::ErrorKind;
    use crate::recents::RecentKind;
    use serde_json::json;
    use std::fs;

    #[test]
    fn opening_a_project_grants_names_and_remembers_it() {
        let (dir, state) = test_state();
        let folder = dir.path().join("Payments");
        fs::create_dir(&folder).unwrap();
        let info = open_project_at(&state, &folder).unwrap();
        assert_eq!(info.name, "Payments");
        assert!(info.display_path.ends_with("Payments"));
        assert_eq!(
            state.project(&info.handle).unwrap().root,
            dunce::canonicalize(&folder).unwrap()
        );

        let recents = state.recents.list().unwrap().items;
        assert_eq!(
            (recents[0].kind, recents[0].name.as_str()),
            (RecentKind::Project, "Payments")
        );
        let settings = state.settings.get();
        assert_eq!(settings.last_project.unwrap().name, "Payments");
        assert_eq!(
            settings.last_dir.as_deref(),
            dunce::canonicalize(&folder).unwrap().to_str()
        );
    }

    #[test]
    fn a_file_is_not_a_project() {
        let (dir, state) = test_state();
        let file = doc(&dir, "a.draftcanvas", "{}");
        assert_eq!(
            open_project_at(&state, &file).err().unwrap().kind,
            ErrorKind::InvalidPath
        );
        assert!(state.recents.list().unwrap().items.is_empty());
    }

    #[test]
    fn scan_and_open_go_through_the_project_handle() {
        let (dir, state) = test_state();
        doc(&dir, "proj/a.draftcanvas", "{\"a\":1}");
        doc(&dir, "proj/sub/b.draftcanvas", "{\"b\":2}");
        let info = open_project_at(&state, &dir.path().join("proj")).unwrap();

        let listing = scan(
            &state.project(&info.handle).unwrap().root,
            &Limits::default(),
        )
        .unwrap();
        let rels: Vec<&str> = listing.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, ["a.draftcanvas", "sub/b.draftcanvas"]);

        let path = state
            .resolve_in_project(&info.handle, "sub/b.draftcanvas")
            .unwrap();
        let opened = opened_doc(&state, &path).unwrap();
        assert_eq!(
            (opened.name.as_str(), opened.text.as_str()),
            ("b", "{\"b\":2}")
        );
        assert!(state
            .resolve_in_project(&info.handle, "../outside.draftcanvas")
            .is_err());
        assert!(state
            .resolve_in_project("h_unknown", "a.draftcanvas")
            .is_err());
    }

    #[test]
    fn new_canvases_take_the_first_free_name_and_never_overwrite() {
        let (dir, state) = test_state();
        fs::create_dir(dir.path().join("proj")).unwrap();
        let info = open_project_at(&state, &dir.path().join("proj")).unwrap();

        let first =
            create_in_project(&state, &info.handle, "Untitled canvas", b"{\"n\":1}").unwrap();
        let second =
            create_in_project(&state, &info.handle, "Untitled canvas", b"{\"n\":2}").unwrap();
        let third = create_in_project(
            &state,
            &info.handle,
            "Untitled canvas.draftcanvas",
            b"{\"n\":3}",
        )
        .unwrap();
        assert_eq!(
            [
                first.name.as_str(),
                second.name.as_str(),
                third.name.as_str()
            ],
            ["Untitled canvas", "Untitled canvas 2", "Untitled canvas 3"]
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("proj/Untitled canvas.draftcanvas")).unwrap(),
            "{\"n\":1}"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("proj/Untitled canvas 2.draftcanvas")).unwrap(),
            "{\"n\":2}"
        );
        assert_eq!(
            check_stamp(
                &dir.path().join("proj/Untitled canvas 3.draftcanvas"),
                &third.stamp
            ),
            StampCheck::Unchanged
        );
        assert_ne!(first.handle, second.handle);
        assert_eq!(
            state.file(&second.handle).unwrap().name,
            "Untitled canvas 2"
        );
    }

    #[test]
    fn a_suggested_name_cannot_leave_the_project_folder() {
        let (dir, state) = test_state();
        fs::create_dir(dir.path().join("proj")).unwrap();
        let info = open_project_at(&state, &dir.path().join("proj")).unwrap();
        let saved = create_in_project(&state, &info.handle, "../../escape", b"{}").unwrap();
        let path = state.file(&saved.handle).unwrap().path;
        assert_eq!(
            path.parent().unwrap(),
            dunce::canonicalize(dir.path().join("proj")).unwrap()
        );
        assert!(!dir.path().join("escape.draftcanvas").exists());
    }

    #[test]
    fn creating_needs_a_project_handle() {
        let (dir, state) = test_state();
        let file_handle = state.grant_file(&doc(&dir, "a.draftcanvas", "{}")).unwrap();
        for handle in ["h_unknown", file_handle.as_str()] {
            assert_eq!(
                create_in_project(&state, handle, "x", b"{}")
                    .err()
                    .unwrap()
                    .kind,
                ErrorKind::InvalidHandle
            );
        }
    }

    #[test]
    fn the_wire_shapes_match_the_typescript_types() {
        let info = ProjectInfo {
            handle: "h_1".into(),
            name: "P".into(),
            display_path: "~/P".into(),
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({"handle": "h_1", "name": "P", "displayPath": "~/P"})
        );
        let meta: NewInProjectMeta =
            serde_json::from_value(json!({"projectHandle": "h_2", "name": "Untitled canvas"}))
                .unwrap();
        assert_eq!(
            (meta.project_handle.as_str(), meta.name.as_str()),
            ("h_2", "Untitled canvas")
        );
    }
}
