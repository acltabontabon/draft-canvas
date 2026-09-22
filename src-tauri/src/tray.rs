//! The tray (macOS menu bar) icon: how the app stays reachable after its window is closed.

use crate::menu::{realize, tray_menu, TrayRecent};
use crate::recents::RecentKind;
use crate::state::AppState;
use crate::window::show_main;
use std::path::Path;
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

/// macOS wants a monochrome template image it can tint for light and dark menu bars; the other
/// platforms take the coloured one.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray-template.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray-color.png");

/// Starts with an empty Recent list: filling it means reading the list and checking every file on it,
/// which can stall on an offline drive and must not hold up the thread that is starting the app.
/// `refresh` fills it in from a worker.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = realize(app, &tray_menu(&[]))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Draft Canvas")
        .menu(&menu)
        // macOS opens the menu on a click. Windows uses left-click for the window and right-click for
        // the menu, which is what people expect from a tray icon there.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| {
            if cfg!(not(target_os = "macos")) {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuilds the Recent submenu after anything changed the list. A failure only leaves the previous
/// menu in place, which is worth a stale entry rather than an error the person can't act on.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = realize(app, &tray_menu(&recent_files(app))) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Recent *files* (a project isn't something the tray can open), each with a handle the page can be
/// sent back.
fn recent_files(app: &AppHandle) -> Vec<TrayRecent> {
    let state = app.state::<AppState>();
    let Ok(listing) = state.recents.list() else {
        return Vec::new();
    };
    listing
        .items
        .into_iter()
        .filter(|e| e.kind == RecentKind::File)
        .filter_map(|e| {
            let handle = state.grant_file(Path::new(&e.path)).ok()?;
            Some(TrayRecent {
                handle,
                name: e.name,
            })
        })
        .collect()
}
