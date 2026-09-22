//! Lifecycle, settings and dialogs: how the page and the shell find each other.

use super::projects::{project_info, ProjectInfo};
use super::run_blocking;
use crate::dialogs;
use crate::errors::AppError;
use crate::quit::{self, QuitDecision};
use crate::settings::{DesktopSettings, SettingsPatch};
use crate::state::{AppState, HostEvent};
use crate::util::lock;
use crate::window::{apply_state, show_main, Platform, ReportedState};
use serde::Serialize;
use std::path::Path;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBoot {
    pub version: String,
    pub platform: Platform,
    pub settings: DesktopSettings,
    /// Every project on the list whose folder is still there, most recent first.
    pub projects: Vec<ProjectInfo>,
}

/// The project folders the person has added and that still exist, each with a handle. A folder that has
/// gone (an unplugged drive, a deleted checkout) is left off, but stays on the list for when it's back.
pub(crate) fn projects(state: &AppState) -> Vec<ProjectInfo> {
    state
        .settings
        .get()
        .projects
        .iter()
        .filter_map(|project| project_info(state, Path::new(&project.path)).ok())
        .collect()
}

/// The page's first call. It attaches the event channel (and receives anything the OS asked us to open
/// before it was listening), then the window, which was created hidden, is shown.
#[tauri::command]
pub async fn host_ready(
    app: AppHandle,
    on_event: Channel<HostEvent>,
) -> Result<HostBoot, AppError> {
    run_blocking(&app, move |app, state| {
        state.attach_page(on_event);
        let boot = HostBoot {
            version: app.package_info().version.to_string(),
            platform: Platform::current(),
            settings: state.settings.get().public(),
            projects: projects(state),
        };
        show_main(app);
        if let Some(ready) = lock(&state.smoke_ready).take() {
            let _ = ready.send(());
        }
        Ok(boot)
    })
    .await
}

/// Keeps the window title (and on macOS the edited dot and proxy icon) in step with the document.
#[tauri::command]
pub async fn report_state(app: AppHandle, state: ReportedState) -> Result<(), AppError> {
    run_blocking(&app, move |app, shared| {
        let file = match &state {
            ReportedState::File { handle, .. } => shared.file(handle).ok().map(|g| g.path),
            _ => None,
        };
        apply_state(app, &state, file);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn quit_ack(app: AppHandle, decision: QuitDecision) -> Result<(), AppError> {
    quit::acknowledge(&app, decision);
    Ok(())
}

#[tauri::command]
pub async fn quit_now(app: AppHandle) -> Result<(), AppError> {
    quit::quit_now(&app);
    Ok(())
}

#[tauri::command]
pub async fn settings_get(app: AppHandle) -> Result<DesktopSettings, AppError> {
    run_blocking(&app, |_, state| Ok(state.settings.get().public())).await
}

#[tauri::command]
pub async fn settings_set(
    app: AppHandle,
    patch: SettingsPatch,
) -> Result<DesktopSettings, AppError> {
    let turned_on = patch.auto_check_updates == Some(true);
    let settings = run_blocking(&app, move |_, state| {
        Ok(state.settings.apply(patch)?.public())
    })
    .await?;
    // Checking was switched back on: look now rather than tomorrow.
    if turned_on {
        if let Some(wake) = app.try_state::<std::sync::Arc<crate::updater::CheckWake>>() {
            wake.wake();
        }
    }
    Ok(settings)
}

/// The one message box the page uses for every question. All its wording is the page's.
#[tauri::command]
pub async fn ask(
    app: AppHandle,
    title: String,
    message: String,
    buttons: Vec<String>,
) -> Result<usize, AppError> {
    run_blocking(&app, move |app, _| {
        dialogs::ask(app, &title, &message, &buttons)
    })
    .await
}

#[tauri::command]
pub async fn show_error(app: AppHandle, title: String, message: String) -> Result<(), AppError> {
    run_blocking(&app, move |app, _| {
        dialogs::show_error(app, &title, &message);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::test_state;
    use crate::settings::LastProject;
    use serde_json::json;
    use std::fs;

    #[test]
    fn the_boot_payload_has_the_shape_the_page_reads() {
        let boot = HostBoot {
            version: "1.10.0".into(),
            platform: Platform::Macos,
            settings: DesktopSettings {
                close_behavior: crate::settings::CloseBehavior::Ask,
                auto_check_updates: true,
            },
            projects: vec![ProjectInfo {
                handle: "h_1".into(),
                name: "P".into(),
                display_path: "~/P".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(boot).unwrap(),
            json!({
                "version": "1.10.0",
                "platform": "macos",
                "settings": {"closeBehavior": "ask", "autoCheckUpdates": true},
                "projects": [{"handle": "h_1", "name": "P", "displayPath": "~/P"}]
            })
        );
    }

    fn add(state: &AppState, folder: &std::path::Path) {
        let path = folder.to_str().unwrap().to_string();
        let name = folder.file_name().unwrap().to_str().unwrap().to_string();
        state
            .settings
            .update(|s| s.remember_project(LastProject { path, name }))
            .unwrap();
    }

    #[test]
    fn every_project_still_there_is_offered_most_recent_first() {
        let (dir, state) = test_state();
        assert!(projects(&state).is_empty());

        let payments = dunce::canonicalize(dir.path()).unwrap().join("Payments");
        let search = dunce::canonicalize(dir.path()).unwrap().join("Search");
        fs::create_dir(&payments).unwrap();
        fs::create_dir(&search).unwrap();
        add(&state, &payments);
        add(&state, &search);

        let listed = projects(&state);
        let names: Vec<&str> = listed.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Search", "Payments"]);
        assert!(
            listed.iter().all(|p| state.project(&p.handle).is_ok()),
            "each handle is usable straight away"
        );

        // A folder that's gone is left off, and back when it is.
        fs::remove_dir(&payments).unwrap();
        assert_eq!(projects(&state).len(), 1);
        fs::create_dir(&payments).unwrap();
        assert_eq!(projects(&state).len(), 2);
    }

    #[test]
    fn a_project_that_is_now_a_file_is_not_offered() {
        let (dir, state) = test_state();
        let file = dir.path().join("not-a-folder");
        fs::write(&file, "x").unwrap();
        add(&state, &file);
        assert!(projects(&state).is_empty());
    }
}
