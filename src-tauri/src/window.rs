//! The main window: showing it, titling it for the open document, and what it may navigate to.

use crate::grants::Handle;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

pub const MAIN: &str = "main";
const APP_NAME: &str = "Draft Canvas";
/// `devUrl` in tauri.conf.json. Only honoured when running under `tauri dev`.
const DEV_PORT: u16 = 5198;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// What the page reports about the open document (`DocState` in `api.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReportedState {
    #[serde(rename = "none")]
    Empty {
        dirty: bool,
    },
    Quick {
        dirty: bool,
    },
    File {
        dirty: bool,
        name: String,
        handle: Handle,
    },
}

impl ReportedState {
    pub fn dirty(&self) -> bool {
        match self {
            ReportedState::Empty { dirty }
            | ReportedState::Quick { dirty }
            | ReportedState::File { dirty, .. } => *dirty,
        }
    }
}

/// `<name> — Draft Canvas`. Unsaved changes are shown as a `* ` prefix on Windows and Linux; macOS has
/// its own mark (the dot in the close button, set separately) and keeps the title clean.
pub fn window_title(state: &ReportedState, platform: Platform) -> String {
    let (label, dirty) = match state {
        ReportedState::Empty { .. } => return APP_NAME.to_string(),
        ReportedState::Quick { dirty } => ("Quick Draft", *dirty),
        ReportedState::File { name, dirty, .. } => (name.as_str(), *dirty),
    };
    let mark = if dirty && platform != Platform::Macos {
        "* "
    } else {
        ""
    };
    format!("{mark}{label} \u{2014} {APP_NAME}")
}

/// Only the app's own origin may load in the window; a link or redirect to anywhere else is refused
/// (the page opens outside links through `open_external`, which allows http(s) and mailto only).
pub fn allows_navigation(url: &Url, dev: bool) -> bool {
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("https", Some("tauri.localhost"), None) => true,
        ("http", Some("localhost"), Some(port)) => dev && port == DEV_PORT,
        _ => false,
    }
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

/// Brings the window back from hidden, minimised or behind others. Also records that it has been
/// shown, which is what stops the startup fallback timer from reopening a window the person closed.
pub fn show_main(app: &AppHandle) {
    app.state::<AppState>()
        .window_shown
        .store(true, Ordering::SeqCst);
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Title, and on macOS the "edited" dot and the proxy icon of the file being edited.
pub fn apply_state(app: &AppHandle, state: &ReportedState, file: Option<std::path::PathBuf>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let _ = window.set_title(&window_title(state, Platform::current()));
    mark_edited(&window, state.dirty(), file);
}

#[cfg(target_os = "macos")]
fn mark_edited(window: &WebviewWindow, edited: bool, file: Option<std::path::PathBuf>) {
    let target = window.clone();
    // AppKit windows may only be touched from the main thread.
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::NSWindow;
        use objc2_foundation::NSString;
        let Ok(pointer) = target.ns_window() else {
            return;
        };
        // SAFETY: `ns_window` is this window's own NSWindow, which lives as long as `target`, and we
        // are on the main thread.
        let ns_window: &NSWindow = unsafe { &*pointer.cast::<NSWindow>() };
        ns_window.setDocumentEdited(edited);
        let represented = file
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        ns_window.setRepresentedFilename(&NSString::from_str(&represented));
    });
}

#[cfg(not(target_os = "macos"))]
fn mark_edited(_window: &WebviewWindow, _edited: bool, _file: Option<std::path::PathBuf>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(dirty: bool) -> ReportedState {
        ReportedState::File {
            dirty,
            name: "payment-flow".into(),
            handle: "h_1".into(),
        }
    }

    #[test]
    fn titles_follow_the_document() {
        assert_eq!(
            window_title(&ReportedState::Empty { dirty: false }, Platform::Windows),
            "Draft Canvas"
        );
        assert_eq!(
            window_title(&ReportedState::Quick { dirty: false }, Platform::Macos),
            "Quick Draft \u{2014} Draft Canvas"
        );
        assert_eq!(
            window_title(&file(false), Platform::Linux),
            "payment-flow \u{2014} Draft Canvas"
        );
    }

    #[test]
    fn unsaved_changes_prefix_the_title_except_on_macos() {
        assert_eq!(
            window_title(&file(true), Platform::Windows),
            "* payment-flow \u{2014} Draft Canvas"
        );
        assert_eq!(
            window_title(&ReportedState::Quick { dirty: true }, Platform::Linux),
            "* Quick Draft \u{2014} Draft Canvas"
        );
        assert_eq!(
            window_title(&file(true), Platform::Macos),
            "payment-flow \u{2014} Draft Canvas"
        );
    }

    #[test]
    fn the_typescript_doc_state_deserializes() {
        use serde_json::json;
        let none: ReportedState =
            serde_json::from_value(json!({"kind": "none", "dirty": false})).unwrap();
        assert_eq!(none, ReportedState::Empty { dirty: false });
        let quick: ReportedState =
            serde_json::from_value(json!({"kind": "quick", "dirty": true})).unwrap();
        assert!(quick.dirty());
        let file: ReportedState = serde_json::from_value(
            json!({"kind": "file", "dirty": false, "name": "a", "handle": "h_9"}),
        )
        .unwrap();
        assert_eq!(
            file,
            ReportedState::File {
                dirty: false,
                name: "a".into(),
                handle: "h_9".into()
            }
        );
        assert!(
            serde_json::from_value::<ReportedState>(json!({"kind": "file", "dirty": false}))
                .is_err()
        );
    }

    #[test]
    fn only_the_apps_own_origin_may_be_navigated_to() {
        let url = |s: &str| Url::parse(s).unwrap();
        for ok in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "https://tauri.localhost/",
            "https://tauri.localhost/assets/x.js",
        ] {
            assert!(allows_navigation(&url(ok), false), "{ok}");
        }
        for bad in [
            "https://example.com/",
            "http://tauri.localhost/",
            "https://tauri.localhost.evil.com/",
            "tauri://evil/",
            "tauri://localhost:1234/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "about:blank",
            "javascript:alert(1)",
            "http://localhost:5198/",
            "http://localhost:8080/",
        ] {
            assert!(!allows_navigation(&url(bad), false), "{bad}");
        }
    }

    #[test]
    fn the_dev_server_is_allowed_only_in_dev_and_only_on_its_port() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(allows_navigation(&url("http://localhost:5198/"), true));
        assert!(allows_navigation(
            &url("http://localhost:5198/src/main.tsx"),
            true
        ));
        assert!(!allows_navigation(&url("http://localhost:5199/"), true));
        assert!(!allows_navigation(&url("http://localhost/"), true));
        assert!(!allows_navigation(&url("https://localhost:5198/"), true));
        assert!(!allows_navigation(&url("http://127.0.0.1:5198/"), true));
    }

    #[test]
    fn platform_serializes_lowercase() {
        assert_eq!(
            serde_json::to_value(Platform::Macos).unwrap(),
            serde_json::json!("macos")
        );
        assert_eq!(
            serde_json::to_value(Platform::Windows).unwrap(),
            serde_json::json!("windows")
        );
        assert_eq!(
            serde_json::to_value(Platform::Linux).unwrap(),
            serde_json::json!("linux")
        );
    }
}
