//! The repositories themselves: where they live, how they are created, imported and removed
//! (`History`), and the `VersionStore` operations on one of them (`Repo`).

use super::objects::{
    commit_bytes, diagram_blob_of, parse_commit, parse_tag, tag_bytes, tag_target, tree_bytes,
};
use super::pack::{scan_pack, PackLimits, PackWriter};
use super::{
    is_safe_id, limits, parse_oid, require_ref, Code, CommitRecord, HistoryError, LogQuery,
    MaintainOutcome, RefEntry, RefUpdate, RefUpdateResult, RepoUsage, Result, SnapshotHead,
    TagRecord, TagWrite,
};
use crate::docio::write_private;
use crate::errors::{Subject, Verb};
use crate::util::lock;
use gix::objs::Kind;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::refs::{FullName, Target};
use gix::ObjectId;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const META_FILE: &str = "draft-canvas/repo.json";
const JOURNAL_DIR: &str = "draft-canvas/journal";
const LOCK_FILE: &str = "draft-canvas/write.lock";
/// A staging repository (an import being checked) is `.staging-<id>.git`; the page names it
/// `.staging-<id>`, which no repository id can be.
const STAGING_PREFIX: &str = ".staging-";
const CREATING_PREFIX: &str = ".creating-";
const TRASH_PREFIX: &str = ".trash-";
/// Unreachable loose objects younger than this survive maintenance: a write may still name them.
pub const PRUNE_GRACE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Leftovers of an import, create or removal that never finished are swept after this long.
const LEFTOVER_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// The refs whose objects maintenance keeps.
const KEPT_PREFIXES: [&str; 4] = [
    "refs/heads",
    "refs/tags",
    "refs/remotes",
    "refs/draft-canvas",
];

fn io_err(verb: Verb) -> impl Fn(io::Error) -> HistoryError {
    move |e| HistoryError::io(&e, verb)
}

/// Every history on this device, under one folder of the app's local data.
pub struct History {
    root: PathBuf,
    /// Held while a repository folder appears or disappears (create, import, remove), so a name is
    /// checked and claimed in one step. The single-instance app is the only writer of this folder.
    dirs: Mutex<()>,
    pub(super) bindings_guard: Mutex<()>,
}

impl History {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            dirs: Mutex::new(()),
            bindings_guard: Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn ensure_root(&self) -> Result<()> {
        fs::create_dir_all(&self.root).map_err(io_err(Verb::Save))
    }

    /// The folder of a repository the page named. Only an id ever reaches the filesystem.
    fn repo_dir(&self, repo_id: &str) -> Result<PathBuf> {
        if !is_safe_id(repo_id) {
            return Err(HistoryError::invalid("Not a history id."));
        }
        Ok(self.root.join(format!("{repo_id}.git")))
    }

    fn staging_dir(&self, token: &str) -> Result<PathBuf> {
        match token.strip_prefix(STAGING_PREFIX) {
            Some(id) if is_safe_id(id) => Ok(self.root.join(format!("{token}.git"))),
            _ => Err(HistoryError::invalid("Not a history import.")),
        }
    }

    /// A repository by id, or a staging repository by `.staging-<id>`, for reading.
    pub fn open(&self, store: &str) -> Result<Repo> {
        if store.starts_with(STAGING_PREFIX) {
            Repo::open(self.staging_dir(store)?, true)
        } else {
            Repo::open(self.repo_dir(store)?, false)
        }
    }

    /// A repository by id, for writing. An import being checked is read-only until it is committed.
    pub fn open_writable(&self, repo_id: &str) -> Result<Repo> {
        Repo::open(self.repo_dir(repo_id)?, false)
    }

    /// The `repo.json` of every history, in id order. Unreadable ones and imports in progress are
    /// left out; leftovers of work that never finished are swept.
    pub fn list(&self) -> Result<Vec<Value>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(HistoryError::io(&e, Verb::Open)),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            if name.starts_with('.') {
                self.sweep_leftover(name, &entry.path());
                continue;
            }
            let Some(id) = name.strip_suffix(".git").filter(|id| is_safe_id(id)) else {
                continue;
            };
            if let Ok(meta) = read_meta(&entry.path()) {
                if meta_repo_id(&meta).as_deref() == Some(id) {
                    out.push((id.to_string(), meta));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out.into_iter().map(|(_, meta)| meta).collect())
    }

