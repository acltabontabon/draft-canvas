//! Temporary explorer capabilities. Browsing mints opaque handles, never project grants: only an
//! explicit Add commits a folder. Directory reads and canonicalisation happen outside registry locks.

use crate::errors::{AppError, Subject, Verb};
use crate::grants::{validate_file, validate_folder, Handle};
use crate::paths::{display_path, file_name, has_doc_ext};
use crate::util::lock;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

const MAX_SESSIONS: usize = 4;
const MAX_HANDLES: usize = 20_000;
const MAX_DIRECTORY_ITEMS: usize = 10_000;
const PAGE_SIZE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
pub enum ExplorerKind {
    Folder,
    File,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerLocation {
    pub handle: Handle,
    pub name: String,
    pub display_path: String,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerPlace {
    pub location: ExplorerLocation,
    pub project: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerEntry {
    pub handle: Handle,
    pub name: String,
    pub kind: ExplorerKind,
    pub display_path: String,
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    #[ts(type = "number")]
    pub modified_ms: u64,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerDirectory {
    pub location: ExplorerLocation,
    pub breadcrumbs: Vec<ExplorerLocation>,
    pub entries: Vec<ExplorerEntry>,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerStart {
    pub session: String,
    pub places: Vec<ExplorerPlace>,
    pub directory: ExplorerDirectory,
}

#[derive(Clone)]
struct Node {
    path: PathBuf,
    kind: ExplorerKind,
}

#[derive(Default)]
pub struct Session {
    nodes: HashMap<Handle, Node>,
    paths: HashMap<PathBuf, Handle>,
}

impl Session {
    fn mint(&mut self, path: PathBuf, kind: ExplorerKind) -> Result<Handle, AppError> {
        if let Some(handle) = self.paths.get(&path) {
            return Ok(handle.clone());
        }
        if self.nodes.len() >= MAX_HANDLES {
            return Err(AppError::invalid_path(
                "Reopen the explorer to continue browsing.",
            ));
        }
        let handle = format!("b_{}", uuid::Uuid::new_v4());
        self.paths.insert(path.clone(), handle.clone());
        self.nodes.insert(handle.clone(), Node { path, kind });
        Ok(handle)
    }

    pub fn path(&self, handle: &str, kind: ExplorerKind) -> Result<PathBuf, AppError> {
        self.nodes
            .get(handle)
            .filter(|node| node.kind == kind)
            .map(|node| node.path.clone())
            .ok_or_else(AppError::invalid_handle)
    }

    fn location(&mut self, path: &Path) -> Result<ExplorerLocation, AppError> {
        Ok(ExplorerLocation {
            handle: self.mint(path.to_path_buf(), ExplorerKind::Folder)?,
            name: file_name(path),
            display_path: display_path(path),
        })
    }
}

#[derive(Default)]
pub struct Explorer {
    sessions: VecDeque<(String, Arc<Mutex<Session>>)>,
}

impl Explorer {
    pub fn start(&mut self) -> (String, Arc<Mutex<Session>>) {
        while self.sessions.len() >= MAX_SESSIONS {
            self.sessions.pop_front();
        }
        let id = format!("x_{}", uuid::Uuid::new_v4());
        let session = Arc::new(Mutex::new(Session::default()));
        self.sessions.push_back((id.clone(), session.clone()));
        (id, session)
    }

    pub fn session(&self, id: &str) -> Result<Arc<Mutex<Session>>, AppError> {
        self.sessions
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, session)| session.clone())
            .ok_or_else(AppError::invalid_handle)
    }

    pub fn close(&mut self, id: &str) {
        self.sessions.retain(|(key, _)| key != id);
    }
}

/// Check again on every action: a file or folder may have been replaced after it was listed.
pub fn checked_path(
    session: &Mutex<Session>,
    handle: &str,
    kind: ExplorerKind,
) -> Result<PathBuf, AppError> {
    let path = lock(session).path(handle, kind)?;
    let current = match kind {
        ExplorerKind::Folder => validate_folder(&path)?,
        ExplorerKind::File => validate_file(&path)?,
    };
    if current != path {
        return Err(AppError::invalid_path(
            "That item changed location. Refresh the folder and try again.",
        ));
    }
    Ok(path)
}

/// A new folder is one named child of a folder capability, never a path supplied by the page.
pub fn create_folder(
    session: &Mutex<Session>,
    parent: &str,
    name: &str,
) -> Result<ExplorerLocation, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::invalid_path("Type a name for the folder."));
    }
    if name == "."
        || name == ".."
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err(AppError::invalid_path(
            "Use a folder name without slashes or special characters.",
        ));
    }
    if name.len() > 255 || name.chars().count() > 120 {
        return Err(AppError::invalid_path(
            "That folder name is too long. Use up to 120 characters.",
        ));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(AppError::invalid_path(
            "That name is reserved by the system. Choose another folder name.",
        ));
    }
    let root = checked_path(session, parent, ExplorerKind::Folder)?;
    let child = root.join(name);
    // create_dir is exclusive: existing files, folders and symlinks are never reused or replaced.
    fs::create_dir(&child).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::new(
                crate::errors::ErrorKind::AlreadyExists,
                "An item with that name already exists. Choose another folder name.",
            )
        } else {
            AppError::from_io(&error, Verb::Save, Subject::Path(&child))
        }
    })?;
    let canonical = validate_folder(&child)?;
    lock(session).location(&canonical)
}

