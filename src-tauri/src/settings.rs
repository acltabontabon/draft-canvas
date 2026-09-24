//! `settings.json` in the app's config folder. The page can read and change only `closeBehavior` and
//! `autoCheckUpdates`;
//! the last project and last dialog folder are written by Rust after a dialog, never by the page.

use crate::docio::write_private;
use crate::errors::{AppError, Subject, Verb};
use crate::util::lock;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const VERSION: u32 = 1;

/// What the window's close button does. `Ask` is the first-run state: the first close explains the
/// tray and stores the answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Tray,
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastProject {
    pub path: String,
    pub name: String,
    /// Whether AI agents may read and change the diagrams in this folder. Off until the person turns
    /// it on for this folder in Settings; a file written before this existed reads as off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub v: u32,
    pub close_behavior: CloseBehavior,
    /// Look for a newer version shortly after launch and once a day. Only ever looks: downloading and
    /// installing are always asked for. A file written before this existed reads as on.
    pub auto_check_updates: bool,
    /// The project folders the person has added, most recently opened first. Written by Rust after a
    /// folder is picked or opened, never by the page.
    pub projects: Vec<LastProject>,
    /// Before there could be several: the one project the last session had open. Read once into
    /// `projects`, and never written again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_project: Option<LastProject>,
    pub last_dir: Option<String>,
    /// Agent access as a whole (`agent/`). Off by default; turned on in Settings, never by the page's
    /// ordinary settings patch.
    pub agent_access: bool,
}

/// How many projects are remembered. Past this the oldest is let go; its folder is untouched, and adding
/// it again brings it back.
pub const PROJECTS_CAP: usize = 50;

impl Default for Settings {
    fn default() -> Self {
        Self {
            v: VERSION,
            close_behavior: CloseBehavior::default(),
            auto_check_updates: true,
            projects: Vec::new(),
            last_project: None,
            last_dir: None,
            agent_access: false,
        }
    }
}

impl Settings {
    /// Puts a project first, adding it if it's new, and keeps the list within its cap.
    pub fn remember_project(&mut self, mut project: LastProject) {
        // Opening a project again keeps the person's choice about agents for it.
        if let Some(known) = self.projects.iter().find(|p| p.path == project.path) {
            project.agent |= known.agent;
        }
        self.projects.retain(|p| p.path != project.path);
        self.projects.insert(0, project);
        self.projects.truncate(PROJECTS_CAP);
    }

    /// Lets a project go from the list. Only the list: the folder and its files are never touched.
    pub fn forget_project(&mut self, path: &str) {
        self.projects.retain(|p| p.path != path);
    }

    /// A file written when there could only be one project becomes a list of one.
    fn migrate(mut self) -> Self {
        if let Some(last) = self.last_project.take() {
            if !self.projects.iter().any(|p| p.path == last.path) {
                self.projects.insert(0, last);
            }
        }
        self
    }
}

/// The part of the settings the page is allowed to see: exactly `DesktopSettings` in `api.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub close_behavior: CloseBehavior,
    pub auto_check_updates: bool,
}

impl Settings {
    /// The part the page may see.
    pub fn public(&self) -> DesktopSettings {
        DesktopSettings {
            close_behavior: self.close_behavior,
            auto_check_updates: self.auto_check_updates,
        }
    }
}

/// What `settings_set` accepts. Anything but a whitelisted key is refused rather than ignored, so the
/// page can't write `lastProject` (a path) by naming it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub close_behavior: Option<CloseBehavior>,
    pub auto_check_updates: Option<bool>,
}

/// The file is read once and then kept in memory: this app is its only writer, and `get` is called
/// from places (the window's close button, every open) that must not wait on a disk, which on a roaming
/// Windows profile can be a network share.
pub struct SettingsStore {
    file: PathBuf,
    cache: Mutex<Option<Settings>>,
}

