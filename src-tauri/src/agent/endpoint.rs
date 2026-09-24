//! Where the bridge listens and how a sidecar finds it: `agent.json` in the app's local data folder,
//! private to this account, naming the socket (or pipe) and the token to present on it.
//!
//! The sidecar reads the same file from the same place (`mcp/src/endpoint.rs` spells the location out
//! independently, because it is a separate program; a test on each side holds them to one layout).

use crate::docio::write_private;
use crate::errors::Subject;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const INFO_FILE: &str = "agent.json";

/// `agent.json`'s contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub v: u32,
    /// A Unix socket path, or a Windows pipe name (`\\.\pipe\…`).
    pub endpoint: String,
    pub token: String,
    /// The app's process id, so a sidecar finding a file left by a crashed app can say "not running"
    /// instead of timing out on a dead socket.
    pub pid: u32,
}

pub fn agent_dir(local_data_dir: &Path) -> PathBuf {
    local_data_dir.join("agent")
}

/// A fresh secret for one enablement: 256 bits from the OS's generator, via two v4 UUIDs.
pub fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The socket path: inside the agent folder when it fits a `sockaddr_un` (104 bytes on macOS, with
/// room to spare), otherwise the per-user temporary folder, which macOS keeps private to the account.
#[cfg(unix)]
pub fn socket_path(dir: &Path) -> PathBuf {
    const MAX_SUN_PATH: usize = 100;
    let preferred = dir.join("bridge.sock");
    if preferred.as_os_str().len() < MAX_SUN_PATH {
        return preferred;
    }
    let uid = unsafe { libc_getuid() };
    std::env::temp_dir().join(format!("draft-canvas-agent-{uid}.sock"))
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

/// A pipe name nobody can guess, so another program can't claim it first.
#[cfg(windows)]
pub fn pipe_name() -> String {
    format!(
        r"\\.\pipe\draft-canvas-agent-{}",
        uuid::Uuid::new_v4().simple()
    )
}

/// Makes the folder, private to the account on Unix (the socket inside inherits nobody else's reach).
pub fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn write_info(dir: &Path, info: &Info) -> Result<(), crate::errors::AppError> {
    let json = serde_json::to_vec_pretty(info).map_err(|_| crate::errors::AppError::internal())?;
    write_private(&dir.join(INFO_FILE), &json, Subject::Preferences)
}

pub fn remove_info(dir: &Path) {
    let _ = fs::remove_file(dir.join(INFO_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn tokens_are_long_and_never_repeat() {
        let a = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, new_token());
    }

    #[cfg(unix)]
    #[test]
    fn a_socket_path_that_would_not_fit_moves_to_the_temp_folder() {
        let short = socket_path(Path::new("/tmp/a"));
        assert_eq!(short, Path::new("/tmp/a/bridge.sock"));
        let long = socket_path(&Path::new("/tmp").join("x".repeat(120)));
        assert!(long.starts_with(std::env::temp_dir()));
        assert!(long.as_os_str().len() < 104 || std::env::temp_dir().as_os_str().len() > 90);
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_and_the_file_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempdir().unwrap();
        let dir = agent_dir(root.path());
        prepare_dir(&dir).unwrap();
        write_info(
            &dir,
            &Info {
                v: 1,
                endpoint: "e".into(),
                token: "t".into(),
                pid: 1,
            },
        )
        .unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(INFO_FILE)), 0o600);
        remove_info(&dir);
        assert!(!dir.join(INFO_FILE).exists());
    }
}