pub fn place(
    session: &Mutex<Session>,
    path: &Path,
    name: &str,
    project: bool,
) -> Option<ExplorerPlace> {
    let canonical = validate_folder(path).ok()?;
    let mut location = lock(session).location(&canonical).ok()?;
    location.name = name.to_string();
    Some(ExplorerPlace { location, project })
}

struct Listed {
    path: PathBuf,
    name: String,
    kind: ExplorerKind,
    size: Option<u64>,
    modified_ms: u64,
}

/// One bounded, non-recursive directory listing. No document is read and no watcher is started.
pub fn directory(
    session: &Mutex<Session>,
    handle: &str,
    show_hidden: bool,
    query: &str,
    offset: usize,
) -> Result<ExplorerDirectory, AppError> {
    let root = checked_path(session, handle, ExplorerKind::Folder)?;
    let read = fs::read_dir(&root)
        .map_err(|error| AppError::from_io(&error, Verb::Open, Subject::Path(&root)))?;
    let needle = query.trim().to_lowercase();
    let mut listed = Vec::new();
    let mut truncated = false;
    for (index, item) in read.enumerate() {
        if index >= MAX_DIRECTORY_ITEMS {
            truncated = true;
            break;
        }
        let Ok(item) = item else {
            continue;
        };
        let name = item.file_name().to_string_lossy().into_owned();
        if (!show_hidden && name.starts_with('.'))
            || (!needle.is_empty() && !name.to_lowercase().contains(&needle))
        {
            continue;
        }
        let Ok(kind) = item.file_type() else {
            continue;
        };
        if !kind.is_dir() && !kind.is_symlink() && !has_doc_ext(&item.path()) {
            continue;
        }
        let Ok(path) = dunce::canonicalize(item.path()) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let kind = if meta.is_dir() {
            ExplorerKind::Folder
        } else if meta.is_file() && has_doc_ext(&path) {
            ExplorerKind::File
        } else {
            continue;
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as u64)
            .unwrap_or(0);
        listed.push(Listed {
            path,
            name,
            kind,
            size: (kind == ExplorerKind::File).then_some(meta.len()),
            modified_ms,
        });
    }
    listed.sort_by_cached_key(|entry| {
        (
            entry.kind != ExplorerKind::Folder,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    let total = listed.len();
    let offset = offset.min(total);
    let next_offset = (offset.saturating_add(PAGE_SIZE) < total).then_some(offset + PAGE_SIZE);
    let mut session = lock(session);
    let location = session.location(&root)?;
    let mut breadcrumbs = Vec::new();
    for ancestor in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
        breadcrumbs.push(session.location(ancestor)?);
    }
    let entries = listed
        .into_iter()
        .skip(offset)
        .take(PAGE_SIZE)
        .map(|entry| {
            Ok(ExplorerEntry {
                handle: session.mint(entry.path.clone(), entry.kind)?,
                name: entry.name,
                kind: entry.kind,
                display_path: display_path(&entry.path),
                size: entry.size,
                modified_ms: entry.modified_ms,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(ExplorerDirectory {
        location,
        breadcrumbs,
        entries,
        total,
        next_offset,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorKind;
    use tempfile::tempdir;

    fn setup(root: &Path) -> (Mutex<Session>, String) {
        let session = Mutex::new(Session::default());
        let handle = place(&session, root, "Test", false)
            .unwrap()
            .location
            .handle;
        (session, handle)
    }

    #[test]
    fn lists_only_folders_and_diagrams_and_never_reads_document_bodies() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("Folder")).unwrap();
        fs::write(
            dir.path().join("flow.draftcanvas"),
            "not parsed during a listing",
        )
        .unwrap();
        fs::write(dir.path().join("secret.txt"), "private").unwrap();
        fs::create_dir(dir.path().join(".hidden")).unwrap();
        let (session, handle) = setup(dir.path());
        let page = directory(&session, &handle, false, "", 0).unwrap();
        assert_eq!(
            page.entries
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Folder", "flow.draftcanvas"]
        );
        assert_eq!(directory(&session, &handle, true, "", 0).unwrap().total, 3);
        assert_eq!(
            directory(&session, &handle, false, "FLOW", 0)
                .unwrap()
                .total,
            1
        );
        assert!(lock(&session)
            .path(&page.entries[1].handle, ExplorerKind::Folder)
            .is_err());
    }

    #[test]
    fn creates_one_folder_and_returns_a_browsable_handle_without_reusing_existing_items() {
        let dir = tempdir().unwrap();
        let (session, parent) = setup(dir.path());
        let created = create_folder(&session, &parent, "  Project ideas  ").unwrap();
        assert_eq!(created.name, "Project ideas");
        assert!(dir.path().join("Project ideas").is_dir());
        assert_eq!(
            directory(&session, &created.handle, false, "", 0)
                .unwrap()
                .total,
            0
        );
        assert_eq!(
            create_folder(&session, &parent, "Project ideas")
                .unwrap_err()
                .kind,
            ErrorKind::AlreadyExists
        );
        fs::write(dir.path().join("notes"), "keep me").unwrap();
        assert_eq!(
            create_folder(&session, &parent, "notes").unwrap_err().kind,
            ErrorKind::AlreadyExists
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("notes")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn rejects_paths_invalid_names_and_unknown_parent_handles_before_creating_anything() {
        let dir = tempdir().unwrap();
        let (session, parent) = setup(dir.path());
        for name in [
            "",
            "  ",
            ".",
            "..",
            "../escaped",
            "nested/child",
            "/absolute",
            "C:\\folder",
            "bad\\name",
            "bad\nname",
            "bad?name",
            "end.",
            "NUL",
            "con.txt",
            "COM1",
            "LPT9",
        ] {
            assert_eq!(
                create_folder(&session, &parent, name).unwrap_err().kind,
                ErrorKind::InvalidPath,
                "{name:?}"
            );
        }
        assert!(create_folder(&session, &parent, &"a".repeat(121)).is_err());
        assert_eq!(
            create_folder(&session, "invented", "Ideas")
                .unwrap_err()
                .kind,
            ErrorKind::InvalidHandle
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn paginates_sorted_results_and_handles_a_deleted_folder() {
        let dir = tempdir().unwrap();
        let child = dir.path().join("child");
        fs::create_dir(&child).unwrap();
        for index in 0..205 {
            fs::create_dir(child.join(format!("Folder {index:03}"))).unwrap();
        }
        let (session, handle) = setup(&child);
        let first = directory(&session, &handle, false, "", 0).unwrap();
        assert_eq!(first.entries.len(), PAGE_SIZE);
        assert_eq!(first.next_offset, Some(PAGE_SIZE));
        let last = directory(&session, &handle, false, "", PAGE_SIZE).unwrap();
        assert_eq!(last.entries.len(), 5);
        assert_eq!(last.entries[0].name, "Folder 200");
        assert_eq!(
            directory(&session, &handle, false, "", usize::MAX)
                .unwrap()
                .entries
                .len(),
            0
        );
        fs::remove_dir_all(child).unwrap();
        assert_eq!(
            directory(&session, &handle, false, "", 0).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn rejects_invented_handles_and_closed_sessions_and_bounds_session_count() {
        let mut explorer = Explorer::default();
        let (first, _) = explorer.start();
        for _ in 0..MAX_SESSIONS {
            explorer.start();
        }
        assert!(explorer.session(&first).is_err());
        let (id, session) = explorer.start();
        assert!(checked_path(&session, "../../private", ExplorerKind::Folder).is_err());
        explorer.close(&id);
        assert!(explorer.session(&id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_substituted_for_a_previously_listed_file() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("flow.draftcanvas");
        fs::write(&file, "{}").unwrap();
        let (session, handle) = setup(dir.path());
        let page = directory(&session, &handle, false, "", 0).unwrap();
        let token = &page.entries[0].handle;
        fs::remove_file(&file).unwrap();
        let other = dir.path().join("other.draftcanvas");
        fs::write(&other, "{}").unwrap();
        std::os::unix::fs::symlink(other, file).unwrap();
        assert!(checked_path(&session, token, ExplorerKind::File).is_err());
    }
}
