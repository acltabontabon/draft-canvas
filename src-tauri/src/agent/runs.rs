//! Agents the companion started (`companion/`) and what each may do.
//!
//! Such an agent's sidecar names its run in the hello (`DRAFT_CANVAS_RUN`). The token, the access
//! switch and the folder scope decide what any agent may reach; a run only narrows that, to the one
//! diagram the person asked about, and to proposals unless they chose to apply changes directly. A run
//! name with no open run here is refused, so a stale or made-up one gains nothing.
//!
//! Every call a run's connection makes is tracked while it runs, so ending the run can cancel what the
//! page hasn't committed yet.

use super::broker::{CallRegistry, ToolError};
use crate::util::lock;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunPolicy {
    pub diagram_id: String,
    /// `update_diagram` is allowed; otherwise changes go through `submit_proposal`.
    pub direct: bool,
    /// The project folder the person let this run read (`code.rs`), read-only; without one the run
    /// may only ask to (`ask_to_read_code`).
    pub code: Option<PathBuf>,
}

struct Open {
    policy: RunPolicy,
    calls: Vec<Weak<CallRegistry>>,
}

#[derive(Default)]
pub struct Runs {
    open: Mutex<HashMap<String, Open>>,
}

impl Runs {
    pub fn open(&self, run: &str, policy: RunPolicy) {
        lock(&self.open).insert(
            run.to_string(),
            Open {
                policy,
                calls: Vec::new(),
            },
        );
    }

    pub fn policy(&self, run: &str) -> Option<RunPolicy> {
        lock(&self.open).get(run).map(|o| o.policy.clone())
    }

    /// Records a call the run's connection is making; `false` once the run has ended, and the call
    /// must not start.
    pub fn track(&self, run: &str, call: &Arc<CallRegistry>) -> bool {
        let mut open = lock(&self.open);
        let Some(entry) = open.get_mut(run) else {
            return false;
        };
        entry.calls.retain(|c| c.strong_count() > 0);
        entry.calls.push(Arc::downgrade(call));
        true
    }

    /// Ends a run: nothing more is admitted for it, and the calls still in flight are handed back for
    /// cancelling. Admission closes in the same step, so no call can slip in after the hand-back.
    pub fn close(&self, run: &str) -> Vec<Arc<CallRegistry>> {
        lock(&self.open)
            .remove(run)
            .map(|o| o.calls.iter().filter_map(Weak::upgrade).collect())
            .unwrap_or_default()
    }
}

/// The tools a run may use at all. `list_diagrams` would show other diagrams, and `create_diagram`
/// would make one nobody asked about; both are left out.
const RUN_TOOLS: &[&str] = &[
    "get_capabilities",
    "read_diagram",
    "read_attachment",
    "read_selection",
    "get_implementation_context",
    "render_diagram",
    "preview_diagram",
    "update_diagram",
    "submit_proposal",
    "get_proposal",
    "list_proposals",
    "ask_to_read_code",
    "list_code",
    "search_code",
    "read_code",
];

/// Tools no agent but a companion run is ever offered: an agent the person connected has files of
/// its own.
pub const RUN_ONLY: &[&str] = &["ask_to_read_code", "list_code", "search_code", "read_code"];

pub fn ended() -> ToolError {
    ToolError::new(
        "CANCELLED",
        "The person stopped this request in Draft Canvas. Nothing more will be done for it.",
    )
}

fn outside(message: String) -> ToolError {
    ToolError::new("RUN_LIMIT", message).hint(
        "You were started from the Draft Canvas companion for one diagram. Work only on that diagram.",
    )
}

