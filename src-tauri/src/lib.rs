mod commands;
mod dialogs;
mod docio;
mod errors;
mod grants;
mod lifecycle;
mod menu;
mod panel;
mod paths;
mod project;
mod quit;
mod recents;
mod recovery;
mod settings;
mod state;
mod tray;
mod updater;
mod util;
mod window;
#[cfg(test)]
mod wiring;

use state::AppState;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

pub fn run() {
    let app = tauri::Builder::default()
        // First, so a second launch is forwarded to the running app before anything else starts.
        .plugin(tauri_plugin_single_instance::init(
            lifecycle::second_instance,
        ))
        .plugin(tauri_plugin_dialog::init())
        // Driven from Rust only (`updater/`): the page is given no updater permission.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Size, position and maximised state only. Restoring visibility would show the window before
        // the page has drawn, and the app decides that moment itself (see `host_ready`).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            commands::host::host_ready,
            commands::host::report_state,
            commands::host::quit_ack,
            commands::host::quit_now,
            commands::documents::open_dialog,
            commands::documents::open_handle,
            commands::documents::save_document,
            commands::documents::save_as,
            commands::documents::check_stamp,
            commands::documents::reveal,
            commands::documents::export_file,
            commands::documents::open_external,
            commands::documents::sidecar_read,
            commands::documents::sidecar_write,
            commands::documents::sidecar_remove,
            commands::peek::peek_document,
            commands::peek::project_peek,
            commands::projects::pick_project,
            commands::projects::open_project,
            commands::projects::project_forget,
            commands::projects::project_scan,
            commands::projects::project_open_file,
            commands::projects::project_save_new,
            commands::recents::recents_list,
            commands::recents::recents_remove,
            commands::recents::recents_clear,
            commands::recovery::recovery_write,
            commands::recovery::recovery_list,
            commands::recovery::recovery_read,
            commands::recovery::recovery_discard,
            commands::host::settings_get,
            commands::host::settings_set,
            commands::host::ask,
            commands::host::show_error,
            commands::tray::tray_decorate,
            commands::tray::tray_panel,
            commands::tray::tray_choose,
            commands::tray::tray_panel_fit,
            commands::updates::update_status,
            commands::updates::update_check,
            commands::updates::update_download,
            commands::updates::update_install,
            commands::updates::update_dismiss,
        ])
        .setup(lifecycle::setup)
        .build(tauri::generate_context!())
        .expect("Draft Canvas couldn't start");

    // Managed before the event loop runs, not in `setup`: a file double-clicked while the app is
    // starting arrives as an event that needs this state, possibly before `setup` has run.
    let resolver = app.path();
    let (Ok(config_dir), Ok(data_dir)) = (resolver.app_config_dir(), resolver.app_local_data_dir())
    else {
        eprintln!("Draft Canvas couldn't find its settings folder");
        std::process::exit(1);
    };
    app.manage(AppState::new(&config_dir, &data_dir));

    app.run(lifecycle::on_run_event);
}
