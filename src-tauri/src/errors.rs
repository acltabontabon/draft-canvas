use crate::paths::{display_path, file_name};
use serde::Serialize;
use std::io;
use std::path::Path;

/// The page switches on these names (`DesktopError.kind` in `src/desktop/api.ts`), so they are spelled
/// exactly as the TypeScript union spells them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorKind {
    NotFound,
    PermissionDenied,
    ReadOnly,
    DiskFull,
    TooLarge,
    NotADocument,
    InvalidHandle,
    InvalidPath,
    AlreadyExists,
    Io,
}

/// What every command rejects with, already worded for a person. Nothing here ever carries a raw OS
/// error code: the page shows `message` as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// What Draft Canvas was doing when the disk objected, so the sentence can say "save" or "open".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Open,
    Save,
}

impl Verb {
    fn word(self) -> &'static str {
        match self {
            Verb::Open => "open",
            Verb::Save => "save",
        }
    }
}

/// What the operation was on. Recovery copies and preferences have names nobody chose (`q_3f…json`),
/// so they are described instead of named.
#[derive(Debug, Clone, Copy)]
pub enum Subject<'a> {
    Path(&'a Path),
    RecoveryCopy,
    Preferences,
}

impl Subject<'_> {
    fn describe(self) -> String {
        match self {
            Subject::Path(p) => file_name(p),
            Subject::RecoveryCopy => "a recovery copy".to_string(),
            Subject::Preferences => "your settings".to_string(),
        }
    }

    fn display(self) -> Option<String> {
        match self {
            Subject::Path(p) => Some(display_path(p)),
            _ => None,
        }
    }
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            path: None,
        }
    }

    fn at(mut self, path: Option<String>) -> Self {
        self.path = path;
        self
    }

    /// Turns a failed filesystem call into a sentence. Disk-full and read-only are recognised by their
    /// OS codes rather than `io::ErrorKind`, whose variants for them are newer than this crate's MSRV.
    pub fn from_io(err: &io::Error, verb: Verb, subject: Subject<'_>) -> Self {
        let what = subject.describe();
        let v = verb.word();
        let (kind, message) = match classify(err) {
            IoClass::NotFound => (
                ErrorKind::NotFound,
                format!("Draft Canvas couldn't find {what}. It may have been moved or deleted."),
            ),
            IoClass::PermissionDenied => (
                ErrorKind::PermissionDenied,
                match verb {
                    Verb::Save => format!(
                        "Draft Canvas couldn't save {what} because it doesn't have permission to write there."
                    ),
                    Verb::Open => format!(
                        "Draft Canvas couldn't open {what} because it doesn't have permission to read it."
                    ),
                },
            ),
            IoClass::ReadOnlyDisk => (
                ErrorKind::ReadOnly,
                format!("Draft Canvas couldn't {v} {what} because the disk is read-only."),
            ),
            IoClass::DiskFull => (
                ErrorKind::DiskFull,
                format!("Draft Canvas couldn't {v} {what} because the disk is full."),
            ),
            IoClass::AlreadyExists => (
                ErrorKind::AlreadyExists,
                format!(
                    "Draft Canvas couldn't {v} {what} because a file with that name already exists."
                ),
            ),
            #[cfg(windows)]
            IoClass::InUse => (
                ErrorKind::Io,
                format!("Draft Canvas couldn't {v} {what} because another program is using it."),
            ),
            IoClass::Other => (
                ErrorKind::Io,
                format!(
                    "Draft Canvas couldn't {v} {what} because of a problem with the disk or folder."
                ),
            ),
        };
        Self::new(kind, message).at(subject.display())
    }

    /// A file the user marked read-only (or that the account may not write). Saving would otherwise
    /// succeed anyway, because replacing a file needs write access to its folder, not to the file.
    pub fn read_only(path: &Path) -> Self {
        Self::new(
            ErrorKind::ReadOnly,
            format!(
                "Draft Canvas couldn't save {} because the file is read-only.",
                file_name(path)
            ),
        )
        .at(Some(display_path(path)))
    }

    pub fn too_large(path: &Path, verb: Verb, limit_bytes: u64) -> Self {
        Self::new(
            ErrorKind::TooLarge,
            format!(
                "{} is too large for Draft Canvas to {} (the limit is {} MB).",
                file_name(path),
                verb.word(),
                limit_bytes / (1024 * 1024)
            ),
        )
        .at(Some(display_path(path)))
    }

    pub fn not_a_document(path: &Path) -> Self {
        Self::new(
            ErrorKind::NotADocument,
            format!("{} isn't a Draft Canvas file.", file_name(path)),
        )
        .at(Some(display_path(path)))
    }

    pub fn already_exists(path: &Path) -> Self {
        Self::new(
            ErrorKind::AlreadyExists,
            format!(
                "A file named {} already exists there. Pick another name.",
                file_name(path)
            ),
        )
        .at(Some(display_path(path)))
    }

    /// The handle isn't one Rust gave out this session (or the page invented it).
    pub fn invalid_handle() -> Self {
        Self::new(
            ErrorKind::InvalidHandle,
            "Draft Canvas no longer has access to that file. Open it again from the Open menu.",
        )
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidPath, message)
    }

    /// A request the page built wrongly (missing header, unreadable metadata). It is a bug, not
    /// something a person can fix, so the wording says so plainly.
    pub fn bad_request(detail: &str) -> Self {
        Self::new(
            ErrorKind::Io,
            format!("Draft Canvas sent itself a request it couldn't understand ({detail})."),
        )
    }

    pub fn internal() -> Self {
        Self::new(
            ErrorKind::Io,
            "Draft Canvas hit an internal error and couldn't finish that.",
        )
    }
}

