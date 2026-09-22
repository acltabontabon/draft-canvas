//! Native dialogs. The blocking functions are for use off the main thread only (the commands run them
//! inside `spawn_blocking`); a dialog waits on the person as long as it takes and must never hold up a
//! command thread that other requests need.

use crate::errors::AppError;
use crate::paths::DOC_EXT;
use crate::window::main_window;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

/// One entry of a save dialog's file-type list, as the page describes it.
#[derive(Debug, Clone, Deserialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// The window a dialog should belong to (so it opens as a sheet on macOS, and stays in front of the
/// window on Windows), but only if the person can see it. A dialog owned by a hidden window is never shown.
fn owner(app: &AppHandle) -> Option<WebviewWindow> {
    let window = main_window(app)?;
    let seen = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    seen.then_some(window)
}

pub fn pick_file(app: &AppHandle, start_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Draft Canvas diagram", &[DOC_EXT]);
    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = owner(app) {
        dialog = dialog.set_parent(&window);
    }
    dialog.blocking_pick_file().and_then(|p| p.into_path().ok())
}

pub fn pick_folder(app: &AppHandle, start_dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut dialog = app.dialog().file();
    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = owner(app) {
        dialog = dialog.set_parent(&window);
    }
    dialog
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
}

pub fn save_file(
    app: &AppHandle,
    start_dir: Option<PathBuf>,
    file_name: &str,
    filters: &[FileFilter],
) -> Option<PathBuf> {
    let mut dialog = app.dialog().file().set_file_name(file_name);
    for filter in filters {
        let extensions = clean_extensions(&filter.extensions);
        if !extensions.is_empty() {
            let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &extensions);
        }
    }
    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    if let Some(window) = owner(app) {
        dialog = dialog.set_parent(&window);
    }
    dialog.blocking_save_file().and_then(|p| p.into_path().ok())
}

/// `.png`, `PNG` and `png` all mean the same filter entry.
fn clean_extensions(extensions: &[String]) -> Vec<String> {
    extensions
        .iter()
        .map(|e| e.trim().trim_start_matches('.').to_string())
        .filter(|e| !e.is_empty())
        .collect()
}

/// One to three buttons, mapped onto the native shapes: the first is the default one, the last is what
/// closing the box any other way means. All wording is the page's.
fn message_buttons(buttons: &[String]) -> Option<MessageDialogButtons> {
    match buttons {
        [a] => Some(MessageDialogButtons::OkCustom(a.clone())),
        [a, b] => Some(MessageDialogButtons::OkCancelCustom(a.clone(), b.clone())),
        [a, b, c] => Some(MessageDialogButtons::YesNoCancelCustom(
            a.clone(),
            b.clone(),
            c.clone(),
        )),
        _ => None,
    }
}

/// Which button was pressed. A named button is found by its label; the platform's own Ok/Yes/No/Cancel
/// (what some report for the first, second and last button, or for Escape and the window's close
/// button) map by position, and anything unrecognised is the last button, the one that changes nothing.
pub fn button_index(result: &MessageDialogResult, buttons: &[String]) -> usize {
    let last = buttons.len().saturating_sub(1);
    match result {
        MessageDialogResult::Custom(label) => {
            buttons.iter().position(|b| b == label).unwrap_or(last)
        }
        MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
        MessageDialogResult::No => 1.min(last),
        MessageDialogResult::Cancel => last,
    }
}

fn message_dialog(
    app: &AppHandle,
    title: &str,
    message: &str,
    buttons: MessageDialogButtons,
    kind: MessageDialogKind,
) -> tauri_plugin_dialog::MessageDialogBuilder<tauri::Wry> {
    let mut dialog = app
        .dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(buttons);
    if let Some(window) = owner(app) {
        dialog = dialog.parent(&window);
    }
    dialog
}

/// Blocks until the person answers; returns the index of the button pressed.
pub fn ask(
    app: &AppHandle,
    title: &str,
    message: &str,
    buttons: &[String],
) -> Result<usize, AppError> {
    let native = message_buttons(buttons)
        .ok_or_else(|| AppError::bad_request("a message box needs one to three buttons"))?;
    let result = message_dialog(app, title, message, native, MessageDialogKind::Info)
        .blocking_show_with_result();
    Ok(button_index(&result, buttons))
}

