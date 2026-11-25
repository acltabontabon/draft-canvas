//! Canvas Evolution's history, as the page sees it (`src/desktop/historyStore.ts`). Every argument is
//! untrusted: a history is named by id or by an import's `.staging-<id>`, never by a path, and the
//! checks live in `history/`, where the tests drive them directly.
//!
//! A snapshot's text and a pack travel as raw bytes, both ways: a diagram is megabytes of JSON
//! already, and a pack is binary.

use super::raw::{raw_request, raw_request_up_to};
use super::run_blocking;
use crate::errors::AppError;
use crate::history::gitcli::Git;
use crate::history::{
    limits, Binding, CommitRecord, LogQuery, MaintainOutcome, RefEntry, RefUpdate, RefUpdateResult,
    RepoUsage, SnapshotHead, TagRecord, TagWrite,
};
use crate::history::{project, remote, HistoryError};
use serde::Deserialize;
use serde_json::Value;
use std::time::SystemTime;
use tauri::ipc::{Request, Response};
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    repo: String,
    #[serde(flatten)]
    head: SnapshotHead,
}

#[derive(Debug, Deserialize)]
struct ImportMeta {
    meta: Value,
}

#[tauri::command]
pub async fn history_list(app: AppHandle) -> Result<Vec<Value>, AppError> {
    run_blocking(&app, |_, state| Ok(state.history.list()?)).await
}

#[tauri::command]
pub async fn history_create(app: AppHandle, meta: Value) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| Ok(state.history.create(&meta)?)).await
}

#[tauri::command]
pub async fn history_remove(app: AppHandle, repo: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| Ok(state.history.remove(&repo)?)).await
}

#[tauri::command]
pub async fn history_meta(app: AppHandle, repo: String) -> Result<Value, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.meta()?)
    })
    .await
}

#[tauri::command]
pub async fn history_write_meta(app: AppHandle, repo: String, meta: Value) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open_writable(&repo)?.write_meta(&meta)?)
    })
    .await
}

/// The body is the diagram's text; parents, signatures and message are in `x-meta`.
#[tauri::command]
pub async fn history_write_snapshot(
    app: AppHandle,
    request: Request<'_>,
) -> Result<String, AppError> {
    let (meta, bytes) = raw_request::<SnapshotMeta>(&request)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |_, state| {
        Ok(state
            .history
            .open_writable(&meta.repo)?
            .write_snapshot(&bytes, &meta.head)?)
    })
    .await
}

#[tauri::command]
pub async fn history_update_ref(
    app: AppHandle,
    repo: String,
    update: RefUpdate,
) -> Result<RefUpdateResult, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open_writable(&repo)?.update_ref(&update)?)
    })
    .await
}

#[tauri::command]
pub async fn history_read_ref(
    app: AppHandle,
    repo: String,
    name: String,
) -> Result<Option<String>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.read_ref(&name)?)
    })
    .await
}

#[tauri::command]
pub async fn history_list_refs(
    app: AppHandle,
    repo: String,
    prefix: String,
) -> Result<Vec<RefEntry>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.list_refs(&prefix)?)
    })
    .await
}

#[tauri::command]
pub async fn history_read_commits(
    app: AppHandle,
    repo: String,
    oids: Vec<String>,
) -> Result<Vec<CommitRecord>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.read_commits(&oids)?)
    })
    .await
}

/// The diagram's text as raw UTF-8 bytes (checked strict UTF-8 here).
#[tauri::command]
pub async fn history_read_snapshot(
    app: AppHandle,
    repo: String,
    oid: String,
) -> Result<Response, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(Response::new(
            state.history.open(&repo)?.read_snapshot(&oid)?,
        ))
    })
    .await
}

#[tauri::command]
pub async fn history_log(
    app: AppHandle,
    repo: String,
    query: LogQuery,
) -> Result<Vec<CommitRecord>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.log(&query)?)
    })
    .await
}

#[tauri::command]
pub async fn history_merge_bases(
    app: AppHandle,
    repo: String,
    a: String,
    b: String,
) -> Result<Vec<String>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.merge_bases(&a, &b)?)
    })
    .await
}