    fn sweep_leftover(&self, name: &str, path: &Path) {
        let leftover = [STAGING_PREFIX, CREATING_PREFIX, TRASH_PREFIX]
            .iter()
            .any(|prefix| name.starts_with(prefix));
        let old = fs::symlink_metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > LEFTOVER_AGE);
        if leftover && old {
            let _ = remove_tree(path);
        }
    }

    /// `git init --bare` with Draft Canvas's own folder, built aside and moved into place whole, so
    /// a repository either exists with its `repo.json` or not at all.
    pub fn create(&self, meta: &Value) -> Result<()> {
        let repo_id = check_meta(meta)?;
        let target = self.repo_dir(&repo_id)?;
        self.ensure_root()?;
        let _dirs = lock(&self.dirs);
        if fs::symlink_metadata(&target).is_ok() {
            return Err(HistoryError::conflict(
                "A history with this id already exists.",
            ));
        }
        let temp = self
            .root
            .join(format!("{CREATING_PREFIX}{}.git", random_id()));
        let built = init_bare(&temp, meta).and_then(|()| {
            fs::rename(&temp, &target).map_err(io_err(Verb::Save))?;
            sync_dir(&self.root);
            Ok(())
        });
        if built.is_err() {
            let _ = remove_tree(&temp);
        }
        built
    }

    /// Removes a history whole. It is moved aside first, so it vanishes in one step even if
    /// removing its files is interrupted; links inside it are removed, never followed.
    pub fn remove(&self, repo_id: &str) -> Result<()> {
        let dir = self.repo_dir(repo_id)?;
        let _dirs = lock(&self.dirs);
        remove_repo_dir(&self.root, &dir)
    }

    /// Exports every object `tips` reach as one pack.
    pub fn pack_reachable(&self, store: &str, tips: &[String]) -> Result<Vec<u8>> {
        let repo = self.open(store)?;
        repo.pack_reachable(tips)
    }

    /// Indexes an imported pack into a new staging repository nothing is bound to, and returns its
    /// name (`.staging-<id>`). The page reads it with the ordinary read commands to check every
    /// revision, then commits or aborts it.
    pub fn import_begin(&self, meta: &Value, pack: &[u8]) -> Result<String> {
        let repo_id = check_meta(meta)?;
        if fs::symlink_metadata(self.repo_dir(&repo_id)?).is_ok() {
            return Err(HistoryError::conflict(
                "A history with this id already exists.",
            ));
        }
        if pack.len() > limits::MAX_BUNDLE_BYTES {
            return Err(HistoryError::too_large(
                "That history file is larger than Draft Canvas imports.",
            ));
        }
        scan_pack(pack, PackLimits::history())?;
        self.ensure_root()?;
        let token = format!("{STAGING_PREFIX}{}", random_id());
        let dir = self.staging_dir(&token)?;
        let built = init_bare(&dir, meta).and_then(|()| index_pack(&dir, pack));
        match built {
            Ok(()) => Ok(token),
            Err(e) => {
                let _ = remove_tree(&dir);
                Err(e)
            }
        }
    }

    /// Gives a checked import its refs and moves it into place as `<repoId>.git`.
    pub fn import_commit(&self, token: &str, refs: &[RefEntry]) -> Result<String> {
        let dir = self.staging_dir(token)?;
        if refs.len() > limits::MAX_BUNDLE_REFS {
            return Err(HistoryError::too_large(
                "That history file names too many branches.",
            ));
        }
        let repo = Repo::open(dir.clone(), true)?;
        let repo_id = meta_repo_id(&repo.meta()?)
            .filter(|id| is_safe_id(id))
            .ok_or_else(|| HistoryError::corrupt("That import has no usable history id."))?;
        let mut names = HashSet::new();
        let mut edits = Vec::with_capacity(refs.len());
        for entry in refs {
            require_ref(&entry.name)?;
            if !names.insert(entry.name.as_str()) {
                return Err(HistoryError::invalid("A branch is named twice."));
            }
            let oid = parse_oid(&entry.oid)?;
            if !repo.repo.has_object(oid) {
                return Err(HistoryError::not_found(
                    "A branch names a revision the file doesn't hold.",
                ));
            }
            edits.push(RefEdit {
                change: Change::Update {
                    log: no_log(),
                    expected: PreviousValue::MustNotExist,
                    new: Target::Object(oid),
                },
                name: full_name(&entry.name)?,
                deref: false,
            });
        }
        {
            let _writer = repo.write_lock()?;
            repo.repo
                .edit_references_as(edits, None)
                .map_err(|_| HistoryError::conflict("That import already has branches."))?;
        }
        drop(repo);
        let target = self.repo_dir(&repo_id)?;
        let _dirs = lock(&self.dirs);
        if fs::symlink_metadata(&target).is_ok() {
            return Err(HistoryError::conflict(
                "A history with this id already exists.",
            ));
        }
        fs::rename(&dir, &target).map_err(io_err(Verb::Save))?;
        sync_dir(&self.root);
        Ok(repo_id)
    }

    pub fn import_abort(&self, token: &str) -> Result<()> {
        let dir = self.staging_dir(token)?;
        let _dirs = lock(&self.dirs);
        match remove_repo_dir(&self.root, &dir) {
            Err(e) if e.code == Code::NotFound => Ok(()),
            other => other,
        }
    }
}

fn random_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The `repoId` a `repo.json` names, checked, and the rest of its shape as far as Rust cares.
fn check_meta(meta: &Value) -> Result<String> {
    let id =
        meta_repo_id(meta).ok_or_else(|| HistoryError::invalid("repo.json names no history."))?;
    if !is_safe_id(&id) {
        return Err(HistoryError::invalid("Not a history id."));
    }
    if serde_json::to_vec(meta).map_or(usize::MAX, |b| b.len()) > limits::MAX_JSON_BYTES {
        return Err(HistoryError::too_large(
            "repo.json is larger than history keeps.",
        ));
    }
    Ok(id)
}

fn meta_repo_id(meta: &Value) -> Option<String> {
    meta.as_object()?
        .get("repoId")?
        .as_str()
        .map(str::to_string)
}

