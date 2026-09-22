//! Opening, saving and exporting documents, and the background image that sits beside one.

use super::raw::raw_request;
use super::{last_dir, recents_changed, remember_dir, remember_file, run_blocking};
use crate::dialogs::{self, FileFilter};
use crate::docio::{
    self, ensure_document_size, is_read_only, read_document, rename_atomic, write_atomic,
    write_unconditional, StampCheck, WriteOutcome, MAX_SIDECAR_BYTES,
};
use crate::errors::{AppError, ErrorKind, Verb};
use crate::grants::{FileGrant, Handle};
use crate::paths::{display_path, force_doc_ext, sanitize_stem, validate_rename_stem, DOC_EXT};
use crate::state::{AppState, HostEvent};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::ipc::Request;
use tauri::{AppHandle, Url};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDoc {
    pub handle: Handle,
    pub name: String,
    pub display_path: String,
    pub text: String,
    pub stamp: String,
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAs {
    pub handle: Handle,
    pub name: String,
    pub display_path: String,
    pub stamp: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum SaveResult {
    Saved { stamp: String },
    Conflict,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarPayload {
    pub mime: String,
    pub base64: String,
}

/// Grants the file, reads it, and puts it at the top of Recent: everything "open" means, whether the
/// path came from a dialog, the OS, a project, or a recent entry.
pub(crate) fn opened_doc(state: &AppState, path: &Path) -> Result<OpenedDoc, AppError> {
    let handle = state.grant_file(path)?;
    let grant = state.file(&handle)?;
    let doc = read_document(&grant.path)?;
    remember_file(state, &grant.path, &grant.name);
    Ok(OpenedDoc {
        handle,
        display_path: display_path(&grant.path),
        read_only: is_read_only(&grant.path),
        name: grant.name,
        text: doc.text,
        stamp: doc.stamp,
    })
}

#[tauri::command]
pub async fn open_dialog(app: AppHandle) -> Result<Option<OpenedDoc>, AppError> {
    run_blocking(&app, |app, state| {
        let Some(path) = dialogs::pick_file(app, last_dir(state)) else {
            return Ok(None);
        };
        let doc = opened_doc(state, &path)?;
        recents_changed(app);
        Ok(Some(doc))
    })
    .await
}

#[tauri::command]
pub async fn open_handle(app: AppHandle, handle: String) -> Result<OpenedDoc, AppError> {
    run_blocking(&app, move |app, state| {
        let grant = state.file(&handle)?;
        let doc = opened_doc(state, &grant.path)?;
        recents_changed(app);
        Ok(doc)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveMeta {
    handle: Handle,
    expected_stamp: Option<String>,
}

fn save_document_now(
    state: &AppState,
    meta: &SaveMeta,
    bytes: &[u8],
) -> Result<SaveResult, AppError> {
    ensure_document_size(bytes.len())?;
    let grant = state.file(&meta.handle)?;
    Ok(
        match write_atomic(&grant.path, bytes, meta.expected_stamp.as_deref())? {
            WriteOutcome::Saved { stamp } => SaveResult::Saved { stamp },
            WriteOutcome::Conflict => SaveResult::Conflict,
        },
    )
}

#[tauri::command]
pub async fn save_document(app: AppHandle, request: Request<'_>) -> Result<SaveResult, AppError> {
    let (meta, bytes) = raw_request::<SaveMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |_, state| {
        save_document_now(state, &meta, &bytes)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartLocation {
    project_handle: Handle,
    rel_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAsMeta {
    suggested_name: String,
    copy_sidecar_from: Option<Handle>,
    /// Where a canvas created inside a project (but never written to disk) remembers it should be saved:
    /// the dialog opens there when the folder still exists, and falls back to the last-used folder
    /// otherwise — a missing destination is never a reason to refuse the dialog itself.
    start_in: Option<StartLocation>,
}

/// Saves to the path the person chose, grants it, and (if asked) brings the background image along.
/// The second value is a warning for when the document saved but the image couldn't be copied.
fn finish_save_as(
    state: &AppState,
    chosen: &Path,
    bytes: &[u8],
    copy_sidecar_from: Option<&FileGrant>,
) -> Result<(SavedAs, Option<String>), AppError> {
    // The dialog confirmed replacing exactly what was typed. If the extension had to be added, it
    // is a different file the person was never asked about, so an existing one is not overwritten.
    let target = force_doc_ext(chosen.to_path_buf());
    if target != chosen && fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::already_exists(&target));
    }
    let stamp = write_unconditional(&target, bytes)?;
    let handle = state.grant_file(&target)?;
    let grant = state.file(&handle)?;
    let warning = copy_sidecar_from
        .and_then(|from| docio::sidecar_copy(&from.path, &grant.path).err())
        .map(|e| {
            format!(
                "Saved {}, but its background image wasn't copied. {}",
                grant.name, e.message
            )
        });
    remember_file(state, &grant.path, &grant.name);
    let saved = SavedAs {
        handle,
        display_path: display_path(&grant.path),
        name: grant.name,
        stamp,
    };
    Ok((saved, warning))
}

/// Where the Save As dialog should open: the folder a pending canvas remembers, when it can still be
/// resolved (the project is still registered and the folder still exists), or the last folder used
/// otherwise. A remembered folder that no longer resolves is never a reason to refuse the dialog.
fn resolve_start_dir(
    state: &AppState,
    start_in: Option<&StartLocation>,
) -> Option<std::path::PathBuf> {
    start_in
        .and_then(|start| {
            state
                .resolve_folder_in_project(&start.project_handle, &start.rel_path)
                .ok()
        })
        .or_else(|| last_dir(state))
}

#[tauri::command]
pub async fn save_as(app: AppHandle, request: Request<'_>) -> Result<Option<SavedAs>, AppError> {
    let (meta, bytes) = raw_request::<SaveAsMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |app, state| {
        ensure_document_size(bytes.len())?;
        let source = meta
            .copy_sidecar_from
            .as_deref()
            .map(|h| state.file(h))
            .transpose()?;
        let suggestion = format!("{}.{DOC_EXT}", sanitize_stem(&meta.suggested_name));
        let filters = [FileFilter {
            name: "Draft Canvas diagram".to_string(),
            extensions: vec![DOC_EXT.to_string()],
        }];
        let start_dir = resolve_start_dir(state, meta.start_in.as_ref());
        let Some(chosen) = dialogs::save_file(app, start_dir, &suggestion, &filters) else {
            return Ok(None);
        };
        let (saved, warning) = finish_save_as(state, &chosen, &bytes, source.as_ref())?;
        if let Some(message) = warning {
            state.events.emit(HostEvent::Notice { message });
        }
        recents_changed(app);
        Ok(Some(saved))
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamedFile {
    pub handle: Handle,
    pub name: String,
    pub display_path: String,
}

/// "Rename file…": changes the file's name in place, in the same folder. Never a move (the target is
/// always the source's own parent), never an overwrite of a different document, and never a touch of the
/// document's own `metadata.title` — only what the filesystem calls it.
fn rename_file_now(
    state: &AppState,
    handle: &str,
    new_stem: &str,
) -> Result<RenamedFile, AppError> {
    let grant = state.file(handle)?;
    let stem = validate_rename_stem(new_stem)?;
    let target = grant.path.with_file_name(format!("{stem}.{DOC_EXT}"));
    rename_atomic(&grant.path, &target)?;
    // The old handle now names a path that is gone; a fresh one is minted for the new path, and the page
    // is the one that swaps it in for whatever session was using the old one.
    let new_handle = state.grant_file(&target)?;
    let new_grant = state.file(&new_handle)?;
    if let Some(sidecar) = docio::sidecar_read(&grant.path).unwrap_or(None) {
        let _ = docio::sidecar_write(&new_grant.path, sidecar.mime, &sidecar.bytes);
        let _ = docio::sidecar_remove(&grant.path);
    }
    state
        .recents
        .rename(&grant.path, &new_grant.path, &new_grant.name)?;
    Ok(RenamedFile {
        handle: new_handle,
        display_path: display_path(&new_grant.path),
        name: new_grant.name,
    })
}

#[tauri::command]
pub async fn rename_file(
    app: AppHandle,
    handle: String,
    new_stem: String,
) -> Result<RenamedFile, AppError> {
    run_blocking(&app, move |app, state| {
        let renamed = rename_file_now(state, &handle, &new_stem)?;
        recents_changed(app);
        Ok(renamed)
    })
    .await
}

#[tauri::command]
pub async fn check_stamp(
    app: AppHandle,
    handle: String,
    stamp: String,
) -> Result<StampCheck, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(docio::check_stamp(&state.file(&handle)?.path, &stamp))
    })
    .await
}

#[tauri::command]
pub async fn reveal(app: AppHandle, handle: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        let grant = state.file(&handle)?;
        tauri_plugin_opener::reveal_item_in_dir(&grant.path).map_err(|_| {
            AppError::new(
                ErrorKind::Io,
                "Draft Canvas couldn't show that file in the file manager.",
            )
        })
    })
    .await
}

#[derive(Debug, Deserialize)]
struct ExportMeta {
    name: String,
    filters: Vec<FileFilter>,
}

/// Saves an export (a PNG, an SVG, Mermaid text) wherever the person chooses. The save dialog is the
/// permission: the page names only a suggested file name, never a place.
#[tauri::command]
pub async fn export_file(app: AppHandle, request: Request<'_>) -> Result<bool, AppError> {
    let (meta, bytes) = raw_request::<ExportMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |app, state| {
        let Some(path) = dialogs::save_file(app, last_dir(state), &meta.name, &meta.filters) else {
            return Ok(false);
        };
        write_unconditional(&path, &bytes)?;
        remember_dir(state, path.parent());
        Ok(true)
    })
    .await
}

/// Only web and mail links leave the app: anything else (`file:`, `javascript:`, another app's URL
/// scheme) is refused, since the text comes from a page that may be showing content from a document.
fn checked_external_url(text: &str) -> Result<Url, AppError> {
    let refused = || AppError::invalid_path("That isn't a link Draft Canvas can open.");
    let url = Url::parse(text.trim()).map_err(|_| refused())?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url),
        "mailto" => Ok(url),
        _ => Err(refused()),
    }
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), AppError> {
    let url = checked_external_url(&url)?;
    run_blocking(&app, move |_, _| {
        tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
            .map_err(|_| AppError::new(ErrorKind::Io, "Draft Canvas couldn't open that link."))
    })
    .await
}

fn read_sidecar(state: &AppState, handle: &str) -> Result<Option<SidecarPayload>, AppError> {
    let grant = state.file(handle)?;
    Ok(docio::sidecar_read(&grant.path)?.map(|s| SidecarPayload {
        mime: s.mime.to_string(),
        base64: STANDARD.encode(&s.bytes),
    }))
}

fn write_sidecar(state: &AppState, handle: &str, mime: &str, base64: &str) -> Result<(), AppError> {
    let grant = state.file(handle)?;
    // Base64 is 4 characters per 3 bytes: refuse an absurd payload before spending memory decoding it.
    if base64.len() > (MAX_SIDECAR_BYTES as usize / 3 + 1) * 4 {
        return Err(AppError::too_large(
            &grant.path,
            Verb::Save,
            MAX_SIDECAR_BYTES,
        ));
    }
    let bytes = STANDARD
        .decode(base64.as_bytes())
        .map_err(|_| AppError::bad_request("the image isn't valid base64"))?;
    docio::sidecar_write(&grant.path, mime, &bytes)
}

#[tauri::command]
pub async fn sidecar_read(
    app: AppHandle,
    handle: String,
) -> Result<Option<SidecarPayload>, AppError> {
    run_blocking(&app, move |_, state| read_sidecar(state, &handle)).await
}

#[tauri::command]
pub async fn sidecar_write(
    app: AppHandle,
    handle: String,
    mime: String,
    base64: String,
) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        write_sidecar(state, &handle, &mime, &base64)
    })
    .await
}

