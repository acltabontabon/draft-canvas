//! Literal, single edits whose meaning needs no model. Everything else uses the agent as usual.
use super::protocol::{ApplyMode, PromptRequest, RunEvent};
use super::Parser;
use serde_json::{json, Value};

/// Require quoted labels and consume the entire command. In particular, never turn a question,
/// conditional, or the first half of a compound request into an immediate edit.
pub fn rename(request: &PromptRequest) -> Option<Value> {
    if request.mode != ApplyMode::Direct {
        return None;
    }
    fn prefix<'a>(text: &'a str, word: &str) -> Option<&'a str> {
        text.get(..word.len())?
            .eq_ignore_ascii_case(word)
            .then(|| &text[word.len()..])
    }
    fn label(text: &str) -> Option<(&str, &str)> {
        let (open, close) = match text.chars().next()? {
            '"' => ('"', '"'),
            '“' => ('“', '”'),
            _ => return None,
        };
        let text = &text[open.len_utf8()..];
        let end = text.find(close)?;
        let name = &text[..end];
        if name.trim().is_empty() || name.len() > 2_000 || name.chars().any(char::is_control) {
            return None;
        }
        Some((name, &text[end + close.len_utf8()..]))
    }
    let text = request.text.trim();
    let text = prefix(text, "please ").unwrap_or(text);
    let (from, rest) = label(prefix(text, "rename ")?.trim_start())?;
    let (to, rest) = label(prefix(rest, " to ")?.trim_start())?;
    if !matches!(rest.trim(), "" | ".") {
        return None;
    }
    let mut args = json!({
        "diagramId": request.diagram_id, "requestId": request.run_id,
        "from": from, "to": to, "view": {"inside": request.room},
    });
    if let Some(selection) = &request.selection {
        if !selection.nodes.is_empty() || !selection.edges.is_empty() {
            args["scope"] = json!(selection);
        }
    }
    Some(args)
}

/// The bundled sidecar emits our own events for a local edit, without inventing an agent session.
pub struct ReceiptParser;

impl Parser for ReceiptParser {
    fn parse(&mut self, line: &str) -> Vec<RunEvent> {
        serde_json::from_str::<RunEvent>(line)
            .ok()
            .into_iter()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::protocol::{AgentKind, Selection};

    fn request(text: &str) -> PromptRequest {
        PromptRequest {
            run_id: "request-1".into(),
            diagram_id: "d_1".into(),
            text: text.into(),
            selection: Some(Selection {
                nodes: vec!["api".into()],
                edges: vec![],
            }),
            room: vec!["system".into()],
            agent: AgentKind::Codex,
            mode: ApplyMode::Direct,
            unchanged: None,
            snapshot: None,
        }
    }

    #[test]
    fn literal_rename_preserves_labels_scope_room_and_request_identity() {
        let args = rename(&request("Please rename “Orders API” to “Checkout API”.")).unwrap();
        assert_eq!(
            args,
            json!({"diagramId":"d_1","requestId":"request-1","from":"Orders API","to":"Checkout API","view":{"inside":["system"]},"scope":{"nodes":["api"],"edges":[]}})
        );
        assert_eq!(
            rename(&request("rename \"A\" to \"B\"")).unwrap()["to"],
            "B"
        );
    }

    #[test]
    fn review_questions_conditions_and_extra_work_stay_with_the_agent() {
        for text in [
            "Can we rename \"A\" to \"B\"?",
            "Don't rename \"A\" to \"B\"",
            "rename \"A\" to \"B\" and add a cache",
            "rename \"A\" to \"B\" if it is unused",
            "rename \"A\" to \"B\". Explain why.",
            "rename A to B",
            "rename \"A\" to \"B\"?",
            "rename \"\" to \"B\"",
            "rename \"A\nC\" to \"B\"",
        ] {
            assert!(rename(&request(text)).is_none(), "{text}");
        }
        let mut review = request("rename \"A\" to \"B\"");
        review.mode = ApplyMode::Proposal;
        assert!(rename(&review).is_none());
    }
}