#[tauri::command]
pub async fn history_is_ancestor(
    app: AppHandle,
    repo: String,
    ancestor: String,
    descendant: String,
) -> Result<bool, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state
            .history
            .open(&repo)?
            .is_ancestor(&ancestor, &descendant)?)
    })
    .await
}

#[tauri::command]
pub async fn history_write_tag(
    app: AppHandle,
    repo: String,
    tag: TagWrite,
) -> Result<String, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open_writable(&repo)?.write_tag(&tag)?)
    })
    .await
}

#[tauri::command]
pub async fn history_list_tags(
    app: AppHandle,
    repo: String,
    prefix: String,
) -> Result<Vec<TagRecord>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.list_tags(&prefix)?)
    })
    .await
}

#[tauri::command]
pub async fn history_journal_put(
    app: AppHandle,
    repo: String,
    record: Value,
) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open_writable(&repo)?.journal_put(&record)?)
    })
    .await
}

#[tauri::command]
pub async fn history_journal_list(app: AppHandle, repo: String) -> Result<Vec<Value>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.journal_list()?)
    })
    .await
}

#[tauri::command]
pub async fn history_journal_delete(
    app: AppHandle,
    repo: String,
    op_id: String,
) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open_writable(&repo)?.journal_delete(&op_id)?)
    })
    .await
}

#[tauri::command]
pub async fn history_usage(app: AppHandle, repo: String) -> Result<RepoUsage, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.open(&repo)?.usage()?)
    })
    .await
}

/// Judged against the shell's own clock: the page never says how old an object is.
#[tauri::command]
pub async fn history_maintain(app: AppHandle, repo: String) -> Result<MaintainOutcome, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state
            .history
            .open_writable(&repo)?
            .maintain(SystemTime::now())?)
    })
    .await
}

/// A pack (version 2, raw bytes) of every object `tips` reach; the page wraps it as a bundle.
#[tauri::command]
pub async fn history_pack_reachable(
    app: AppHandle,
    repo: String,
    tips: Vec<String>,
) -> Result<Response, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(Response::new(state.history.pack_reachable(&repo, &tips)?))
    })
    .await
}

/// The body is the pack; `x-meta` carries the new history's `repo.json`. Returns `.staging-<id>`.
#[tauri::command]
pub async fn history_import_begin(
    app: AppHandle,
    request: Request<'_>,
) -> Result<String, AppError> {
    let (meta, bytes) = raw_request_up_to::<ImportMeta>(&request, limits::MAX_BUNDLE_BYTES)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |_, state| {
        Ok(state.history.import_begin(&meta.meta, &bytes)?)
    })
    .await
}

#[tauri::command]
pub async fn history_import_commit(
    app: AppHandle,
    staging: String,
    refs: Vec<RefEntry>,
) -> Result<String, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.import_commit(&staging, &refs)?)
    })
    .await
}

#[tauri::command]
pub async fn history_import_abort(app: AppHandle, staging: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.import_abort(&staging)?)
    })
    .await
}

#[tauri::command]
pub async fn history_binding_get(
    app: AppHandle,
    copy_id: String,
) -> Result<Option<Binding>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.binding_get(&copy_id)?)
    })
    .await
}

#[tauri::command]
pub async fn history_binding_put(app: AppHandle, binding: Binding) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.binding_put(&binding)?)
    })
    .await
}

#[tauri::command]
pub async fn history_binding_delete(app: AppHandle, copy_id: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        Ok(state.history.binding_delete(&copy_id)?)
    })
    .await
}

#[tauri::command]
pub async fn history_binding_list(app: AppHandle) -> Result<Vec<Binding>, AppError> {
    run_blocking(&app, |_, state| Ok(state.history.binding_list()?)).await
}

// Remotes and project repositories (`history/remote.rs`, `history/project.rs`): the person's own
// `git`, hardened (`history/gitcli.rs`), run only on these explicit requests. A project repository
// is reached only through the handle of a diagram the page already has open.

#[tauri::command]
pub async fn history_git_status(app: AppHandle) -> Result<remote::GitStatus, AppError> {
    run_blocking(&app, |_, state| Ok(remote::git_status(&state.history))).await
}

#[tauri::command]
pub async fn history_remote_set(
    app: AppHandle,
    repo: String,
    url: String,
) -> Result<String, AppError> {
    run_blocking(&app, move |_, state| {
        let git = remote::require_git(&state.history)?;
        Ok(remote::remote_set(&state.history, &git, &repo, &url)?)
    })
    .await
}