#[tauri::command]
pub async fn sidecar_remove(app: AppHandle, handle: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        docio::sidecar_remove(&state.file(&handle)?.path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::{doc, test_state};
    use crate::recents::RecentKind;
    use serde_json::json;

    #[test]
    fn opening_grants_reads_and_remembers() {
        let (dir, state) = test_state();
        let path = doc(&dir, "payment-flow.draftcanvas", "{\"v\":1}");
        let opened = opened_doc(&state, &path).unwrap();

        assert_eq!(opened.name, "payment-flow");
        assert_eq!(opened.text, "{\"v\":1}");
        assert!(!opened.read_only);
        assert!(opened.display_path.ends_with("payment-flow.draftcanvas"));
        assert_eq!(
            state.file(&opened.handle).unwrap().path,
            dunce::canonicalize(&path).unwrap()
        );
        assert_eq!(
            docio::check_stamp(&path, &opened.stamp),
            StampCheck::Unchanged
        );

        let recents = state.recents.list().unwrap().items;
        assert_eq!(recents.len(), 1);
        assert_eq!(
            (recents[0].kind, recents[0].name.as_str()),
            (RecentKind::File, "payment-flow")
        );
        assert_eq!(
            state.settings.get().last_dir.as_deref(),
            dunce::canonicalize(dir.path()).unwrap().to_str()
        );
    }

    #[test]
    fn opening_the_same_file_again_reuses_its_handle_and_keeps_one_recent_entry() {
        let (dir, state) = test_state();
        let path = doc(&dir, "a.draftcanvas", "{}");
        let first = opened_doc(&state, &path).unwrap();
        let second = opened_doc(&state, &path).unwrap();
        assert_eq!(first.handle, second.handle);
        assert_eq!(state.recents.list().unwrap().items.len(), 1);
    }

    #[test]
    fn a_read_only_file_opens_flagged_read_only() {
        let (dir, state) = test_state();
        let path = doc(&dir, "locked.draftcanvas", "{}");
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms).unwrap();
        assert!(opened_doc(&state, &path).unwrap().read_only);
    }

    #[test]
    fn opening_refuses_what_is_not_a_document() {
        let (dir, state) = test_state();
        let text = doc(&dir, "notes.txt", "hi");
        assert_eq!(
            opened_doc(&state, &text).err().unwrap().kind,
            ErrorKind::NotADocument
        );
        let binary = dir.path().join("bin.draftcanvas");
        fs::write(&binary, [0xff, 0xfe]).unwrap();
        assert_eq!(
            opened_doc(&state, &binary).err().unwrap().kind,
            ErrorKind::NotADocument
        );
        let missing = dir.path().join("gone.draftcanvas");
        assert_eq!(
            opened_doc(&state, &missing).err().unwrap().kind,
            ErrorKind::NotFound
        );
        assert!(state.recents.list().unwrap().items.is_empty());
    }

    #[test]
    fn saving_through_a_handle_returns_the_new_stamp() {
        let (dir, state) = test_state();
        let path = doc(&dir, "a.draftcanvas", "old");
        let opened = opened_doc(&state, &path).unwrap();
        let meta = SaveMeta {
            handle: opened.handle.clone(),
            expected_stamp: Some(opened.stamp.clone()),
        };
        let SaveResult::Saved { stamp } = save_document_now(&state, &meta, b"new").unwrap() else {
            panic!("expected a save");
        };
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let again = SaveMeta {
            handle: opened.handle,
            expected_stamp: Some(stamp),
        };
        assert!(matches!(
            save_document_now(&state, &again, b"newer").unwrap(),
            SaveResult::Saved { .. }
        ));
    }

    #[test]
    fn saving_over_an_outside_change_is_a_conflict_not_an_error() {
        let (dir, state) = test_state();
        let path = doc(&dir, "a.draftcanvas", "mine");
        let opened = opened_doc(&state, &path).unwrap();
        fs::write(&path, "someone else's longer edit").unwrap();
        let meta = SaveMeta {
            handle: opened.handle,
            expected_stamp: Some(opened.stamp),
        };
        assert_eq!(
            save_document_now(&state, &meta, b"mine again").unwrap(),
            SaveResult::Conflict
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "someone else's longer edit"
        );
    }

    #[test]
    fn saving_needs_a_handle_rust_issued() {
        let (_dir, state) = test_state();
        let meta = SaveMeta {
            handle: "h_made-up".into(),
            expected_stamp: None,
        };
        assert_eq!(
            save_document_now(&state, &meta, b"x").err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
    }

    #[test]
    fn saving_without_a_stamp_replaces_whatever_is_there() {
        let (dir, state) = test_state();
        let path = doc(&dir, "a.draftcanvas", "old");
        let opened = opened_doc(&state, &path).unwrap();
        fs::write(&path, "changed elsewhere").unwrap();
        let meta = SaveMeta {
            handle: opened.handle,
            expected_stamp: None,
        };
        assert!(matches!(
            save_document_now(&state, &meta, b"forced").unwrap(),
            SaveResult::Saved { .. }
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "forced");
    }

    #[test]
    fn save_as_starts_in_the_folder_a_pending_canvas_remembered() {
        let (dir, state) = test_state();
        fs::create_dir_all(dir.path().join("proj/sub")).unwrap();
        let project = state.grant_project(&dir.path().join("proj")).unwrap();
        let start = StartLocation {
            project_handle: project,
            rel_path: "sub".to_string(),
        };
        assert_eq!(
            resolve_start_dir(&state, Some(&start)).unwrap(),
            dunce::canonicalize(dir.path().join("proj/sub")).unwrap()
        );
    }

    #[test]
    fn save_as_falls_back_to_last_dir_when_the_remembered_folder_no_longer_exists() {
        let (dir, state) = test_state();
        fs::create_dir(dir.path().join("proj")).unwrap();
        let project = state.grant_project(&dir.path().join("proj")).unwrap();
        state
            .settings
            .update(|s| s.last_dir = dir.path().to_str().map(str::to_string))
            .unwrap();
        let start = StartLocation {
            project_handle: project,
            rel_path: "gone".to_string(),
        };
        assert_eq!(resolve_start_dir(&state, Some(&start)).unwrap(), dir.path());
        assert_eq!(resolve_start_dir(&state, None).unwrap(), dir.path());
    }

    #[test]
    fn save_as_forces_the_extension_grants_and_remembers() {
        let (dir, state) = test_state();
        let chosen = dir.path().join("plan.v2");
        let (saved, warning) = finish_save_as(&state, &chosen, b"{\"x\":1}", None).unwrap();
        assert!(warning.is_none());
        assert_eq!(saved.name, "plan.v2");
        assert!(saved.display_path.ends_with("plan.v2.draftcanvas"));
        assert_eq!(
            fs::read_to_string(dir.path().join("plan.v2.draftcanvas")).unwrap(),
            "{\"x\":1}"
        );
        assert!(!chosen.exists());
        assert_eq!(state.file(&saved.handle).unwrap().name, "plan.v2");
        assert_eq!(state.recents.list().unwrap().items.len(), 1);
        assert_eq!(
            docio::check_stamp(&dir.path().join("plan.v2.draftcanvas"), &saved.stamp),
            StampCheck::Unchanged
        );
    }

    #[test]
    fn save_as_replaces_the_exact_file_the_dialog_confirmed() {
        let (dir, state) = test_state();
        let existing = doc(&dir, "a.draftcanvas", "old");
        let (saved, _) = finish_save_as(&state, &existing, b"new", None).unwrap();
        assert_eq!(fs::read_to_string(&existing).unwrap(), "new");
        assert_eq!(saved.name, "a");
    }

    #[test]
    fn save_as_will_not_overwrite_a_file_the_person_was_never_asked_about() {
        let (dir, state) = test_state();
        let other = doc(&dir, "notes.draftcanvas", "precious");
        let err = finish_save_as(&state, &dir.path().join("notes"), b"new", None)
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(other).unwrap(), "precious");
    }

    #[test]
    fn save_as_carries_the_background_image_along() {
        let (dir, state) = test_state();
        let from = doc(&dir, "from.draftcanvas", "{}");
        docio::sidecar_write(&from, "image/webp", b"bg").unwrap();
        let source = state.file(&state.grant_file(&from).unwrap()).unwrap();
        let (saved, warning) = finish_save_as(
            &state,
            &dir.path().join("to.draftcanvas"),
            b"{}",
            Some(&source),
        )
        .unwrap();
        assert!(warning.is_none());
        let copied = docio::sidecar_read(&state.file(&saved.handle).unwrap().path)
            .unwrap()
            .unwrap();
        assert_eq!(
            (copied.mime, copied.bytes.as_slice()),
            ("image/webp", &b"bg"[..])
        );
    }

    #[test]
    fn renames_the_file_on_disk_and_regrants_the_handle() {
        let (dir, state) = test_state();
        let path = doc(&dir, "plan.draftcanvas", "{\"x\":1}");
        let handle = state.grant_file(&path).unwrap();
        let renamed = rename_file_now(&state, &handle, "roadmap").unwrap();
        assert_eq!(renamed.name, "roadmap");
        assert!(renamed.display_path.ends_with("roadmap.draftcanvas"));
        assert_ne!(renamed.handle, handle);
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("roadmap.draftcanvas")).unwrap(),
            "{\"x\":1}"
        );
        assert_eq!(state.file(&renamed.handle).unwrap().name, "roadmap");
        // The old handle no longer resolves to anything.
        assert!(state.file(&handle).is_err() || state.file(&handle).unwrap().path != path);
    }

    #[test]
    fn rejects_a_new_name_containing_a_path_separator() {
        let (dir, state) = test_state();
        let path = doc(&dir, "plan.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        let err = rename_file_now(&state, &handle, "sub/plan").err().unwrap();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        assert!(path.exists());
    }

    #[test]
    fn rejects_renaming_onto_an_existing_different_file() {
        let (dir, state) = test_state();
        let path = doc(&dir, "plan.draftcanvas", "mine");
        doc(&dir, "roadmap.draftcanvas", "someone else's");
        let handle = state.grant_file(&path).unwrap();
        let err = rename_file_now(&state, &handle, "roadmap").err().unwrap();
        assert_eq!(err.kind, ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        assert_eq!(
            fs::read_to_string(dir.path().join("roadmap.draftcanvas")).unwrap(),
            "someone else's"
        );
        // The stale handle still resolves to the untouched original file.
        assert_eq!(
            state.file(&handle).unwrap().path,
            dunce::canonicalize(&path).unwrap()
        );
    }

    #[test]
    fn allows_renaming_a_file_onto_itself_with_only_a_case_change() {
        let (dir, state) = test_state();
        let path = doc(&dir, "plan.draftcanvas", "content");
        let handle = state.grant_file(&path).unwrap();
        let renamed = rename_file_now(&state, &handle, "Plan").unwrap();
        assert_eq!(renamed.name, "Plan");
        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn strips_a_redundant_dot_draftcanvas_the_user_typed_in_the_new_name() {
        let (dir, state) = test_state();
        let path = doc(&dir, "plan.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        let renamed = rename_file_now(&state, &handle, "roadmap.draftcanvas").unwrap();
        assert_eq!(renamed.name, "roadmap");
        assert!(dir.path().join("roadmap.draftcanvas").exists());
    }

    #[test]
    fn updates_a_matching_recents_entry_in_place_and_leaves_its_mru_position() {
        let (dir, state) = test_state();
        let a = doc(&dir, "a.draftcanvas", "{}");
        let b = doc(&dir, "b.draftcanvas", "{}");
        opened_doc(&state, &a).unwrap();
        opened_doc(&state, &b).unwrap();
        let handle = state.grant_file(&a).unwrap();
        rename_file_now(&state, &handle, "renamed").unwrap();
        let items = state.recents.list().unwrap().items;
        assert_eq!(items.len(), 2);
        // Still the older (second) entry, not bumped to the front by the rename.
        assert_eq!(items[1].name, "renamed");
        assert!(items[1].path.ends_with("renamed.draftcanvas"));
    }

    #[test]
    fn leaves_the_original_file_and_state_untouched_when_the_target_already_exists() {
        let (dir, state) = test_state();
        let path = doc(&dir, "plan.draftcanvas", "{}");
        doc(&dir, "roadmap.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        assert!(rename_file_now(&state, &handle, "roadmap").is_err());
        assert_eq!(state.file(&handle).unwrap().name, "plan");
        assert_eq!(
            state.file(&handle).unwrap().path,
            dunce::canonicalize(&path).unwrap()
        );
    }

    #[test]
    fn the_wire_shapes_match_the_typescript_types() {
        assert_eq!(
            serde_json::to_value(SaveResult::Saved {
                stamp: "v1:1:2:ab".into()
            })
            .unwrap(),
            json!({"outcome": "saved", "stamp": "v1:1:2:ab"})
        );
        assert_eq!(
            serde_json::to_value(SaveResult::Conflict).unwrap(),
            json!({"outcome": "conflict"})
        );
        let opened = OpenedDoc {
            handle: "h_1".into(),
            name: "n".into(),
            display_path: "~/n.draftcanvas".into(),
            text: "t".into(),
            stamp: "s".into(),
            read_only: true,
        };
        assert_eq!(
            serde_json::to_value(opened).unwrap(),
            json!({"handle": "h_1", "name": "n", "displayPath": "~/n.draftcanvas", "text": "t", "stamp": "s", "readOnly": true})
        );
        let saved = SavedAs {
            handle: "h_1".into(),
            name: "n".into(),
            display_path: "p".into(),
            stamp: "s".into(),
        };
        assert_eq!(
            serde_json::to_value(saved).unwrap(),
            json!({"handle": "h_1", "name": "n", "displayPath": "p", "stamp": "s"})
        );
        assert_eq!(
            serde_json::to_value(StampCheck::Unchanged).unwrap(),
            json!("unchanged")
        );
        assert_eq!(
            serde_json::to_value(StampCheck::Changed).unwrap(),
            json!("changed")
        );
        assert_eq!(
            serde_json::to_value(StampCheck::Missing).unwrap(),
            json!("missing")
        );
        let renamed = RenamedFile {
            handle: "h_2".into(),
            name: "roadmap".into(),
            display_path: "~/roadmap.draftcanvas".into(),
        };
        assert_eq!(
            serde_json::to_value(renamed).unwrap(),
            json!({"handle": "h_2", "name": "roadmap", "displayPath": "~/roadmap.draftcanvas"})
        );
    }

    #[test]
    fn the_request_metadata_uses_the_names_the_page_sends() {
        let save: SaveMeta =
            serde_json::from_value(json!({"handle": "h_1", "expectedStamp": "s"})).unwrap();
        assert_eq!(save.expected_stamp.as_deref(), Some("s"));
        let bare: SaveMeta = serde_json::from_value(json!({"handle": "h_1"})).unwrap();
        assert!(bare.expected_stamp.is_none());
        let save_as: SaveAsMeta =
            serde_json::from_value(json!({"suggestedName": "Plan", "copySidecarFrom": "h_2"}))
                .unwrap();
        assert_eq!(
            (
                save_as.suggested_name.as_str(),
                save_as.copy_sidecar_from.as_deref()
            ),
            ("Plan", Some("h_2"))
        );
        assert!(save_as.start_in.is_none());
        let with_start: SaveAsMeta = serde_json::from_value(json!({
            "suggestedName": "Plan",
            "startIn": {"projectHandle": "h_3", "relPath": "a/b"}
        }))
        .unwrap();
        let start = with_start.start_in.unwrap();
        assert_eq!(
            (start.project_handle.as_str(), start.rel_path.as_str()),
            ("h_3", "a/b")
        );
        let export: ExportMeta = serde_json::from_value(
            json!({"name": "a.png", "filters": [{"name": "PNG", "extensions": ["png"]}]}),
        )
        .unwrap();
        assert_eq!(export.filters[0].extensions, ["png"]);
    }

    #[test]
    fn only_web_and_mail_links_may_leave_the_app() {
        for ok in [
            "https://example.com/a?b=c",
            "http://example.com",
            " https://example.com/x ",
            "HTTPS://EXAMPLE.COM",
            "mailto:hi@example.com",
        ] {
            assert!(checked_external_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "ftp://example.com/",
            "tauri://localhost/",
            "vscode://file/etc/passwd",
            "http://",
            "about:blank",
        ] {
            assert_eq!(
                checked_external_url(bad).err().map(|e| e.kind),
                Some(ErrorKind::InvalidPath),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn backgrounds_travel_as_base64() {
        let (dir, state) = test_state();
        let path = doc(&dir, "a.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        assert_eq!(read_sidecar(&state, &handle).unwrap(), None);

        write_sidecar(
            &state,
            &handle,
            "image/png",
            &STANDARD.encode(b"\x89PNG-bytes"),
        )
        .unwrap();
        let read = read_sidecar(&state, &handle).unwrap().unwrap();
        assert_eq!(read.mime, "image/png");
        assert_eq!(STANDARD.decode(read.base64).unwrap(), b"\x89PNG-bytes");

        docio::sidecar_remove(&path).unwrap();
        assert_eq!(read_sidecar(&state, &handle).unwrap(), None);
    }

    #[test]
    fn bad_background_payloads_are_refused() {
        let (dir, state) = test_state();
        let handle = state.grant_file(&doc(&dir, "a.draftcanvas", "{}")).unwrap();
        assert_eq!(
            write_sidecar(&state, &handle, "image/png", "***not base64***")
                .err()
                .unwrap()
                .kind,
            ErrorKind::Io
        );
        assert_eq!(
            write_sidecar(&state, &handle, "image/svg+xml", &STANDARD.encode(b"x"))
                .err()
                .unwrap()
                .kind,
            ErrorKind::NotADocument
        );
        let huge = "A".repeat((MAX_SIDECAR_BYTES as usize / 3 + 2) * 4);
        assert_eq!(
            write_sidecar(&state, &handle, "image/png", &huge)
                .err()
                .unwrap()
                .kind,
            ErrorKind::TooLarge
        );
        assert_eq!(
            write_sidecar(&state, "h_unknown", "image/png", "AAAA")
                .err()
                .unwrap()
                .kind,
            ErrorKind::InvalidHandle
        );
        assert_eq!(
            read_sidecar(&state, "h_unknown").err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
    }
}
