//! Starting up, reacting to the OS (files to open, the dock icon, the window's close button) and
//! deciding what closing the window means.

use crate::dialogs::{ask_later, show_error_later};
use crate::menu::{app_menu, realize};
use crate::paths::has_doc_ext;
use crate::quit::request_quit;
use crate::settings::CloseBehavior;
use crate::state::{AppState, HostEvent};
use crate::util::lock;
use crate::window::{allows_navigation, main_window, show_main, Platform, MAIN};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, DragDropEvent, Manager, RunEvent, WebviewWindowBuilder, WindowEvent};

/// The window is created hidden so the person never sees a white frame; `host_ready` shows it once the
/// page has drawn. This is the backstop for a page that never reports in, and the only timer Rust owns.
const SHOW_FALLBACK: Duration = Duration::from_secs(3);
const SMOKE_VARIABLE: &str = "DRAFT_CANVAS_SMOKE";
const SMOKE_MARKER: &str = "DRAFT_CANVAS_SMOKE_OK";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(8);

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    app.set_menu(realize(app, &app_menu(Platform::current()))?)?;
    create_window(app)?;

    let handle = app.handle().clone();
    let state = handle.state::<AppState>();
    match crate::tray::create(&handle) {
        Ok(()) => {
            state.tray_ready.store(true, Ordering::SeqCst);
            let for_worker = handle.clone();
            tauri::async_runtime::spawn_blocking(move || crate::tray::refresh(&for_worker));
        }
        // No status area (some Linux desktops): the app still runs, and closing the window quits.
        Err(e) => eprintln!("Draft Canvas: no tray icon ({e})"),
    }
    // Returns at once; the first look for an update is well after the window is up.
    crate::updater::start(&handle);

    #[cfg(not(target_os = "macos"))]
    {
        // Windows and Linux hand a double-clicked file to the program as an argument. (macOS sends an
        // Opened event instead, handled below.)
        let cwd = std::env::current_dir().unwrap_or_default();
        open_paths(&handle, paths_from_args(std::env::args().skip(1), &cwd));
    }

    let fallback = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        if !fallback
            .state::<AppState>()
            .window_shown
            .load(Ordering::SeqCst)
        {
            show_main(&fallback);
        }
    });

    if smoke_requested(std::env::var(SMOKE_VARIABLE).ok().as_deref()) {
        start_smoke(&handle);
    }
    Ok(())
}

/// The window comes from tauri.conf.json (`create: false`) so navigation and pop-ups can be locked
/// down on the builder: only the app's own origin loads, and nothing may open another window.
fn create_window(app: &App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
        .expect("tauri.conf.json defines the main window");
    WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(|url| allows_navigation(url, tauri::is_dev()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;
    Ok(())
}

pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::WindowEvent { label, event, .. } if label == MAIN => match event {
            WindowEvent::CloseRequested { api, .. } => close_window(app, Some(&api)),
            WindowEvent::Focused(true) => {
                app.state::<AppState>()
                    .events
                    .emit(HostEvent::WindowFocused);
            }
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => open_paths(app, paths),
            _ => {}
        },
        // The app is being replaced by an update: a Quit or a shutdown waits, or it would stop halfway.
        // The install's own relaunch carries Tauri's restart code and goes through.
        RunEvent::ExitRequested { code, api, .. }
            if app
                .try_state::<crate::updater::Updater>()
                .is_some_and(|updater| crate::updater::defers_exit(updater.installing(), code)) =>
        {
            api.prevent_exit();
        }
        // Last window gone with nobody having chosen to quit: stay alive in the tray. Exits Rust asks
        // for itself (`code` is set) and the quit flow's own (`is_quitting`) go through.
        RunEvent::ExitRequested {
            code: None, api, ..
        } if !lock(&app.state::<AppState>().quit).is_quitting() => {
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            open_paths(app, urls.iter().filter_map(|u| u.to_file_path().ok()));
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main(app),
        _ => {}
    }
}

/// A second launch (`draft-canvas file.draftcanvas`, or a double-click on Windows) is forwarded to the
/// running instance instead of starting another.
pub fn second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    open_paths(
        app,
        paths_from_args(args.into_iter().skip(1), Path::new(&cwd)),
    );
    // While the first instance is still starting its window is hidden on purpose and `host_ready`
    // shows it; bringing it forward here would put an empty frame on screen.
    if state.events.is_attached() {
        show_main(app);
    }
}

