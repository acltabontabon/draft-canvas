//! The agent plans an edit as its final structured response. Only after a successful CLI exit
//! does the host authorize that exact request and run it through the ordinary native broker.
use super::protocol::{ApplyMode, PromptRequest, RunEvent, StopReason};
use super::Parser;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

pub const SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"properties":{"tool":{"type":"string","enum":["reply","rename_element","update_diagram","submit_proposal"]},"args":{"type":"string","description":"JSON object of operation arguments; {} for reply"},"text":{"type":"string","description":"Answer for reply; optional explanation for an edit, never a claim it was applied or saved"}},"required":["tool","args","text"]}"#;
pub const INSTRUCTIONS: &str = "Return your final answer using the response schema. For an edit, set tool to rename_element, update_diagram, or submit_proposal and args to its JSON arguments. This is a plan, not an applied change: do NOT call mutation tools through MCP. The host applies the final edit after your turn ends and confirms from its receipt. For a simple direct rename with both labels supplied, return rename_element immediately: no tool discovery, read or preview is needed. Reads, help and previews remain available for other tasks. Batch all requested changes into one update/proposal. Preserve the requested review mode. The host supplies diagramId, requestId and selection scope. A rename needs only from and to (plus view when needed); other updates still need expectedRevision. For advice or clarification use tool=reply, args={}, text=your answer. For edits text may explain your reasoning, but leave outcome confirmation to the host.";

type Authorize = Arc<dyn Fn(&str, &Value) -> Result<(), String> + Send + Sync>;

pub struct Finalizer {
    pub sidecar: PathBuf,
    pub env: Vec<(&'static str, String)>,
    pub request: PromptRequest,
    pub authorize: Authorize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub tool: String,
    pub args: String,
    pub text: String,
}

impl Decision {
    pub fn edit(&self, request: &PromptRequest) -> Result<(String, Value), String> {
        let invalid = || "The agent returned an invalid edit. Nothing was applied.".to_string();
        if self.args.len() > 256_000 || self.text.len() > 20_000 {
            return Err(invalid());
        }
        let mut args: Value = serde_json::from_str(&self.args).map_err(|_| invalid())?;
        let map = args.as_object_mut().ok_or_else(invalid)?;
        let tool =
            match self.tool.as_str() {
                "rename_element" if request.mode == ApplyMode::Direct => {
                    if map.keys().any(|key| {
                        !["from", "to", "diagramId", "requestId", "view", "scope"]
                            .contains(&key.as_str())
                    }) {
                        return Err(invalid());
                    }
                    let from = map
                        .remove("from")
                        .filter(Value::is_string)
                        .ok_or_else(invalid)?;
                    let to = map
                        .remove("to")
                        .filter(Value::is_string)
                        .ok_or_else(invalid)?;
                    map.insert("rename".into(), json!({"from":from,"to":to}));
                    "update_diagram"
                }
                "update_diagram" if request.mode == ApplyMode::Direct => "update_diagram",
                "submit_proposal" => "submit_proposal",
                _ => return Err(
                    "The agent's edit does not match this turn's review mode. Nothing was applied."
                        .into(),
                ),
            };
        if map
            .get("diagramId")
            .is_some_and(|id| id != &json!(request.diagram_id))
        {
            return Err(invalid());
        }
        map.insert("diagramId".into(), json!(request.diagram_id));
        map.insert("requestId".into(), json!(request.run_id));
        if self.tool != "rename_element" || !request.room.is_empty() {
            map.entry("view")
                .or_insert_with(|| json!({"inside":request.room}));
        }
        // The model cannot broaden the selection captured at Send, even when the live selection moves.
        if let Some(selection) = request
            .selection
            .as_ref()
            .filter(|s| !s.nodes.is_empty() || !s.edges.is_empty())
        {
            map.insert("scope".into(), json!(selection));
        }
        Ok((tool.into(), args))
    }
}

pub struct Planner {
    inner: Box<dyn Parser>,
    pub decision: Option<Decision>,
    pub stopped: Option<RunEvent>,
    output_tools: HashSet<String>,
}

impl Planner {
    pub fn new(inner: Box<dyn Parser>) -> Self {
        Self {
            inner,
            decision: None,
            stopped: None,
            output_tools: HashSet::new(),
        }
    }