#[tauri::command]
pub async fn history_remote_remove(app: AppHandle, repo: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        let git = remote::require_git(&state.history)?;
        Ok(remote::remote_remove(&state.history, &git, &repo)?)
    })
    .await
}

#[tauri::command]
pub async fn history_fetch(app: AppHandle, repo: String) -> Result<remote::FetchOutcome, AppError> {
    run_blocking(&app, move |_, state| {
        let git = remote::require_git(&state.history)?;
        Ok(remote::fetch(&state.history, &git, &repo)?)
    })
    .await
}

#[tauri::command]
pub async fn history_push_preview(
    app: AppHandle,
    repo: String,
    refs: Vec<String>,
) -> Result<Vec<remote::PushPreview>, AppError> {
    run_blocking(&app, move |_, state| {
        Ok(remote::push_preview(&state.history, &repo, &refs)?)
    })
    .await
}

#[tauri::command]
pub async fn history_push(
    app: AppHandle,
    repo: String,
    refs: Vec<String>,
) -> Result<Vec<remote::PushedRef>, AppError> {
    run_blocking(&app, move |app, state| {
        let git = remote::require_git(&state.history)?;
        // The first publish to an address is confirmed in a native dialog the page can't answer.
        let confirm = |title: &str, message: &str| {
            let buttons = ["Publish".to_string(), "Cancel".to_string()];
            matches!(crate::dialogs::ask(app, title, message, &buttons), Ok(0))
        };
        Ok(remote::push(&state.history, &git, &repo, &refs, &confirm)?)
    })
    .await
}

/// The repository holding the file a handle names, and Git for it; `None` when it is in none.
fn project_of(
    state: &crate::state::AppState,
    handle: &str,
) -> Result<Option<(std::sync::Arc<Git>, project::ProjectRepo)>, AppError> {
    let file = state.file(handle)?.path;
    let Some(repo) = project::discover(&file)? else {
        return Ok(None);
    };
    let git = remote::require_git(&state.history)?;
    Ok(Some((git, repo)))
}

fn require_project(
    state: &crate::state::AppState,
    handle: &str,
) -> Result<(std::sync::Arc<Git>, project::ProjectRepo), AppError> {
    project_of(state, handle)?.ok_or_else(|| {
        AppError::from(
            HistoryError::not_found("This diagram isn't inside a Git repository.")
                .with_reason("not-in-repo"),
        )
    })
}

#[tauri::command]
pub async fn history_project_repo(
    app: AppHandle,
    handle: String,
) -> Result<Option<project::ProjectRepoInfo>, AppError> {
    run_blocking(&app, move |_, state| match project_of(state, &handle)? {
        Some((git, repo)) => Ok(Some(project::inspect(&git, &repo)?)),
        None => Ok(None),
    })
    .await
}

#[tauri::command]
pub async fn history_project_publish_branch(
    app: AppHandle,
    handle: String,
    message: String,
) -> Result<project::Published, AppError> {
    run_blocking(&app, move |_, state| {
        let (git, repo) = require_project(state, &handle)?;
        Ok(project::publish_branch(&git, &repo, &message)?)
    })
    .await
}

#[tauri::command]
pub async fn history_project_commit_current(
    app: AppHandle,
    handle: String,
    message: String,
    expected_head: String,
) -> Result<project::Published, AppError> {
    run_blocking(&app, move |_, state| {
        let (git, repo) = require_project(state, &handle)?;
        Ok(project::commit_current(
            &git,
            &repo,
            &message,
            &expected_head,
        )?)
    })
    .await
}

#[tauri::command]
pub async fn history_project_push_preview(
    app: AppHandle,
    handle: String,
    branch: String,
) -> Result<project::ProjectPushPreview, AppError> {
    run_blocking(&app, move |_, state| {
        let (git, repo) = require_project(state, &handle)?;
        Ok(project::push_preview(&git, &repo, &branch)?)
    })
    .await
}

#[tauri::command]
pub async fn history_project_push(
    app: AppHandle,
    handle: String,
    branch: String,
) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        let (git, repo) = require_project(state, &handle)?;
        Ok(project::push(&git, &repo, &branch)?)
    })
    .await
}
