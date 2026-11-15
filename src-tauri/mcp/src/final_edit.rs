//! Execute one host-authorized final edit through the normal bridge, then confirm its receipt.
//! The model has already exited. The native broker still owns every safety check.
use crate::{bridge, dispatch, served, Bridge, Dispatch, RUN_VAR};
use serde_json::{json, Value};
use std::io::{Read, Write};

fn emit(event: Value) {
    println!("{event}");
    let _ = std::io::stdout().flush();
}

fn stopped(reason: Value) {
    emit(
        json!({"type":"stopped", "reason":reason, "summary":null, "costMicroUsd":null,
        "usage":null}),
    );
}

fn failure(error: &Value) {
    let message = error["message"].as_str().unwrap_or(
        "The edit could not be confirmed. Do not repeat it without checking the diagram.",
    );
    let message = match error["hint"].as_str().filter(|hint| !hint.is_empty()) {
        Some(hint) => format!("{message}\n\n{hint}"),
        None => message.to_string(),
    };
    emit(json!({"type":"tool-call-update","id":"final-edit","status":"failed","error":message}));
    stopped(if error["code"] == "CANCELLED" {
        json!({"kind":"cancelled"})
    } else {
        json!({"kind":"failed","message":message})
    });
}

pub async fn run() {
    // This mode is internal to a registered companion run, never a way around its policy.
    if bridge::run_from(std::env::var(RUN_VAR).ok()).is_none() {
        failure(&json!({"message":"A registered companion run is required."}));
        return;
    }
    let mut input = String::new();
    if std::io::stdin()
        .take(300_001)
        .read_to_string(&mut input)
        .is_err()
        || input.len() > 300_000
    {
        failure(&json!({"message":"The edit request is too large or unreadable."}));
        return;
    }
    let envelope: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let name = envelope["tool"].as_str().unwrap_or("");
    let args = envelope["args"].clone();
    let notes = envelope["text"].as_str().unwrap_or("");
    if !matches!(name, "update_diagram" | "submit_proposal")
        || !args.is_object()
        || notes.len() > 20_000
    {
        failure(&json!({"message":"Invalid final edit."}));
        return;
    }
    let (tool, args) = match dispatch(name, args, &served(true, false)) {
        Ok(Dispatch::Call(tool, args)) => (tool, args),
        _ => {
            failure(&json!({"message":"Invalid final edit."}));
            return;
        }
    };
    let rename = args.get("rename").is_some();
    emit(json!({"type":"tool-call","id":"final-edit","tool":tool,"status":"in-progress"}));
    match Bridge::new(crate::version())
        .call(&tool, args, |_| {}, None)
        .await
    {
        Ok(receipt) => match confirmation(&receipt, &tool, rename) {
            Some(mut text) => {
                // Agent explanations were prepared before execution, so never let them obscure a
                // failed save or imply a pending proposal was applied.
                if !notes.is_empty() && receipt["persisted"] == true && receipt["replayed"] != true
                {
                    text.push_str(&format!("\n\nAgent notes:\n\n{notes}"));
                }
                emit(
                    json!({"type":"tool-call-update","id":"final-edit","status":"completed","error":null}),
                );
                emit(json!({"type":"message-chunk","text":text}));
                stopped(json!({"kind":"end-turn"}));
            }
            None => failure(
                &json!({"message":"The edit returned an unrecognized receipt. Check the diagram before repeating it."}),
            ),
        },
        Err(error) => failure(&error),
    }
}

/// Never infer saving from a successful transport result. Applied-but-unsaved and save failure
/// are real outcomes; acknowledge them without retrying a mutation that may already have landed.
fn confirmation(receipt: &Value, tool: &str, rename: bool) -> Option<String> {
    let mut text = if tool == "submit_proposal" {
        receipt["proposalId"].as_str().filter(|id| !id.is_empty())?;
        match receipt["status"].as_str()? {
            "pending" => "Prepared a proposal for review. No diagram changes have been applied. Accept or reject it in the proposal panel.".to_string(),
            "accepted" if ["added", "updated", "removed"].iter().all(|key| receipt["counts"][key] == 0) => "No change was needed.".to_string(),
            _ => return None,
        }
    } else {
        update_confirmation(receipt, rename)?
    };
    advisories(receipt, &mut text);
    Some(text)
}

