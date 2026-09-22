//! Reading and writing `.draftcanvas` files. Pure functions over paths and bytes, no Tauri types, so
//! everything that can lose a person's work is tested without a window.

use crate::errors::{AppError, Subject, Verb};
use crate::paths::file_name;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_DOC_BYTES: u64 = 24 * 1024 * 1024;
pub const MAX_SIDECAR_BYTES: u64 = 16 * 1024 * 1024;

/// A background image lives next to its document as `<file>.draftcanvas.background.<ext>`, the same
/// convention the VS Code extension uses, so a folder opens identically in either.
const SIDECAR_TYPES: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
];

// --- stamps ------------------------------------------------------------------------------------

/// Identifies "the file as I last read or wrote it": `v1:<mtime_ns>:<size>:<sha256 of the content>`.
/// The page treats it as opaque and hands it back with the next save.
struct Stamp {
    mtime_ns: u128,
    size: u64,
    hash: String,
}

impl Stamp {
    fn of(meta: &fs::Metadata, bytes: &[u8]) -> Self {
        Self {
            mtime_ns: mtime_ns(meta),
            size: bytes.len() as u64,
            hash: sha256_hex(bytes),
        }
    }

    fn encode(&self) -> String {
        format!("v1:{}:{}:{}", self.mtime_ns, self.size, self.hash)
    }

    fn parse(text: &str) -> Option<Self> {
        let mut parts = text.split(':');
        if parts.next()? != "v1" {
            return None;
        }
        let mtime_ns = parts.next()?.parse().ok()?;
        let size = parts.next()?.parse().ok()?;
        let hash = parts.next()?;
        if parts.next().is_some()
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        Some(Self {
            mtime_ns,
            size,
            hash: hash.to_ascii_lowercase(),
        })
    }
}