/// Same as `ask` but returns at once and reports through `answered`. For questions raised from an event
/// handler on the main thread, which must not block.
pub fn ask_later(
    app: &AppHandle,
    title: &str,
    message: &str,
    buttons: &[&str],
    answered: impl FnOnce(usize) + Send + 'static,
) {
    let labels: Vec<String> = buttons.iter().map(|b| b.to_string()).collect();
    let Some(native) = message_buttons(&labels) else {
        return;
    };
    message_dialog(app, title, message, native, MessageDialogKind::Info)
        .show_with_result(move |result| answered(button_index(&result, &labels)));
}

pub fn show_error(app: &AppHandle, title: &str, message: &str) {
    message_dialog(
        app,
        title,
        message,
        MessageDialogButtons::Ok,
        MessageDialogKind::Error,
    )
    .blocking_show();
}

/// For failures with nobody to report to (a file the OS asked us to open, before the page exists).
pub fn show_error_later(app: &AppHandle, title: &str, message: &str) {
    message_dialog(
        app,
        title,
        message,
        MessageDialogButtons::Ok,
        MessageDialogKind::Error,
    )
    .show(|_| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn buttons_map_onto_the_native_shapes() {
        assert!(
            matches!(message_buttons(&labels(&["OK"])), Some(MessageDialogButtons::OkCustom(a)) if a == "OK")
        );
        assert!(matches!(
            message_buttons(&labels(&["Save", "Cancel"])),
            Some(MessageDialogButtons::OkCancelCustom(a, b)) if a == "Save" && b == "Cancel"
        ));
        assert!(matches!(
            message_buttons(&labels(&["Save", "Don't Save", "Cancel"])),
            Some(MessageDialogButtons::YesNoCancelCustom(a, b, c)) if a == "Save" && b == "Don't Save" && c == "Cancel"
        ));
        assert!(message_buttons(&[]).is_none());
        assert!(message_buttons(&labels(&["a", "b", "c", "d"])).is_none());
    }

    #[test]
    fn a_named_button_is_found_by_its_label() {
        let buttons = labels(&["Save", "Don't Save", "Cancel"]);
        for (i, label) in ["Save", "Don't Save", "Cancel"].iter().enumerate() {
            assert_eq!(
                button_index(&MessageDialogResult::Custom(label.to_string()), &buttons),
                i
            );
        }
    }

    #[test]
    fn any_other_way_of_closing_the_box_is_the_last_button() {
        let three = labels(&["Save", "Don't Save", "Cancel"]);
        assert_eq!(button_index(&MessageDialogResult::Cancel, &three), 2);
        assert_eq!(
            button_index(
                &MessageDialogResult::Custom("something else".into()),
                &three
            ),
            2
        );
        let two = labels(&["Quit", "Keep working"]);
        assert_eq!(button_index(&MessageDialogResult::Cancel, &two), 1);
        assert_eq!(
            button_index(&MessageDialogResult::Custom(String::new()), &two),
            1
        );
        let one = labels(&["OK"]);
        assert_eq!(button_index(&MessageDialogResult::Cancel, &one), 0);
    }

    #[test]
    fn platform_answers_map_by_position() {
        let three = labels(&["Save", "Don't Save", "Cancel"]);
        assert_eq!(button_index(&MessageDialogResult::Yes, &three), 0);
        assert_eq!(button_index(&MessageDialogResult::Ok, &three), 0);
        assert_eq!(button_index(&MessageDialogResult::No, &three), 1);
        let one = labels(&["OK"]);
        assert_eq!(button_index(&MessageDialogResult::No, &one), 0);
    }

    #[test]
    fn filter_extensions_are_normalised() {
        let cleaned = clean_extensions(&[
            ".png".into(),
            " svg ".into(),
            "".into(),
            "..".into(),
            "mmd".into(),
        ]);
        assert_eq!(cleaned, ["png", "svg", "mmd"]);
    }
}
