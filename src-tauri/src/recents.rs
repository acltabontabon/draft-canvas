//! The Recent list: `recents.json` in the app's config folder. Rust owns the file; the page only ever
//! sees entries as handles minted from these paths.

use crate::docio::write_private;
use crate::errors::{AppError, Subject, Verb};
use crate::util::lock;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CAP: usize = 15;
const VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecentKind {
    File,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub kind: RecentKind,
    /// Canonical, absolute. It is never shown as-is; the page gets a handle and a display path.
    pub path: String,
    pub name: String,
    pub last_opened_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct RecentsFile {
    v: u32,
    items: Vec<RecentEntry>,
}

pub struct Listing {
    pub items: Vec<RecentEntry>,
    /// Entries for files that no longer exist were dropped; whoever mirrors the list (the tray) must refresh.
    pub pruned: bool,
}

/// Each method reads, changes and rewrites the file under one lock, so two commands can't interleave
/// and lose an update.
pub struct Recents {
    file: PathBuf,
    guard: Mutex<()>,
}

impl Recents {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            file: config_dir.join("recents.json"),
            guard: Mutex::new(()),
        }
    }

    /// Newest first. Entries whose file (or folder) has gone are removed for good and the file is
    /// rewritten only when something was.
    pub fn list(&self) -> Result<Listing, AppError> {
        let _held = lock(&self.guard);
        let mut items = self.load();
        let before = items.len();
        items.retain(still_exists);
        let pruned = items.len() != before;
        if pruned {
            self.store(&items)?;
        }
        Ok(Listing { items, pruned })
    }

    /// Moves the entry to the front (adding it if new), keeping at most 15 files and projects together.
    pub fn add(
        &self,
        kind: RecentKind,
        path: &Path,
        name: &str,
        now_ms: u64,
    ) -> Result<(), AppError> {
        let Some(path) = path.to_str() else {
            // A path that isn't Unicode can't be stored in JSON; it just doesn't appear in Recent.
            return Ok(());
        };
        let _held = lock(&self.guard);
        let mut items = self.load();
        items.retain(|e| e.path != path);
        items.insert(
            0,
            RecentEntry {
                kind,
                path: path.to_string(),
                name: name.to_string(),
                last_opened_ms: now_ms,
            },
        );
        items.truncate(CAP);
        self.store(&items)
    }

    /// A file's Recent entry, if it has one, keeps its place in the list but takes the renamed path and
    /// name — rewriting it in place rather than removing and re-adding, which would send it to the back.
    pub fn rename(&self, old_path: &Path, new_path: &Path, new_name: &str) -> Result<(), AppError> {
        let Some(new_path) = new_path.to_str() else {
            return Ok(());
        };
        let _held = lock(&self.guard);
        let mut items = self.load();
        let mut changed = false;
        for entry in &mut items {
            if Path::new(&entry.path) == old_path {
                entry.path = new_path.to_string();
                entry.name = new_name.to_string();
                changed = true;
            }
        }
        if changed {
            self.store(&items)?;
        }
        Ok(())
    }

    pub fn remove(&self, path: &Path) -> Result<(), AppError> {
        let _held = lock(&self.guard);
        let mut items = self.load();
        let before = items.len();
        items.retain(|e| Path::new(&e.path) != path);
        if items.len() != before {
            self.store(&items)?;
        }
        Ok(())
    }

    pub fn clear(&self) -> Result<(), AppError> {
        let _held = lock(&self.guard);
        self.store(&[])
    }

    /// A missing file is an empty list. One that can't be read or understood is set aside as
    /// `recents.json.bad` (so nothing is lost) and replaced by an empty list, rather than failing every
    /// command that touches Recent.
    fn load(&self) -> Vec<RecentEntry> {
        let bytes = match fs::read(&self.file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Vec::new(),
            Err(_) => return self.set_aside(),
        };
        match serde_json::from_slice::<RecentsFile>(&bytes) {
            Ok(file) if file.v == VERSION => {
                let mut items = file.items;
                items.sort_by_key(|e| std::cmp::Reverse(e.last_opened_ms));
                items.truncate(CAP);
                items
            }
            _ => self.set_aside(),
        }
    }

    fn set_aside(&self) -> Vec<RecentEntry> {
        let mut bad = self.file.clone().into_os_string();
        bad.push(".bad");
        let _ = fs::rename(&self.file, bad);
        Vec::new()
    }

    fn store(&self, items: &[RecentEntry]) -> Result<(), AppError> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| AppError::from_io(&e, Verb::Save, Subject::Preferences))?;
        }
        let json = serde_json::to_vec_pretty(&RecentsFile {
            v: VERSION,
            items: items.to_vec(),
        })
        .map_err(|_| AppError::internal())?;
        write_private(&self.file, &json, Subject::Preferences)
    }
}

