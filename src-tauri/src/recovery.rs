//! Recovery copies: what the page keeps of unsaved work so a crash or a quit doesn't lose it. They live
//! in the app's own local-data folder, never beside (or instead of) the person's files, and nothing here
//! ever deletes one on its own: only `discard`, which the page calls after a person decides.
//!
//! Each entry is two files, `<id>.draftcanvas` (the document) and `<id>.json` (who it belongs to).

use crate::docio::{read_document, write_private, MAX_DOC_BYTES};
use crate::errors::{AppError, ErrorKind, Subject, Verb};
use crate::util::lock;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const VERSION: u32 = 1;
const RECOVERED_TITLE: &str = "Recovered draft";

/// `q_<uuid>` for a quick draft, `f_<uuid>` for a snapshot of a named file. The id becomes part of a
/// file name, so anything else is refused: this is the guard against a page-supplied `../`.
pub fn is_valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 38
        && matches!(b[0], b'q' | b'f')
        && b[1] == b'_'
        && b[2..]
            .iter()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

fn checked(id: &str) -> Result<&str, AppError> {
    if is_valid_id(id) {
        Ok(id)
    } else {
        Err(AppError::invalid_handle())
    }
}

/// Where a snapshot came from, as stored. For a named file the path is written by Rust from a handle;
/// the page never supplies one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum StoredOrigin {
    Quick,
    File { path: String, base_stamp: String },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    v: u32,
    id: String,
    origin: StoredOrigin,
    title: String,
    updated_at: u64,
    bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub origin: StoredOrigin,
    pub title: String,
    pub updated_at: u64,
    pub bytes: u64,
}

pub struct Recovery {
    dir: PathBuf,
    guard: Mutex<()>,
}

impl Recovery {
    pub fn new(local_data_dir: &Path) -> Self {
        Self {
            dir: local_data_dir.join("recovery"),
            guard: Mutex::new(()),
        }
    }

    fn data_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.draftcanvas"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// The document first, then who it belongs to: a crash between the two leaves a document without a
    /// label (still recoverable, see `list`), never a label pointing at nothing.
    pub fn write(
        &self,
        id: &str,
        origin: StoredOrigin,
        title: &str,
        bytes: &[u8],
        now_ms: u64,
    ) -> Result<(), AppError> {
        checked(id)?;
        if bytes.len() as u64 > MAX_DOC_BYTES {
            return Err(AppError::new(
                ErrorKind::TooLarge,
                format!(
                    "This canvas is too large for Draft Canvas to keep a recovery copy of (the limit is {} MB).",
                    MAX_DOC_BYTES / (1024 * 1024)
                ),
            ));
        }
        let meta = serde_json::to_vec_pretty(&Meta {
            v: VERSION,
            id: id.to_string(),
            origin,
            title: title.to_string(),
            updated_at: now_ms,
            bytes: bytes.len() as u64,
        })
        .map_err(|_| AppError::internal())?;

        let _held = lock(&self.guard);
        fs::create_dir_all(&self.dir)
            .map_err(|e| AppError::from_io(&e, Verb::Save, Subject::RecoveryCopy))?;
        write_private(&self.data_path(id), bytes, Subject::RecoveryCopy)?;
        write_private(&self.meta_path(id), &meta, Subject::RecoveryCopy)
    }

    /// Newest first. A document with no (or unreadable) label is still offered, as a quick draft called
    /// "Recovered draft", because losing work over a missing label would defeat the point. A label with no
    /// document has nothing to recover and is deleted.
    pub fn list(&self) -> Result<Vec<Entry>, AppError> {
        let _held = lock(&self.guard);
        let read_dir = match fs::read_dir(&self.dir) {
            Ok(read_dir) => read_dir,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::from_io(&e, Verb::Open, Subject::RecoveryCopy)),
        };

