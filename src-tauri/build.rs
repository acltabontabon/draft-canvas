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
    "rename_file",
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
    "project_grant_file",
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
    "agent_ack",
    "agent_gate",
    "agent_cancel",
    "agent_progress",
    "agent_respond",
    "agent_status",
    "agent_configure",
    "agent_proposal_list",
    "agent_proposal_get",
    "agent_proposal_begin_accept",
    "agent_proposal_resolve",
];

fn main() {
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if embed_windows_manifest() {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to run the Tauri build script");
}

// Tauri embeds its Windows manifest (Common Controls v6) as a resource of the app binary only, so the
// unit-test binary linked without it and died on start with STATUS_ENTRYPOINT_NOT_FOUND once the lib
// grew a reference into comctl32 v6. Handing the same manifest to the linker reaches every binary this
// crate links, tests included.
fn embed_windows_manifest() -> bool {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return false;
    }
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    true
}
