//! What a coding agent proposed for a diagram, and what the person has done with it since.
//!
//! An append-only journal (`proposals.jsonl`), the same on-disk discipline as `ledger.rs` — one JSON
//! record per line, flushed and fsync'd before the step it describes goes ahead, compacted to its live
//! entries (temp file, then rename) on load and periodically after. A torn last line is ignored.
//!
//! This is a different concern from the ledger, not a second copy of it: the ledger answers "was this
//! exact call already applied" (a fingerprint, replayed at most once); this store answers "what is the
//! current content and review state of this long-lived object" (revised in place, read back across a
//! restart, resolved by a person days later). `submit_proposal`'s call-level retry safety still goes
//! through the ledger, same as every other tool; only the proposal's own version/status lifecycle lives
//! here.
//!
//! Every transition this module allows is a plain overwrite — `Pending` revised in place, or moved to a
//! terminal status. Whether a transition is *permitted* (only a `Pending` proposal may be revised; a
//! resolve to a status that conflicts with an existing terminal one is refused) is the broker's business
//! logic, not this module's — mirroring how `ledger.rs` stays a dumb store and `broker.rs` holds the
//! rules, just as it does for revision conflicts and duplicate titles today.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// How long a resolved (terminal) proposal is kept before it's dropped. Pending and Accepting ones —
/// the only evidence of unreviewed or in-flight work — are never aged out by time.
pub const RESOLVED_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
/// At most this many resolved proposals are kept; the oldest are dropped first. A proposal carries a
/// full op payload, larger than a ledger entry, so this is tighter than the ledger's cap.
pub const RESOLVED_CAP: usize = 500;
const COMPACT_AFTER: usize = 200;
/// Unreviewed proposals one diagram may have waiting, and all diagrams together. Waiting ones are never
/// aged out (they're work nobody has looked at), so without a cap an agent in a loop could grow the
/// journal, and the review panel's list, without end. Far more than anyone reviews; a new one past
/// either is refused until some are accepted, rejected or dismissed. Revising one in place is not new.
pub const PENDING_PER_DIAGRAM: usize = 50;
pub const PENDING_TOTAL: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProposalStatus {
    /// Awaiting review; revisable in place.
    Pending,
    /// The person clicked Accept: durably recorded before the document commit is attempted, so a
    /// crash between the click and the terminal `Accepted` record is recoverable rather than guessed at.
    Accepting,
    /// Applied to the document. Terminal — never reactivated, including by an undo of the change.
    Accepted,
    /// Reviewed and declined. Terminal.
    Rejected,
    /// Cleared without review (housekeeping). Terminal, and distinct from `Rejected` so a caller can
    /// tell "never reviewed" from "reviewed and declined".
    Dismissed,
    /// The agent reported no architectural impact (empty `ops`). Terminal from the moment it's created —
    /// there is nothing to accept or reject.
    Informational,
    /// Restart recovery couldn't tell whether the change committed before a crash, and the evidence
    /// doesn't match the proposal's own ids cleanly enough to say either way. Terminal-ish: not reapplied,
    /// not silently reopened as `Pending` — a person must look at the document and then dismiss it.
    AcceptFailed,
}

impl ProposalStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, ProposalStatus::Pending | ProposalStatus::Accepting)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    /// 1 at creation, +1 on every revise-in-place. Accept must be checked against the exact version
    /// that was on screen when the person clicked it, so a revision racing the click is caught.
    pub version: u32,
    pub diagram_id: String,
    /// The `DepthPath` (owner-node-id chain) the ops target; `[]` is the document root.
    pub path: Vec<String>,
    pub status: ProposalStatus,
    /// `expectedRevision` at submit time, or at the most recent revise.
    pub base_revision: String,
    pub ops: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Value>,
    /// The dry-run's counts at submit/last-revise time — `get_proposal`/`list_proposals` read this
    /// back rather than re-running a dry-run; only the native review UI (Phase 4b) recomputes live.
    #[serde(default)]
    pub counts: Value,
    /// Snapshots of every id the ops reference or target, captured at submit/revise time — the
    /// conflict-detection mechanism, distinct from `base_revision`-vs-live staleness. See broker.rs.
    #[serde(default)]
    pub preconditions: Value,
    pub summary: String,
    #[serde(default)]
    pub rationale: String,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<Value>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
}

pub struct Proposals {
    file: PathBuf,
    entries: HashMap<String, Proposal>,
    appended: usize,
}

