//! The agent plans an edit as its final structured response. Only after a successful CLI exit
//! does the host authorize that exact request and run it through the ordinary native broker.
use super::protocol::{ApplyMode, PromptRequest, RunEvent, StopReason};
use super::Parser;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

pub const SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"properties":{"tool":{"type":"string","enum":["reply","edit","rename_element","update_diagram","submit_proposal"]},"args":{"type":"string","description":"JSON object of operation arguments; {} for reply"},"text":{"type":"string","description":"Reply or edit reasoning; never an outcome claim"}},"required":["tool","args","text"]}"#;
pub const INSTRUCTIONS: &str = "Return tool, args (JSON object string), text. Shapes: args={kind:'shape',target:exactLabel,set:{description:'new text'}}; use set.label for renames. Add: {kind:'add',type:'service',label:'name',description:'text'}. Existing connection: {kind:'connection',from:exactSourceLabel,to:exactTargetLabel,set:{label:'caption'}}; set.to/from redirects to another exact shape label. New connection: {kind:'connect',from:exactLabel,to:exactLabel,label:'caption'}. Omit view for named edits across rooms; optional view={inside:[ids]} disambiguates. Host resolves targets, creates ids, pins revision/scope and executes after exit. Never invent ids/revisions or call mutations. For complex edits read needed context then return the mode's tool with expectedRevision and ops. If a target/value is omitted and refers to earlier chat, use diagram_tool tool=read_conversation args={}; missing history means ask, never guess. For clarification/advice use reply, args={}, text=answer. Edit text is optional reasoning, never an outcome claim.";
const DIRECT: &str = "Mode: direct. Final tool=edit for simple requests; host applies it. Only complex patches use final update_diagram.";
const REVIEW: &str = "Mode: review. Final tool=edit for simple requests; host creates a proposal with summary/revision, never applies it. Only complex patches use final submit_proposal. revises amends a pending proposal; never update_diagram.";