fn read_json_file(path: &Path, cap: usize) -> Result<Value> {
    let file = File::open(path).map_err(io_err(Verb::Open))?;
    let mut bytes = Vec::new();
    file.take(cap as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_err(Verb::Open))?;
    if bytes.len() > cap {
        return Err(HistoryError::too_large(
            "A history file is larger than expected.",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| HistoryError::corrupt("A history file could not be read."))
}

fn read_meta(dir: &Path) -> Result<Value> {
    read_json_file(&dir.join(META_FILE), limits::MAX_JSON_BYTES)
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| HistoryError::invalid("Not JSON."))?;
    write_private(path, &bytes, Subject::History).map_err(|e| {
        HistoryError::new(
            match e.kind {
                crate::errors::ErrorKind::DiskFull => Code::Quota,
                _ => Code::Unavailable,
            },
            e.message,
        )
    })
}

/// A bare repository whose `HEAD` names `main`, plus `draft-canvas/` with `repo.json` and an empty journal.
fn init_bare(dir: &Path, meta: &Value) -> Result<()> {
    let options = gix::create::Options {
        destination_must_be_empty: Some(true),
        fs_capabilities: None,
        object_hash: Some(gix::hash::Kind::Sha1),
    };
    gix::create::into(dir, gix::create::Kind::Bare, options).map_err(HistoryError::git)?;
    fs::create_dir_all(dir.join(JOURNAL_DIR)).map_err(io_err(Verb::Save))?;
    write_json(&dir.join(META_FILE), meta)
}

/// Indexes `pack` into `dir`'s object store. gix hashes every object as it goes and checks the
/// trailer; a thin pack (one naming bases it doesn't hold) is refused.
fn index_pack(dir: &Path, pack: &[u8]) -> Result<()> {
    let pack_dir = dir.join("objects").join("pack");
    let options = gix_pack::bundle::write::Options {
        thread_limit: Some(1),
        iteration_mode: gix_pack::data::input::Mode::Verify,
        index_version: gix_pack::index::Version::default(),
        alloc_limit_bytes: Some(limits::MAX_BLOB_BYTES + 1024 * 1024),
        ..Default::default()
    };
    let mut reader = pack;
    let outcome = gix_pack::Bundle::write_to_directory(
        &mut reader,
        Some(&pack_dir),
        &mut gix::progress::Discard,
        &AtomicBool::new(false),
        None::<gix::objs::find::Never>,
        gix::hash::Kind::Sha1,
        options,
    )
    .map_err(|_| HistoryError::corrupt("That history file is damaged or incomplete."))?;
    // Nothing here repacks; the marker only matters to a `git gc` someone runs by hand.
    if let Some(keep) = outcome.keep_path {
        let _ = fs::remove_file(keep);
    }
    Ok(())
}

/// Removes a repository folder: moved aside, then deleted without following links.
fn remove_repo_dir(root: &Path, dir: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(dir).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => HistoryError::not_found("That history is not on this device."),
        _ => HistoryError::io(&e, Verb::Save),
    })?;
    if !meta.is_dir() {
        // A link where a repository should be: remove the link, never what it points at.
        return remove_entry(dir).map_err(io_err(Verb::Save));
    }
    let trash = root.join(format!("{TRASH_PREFIX}{}", random_id()));
    fs::rename(dir, &trash).map_err(io_err(Verb::Save))?;
    sync_dir(root);
    // Gone from every listing now; what is left is swept later if this is interrupted.
    remove_tree(&trash).map_err(io_err(Verb::Save))
}

/// `remove_dir_all` does not follow symbolic links or junctions; Git marks objects read-only,
/// which Windows refuses to delete until the flag is cleared.
fn remove_tree(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(first) => {
            clear_read_only(dir);
            fs::remove_dir_all(dir).map_err(|_| first)
        }
    }
}

fn clear_read_only(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            clear_read_only(&entry.path());
        } else if kind.is_file() {
            make_writable(&entry.path());
        }
    }
}