/// Command-line arguments as paths, made absolute against the directory the command was run from, and
/// only the ones that name a `.draftcanvas`: launchers add flags and other arguments of their own.
fn paths_from_args(args: impl Iterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.map(PathBuf::from)
        .filter(|p| has_doc_ext(p))
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) })
        .collect()
}

/// Turns files the OS asked us to open into handles and delivers them to the page (or queues them until
/// it is listening). A file that can't be opened is said out loud: nobody else will report it.
/// Checking the files touches the disk, and this is called from the event loop, so it runs on a worker.
pub fn open_paths(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|p| has_doc_ext(p)).collect();
    if paths.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let mut handles = Vec::new();
        for path in &paths {
            match state.grant_file(path) {
                Ok(handle) => handles.push(handle),
                Err(e) => show_error_later(&app, "Draft Canvas", &e.message),
            }
        }
        if handles.is_empty() {
            return;
        }
        // Before the page is ready the window is still hidden on purpose; `host_ready` will show it.
        if state.events.is_attached() {
            show_main(&app);
        }
        state.deliver_opens(handles);
    });
}

// --- closing -----------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Let the window close: the app is quitting, or the OS is shutting down.
    Allow,
    Hide,
    /// Hide, and explain (once) that the app is still in the tray, asking whether to keep it there.
    HideAndAsk,
    Quit,
}

pub fn close_action(
    behavior: CloseBehavior,
    can_hide: bool,
    quitting: bool,
    shutting_down: bool,
) -> CloseAction {
    if quitting || shutting_down {
        return CloseAction::Allow;
    }
    // With no tray icon (and no dock to bring it back on macOS) a hidden window could never return.
    if !can_hide {
        return CloseAction::Quit;
    }
    match behavior {
        CloseBehavior::Ask => CloseAction::HideAndAsk,
        CloseBehavior::Tray => CloseAction::Hide,
        CloseBehavior::Quit => CloseAction::Quit,
    }
}

/// Windows tells a program it is being closed because the machine is shutting down; refusing then
/// would stall the shutdown, so the close is let through.
#[cfg(windows)]
fn system_shutting_down() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: a plain query with no pointers.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

#[cfg(not(windows))]
fn system_shutting_down() -> bool {
    false
}

/// The window's close button (`api` is set) and the Close Window shortcut (`api` is `None`) share this,
/// so they can never disagree about what closing means.
pub fn close_window(app: &AppHandle, api: Option<&tauri::CloseRequestApi>) {
    let state = app.state::<AppState>();
    let can_hide = cfg!(target_os = "macos") || state.tray_ready.load(Ordering::SeqCst);
    let shutting_down = system_shutting_down();
    let action = close_action(
        state.settings.get().close_behavior,
        can_hide,
        lock(&state.quit).is_quitting(),
        shutting_down,
    );
    if action == CloseAction::Allow {
        if shutting_down {
            // Mark the quit so the app exits with its last window instead of lingering in the tray.
            lock(&state.quit).quit_now();
        }
        return;
    }
    if let Some(api) = api {
        api.prevent_close();
    }
    match action {
        CloseAction::Hide => hide_main(app),
        CloseAction::HideAndAsk => {
            hide_main(app);
            explain_tray(app);
        }
        CloseAction::Quit => request_quit(app),
        CloseAction::Allow => {}
    }
}

pub fn request_close(app: &AppHandle) {
    close_window(app, None);
}

fn hide_main(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
    }
}

fn tray_place(platform: Platform) -> &'static str {
    match platform {
        Platform::Macos => "menu bar",
        Platform::Windows | Platform::Linux => "system tray",
    }
}

