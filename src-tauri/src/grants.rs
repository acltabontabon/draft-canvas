//! The only way the page ever names a file: an opaque handle Rust minted for a path the user picked
//! (dialog), the OS opened, or Rust itself wrote down. A path the page invents can't be read or
//! written, because there is no command that accepts one.

use crate::docio::MAX_DOC_BYTES;
use crate::errors::{AppError, Subject, Verb};
use crate::paths::{doc_stem, file_name, has_doc_ext};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub type Handle = String;

#[derive(Debug, Clone)]
pub struct FileGrant {
    /// Canonical, so two routes to the same file get the same handle.
    pub path: PathBuf,
    /// The document's title: its file name without `.draftcanvas`.
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct ProjectGrant {
    pub root: PathBuf,
    pub name: String,
}

/// Held behind a `Mutex` in app state. Everything here is in-memory bookkeeping; the filesystem checks
/// that produce a canonical path (`validate_file`, `validate_folder`) run before the lock is taken so a
/// slow drive can't stall unrelated commands.
#[derive(Default)]
pub struct Grants {
    files: HashMap<Handle, FileGrant>,
    projects: HashMap<Handle, ProjectGrant>,
}

fn new_handle() -> Handle {
    format!("h_{}", uuid::Uuid::new_v4())
}

impl Grants {
    /// Granting the same canonical path twice returns the same handle: recovery decides which open
    /// document a snapshot belongs to by comparing handles.
    pub fn insert_file(&mut self, canonical: PathBuf) -> Handle {
        if let Some((handle, _)) = self.files.iter().find(|(_, g)| g.path == canonical) {
            return handle.clone();
        }
        let handle = new_handle();
        let name = doc_stem(&canonical);
        self.files.insert(
            handle.clone(),
            FileGrant {
                path: canonical,
                name,
            },
        );
        handle
    }

    pub fn insert_project(&mut self, canonical: PathBuf) -> Handle {
        if let Some((handle, _)) = self.projects.iter().find(|(_, g)| g.root == canonical) {
            return handle.clone();
        }
        let handle = new_handle();
        let name = file_name(&canonical);
        self.projects.insert(
            handle.clone(),
            ProjectGrant {
                root: canonical,
                name,
            },
        );
        handle
    }

    pub fn file(&self, handle: &str) -> Result<FileGrant, AppError> {
        self.files
            .get(handle)
            .cloned()
            .ok_or_else(AppError::invalid_handle)
    }

    pub fn project(&self, handle: &str) -> Result<ProjectGrant, AppError> {
        self.projects
            .get(handle)
            .cloned()
            .ok_or_else(AppError::invalid_handle)
    }
}

/// A file that may be handed to the page: it exists, is a regular file, is a `.draftcanvas`, and is
/// small enough to open. Returns the canonical path.
pub fn validate_file(path: &Path) -> Result<PathBuf, AppError> {
    let canonical = dunce::canonicalize(path)
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(path)))?;
    if !has_doc_ext(&canonical) {
        return Err(AppError::not_a_document(path));
    }
    let meta = fs::metadata(&canonical)
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(path)))?;
    if !meta.is_file() {
        return Err(AppError::not_a_document(path));
    }
    if meta.len() > MAX_DOC_BYTES {
        return Err(AppError::too_large(path, Verb::Open, MAX_DOC_BYTES));
    }
    Ok(canonical)
}

pub fn validate_folder(path: &Path) -> Result<PathBuf, AppError> {
    let canonical = dunce::canonicalize(path)
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(path)))?;
    if !canonical.is_dir() {
        return Err(AppError::invalid_path(format!(
            "{} isn't a folder.",
            file_name(path)
        )));
    }
    Ok(canonical)
}

