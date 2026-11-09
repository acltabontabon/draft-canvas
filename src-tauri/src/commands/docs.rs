//! Use in docs: the picture beside a diagram, and adding it to a Markdown file. The rules live in
//! `crate::docs`; these commands only find the files a handle names and run the work off the main thread.

use super::raw::{raw_request, raw_request_up_to};
use super::run_blocking;
use crate::dialogs::{self, FileFilter};
use crate::docs::{self, ImageState, MarkdownWrite, Published};
use crate::errors::{AppError, ErrorKind};
use crate::grants::Handle;
use crate::paths::{display_path, file_name};
use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::AppHandle;

/// Where the picture of the diagram `handle` stands.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct DocsStatus {
    /// `payments.svg`: what the picture is, or would be, called.
    pub image_name: String,
    /// `none`: not published. `ours`: a picture Draft Canvas made. `foreign`: another file has the name.
    #[ts(type = "\"none\" | \"ours\" | \"foreign\"")]
    pub state: String,
    /// The picture's SVG, when it is ours, so the page can tell whether it is current.
    pub svg: Option<String>,
    pub modified_ms: Option<f64>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct DocsPublished {
    /// `written`, or `unchanged` when the picture was already exactly this.
    #[ts(type = "\"written\" | \"unchanged\"")]
    pub outcome: String,
    pub image_name: String,
}

/// A Markdown file the person picked, and the way from it to the diagram's picture.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFile {
    pub handle: Handle,
    pub name: String,
    pub display_path: String,
    pub text: String,
    pub stamp: String,
    /// The picture's path from the Markdown file's folder, `/`-separated.
    pub image_path: String,
}

fn status_now(state: &crate::state::AppState, handle: &str) -> Result<DocsStatus, AppError> {
    let grant = state.file(handle)?;
    let path = docs::image_path(&grant.path);
    let read = docs::read_image(&path)?;
    Ok(DocsStatus {
        image_name: file_name(&path),
        state: match read.state {
            ImageState::None => "none",
            ImageState::Ours => "ours",
            ImageState::Foreign => "foreign",
        }
        .into(),
        svg: read.text,
        modified_ms: read.modified_ms,
    })
}

#[tauri::command]
pub async fn docs_status(app: AppHandle, handle: String) -> Result<DocsStatus, AppError> {
    run_blocking(&app, move |_, state| status_now(state, &handle)).await
}

#[derive(Debug, Deserialize)]
struct PublishMeta {
    handle: Handle,
}

/// Writes the picture beside the diagram. The page names the diagram; Rust decides where its picture goes.
#[tauri::command]
pub async fn docs_publish(app: AppHandle, request: Request<'_>) -> Result<DocsPublished, AppError> {
    let (meta, bytes) = raw_request_up_to::<PublishMeta>(&request, docs::MAX_IMAGE_BYTES as usize)?;
    let bytes = bytes.to_vec();
    run_blocking(&app, move |_, state| {
        let grant = state.file(&meta.handle)?;
        let outcome = docs::publish_image(&grant.path, &bytes)?;
        Ok(DocsPublished {
            outcome: match outcome {
                Published::Written => "written",
                Published::Unchanged => "unchanged",
            }
            .into(),
            image_name: file_name(&docs::image_path(&grant.path)),
        })
    })
    .await
}

/// Picks a Markdown file, starting beside the diagram. The dialog is the permission to add to it.
#[tauri::command]
pub async fn docs_pick_markdown(
    app: AppHandle,
    handle: String,
) -> Result<Option<MarkdownFile>, AppError> {
    run_blocking(&app, move |app, state| {
        let grant = state.file(&handle)?;
        let start = grant.path.parent().map(|p| p.to_path_buf());
        let filters = [FileFilter {
            name: "Markdown".into(),
            extensions: vec!["md".into(), "markdown".into(), "mdx".into()],
        }];
        let Some(picked) = dialogs::pick_file(app, start, &filters) else {
            return Ok(None);
        };
        let md_handle = state.grant_markdown(&picked)?;
        let path = state.markdown(&md_handle)?;
        let read = docs::read_markdown(&path)?;
        let image = docs::image_path(&grant.path);
        let image_path = path
            .parent()
            .and_then(|dir| docs::relative_path(dir, &image))
            .ok_or_else(|| {
                AppError::new(
                    ErrorKind::InvalidPath,
                    "That Markdown file is on another drive from the diagram, so it can't point at the picture with a relative path. Pick one on the same drive.",
                )
            })?;
        Ok(Some(MarkdownFile {
            handle: md_handle,
            name: file_name(&path),
            display_path: display_path(&path),
            text: read.text,
            stamp: read.stamp,
            image_path,
        }))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMeta {
    markdown: Handle,
    expected_stamp: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum MarkdownSaveResult {
    Saved { stamp: String },
    Conflict,
}

/// Adds the image reference to the Markdown file — only adds, and only to the file as it was read.
#[tauri::command]
pub async fn docs_add_to_markdown(
    app: AppHandle,
    request: Request<'_>,
) -> Result<MarkdownSaveResult, AppError> {
    let (meta, bytes) = raw_request::<AddMeta>(&request)?;
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::bad_request("Markdown text is not UTF-8"))?;
    run_blocking(&app, move |_, state| {
        let path = state.markdown(&meta.markdown)?;
        Ok(
            match docs::add_to_markdown(&path, &text, &meta.expected_stamp)? {
                MarkdownWrite::Saved { stamp } => MarkdownSaveResult::Saved { stamp },
                MarkdownWrite::Conflict => MarkdownSaveResult::Conflict,
            },
        )
    })
    .await
}

/// Shows the published picture in the file manager.
#[tauri::command]
pub async fn docs_reveal(app: AppHandle, handle: String) -> Result<(), AppError> {
    run_blocking(&app, move |_, state| {
        let grant = state.file(&handle)?;
        let path = docs::image_path(&grant.path);
        if docs::read_image(&path)?.state != ImageState::Ours {
            return Err(AppError::new(
                ErrorKind::NotFound,
                format!("{} isn't beside the diagram any more.", file_name(&path)),
            ));
        }
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|_| {
            AppError::new(
                ErrorKind::Io,
                "Draft Canvas couldn't show that file in the file manager.",
            )
        })
    })
    .await
}