fn update_confirmation(receipt: &Value, rename: bool) -> Option<String> {
    let applied = receipt["applied"].as_bool()?;
    let persisted = receipt["persisted"].as_bool()?;
    receipt["revision"]
        .as_str()
        .filter(|revision| !revision.is_empty())?;
    let state = receipt["state"].as_str()?;
    let mut text = match (state, applied, persisted) {
        ("saved", true, true) => "Renamed the shape and saved the diagram.",
        ("applied-unsaved", true, false) => "Renamed the shape in the editor. It has not been saved; your existing unsaved changes are preserved.",
        ("save-failed", true, false) => "Renamed the shape in the editor, but saving failed. Do not repeat the rename; save the diagram when the problem is resolved.",
        ("unchanged", false, true) => "No change was needed. The diagram is saved.",
        ("unchanged", false, false) => "No change was needed. The diagram still has unsaved changes.",
        _ => return None,
    }.to_string();
    if receipt["replayed"] == true {
        text = "This request was already completed; the rename was not repeated.".into();
        if receipt["durability"] == "unverified" || !persisted {
            text.push_str(
                " Its current save state is unverified. Check the diagram before saving.",
            );
        }
    } else if receipt["durability"] == "unverified" {
        return None;
    }
    if !rename {
        text = text
            .replace("Renamed the shape", "Applied the change")
            .replace("rename", "change");
    }
    if receipt["undo"] == "editor" && receipt["replayed"] != true {
        text.push_str(" You can undo it in the editor.");
    } else if receipt["undo"] == "on-open" && receipt["replayed"] != true {
        text.push_str(" Open the diagram to undo it.");
    }
    Some(text)
}

fn advisories(receipt: &Value, text: &mut String) {
    if let Some(note) = receipt["note"].as_str() {
        text.push_str(&format!("\n\n{note}"));
    }
    if let Some(advisories) = receipt["advisories"].as_array() {
        for advisory in advisories.iter().filter_map(Value::as_str) {
            text.push_str(&format!("\n\n{advisory}"));
        }
    }
    if let Some(n) = receipt["advisoriesDropped"].as_u64().filter(|n| *n > 0) {
        text.push_str(&format!(
            "\n\n{n} additional advisories were omitted from the tool receipt."
        ));
    }
    for (count, list, word) in [
        ("errors", "problems", "issues"),
        ("warnings", "warningProblems", "warnings"),
    ] {
        if let Some(n) = receipt["quality"][count].as_u64().filter(|n| *n > 0) {
            text.push_str(&format!("\n\nThe affected content has {n} {word}."));
            if let Some(problems) = receipt["quality"][list].as_array() {
                for message in problems
                    .iter()
                    .filter_map(|problem| problem["message"].as_str())
                {
                    text.push_str(&format!("\n\n{message}"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_and_review_only_proposals_have_distinct_confirmations() {
        let update = json!({"state":"saved","applied":true,"persisted":true,"revision":"f:2"});
        assert_eq!(
            confirmation(&update, "update_diagram", false).unwrap(),
            "Applied the change and saved the diagram."
        );
        let mut proposal = json!({"proposalId":"p_1","status":"pending","counts":{"added":0,"updated":1,"removed":0},"advisories":["Check labels"]});
        let text = confirmation(&proposal, "submit_proposal", false).unwrap();
        assert!(text.contains("No diagram changes have been applied"));
        assert!(text.contains("Check labels"));
        proposal["status"] = json!("accepted");
        assert!(confirmation(&proposal, "submit_proposal", false).is_none());
        proposal["counts"]["updated"] = json!(0);
        assert!(confirmation(&proposal, "submit_proposal", false)
            .unwrap()
            .contains("No change was needed"));
    }

    #[test]
    fn receipt_states_never_confuse_applied_with_saved() {
        for (state, applied, persisted, expected) in [
            ("saved", true, true, "saved the diagram"),
            ("applied-unsaved", true, false, "has not been saved"),
            ("save-failed", true, false, "saving failed"),
            ("unchanged", false, true, "No change was needed"),
            ("unchanged", false, false, "still has unsaved changes"),
        ] {
            let receipt = json!({"state":state,"applied":applied,"persisted":persisted,"revision":"o:2","undo":"editor"});
            assert!(confirmation(&receipt, "update_diagram", true)
                .unwrap()
                .contains(expected));
        }
        for receipt in [
            json!({}),
            json!({"state":"saved","applied":true,"persisted":false,"revision":"f:2"}),
            json!({"state":"pending","applied":false,"persisted":false,"revision":"f:2"}),
        ] {
            assert!(confirmation(&receipt, "update_diagram", true).is_none());
        }
    }

    #[test]
    fn warnings_recovery_and_unverified_replays_are_visible() {
        let receipt = json!({"state":"applied-unsaved","applied":true,"persisted":false,"revision":"o:2","replayed":true,"durability":"unverified","note":"A recovery copy exists.","advisories":["Long label"],"advisoriesDropped":2,"quality":{"warnings":3,"warningProblems":[{"message":"Crowded shapes"}]}});
        let text = confirmation(&receipt, "update_diagram", true).unwrap();
        for expected in [
            "not repeated",
            "save state is unverified",
            "recovery copy",
            "Long label",
            "2 additional",
            "3 warnings",
            "Crowded shapes",
        ] {
            assert!(text.contains(expected), "{text}");
        }
        assert!(!text.contains("saved the diagram"));
    }
}