    pub fn parse(&mut self, line: &str) -> Vec<RunEvent> {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            // Codex emits a whole final message; Claude carries the schema result separately.
            let result =
                if value["type"] == "item.completed" && value["item"]["type"] == "agent_message" {
                    value["item"]["text"]
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                } else if value["type"] == "result" {
                    value.get("structured_output").cloned()
                } else {
                    None
                };
            if value["type"] == "result"
                || (value["type"] == "item.completed" && value["item"]["type"] == "agent_message")
            {
                self.decision = result.and_then(|result| serde_json::from_value(result).ok());
            }
        }
        self.inner
            .parse(line)
            .into_iter()
            .filter_map(|mut event| match event {
                RunEvent::MessageChunk { .. } => None,
                RunEvent::Stopped {
                    ref mut summary, ..
                } => {
                    *summary = None;
                    self.stopped = Some(event);
                    None
                }
                RunEvent::ToolCall { id, tool, .. } if tool == "StructuredOutput" => {
                    self.output_tools.insert(id);
                    None
                }
                RunEvent::ToolCallUpdate { ref id, .. } if self.output_tools.contains(id) => None,
                other => Some(other),
            })
            .collect()
    }

    pub fn succeeded(&self) -> bool {
        matches!(
            self.stopped,
            Some(RunEvent::Stopped {
                reason: StopReason::EndTurn,
                ..
            })
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::{
        backend,
        protocol::{AgentKind, Selection},
    };

    pub fn request() -> PromptRequest {
        PromptRequest {
            run_id: "host-request".into(),
            diagram_id: "d_1".into(),
            text: "Could you call the API Gateway instead?".into(),
            agent: AgentKind::Codex,
            mode: ApplyMode::Direct,
            room: vec!["system".into()],
            selection: Some(Selection {
                nodes: vec!["api".into()],
                edges: vec![],
            }),
            unchanged: None,
            snapshot: None,
        }
    }

    #[test]
    fn model_decisions_keep_revision_room_and_host_scope() {
        let d = Decision { tool: "update_diagram".into(), args: json!({"requestId":"invented","expectedRevision":"o:4","ops":[{"op":"update","id":"api","set":{"label":"Gateway"}}],"scope":{"nodes":["outside"]}}).to_string(), text: String::new() };
        let (tool, args) = d.edit(&request()).unwrap();
        assert_eq!(tool, "update_diagram");
        assert_eq!(args["requestId"], "host-request");
        assert_eq!(args["expectedRevision"], "o:4");
        assert_eq!(args["view"], json!({"inside":["system"]}));
        assert_eq!(args["scope"], json!({"nodes":["api"],"edges":[]}));
    }

    #[test]
    fn rename_is_a_model_decision_not_a_text_pattern_and_cannot_bypass_review() {
        let d = Decision {
            tool: "rename_element".into(),
            args: json!({"from":"API","to":"Gateway"}).to_string(),
            text: String::new(),
        };
        assert_eq!(
            d.edit(&request()).unwrap().1["rename"],
            json!({"from":"API","to":"Gateway"})
        );
        let mut review = request();
        review.mode = ApplyMode::Proposal;
        assert!(d.edit(&review).is_err());
        let proposal = Decision {
            tool: "submit_proposal".into(),
            ..d
        };
        assert!(proposal.edit(&review).is_ok()); // The complete proposal contract is validated by the broker/page.
        for (tool, args) in [
            ("create_diagram", "{}"),
            ("rename_element", "{\"from\":\"A\",\"to\":\"B\",\"ops\":[]}"),
            ("update_diagram", "{\"diagramId\":\"other\"}"),
            ("update_diagram", "[]"),
        ] {
            assert!(Decision {
                tool: tool.into(),
                args: args.into(),
                text: String::new()
            }
            .edit(&request())
            .is_err());
        }
    }

    #[test]
    fn malformed_final_output_cannot_reuse_an_earlier_decision() {
        let mut parser = Planner::new(backend(AgentKind::Codex).parser());
        for text in [
            r#"{"tool":"rename_element","args":"{}","text":""}"#,
            "not JSON",
        ] {
            let line = json!({"type":"item.completed","item":{"id":"answer","type":"agent_message","text":text}}).to_string();
            assert!(parser.parse(&line).is_empty());
        }
        assert!(parser.decision.is_none());
    }

    #[test]
    fn claude_structured_result_is_held_until_execution_and_keeps_usage() {
        let mut parser = Planner::new(backend(AgentKind::ClaudeCode).parser());
        let line = json!({"type":"result","subtype":"success","is_error":false,"result":"raw structured JSON", "structured_output":{"tool":"reply","args":"{}","text":"Which API?"},"usage":{"input_tokens":3,"cache_creation_input_tokens":100,"cache_read_input_tokens":50,"output_tokens":20}}).to_string();
        assert!(parser.parse(&line).is_empty());
        assert!(parser.succeeded());
        assert_eq!(parser.decision.unwrap().text, "Which API?");
        assert!(matches!(
            parser.stopped,
            Some(RunEvent::Stopped {
                summary: None,
                usage: Some(super::super::protocol::Usage {
                    input: 153,
                    cached: 50,
                    output: 20
                }),
                ..
            })
        ));
    }
}
