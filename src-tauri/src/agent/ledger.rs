//! What the agent bridge remembers about requests it was asked to make, so a retry after a lost
//! response returns the first outcome instead of doing the work twice.
//!
//! An append-only journal (`ledger.jsonl`): one JSON record per line, each flushed to disk before the
//! step it describes goes ahead, so a crash at any point leaves a record of how far the request got.
//! A torn last line (the crash happened mid-write) is ignored on load. The journal is rewritten to its
//! live entries — atomically, temp file then rename — on start and whenever it has grown.
//!
//! What it promises, and no more: while a request's entry is retained, the same `requestId` is applied
//! at most once. Where the journal can't tell whether an update reached the document (the app stopped
//! between the commit gate and the receipt), it says so — `OUTCOME_UNKNOWN` — rather than guess.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// How long a finished request is remembered, and how many are.
pub const RESOLVED_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const RESOLVED_CAP: usize = 2_000;
/// An entry that never resolved is kept longer: it is the only evidence left about that request.
pub const UNRESOLVED_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// Records appended before the journal is compacted again.
const COMPACT_AFTER: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    /// Registered; nothing has been changed yet.
    Pending,
    /// Past the commit gate: the change may be in the document (or, for a create, on disk).
    Committing,
    /// Done, with the receipt the caller was (or should have been) given.
    Committed,
    /// Refused before anything changed. Safe to run again.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub tool: String,
    pub fingerprint: String,
    pub stage: Stage,
    pub at: u64,
    /// For a create: the document id minted for this request before anything was written — the
    /// evidence a crash recovery looks for on disk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagram_id: Option<String>,
    /// Where the document lives, so a replay can check it is still in an enabled project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Value>,
}

/// What `begin` found for a request.
#[derive(Debug, Clone, PartialEq)]
pub enum Begin {
    /// Never seen, or seen and refused before anything changed: go ahead.
    Fresh,
    /// Already done; this is what it said.
    Replay(Entry),
    /// Seen with different content under the same id.
    Mismatch,
    /// Registered or past the gate in an earlier run of the app, never resolved. The caller decides,
    /// from evidence the journal doesn't have (is the document on disk?), what that means.
    Unresolved(Entry),
}

pub struct Ledger {
    file: PathBuf,
    entries: HashMap<String, Entry>,
    appended: usize,
}

impl Ledger {
    /// Opens (creating if needed) the journal in `dir`, dropping what has aged out and compacting.
    pub fn open(dir: &Path, now: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = dir.join("ledger.jsonl");
        let mut ledger = Self {
            file,
            entries: HashMap::new(),
            appended: 0,
        };
        ledger.load()?;
        ledger.evict(now);
        ledger.compact()?;
        Ok(ledger)
    }

    fn load(&mut self) -> io::Result<()> {
        let file = match File::open(&self.file) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        };
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            // A line that doesn't parse is the one a crash cut short; everything before it stands.
            if let Ok(entry) = serde_json::from_str::<Entry>(&line) {
                self.entries.insert(entry.key.clone(), entry);
            }
        }
        Ok(())
    }

    pub fn get(&self, key: &str) -> Option<&Entry> {
        self.entries.get(key)
    }

    /// Looks a request up before any work is done. Replays are decided here, ahead of any revision
    /// check, so the retry of a request whose first attempt succeeded isn't refused as stale.
    pub fn begin(&self, key: &str, fingerprint: &str) -> Begin {
        match self.entries.get(key) {
            None => Begin::Fresh,
            Some(entry) if entry.fingerprint != fingerprint => Begin::Mismatch,
            Some(entry) => match entry.stage {
                Stage::Failed => Begin::Fresh,
                Stage::Committed => Begin::Replay(entry.clone()),
                Stage::Pending | Stage::Committing => Begin::Unresolved(entry.clone()),
            },
        }
    }

    /// Writes `entry` through to disk before returning: the step it records may only go ahead once
    /// this has.
    pub fn record(&mut self, entry: Entry) -> io::Result<()> {
        let mut line = serde_json::to_vec(&entry).map_err(io::Error::other)?;
        line.push(b'\n');
        let mut file = private(OpenOptions::new().create(true).append(true)).open(&self.file)?;
        file.write_all(&line)?;
        file.sync_data()?;
        self.entries.insert(entry.key.clone(), entry);
        self.appended += 1;
        if self.appended >= COMPACT_AFTER {
            self.compact()?;
        }
        Ok(())
    }

    /// Moves an existing entry to `stage`, with whatever else the step learned.
    pub fn advance(
        &mut self,
        key: &str,
        stage: Stage,
        now: u64,
        update: impl FnOnce(&mut Entry),
    ) -> io::Result<()> {
        let Some(mut entry) = self.entries.get(key).cloned() else {
            return Ok(());
        };
        entry.stage = stage;
        entry.at = now;
        update(&mut entry);
        self.record(entry)
    }

    fn evict(&mut self, now: u64) {
        self.entries.retain(|_, e| {
            let age = now.saturating_sub(e.at);
            match e.stage {
                Stage::Committed | Stage::Failed => age <= RESOLVED_RETENTION_MS,
                Stage::Pending | Stage::Committing => age <= UNRESOLVED_RETENTION_MS,
            }
        });
        let mut resolved: Vec<(u64, String)> = self
            .entries
            .values()
            .filter(|e| matches!(e.stage, Stage::Committed | Stage::Failed))
            .map(|e| (e.at, e.key.clone()))
            .collect();
        if resolved.len() > RESOLVED_CAP {
            resolved.sort();
            for (_, key) in resolved.iter().take(resolved.len() - RESOLVED_CAP) {
                self.entries.remove(key);
            }
        }
    }

    /// Rewrites the journal to exactly the live entries. Temp file, flush, rename: a crash leaves either
    /// the old journal or the new one, never a mix.
    fn compact(&mut self) -> io::Result<()> {
        let mut entries: Vec<&Entry> = self.entries.values().collect();
        entries.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.key.cmp(&b.key)));
        let temp = self.file.with_extension("jsonl.tmp");
        {
            let mut out =
                private(OpenOptions::new().write(true).create(true).truncate(true)).open(&temp)?;
            for entry in entries {
                let mut line = serde_json::to_vec(entry).map_err(io::Error::other)?;
                line.push(b'\n');
                out.write_all(&line)?;
            }
            out.sync_all()?;
        }
        fs::rename(&temp, &self.file)?;
        self.appended = 0;
        Ok(())
    }
}