        let mut ids = BTreeSet::new();
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Nobody else writes here, and the guard is held, so a temp file is debris from a crash.
            if name.starts_with('.') && name.contains(".dctmp-") {
                let _ = fs::remove_file(entry.path());
                continue;
            }
            let stem = name
                .strip_suffix(".draftcanvas")
                .or_else(|| name.strip_suffix(".json"));
            if let Some(id) = stem.filter(|s| is_valid_id(s)) {
                ids.insert(id.to_string());
            }
        }

        let mut entries = Vec::new();
        for id in ids {
            let data = fs::metadata(self.data_path(&id))
                .ok()
                .filter(|m| m.is_file());
            let meta = fs::read(self.meta_path(&id))
                .ok()
                .and_then(|b| serde_json::from_slice::<Meta>(&b).ok())
                .filter(|m| m.v == VERSION && m.id == id);
            match (data, meta) {
                (Some(data), Some(meta)) => entries.push(Entry {
                    id,
                    origin: meta.origin,
                    title: meta.title,
                    updated_at: meta.updated_at,
                    bytes: data.len(),
                }),
                (Some(data), None) => entries.push(Entry {
                    id,
                    origin: StoredOrigin::Quick,
                    title: RECOVERED_TITLE.to_string(),
                    updated_at: data
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                    bytes: data.len(),
                }),
                (None, _) => {
                    let _ = fs::remove_file(self.meta_path(&id));
                }
            }
        }
        entries.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(entries)
    }

    pub fn read(&self, id: &str) -> Result<String, AppError> {
        checked(id)?;
        let _held = lock(&self.guard);
        read_document(&self.data_path(id))
            .map(|doc| doc.text)
            .map_err(|e| match e.kind {
                ErrorKind::NotFound => {
                    AppError::new(ErrorKind::NotFound, "That recovery copy no longer exists.")
                }
                _ => e,
            })
    }

    /// Removes the entry and anything else that starts with its id (a stray temp file, an old label).
    /// Discarding something that isn't there succeeds.
    pub fn discard(&self, id: &str) -> Result<(), AppError> {
        checked(id)?;
        let _held = lock(&self.guard);
        let read_dir = match fs::read_dir(&self.dir) {
            Ok(read_dir) => read_dir,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(AppError::from_io(&e, Verb::Save, Subject::RecoveryCopy)),
        };
        let own = format!("{id}.");
        let own_temp = format!(".{id}.");
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&own) || name.starts_with(&own_temp) {
                match fs::remove_file(entry.path()) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(AppError::from_io(&e, Verb::Save, Subject::RecoveryCopy)),
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::{tempdir, TempDir};

    const Q1: &str = "q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3a";
    const Q2: &str = "q_00000000-0000-4000-8000-000000000002";
    const F1: &str = "f_11111111-2222-4333-8444-555555555555";

    fn fixture() -> (TempDir, Recovery) {
        let dir = tempdir().unwrap();
        let recovery = Recovery::new(dir.path());
        (dir, recovery)
    }

    fn file_origin() -> StoredOrigin {
        StoredOrigin::File {
            path: "/w/payment-flow.draftcanvas".into(),
            base_stamp: "v1:1:2:abc".into(),
        }
    }

    #[test]
    fn write_list_read_discard() {
        let (dir, recovery) = fixture();
        assert!(recovery.list().unwrap().is_empty());

        recovery
            .write(Q1, StoredOrigin::Quick, "Sketch", b"{\"a\":1}", 100)
            .unwrap();
        recovery
            .write(F1, file_origin(), "payment-flow", b"{\"b\":2}", 200)
            .unwrap();

        let entries = recovery.list().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0],
            Entry {
                id: F1.into(),
                origin: file_origin(),
                title: "payment-flow".into(),
                updated_at: 200,
                bytes: 7
            }
        );
        assert_eq!(
            entries[1],
            Entry {
                id: Q1.into(),
                origin: StoredOrigin::Quick,
                title: "Sketch".into(),
                updated_at: 100,
                bytes: 7
            }
        );
        assert_eq!(recovery.read(Q1).unwrap(), "{\"a\":1}");

        recovery.discard(Q1).unwrap();
        assert!(!dir
            .path()
            .join("recovery")
            .join(format!("{Q1}.draftcanvas"))
            .exists());
        assert!(!dir
            .path()
            .join("recovery")
            .join(format!("{Q1}.json"))
            .exists());
        assert_eq!(recovery.list().unwrap().len(), 1);
        recovery.discard(Q1).unwrap();
        assert_eq!(recovery.read(Q1).err().unwrap().kind, ErrorKind::NotFound);
    }

    #[test]
    fn a_second_write_replaces_the_first() {
        let (_dir, recovery) = fixture();
        recovery
            .write(Q1, StoredOrigin::Quick, "one", b"111", 1)
            .unwrap();
        recovery
            .write(Q1, StoredOrigin::Quick, "two", b"22", 2)
            .unwrap();
        let entries = recovery.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            (
                entries[0].title.as_str(),
                entries[0].bytes,
                entries[0].updated_at
            ),
            ("two", 2, 2)
        );
        assert_eq!(recovery.read(Q1).unwrap(), "22");
    }

    #[test]
    fn the_label_file_has_the_documented_shape() {
        let (dir, recovery) = fixture();
        recovery
            .write(Q1, StoredOrigin::Quick, "Sketch", b"{}", 5)
            .unwrap();
        recovery.write(F1, file_origin(), "pf", b"{}", 6).unwrap();
        let read = |id: &str| -> serde_json::Value {
            serde_json::from_slice(
                &fs::read(dir.path().join("recovery").join(format!("{id}.json"))).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            read(Q1),
            json!({"v": 1, "id": Q1, "origin": {"kind": "quick"}, "title": "Sketch", "updatedAt": 5, "bytes": 2})
        );
        assert_eq!(
            read(F1),
            json!({"v": 1, "id": F1, "origin": {"kind": "file", "path": "/w/payment-flow.draftcanvas", "baseStamp": "v1:1:2:abc"}, "title": "pf", "updatedAt": 6, "bytes": 2})
        );
    }

    #[test]
    fn a_document_without_a_label_is_offered_as_a_recovered_draft() {
        let (dir, recovery) = fixture();
        recovery
            .write(Q1, file_origin(), "named", b"{}", 5)
            .unwrap();
        fs::remove_file(dir.path().join("recovery").join(format!("{Q1}.json"))).unwrap();
        let entries = recovery.list().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].origin, StoredOrigin::Quick);
        assert_eq!(entries[0].title, "Recovered draft");
        assert_eq!(entries[0].bytes, 2);
        assert!(entries[0].updated_at > 0);
        assert_eq!(recovery.read(Q1).unwrap(), "{}");
    }

    #[test]
    fn a_corrupt_label_is_treated_like_a_missing_one() {
        let (dir, recovery) = fixture();
        recovery
            .write(Q1, StoredOrigin::Quick, "t", b"{}", 5)
            .unwrap();
        fs::write(
            dir.path().join("recovery").join(format!("{Q1}.json")),
            "not json",
        )
        .unwrap();
        assert_eq!(recovery.list().unwrap()[0].title, "Recovered draft");
    }

    #[test]
    fn a_label_without_a_document_is_deleted() {
        let (dir, recovery) = fixture();
        recovery
            .write(Q1, StoredOrigin::Quick, "t", b"{}", 5)
            .unwrap();
        fs::remove_file(
            dir.path()
                .join("recovery")
                .join(format!("{Q1}.draftcanvas")),
        )
        .unwrap();
        assert!(recovery.list().unwrap().is_empty());
        assert!(!dir
            .path()
            .join("recovery")
            .join(format!("{Q1}.json"))
            .exists());
    }

    #[test]
    fn listing_is_newest_first_and_clears_crash_debris() {
        let (dir, recovery) = fixture();
        recovery
            .write(Q1, StoredOrigin::Quick, "old", b"1", 10)
            .unwrap();
        recovery
            .write(Q2, StoredOrigin::Quick, "new", b"2", 20)
            .unwrap();
        let debris = dir
            .path()
            .join("recovery")
            .join(format!(".{Q1}.draftcanvas.dctmp-99-abcd1234"));
        fs::write(&debris, "half").unwrap();
        fs::write(dir.path().join("recovery").join("notes.txt"), "not ours").unwrap();
        let titles: Vec<String> = recovery
            .list()
            .unwrap()
            .into_iter()
            .map(|e| e.title)
            .collect();
        assert_eq!(titles, ["new", "old"]);
        assert!(!debris.exists());
        assert!(
            dir.path().join("recovery").join("notes.txt").exists(),
            "files that aren't ours are left alone"
        );
    }

    #[test]
    fn discard_takes_every_file_of_the_entry_and_nothing_else() {
        let (dir, recovery) = fixture();
        recovery
            .write(Q1, StoredOrigin::Quick, "a", b"1", 1)
            .unwrap();
        recovery
            .write(Q2, StoredOrigin::Quick, "b", b"2", 2)
            .unwrap();
        let stray = dir.path().join("recovery").join(format!("{Q1}.old.json"));
        fs::write(&stray, "x").unwrap();
        recovery.discard(Q1).unwrap();
        assert!(!stray.exists());
        assert_eq!(recovery.list().unwrap().len(), 1);
        assert_eq!(recovery.read(Q2).unwrap(), "2");
    }

    #[test]
    fn ids_must_be_exactly_the_generated_shape() {
        for good in [Q1, Q2, F1] {
            assert!(is_valid_id(good), "{good}");
        }
        for bad in [
            "",
            "q_",
            "../../etc/passwd",
            "q_../../etc/passwd-0000-0000-0000-000000",
            "x_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3a",
            "Q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3a",
            "q-3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3a",
            "q_3F2B8C1E-9D4A-4C55-8A1B-0E7F6D5C4B3A",
            "q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3",
            "q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3aa",
            "q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b3/",
            "q_3f2b8c1e-9d4a-4c55-8a1b-0e7f6d5c4b\\a",
        ] {
            assert!(!is_valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_bad_id_is_refused_by_every_operation() {
        let (dir, recovery) = fixture();
        for bad in ["../../evil", "q_x", ""] {
            assert_eq!(
                recovery
                    .write(bad, StoredOrigin::Quick, "t", b"{}", 1)
                    .err()
                    .unwrap()
                    .kind,
                ErrorKind::InvalidHandle
            );
            assert_eq!(
                recovery.read(bad).err().unwrap().kind,
                ErrorKind::InvalidHandle
            );
            assert_eq!(
                recovery.discard(bad).err().unwrap().kind,
                ErrorKind::InvalidHandle
            );
        }
        assert!(
            !dir.path().join("recovery").exists(),
            "a refused write creates nothing"
        );
    }

    #[test]
    fn an_oversized_snapshot_is_refused_before_anything_is_written() {
        let (dir, recovery) = fixture();
        let err = recovery
            .write(
                Q1,
                StoredOrigin::Quick,
                "t",
                &vec![b'a'; MAX_DOC_BYTES as usize + 1],
                1,
            )
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::TooLarge);
        assert!(!dir.path().join("recovery").exists());
    }
}
