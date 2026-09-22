//! The page's side of updating: five commands, each returning the whole [`Snapshot`], which also goes
//! out as a host event whenever anything changes, so the page keeps no update state of its own.
//!
//! None of them is the updater plugin itself — the page has no permission to that — and installing goes
//! through the same conversation a quit has, so nothing unsaved is lost to a restart.

use crate::updater::{Snapshot, Updater};
use tauri::State;

#[tauri::command]
pub fn update_status(updater: State<'_, Updater>) -> Snapshot {
    updater.snapshot()
}

/// Look now. `manual` when a person asked: that is what makes a failure worth showing.
#[tauri::command]
pub async fn update_check(updater: State<'_, Updater>, manual: bool) -> Result<Snapshot, ()> {
    Ok(updater.check(manual).await)
}

/// Returns when the download has finished or failed; progress arrives as events meanwhile.
#[tauri::command]
pub async fn update_download(updater: State<'_, Updater>) -> Result<Snapshot, ()> {
    Ok(updater.download().await)
}

/// Keep everything, then replace the app and relaunch. Doesn't return when it works.
#[tauri::command]
pub async fn update_install(updater: State<'_, Updater>) -> Result<Snapshot, ()> {
    Ok(updater.install().await)
}

/// "Later".
#[tauri::command]
pub fn update_dismiss(updater: State<'_, Updater>) -> Snapshot {
    updater.dismiss()
}
