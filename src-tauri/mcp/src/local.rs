//! One literal rename through the normal authenticated bridge, then a receipt-generated reply.
//! No model or MCP tool-result loop is started. The native broker still owns every safety check.
use crate::{bridge, dispatch, served, Bridge, Dispatch, RUN_VAR};
use serde_json::{json, Value};
use std::io::{Read, Write};

fn emit(event: Value) {
    println!("{event}");
    let _ = std::io::stdout().flush();
}

fn stopped(reason: Value) {
    emit(
        json!({"type":"stopped", "reason":reason, "summary":null, "costMicroUsd":0,
        "usage":{"input":0,"cached":0,"output":0}}),
    );
}

fn failure(error: &Value) {
    let message = error["message"].as_str().unwrap_or(
        "The rename could not be confirmed. Do not repeat it without checking the diagram.",
    );
    let message = match error["hint"].as_str().filter(|hint| !hint.is_empty()) {
        Some(hint) => format!("{message}\n\n{hint}"),
        None => message.to_string(),
    };
    emit(json!({"type":"tool-call-update","id":"rename","status":"failed","error":message}));
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
        .take(32_001)
        .read_to_string(&mut input)
        .is_err()
        || input.len() > 32_000
    {
        failure(&json!({"message":"The rename request is too large or unreadable."}));
        return;
    }
    let args = serde_json::from_str(&input).unwrap_or(Value::Null);
    let (tool, args) = match dispatch("rename_element", args, &served(true, false)) {
        Ok(Dispatch::Call(tool, args)) => (tool, args),
        _ => {
            failure(&json!({"message":"Invalid rename request."}));
            return;
        }
    };
    emit(json!({"type":"tool-call","id":"rename","tool":tool,"status":"in-progress"}));
    match Bridge::new(crate::version())
        .call(&tool, args, |_| {}, None)
        .await
    {
        Ok(receipt) => match confirmation(&receipt) {
            Some(text) => {
                emit(
                    json!({"type":"tool-call-update","id":"rename","status":"completed","error":null}),
                );
                emit(json!({"type":"message-chunk","text":text}));
                stopped(json!({"kind":"end-turn"}));
            }
            None => failure(
                &json!({"message":"The rename returned an unrecognized receipt. Check the diagram before repeating it."}),
            ),
        },
        Err(error) => failure(&error),
    }
}

/// Never infer saving from a successful transport result. Applied-but-unsaved and save failure
/// are real outcomes; acknowledge them without retrying a mutation that may already have landed.
fn confirmation(receipt: &Value) -> Option<String> {
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
    if receipt["undo"] == "editor" && receipt["replayed"] != true {
        text.push_str(" You can undo it in the editor.");
    } else if receipt["undo"] == "on-open" && receipt["replayed"] != true {
        text.push_str(" Open the diagram to undo it.");
    }
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
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(confirmation(&receipt).unwrap().contains(expected));
        }
        for receipt in [
            json!({}),
            json!({"state":"saved","applied":true,"persisted":false,"revision":"f:2"}),
            json!({"state":"pending","applied":false,"persisted":false,"revision":"f:2"}),
        ] {
            assert!(confirmation(&receipt).is_none());
        }
    }

    #[test]
    fn warnings_recovery_and_unverified_replays_are_visible() {
        let receipt = json!({"state":"applied-unsaved","applied":true,"persisted":false,"revision":"o:2","replayed":true,"durability":"unverified","note":"A recovery copy exists.","advisories":["Long label"],"advisoriesDropped":2,"quality":{"warnings":3,"warningProblems":[{"message":"Crowded shapes"}]}});
        let text = confirmation(&receipt).unwrap();
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