enum IoClass {
    NotFound,
    PermissionDenied,
    ReadOnlyDisk,
    DiskFull,
    AlreadyExists,
    /// Another program has the file open without sharing it (Windows only).
    #[cfg(windows)]
    InUse,
    Other,
}

fn classify(err: &io::Error) -> IoClass {
    if let Some(code) = err.raw_os_error() {
        if let Some(class) = classify_os_code(code) {
            return class;
        }
    }
    match err.kind() {
        io::ErrorKind::NotFound => IoClass::NotFound,
        io::ErrorKind::PermissionDenied => IoClass::PermissionDenied,
        io::ErrorKind::AlreadyExists => IoClass::AlreadyExists,
        _ => IoClass::Other,
    }
}

#[cfg(unix)]
fn classify_os_code(code: i32) -> Option<IoClass> {
    match code {
        28 => Some(IoClass::DiskFull),     // ENOSPC
        30 => Some(IoClass::ReadOnlyDisk), // EROFS
        _ => None,
    }
}

#[cfg(windows)]
fn classify_os_code(code: i32) -> Option<IoClass> {
    match code {
        19 => Some(IoClass::ReadOnlyDisk),   // ERROR_WRITE_PROTECT
        39 | 112 => Some(IoClass::DiskFull), // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
        32 | 33 => Some(IoClass::InUse),     // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(err: io::Error, verb: Verb) -> AppError {
        AppError::from_io(
            &err,
            verb,
            Subject::Path(Path::new("/w/payment-flow.draftcanvas")),
        )
    }

    #[test]
    fn not_found_names_the_file() {
        let e = message(io::Error::from(io::ErrorKind::NotFound), Verb::Open);
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert_eq!(
            e.message,
            "Draft Canvas couldn't find payment-flow.draftcanvas. It may have been moved or deleted."
        );
    }

    #[test]
    fn permission_denied_words_read_and_write_differently() {
        let save = message(io::Error::from(io::ErrorKind::PermissionDenied), Verb::Save);
        assert_eq!(save.kind, ErrorKind::PermissionDenied);
        assert_eq!(
            save.message,
            "Draft Canvas couldn't save payment-flow.draftcanvas because it doesn't have permission to write there."
        );
        let open = message(io::Error::from(io::ErrorKind::PermissionDenied), Verb::Open);
        assert!(open.message.contains("permission to read it"));
    }

    #[test]
    fn already_exists_maps_by_kind() {
        let e = message(io::Error::from(io::ErrorKind::AlreadyExists), Verb::Save);
        assert_eq!(e.kind, ErrorKind::AlreadyExists);
    }

    #[cfg(unix)]
    #[test]
    fn disk_full_and_read_only_disk_are_recognised_by_os_code() {
        let full = message(io::Error::from_raw_os_error(28), Verb::Save);
        assert_eq!(full.kind, ErrorKind::DiskFull);
        assert_eq!(
            full.message,
            "Draft Canvas couldn't save payment-flow.draftcanvas because the disk is full."
        );
        let ro = message(io::Error::from_raw_os_error(30), Verb::Save);
        assert_eq!(ro.kind, ErrorKind::ReadOnly);
        assert!(ro.message.ends_with("because the disk is read-only."));
    }

    #[cfg(windows)]
    #[test]
    fn windows_disk_full_and_sharing_codes_are_recognised() {
        assert_eq!(
            message(io::Error::from_raw_os_error(112), Verb::Save).kind,
            ErrorKind::DiskFull
        );
        assert_eq!(
            message(io::Error::from_raw_os_error(39), Verb::Save).kind,
            ErrorKind::DiskFull
        );
        assert_eq!(
            message(io::Error::from_raw_os_error(19), Verb::Save).kind,
            ErrorKind::ReadOnly
        );
        assert!(message(io::Error::from_raw_os_error(32), Verb::Save)
            .message
            .contains("another program is using it"));
    }

    #[test]
    fn unknown_failures_never_leak_a_raw_code() {
        let e = message(io::Error::from_raw_os_error(9999), Verb::Save);
        assert_eq!(e.kind, ErrorKind::Io);
        assert!(!e.message.contains("9999"));
        assert!(e.message.contains("payment-flow.draftcanvas"));
    }

    #[test]
    fn read_only_file_message_matches_the_product_wording() {
        let e = AppError::read_only(Path::new("/w/payment-flow.draftcanvas"));
        assert_eq!(e.kind, ErrorKind::ReadOnly);
        assert_eq!(
            e.message,
            "Draft Canvas couldn't save payment-flow.draftcanvas because the file is read-only."
        );
    }

    #[test]
    fn recovery_and_settings_are_described_not_named() {
        let e = AppError::from_io(
            &io::Error::from(io::ErrorKind::PermissionDenied),
            Verb::Save,
            Subject::RecoveryCopy,
        );
        assert!(e.message.contains("a recovery copy"));
        assert!(e.path.is_none());
        let e = AppError::from_io(
            &io::Error::from(io::ErrorKind::PermissionDenied),
            Verb::Save,
            Subject::Preferences,
        );
        assert!(e.message.contains("your settings"));
    }

    #[test]
    fn serializes_as_kind_message_and_optional_path() {
        let with_path =
            serde_json::to_value(AppError::not_a_document(Path::new("/w/a.txt"))).unwrap();
        assert_eq!(
            with_path,
            json!({"kind": "NotADocument", "message": "a.txt isn't a Draft Canvas file.", "path": "/w/a.txt"})
        );
        let without = serde_json::to_value(AppError::invalid_handle()).unwrap();
        assert_eq!(without["kind"], "InvalidHandle");
        assert!(without.get("path").is_none());
    }

    #[test]
    fn every_kind_serializes_to_the_typescript_spelling() {
        for (kind, name) in [
            (ErrorKind::NotFound, "NotFound"),
            (ErrorKind::PermissionDenied, "PermissionDenied"),
            (ErrorKind::ReadOnly, "ReadOnly"),
            (ErrorKind::DiskFull, "DiskFull"),
            (ErrorKind::TooLarge, "TooLarge"),
            (ErrorKind::NotADocument, "NotADocument"),
            (ErrorKind::InvalidHandle, "InvalidHandle"),
            (ErrorKind::InvalidPath, "InvalidPath"),
            (ErrorKind::AlreadyExists, "AlreadyExists"),
            (ErrorKind::Io, "Io"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
        }
    }
}
