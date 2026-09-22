//! Recovery copies as the page sees them. The page names a file by handle; the path Rust stores beside
//! the snapshot is resolved here, so the page never supplies (or reads back) one.

use super::raw::raw_request;
use super::run_blocking;
use crate::errors::AppError;
use crate::grants::Handle;
use crate::paths::display_path;
use crate::recovery::StoredOrigin;
use crate::state::AppState;
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::ipc::Request;
use tauri::AppHandle;

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum WriteOrigin {
    Quick,
    File { handle: Handle, base_stamp: String },
}

#[derive(Debug, Deserialize)]
struct WriteMeta {
    id: String,
    origin: WriteOrigin,
    title: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum RecoveryOrigin {
    Quick,
    File {
        name: String,
        display_path: String,
        handle: Handle,
    },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub id: String,
    pub origin: RecoveryOrigin,
    pub title: String,
    pub updated_at: u64,
    pub bytes: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RecoveryText {
    pub text: String,
}

fn write_recovery(state: &AppState, meta: WriteMeta, bytes: &[u8]) -> Result<(), AppError> {
    let origin = match meta.origin {
        WriteOrigin::Quick => StoredOrigin::Quick,
        WriteOrigin::File { handle, base_stamp } => {
            let grant = state.file(&handle)?;
            let path = grant
                .path
                .to_str()
                .ok_or_else(|| AppError::invalid_path("That file's location can't be stored."))?
                .to_string();
            StoredOrigin::File { path, base_stamp }
        }
    };
    state
        .recovery
        .write(&meta.id, origin, &meta.title, bytes, now_ms())
}

/// A snapshot of a named file is offered against that file, with a handle so the page can tell whether
/// it is the document already open. If the file has since gone (or can no longer be opened) the
/// snapshot is still worth keeping, so it is offered as a quick draft instead of being hidden.
fn recovery_entries(state: &AppState) -> Result<Vec<RecoveryEntry>, AppError> {
    Ok(state
        .recovery
        .list()?
        .into_iter()
        .map(|e| RecoveryEntry {
            origin: match &e.origin {
                StoredOrigin::Quick => RecoveryOrigin::Quick,
                StoredOrigin::File { path, .. } => {
                    file_origin(state, path).unwrap_or(RecoveryOrigin::Quick)
                }
            },
            id: e.id,
            title: e.title,
            updated_at: e.updated_at,
            bytes: e.bytes,
        })
        .collect())
}

fn file_origin(state: &AppState, path: &str) -> Option<RecoveryOrigin> {
    let handle = state.grant_file(Path::new(path)).ok()?;
    let grant = state.file(&handle).ok()?;
    Some(RecoveryOrigin::File {
        display_path: display_path(&grant.path),
        name: grant.name,
        handle,
    })
}

#[tauri::command]
pub async fn recovery_write(app: AppHandle, request: Request<'_>) -> Result<(), AppError> {
    let (meta, bytes) = raw_request::<WriteMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |_, state| write_recovery(state, meta, &bytes)).await
}

#[tauri::command]
pub async fn recovery_list(app: AppHandle) -> Result<Vec<RecoveryEntry>, AppError> {
    run_blocking(&app, |_, state| recovery_entries(state)).await
}

#[tauri::command]
pub async fn recovery_read(app: AppHandle, id: String) -> Result<RecoveryText, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(RecoveryText {
            text: state.recovery.read(&id)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn recovery_discard(app: AppHandle, id: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| state.recovery.discard(&id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::{doc, test_state};
    use crate::errors::ErrorKind;
    use serde_json::json;
    use std::fs;

    const Q: &str = "q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3a";
    const F: &str = "f_11111111-2222-4333-8444-555555555555";

    fn meta(id: &str, origin: serde_json::Value) -> WriteMeta {
        serde_json::from_value(json!({"id": id, "origin": origin, "title": "Sketch"})).unwrap()
    }

    #[test]
    fn the_page_describes_origins_the_way_typescript_does() {
        let quick: WriteOrigin = serde_json::from_value(json!({"kind": "quick"})).unwrap();
        assert_eq!(quick, WriteOrigin::Quick);
        let file: WriteOrigin = serde_json::from_value(
            json!({"kind": "file", "handle": "h_1", "baseStamp": "v1:1:1:aa"}),
        )
        .unwrap();
        assert_eq!(
            file,
            WriteOrigin::File {
                handle: "h_1".into(),
                base_stamp: "v1:1:1:aa".into()
            }
        );
        assert!(
            serde_json::from_value::<WriteOrigin>(json!({"kind": "file", "handle": "h_1"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<WriteOrigin>(
                json!({"kind": "file", "path": "/etc/passwd", "baseStamp": "x"})
            )
            .is_err(),
            "a path is not an accepted way to name a file"
        );
    }

    #[test]
    fn a_quick_draft_round_trips() {
        let (_dir, state) = test_state();
        write_recovery(&state, meta(Q, json!({"kind": "quick"})), b"{\"a\":1}").unwrap();
        let entries = recovery_entries(&state).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].origin, RecoveryOrigin::Quick);
        assert_eq!(
            (
                entries[0].id.as_str(),
                entries[0].title.as_str(),
                entries[0].bytes
            ),
            (Q, "Sketch", 7)
        );
        assert!(entries[0].updated_at > 0);
        assert_eq!(state.recovery.read(Q).unwrap(), "{\"a\":1}");
        state.recovery.discard(Q).unwrap();
        assert!(recovery_entries(&state).unwrap().is_empty());
    }

    #[test]
    fn a_snapshot_of_a_named_file_stores_the_path_rust_resolved_and_lists_the_same_handle() {
        let (dir, state) = test_state();
        let path = doc(&dir, "payment-flow.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        write_recovery(
            &state,
            meta(
                F,
                json!({"kind": "file", "handle": handle, "baseStamp": "v1:1:2:aa"}),
            ),
            b"{}",
        )
        .unwrap();

        let stored: serde_json::Value = serde_json::from_slice(
            &fs::read(dir.path().join("data/recovery").join(format!("{F}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            stored["origin"]["path"],
            dunce::canonicalize(&path).unwrap().to_str().unwrap()
        );
        assert_eq!(stored["origin"]["baseStamp"], "v1:1:2:aa");

        let entries = recovery_entries(&state).unwrap();
        let RecoveryOrigin::File {
            name,
            handle: listed,
            display_path,
        } = &entries[0].origin
        else {
            panic!("expected a file origin, got {:?}", entries[0].origin);
        };
        assert_eq!(name, "payment-flow");
        assert_eq!(
            listed, &handle,
            "the same file yields the same handle, so the page can match it to the open document"
        );
        assert!(display_path.ends_with("payment-flow.draftcanvas"));
    }

    #[test]
    fn a_snapshot_of_a_file_that_is_gone_is_still_offered_as_a_quick_draft() {
        let (dir, state) = test_state();
        let path = doc(&dir, "gone.draftcanvas", "{}");
        let handle = state.grant_file(&path).unwrap();
        write_recovery(
            &state,
            meta(
                F,
                json!({"kind": "file", "handle": handle, "baseStamp": "v1:1:2:aa"}),
            ),
            b"{\"kept\":true}",
        )
        .unwrap();
        fs::remove_file(&path).unwrap();
        let entries = recovery_entries(&state).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].origin, RecoveryOrigin::Quick);
        assert_eq!(state.recovery.read(F).unwrap(), "{\"kept\":true}");
    }

    #[test]
    fn a_handle_rust_never_issued_cannot_be_used_to_name_a_file() {
        let (dir, state) = test_state();
        let err = write_recovery(
            &state,
            meta(
                F,
                json!({"kind": "file", "handle": "h_forged", "baseStamp": "x"}),
            ),
            b"{}",
        )
        .err()
        .unwrap();
        assert_eq!(err.kind, ErrorKind::InvalidHandle);
        assert!(!dir.path().join("data/recovery").exists());
    }

    #[test]
    fn a_bad_id_is_refused_before_anything_touches_the_disk() {
        let (dir, state) = test_state();
        let err = write_recovery(&state, meta("../../evil", json!({"kind": "quick"})), b"{}")
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::InvalidHandle);
        assert!(!dir.path().join("data").exists());
        assert_eq!(
            state.recovery.read("../x").err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
        assert_eq!(
            state.recovery.discard("../x").err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
    }

    #[test]
    fn the_wire_shapes_match_the_typescript_types() {
        let quick = RecoveryEntry {
            id: Q.into(),
            origin: RecoveryOrigin::Quick,
            title: "t".into(),
            updated_at: 5,
            bytes: 7,
        };
        assert_eq!(
            serde_json::to_value(quick).unwrap(),
            json!({"id": Q, "origin": {"kind": "quick"}, "title": "t", "updatedAt": 5, "bytes": 7})
        );
        let file = RecoveryEntry {
            id: F.into(),
            origin: RecoveryOrigin::File {
                name: "n".into(),
                display_path: "~/n.draftcanvas".into(),
                handle: "h_1".into(),
            },
            title: "t".into(),
            updated_at: 5,
            bytes: 7,
        };
        assert_eq!(
            serde_json::to_value(file).unwrap()["origin"],
            json!({"kind": "file", "name": "n", "displayPath": "~/n.draftcanvas", "handle": "h_1"})
        );
        assert_eq!(
            serde_json::to_value(RecoveryText { text: "x".into() }).unwrap(),
            json!({"text": "x"})
        );
    }
}
