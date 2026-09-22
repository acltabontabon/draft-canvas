// Every command is listed here so Tauri generates an `allow-<command>` permission for each one and the
// webview can call nothing that isn't named in capabilities/default.json. Adding a command to the
// handler without adding it here (and there) makes the call fail at runtime, not silently succeed.
const COMMANDS: &[&str] = &[
    "host_ready",
    "report_state",
    "quit_ack",
    "quit_now",
    "open_dialog",
    "open_handle",
    "save_document",
    "save_as",
    "check_stamp",
    "reveal",
    "export_file",
    "open_external",
    "sidecar_read",
    "sidecar_write",
    "sidecar_remove",
    "peek_document",
    "project_peek",
    "pick_project",
    "open_project",
    "project_forget",
    "project_scan",
    "project_open_file",
    "project_save_new",
    "recents_list",
    "recents_remove",
    "recents_clear",
    "recovery_write",
    "recovery_list",
    "recovery_read",
    "recovery_discard",
    "settings_get",
    "settings_set",
    "ask",
    "show_error",
    "tray_decorate",
    "tray_panel",
    "tray_choose",
    "tray_panel_fit",
    "update_status",
    "update_check",
    "update_download",
    "update_install",
    "update_dismiss",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