/// `rel` (from a project scan, `/`-separated) joined onto the project root, refused unless it is a
/// plain relative path to a `.draftcanvas` whose real location, symlinks resolved, is still inside
/// the root. `root` must be canonical.
pub fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let outside =
        || AppError::invalid_path("That file isn't inside the project folder that is open.");
    if rel.is_empty() || rel.contains('\0') {
        return Err(outside());
    }
    let rel_path = Path::new(rel);
    let plain = !rel_path.is_absolute()
        && rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    if !plain || !has_doc_ext(rel_path) {
        return Err(outside());
    }
    let canonical = dunce::canonicalize(root.join(rel_path))
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(rel_path)))?;
    if !canonical.starts_with(root) {
        return Err(outside());
    }
    Ok(canonical)
}

/// `rel` (a folder inside a project, `/`-separated, possibly empty for the project root) joined onto
/// `root` and checked the same way `resolve_in_root` checks a file: a plain relative path whose real
/// location, symlinks resolved, is still inside the root, and which names a folder rather than a file.
/// Unlike `resolve_in_root`, an empty `rel` is accepted (the root itself) and no `.draftcanvas` extension
/// is required, since this resolves a *destination folder*, not a document to open.
pub fn resolve_folder_in_root(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let outside = || AppError::invalid_path("That folder isn't inside the project that is open.");
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    if rel.contains('\0') {
        return Err(outside());
    }
    let rel_path = Path::new(rel);
    let plain = !rel_path.is_absolute()
        && rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return Err(outside());
    }
    let canonical = dunce::canonicalize(root.join(rel_path))
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(rel_path)))?;
    if !canonical.starts_with(root) || !canonical.is_dir() {
        return Err(outside());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorKind;
    use std::fs::File;
    use tempfile::tempdir;

    fn canonical(dir: &tempfile::TempDir) -> PathBuf {
        dunce::canonicalize(dir.path()).unwrap()
    }

    #[test]
    fn handles_are_opaque_and_stable_for_the_same_file() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        let a = root.join("a.draftcanvas");
        let b = root.join("b.draftcanvas");
        let mut grants = Grants::default();
        let ha = grants.insert_file(a.clone());
        assert!(ha.starts_with("h_"));
        assert_eq!(grants.insert_file(a.clone()), ha);
        assert_ne!(grants.insert_file(b), ha);
        assert_eq!(grants.file(&ha).unwrap().name, "a");
        assert_eq!(grants.file(&ha).unwrap().path, a);
    }

    #[test]
    fn files_and_projects_do_not_share_a_namespace() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        let mut grants = Grants::default();
        let project = grants.insert_project(root.clone());
        assert_eq!(grants.project(&project).unwrap().root, root);
        assert_eq!(
            grants.file(&project).err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
        let file = grants.insert_file(root.join("a.draftcanvas"));
        assert_eq!(
            grants.project(&file).err().unwrap().kind,
            ErrorKind::InvalidHandle
        );
        assert_eq!(grants.insert_project(root), project);
    }

    #[test]
    fn a_handle_that_was_never_issued_is_invalid() {
        let grants = Grants::default();
        for handle in ["", "h_nope", "/etc/passwd", "../../x"] {
            assert_eq!(
                grants.file(handle).err().unwrap().kind,
                ErrorKind::InvalidHandle
            );
            assert_eq!(
                grants.project(handle).err().unwrap().kind,
                ErrorKind::InvalidHandle
            );
        }
    }

    #[test]
    fn a_file_to_grant_must_exist_be_a_document_and_be_small() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);

        let ok = root.join("Ok.DRAFTCANVAS");
        fs::write(&ok, "{}").unwrap();
        assert_eq!(validate_file(&ok).unwrap(), ok);

        assert_eq!(
            validate_file(&root.join("missing.draftcanvas"))
                .err()
                .unwrap()
                .kind,
            ErrorKind::NotFound
        );

        let text = root.join("notes.txt");
        fs::write(&text, "x").unwrap();
        assert_eq!(
            validate_file(&text).err().unwrap().kind,
            ErrorKind::NotADocument
        );

        let folder = root.join("folder.draftcanvas");
        fs::create_dir(&folder).unwrap();
        assert_eq!(
            validate_file(&folder).err().unwrap().kind,
            ErrorKind::NotADocument
        );

        let big = root.join("big.draftcanvas");
        File::create(&big)
            .unwrap()
            .set_len(MAX_DOC_BYTES + 1)
            .unwrap();
        assert_eq!(validate_file(&big).err().unwrap().kind, ErrorKind::TooLarge);
    }

    #[test]
    fn a_folder_to_grant_must_be_a_folder() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        assert_eq!(validate_folder(&root).unwrap(), root);
        let file = root.join("f.draftcanvas");
        fs::write(&file, "").unwrap();
        assert_eq!(
            validate_folder(&file).err().unwrap().kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            validate_folder(&root.join("nope")).err().unwrap().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn project_paths_resolve_inside_the_root() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        fs::create_dir_all(root.join("sub/deeper")).unwrap();
        fs::write(root.join("a.draftcanvas"), "").unwrap();
        fs::write(root.join("sub/deeper/b.DraftCanvas"), "").unwrap();
        assert_eq!(
            resolve_in_root(&root, "a.draftcanvas").unwrap(),
            root.join("a.draftcanvas")
        );
        assert_eq!(
            resolve_in_root(&root, "sub/deeper/b.DraftCanvas").unwrap(),
            root.join("sub/deeper/b.DraftCanvas")
        );
        assert_eq!(
            resolve_in_root(&root, "sub/nope.draftcanvas")
                .err()
                .unwrap()
                .kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn traversal_absolute_and_odd_paths_are_refused() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.draftcanvas"), "").unwrap();
        fs::write(root.join("a.draftcanvas"), "").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        let absolute = outside.path().join("secret.draftcanvas");
        let cases = [
            "",
            "..",
            "../secret.draftcanvas",
            "sub/../a.draftcanvas",
            "./a.draftcanvas",
            "sub/./../a.draftcanvas",
            "/etc/passwd.draftcanvas",
            absolute.to_str().unwrap(),
            "a.draftcanvas\0",
            "a.txt",
            "a.draftcanvas.txt",
            "sub",
            "noextension",
        ];
        for rel in cases {
            let err = resolve_in_root(&root, rel)
                .err()
                .unwrap_or_else(|| panic!("accepted {rel:?}"));
            assert!(
                matches!(err.kind, ErrorKind::InvalidPath | ErrorKind::NotFound),
                "{rel:?} -> {err:?}"
            );
        }
        assert_eq!(
            resolve_in_root(&root, "../secret.draftcanvas")
                .err()
                .unwrap()
                .kind,
            ErrorKind::InvalidPath
        );
    }

    #[test]
    fn resolve_folder_in_root_accepts_the_root_itself_for_an_empty_rel_path() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        assert_eq!(resolve_folder_in_root(&root, "").unwrap(), root);
    }

    #[test]
    fn resolve_folder_in_root_accepts_a_nested_folder_and_refuses_a_file() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/f.draftcanvas"), "").unwrap();
        assert_eq!(
            resolve_folder_in_root(&root, "a/b").unwrap(),
            root.join("a/b")
        );
        assert!(resolve_folder_in_root(&root, "a/f.draftcanvas").is_err());
        assert!(resolve_folder_in_root(&root, "nope").is_err());
        assert!(resolve_folder_in_root(&root, "../escape").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_folder_in_root_refuses_a_folder_that_escapes_the_root_via_symlink() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        assert!(resolve_folder_in_root(&root, "linked").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_leaves_the_project_is_refused() {
        let dir = tempdir().unwrap();
        let root = canonical(&dir);
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.draftcanvas"), "").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.draftcanvas"),
            root.join("escape.draftcanvas"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("linked")).unwrap();
        fs::write(root.join("real.draftcanvas"), "").unwrap();
        std::os::unix::fs::symlink(
            root.join("real.draftcanvas"),
            root.join("inside.draftcanvas"),
        )
        .unwrap();

        assert_eq!(
            resolve_in_root(&root, "escape.draftcanvas")
                .err()
                .unwrap()
                .kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            resolve_in_root(&root, "linked/secret.draftcanvas")
                .err()
                .unwrap()
                .kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            resolve_in_root(&root, "inside.draftcanvas").unwrap(),
            root.join("real.draftcanvas")
        );
    }
}