impl Proposals {
    /// Opens (creating if needed) the journal in `dir`, dropping resolved proposals that have aged out
    /// and compacting.
    pub fn open(dir: &Path, now: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let file = dir.join("proposals.jsonl");
        let mut store = Self {
            file,
            entries: HashMap::new(),
            appended: 0,
        };
        let tidy = store.load()?;
        let loaded = store.entries.len();
        store.evict(now);
        // Rewritten only when that changes something: an fsynced rewrite on every launch, before the
        // window shows, for a journal that is already exactly its live entries, is wasted start-up time.
        if !tidy || store.entries.len() != loaded {
            store.compact()?;
        }
        Ok(store)
    }

    /// Reads the journal. True when it holds exactly one complete line per live entry — nothing
    /// superseded, torn or unreadable — so rewriting it would change nothing.
    fn load(&mut self) -> io::Result<bool> {
        let file = match File::open(&self.file) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(e),
        };
        let mut reader = BufReader::new(file);
        let (mut lines, mut clean) = (0, true);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => lines += 1,
                Err(_) => {
                    clean = false;
                    break;
                }
            }
            // A line without its newline is one a crash cut short. It must not be left in place even
            // when it parses: the next record appended would join it on the same line.
            clean &= line.ends_with('\n');
            // A line that doesn't parse is the one a crash cut short; everything before it stands.
            match serde_json::from_str::<Proposal>(line.trim_end()) {
                Ok(proposal) => {
                    self.entries.insert(proposal.id.clone(), proposal);
                }
                Err(_) => clean = false,
            }
        }
        Ok(clean && lines == self.entries.len())
    }

    pub fn get(&self, id: &str) -> Option<&Proposal> {
        self.entries.get(id)
    }

    pub fn list(&self, diagram_id: Option<&str>) -> Vec<&Proposal> {
        let mut out: Vec<&Proposal> = self
            .entries
            .values()
            .filter(|p| diagram_id.is_none_or(|d| p.diagram_id == d))
            .collect();
        out.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
        out
    }

    /// Why another waiting proposal for `diagram_id` can't be added, if it can't.
    pub fn pending_limit(&self, diagram_id: &str) -> Option<String> {
        let (mut here, mut total) = (0, 0);
        for p in self.entries.values().filter(|p| !p.status.is_terminal()) {
            total += 1;
            if p.diagram_id == diagram_id {
                here += 1;
            }
        }
        if here >= PENDING_PER_DIAGRAM {
            Some(format!(
                "This diagram already has {PENDING_PER_DIAGRAM} proposals waiting for review."
            ))
        } else if total >= PENDING_TOTAL {
            Some(format!(
                "There are already {PENDING_TOTAL} proposals waiting for review."
            ))
        } else {
            None
        }
    }

    /// Writes `proposal` through to disk before returning — inserted if its id is new, overwritten in
    /// place otherwise (a revise, or a status transition). The caller decides whether that's allowed.
    pub fn put(&mut self, proposal: Proposal) -> io::Result<()> {
        let mut line = serde_json::to_vec(&proposal).map_err(io::Error::other)?;
        line.push(b'\n');
        let mut file = private(OpenOptions::new().create(true).append(true)).open(&self.file)?;
        file.write_all(&line)?;
        file.sync_data()?;
        self.entries.insert(proposal.id.clone(), proposal);
        self.appended += 1;
        if self.appended >= COMPACT_AFTER {
            self.compact()?;
        }
        Ok(())
    }

    fn evict(&mut self, now: u64) {
        self.entries.retain(|_, p| {
            if !p.status.is_terminal() {
                return true;
            }
            let age = now.saturating_sub(p.resolved_at.unwrap_or(p.updated_at));
            age <= RESOLVED_RETENTION_MS
        });
        let mut resolved: Vec<(u64, String)> = self
            .entries
            .values()
            .filter(|p| p.status.is_terminal())
            .map(|p| (p.updated_at, p.id.clone()))
            .collect();
        if resolved.len() > RESOLVED_CAP {
            resolved.sort();
            for (_, id) in resolved.iter().take(resolved.len() - RESOLVED_CAP) {
                self.entries.remove(id);
            }
        }
    }

    /// Rewrites the journal to exactly the live entries. Temp file, flush, rename: a crash leaves either
    /// the old journal or the new one, never a mix.
    fn compact(&mut self) -> io::Result<()> {
        let mut entries: Vec<&Proposal> = self.entries.values().collect();
        entries.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let temp = self.file.with_extension("jsonl.tmp");
        {
            let mut out =
                private(OpenOptions::new().write(true).create(true).truncate(true)).open(&temp)?;
            for proposal in entries {
                let mut line = serde_json::to_vec(proposal).map_err(io::Error::other)?;
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

/// Diagram ids, ops and rationale are the person's business: readable by this account only.
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

    fn proposal(id: &str, status: ProposalStatus, updated_at: u64) -> Proposal {
        Proposal {
            id: id.into(),
            version: 1,
            diagram_id: "d_1".into(),
            path: vec![],
            status,
            base_revision: "o:1.1".into(),
            ops: json!([]),
            layout: None,
            scope: None,
            counts: json!({}),
            preconditions: json!({}),
            summary: "s".into(),
            rationale: String::new(),
            assumptions: vec![],
            open_questions: vec![],
            source_ref: None,
            created_at: updated_at,
            updated_at,
            resolved_at: if status.is_terminal() {
                Some(updated_at)
            } else {
                None
            },
        }
    }

    #[test]
    fn a_proposal_is_stored_and_revised_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Proposals::open(dir.path(), 1).unwrap();
        store
            .put(proposal("p1", ProposalStatus::Pending, 1))
            .unwrap();
        assert_eq!(store.get("p1").unwrap().version, 1);
        let mut revised = proposal("p1", ProposalStatus::Pending, 2);
        revised.version = 2;
        store.put(revised).unwrap();
        assert_eq!(store.get("p1").unwrap().version, 2);
        assert_eq!(store.list(None).len(), 1);
    }

    #[test]
    fn survives_a_restart_and_ignores_a_torn_last_line() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut store = Proposals::open(dir.path(), 1).unwrap();
            store
                .put(proposal("p1", ProposalStatus::Pending, 1))
                .unwrap();
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(dir.path().join("proposals.jsonl"))
            .unwrap();
        file.write_all(b"{\"id\":\"p2\",\"status\":\"pen").unwrap();
        drop(file);

        let store = Proposals::open(dir.path(), 2).unwrap();
        assert!(store.get("p1").is_some());
        assert!(store.get("p2").is_none());
    }

    #[test]
    fn pending_and_accepting_never_age_out() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut store = Proposals::open(dir.path(), 0).unwrap();
            store
                .put(proposal("pending", ProposalStatus::Pending, 0))
                .unwrap();
            store
                .put(proposal("accepting", ProposalStatus::Accepting, 0))
                .unwrap();
            store
                .put(proposal("accepted", ProposalStatus::Accepted, 0))
                .unwrap();
        }
        let store = Proposals::open(dir.path(), RESOLVED_RETENTION_MS * 10).unwrap();
        assert!(store.get("pending").is_some());
        assert!(store.get("accepting").is_some());
        assert!(store.get("accepted").is_none(), "terminal, aged out");
    }

    #[test]
    fn the_resolved_cap_drops_the_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Proposals::open(dir.path(), 0).unwrap();
        for i in 0..(RESOLVED_CAP as u64 + 3) {
            store
                .put(proposal(&format!("p{i}"), ProposalStatus::Rejected, i))
                .unwrap();
        }
        drop(store);
        let store = Proposals::open(dir.path(), RESOLVED_CAP as u64 + 3).unwrap();
        assert!(store.get("p0").is_none());
        assert!(store.get("p2").is_none());
        assert!(store.get("p3").is_some());
    }

    #[test]
    fn waiting_proposals_are_capped_per_diagram_and_in_total() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Proposals::open(dir.path(), 1).unwrap();
        for i in 0..PENDING_PER_DIAGRAM {
            store
                .put(proposal(&format!("p{i}"), ProposalStatus::Pending, 1))
                .unwrap();
        }
        // Resolved ones don't count.
        store
            .put(proposal("done", ProposalStatus::Accepted, 1))
            .unwrap();
        assert!(store.pending_limit("d_1").is_some());
        assert!(store.pending_limit("d_2").is_none());
        let mut accepting = proposal("p0", ProposalStatus::Rejected, 2);
        accepting.version = 2;
        store.put(accepting).unwrap();
        assert!(store.pending_limit("d_1").is_none());

        let mut others = 0;
        while store
            .entries
            .values()
            .filter(|p| !p.status.is_terminal())
            .count()
            < PENDING_TOTAL
        {
            let mut p = proposal(&format!("o{others}"), ProposalStatus::Accepting, 1);
            p.diagram_id = format!("d_other_{}", others % 20);
            store.entries.insert(p.id.clone(), p);
            others += 1;
        }
        assert!(store.pending_limit("d_new").unwrap().contains("500"));
    }

    #[test]
    fn list_filters_by_diagram_and_orders_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Proposals::open(dir.path(), 0).unwrap();
        let mut other = proposal("other-diagram", ProposalStatus::Pending, 5);
        other.diagram_id = "d_2".into();
        store
            .put(proposal("older", ProposalStatus::Pending, 1))
            .unwrap();
        store
            .put(proposal("newer", ProposalStatus::Pending, 2))
            .unwrap();
        store.put(other).unwrap();
        let listed = store.list(Some("d_1"));
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "newer");
    }
}
