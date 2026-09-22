//! The tray panel: the small window a left click on the tray icon opens beside it — Home in
//! miniature, with every diagram drawn as itself. On Windows and Linux a right click still opens the
//! plain native menu; on macOS the panel is the tray (see `tray::NATIVE_MENU`), and if it can't be
//! built the main window comes forward instead.
//!
//! It is one window, built the first time it is wanted and then shown and hidden, placed from the
//! icon's own rectangle and kept inside the work area of whichever display that icon is on. It only
//! ever opens because someone clicked for it, and clicking anywhere else puts it away.

use crate::window::allows_navigation;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, PhysicalPosition, Position, Rect, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const PANEL: &str = "tray";

/// Logical size. The page reports how tall it came out (`tray_panel_fit`); this is where it starts.
const WIDTH: f64 = 344.0;
const HEIGHT: f64 = 420.0;
const MIN_HEIGHT: f64 = 220.0;
const MAX_HEIGHT: f64 = 620.0;
/// Between the icon and the panel, and between the panel and a screen edge.
const GAP: f64 = 6.0;
const MARGIN: f64 = 8.0;
/// A click on the icon while the panel is open first takes focus from it, which puts it away; the click
/// that follows must not bring it straight back.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

struct Placement {
    /// The icon's rectangle the panel last opened from, kept so a new height can be placed again.
    icon: Option<Rect>,
    height: f64,
    hidden_at: Option<Instant>,
}

static PLACEMENT: Mutex<Placement> = Mutex::new(Placement {
    icon: None,
    height: HEIGHT,
    hidden_at: None,
});

fn placement_state() -> std::sync::MutexGuard<'static, Placement> {
    PLACEMENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Opens the panel beside the icon at `rect`, or puts it away if it is open.
pub fn toggle(app: &AppHandle, rect: Rect) {
    if let Some(window) = app.get_webview_window(PANEL) {
        if window.is_visible().unwrap_or(false) {
            hide(app);
            return;
        }
    }
    {
        let mut state = placement_state();
        if state
            .hidden_at
            .is_some_and(|at| at.elapsed() < REOPEN_GUARD)
        {
            state.hidden_at = None;
            return;
        }
        state.icon = Some(rect);
    }
    let window = match app.get_webview_window(PANEL) {
        Some(window) => window,
        None => match build(app) {
            Ok(window) => window,
            // Nothing is stranded: the window comes forward instead, as it would from the menu.
            Err(e) => {
                eprintln!("Draft Canvas: the tray panel couldn't be built ({e})");
                crate::window::show_main(app);
                return;
            }
        },
    };
    place(app, &window);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Puts the panel away, if it is out.
pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PANEL) {
        if window.is_visible().unwrap_or(false) {
            placement_state().hidden_at = Some(Instant::now());
            let _ = window.hide();
        }
    }
}

/// The page measured itself: take that height, within reason, and stay put against the icon.
pub fn fit(app: &AppHandle, height: f64) {
    if !height.is_finite() {
        return;
    }
    placement_state().height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    if let Some(window) = app.get_webview_window(PANEL) {
        place(app, &window);
    }
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App("tray.html".into()))
        .title("Draft Canvas")
        .inner_size(WIDTH, placement_state().height)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(true)
        .visible(false)
        .focused(false)
        .on_navigation(|url| allows_navigation(url, tauri::is_dev()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .build()?;
    round_corners(&window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide(&handle);
        }
    });
    Ok(window)
}

/// A popover has the rounded corners of the menus beside it. The window is made see-through and its
/// content clipped to the curve, so the shadow follows the rounded shape rather than a square one.
#[cfg(target_os = "macos")]
fn round_corners(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSColor, NSWindow};
        let Ok(pointer) = target.ns_window() else {
            return;
        };
        // SAFETY: `ns_window` is this window's own NSWindow, alive as long as `target`, and this runs
        // on the main thread.
        let ns_window: &NSWindow = unsafe { &*pointer.cast::<NSWindow>() };
        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
        if let Some(view) = ns_window.contentView() {
            view.setWantsLayer(true);
            if let Some(layer) = view.layer() {
                layer.setCornerRadius(12.0);
                layer.setMasksToBounds(true);
            }
        }
        ns_window.invalidateShadow();
    });
}

#[cfg(not(target_os = "macos"))]
fn round_corners(_window: &WebviewWindow) {}

