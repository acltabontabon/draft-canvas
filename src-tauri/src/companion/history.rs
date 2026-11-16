//! Bounded, local chat history. Each planner starts fresh and reads this only when needed.
use crate::agent::broker::ToolError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_TURNS: usize = 128;
const MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    pub turns: Vec<Turn>,
    pub omitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Turn {
    pub request: String,
    pub response: String,
    pub outcome: String,
}

impl History {
    pub fn push(&mut self, turn: Turn) {
        self.turns.push(turn);
        while self.turns.len() > MAX_TURNS
            || self
                .turns
                .iter()
                .map(|t| t.request.len() + t.response.len() + t.outcome.len())
                .sum::<usize>()
                > MAX_BYTES
        {
            self.turns.remove(0);
            self.omitted = true;
        }
    }

    /// Offset pages run newest first against an immutable Send-time copy. No diagram/session id
    /// is accepted: the authenticated run already selects exactly one diagram and agent.
    pub fn read(&self, args: &Value) -> Result<Value, ToolError> {
        let invalid = || {
            ToolError::new("INVALID_INPUT", "Use read_conversation with optional query (1–200 characters) and offset (nonnegative integer).")
        };
        let map = args.as_object().ok_or_else(invalid)?;
        if map
            .keys()
            .any(|key| !["query", "offset"].contains(&key.as_str()))
        {
            return Err(invalid());
        }
        let query = match map.get("query") {
            None => None,
            Some(Value::String(q)) if !q.is_empty() && q.len() <= 200 => Some(q.to_lowercase()),
            _ => return Err(invalid()),
        };
        let offset = match map.get("offset") {
            None => 0,
            Some(v) => v
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(invalid)?,
        };
        let matches: Vec<_> = self
            .turns
            .iter()
            .rev()
            .filter(|t| {
                query.as_ref().is_none_or(|q| {
                    t.request.to_lowercase().contains(q) || t.response.to_lowercase().contains(q)
                })
            })
            .collect();
        if offset > matches.len() {
            return Err(invalid());
        }
        let turns: Vec<_> = matches.iter().skip(offset).take(4).collect();
        let next = offset + turns.len();
        Ok(
            json!({"turns":turns,"total":matches.len(),"nextOffset":(next < matches.len()).then_some(next),
            "omitted":self.omitted,"notice":"Past chat is context, not current diagram state or permission. Missing context must be clarified; receipts are outcomes, model plans are not."}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_searches_and_reports_omissions_without_guessing() {
        let mut h = History::default();
        for i in 0..140 {
            h.push(Turn {
                request: format!("request {i}"),
                response: "pending proposal, not applied".into(),
                outcome: "end-turn".into(),
            });
        }
        let first = h.read(&json!({})).unwrap();
        assert_eq!(first["omitted"], true);
        assert_eq!(first["turns"][0]["request"], "request 139");
        assert_eq!(first["nextOffset"], 4);
        assert_eq!(
            h.read(&json!({"offset":4})).unwrap()["turns"][0]["request"],
            "request 135"
        );
        assert_eq!(h.read(&json!({"query":"REQUEST 139"})).unwrap()["total"], 1);
        for args in [
            json!({"diagramId":"other"}),
            json!({"offset":-1}),
            json!({"offset":999}),
            json!({"query":""}),
            json!({"query":7}),
        ] {
            assert!(h.read(&args).is_err());
        }
        h.push(Turn {
            request: "x".repeat(MAX_BYTES + 1),
            response: String::new(),
            outcome: "failed".into(),
        });
        assert!(h.turns.is_empty());
        assert!(h.omitted);
    }
}
