//! The page can browse only locations Rust handed it. Committing a project or opening a file uses
//! the same grant, persistence and watcher paths as native-opened documents, without any OS dialog.
use super::documents::{complete_save_as, opened_doc, OpenedDoc, SavedAs, StartLocation};
use super::projects::{open_project_at, ProjectInfo};
use super::raw::raw_request;
use super::{last_dir, recents_changed, run_blocking};
use crate::docio::{self, WriteOutcome};
use crate::errors::AppError;
use crate::errors::ErrorKind;
use crate::explorer::{
    self, ExplorerDirectory, ExplorerKind, ExplorerLocation, ExplorerPlace, ExplorerStart,
};
use crate::paths::{validate_rename_stem, DOC_EXT};
use crate::state::AppState;
use crate::state::HostEvent;
use crate::util::lock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager};

fn start(
    state: &AppState,
    home: PathBuf,
    places: Vec<(String, PathBuf, bool)>,
) -> Result<ExplorerStart, AppError> {
    let (id, session) = lock(&state.explorer).start();
    let places: Vec<ExplorerPlace> = places
        .into_iter()
        .filter_map(|(name, path, project)| explorer::place(&session, &path, &name, project))
        .collect();
    let initial = last_dir(state).unwrap_or(home.clone());
    let read = |path: &std::path::Path| {
        let location = explorer::place(&session, path, "", false)
            .ok_or_else(|| AppError::invalid_path("That folder could not be found."))?
            .location;
        explorer::directory(&session, &location.handle, false, "", 0)
    };
    // A disconnected drive or a folder whose permissions changed must not strand the browser.
    let directory = read(&initial).or_else(|_| read(&home));
    match directory {
        Ok(directory) => Ok(ExplorerStart {
            session: id,
            places,
            directory,
        }),
        Err(error) => {
            lock(&state.explorer).close(&id);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn explorer_open(
    app: AppHandle,
    start_in: Option<StartLocation>,
) -> Result<ExplorerStart, AppError> {
    run_blocking(&app, move |app, state| {
        let resolver = app.path();
        let home = resolver.home_dir().map_err(|_| AppError::internal())?;
        let mut places = vec![("Home".to_string(), home.clone(), false)];
        for (name, path) in [
            ("Desktop", resolver.desktop_dir()),
            ("Documents", resolver.document_dir()),
            ("Downloads", resolver.download_dir()),
        ] {
            if let Ok(path) = path {
                places.push((name.to_string(), path, false));
            }
        }
        #[cfg(unix)]
        places.push(("Computer".to_string(), PathBuf::from("/"), false));
        #[cfg(target_os = "macos")]
        places.push(("Volumes".to_string(), PathBuf::from("/Volumes"), false));
        #[cfg(windows)]
        for drive in b'A'..=b'Z' {
            let path = PathBuf::from(format!("{}:\\", drive as char));
            if path.is_dir() {
                places.push((format!("Drive {}:", drive as char), path, false));
            }
        }
        places.extend(
            state
                .settings
                .get()
                .projects
                .into_iter()
                .map(|project| (project.name, PathBuf::from(project.path), true)),
        );
        let mut opened = start(state, home, places)?;
        if let Some(path) = start_in.and_then(|location| {
            state
                .resolve_folder_in_project(&location.project_handle, &location.rel_path)
                .ok()
        }) {
            let session = lock(&state.explorer).session(&opened.session)?;
            if let Some(place) = explorer::place(&session, &path, "", false) {
                if let Ok(directory) =
                    explorer::directory(&session, &place.location.handle, false, "", 0)
                {
                    opened.directory = directory;
                }
            }
        }
        Ok(opened)
    })
    .await
}

#[tauri::command]
pub async fn explorer_list(
    app: AppHandle,
    session: String,
    handle: String,
    show_hidden: bool,
    query: String,
    offset: usize,
) -> Result<ExplorerDirectory, AppError> {
    run_blocking(&app, move |_, state| {
        let session = lock(&state.explorer).session(&session)?;
        explorer::directory(&session, &handle, show_hidden, &query, offset)
    })
    .await
}

#[tauri::command]
pub async fn explorer_create_folder(
    app: AppHandle,
    session: String,
    handle: String,
    name: String,
) -> Result<ExplorerLocation, AppError> {
    run_blocking(&app, move |_, state| {
        let session = lock(&state.explorer).session(&session)?;
        explorer::create_folder(&session, &handle, &name)
    })
    .await
}

#[tauri::command]
pub async fn explorer_peek(
    app: AppHandle,
    session: String,
    handle: String,
) -> Result<Option<String>, AppError> {
    run_blocking(&app, move |_, state| {
        let session = lock(&state.explorer).session(&session)?;
        let path = explorer::checked_path(&session, &handle, ExplorerKind::File)?;
        Ok(super::peek::peek_path(&path))
    })
    .await
}

#[tauri::command]
pub async fn explorer_add_project(
    app: AppHandle,
    session: String,
    handle: String,
) -> Result<ProjectInfo, AppError> {
    run_blocking(&app, move |app, state| {
        let session = lock(&state.explorer).session(&session)?;
        let path = explorer::checked_path(&session, &handle, ExplorerKind::Folder)?;
        let info = open_project_at(state, &path)?;
        recents_changed(app);
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn explorer_open_file(
    app: AppHandle,
    session: String,
    handle: String,
) -> Result<OpenedDoc, AppError> {
    run_blocking(&app, move |app, state| {
        let session = lock(&state.explorer).session(&session)?;
        let path = explorer::checked_path(&session, &handle, ExplorerKind::File)?;
        let doc = opened_doc(state, &path)?;
        recents_changed(app);
        Ok(doc)
    })
    .await
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum ExplorerSaveResult {
    Saved { saved: SavedAs },
    Exists { name: String, stamp: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplorerSaveMeta {
    session: String,
    handle: String,
    name: String,
    expected_stamp: Option<String>,
    copy_sidecar_from: Option<String>,
}

/// A name is joined only to an explorer-issued folder. Writes are exclusive until the person
/// confirms the target's content stamp; a changed target requires a fresh confirmation.
fn save_file(
    state: &AppState,
    meta: &ExplorerSaveMeta,
    bytes: &[u8],
) -> Result<(ExplorerSaveResult, Option<String>), AppError> {
    docio::ensure_document_size(bytes.len())?;
    let session = lock(&state.explorer).session(&meta.session)?;
    let root = explorer::checked_path(&session, &meta.handle, ExplorerKind::Folder)?;
    let stem = validate_rename_stem(&meta.name)?;
    let target = root.join(format!("{stem}.{DOC_EXT}"));
    let source = meta
        .copy_sidecar_from
        .as_deref()
        .map(|handle| state.file(handle))
        .transpose()?;
    let exists = || -> Result<(ExplorerSaveResult, Option<String>), AppError> {
        let metadata = std::fs::symlink_metadata(&target).map_err(|error| {
            AppError::from_io(
                &error,
                crate::errors::Verb::Open,
                crate::errors::Subject::Path(&target),
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AppError::invalid_path(
                "That name belongs to a folder or shortcut. Choose another file name.",
            ));
        }
        let stamp = docio::read_document(&target)?.stamp;
        Ok((
            ExplorerSaveResult::Exists {
                name: format!("{stem}.{DOC_EXT}"),
                stamp,
            },
            None,
        ))
    };
    let stamp = if let Some(expected) = meta.expected_stamp.as_deref() {
        // Refuse aliases into another folder even when a page supplies a matching content stamp.
        let canonical = crate::grants::validate_file(&target)?;
        if canonical.parent() != Some(root.as_path())
            || std::fs::symlink_metadata(&target)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true)
        {
            return Err(AppError::invalid_path(
                "Choose the file's own folder to replace it.",
            ));
        }
        match docio::write_atomic(&target, bytes, Some(expected))? {
            WriteOutcome::Saved { stamp } => stamp,
            WriteOutcome::Conflict => return exists(),
        }
    } else {
        match docio::create_new_atomic(&target, bytes) {
            Ok(stamp) => stamp,
            Err(error) if error.kind == ErrorKind::AlreadyExists => return exists(),
            Err(error) => return Err(error),
        }
    };
    let (saved, warning) = complete_save_as(state, &target, stamp, source.as_ref())?;
    Ok((ExplorerSaveResult::Saved { saved }, warning))
}

#[tauri::command]
pub async fn explorer_save_file(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ExplorerSaveResult, AppError> {
    let (meta, bytes) = raw_request::<ExplorerSaveMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |app, state| {
        let (result, warning) = save_file(state, &meta, &bytes)?;
        if let Some(message) = warning {
            state.events.emit(HostEvent::Notice { message });
        }
        if matches!(result, ExplorerSaveResult::Saved { .. }) {
            recents_changed(app);
        }
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn explorer_close(app: AppHandle, session: String) -> Result<(), AppError> {
    lock(&app.state::<AppState>().explorer).close(&session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::test_state;

    fn save_meta(state: &AppState, root: &std::path::Path, name: &str) -> ExplorerSaveMeta {
        let opened = start(state, root.to_path_buf(), vec![]).unwrap();
        ExplorerSaveMeta {
            session: opened.session,
            handle: opened.directory.location.handle,
            name: name.into(),
            expected_stamp: None,
            copy_sidecar_from: None,
        }
    }

    #[test]
    fn save_creates_a_file_and_requires_fresh_confirmation_before_replacement() {
        let (dir, state) = test_state();
        let mut meta = save_meta(&state, dir.path(), "Copy");
        assert!(matches!(
            save_file(&state, &meta, b"first").unwrap().0,
            ExplorerSaveResult::Saved { .. }
        ));
        let path = dir.path().join("Copy.draftcanvas");
        let ExplorerSaveResult::Exists { stamp, .. } =
            save_file(&state, &meta, b"second").unwrap().0
        else {
            panic!("must ask before replacing")
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        std::fs::write(&path, b"outside edit").unwrap();
        meta.expected_stamp = Some(stamp);
        let ExplorerSaveResult::Exists { stamp, .. } =
            save_file(&state, &meta, b"second").unwrap().0
        else {
            panic!("must ask again after an outside edit")
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"outside edit");
        meta.expected_stamp = Some(stamp);
        assert!(matches!(
            save_file(&state, &meta, b"second").unwrap().0,
            ExplorerSaveResult::Saved { .. }
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn save_refuses_paths_invalid_handles_and_folders_without_writing() {
        let (dir, state) = test_state();
        let mut meta = save_meta(&state, dir.path(), "../outside");
        assert_eq!(
            save_file(&state, &meta, b"content").unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        meta.name = "Folder".into();
        std::fs::create_dir(dir.path().join("Folder.draftcanvas")).unwrap();
        assert!(save_file(&state, &meta, b"content").is_err());
        meta.name = "Untouched".into();
        meta.handle = "invented".into();
        assert_eq!(
            save_file(&state, &meta, b"content").unwrap_err().kind,
            ErrorKind::InvalidHandle
        );
        assert!(!dir.path().join("Untouched.draftcanvas").exists());
    }

    #[test]
    fn save_copies_the_background_beside_the_new_diagram() {
        let (dir, state) = test_state();
        let source = dir.path().join("Original.draftcanvas");
        std::fs::write(&source, b"original").unwrap();
        docio::sidecar_write(&source, "image/png", b"image bytes").unwrap();
        let source_handle = state.grant_file(&source).unwrap();
        let mut meta = save_meta(&state, dir.path(), "Copy.draftcanvas");
        meta.copy_sidecar_from = Some(source_handle);
        let (result, warning) = save_file(&state, &meta, b"copy").unwrap();
        let ExplorerSaveResult::Saved { saved } = result else {
            panic!("new copy should save")
        };
        let target = state.file(&saved.handle).unwrap().path;
        assert!(warning.is_none());
        assert_eq!(
            docio::sidecar_read(&target).unwrap().unwrap().bytes,
            b"image bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn save_never_replaces_a_symlink_target() {
        let (dir, state) = test_state();
        let outside = dir.path().join("outside.draftcanvas");
        std::fs::write(&outside, b"untouched").unwrap();
        std::os::unix::fs::symlink(&outside, dir.path().join("Alias.draftcanvas")).unwrap();
        let mut meta = save_meta(&state, dir.path(), "Alias");
        assert!(save_file(&state, &meta, b"overwrite").is_err());
        meta.expected_stamp = Some(docio::read_document(&outside).unwrap().stamp);
        assert!(save_file(&state, &meta, b"overwrite").is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }

    #[test]
    fn missing_initial_location_fails_or_falls_back_home() {
        let (dir, state) = test_state();
        let missing = dir.path().join("missing");
        assert!(start(&state, missing.clone(), vec![]).is_err());
        state
            .settings
            .update(|settings| settings.last_dir = Some(missing.to_string_lossy().to_string()))
            .unwrap();
        let opened = start(&state, dir.path().to_path_buf(), vec![]).unwrap();
        assert_eq!(
            opened.directory.location.display_path,
            crate::paths::display_path(&dunce::canonicalize(dir.path()).unwrap())
        );
    }

    #[test]
    fn browsing_does_not_register_a_project_or_change_recents() {
        let (dir, state) = test_state();
        let explorer = start(&state, dir.path().to_path_buf(), vec![]).unwrap();
        assert!(state.settings.get().projects.is_empty());
        assert!(state.recents.list().unwrap().items.is_empty());
        assert!(state.project(&explorer.directory.location.handle).is_err());
        let session = lock(&state.explorer).session(&explorer.session).unwrap();
        let created =
            explorer::create_folder(&session, &explorer.directory.location.handle, "New ideas")
                .unwrap();
        assert_eq!(created.name, "New ideas");
        assert!(state.settings.get().projects.is_empty());
        assert!(state.recents.list().unwrap().items.is_empty());
        assert!(state.project(&created.handle).is_err());
        let path = explorer::checked_path(
            &session,
            &explorer.directory.location.handle,
            ExplorerKind::Folder,
        )
        .unwrap();
        let project = open_project_at(&state, &path).unwrap();
        assert_eq!(state.settings.get().projects.len(), 1);
        assert!(state.project(&project.handle).is_ok());
    }
}
