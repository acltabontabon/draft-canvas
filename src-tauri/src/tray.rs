//! The tray (macOS menu bar) icon: how the app stays reachable after its window is closed.
//!
//! Deliberately small. The tray exists for one reason — closing the window hides it rather than
//! quitting, so an agent connected over the local socket keeps its app, and the next Quick Draft is
//! instant — and its menu says exactly that much: bring the window back, whether agents are
//! connected, Settings, Quit. Everything else (drafts, recent files, new documents) is Home's job,
//! one click away behind "Show Draft Canvas".

use crate::menu::{realize, tray_menu, TrayAgent};
use std::sync::Arc;
use tauri::image::Image;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

/// macOS wants a monochrome template image it can tint for light and dark menu bars; the other
/// platforms take the coloured one.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray-template.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray-color.png");

/// Every platform gets the native menu, on either button. macOS pops a status item's menu on
/// mouse-down, which is exactly the behaviour wanted now that there is no panel to open instead.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Draft Canvas")
        .menu(&realize(app, &tray_menu(agent_status(app)))?)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// Rebuilds the menu after the one thing in it that changes — agent access, and how many agents are
/// connected. A failure only leaves the previous menu in place, which is worth a stale line rather
/// than an error the person can't act on.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = realize(app, &tray_menu(agent_status(app))) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn agent_status(app: &AppHandle) -> TrayAgent {
    match app.try_state::<Arc<crate::agent::Agent>>() {
        Some(agent) if agent.is_running() => TrayAgent::On {
            connections: agent.connections(),
        },
        Some(_) => TrayAgent::Off,
        None => TrayAgent::Off,
    }
}