/// Request ids and diagram paths are the person's business: the journal is readable by this account only.
fn private(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn entry(key: &str, stage: Stage, at: u64) -> Entry {
        Entry {
            key: key.into(),
            tool: "update_diagram".into(),
            fingerprint: "fp".into(),
            stage,
            at,
            diagram_id: None,
            path: None,
            receipt: None,
        }
    }

    #[test]
    fn a_fresh_request_is_fresh_and_a_committed_one_replays() {
        let dir = tempdir().unwrap();
        let mut ledger = Ledger::open(dir.path(), 1).unwrap();
        assert_eq!(ledger.begin("k", "fp"), Begin::Fresh);
        ledger.record(entry("k", Stage::Pending, 1)).unwrap();
        ledger
            .advance("k", Stage::Committed, 2, |e| {
                e.receipt = Some(json!({"revision": "o:1.2"}))
            })
            .unwrap();
        let Begin::Replay(found) = ledger.begin("k", "fp") else {
            panic!("replays")
        };
        assert_eq!(found.receipt, Some(json!({"revision": "o:1.2"})));
        assert_eq!(ledger.begin("k", "other"), Begin::Mismatch);
    }

    #[test]
    fn survives_a_restart_and_ignores_a_torn_last_line() {
        let dir = tempdir().unwrap();
        {
            let mut ledger = Ledger::open(dir.path(), 1).unwrap();
            ledger.record(entry("a", Stage::Pending, 1)).unwrap();
            ledger.advance("a", Stage::Committing, 2, |_| {}).unwrap();
        }
        // The crash came mid-write of the next record.
        let mut file = OpenOptions::new()
            .append(true)
            .open(dir.path().join("ledger.jsonl"))
            .unwrap();
        file.write_all(b"{\"key\":\"a\",\"stage\":\"comm").unwrap();
        drop(file);

        let ledger = Ledger::open(dir.path(), 3).unwrap();
        let Begin::Unresolved(found) = ledger.begin("a", "fp") else {
            panic!("the last whole record stands")
        };
        assert_eq!(found.stage, Stage::Committing);
    }

    #[test]
    fn a_request_refused_before_it_changed_anything_may_run_again() {
        let dir = tempdir().unwrap();
        let mut ledger = Ledger::open(dir.path(), 1).unwrap();
        ledger.record(entry("k", Stage::Failed, 1)).unwrap();
        assert_eq!(ledger.begin("k", "fp"), Begin::Fresh);
    }

    #[test]
    fn resolved_entries_age_out_before_unresolved_ones() {
        let dir = tempdir().unwrap();
        {
            let mut ledger = Ledger::open(dir.path(), 0).unwrap();
            ledger.record(entry("done", Stage::Committed, 0)).unwrap();
            ledger.record(entry("open", Stage::Committing, 0)).unwrap();
        }
        let later = RESOLVED_RETENTION_MS + 1;
        let ledger = Ledger::open(dir.path(), later).unwrap();
        assert!(ledger.get("done").is_none());
        assert!(
            ledger.get("open").is_some(),
            "the only evidence about it is kept"
        );
        let ledger = Ledger::open(dir.path(), UNRESOLVED_RETENTION_MS + 1).unwrap();
        assert!(ledger.get("open").is_none());
    }

    #[test]
    fn the_resolved_cap_drops_the_oldest_first() {
        let dir = tempdir().unwrap();
        let mut ledger = Ledger::open(dir.path(), 0).unwrap();
        for i in 0..(RESOLVED_CAP as u64 + 3) {
            ledger
                .record(entry(&format!("k{i}"), Stage::Committed, i))
                .unwrap();
        }
        drop(ledger);
        let ledger = Ledger::open(dir.path(), RESOLVED_CAP as u64 + 3).unwrap();
        assert!(ledger.get("k0").is_none());
        assert!(ledger.get("k2").is_none());
        assert!(ledger.get("k3").is_some());
    }
}
