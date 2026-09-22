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
    pub last_project: Option<ProjectInfo>,
}

/// The folder the last session had open, if it is still there. Only offered: nothing is opened from it.
fn last_project(state: &AppState) -> Option<ProjectInfo> {
    let last = state.settings.get().last_project?;
    project_info(state, Path::new(&last.path)).ok()
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
            last_project: last_project(state),
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
            last_project: Some(ProjectInfo {
                handle: "h_1".into(),
                name: "P".into(),
                display_path: "~/P".into(),
            }),
        };
        assert_eq!(
            serde_json::to_value(boot).unwrap(),
            json!({
                "version": "1.10.0",
                "platform": "macos",
                "settings": {"closeBehavior": "ask", "autoCheckUpdates": true},
                "lastProject": {"handle": "h_1", "name": "P", "displayPath": "~/P"}
            })
        );
        let bare = HostBoot {
            version: "1".into(),
            platform: Platform::Windows,
            settings: DesktopSettings {
                close_behavior: crate::settings::CloseBehavior::Quit,
                auto_check_updates: false,
            },
            last_project: None,
        };
        assert_eq!(
            serde_json::to_value(bare).unwrap()["lastProject"],
            json!(null)
        );
    }

    #[test]
    fn the_last_project_is_offered_only_while_it_still_exists() {
        let (dir, state) = test_state();
        assert!(last_project(&state).is_none());

        let folder = dir.path().join("Payments");
        fs::create_dir(&folder).unwrap();
        let path = dunce::canonicalize(&folder)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        state
            .settings
            .update(|s| {
                s.last_project = Some(LastProject {
                    path,
                    name: "Payments".into(),
                })
            })
            .unwrap();
        let info = last_project(&state).unwrap();
        assert_eq!(info.name, "Payments");
        assert!(
            state.project(&info.handle).is_ok(),
            "the handle is usable straight away"
        );

        fs::remove_dir(&folder).unwrap();
        assert!(last_project(&state).is_none());
    }

    #[test]
    fn a_last_project_that_is_now_a_file_is_not_offered() {
        let (dir, state) = test_state();
        let file = dir.path().join("not-a-folder");
        fs::write(&file, "x").unwrap();
        let path = file.to_str().unwrap().to_string();
        state
            .settings
            .update(|s| {
                s.last_project = Some(LastProject {
                    path,
                    name: "x".into(),
                })
            })
            .unwrap();
        assert!(last_project(&state).is_none());
    }
}