/// Where the panel goes, in physical pixels: centred on the icon, on the side of it that faces the
/// middle of the screen, never past the edge of the work area. `icon` and `work` are (x, y, w, h).
pub(crate) fn placement(
    icon: (f64, f64, f64, f64),
    work: (f64, f64, f64, f64),
    size: (f64, f64),
    scale: f64,
) -> (f64, f64) {
    let (ix, iy, iw, ih) = icon;
    let (wx, wy, ww, wh) = work;
    let (width, height) = (size.0 * scale, size.1 * scale);
    let gap = GAP * scale;
    let margin = MARGIN * scale;
    let clamp = |value: f64, low: f64, high: f64| {
        if high < low {
            low
        } else {
            value.clamp(low, high)
        }
    };
    let centre_x = ix + iw / 2.0;
    let centre_y = iy + ih / 2.0;
    let beside = iw > 0.0 && (ix + iw <= wx + margin || ix >= wx + ww - margin);
    let (x, y) = if beside {
        // A taskbar on the left or right edge: open sideways.
        let x = if ix >= wx + ww / 2.0 {
            ix - width - gap
        } else {
            ix + iw + gap
        };
        (x, centre_y - height / 2.0)
    } else if centre_y < wy + wh / 2.0 {
        // The menu bar, or a taskbar at the top: open below.
        (centre_x - width / 2.0, iy + ih + gap)
    } else {
        // The usual Windows taskbar: open above.
        (centre_x - width / 2.0, iy - height - gap)
    };
    (
        clamp(x, wx + margin, wx + ww - width - margin),
        clamp(y, wy + margin, wy + wh - height - margin),
    )
}

fn place(app: &AppHandle, window: &WebviewWindow) {
    let (rect, height) = {
        let state = placement_state();
        (state.icon, state.height)
    };
    let _ = window.set_size(tauri::LogicalSize::new(WIDTH, height));
    let Some(rect) = rect else {
        return;
    };
    // The icon's rectangle can come in physical or logical pixels; a logical one needs a scale, and
    // the display under it is what supplies that.
    let physical = |position: &Position, size: &Size, scale: f64| {
        let p = position.to_physical::<f64>(scale);
        let s = size.to_physical::<f64>(scale);
        (p.x, p.y, s.width, s.height)
    };
    let guess = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let first = physical(&rect.position, &rect.size, guess);
    let Some(monitor) = app
        .monitor_from_point(first.0 + first.2 / 2.0, first.1 + first.3 / 2.0)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
    else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let work = (
        f64::from(area.position.x),
        f64::from(area.position.y),
        f64::from(area.size.width),
        f64::from(area.size.height),
    );
    let (x, y) = placement(
        physical(&rect.position, &rect.size, scale),
        work,
        (WIDTH, height),
        scale,
    );
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK_1080: (f64, f64, f64, f64) = (0.0, 0.0, 1920.0, 1040.0);
    const SIZE: (f64, f64) = (WIDTH, HEIGHT);

    #[test]
    fn the_menu_bar_opens_it_below_the_icon() {
        let (x, y) = placement(
            (2600.0, 0.0, 44.0, 48.0),
            (0.0, 50.0, 3024.0, 1914.0),
            SIZE,
            2.0,
        );
        assert!(y >= 48.0, "{y}");
        assert!((x + WIDTH).round() <= 3024.0);
    }

    #[test]
    fn a_bottom_taskbar_opens_it_above_the_icon() {
        let (x, y) = placement((1700.0, 1044.0, 24.0, 32.0), WORK_1080, SIZE, 1.0);
        assert!(y + HEIGHT <= 1044.0, "above the icon: {y}");
        assert!(x + WIDTH <= 1920.0 - MARGIN + 0.5);
    }

    #[test]
    fn it_never_leaves_the_screen_at_the_corner() {
        let (x, y) = placement((1910.0, 1044.0, 24.0, 32.0), WORK_1080, SIZE, 1.0);
        assert!(x >= 0.0 && x + WIDTH <= 1920.0);
        assert!(y >= 0.0 && y + HEIGHT <= 1040.0);
    }

    #[test]
    fn a_side_taskbar_opens_it_sideways() {
        let (x, _) = placement(
            (4.0, 900.0, 40.0, 40.0),
            (48.0, 0.0, 1872.0, 1080.0),
            SIZE,
            1.0,
        );
        assert!(x >= 48.0);
    }

    #[test]
    fn a_display_to_the_left_is_honoured() {
        let work = (-2560.0, 0.0, 2560.0, 1400.0);
        let (x, y) = placement((-300.0, 1404.0, 36.0, 36.0), work, SIZE, 1.5);
        assert!(x >= -2560.0 && x + WIDTH * 1.5 <= 0.0, "{x}");
        assert!(y + HEIGHT * 1.5 <= 1404.0);
    }
}
