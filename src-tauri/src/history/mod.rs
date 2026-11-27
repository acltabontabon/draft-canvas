//! Canvas Evolution's desktop history backend: the `VersionStore` contract of
//! `src/evolution/contracts.ts`, over bare Git repositories in the app's own local-data folder.
//!
//! Each history is `<local data>/history/<repoId>.git`, a standard bare repository whose revisions
//! each hold exactly one file, `diagram.draftcanvas`, so `git clone`, `git log` and `git show` read
//! it as they read any other. Draft Canvas's own state lives beside the objects in `draft-canvas/`:
//! `repo.json` (the `RepoMeta`), `journal/` (multi-step operations in flight) and `write.lock`.
//!
//! The browser backend (`src/evolution/browser/igitStore.ts`) and this one write the same objects
//! byte for byte and answer every query in the same order; `tests.rs` holds this one to the shared
//! fixtures (`tests/fixtures/evolution/contract.json`).
//!
//! Everything the page sends is untrusted. A repository is named by an id the page cannot turn into
//! a path (`is_safe_id`), refs pass `is_safe_ref_name`, object ids must be 40 lowercase hex digits,
//! and every walk and payload is bounded by `limits`. gix runs no hooks, filters or external
//! programs, and repositories are opened isolated from the person's Git configuration.

pub mod bindings;
#[cfg(test)]
mod git_tests;
pub mod gitcli;
mod objects;
pub mod pack;
pub mod project;
pub mod remote;
pub mod store;
#[cfg(test)]
mod tests;

use crate::errors::{AppError, ErrorKind, Subject, Verb};
use serde::{Deserialize, Serialize};
use std::io;

pub use bindings::Binding;
pub use store::History;

/// The one path every revision's tree holds.
pub const DIAGRAM_PATH: &str = "diagram.draftcanvas";

/// `HISTORY_LIMITS` in `contracts.ts`, plus the limits only a backend needs.
pub mod limits {
    pub const MAX_BLOB_BYTES: usize = 24 * 1024 * 1024;
    pub const MAX_LOG_PAGE: usize = 500;
    pub const MAX_WALK: usize = 200_000;
    pub const MAX_BUNDLE_BYTES: usize = 512 * 1024 * 1024;
    pub const MAX_BUNDLE_OBJECTS: usize = 2_000_000;
    pub const MAX_BUNDLE_REFS: usize = 10_000;
    pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
    /// `PACK_LIMITS.maxTotalInflated` in `bundleIo.ts`: the sum of every object an imported pack inflates to.
    pub const MAX_TOTAL_INFLATED: u64 = 2 * 1024 * 1024 * 1024;
    /// `PACK_LIMITS.maxDeltaDepth`: deeper than Git itself writes.
    pub const MAX_DELTA_DEPTH: u32 = 4096;
    /// A commit or tag object: headers plus a message. Ours are under 17 KiB; one from elsewhere may
    /// carry a longer message, but nothing a history needs is anywhere near this.
    pub const MAX_COMMIT_BYTES: usize = 1024 * 1024;
    /// `repo.json`, a journal entry, the bindings registry.
    pub const MAX_JSON_BYTES: usize = 1024 * 1024;
    pub const MAX_BINDINGS_BYTES: usize = 16 * 1024 * 1024;
    /// Commits asked for in one `read_commits`.
    pub const MAX_BATCH: usize = 1000;
    /// A working copy's id is `file_<canonical path>` at most: a long path, never a document.
    pub const MAX_COPY_ID_BYTES: usize = 8 * 1024;
}

/// `HistoryError.code` in `contracts.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    NotFound,
    Corrupt,
    UnsupportedFormat,
    Conflict,
    Quota,
    Unavailable,
    Invalid,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HistoryError {
    pub code: Code,
    pub message: String,
    /// Finer than `code`, for the page to act on: which Git failure (`gitcli::Failure`) or which
    /// precondition of publishing refused (`project.rs`).
    pub reason: Option<&'static str>,
}

pub type Result<T> = std::result::Result<T, HistoryError>;

impl HistoryError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            reason: None,
        }
    }

    pub fn with_reason(mut self, reason: &'static str) -> Self {
        self.reason = Some(reason);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Code::Invalid, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(Code::NotFound, message)
    }

    pub fn corrupt(message: impl Into<String>) -> Self {
        Self::new(Code::Corrupt, message)
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self::new(Code::TooLarge, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(Code::Conflict, message)
    }

    /// A failed filesystem call, worded the way every other disk failure in the app is.
    pub fn io(err: &io::Error, verb: Verb) -> Self {
        let app = AppError::from_io(err, verb, Subject::History);
        let code = match app.kind {
            ErrorKind::NotFound => Code::NotFound,
            ErrorKind::DiskFull => Code::Quota,
            _ => Code::Unavailable,
        };
        Self::new(code, app.message)
    }

    /// Something gix refused. Its own wording names internals, so the person gets a plain sentence.
    pub fn git(_err: impl std::fmt::Display) -> Self {
        Self::corrupt("Draft Canvas couldn't read or write this diagram's history.")
    }
}