impl SettingsStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            file: config_dir.join("settings.json"),
            cache: Mutex::new(None),
        }
    }

    pub fn get(&self) -> Settings {
        let mut cache = lock(&self.cache);
        cache.get_or_insert_with(|| self.load()).clone()
    }

    /// Applies `change` to the settings and writes the result back, all under one lock. If the write
    /// fails the in-memory settings are left as they were.
    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, AppError> {
        let mut cache = lock(&self.cache);
        let mut settings = cache.clone().unwrap_or_else(|| self.load());
        change(&mut settings);
        self.store(&settings)?;
        *cache = Some(settings.clone());
        Ok(settings)
    }

    pub fn apply(&self, patch: SettingsPatch) -> Result<Settings, AppError> {
        self.update(|s| {
            if let Some(behavior) = patch.close_behavior {
                s.close_behavior = behavior;
            }
            if let Some(auto) = patch.auto_check_updates {
                s.auto_check_updates = auto;
            }
        })
    }

    /// Same recovery rule as Recent: unreadable or unrecognised settings are kept as `settings.json.bad`
    /// and the defaults apply, so a damaged file can't stop the app from starting.
    fn load(&self) -> Settings {
        let bytes = match fs::read(&self.file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Settings::default(),
            Err(_) => return self.set_aside(),
        };
        match serde_json::from_slice::<Settings>(&bytes) {
            Ok(settings) if settings.v == VERSION => settings.migrate(),
            _ => self.set_aside(),
        }
    }

    fn set_aside(&self) -> Settings {
        let mut bad = self.file.clone().into_os_string();
        bad.push(".bad");
        let _ = fs::rename(&self.file, bad);
        Settings::default()
    }

    fn store(&self, settings: &Settings) -> Result<(), AppError> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| AppError::from_io(&e, Verb::Save, Subject::Preferences))?;
        }
        let json = serde_json::to_vec_pretty(settings).map_err(|_| AppError::internal())?;
        write_private(&self.file, &json, Subject::Preferences)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn defaults_when_nothing_is_stored() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(&dir.path().join("config"));
        assert_eq!(store.get(), Settings::default());
        assert_eq!(store.get().close_behavior, CloseBehavior::Ask);
        assert!(store.get().projects.is_empty() && store.get().last_dir.is_none());
    }

    #[test]
    fn a_patch_changes_only_the_close_behavior_and_persists() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        store
            .update(|s| s.last_dir = Some("/somewhere".into()))
            .unwrap();
        let after = store
            .apply(SettingsPatch {
                close_behavior: Some(CloseBehavior::Tray),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(after.close_behavior, CloseBehavior::Tray);
        assert_eq!(after.last_dir.as_deref(), Some("/somewhere"));

        let reread = SettingsStore::new(dir.path()).get();
        assert_eq!(reread.close_behavior, CloseBehavior::Tray);
        let empty = store.apply(SettingsPatch::default()).unwrap();
        assert_eq!(empty.close_behavior, CloseBehavior::Tray);
    }

    #[test]
    fn the_page_may_only_name_whitelisted_keys_with_valid_values() {
        let ok: SettingsPatch = serde_json::from_value(json!({"closeBehavior": "quit"})).unwrap();
        assert_eq!(ok.close_behavior, Some(CloseBehavior::Quit));
        assert!(serde_json::from_value::<SettingsPatch>(json!({}))
            .unwrap()
            .close_behavior
            .is_none());
        for bad in [
            json!({"lastProject": {"path": "/etc", "name": "x"}}),
            json!({"lastDir": "/etc"}),
            json!({"closeBehavior": "explode"}),
            json!({"closeBehavior": "quit", "v": 9}),
        ] {
            assert!(
                serde_json::from_value::<SettingsPatch>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_corrupt_file_is_kept_as_bad_and_defaults_apply() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("settings.json"), "][").unwrap();
        let store = SettingsStore::new(dir.path());
        assert_eq!(store.get(), Settings::default());
        assert_eq!(
            fs::read_to_string(dir.path().join("settings.json.bad")).unwrap(),
            "]["
        );
        store
            .apply(SettingsPatch {
                close_behavior: Some(CloseBehavior::Quit),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(store.get().close_behavior, CloseBehavior::Quit);
    }

    #[test]
    fn the_file_is_read_once_and_kept_in_memory() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"v":1,"closeBehavior":"tray"}"#,
        )
        .unwrap();
        let store = SettingsStore::new(dir.path());
        assert_eq!(store.get().close_behavior, CloseBehavior::Tray);
        fs::remove_file(dir.path().join("settings.json")).unwrap();
        assert_eq!(store.get().close_behavior, CloseBehavior::Tray);
    }

    #[test]
    fn a_failed_write_leaves_the_settings_as_they_were() {
        let dir = tempdir().unwrap();
        let not_a_folder = dir.path().join("file");
        fs::write(&not_a_folder, "x").unwrap();
        let store = SettingsStore::new(&not_a_folder);
        let err = store
            .apply(SettingsPatch {
                close_behavior: Some(CloseBehavior::Quit),
                ..Default::default()
            })
            .err()
            .unwrap();
        assert!(err.message.contains("your settings"));
        assert_eq!(store.get().close_behavior, CloseBehavior::Ask);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"v":1,"closeBehavior":"tray"}"#,
        )
        .unwrap();
        let settings = SettingsStore::new(dir.path()).get();
        assert_eq!(settings.close_behavior, CloseBehavior::Tray);
        assert!(settings.projects.is_empty());
        // Written before the updater existed: it looks for updates, as a new install does.
        assert!(settings.auto_check_updates);
        assert!(!dir.path().join("settings.json.bad").exists());
    }

    #[test]
    fn the_one_project_of_an_older_file_becomes_a_list_of_one() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("settings.json"),
            r#"{"v":1,"lastProject":{"path":"/work/payments","name":"payments"}}"#,
        )
        .unwrap();
        let store = SettingsStore::new(dir.path());
        let settings = store.get();
        assert_eq!(settings.projects.len(), 1);
        assert_eq!(settings.projects[0].name, "payments");
        assert!(settings.last_project.is_none());
        // Once written back, the old key is gone.
        store.update(|_| {}).unwrap();
        let stored = fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(!stored.contains("lastProject"));
    }

    #[test]
    fn projects_are_most_recent_first_without_duplicates_and_capped() {
        let mut settings = Settings::default();
        let project = |n: usize| LastProject {
            path: format!("/p/{n}"),
            name: format!("p{n}"),
            agent: false,
        };
        for n in 0..PROJECTS_CAP + 5 {
            settings.remember_project(project(n));
        }
        assert_eq!(settings.projects.len(), PROJECTS_CAP);
        assert_eq!(
            settings.projects[0].path,
            format!("/p/{}", PROJECTS_CAP + 4)
        );
        settings.remember_project(project(10));
        assert_eq!(settings.projects[0].path, "/p/10");
        assert_eq!(settings.projects.len(), PROJECTS_CAP);
        settings.forget_project("/p/10");
        assert!(settings.projects.iter().all(|p| p.path != "/p/10"));
    }

    #[test]
    fn checking_for_updates_can_be_turned_off_and_stays_off() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        let patch: SettingsPatch =
            serde_json::from_value(json!({"autoCheckUpdates": false})).unwrap();
        assert!(!store.apply(patch).unwrap().auto_check_updates);
        assert!(!SettingsStore::new(dir.path()).get().auto_check_updates);
        assert!(
            serde_json::from_value::<SettingsPatch>(json!({"autoCheckUpdates": "no"})).is_err()
        );
    }

    #[test]
    fn stored_and_public_shapes() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        let settings = store
            .update(|s| {
                s.remember_project(LastProject {
                    path: "/p".into(),
                    name: "p".into(),
                    agent: false,
                });
            })
            .unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            stored,
            json!({"v": 1, "closeBehavior": "ask", "autoCheckUpdates": true, "projects": [{"path": "/p", "name": "p"}], "lastDir": null, "agentAccess": false})
        );
        assert_eq!(
            serde_json::to_value(settings.public()).unwrap(),
            json!({"closeBehavior": "ask", "autoCheckUpdates": true})
        );
    }
}
