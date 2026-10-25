//! Which agent conversation each diagram's companion continues: (diagram, agent) → the agent's own session
//! id, so a follow-up ("now make it async") resumes with its context. Kept in the app's data folder,
//! never in the diagram. Forgetting an entry starts a new conversation; it does not delete the agent's
//! transcript, which is the agent's own (Claude Code keeps it under `~/.claude/projects/`).

use super::protocol::AgentKind;
use crate::docio::write_private;
use crate::errors::{AppError, Subject};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FILE: &str = "sessions.json";
/// Diagrams remembered at most; the least recently used goes first.
pub const CAP: usize = 200;
/// A conversation not continued for this long starts afresh.
pub const MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    agent: AgentKind,
    session: String,
    updated_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    v: u32,
    entries: BTreeMap<String, Vec<Entry>>,
}

#[derive(Deserialize)]
struct LegacyStored {
    v: u32,
    entries: BTreeMap<String, Entry>,
}

pub struct Sessions {
    path: PathBuf,
    entries: BTreeMap<String, Vec<Entry>>,
}

impl Sessions {
    /// What is on disk. A missing or unreadable file is an empty list: losing it only means the next
    /// turn starts a new conversation.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(FILE);
        let entries = std::fs::read(&path)
            .ok()
            .and_then(|bytes| {
                if let Ok(stored) = serde_json::from_slice::<Stored>(&bytes) {
                    return (stored.v == 2).then_some(stored.entries);
                }
                // Keep the agent's existing session when upgrading the one-session-per-diagram file.
                serde_json::from_slice::<LegacyStored>(&bytes)
                    .ok()
                    .filter(|stored| stored.v == 1)
                    .map(|stored| {
                        stored
                            .entries
                            .into_iter()
                            .map(|(id, entry)| (id, vec![entry]))
                            .collect()
                    })
            })
            .unwrap_or_default();
        Self { path, entries }
    }

    /// The session to resume for `diagram` with `agent`, if one is recent enough.
    pub fn get(&self, diagram: &str, agent: AgentKind, now: u64) -> Option<String> {
        self.entries
            .get(diagram)
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|e| e.agent == agent && now.saturating_sub(e.updated_at) < MAX_AGE_MS)
            })
            .map(|e| e.session.clone())
    }

    pub fn remember(
        &mut self,
        diagram: &str,
        agent: AgentKind,
        session: &str,
        now: u64,
    ) -> Result<(), AppError> {
        let entries = self.entries.entry(diagram.to_string()).or_default();
        entries.retain(|entry| entry.agent != agent);
        entries.push(Entry {
            agent,
            session: session.to_string(),
            updated_at: now,
        });
        self.entries.retain(|_, entries| {
            entries.retain(|e| now.saturating_sub(e.updated_at) < MAX_AGE_MS);
            !entries.is_empty()
        });
        while self.entries.len() > CAP {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entries)| entries.iter().map(|e| e.updated_at).max().unwrap_or(0))
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => self.entries.remove(&id),
                None => break,
            };
        }
        self.save()
    }

    pub fn forget(&mut self, diagram: &str, agent: Option<AgentKind>) -> Result<(), AppError> {
        if let Some(entries) = self.entries.get_mut(diagram) {
            entries.retain(|entry| agent.is_some_and(|agent| entry.agent != agent));
            if entries.is_empty() {
                self.entries.remove(diagram);
            }
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<(), AppError> {
        let stored = Stored {
            v: 2,
            entries: self.entries.clone(),
        };
        let json = serde_json::to_vec_pretty(&stored).map_err(|_| AppError::internal())?;
        write_private(&self.path, &json, Subject::Preferences)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const DAY: u64 = 24 * 60 * 60 * 1000;

    #[test]
    fn a_remembered_session_is_resumed_and_survives_a_restart() {
        let dir = tempdir().unwrap();
        let mut sessions = Sessions::open(dir.path());
        assert_eq!(sessions.get("d_1", AgentKind::ClaudeCode, 0), None);
        sessions
            .remember("d_1", AgentKind::ClaudeCode, "s-1", 1_000)
            .unwrap();
        let reopened = Sessions::open(dir.path());
        assert_eq!(
            reopened.get("d_1", AgentKind::ClaudeCode, 2_000).as_deref(),
            Some("s-1")
        );
    }

    #[test]
    fn each_agent_keeps_its_session_and_forgetting_only_resets_the_chosen_agent() {
        let dir = tempdir().unwrap();
        let mut sessions = Sessions::open(dir.path());
        sessions
            .remember("d_1", AgentKind::ClaudeCode, "claude", 1_000)
            .unwrap();
        sessions
            .remember("d_1", AgentKind::Codex, "codex", 2_000)
            .unwrap();
        let mut reopened = Sessions::open(dir.path());
        assert_eq!(
            reopened.get("d_1", AgentKind::ClaudeCode, 3_000).as_deref(),
            Some("claude")
        );
        assert_eq!(
            reopened.get("d_1", AgentKind::Codex, 3_000).as_deref(),
            Some("codex")
        );
        reopened.forget("d_1", Some(AgentKind::Codex)).unwrap();
        let reopened = Sessions::open(dir.path());
        assert_eq!(
            reopened.get("d_1", AgentKind::ClaudeCode, 3_000).as_deref(),
            Some("claude")
        );
        assert!(reopened.get("d_1", AgentKind::Codex, 3_000).is_none());
    }

    #[test]
    fn legacy_sessions_survive_upgrade_and_another_agent_run() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), br#"{"v":1,"entries":{"d_1":{"agent":"claude-code","session":"legacy","updatedAt":1000}}}"#).unwrap();
        let mut sessions = Sessions::open(dir.path());
        assert_eq!(
            sessions.get("d_1", AgentKind::ClaudeCode, 2_000).as_deref(),
            Some("legacy")
        );
        sessions
            .remember("d_1", AgentKind::Codex, "new", 2_000)
            .unwrap();
        let reopened = Sessions::open(dir.path());
        assert_eq!(
            reopened.get("d_1", AgentKind::ClaudeCode, 3_000).as_deref(),
            Some("legacy")
        );
        assert_eq!(
            reopened.get("d_1", AgentKind::Codex, 3_000).as_deref(),
            Some("new")
        );
    }

    #[test]
    fn an_old_conversation_starts_afresh() {
        let dir = tempdir().unwrap();
        let mut sessions = Sessions::open(dir.path());
        sessions
            .remember("d_1", AgentKind::ClaudeCode, "s-1", DAY)
            .unwrap();
        assert!(sessions
            .get("d_1", AgentKind::ClaudeCode, DAY + MAX_AGE_MS - 1)
            .is_some());
        assert!(sessions
            .get("d_1", AgentKind::ClaudeCode, DAY + MAX_AGE_MS)
            .is_none());
    }

    #[test]
    fn the_least_recently_used_diagram_goes_past_the_cap() {
        let dir = tempdir().unwrap();
        let mut sessions = Sessions::open(dir.path());
        for i in 0..=CAP as u64 {
            sessions
                .remember(&format!("d_{i}"), AgentKind::ClaudeCode, "s", 1_000 + i)
                .unwrap();
        }
        assert!(sessions.get("d_0", AgentKind::ClaudeCode, 2_000).is_none());
        assert!(sessions
            .get(&format!("d_{CAP}"), AgentKind::ClaudeCode, 2_000)
            .is_some());
        assert_eq!(Sessions::open(dir.path()).entries.len(), CAP);
    }

    #[test]
    fn forgetting_starts_a_new_conversation_and_a_broken_file_is_empty() {
        let dir = tempdir().unwrap();
        let mut sessions = Sessions::open(dir.path());
        sessions
            .remember("d_1", AgentKind::ClaudeCode, "s-1", 1)
            .unwrap();
        sessions.forget("d_1", None).unwrap();
        assert!(Sessions::open(dir.path())
            .get("d_1", AgentKind::ClaudeCode, 2)
            .is_none());
        std::fs::write(dir.path().join(FILE), b"{not json").unwrap();
        assert!(Sessions::open(dir.path()).entries.is_empty());
    }
}