fn mtime_ns(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Whether the file on disk is still the one `expected` describes. Modification time and size are
/// compared first; when they differ the content is hashed and only the hash decides, so a cloud-sync
/// client touching the mtime is not mistaken for someone else's edit.
pub fn stamp_matches(path: &Path, expected: &str) -> io::Result<bool> {
    let Some(expected) = Stamp::parse(expected) else {
        return Ok(false);
    };
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if !meta.is_file() {
        return Ok(false);
    }
    if mtime_ns(&meta) == expected.mtime_ns && meta.len() == expected.size {
        return Ok(true);
    }
    if meta.len() > MAX_DOC_BYTES {
        return Ok(false);
    }
    Ok(sha256_hex(&fs::read(path)?) == expected.hash)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StampCheck {
    Unchanged,
    Changed,
    Missing,
}

/// The cheap check made whenever the window regains focus: no hashing, only mtime and size. A file
/// that can't be compared (unreadable stamp, unreadable file) counts as changed so the page looks again.
pub fn check_stamp(path: &Path, expected: &str) -> StampCheck {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return StampCheck::Missing,
        Err(_) => return StampCheck::Changed,
    };
    match Stamp::parse(expected) {
        Some(s) if mtime_ns(&meta) == s.mtime_ns && meta.len() == s.size => StampCheck::Unchanged,
        _ => StampCheck::Changed,
    }
}

// --- reading -----------------------------------------------------------------------------------

pub struct ReadDoc {
    pub text: String,
    pub stamp: String,
}

pub fn read_document(path: &Path) -> Result<ReadDoc, AppError> {
    let io_err = |e: io::Error| AppError::from_io(&e, Verb::Open, Subject::Path(path));
    let file = File::open(path).map_err(io_err)?;
    let len = file.metadata().map_err(io_err)?.len();
    if len > MAX_DOC_BYTES {
        return Err(AppError::too_large(path, Verb::Open, MAX_DOC_BYTES));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    // Bounded again on the way in: the file may have grown since the size check.
    (&file)
        .take(MAX_DOC_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_err)?;
    if bytes.len() as u64 > MAX_DOC_BYTES {
        return Err(AppError::too_large(path, Verb::Open, MAX_DOC_BYTES));
    }
    // Taken after the read so the stamp's mtime belongs to the bytes just read.
    let meta = file.metadata().map_err(io_err)?;
    let text = String::from_utf8(bytes).map_err(|_| AppError::not_a_document(path))?;
    let stamp = Stamp::of(&meta, text.as_bytes()).encode();
    Ok(ReadDoc { text, stamp })
}

// --- writing -----------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteOutcome {
    Saved {
        stamp: String,
    },
    /// The file changed (or vanished) since the stamp was taken; nothing was written.
    Conflict,
}

/// Saves `bytes` over `target` without ever leaving a half-written file: a temp file beside the target
/// is written and flushed, then swapped in with a single rename. Whatever goes wrong, the previous
/// contents are still the file's contents. There is deliberately no fallback to a plain overwrite.
/// The bytes are written exactly as given.
pub fn write_atomic(
    target: &Path,
    bytes: &[u8],
    expected_stamp: Option<&str>,
) -> Result<WriteOutcome, AppError> {
    let io_err = |e: io::Error| AppError::from_io(&e, Verb::Save, Subject::Path(target));
    if let Some(expected) = expected_stamp {
        if !stamp_matches(target, expected).map_err(io_err)? {
            return Ok(WriteOutcome::Conflict);
        }
    }
    // A symlinked document is written through: the link stays a link and the real file is replaced.
    let real = resolve_through_symlink(target).map_err(io_err)?;
    if let Some(block) = write_block(&real) {
        return Err(match block {
            WriteBlock::ReadOnly => AppError::read_only(target),
            WriteBlock::Denied(e) => io_err(e),
        });
    }
    replace_contents(&real, bytes, Kind::User, true).map_err(io_err)?;
    let stamp = stamp_after_write(&real, bytes).map_err(io_err)?;
    Ok(WriteOutcome::Saved { stamp })
}

/// Writes `bytes` over `target` (or creates it) with no conflict check, for a file the person just
/// chose in a save dialog that already asked about replacing it. Returns the new stamp.
pub fn write_unconditional(target: &Path, bytes: &[u8]) -> Result<String, AppError> {
    match write_atomic(target, bytes, None)? {
        WriteOutcome::Saved { stamp } => Ok(stamp),
        // Only a stamp can produce a conflict, and none was given.
        WriteOutcome::Conflict => Err(AppError::internal()),
    }
}

/// A document that couldn't be opened again shouldn't be saved: the same cap as reading.
pub fn ensure_document_size(len: usize) -> Result<(), AppError> {
    if len as u64 > MAX_DOC_BYTES {
        return Err(AppError::new(
            crate::errors::ErrorKind::TooLarge,
            format!(
                "This canvas is too large for Draft Canvas to save (the limit is {} MB).",
                MAX_DOC_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(())
}

/// Creates a document that must not exist yet (the Untitled canvas in a project folder).
pub fn create_new_atomic(target: &Path, bytes: &[u8]) -> Result<String, AppError> {
    let io_err = |e: io::Error| AppError::from_io(&e, Verb::Save, Subject::Path(target));
    if fs::symlink_metadata(target).is_ok() {
        return Err(AppError::already_exists(target));
    }
    replace_contents(target, bytes, Kind::User, false).map_err(io_err)?;
    stamp_after_write(target, bytes).map_err(io_err)
}

/// Writes one of the app's own files (settings, recents, recovery copies): same atomic swap, but
/// private to the account, and `subject` words a failure without exposing an internal file name.
pub fn write_private(target: &Path, bytes: &[u8], subject: Subject<'_>) -> Result<(), AppError> {
    replace_contents(target, bytes, Kind::Private, true)
        .map_err(|e| AppError::from_io(&e, Verb::Save, subject))
}

/// Whether the person may not save over this file. Feeds `OpenedDoc.readOnly` as well as the save path.
pub fn is_read_only(path: &Path) -> bool {
    write_block(path).is_some()
}

enum WriteBlock {
    ReadOnly,
    Denied(io::Error),
}

/// Replacing a file needs write access to its *folder*, not to the file, so a plain atomic save would
/// happily overwrite a read-only file. The file's own writability is checked first.
fn write_block(path: &Path) -> Option<WriteBlock> {
    let meta = fs::metadata(path).ok()?;
    if meta.permissions().readonly() {
        return Some(WriteBlock::ReadOnly);
    }
    denied_to_this_account(path).map(WriteBlock::Denied)
}

/// A file owned by someone else can look writable (mode 0644) yet be closed to this account; the only
/// honest test is to ask the OS to open it for writing.
#[cfg(unix)]
fn denied_to_this_account(path: &Path) -> Option<io::Error> {
    OpenOptions::new()
        .write(true)
        .open(path)
        .err()
        .filter(|e| e.kind() == io::ErrorKind::PermissionDenied)
}

/// On Windows the read-only attribute is the whole story; opening for write would also fail whenever
/// another program merely has the file open.
#[cfg(windows)]
fn denied_to_this_account(_path: &Path) -> Option<io::Error> {
    None
}

fn resolve_through_symlink(target: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => dunce::canonicalize(target),
        Ok(_) => Ok(target.to_path_buf()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(target.to_path_buf()),
        Err(e) => Err(e),
    }
}

fn stamp_after_write(path: &Path, bytes: &[u8]) -> io::Result<String> {
    Ok(Stamp::of(&fs::metadata(path)?, bytes).encode())
}

#[derive(Clone, Copy)]
enum Kind {
    /// A file the person owns: takes the permissions of the file it replaces, or the default ones.
    User,
    /// One of the app's own files: readable by the account only.
    Private,
}

fn replace_contents(target: &Path, bytes: &[u8], kind: Kind, clobber: bool) -> io::Result<()> {
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let existing = fs::metadata(target).ok();
    let temp = temp_path(dir, target);
    let result = write_temp(&temp, bytes, kind, existing.as_ref())
        .and_then(|()| install(&temp, target, existing.is_some(), clobber));
    match &result {
        Ok(()) => sync_dir(dir),
        Err(_) => {
            let _ = fs::remove_file(&temp);
        }
    }
    result
}

/// Same folder as the target (a rename across volumes isn't atomic). The name is capped so a long
/// document name can't push the temp name past the filesystem's limit.
fn temp_path(dir: &Path, target: &Path) -> PathBuf {
    let name: String = file_name(target).chars().take(60).collect();
    let rand = uuid::Uuid::new_v4().simple().to_string();
    dir.join(format!(
        ".{name}.dctmp-{}-{}",
        std::process::id(),
        &rand[..8]
    ))
}

fn write_temp(
    temp: &Path,
    bytes: &[u8],
    kind: Kind,
    existing: Option<&fs::Metadata>,
) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    restrict_to_owner(&mut options, kind);
    let mut file = options.open(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    // Closed before the swap: Windows can't rename a file that is still open.
    drop(file);
    if let (Kind::User, Some(meta)) = (kind, existing) {
        fs::set_permissions(temp, meta.permissions())?;
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_to_owner(options: &mut OpenOptions, kind: Kind) {
    use std::os::unix::fs::OpenOptionsExt;
    if matches!(kind, Kind::Private) {
        options.mode(0o600);
    }
}

/// Windows files inherit their folder's ACL; there is no mode to set.
#[cfg(windows)]
fn restrict_to_owner(_options: &mut OpenOptions, _kind: Kind) {}

#[cfg(unix)]
fn install(temp: &Path, target: &Path, _existing: bool, _clobber: bool) -> io::Result<()> {
    fs::rename(temp, target)
}

/// Sync clients and antivirus briefly hold files open; a sharing violation is retried a few times
/// before it is reported, instead of failing a save the person can't do anything about.
#[cfg(windows)]
fn install(temp: &Path, target: &Path, existing: bool, clobber: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    const ATTEMPTS: u32 = 5;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;

    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (temp_w, target_w) = (wide(temp), wide(target));
    let mut attempt = 1;
    loop {
        // SAFETY: both buffers are NUL-terminated and outlive the call; the optional pointers are null.
        let ok = unsafe {
            if existing {
                ReplaceFileW(
                    target_w.as_ptr(),
                    temp_w.as_ptr(),
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            } else {
                let flags = MOVEFILE_WRITE_THROUGH
                    | if clobber {
                        MOVEFILE_REPLACE_EXISTING
                    } else {
                        0
                    };
                MoveFileExW(temp_w.as_ptr(), target_w.as_ptr(), flags)
            }
        };
        if ok != 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        let busy = matches!(
            err.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
        );
        if !busy || attempt == ATTEMPTS {
            return Err(err);
        }
        attempt += 1;
        std::thread::sleep(RETRY_DELAY);
    }
}

/// Makes the rename itself durable. Best effort: some filesystems refuse to open a directory.
#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(windows)]
fn sync_dir(_dir: &Path) {}

/// `Untitled canvas.draftcanvas`, then `Untitled canvas 2.draftcanvas`, and so on. `ext` includes its dot.
pub fn unique_name(dir: &Path, base: &str, ext: &str) -> String {
    let taken = |name: &str| fs::symlink_metadata(dir.join(name)).is_ok();
    let first = format!("{base}{ext}");
    if !taken(&first) {
        return first;
    }
    (2u32..)
        .map(|n| format!("{base} {n}{ext}"))
        .find(|name| !taken(name))
        .expect("an unbounded counter always finds a free name")
}

// --- background image sidecars -----------------------------------------------------------------

pub struct Sidecar {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

fn sidecar_path(doc: &Path, ext: &str) -> PathBuf {
    let mut name = doc.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".background.{ext}"));
    doc.with_file_name(name)
}

/// The first background image that exists next to `doc`, whatever its type.
pub fn sidecar_read(doc: &Path) -> Result<Option<Sidecar>, AppError> {
    for (mime, ext) in SIDECAR_TYPES {
        let path = sidecar_path(doc, ext);
        let io_err = |e: io::Error| AppError::from_io(&e, Verb::Open, Subject::Path(&path));
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_err(e)),
        };
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_SIDECAR_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(io_err)?;
        if bytes.len() as u64 > MAX_SIDECAR_BYTES {
            return Err(AppError::too_large(&path, Verb::Open, MAX_SIDECAR_BYTES));
        }
        return Ok(Some(Sidecar { mime, bytes }));
    }
    Ok(None)
}

pub fn sidecar_write(doc: &Path, mime: &str, bytes: &[u8]) -> Result<(), AppError> {
    let Some((_, ext)) = SIDECAR_TYPES.iter().find(|(m, _)| *m == mime) else {
        return Err(AppError::new(
            crate::errors::ErrorKind::NotADocument,
            "That image type isn't supported. Use a PNG, JPEG, WebP or GIF.",
        ));
    };
    let path = sidecar_path(doc, ext);
    if bytes.len() as u64 > MAX_SIDECAR_BYTES {
        return Err(AppError::too_large(&path, Verb::Save, MAX_SIDECAR_BYTES));
    }
    write_unconditional(&path, bytes)?;
    // A stale `.png` beside a fresh `.jpg` would win on the next read, so the others must go.
    for (_, other) in SIDECAR_TYPES.iter().filter(|(_, e)| e != ext) {
        remove_if_present(&sidecar_path(doc, other))?;
    }
    Ok(())
}

pub fn sidecar_remove(doc: &Path) -> Result<(), AppError> {
    for (_, ext) in SIDECAR_TYPES {
        remove_if_present(&sidecar_path(doc, ext))?;
    }
    Ok(())
}

/// Save As keeps the background: the image (if any) is copied beside the new document.
pub fn sidecar_copy(from: &Path, to: &Path) -> Result<(), AppError> {
    match sidecar_read(from)? {
        Some(s) => sidecar_write(to, s.mime, &s.bytes),
        None => sidecar_remove(to),
    }
}

fn remove_if_present(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::from_io(&e, Verb::Save, Subject::Path(path))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorKind;
    use std::time::{Duration, SystemTime};
    use tempfile::tempdir;

    fn touch(path: &Path, later_by: Duration) {
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() + later_by).unwrap();
    }

    fn temp_leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".dctmp-"))
            .collect()
    }

    #[test]
    fn reads_text_with_a_versioned_stamp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "{\"v\":1}").unwrap();
        let doc = read_document(&path).unwrap();
        assert_eq!(doc.text, "{\"v\":1}");
        let parts: Vec<&str> = doc.stamp.split(':').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "v1");
        assert_eq!(parts[2], "7");
        assert_eq!(parts[3].len(), 64);
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let dir = tempdir().unwrap();
        let err = read_document(&dir.path().join("gone.draftcanvas"))
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::NotFound);
        assert!(err.message.contains("gone.draftcanvas"));
    }

    #[test]
    fn an_oversized_file_is_refused_without_reading_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.draftcanvas");
        File::create(&path)
            .unwrap()
            .set_len(MAX_DOC_BYTES + 1)
            .unwrap();
        let err = read_document(&path).err().unwrap();
        assert_eq!(err.kind, ErrorKind::TooLarge);
        assert!(err.message.contains("24 MB"));
    }

    #[test]
    fn a_file_at_the_limit_is_accepted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("edge.draftcanvas");
        fs::write(&path, vec![b'a'; MAX_DOC_BYTES as usize]).unwrap();
        assert_eq!(
            read_document(&path).unwrap().text.len() as u64,
            MAX_DOC_BYTES
        );
    }

    #[test]
    fn invalid_utf8_is_not_a_document() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("bin.draftcanvas");
        fs::write(&path, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        let err = read_document(&path).err().unwrap();
        assert_eq!(err.kind, ErrorKind::NotADocument);
    }

    #[test]
    fn atomic_write_replaces_the_file_and_returns_the_stamp_a_read_would() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "old").unwrap();
        let stamp = read_document(&path).unwrap().stamp;
        let WriteOutcome::Saved { stamp: new_stamp } =
            write_atomic(&path, b"new contents", Some(&stamp)).unwrap()
        else {
            panic!("expected a save");
        };
        assert_eq!(fs::read_to_string(&path).unwrap(), "new contents");
        assert_eq!(new_stamp, read_document(&path).unwrap().stamp);
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn bytes_are_written_exactly_as_given() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        let bytes = "line one\r\nline two \u{2014} caf\u{e9}\n\n  {\"k\":1}  ".as_bytes();
        write_atomic(&path, bytes, None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn a_new_file_can_be_written_without_a_stamp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("fresh.draftcanvas");
        assert!(matches!(
            write_atomic(&path, b"x", None).unwrap(),
            WriteOutcome::Saved { .. }
        ));
        assert_eq!(fs::read(&path).unwrap(), b"x");
    }

    #[test]
    fn leftover_temp_files_from_a_crash_do_not_get_in_the_way() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        let stale = dir.path().join(".a.draftcanvas.dctmp-1-deadbeef");
        fs::write(&stale, "half a document").unwrap();
        write_atomic(&path, b"whole", None).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"whole");
        assert!(
            stale.exists(),
            "another process's temp file is not ours to delete"
        );
    }

    #[test]
    fn a_failed_swap_removes_its_temp_file_and_keeps_the_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("dir.draftcanvas");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("inside"), "keep").unwrap();
        assert!(write_atomic(&target, b"x", None).is_err());
        assert!(temp_leftovers(dir.path()).is_empty());
        assert_eq!(fs::read_to_string(target.join("inside")).unwrap(), "keep");
    }

    #[test]
    fn a_changed_file_is_a_conflict_and_is_not_touched() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "mine").unwrap();
        let stamp = read_document(&path).unwrap().stamp;
        // Same length, different content, later mtime: only the hash can tell.
        fs::write(&path, "them").unwrap();
        touch(&path, Duration::from_secs(5));
        assert_eq!(
            write_atomic(&path, b"overwrite", Some(&stamp)).unwrap(),
            WriteOutcome::Conflict
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "them");
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn touching_only_the_mtime_is_not_a_conflict() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "same").unwrap();
        let stamp = read_document(&path).unwrap().stamp;
        touch(&path, Duration::from_secs(30));
        assert!(matches!(
            write_atomic(&path, b"next", Some(&stamp)).unwrap(),
            WriteOutcome::Saved { .. }
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "next");
    }

    #[test]
    fn a_deleted_file_is_a_conflict() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "x").unwrap();
        let stamp = read_document(&path).unwrap().stamp;
        fs::remove_file(&path).unwrap();
        assert_eq!(
            write_atomic(&path, b"y", Some(&stamp)).unwrap(),
            WriteOutcome::Conflict
        );
        assert!(!path.exists());
    }

    #[test]
    fn a_stamp_that_is_not_ours_never_matches() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "x").unwrap();
        for bad in ["", "v2:1:1:abc", "v1:x:1:abc", "garbage", "v1:1:1:zz:extra"] {
            assert!(!stamp_matches(&path, bad).unwrap(), "{bad}");
            assert_eq!(check_stamp(&path, bad), StampCheck::Changed, "{bad}");
        }
    }

    #[test]
    fn check_stamp_compares_only_mtime_and_size() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "abcd").unwrap();
        let stamp = read_document(&path).unwrap().stamp;
        assert_eq!(check_stamp(&path, &stamp), StampCheck::Unchanged);
        touch(&path, Duration::from_secs(60));
        assert_eq!(check_stamp(&path, &stamp), StampCheck::Changed);
        fs::remove_file(&path).unwrap();
        assert_eq!(check_stamp(&path, &stamp), StampCheck::Missing);
    }

    #[test]
    fn a_read_only_file_is_refused_even_though_its_folder_is_writable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("locked.draftcanvas");
        fs::write(&path, "original").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms).unwrap();

        assert!(is_read_only(&path));
        let err = write_atomic(&path, b"changed", None).err().unwrap();
        assert_eq!(err.kind, ErrorKind::ReadOnly);
        assert_eq!(
            err.message,
            "Draft Canvas couldn't save locked.draftcanvas because the file is read-only."
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_folder_is_a_permission_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o555)).unwrap();
        let probe = File::create(sub.join("probe"));
        if probe.is_err() {
            let err = write_atomic(&sub.join("a.draftcanvas"), b"x", None)
                .err()
                .unwrap();
            assert_eq!(err.kind, ErrorKind::PermissionDenied);
            assert!(err.message.contains("permission to write"));
        } // running as root: the folder can't be made unwritable, so there is nothing to assert
        fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_document_is_written_through_and_stays_a_link() {
        let dir = tempdir().unwrap();
        let real = dir.path().join("real.draftcanvas");
        let link = dir.path().join("link.draftcanvas");
        fs::write(&real, "before").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"after", None).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "after");
        assert!(temp_leftovers(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_saved_file_keeps_the_mode_it_had() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.draftcanvas");
        fs::write(&path, "x").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&path, b"y", None).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_readable_by_the_account_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_private(&path, b"{}", Subject::Preferences).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn create_new_refuses_a_taken_name_and_writes_a_free_one() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("Untitled canvas.draftcanvas");
        let stamp = create_new_atomic(&path, b"first").unwrap();
        assert_eq!(stamp, read_document(&path).unwrap().stamp);
        let err = create_new_atomic(&path, b"second").err().unwrap();
        assert_eq!(err.kind, ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"first");
    }

    #[test]
    fn unique_names_count_up_from_two() {
        let dir = tempdir().unwrap();
        let ext = ".draftcanvas";
        assert_eq!(
            unique_name(dir.path(), "Untitled canvas", ext),
            "Untitled canvas.draftcanvas"
        );
        fs::write(dir.path().join("Untitled canvas.draftcanvas"), "").unwrap();
        assert_eq!(
            unique_name(dir.path(), "Untitled canvas", ext),
            "Untitled canvas 2.draftcanvas"
        );
        fs::write(dir.path().join("Untitled canvas 2.draftcanvas"), "").unwrap();
        fs::write(dir.path().join("Untitled canvas 4.draftcanvas"), "").unwrap();
        assert_eq!(
            unique_name(dir.path(), "Untitled canvas", ext),
            "Untitled canvas 3.draftcanvas"
        );
    }

    #[test]
    fn sidecars_round_trip_and_the_newest_type_replaces_the_others() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("a.draftcanvas");
        fs::write(&doc, "{}").unwrap();
        assert!(sidecar_read(&doc).unwrap().is_none());

        sidecar_write(&doc, "image/png", b"png-bytes").unwrap();
        assert!(dir.path().join("a.draftcanvas.background.png").exists());
        let read = sidecar_read(&doc).unwrap().unwrap();
        assert_eq!(
            (read.mime, read.bytes.as_slice()),
            ("image/png", &b"png-bytes"[..])
        );

        sidecar_write(&doc, "image/jpeg", b"jpg-bytes").unwrap();
        assert!(!dir.path().join("a.draftcanvas.background.png").exists());
        let read = sidecar_read(&doc).unwrap().unwrap();
        assert_eq!(
            (read.mime, read.bytes.as_slice()),
            ("image/jpeg", &b"jpg-bytes"[..])
        );

        sidecar_remove(&doc).unwrap();
        assert!(sidecar_read(&doc).unwrap().is_none());
        sidecar_remove(&doc).unwrap();
    }

    #[test]
    fn sidecars_only_accept_the_four_image_types() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("a.draftcanvas");
        for mime in ["image/svg+xml", "text/html", "application/pdf", ""] {
            let err = sidecar_write(&doc, mime, b"x").err().unwrap();
            assert_eq!(err.kind, ErrorKind::NotADocument, "{mime}");
        }
        for mime in ["image/png", "image/jpeg", "image/webp", "image/gif"] {
            sidecar_write(&doc, mime, b"x").unwrap();
        }
    }

    #[test]
    fn sidecars_are_capped_at_sixteen_megabytes() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("a.draftcanvas");
        let too_big = vec![0u8; MAX_SIDECAR_BYTES as usize + 1];
        let err = sidecar_write(&doc, "image/png", &too_big).err().unwrap();
        assert_eq!(err.kind, ErrorKind::TooLarge);
        assert!(!dir.path().join("a.draftcanvas.background.png").exists());

        let big = dir.path().join("b.draftcanvas.background.png");
        File::create(&big)
            .unwrap()
            .set_len(MAX_SIDECAR_BYTES + 1)
            .unwrap();
        let err = sidecar_read(&dir.path().join("b.draftcanvas"))
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::TooLarge);
    }

    #[test]
    fn save_as_copies_the_background_and_clears_a_stale_one() {
        let dir = tempdir().unwrap();
        let from = dir.path().join("from.draftcanvas");
        let to = dir.path().join("to.draftcanvas");
        sidecar_write(&from, "image/webp", b"bg").unwrap();
        sidecar_write(&to, "image/png", b"stale").unwrap();
        sidecar_copy(&from, &to).unwrap();
        let read = sidecar_read(&to).unwrap().unwrap();
        assert_eq!(
            (read.mime, read.bytes.as_slice()),
            ("image/webp", &b"bg"[..])
        );

        sidecar_remove(&from).unwrap();
        sidecar_copy(&from, &to).unwrap();
        assert!(sidecar_read(&to).unwrap().is_none());
    }
}
