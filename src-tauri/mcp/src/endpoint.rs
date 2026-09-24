//! Finding the running app: `agent.json` in the app's local data folder, the same place the app's
//! `agent/endpoint.rs` writes it. Spelled out here rather than shared because this is a separate
//! program that must stay small; `tests/bridge.rs` and the app's own tests hold both to one layout.

use serde::Deserialize;
use std::path::PathBuf;

/// The app's bundle identifier (`tauri.conf.json`), which names its data folder on every platform.
pub const APP_IDENTIFIER: &str = "com.acltabontabon.draft-canvas";
/// Overrides where `agent.json` is looked for — for development and tests, never needed installed.
pub const DIR_OVERRIDE: &str = "DRAFT_CANVAS_AGENT_DIR";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub v: u32,
    pub endpoint: String,
    pub token: String,
    #[allow(dead_code)]
    pub pid: u32,
}

/// Where the app keeps `agent.json`: Tauri's `app_local_data_dir`, plus `agent`.
pub fn agent_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(DIR_OVERRIDE) {
        return Some(PathBuf::from(dir));
    }
    local_data_dir().map(|d| d.join(APP_IDENTIFIER).join("agent"))
}

#[cfg(target_os = "macos")]
fn local_data_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
}

#[cfg(windows)]
fn local_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn local_data_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

/// Why the app can't be reached, worded for the agent to relay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missing {
    /// No `agent.json`: the app isn't running, or agent access is off.
    NotRunningOrDisabled,
    /// It's there but unreadable or malformed.
    Unreadable,
}

pub fn read_info() -> Result<Info, Missing> {
    let dir = agent_dir().ok_or(Missing::NotRunningOrDisabled)?;
    let bytes = match std::fs::read(dir.join("agent.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(Missing::NotRunningOrDisabled)
        }
        Err(_) => return Err(Missing::Unreadable),
    };
    serde_json::from_slice(&bytes).map_err(|_| Missing::Unreadable)
}