fn still_exists(entry: &RecentEntry) -> bool {
    let path = Path::new(&entry.path);
    match entry.kind {
        RecentKind::File => path.is_file(),
        RecentKind::Project => path.is_dir(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        _dir: TempDir,
        root: PathBuf,
        recents: Recents,
    }

    fn fixture() -> Fixture {
        let dir = tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let recents = Recents::new(&root.join("config"));
        Fixture {
            _dir: dir,
            root,
            recents,
        }
    }

    fn file(f: &Fixture, name: &str) -> PathBuf {
        let path = f.root.join(name);
        fs::write(&path, "{}").unwrap();
        path
    }

    fn paths(f: &Fixture) -> Vec<String> {
        f.recents
            .list()
            .unwrap()
            .items
            .into_iter()
            .map(|e| e.name)
            .collect()
    }

    #[test]
    fn starts_empty_without_creating_anything() {
        let f = fixture();
        let listing = f.recents.list().unwrap();
        assert!(listing.items.is_empty() && !listing.pruned);
        assert!(!f.root.join("config").exists());
    }

    #[test]
    fn newest_first_and_a_reopened_file_moves_to_the_top_without_duplicating() {
        let f = fixture();
        let (a, b) = (file(&f, "a.draftcanvas"), file(&f, "b.draftcanvas"));
        f.recents.add(RecentKind::File, &a, "a", 1).unwrap();
        f.recents.add(RecentKind::File, &b, "b", 2).unwrap();
        assert_eq!(paths(&f), ["b", "a"]);
        f.recents.add(RecentKind::File, &a, "a", 3).unwrap();
        assert_eq!(paths(&f), ["a", "b"]);
        assert_eq!(f.recents.list().unwrap().items[0].last_opened_ms, 3);
    }

    #[test]
    fn keeps_fifteen_files_and_projects_together() {
        let f = fixture();
        for i in 0..20u64 {
            let path = file(&f, &format!("f{i}.draftcanvas"));
            f.recents
                .add(RecentKind::File, &path, &format!("f{i}"), i)
                .unwrap();
        }
        let folder = f.root.join("proj");
        fs::create_dir(&folder).unwrap();
        f.recents
            .add(RecentKind::Project, &folder, "proj", 100)
            .unwrap();
        let items = f.recents.list().unwrap().items;
        assert_eq!(items.len(), 15);
        assert_eq!(items[0].kind, RecentKind::Project);
        assert_eq!(items[1].name, "f19");
        assert_eq!(items[14].name, "f6");
    }

    #[test]
    fn entries_for_missing_files_and_wrong_kinds_are_pruned_and_the_file_rewritten() {
        let f = fixture();
        let keep = file(&f, "keep.draftcanvas");
        let gone = file(&f, "gone.draftcanvas");
        let folder = f.root.join("folder");
        let other = f.root.join("other");
        fs::create_dir(&folder).unwrap();
        fs::create_dir(&other).unwrap();
        f.recents.add(RecentKind::File, &keep, "keep", 1).unwrap();
        f.recents.add(RecentKind::File, &gone, "gone", 2).unwrap();
        f.recents
            .add(RecentKind::Project, &folder, "folder", 3)
            .unwrap();
        f.recents
            .add(RecentKind::File, &other, "folder-as-file", 4)
            .unwrap();
        fs::remove_file(&gone).unwrap();

        let listing = f.recents.list().unwrap();
        assert!(listing.pruned);
        assert_eq!(
            listing
                .items
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            ["folder", "keep"]
        );
        let on_disk: RecentsFile =
            serde_json::from_slice(&fs::read(f.root.join("config/recents.json")).unwrap()).unwrap();
        assert_eq!(on_disk.items.len(), 2);
        assert!(!f.recents.list().unwrap().pruned);
    }

    #[test]
    fn a_corrupt_file_is_set_aside_and_replaced_by_an_empty_list() {
        let f = fixture();
        fs::create_dir_all(f.root.join("config")).unwrap();
        fs::write(f.root.join("config/recents.json"), "{ not json").unwrap();
        assert!(f.recents.list().unwrap().items.is_empty());
        assert_eq!(
            fs::read_to_string(f.root.join("config/recents.json.bad")).unwrap(),
            "{ not json"
        );
        assert!(!f.root.join("config/recents.json").exists());

        let a = file(&f, "a.draftcanvas");
        f.recents.add(RecentKind::File, &a, "a", 1).unwrap();
        assert_eq!(paths(&f), ["a"]);
    }

    #[test]
    fn an_unknown_version_or_shape_is_treated_as_corrupt() {
        let f = fixture();
        fs::create_dir_all(f.root.join("config")).unwrap();
        fs::write(f.root.join("config/recents.json"), r#"{"v":2,"items":[]}"#).unwrap();
        assert!(f.recents.list().unwrap().items.is_empty());
        assert!(f.root.join("config/recents.json.bad").exists());
        fs::write(
            f.root.join("config/recents.json"),
            r#"{"v":1,"items":[{"kind":"file"}]}"#,
        )
        .unwrap();
        assert!(f.recents.list().unwrap().items.is_empty());
    }

    #[test]
    fn rename_rewrites_a_matching_entry_in_place_without_losing_its_position() {
        let f = fixture();
        let (a, b) = (file(&f, "a.draftcanvas"), file(&f, "b.draftcanvas"));
        f.recents.add(RecentKind::File, &a, "a", 1).unwrap();
        f.recents.add(RecentKind::File, &b, "b", 2).unwrap();
        assert_eq!(paths(&f), ["b", "a"]);
        let renamed = f.root.join("renamed.draftcanvas");
        fs::rename(&a, &renamed).unwrap();
        f.recents.rename(&a, &renamed, "renamed").unwrap();
        // Still in the same (second) slot, not moved to the front.
        assert_eq!(paths(&f), ["b", "renamed"]);
        assert_eq!(
            f.recents.list().unwrap().items[1].path,
            renamed.to_str().unwrap()
        );
        // Renaming a path with no matching entry is a harmless no-op.
        f.recents
            .rename(&f.root.join("nope"), &f.root.join("also-nope"), "x")
            .unwrap();
        assert_eq!(paths(&f), ["b", "renamed"]);
    }

    #[test]
    fn remove_and_clear() {
        let f = fixture();
        let (a, b) = (file(&f, "a.draftcanvas"), file(&f, "b.draftcanvas"));
        f.recents.add(RecentKind::File, &a, "a", 1).unwrap();
        f.recents.add(RecentKind::File, &b, "b", 2).unwrap();
        f.recents.remove(&b).unwrap();
        assert_eq!(paths(&f), ["a"]);
        f.recents.remove(&b).unwrap();
        f.recents.clear().unwrap();
        assert!(paths(&f).is_empty());
    }

    #[test]
    fn the_file_format_is_the_documented_one() {
        let f = fixture();
        let a = file(&f, "a.draftcanvas");
        f.recents.add(RecentKind::File, &a, "a", 42).unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(f.root.join("config/recents.json")).unwrap()).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["items"][0]["kind"], "file");
        assert_eq!(json["items"][0]["lastOpenedMs"], 42);
        assert_eq!(json["items"][0]["path"], a.to_str().unwrap());
    }
}
