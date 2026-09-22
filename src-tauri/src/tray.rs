//! The tray (macOS menu bar) icon: how the app stays reachable after its window is closed.

use crate::grants::Handle;
use crate::menu::{realize, tray_menu, Icon, TrayActionIcons, TrayDraft, TrayRecent};
use crate::recents::RecentKind;
use crate::state::AppState;
use crate::util::lock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "main";

/// macOS wants a monochrome template image it can tint for light and dark menu bars; the other
/// platforms take the coloured one. Each has a twin with a small dot, worn while a draft is unsaved —
/// the dot a window's close button shows for the same thing.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray-template.png");
#[cfg(target_os = "macos")]
const ICON_UNSAVED: &[u8] = include_bytes!("../icons/tray-template-unsaved.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray-color.png");
#[cfg(not(target_os = "macos"))]
const ICON_UNSAVED: &[u8] = include_bytes!("../icons/tray-color-unsaved.png");

/// What the page drew for the tray menu (`tray_decorate`): its action icons, each recent file's
/// silhouette by the file's canonical path, and the drafts that aren't saved yet. Kept here rather
/// than drawn in Rust because the page already has every diagram's shape and knows the appearance.
#[derive(Default)]
pub struct TrayArt {
    pub actions: TrayActionIcons,
    pub files: HashMap<PathBuf, Icon>,
    pub drafts: Vec<TrayDraft>,
}

/// Starts with an empty Recent list: filling it means reading the list and checking every file on it,
/// which can stall on an offline drive and must not hold up the thread that is starting the app.
/// `refresh` fills it in from a worker.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Draft Canvas")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                if button == MouseButton::Left || !NATIVE_MENU {
                    crate::panel::toggle(tray.app_handle(), rect);
                }
            }
        });
    if NATIVE_MENU {
        builder = builder.menu(&realize(
            app,
            &tray_menu(&[], &[], &TrayActionIcons::default()),
        )?);
    }
    builder.build(app)?;
    Ok(())
}

/// Windows and Linux keep the native menu one right click away from the panel. macOS doesn't: a status
/// item that carries a menu pops it on mouse-down and swallows the mouse-up, so any click would open
/// the menu and never the panel. There the panel is the tray — it has every item the menu has.
const NATIVE_MENU: bool = cfg!(not(target_os = "macos"));

/// Rebuilds the menu after anything changed it — the Recent list, or what the page drew — and puts
/// the dot on the icon while a draft is unsaved. A failure only leaves the previous menu in place,
/// which is worth a stale entry rather than an error the person can't act on.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let recents = recent_files(app);
    let state = app.state::<AppState>();
    let (drafts, icons) = {
        let art = lock(&state.tray_art);
        (art.drafts.clone(), art.actions.clone())
    };
    if NATIVE_MENU {
        if let Ok(menu) = realize(app, &tray_menu(&recents, &drafts, &icons)) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    if let Ok(icon) = Image::from_bytes(if drafts.is_empty() {
        ICON
    } else {
        ICON_UNSAVED
    }) {
        let _ = tray.set_icon(Some(icon));
        // Setting a new image resets it to an ordinary one on macOS; it has to be a template again.
        let _ = tray.set_icon_as_template(cfg!(target_os = "macos"));
    }
}

/// A recent file as the tray offers it: a handle the page can be sent back, and where it is.
pub struct RecentFile {
    pub handle: Handle,
    pub name: String,
    pub path: PathBuf,
    pub last_opened_ms: u64,
}

/// Recent *files* (a project isn't something the tray can open), newest first.
pub fn recent_entries(state: &AppState) -> Vec<RecentFile> {
    let Ok(listing) = state.recents.list() else {
        return Vec::new();
    };
    listing
        .items
        .into_iter()
        .filter(|e| e.kind == RecentKind::File)
        .filter_map(|e| {
            let handle = state.grant_file(Path::new(&e.path)).ok()?;
            let path = state.file(&handle).ok()?.path;
            Some(RecentFile {
                handle,
                name: e.name,
                path,
                last_opened_ms: e.last_opened_ms,
            })
        })
        .collect()
}

/// The menu's Recent items, each with the silhouette the page drew for it, if it has.
fn recent_files(app: &AppHandle) -> Vec<TrayRecent> {
    let state = app.state::<AppState>();
    let entries = recent_entries(&state);
    let art = lock(&state.tray_art);
    entries
        .into_iter()
        .map(|e| TrayRecent {
            icon: art.files.get(&e.path).cloned(),
            handle: e.handle,
            name: e.name,
        })
        .collect()
}