pub fn instructions(mode: ApplyMode) -> String {
    format!(
        "{} {}",
        match mode {
            ApplyMode::Direct => DIRECT,
            ApplyMode::Proposal => REVIEW,
        },
        INSTRUCTIONS
    )
}

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
        // Accept an intent under the mode's native name too, but never turn a review-mode
        // update_diagram decision into permission to write. Full intent validation is unchanged.
        let local_intent = self.tool == "edit"
            || (map.contains_key("kind")
                && ((self.tool == "update_diagram" && request.mode == ApplyMode::Direct)
                    || (self.tool == "submit_proposal" && request.mode == ApplyMode::Proposal)));
        let tool =
            match if local_intent {
                "edit"
            } else {
                self.tool.as_str()
            } {
                "edit" => {
                    let revision = request
                        .revision
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .ok_or_else(invalid)?;
                    let view = map.remove("view");
                    let revises = map.remove("revises");
                    if revises.is_some() && request.mode != ApplyMode::Proposal {
                        return Err(invalid());
                    }
                    let intent = Value::Object(map.clone());
                    map.clear();
                    map.insert("expectedRevision".into(), json!(revision));
                    if let Some(view) = view {
                        map.insert("view".into(), view);
                    }
                    if let Some(revises) = revises {
                        map.insert("revises".into(), revises);
                    }
                    if request.mode == ApplyMode::Proposal {
                        let kind = intent.get("kind").and_then(Value::as_str).unwrap_or("edit");
                        let name = intent
                            .get("target")
                            .or_else(|| intent.get("label"))
                            .or_else(|| intent.get("from"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        map.insert(
                            "summary".into(),
                            json!(format!(
                                "{}: {}",
                                kind,
                                name.chars().take(150).collect::<String>()
                            )),
                        );
                    }
                    map.insert("intent".into(), intent);
                    match request.mode {
                        ApplyMode::Direct => "update_diagram",
                        ApplyMode::Proposal => "submit_proposal",
                    }
                }
                "rename_element" => {
                    if map.keys().any(|key| {
                        !["from", "to", "diagramId", "requestId", "view", "scope"]
                            .contains(&key.as_str())
                            && !(key == "revises" && request.mode == ApplyMode::Proposal)
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
                    if request.mode == ApplyMode::Proposal {
                        // Bounded host text; the complete labels remain in the concrete proposal ops.
                        let label = |value: &Value| {
                            value
                                .as_str()
                                .unwrap_or_default()
                                .chars()
                                .take(150)
                                .collect::<String>()
                        };
                        map.insert(
                            "summary".into(),
                            json!(format!("Rename “{}” to “{}”", label(&from), label(&to))),
                        );
                    }
                    map.insert("rename".into(), json!({"from":from,"to":to}));
                    match request.mode {
                        ApplyMode::Direct => "update_diagram",
                        ApplyMode::Proposal => "submit_proposal",
                    }
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
        let named = self.tool == "rename_element"
            || (local_intent
                && map
                    .get("intent")
                    .and_then(|i| i.get("kind"))
                    .and_then(Value::as_str)
                    != Some("add"));
        if !named || !request.room.is_empty() {
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
            revision: None,
        }
    }

    #[test]
    fn local_intents_pin_the_send_revision_mode_and_scope_without_model_metadata() {
        for mode in [ApplyMode::Direct, ApplyMode::Proposal] {
            let mut r = request();
            r.mode = mode;
            r.room.clear();
            r.revision = Some("o:at-send.1".into());
            for name in [
                "edit",
                if mode == ApplyMode::Direct {
                    "update_diagram"
                } else {
                    "submit_proposal"
                },
            ] {
                let d = Decision {
                    tool: name.into(),
                    args:
                        json!({"kind":"connection","from":"API","to":"DB","set":{"label":"Writes"}})
                            .to_string(),
                    text: String::new(),
                };
                let (tool, args) = d.edit(&r).unwrap();
                assert_eq!(
                    tool,
                    if mode == ApplyMode::Direct {
                        "update_diagram"
                    } else {
                        "submit_proposal"
                    }
                );
                assert_eq!(args["expectedRevision"], "o:at-send.1");
                assert_eq!(args["diagramId"], r.diagram_id);
                assert_eq!(args["requestId"], r.run_id);
                assert_eq!(args["scope"], json!({"nodes":["api"],"edges":[]}));
                assert!(args.get("view").is_none());
                assert_eq!(args["intent"]["set"]["label"], "Writes");
                assert_eq!(args.get("summary").is_some(), mode == ApplyMode::Proposal);
            }
        }
        let d = Decision {
            tool: "edit".into(),
            args: json!({"kind":"add","type":"service","label":"Worker"}).to_string(),
            text: String::new(),
        };
        assert!(
            d.edit(&request()).is_err(),
            "no captured revision means no local intent"
        );
        let mut r = request();
        r.mode = ApplyMode::Proposal;
        r.revision = Some("o:at-send.1".into());
        assert!(Decision {
            tool: "update_diagram".into(),
            ..d
        }
        .edit(&r)
        .is_err());
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
        let (tool, args) = d.edit(&review).unwrap();
        assert_eq!(tool, "submit_proposal");
        assert_eq!(args["rename"], json!({"from":"API","to":"Gateway"}));
        assert_eq!(args["summary"], "Rename “API” to “Gateway”");
        assert_eq!(args["scope"], json!({"nodes":["api"],"edges":[]}));
        assert!(Decision {
            tool: "update_diagram".into(),
            args: "{}".into(),
            text: String::new()
        }
        .edit(&review)
        .is_err());
        let revision = Decision {
            args: json!({"from":"API","to":"Gateway","revises":"p_1"}).to_string(),
            tool: "rename_element".into(),
            text: String::new(),
        };
        assert_eq!(revision.edit(&review).unwrap().1["revises"], "p_1");
        assert!(revision.edit(&request()).is_err());
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
