//! What the page and the companion say to each other about a run. Shaped like the Agent Client
//! Protocol (a prompt, a stream of session updates, cancel, a stop reason) so a backend that speaks
//! ACP natively can produce the same events later. Nothing here speaks ACP itself.

use serde::{Deserialize, Serialize};

/// The coding agents the companion can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
}

impl AgentKind {
    /// Every agent the companion knows how to run, in the order the page offers them.
    pub const ALL: [AgentKind; 2] = [AgentKind::ClaudeCode, AgentKind::Codex];

    /// The agent's own name, as the person knows it.
    pub fn name(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }
}

/// What was selected when the person pressed Send, by id. The agent passes these as `scope`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub nodes: Vec<String>,
    pub edges: Vec<String>,
}

/// How a change reaches the diagram: reviewed first, or applied with Undo as the way back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyMode {
    Proposal,
    Direct,
}

/// One turn the person typed (ACP `session/prompt`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptRequest {
    /// Made by the page, so events that arrive before `companion_send` returns are already its.
    pub run_id: String,
    pub diagram_id: String,
    /// The person's words, passed on unchanged.
    pub text: String,
    pub selection: Option<Selection>,
    /// The room the person is in, outermost first; empty at the root.
    pub room: Vec<String>,
    pub agent: AgentKind,
    pub mode: ApplyMode,
    /// The page's word that the diagram is as it was when this conversation's last turn was sent,
    /// so the agent can skip reading it again (a read is a round trip, and its whole answer). False
    /// whenever the page can't be sure.
    #[serde(default)]
    #[ts(optional)]
    pub unchanged: Option<bool>,
    /// The view as read_diagram would answer it, read by the page as the turn was sent, so the agent's
    /// first call needn't be a read. JSON text; left out when it was too big or couldn't be read.
    #[serde(default)]
    #[ts(optional)]
    pub snapshot: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum ToolStatus {
    InProgress,
    Completed,
    Failed,
}

/// Why a run ended (ACP's stop reasons, plus a failure worded for the person).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StopReason {
    EndTurn,
    Cancelled,
    MaxTurns,
    Refusal,
    Failed { message: String },
}

/// What happened in a run (ACP `session/update`). Sent to the page as it happens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum RunEvent {
    /// The agent's own session id: the next turn on this diagram resumes it.
    Started { session: String },
    /// Part of the agent's reply.
    MessageChunk { text: String },
    /// A tool call began. `tool` is the Draft Canvas tool name (`update_diagram`), or the agent's own
    /// name for anything else.
    ToolCall {
        id: String,
        tool: String,
        status: ToolStatus,
    },
    ToolCallUpdate {
        id: String,
        status: ToolStatus,
        error: Option<String>,
    },
    /// Always the last event of a run.
    Stopped {
        reason: StopReason,
        summary: Option<String>,
        /// What the turn cost in millionths of a dollar, as the agent reported it.
        #[ts(type = "number | null")]
        cost_micro_usd: Option<u64>,
        /// The tokens the turn used, as the agent reported them.
        usage: Option<Usage>,
    },
}

/// What a turn used, in tokens. Most of it is what the agent reads in on every turn (its instructions,
/// the tools, the diagram), not the words exchanged: `input` counts all of that, and `cached` is the
/// part of `input` the provider served from its cache, which costs less and counts for less against a
/// subscription's limits. A turn's total is `input + output`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub cached: u64,
    #[ts(type = "number")]
    pub output: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum Availability {
    Installed,
    Missing,
    /// Installed, but older than the version the companion was tested with.
    TooOld,
}

/// What the agent says about its sign-in. A hint only: a sandboxed or GUI process may not see the
/// keychain the agent signs in with, so a run is never refused on this.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub logged_in: Option<bool>,
    /// The agent's own word for how it signs in (`claude.ai`, `api_key`, …).
    pub method: Option<String>,
    /// Where the agent keeps its transcripts, for the person to see.
    pub transcripts: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub agent: AgentKind,
    /// How the companion names it: the page has no list of agents of its own.
    pub name: String,
    pub availability: Availability,
    pub version: Option<String>,
    pub sign_in: SignIn,
}

/// A run still going, with what it has said so far: a reloaded page rebuilds its conversation from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run_id: String,
    pub diagram_id: String,
    pub agent: AgentKind,
    /// What the person typed.
    pub prompt: String,
    pub events: Vec<RunEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_are_spelled_the_way_the_page_switches_on_them() {
        let stopped = RunEvent::Stopped {
            reason: StopReason::Failed {
                message: "No".into(),
            },
            summary: None,
            cost_micro_usd: Some(1200),
            usage: Some(Usage {
                input: 48_171,
                cached: 46_208,
                output: 4,
            }),
        };
        assert_eq!(
            serde_json::to_value(stopped).unwrap(),
            json!({"type": "stopped", "reason": {"kind": "failed", "message": "No"}, "summary": null, "costMicroUsd": 1200, "usage": {"input": 48_171, "cached": 46_208, "output": 4}})
        );
        let call = RunEvent::ToolCall {
            id: "t1".into(),
            tool: "read_diagram".into(),
            status: ToolStatus::InProgress,
        };
        assert_eq!(
            serde_json::to_value(call).unwrap(),
            json!({"type": "tool-call", "id": "t1", "tool": "read_diagram", "status": "in-progress"})
        );
    }

    #[test]
    fn a_prompt_request_reads_the_page_spelling_and_refuses_extra_fields() {
        let request: PromptRequest = serde_json::from_value(json!({
            "runId": "r", "diagramId": "d_1", "text": "Add a cache",
            "selection": {"nodes": ["n1"], "edges": []}, "room": [],
            "agent": "claude-code", "mode": "proposal",
        }))
        .unwrap();
        assert_eq!(request.agent, AgentKind::ClaudeCode);
        assert_eq!(request.selection.unwrap().nodes, vec!["n1"]);
        let extra = serde_json::from_value::<PromptRequest>(json!({
            "runId": "r", "diagramId": "d_1", "text": "x", "selection": null, "room": [],
            "agent": "claude-code", "mode": "direct", "cwd": "/",
        }));
        assert!(extra.is_err());
    }
}

/// How long the person let a diagram's runs read its project folder: until the app quits, or always.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
pub enum CodeGrant {
    Now,
    Always,
}

/// The project folder a diagram's code is in, as Nodi asks to read it: never its full path, only
/// what the person would recognise it by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct CodeFolder {
    pub name: String,
    pub display_path: String,
    /// Whether runs may read it already, and for how long; absent until the person says.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub allowed: Option<CodeGrant>,
}