#[allow(clippy::permissions_set_readonly_false)] // Only ever on the app's own files, about to be deleted.
fn make_writable(path: &Path) {
    if let Ok(meta) = fs::symlink_metadata(path) {
        let mut permissions = meta.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn remove_entry(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(first) => {
            // A directory link on Windows is removed as a directory, without touching its target.
            fs::remove_dir(path).or_else(|_| {
                make_writable(path);
                fs::remove_file(path).map_err(|_| first)
            })
        }
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

/// Flushes a loose object or ref file Git wrote without flushing, so a ref never names an object a
/// crash could lose. Best effort: a packed object or ref has no file of its own here.
fn sync_file(path: &Path) {
    if let Ok(file) = OpenOptions::new().read(true).open(path) {
        let _ = file.sync_all();
    }
    if let Some(parent) = path.parent() {
        sync_dir(parent);
    }
}

fn full_name(name: &str) -> Result<FullName> {
    FullName::try_from(name)
        .map_err(|_| HistoryError::invalid("Not a ref Draft Canvas reads or writes."))
}

fn no_log() -> LogChange {
    LogChange {
        mode: RefLog::AndReference,
        force_create_reflog: false,
        message: Default::default(),
    }
}

/// Newest committer time first, ties by id ascending: the order every backend lists.
struct Newest(CommitRecord);

impl Ord for Newest {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0
            .committer
            .timestamp
            .cmp(&other.0.committer.timestamp)
            .then_with(|| other.0.oid.cmp(&self.0.oid))
    }
}

impl PartialOrd for Newest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Newest {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Newest {}

/// One open repository.
pub struct Repo {
    dir: PathBuf,
    repo: gix::Repository,
    staging: bool,
}

impl std::fmt::Debug for Repo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repo")
            .field("dir", &self.dir)
            .field("staging", &self.staging)
            .finish()
    }
}

impl Repo {
    fn open(dir: PathBuf, staging: bool) -> Result<Self> {
        let meta = fs::symlink_metadata(&dir).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => {
                HistoryError::not_found("That history is not on this device.")
            }
            _ => HistoryError::io(&e, Verb::Open),
        })?;
        if !meta.is_dir() || !dir.join(META_FILE).is_file() {
            return Err(HistoryError::not_found(
                "That history is not on this device.",
            ));
        }
        refuse_sha256(&dir)?;
        // Isolated: no system, global or user configuration, no environment, no includes. Nothing
        // the person configured for their own Git (hooks paths, filters, fsmonitor) applies here.
        let options = gix::open::Options::isolated()
            .strict_config(false)
            .open_path_as_is(true);
        let repo = gix::open_opts(&dir, options).map_err(|_| {
            HistoryError::corrupt("Draft Canvas couldn't open this diagram's history.")
        })?;
        if repo.object_hash() != gix::hash::Kind::Sha1 {
            return Err(sha256_refused());
        }
        Ok(Self { dir, repo, staging })
    }

    #[cfg(test)]
    pub(super) fn repo_for_tests(&self) -> &gix::Repository {
        &self.repo
    }

    fn require_writable(&self) -> Result<()> {
        if self.staging {
            return Err(HistoryError::invalid(
                "An import can't be changed before it is committed.",
            ));
        }
        Ok(())
    }

    /// The repository's writer lock, an OS lock on `draft-canvas/write.lock`, held around every
    /// read-compare-write. Never taken twice by one caller: the lock is not reentrant.
    fn write_lock(&self) -> Result<File> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dir.join(LOCK_FILE))
            .map_err(io_err(Verb::Save))?;
        file.lock().map_err(io_err(Verb::Save))?;
        Ok(file)
    }

    pub fn meta(&self) -> Result<Value> {
        read_meta(&self.dir)
    }

    /// Replaces `repo.json` atomically. It must keep naming this history.
    pub fn write_meta(&self, meta: &Value) -> Result<()> {
        self.require_writable()?;
        let id = check_meta(meta)?;
        let file_id = self
            .dir
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".git"));
        if file_id != Some(id.as_str()) {
            return Err(HistoryError::invalid("repo.json names another history."));
        }
        write_json(&self.dir.join(META_FILE), meta)
    }

    fn write_object(&self, kind: Kind, bytes: &[u8]) -> Result<ObjectId> {
        let id = gix::objs::Write::write_buf(&self.repo.objects, kind, bytes)
            .map_err(HistoryError::git)?;
        let hex = id.to_hex().to_string();
        sync_file(&self.dir.join("objects").join(&hex[..2]).join(&hex[2..]));
        Ok(id)
    }

    /// Blob, tree and commit. Content-addressed: the same snapshot twice writes nothing new.
    pub fn write_snapshot(&self, text: &[u8], head: &SnapshotHead) -> Result<String> {
        self.require_writable()?;
        if text.len() > limits::MAX_BLOB_BYTES {
            return Err(HistoryError::too_large(
                "This diagram is larger than history records.",
            ));
        }
        if std::str::from_utf8(text).is_err() {
            return Err(HistoryError::invalid("A diagram is text."));
        }
        if head.parents.len() > 64 {
            return Err(HistoryError::invalid("Too many parents."));
        }
        for parent in &head.parents {
            parse_oid(parent)
                .map_err(|_| HistoryError::invalid("A parent is not an object id."))?;
        }
        let message = head.message.as_str();
        // Checked before anything is written, so a refused commit leaves no orphan blob.
        commit_bytes(
            &ObjectId::null(gix::hash::Kind::Sha1).to_string(),
            &head.parents,
            &head.author,
            &head.committer,
            message,
        )?;
        let blob = self.write_object(Kind::Blob, text)?;
        let tree = self.write_object(Kind::Tree, &tree_bytes(&blob))?;
        let commit = commit_bytes(
            &tree.to_string(),
            &head.parents,
            &head.author,
            &head.committer,
            message,
        )?;
        Ok(self.write_object(Kind::Commit, &commit)?.to_string())
    }

    /// A ref's value, `None` when it does not exist. A symbolic ref is not one Draft Canvas reads.
    pub fn read_ref(&self, name: &str) -> Result<Option<String>> {
        require_ref(name)?;
        Ok(self.lookup_ref(name)?.map(|id| id.to_string()))
    }

    fn lookup_ref(&self, name: &str) -> Result<Option<ObjectId>> {
        let found =
            self.repo.refs.try_find(name).map_err(|_| {
                HistoryError::corrupt("A branch of this history could not be read.")
            })?;
        let Some(reference) = found else {
            return Ok(None);
        };
        // gix also tries `refs/tags/<name>`, `refs/heads/<name>`… for a short name: only the exact one counts.
        if reference.name.as_bstr() != name.as_bytes() {
            return Ok(None);
        }
        match reference.target {
            Target::Object(id) => Ok(Some(id)),
            Target::Symbolic(_) => Err(HistoryError::invalid(
                "Not a ref Draft Canvas reads or writes.",
            )),
        }
    }

    /// Compare-and-swap under the writer lock, and as a gix transaction whose expected previous
    /// value is checked again under Git's own ref lock, so a Git process outside the app can't slip in between.
    pub fn update_ref(&self, update: &RefUpdate) -> Result<RefUpdateResult> {
        self.require_writable()?;
        require_ref(&update.name)?;
        let expected = update.expected.as_deref().map(parse_oid).transpose()?;
        let next = update.next.as_deref().map(parse_oid).transpose()?;
        let name = full_name(&update.name)?;
        let _writer = self.write_lock()?;
        let actual = self.lookup_ref(&update.name)?;
        if actual != expected {
            return Ok(RefUpdateResult::missed(actual.map(|id| id.to_string())));
        }
        let previous = match actual {
            Some(id) => PreviousValue::MustExistAndMatch(Target::Object(id)),
            None => PreviousValue::MustNotExist,
        };
        let change = match next {
            None if actual.is_none() => return Ok(RefUpdateResult::applied()),
            None => Change::Delete {
                expected: previous,
                log: RefLog::AndReference,
            },
            Some(id) => {
                // The object must exist before a ref may name it.
                if !self.repo.has_object(id) {
                    return Err(HistoryError::not_found(
                        "That revision is not in this history.",
                    ));
                }
                Change::Update {
                    log: no_log(),
                    expected: previous,
                    new: Target::Object(id),
                }
            }
        };
        let edit = RefEdit {
            change,
            name,
            deref: false,
        };
        if self.repo.edit_references_as([edit], None).is_err() {
            // Someone outside the app moved it under Git's lock, or the disk refused.
            let now = self.lookup_ref(&update.name)?;
            if now != expected {
                return Ok(RefUpdateResult::missed(now.map(|id| id.to_string())));
            }
            return Err(HistoryError::new(
                Code::Unavailable,
                "Draft Canvas couldn't save this diagram's history.",
            ));
        }
        if next.is_some() {
            sync_file(&self.dir.join(&update.name));
        }
        Ok(RefUpdateResult::applied())
    }

    /// Every direct ref under `prefix`, by name.
    pub fn list_refs(&self, prefix: &str) -> Result<Vec<RefEntry>> {
        let base = prefix.trim_end_matches('/');
        require_ref(&format!("{base}/x"))
            .map_err(|_| HistoryError::invalid("Not a ref prefix Draft Canvas reads."))?;
        let wanted = format!("{base}/");
        let platform = self.repo.references().map_err(|_| {
            HistoryError::corrupt("The branches of this history could not be read.")
        })?;
        let iter = platform.prefixed(wanted.as_str()).map_err(|_| {
            HistoryError::corrupt("The branches of this history could not be read.")
        })?;
        let mut out = Vec::new();
        for reference in iter {
            let Ok(reference) = reference else { continue };
            let Ok(name) = std::str::from_utf8(reference.name().as_bstr()) else {
                continue;
            };
            if !name.starts_with(&wanted) || !super::is_safe_ref_name(name) {
                continue;
            }
            if let Some(id) = reference.target().try_id() {
                out.push(RefEntry {
                    name: name.to_string(),
                    oid: id.to_string(),
                });
            }
            if out.len() > limits::MAX_BUNDLE_REFS * 10 {
                return Err(HistoryError::too_large(
                    "This history has too many branches.",
                ));
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// An object's kind and bytes, refusing anything larger than `cap` before it is inflated.
    fn read_object(&self, id: ObjectId, cap: usize) -> Result<(Kind, Vec<u8>)> {
        let not_found = || HistoryError::not_found("That revision is not in this history.");
        let header = self
            .repo
            .try_find_header(id)
            .map_err(|_| HistoryError::corrupt("That revision could not be read."))?
            .ok_or_else(not_found)?;
        if header.size() > cap as u64 {
            return Err(HistoryError::too_large(
                "That revision is larger than history reads.",
            ));
        }
        let object = self
            .repo
            .try_find_object(id)
            .map_err(|_| HistoryError::corrupt("That revision could not be read."))?
            .ok_or_else(not_found)?;
        Ok((object.kind, object.detach().data))
    }

    pub fn read_commit(&self, oid: &str) -> Result<CommitRecord> {
        let id = parse_oid(oid)?;
        let (kind, data) = self.read_object(id, limits::MAX_COMMIT_BYTES)?;
        if kind != Kind::Commit {
            return Err(HistoryError::corrupt("That revision could not be read."));
        }
        parse_commit(oid, &data)
    }

    pub fn read_commits(&self, oids: &[String]) -> Result<Vec<CommitRecord>> {
        if oids.len() > limits::MAX_BATCH {
            return Err(HistoryError::too_large(
                "Too many revisions asked for at once.",
            ));
        }
        oids.iter().map(|oid| self.read_commit(oid)).collect()
    }

    /// The diagram text of a commit, after checking its tree is exactly `{ diagram.draftcanvas }`.
    pub fn read_snapshot(&self, oid: &str) -> Result<Vec<u8>> {
        let commit = self.read_commit(oid)?;
        let tree = parse_oid(&commit.tree)
            .map_err(|_| HistoryError::corrupt("That revision could not be read."))?;
        let not_a_diagram = || HistoryError::corrupt("That revision does not hold a diagram.");
        let (kind, data) = match self.read_object(tree, 1024) {
            Err(e) if e.code == Code::TooLarge => return Err(not_a_diagram()),
            other => other?,
        };
        if kind != Kind::Tree {
            return Err(not_a_diagram());
        }
        let blob = diagram_blob_of(&data).ok_or_else(not_a_diagram)?;
        let (kind, bytes) = self.read_object(blob, limits::MAX_BLOB_BYTES)?;
        if kind != Kind::Blob {
            return Err(not_a_diagram());
        }
        if std::str::from_utf8(&bytes).is_err() {
            return Err(HistoryError::corrupt("That revision is not text."));
        }
        Ok(bytes)
    }

    /// Commits reachable from `from` and not from `hide`, newest committer time first, ties by id.
    pub fn log(&self, query: &LogQuery) -> Result<Vec<CommitRecord>> {
        let limit = query.limit.clamp(0, limits::MAX_LOG_PAGE as i64) as usize;
        if query.from.len() > limits::MAX_BATCH
            || query
                .hide
                .as_ref()
                .is_some_and(|h| h.len() > limits::MAX_BATCH)
        {
            return Err(HistoryError::too_large(
                "Too many revisions asked for at once.",
            ));
        }
        let mut hidden: HashSet<String> = HashSet::new();
        let mut stack: Vec<String> = query.hide.clone().unwrap_or_default();
        while let Some(oid) = stack.pop() {
            if hidden.len() >= limits::MAX_WALK {
                break;
            }
            if !hidden.insert(oid.clone()) {
                continue;
            }
            match self.read_commit(&oid) {
                Ok(commit) => stack.extend(commit.parents),
                Err(e) if e.code == Code::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        let mut queue = BinaryHeap::new();
        let mut seen: HashSet<String> = HashSet::new();
        let push =
            |oid: &str, queue: &mut BinaryHeap<Newest>, seen: &mut HashSet<String>| -> Result<()> {
                if seen.contains(oid) || hidden.contains(oid) {
                    return Ok(());
                }
                seen.insert(oid.to_string());
                queue.push(Newest(self.read_commit(oid)?));
                Ok(())
            };
        for oid in &query.from {
            push(oid, &mut queue, &mut seen)?;
        }
        let mut out = Vec::new();
        while out.len() < limit {
            let Some(Newest(next)) = queue.pop() else {
                break;
            };
            for parent in &next.parents {
                push(parent, &mut queue, &mut seen)?;
            }
            out.push(next);
            if seen.len() > limits::MAX_WALK {
                break;
            }
        }
        Ok(out)
    }

    /// Git's merge bases (all of them: a criss-cross history has more than one), by id.
    pub fn merge_bases(&self, a: &str, b: &str) -> Result<Vec<String>> {
        let one = parse_oid(a)?;
        let two = parse_oid(b)?;
        for id in [one, two] {
            self.read_commit(&id.to_string())?;
        }
        let bases = self.repo.merge_bases_many(one, &[two]).map_err(|_| {
            HistoryError::corrupt("This history's revisions could not be compared.")
        })?;
        let mut out: Vec<String> = bases.into_iter().map(|id| id.to_string()).collect();
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// Whether `ancestor` is `descendant` or reachable from it, walking at most `MAX_WALK` commits.
    pub fn is_ancestor(&self, ancestor: &str, descendant: &str) -> Result<bool> {
        parse_oid(ancestor)?;
        parse_oid(descendant)?;
        if ancestor == descendant {
            return Ok(true);
        }
        let mut seen: HashSet<String> = HashSet::new();
        let mut queue = std::collections::VecDeque::from([descendant.to_string()]);
        while let Some(oid) = queue.pop_front() {
            for parent in self.read_commit(&oid)?.parents {
                if parent == ancestor {
                    return Ok(true);
                }
                if seen.insert(parent.clone()) {
                    queue.push_back(parent);
                }
            }
            if seen.len() > limits::MAX_WALK {
                return Err(HistoryError::too_large(
                    "This history is too long to compare.",
                ));
            }
        }
        Ok(false)
    }

    /// An annotated tag on a commit, then its ref, created only if it does not exist yet.
    pub fn write_tag(&self, tag: &TagWrite) -> Result<String> {
        self.require_writable()?;
        require_ref(&tag.name_ref)?;
        if tag.name_ref != format!("refs/tags/{}", tag.name) {
            return Err(HistoryError::invalid("Not a tag Draft Canvas writes."));
        }
        let target = parse_oid(&tag.target)?;
        self.read_commit(&target.to_string())?;
        let bytes = tag_bytes(&tag.target, &tag.name, &tag.tagger, &tag.message)?;
        let oid = self.write_object(Kind::Tag, &bytes)?.to_string();
        let result = self.update_ref(&RefUpdate {
            name: tag.name_ref.clone(),
            expected: None,
            next: Some(oid.clone()),
        })?;
        if !result.ok {
            return Err(HistoryError::conflict("That milestone already exists."));
        }
        Ok(oid)
    }

    /// Annotated tags on commits under `prefix`; lightweight or unreadable tags are not milestones.
    pub fn list_tags(&self, prefix: &str) -> Result<Vec<TagRecord>> {
        let mut out = Vec::new();
        for entry in self.list_refs(prefix)? {
            let Ok(id) = parse_oid(&entry.oid) else {
                continue;
            };
            let Ok((Kind::Tag, data)) = self.read_object(id, limits::MAX_COMMIT_BYTES) else {
                continue;
            };
            let Some(tag) = parse_tag(&data) else {
                continue;
            };
            let Some(tagger) = tag.tagger else { continue };
            if tag.kind != "commit" {
                continue;
            }
            out.push(TagRecord {
                oid: entry.oid,
                name: entry.name,
                target: tag.object,
                message: tag.message,
                tagger,
            });
        }
        Ok(out)
    }

    fn journal_path(&self, op_id: &str) -> Result<PathBuf> {
        if !is_safe_id(op_id) {
            return Err(HistoryError::invalid("Not an operation id."));
        }
        Ok(self.dir.join(JOURNAL_DIR).join(format!("{op_id}.json")))
    }

    pub fn journal_put(&self, record: &Value) -> Result<()> {
        self.require_writable()?;
        let fields = record
            .as_object()
            .ok_or_else(|| HistoryError::invalid("Not a journal entry."))?;
        let op_id = fields
            .get("opId")
            .and_then(Value::as_str)
            .ok_or_else(|| HistoryError::invalid("Not an operation id."))?;
        let shaped = fields.get("kind").is_some_and(Value::is_string)
            && fields.get("step").is_some_and(Value::is_string)
            && fields.get("at").is_some_and(Value::is_number)
            && fields.get("data").is_some_and(Value::is_object);
        if !shaped {
            return Err(HistoryError::invalid("Not a journal entry."));
        }
        if serde_json::to_vec(record).map_or(usize::MAX, |b| b.len()) > limits::MAX_JSON_BYTES {
            return Err(HistoryError::too_large(
                "That journal entry is larger than history keeps.",
            ));
        }
        let path = self.journal_path(op_id)?;
        fs::create_dir_all(self.dir.join(JOURNAL_DIR)).map_err(io_err(Verb::Save))?;
        write_json(&path, record)
    }

    /// Every readable entry, by operation id. An unreadable one stays on disk for a person to look
    /// at; it never blocks the others.
    pub fn journal_list(&self) -> Result<Vec<Value>> {
        let dir = self.dir.join(JOURNAL_DIR);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(HistoryError::io(&e, Verb::Open)),
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| name.strip_suffix(".json").is_some_and(is_safe_id))
            .collect();
        names.sort();
        Ok(names
            .iter()
            .filter_map(|name| read_json_file(&dir.join(name), limits::MAX_JSON_BYTES).ok())
            .collect())
    }

    pub fn journal_delete(&self, op_id: &str) -> Result<()> {
        self.require_writable()?;
        let path = self.journal_path(op_id)?;
        match fs::remove_file(&path) {
            Ok(()) => {
                sync_dir(&self.dir.join(JOURNAL_DIR));
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(HistoryError::io(&e, Verb::Save)),
        }
    }

    /// Bytes on disk, and objects: loose ones plus every pack's count.
    pub fn usage(&self) -> Result<RepoUsage> {
        let mut usage = RepoUsage {
            bytes: 0,
            objects: 0,
        };
        add_usage(&self.dir, &mut usage, 0);
        usage.objects += self.loose_objects()?.len() as u64;
        if let Ok(entries) = fs::read_dir(self.dir.join("objects").join("pack")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("pack") {
                    usage.objects += pack_object_count(&path).unwrap_or(0);
                }
            }
        }
        Ok(usage)
    }

    /// Every loose object file: id, path and when it was written.
    fn loose_objects(&self) -> Result<Vec<(ObjectId, PathBuf, SystemTime)>> {
        let root = self.dir.join("objects");
        let mut out = Vec::new();
        let dirs = fs::read_dir(&root).map_err(io_err(Verb::Open))?;
        for dir in dirs.flatten() {
            let Some(fan) = dir.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if fan.len() != 2
                || !fan
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            {
                continue;
            }
            if !dir.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(files) = fs::read_dir(dir.path()) else {
                continue;
            };
            for file in files.flatten() {
                let Some(rest) = file.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                let hex = format!("{fan}{rest}");
                let Ok(id) = parse_oid(&hex) else { continue };
                let Ok(meta) = fs::symlink_metadata(file.path()) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                out.push((
                    id,
                    file.path(),
                    meta.modified().unwrap_or(SystemTime::now()),
                ));
            }
        }
        Ok(out)
    }

    /// Removes loose objects no ref reaches that are older than `PRUNE_GRACE`. Nothing is repacked:
    /// packs are left as they are (an imported pack is already compact, and a snapshot's objects
    /// are small), so an unreachable object inside a pack stays until someone runs `git gc`.
    /// Refused, doing nothing, while a journal entry is open: an operation in flight may hold
    /// objects no ref names yet.
    pub fn maintain(&self, now: SystemTime) -> Result<MaintainOutcome> {
        self.require_writable()?;
        let _writer = self.write_lock()?;
        if !self.journal_list()?.is_empty() {
            return Ok(MaintainOutcome {
                skipped: Some("journal".into()),
                pruned: 0,
            });
        }
        let loose = self.loose_objects()?;
        let old: Vec<_> = loose
            .into_iter()
            .filter(|(_, _, written)| {
                now.duration_since(*written)
                    .is_ok_and(|age| age > PRUNE_GRACE)
            })
            .collect();
        if old.is_empty() {
            return Ok(MaintainOutcome {
                skipped: None,
                pruned: 0,
            });
        }
        let reachable = self.reachable()?;
        let mut pruned = 0;
        for (id, path, _) in old {
            if reachable.contains(&id) {
                continue;
            }
            if remove_entry(&path).is_ok() {
                pruned += 1;
            }
        }
        Ok(MaintainOutcome {
            skipped: None,
            pruned,
        })
    }

    /// Every object any kept ref reaches: commits, their trees and blobs, and tags. A ref naming a
    /// missing object stops maintenance rather than prune around a hole.
    fn reachable(&self) -> Result<HashSet<ObjectId>> {
        let mut stack = Vec::new();
        for prefix in KEPT_PREFIXES {
            for entry in self.list_refs(prefix)? {
                stack.push(parse_oid(&entry.oid)?);
            }
        }
        self.walk(stack, limits::MAX_WALK * 4, |_, _, _| Ok(()))
    }

    /// Visits every object reachable from `tips` once, with its kind and bytes.
    fn walk(
        &self,
        mut stack: Vec<ObjectId>,
        cap: usize,
        mut visit: impl FnMut(ObjectId, Kind, &[u8]) -> Result<()>,
    ) -> Result<HashSet<ObjectId>> {
        let mut seen = HashSet::new();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            if seen.len() > cap {
                return Err(HistoryError::too_large(
                    "This history is too large to work with here.",
                ));
            }
            let (kind, data) = self.read_object(id, limits::MAX_BLOB_BYTES)?;
            match kind {
                Kind::Commit => {
                    let commit = parse_commit(&id.to_string(), &data)?;
                    stack.push(parse_oid(&commit.tree)?);
                    for parent in &commit.parents {
                        stack.push(parse_oid(parent)?);
                    }
                }
                Kind::Tree => {
                    for entry in gix::objs::TreeRefIter::from_bytes(&data, gix::hash::Kind::Sha1) {
                        let entry = entry.map_err(|_| {
                            HistoryError::corrupt("A revision's files could not be read.")
                        })?;
                        // A submodule's commit lives in another repository.
                        if !entry.mode.is_commit() {
                            stack.push(entry.oid.to_owned());
                        }
                    }
                }
                Kind::Tag => {
                    let target = tag_target(&data)
                        .ok_or_else(|| HistoryError::corrupt("A milestone could not be read."))?;
                    stack.push(target);
                }
                Kind::Blob => {}
            }
            visit(id, kind, &data)?;
        }
        Ok(seen)
    }

    /// Every object `tips` reach, as one pack of whole objects in id order.
    pub fn pack_reachable(&self, tips: &[String]) -> Result<Vec<u8>> {
        if tips.len() > limits::MAX_BUNDLE_REFS {
            return Err(HistoryError::too_large(
                "Too many branches asked for at once.",
            ));
        }
        let tips = tips
            .iter()
            .map(|t| parse_oid(t))
            .collect::<Result<Vec<_>>>()?;
        let mut total = 0usize;
        let seen = self.walk(tips, limits::MAX_BUNDLE_OBJECTS, |_, _, data| {
            total += data.len();
            if total > limits::MAX_TOTAL_INFLATED as usize {
                return Err(HistoryError::too_large(
                    "This history is too large to export.",
                ));
            }
            Ok(())
        })?;
        let mut ids: Vec<ObjectId> = seen.into_iter().collect();
        ids.sort();
        let count = u32::try_from(ids.len())
            .map_err(|_| HistoryError::too_large("This history is too large to export."))?;
        let mut writer = PackWriter::new(count, limits::MAX_BUNDLE_BYTES);
        for id in ids {
            let (kind, data) = self.read_object(id, limits::MAX_BLOB_BYTES)?;
            writer.add(kind, &data)?;
        }
        writer.finish()
    }
}

/// gix built for SHA-1 only can't open a SHA-256 repository at all; say why rather than "corrupt".
fn refuse_sha256(dir: &Path) -> Result<()> {
    let Ok(config) = fs::read_to_string(dir.join("config")) else {
        return Ok(());
    };
    let lower = config.to_ascii_lowercase();
    if lower.contains("objectformat") && lower.contains("sha256") {
        return Err(sha256_refused());
    }
    Ok(())
}

fn sha256_refused() -> HistoryError {
    HistoryError::new(
        Code::UnsupportedFormat,
        "This history uses SHA-256 object ids, which Draft Canvas doesn't read yet.",
    )
}

fn add_usage(dir: &Path, usage: &mut RepoUsage, depth: u32) {
    if depth > 16 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir() {
            add_usage(&entry.path(), usage, depth + 1);
        } else if meta.is_file() {
            usage.bytes += meta.len();
        }
    }
}

fn pack_object_count(path: &Path) -> io::Result<u64> {
    let mut header = [0u8; 12];
    File::open(path)?.read_exact(&mut header)?;
    if &header[..4] != b"PACK" {
        return Ok(0);
    }
    Ok(u64::from(u32::from_be_bytes([
        header[8], header[9], header[10], header[11],
    ])))
}