/// The first time the close button is used: the window is already gone, so say where the app went and
/// let the person decide for good. Non-blocking, because this runs inside the window event handler.
fn explain_tray(app: &AppHandle) {
    let message = format!(
        "Draft Canvas is still available from the {}. Keep it running there, or quit?",
        tray_place(Platform::current())
    );
    let answering = app.clone();
    ask_later(
        app,
        "Draft Canvas",
        &message,
        &["Keep in Tray", "Quit"],
        move |choice| {
            let behavior = if choice == 0 {
                CloseBehavior::Tray
            } else {
                CloseBehavior::Quit
            };
            // Not being able to save the answer only means the person is asked again next time.
            let _ = answering
                .state::<AppState>()
                .settings
                .update(|s| s.close_behavior = behavior);
            if behavior == CloseBehavior::Quit {
                request_quit(&answering);
            }
        },
    );
}

// --- smoke test --------------------------------------------------------------------------------

/// CI launches the packaged app with `DRAFT_CANVAS_SMOKE=1` to prove it starts: once the page reports in
/// (or after a timeout) it prints a marker and exits.
fn smoke_requested(value: Option<&str>) -> bool {
    value == Some("1")
}

fn start_smoke(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    *lock(&app.state::<AppState>().smoke_ready) = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = rx.recv_timeout(SMOKE_TIMEOUT);
        println!("{SMOKE_MARKER}");
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [CloseBehavior; 3] = [CloseBehavior::Ask, CloseBehavior::Tray, CloseBehavior::Quit];

    #[test]
    fn closing_follows_the_stored_behavior() {
        assert_eq!(
            close_action(CloseBehavior::Ask, true, false, false),
            CloseAction::HideAndAsk
        );
        assert_eq!(
            close_action(CloseBehavior::Tray, true, false, false),
            CloseAction::Hide
        );
        assert_eq!(
            close_action(CloseBehavior::Quit, true, false, false),
            CloseAction::Quit
        );
    }

    #[test]
    fn a_quit_in_progress_or_a_system_shutdown_is_never_blocked() {
        for behavior in ALL {
            for can_hide in [true, false] {
                assert_eq!(
                    close_action(behavior, can_hide, true, false),
                    CloseAction::Allow
                );
                assert_eq!(
                    close_action(behavior, can_hide, false, true),
                    CloseAction::Allow
                );
                assert_eq!(
                    close_action(behavior, can_hide, true, true),
                    CloseAction::Allow
                );
            }
        }
    }

    #[test]
    fn without_a_way_back_the_window_closes_by_quitting() {
        for behavior in ALL {
            assert_eq!(
                close_action(behavior, false, false, false),
                CloseAction::Quit
            );
        }
    }

    #[test]
    fn the_first_close_names_where_the_app_went() {
        assert_eq!(tray_place(Platform::Macos), "menu bar");
        assert_eq!(tray_place(Platform::Windows), "system tray");
        assert_eq!(tray_place(Platform::Linux), "system tray");
    }

    #[test]
    fn only_document_arguments_are_paths_and_relative_ones_use_the_launch_directory() {
        let cwd = Path::new("/work");
        let args = [
            "--flag",
            "/abs/one.draftcanvas",
            "rel/two.DraftCanvas",
            "notes.txt",
            "",
            "three.draftcanvas",
        ]
        .map(String::from);
        let paths = paths_from_args(args.into_iter(), cwd);
        assert_eq!(
            paths,
            [
                PathBuf::from("/abs/one.draftcanvas"),
                PathBuf::from("/work/rel/two.DraftCanvas"),
                PathBuf::from("/work/three.draftcanvas"),
            ]
        );
    }

    #[test]
    fn no_arguments_means_no_paths() {
        assert!(paths_from_args(std::iter::empty(), Path::new("/w")).is_empty());
    }

    #[test]
    fn the_smoke_test_is_opt_in_by_exactly_one() {
        assert!(smoke_requested(Some("1")));
        for off in [None, Some(""), Some("0"), Some("true"), Some("yes")] {
            assert!(!smoke_requested(off), "{off:?}");
        }
    }
}
