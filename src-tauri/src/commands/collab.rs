//! Sharing a canvas with guests on the same network (`collab/`). The page runs the session; these
//! open and close the door and carry text both ways.

use super::raw::raw_request_up_to;
use crate::collab::{Relay, Started, MAX_TEXT};
use crate::errors::AppError;
use serde::Deserialize;
use tauri::ipc::Request;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMeta {
    conn_id: String,
}

/// Starts the server (or answers the one running) with the page's token for this session.
#[tauri::command]
pub async fn collab_lan_start(relay: State<'_, Relay>, token: String) -> Result<Started, AppError> {
    relay.start(&token).await
}

#[tauri::command]
pub async fn collab_lan_stop(relay: State<'_, Relay>) -> Result<(), AppError> {
    relay.stop("stopped").await;
    Ok(())
}

/// The text arrives as raw UTF-8 bytes: a whole diagram for a guest who just joined is megabytes,
/// not worth escaping into JSON and back.
#[tauri::command]
pub async fn collab_lan_send(
    relay: State<'_, Relay>,
    request: Request<'_>,
) -> Result<(), AppError> {
    let (meta, bytes) = raw_request_up_to::<SendMeta>(&request, MAX_TEXT)?;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::bad_request("a guest message isn't UTF-8"))?
        .to_owned();
    relay.send(&meta.conn_id, text)
}

#[tauri::command]
pub async fn collab_lan_close(
    relay: State<'_, Relay>,
    conn_id: String,
    reason: String,
) -> Result<(), AppError> {
    relay.close(&conn_id, &reason);
    Ok(())
}
