//! `settings.json` in the app's config folder. The page can read and change only `closeBehavior`;
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub v: u32,
    pub close_behavior: CloseBehavior,
    pub last_project: Option<LastProject>,
    pub last_dir: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            v: VERSION,
            close_behavior: CloseBehavior::default(),
            last_project: None,
            last_dir: None,
        }
    }
}

/// The part of the settings the page is allowed to see: exactly `DesktopSettings` in `api.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub close_behavior: CloseBehavior,
}

impl Settings {
    pub fn public(&self) -> DesktopSettings {
        DesktopSettings {
            close_behavior: self.close_behavior,
        }
    }
}

/// What `settings_set` accepts. Anything but a whitelisted key is refused rather than ignored, so the
/// page can't write `lastProject` (a path) by naming it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub close_behavior: Option<CloseBehavior>,
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
            Ok(settings) if settings.v == VERSION => settings,
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
        assert!(store.get().last_project.is_none() && store.get().last_dir.is_none());
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
        assert!(settings.last_project.is_none());
        assert!(!dir.path().join("settings.json.bad").exists());
    }

    #[test]
    fn stored_and_public_shapes() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        let settings = store
            .update(|s| {
                s.last_project = Some(LastProject {
                    path: "/p".into(),
                    name: "p".into(),
                });
            })
            .unwrap();
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
        assert_eq!(
            stored,
            json!({"v": 1, "closeBehavior": "ask", "lastProject": {"path": "/p", "name": "p"}, "lastDir": null})
        );
        assert_eq!(
            serde_json::to_value(settings.public()).unwrap(),
            json!({"closeBehavior": "ask"})
        );
    }
}