impl From<HistoryError> for AppError {
    fn from(err: HistoryError) -> Self {
        let kind = match err.code {
            Code::NotFound => ErrorKind::NotFound,
            Code::Corrupt => ErrorKind::Corrupt,
            Code::UnsupportedFormat => ErrorKind::Unsupported,
            Code::Conflict => ErrorKind::Conflict,
            Code::Quota => ErrorKind::DiskFull,
            Code::Unavailable => ErrorKind::Io,
            Code::Invalid => ErrorKind::Invalid,
            Code::TooLarge => ErrorKind::TooLarge,
        };
        let mut app = AppError::new(kind, err.message);
        app.reason = err.reason.map(str::to_string);
        app
    }
}

/// `isSafeId` in `refs.ts`: the only form a repository, staging or operation id may take. It becomes
/// part of a file name, so this is the guard against a page-supplied `../`. Stricter than the
/// page's in one way: a Windows device name (`con`, `nul`, `com1`…) names no file there, on any
/// platform, so a history moved between machines never meets one. Ids are random, so none is lost.
pub fn is_safe_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && matches!(b[0], b'a'..=b'z' | b'0'..=b'9')
        && b[1..]
            .iter()
            .all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
        && !is_device_name(id)
}

fn is_device_name(id: &str) -> bool {
    matches!(id, "con" | "prn" | "aux" | "nul")
        || (id.len() == 4
            && (id.starts_with("com") || id.starts_with("lpt"))
            && id.as_bytes()[3].is_ascii_digit())
}

/// `isSafeRefName` in `refs.ts`: `git check-ref-format`, tightened.
pub fn is_safe_ref_name(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b.len() > 255 || !name.starts_with("refs/") {
        return false;
    }
    if !b.iter().all(|c| (0x21..=0x7e).contains(c)) {
        return false;
    }
    if b.iter()
        .any(|c| matches!(c, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\'))
    {
        return false;
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return false;
    }
    if name.ends_with('/') || name.ends_with('.') {
        return false;
    }
    name.split('/').all(|part| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part.starts_with('-')
            && !part.ends_with(".lock")
    })
}

pub fn is_oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn parse_oid(value: &str) -> Result<gix::ObjectId> {
    if !is_oid(value) {
        return Err(HistoryError::invalid("Not an object id."));
    }
    gix::ObjectId::from_hex(value.as_bytes())
        .map_err(|_| HistoryError::invalid("Not an object id."))
}

pub fn require_ref(name: &str) -> Result<()> {
    if is_safe_ref_name(name) {
        Ok(())
    } else {
        Err(HistoryError::invalid(
            "Not a ref Draft Canvas reads or writes.",
        ))
    }
}

/// `Signature` in `contracts.ts`. `timezone_offset` is in minutes as `Date.getTimezoneOffset()`
/// reports them: positive west of UTC, so Git's `+0200` is `-120`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub timestamp: i64,
    pub timezone_offset: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRecord {
    pub oid: String,
    pub tree: String,
    pub parents: Vec<String>,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
}

/// `SnapshotWrite` without its text, which travels as the raw body.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotHead {
    pub parents: Vec<String>,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RefUpdate {
    #[serde(rename = "ref")]
    pub name: String,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub next: Option<String>,
}

/// `{ ok: true }` or `{ ok: false, actual }`, with `actual` present (possibly `null`) only on a miss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefUpdateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<Option<String>>,
}

impl RefUpdateResult {
    pub fn applied() -> Self {
        Self {
            ok: true,
            actual: None,
        }
    }

    pub fn missed(actual: Option<String>) -> Self {
        Self {
            ok: false,
            actual: Some(actual),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefEntry {
    #[serde(rename = "ref")]
    pub name: String,
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TagWrite {
    #[serde(rename = "ref")]
    pub name_ref: String,
    pub target: String,
    pub name: String,
    pub tagger: Signature,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagRecord {
    pub oid: String,
    #[serde(rename = "ref")]
    pub name: String,
    pub target: String,
    pub message: String,
    pub tagger: Signature,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LogQuery {
    pub from: Vec<String>,
    pub limit: i64,
    #[serde(default)]
    pub hide: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RepoUsage {
    pub bytes: u64,
    pub objects: u64,
}

/// What `maintain` did. `skipped` names why nothing was touched (`"journal"`: an operation is open).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintainOutcome {
    pub skipped: Option<String>,
    pub pruned: u64,
}
