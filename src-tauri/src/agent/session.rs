//! What one agent session has worked on here, so `list_diagrams` can remind it after its own context
//! was trimmed — never a "last diagram" shared between agents.
//!
//! A session is one running sidecar: it makes up a nonce when it starts and sends it in every hello,
//! so a reconnect after the app restarted its listener is still the same session. Memory only, and
//! bounded: an app restart forgets every session (the agent's own record of the ids it was given is
//! the authority; this is a courtesy), and the least recently heard-from session is dropped first.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

const SESSIONS: usize = 64;
const PER_SESSION: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub diagram_id: String,
    pub title: String,
    pub revision: String,
}

#[derive(Default)]
pub struct Sessions {
    /// Most recently heard-from last; each session's diagrams most recent first.
    inner: Mutex<VecDeque<(String, VecDeque<Recent>)>>,
}

impl Sessions {
    /// Records that `session` created or changed a diagram.
    pub fn note(&self, session: &str, recent: Recent) {
        if session.is_empty() {
            return;
        }
        let mut all = crate::util::lock(&self.inner);
        let mut mine = match all.iter().position(|(s, _)| s == session) {
            Some(at) => all.remove(at).map(|(_, r)| r).unwrap_or_default(),
            None => VecDeque::new(),
        };
        mine.retain(|r| r.diagram_id != recent.diagram_id);
        mine.push_front(recent);
        mine.truncate(PER_SESSION);
        all.push_back((session.to_string(), mine));
        while all.len() > SESSIONS {
            all.pop_front();
        }
    }

    pub fn recent(&self, session: &str) -> Vec<Recent> {
        crate::util::lock(&self.inner)
            .iter()
            .find(|(s, _)| s == session)
            .map(|(_, r)| r.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recent(id: &str) -> Recent {
        Recent {
            diagram_id: id.into(),
            title: format!("T {id}"),
            revision: "f:1".into(),
        }
    }

    #[test]
    fn a_session_sees_only_its_own_diagrams_most_recent_first() {
        let sessions = Sessions::default();
        sessions.note("a", recent("d1"));
        sessions.note("b", recent("d2"));
        sessions.note("a", recent("d3"));
        sessions.note("a", recent("d1"));
        let ids = |s: &str| {
            sessions
                .recent(s)
                .into_iter()
                .map(|r| r.diagram_id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("a"), ["d1", "d3"]);
        assert_eq!(ids("b"), ["d2"]);
        assert!(ids("c").is_empty());
        assert!(ids("").is_empty());
    }

    #[test]
    fn memory_is_bounded() {
        let sessions = Sessions::default();
        for i in 0..(SESSIONS + 10) {
            sessions.note(&format!("s{i}"), recent("d"));
        }
        for i in 0..(PER_SESSION + 3) {
            sessions.note("last", recent(&format!("d{i}")));
        }
        assert!(
            sessions.recent("s0").is_empty(),
            "the oldest session was dropped"
        );
        assert_eq!(sessions.recent("last").len(), PER_SESSION);
        sessions.note("", recent("x"));
        assert!(sessions.recent("").is_empty(), "no anonymous session");
    }
}