/// Holds one call to `policy`. Returns the arguments to run it with (`list_proposals` is narrowed to
/// the run's diagram), or why it may not run. `proposal_diagram` looks up the diagram a proposal id
/// belongs to.
pub fn constrain(
    policy: &RunPolicy,
    tool: &str,
    mut args: Value,
    proposal_diagram: impl FnOnce(&str) -> Option<String>,
) -> Result<Value, ToolError> {
    if !RUN_TOOLS.contains(&tool) {
        return Err(outside(format!("{tool} isn't available to the companion.")));
    }
    if tool == "update_diagram" && !policy.direct {
        return Err(ToolError::new(
            "PROPOSAL_ONLY",
            "The person reviews the companion's changes before they are saved.",
        )
        .hint("Send the same ops with submit_proposal instead."));
    }
    let named = args.get("diagramId").and_then(Value::as_str);
    match tool {
        "get_capabilities" | "ask_to_read_code" => {}
        reader if super::code::CODE_TOOLS.contains(&reader) => {
            if policy.code.is_none() {
                return Err(ToolError::new(
                    "NOT_ALLOWED",
                    "The person hasn't let you read the project's code.",
                )
                .hint("Call ask_to_read_code with why you need it, then end your turn."));
            }
        }
        "list_proposals" => {
            if named.is_some_and(|id| id != policy.diagram_id) {
                return Err(outside(format!(
                    "Only proposals for {} are available.",
                    policy.diagram_id
                )));
            }
            args["diagramId"] = json!(policy.diagram_id);
        }
        "get_proposal" => {
            let proposal = args.get("proposalId").and_then(Value::as_str).unwrap_or("");
            // An unknown id is left to the tool's own NOT_FOUND.
            if let Some(diagram) = proposal_diagram(proposal) {
                if diagram != policy.diagram_id {
                    return Err(outside(format!(
                        "That proposal belongs to another diagram than {}.",
                        policy.diagram_id
                    )));
                }
            }
        }
        _ => {
            if named != Some(policy.diagram_id.as_str()) {
                return Err(outside(format!(
                    "Only the diagram {} is available.",
                    policy.diagram_id
                )));
            }
        }
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(direct: bool) -> RunPolicy {
        RunPolicy {
            diagram_id: "d_1".into(),
            direct,
            code: None,
        }
    }

    fn code(result: Result<Value, ToolError>) -> String {
        result.unwrap_err().to_value()["code"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn a_run_reads_code_only_when_the_person_allowed_it() {
        let none = |_: &str| None;
        let p = policy(false);
        assert!(constrain(&p, "ask_to_read_code", json!({"reason": "retries"}), none).is_ok());
        assert_eq!(
            code(constrain(
                &p,
                "read_code",
                json!({"path": "src/a.ts"}),
                none
            )),
            "NOT_ALLOWED"
        );
        let allowed = RunPolicy {
            code: Some(PathBuf::from("/work/library")),
            ..policy(false)
        };
        for tool in ["list_code", "search_code", "read_code"] {
            assert!(constrain(&allowed, tool, json!({}), none).is_ok(), "{tool}");
        }
    }

    #[test]
    fn a_run_reaches_only_its_own_diagram() {
        let p = policy(false);
        let none = |_: &str| None;
        assert!(constrain(&p, "read_diagram", json!({"diagramId": "d_1"}), none).is_ok());
        assert_eq!(
            code(constrain(
                &p,
                "read_diagram",
                json!({"diagramId": "d_2"}),
                none
            )),
            "RUN_LIMIT"
        );
        assert_eq!(
            code(constrain(&p, "render_diagram", json!({}), none)),
            "RUN_LIMIT"
        );
        assert_eq!(
            code(constrain(&p, "list_diagrams", json!({}), none)),
            "RUN_LIMIT"
        );
        assert_eq!(
            code(constrain(&p, "create_diagram", json!({"title": "x"}), none)),
            "RUN_LIMIT"
        );
        assert!(constrain(&p, "get_capabilities", json!({}), none).is_ok());
    }

    #[test]
    fn changes_are_proposals_unless_the_person_chose_direct() {
        let args = json!({"diagramId": "d_1", "ops": []});
        assert_eq!(
            code(constrain(
                &policy(false),
                "update_diagram",
                args.clone(),
                |_| None
            )),
            "PROPOSAL_ONLY"
        );
        assert!(constrain(&policy(true), "update_diagram", args.clone(), |_| None).is_ok());
        assert!(constrain(&policy(false), "submit_proposal", args, |_| None).is_ok());
    }

    #[test]
    fn proposals_are_limited_to_the_run_s_diagram() {
        let p = policy(false);
        let listed = constrain(&p, "list_proposals", json!({}), |_| None).unwrap();
        assert_eq!(listed["diagramId"], "d_1");
        assert_eq!(
            code(constrain(
                &p,
                "list_proposals",
                json!({"diagramId": "d_2"}),
                |_| None
            )),
            "RUN_LIMIT"
        );
        let other = |_: &str| Some("d_2".to_string());
        assert_eq!(
            code(constrain(
                &p,
                "get_proposal",
                json!({"proposalId": "p"}),
                other
            )),
            "RUN_LIMIT"
        );
        let own = |_: &str| Some("d_1".to_string());
        assert!(constrain(&p, "get_proposal", json!({"proposalId": "p"}), own).is_ok());
    }

    #[test]
    fn a_closed_run_admits_nothing_and_hands_back_its_calls() {
        let runs = Runs::default();
        let call = Arc::new(CallRegistry::new("s".into()));
        assert!(!runs.track("r1", &call), "never opened");
        runs.open("r1", policy(false));
        assert!(runs.track("r1", &call));
        let finished = Arc::new(CallRegistry::new("s".into()));
        assert!(runs.track("r1", &finished));
        drop(finished);
        let live = runs.close("r1");
        assert_eq!(live.len(), 1);
        assert!(Arc::ptr_eq(&live[0], &call));
        assert!(runs.policy("r1").is_none());
        assert!(!runs.track("r1", &call));
    }
}
