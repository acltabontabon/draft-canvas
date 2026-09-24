//! One tool call, from an authenticated connection to an answer: scope, the ledger, the trip to the
//! page, and — for a new diagram — the file write itself, which only Rust may make.
//!
//! The order is the contract: access and scope are checked on every call (a replay included); the
//! ledger is consulted before anything else, so a retry of a request that succeeded gets its first
//! answer instead of a revision conflict; and every step that changes something is written to the
//! ledger before it happens.

use super::ledger::{Begin, Entry, Stage};
use super::page::{Budgets, Failure};
use super::proposals::{Proposal, ProposalStatus};
use super::scope::{self, enabled_projects, in_scope, Diagram, Lookup, Project};
use super::{Agent, InflightGuard};
use crate::docio::{
    create_new_atomic, ensure_document_size, read_document, unique_name, write_atomic, WriteOutcome,
};
use crate::paths::{display_path, sanitize_stem, DOC_EXT};
use crate::state::{AppState, HostEvent};
use crate::util::now_ms;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// A tool's failure, as the agent sees it: a stable code to branch on, a sentence to show, and
/// where relevant what to do next. Never a stack trace, a path outside scope, or document content.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
            retryable: None,
            details: None,
        }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = Some(true);
        self
    }

    pub fn details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

pub type ToolResult = Result<Value, ToolError>;

const TOOLS: &[&str] = &[
    "get_capabilities",
    "list_diagrams",
    "read_diagram",
    "read_selection",
    "get_implementation_context",
    "create_diagram",
    "update_diagram",
    "submit_proposal",
    "get_proposal",
    "list_proposals",
];

/// The whole request, as stored for comparison: keys sorted at every level, `requestId` left out
/// (it is the key, not the content). Two requests with the same content hash the same however their
/// fields were ordered.
pub fn fingerprint(tool: &str, args: &Value) -> String {
    fn canonical(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, key) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).unwrap_or_default());
                    out.push(':');
                    canonical(&map[*key], out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    canonical(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut stripped = args.clone();
    if let Value::Object(map) = &mut stripped {
        map.remove("requestId");
    }
    let mut text = String::from(tool);
    text.push('\n');
    canonical(&stripped, &mut text);
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Runs one tool call. `calls` is how the connection finds this call's page request to cancel it.
pub async fn call(agent: &Agent, tool: &str, args: Value, calls: &CallRegistry) -> ToolResult {
    let Some(app) = agent.app().cloned() else {
        return Err(unavailable());
    };
    if !TOOLS.contains(&tool) {
        return Err(ToolError::new(
            "UNKNOWN_TOOL",
            format!("There is no tool named {tool}."),
        ));
    }
    if !app.state::<AppState>().settings.get().agent_access {
        return Err(not_enabled());
    }
    let args = match args {
        Value::Object(map) => Value::Object(map),
        Value::Null => Value::Object(Map::new()),
        _ => {
            return Err(ToolError::new(
                "INVALID_INPUT",
                "Arguments must be an object.",
            ))
        }
    };
    let projects = enabled_projects(&app.state::<AppState>());
    match tool {
        "get_capabilities" => to_page(agent, &app, tool, &args, json!({}), calls).await,
        "list_diagrams" => list(agent, &app, &projects, &args, calls).await,
        "read_diagram" => read(agent, &app, &projects, &args, calls).await,
        "read_selection" => read_selection(agent, &app, &projects, &args, calls).await,
        "get_implementation_context" => {
            implementation_context(agent, &app, &projects, &args, calls).await
        }
        "create_diagram" => create(agent, &app, &projects, &args, calls).await,
        "update_diagram" => update(agent, &app, &projects, &args, calls).await,
        "submit_proposal" => submit_proposal(agent, &app, &projects, &args, calls).await,
        "get_proposal" => get_proposal(agent, &projects, &args),
        "list_proposals" => list_proposals(agent, &projects, &args),
        _ => unreachable!(),
    }
}

fn unavailable() -> ToolError {
    ToolError::new(
        "APP_UNAVAILABLE",
        "Draft Canvas isn't ready to take requests.",
    )
    .hint("Open Draft Canvas, then try again.")
    .retryable()
}

fn not_enabled() -> ToolError {
    ToolError::new("NOT_ENABLED", "Agent access is turned off in Draft Canvas.").hint(
        "In Draft Canvas, open Settings → AI agents and turn on agent access for a project folder.",
    )
}

fn request_id(args: &Value) -> Result<String, ToolError> {
    let id = args
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err(ToolError::new(
            "INVALID_INPUT",
            "requestId is required: 1–128 printable characters, unique per intended change.",
        )
        .details(json!({"path": "/requestId"})));
    }
    Ok(id.to_string())
}

fn diagram_id(args: &Value) -> Result<String, ToolError> {
    args.get("diagramId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_string)
        .ok_or_else(|| {
            ToolError::new("INVALID_INPUT", "diagramId is required.")
                .details(json!({"path": "/diagramId"}))
        })
}

fn locate(agent: &Agent, projects: &[Project], id: &str) -> Result<Diagram, ToolError> {
    if projects.is_empty() {
        return Err(not_enabled());
    }
    agent
        .index
        .find(projects, id)
        .map_err(|lookup| match lookup {
            Lookup::NotFound => ToolError::new(
                "NOT_FOUND",
                format!("No diagram with id {id} in the folders agents may use."),
            )
            .hint("It may have been deleted, or moved out of the folders agents may use. Tell the person and ask which diagram to use (list_diagrams shows what is in scope); don't create a replacement unless they ask for one."),
            Lookup::Ambiguous(paths) => ToolError::new(
                "AMBIGUOUS_DIAGRAM",
                format!("More than one file carries the id {id} (a copied file)."),
            )
            .hint("Ask the person which one to use, or to rename one in Draft Canvas.")
            .details(json!({"paths": paths})),
        })
}

// ─── list_diagrams ──────────────────────────────────────────────────────────────────────────────

const LIST_PAGE_MAX: usize = 50;
/// A title lookup answers with at most this many candidates — enough to ask the person which.
const QUERY_MAX: usize = 20;

/// How a title is compared: trimmed, case and inner spacing ignored.
fn title_key(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

async fn list(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    if projects.is_empty() {
        return Err(not_enabled());
    }
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(title_key)
        .filter(|q| !q.is_empty());
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, LIST_PAGE_MAX))
        .unwrap_or(if query.is_some() {
            QUERY_MAX
        } else {
            LIST_PAGE_MAX
        });
    let offset = args
        .get("cursor")
        .and_then(Value::as_str)
        .and_then(|c| c.strip_prefix("o:"))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    let project_filter = args.get("project").and_then(Value::as_str);
    let active = agent.active();
    let mut all: Vec<Diagram> = agent
        .index
        .list(projects)
        .into_iter()
        .filter(|d| project_filter.is_none_or(|p| d.project == p))
        .filter(|d| {
            query
                .as_ref()
                .is_none_or(|q| title_key(&d.title).contains(q.as_str()))
        })
        .collect();
    // Exact title matches first: "update the Payments diagram" should find Payments before Payments v2.
    if let Some(q) = &query {
        all.sort_by_key(|d| title_key(&d.title) != *q);
    }
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    for d in &all {
        *counts.entry(d.diagram_id.as_str()).or_default() += 1;
    }
    let page: Vec<Value> = all
        .iter()
        .skip(offset)
        .take(limit)
        .map(|d| {
            let open = active.as_ref().is_some_and(|a| {
                dunce::canonicalize(&a.path).ok() == dunce::canonicalize(&d.absolute).ok()
            });
            let mut item = json!({
                "diagramId": d.diagram_id,
                "title": d.title,
                "project": d.project,
                "path": d.path,
                "revision": d.revision,
                "open": open,
            });
            if open {
                item["dirty"] = json!(active.as_ref().is_some_and(|a| a.dirty));
            }
            if counts.get(d.diagram_id.as_str()).copied().unwrap_or(0) > 1 {
                item["duplicateId"] = json!(true);
            }
            if query.as_ref().is_some_and(|q| title_key(&d.title) == *q) {
                item["exact"] = json!(true);
            }
            item
        })
        .collect();
    let next = offset + page.len();
    let mut result = json!({
        "diagrams": page,
        "projects": projects.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
        "complete": next >= all.len(),
    });
    if next < all.len() {
        result["cursor"] = json!(format!("o:{next}"));
    }
    // "The current diagram": what the person has open right now — which may not be the diagram this
    // conversation has been working on, and is never substituted for it.
    result["active"] = match &active {
        Some(open) => active_context(agent, app, projects, open, calls).await,
        None => Value::Null,
    };
    let recent = agent.sessions.recent(&calls.session);
    if !recent.is_empty() {
        result["thisSession"] = json!(recent);
    }
    Ok(result)
}

/// The open document, described enough to target it: id, title, the revision to pass, and the view
/// (room) the person is in. Asked of the page, which alone knows an unsaved revision and the room;
/// if it can't say, what the file on disk says is given instead.
async fn active_context(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    open: &super::ActiveDoc,
    calls: &CallRegistry,
) -> Value {
    let Some(diagram) =
        agent.index.list(projects).into_iter().find(|d| {
            dunce::canonicalize(&d.absolute).ok() == dunce::canonicalize(&open.path).ok()
        })
    else {
        // Open, but not in a folder agents may use: say only that much.
        return json!({"inScope": false});
    };
    let mut out = json!({
        "diagramId": diagram.diagram_id,
        "title": diagram.title,
        "path": diagram.path,
        "project": diagram.project,
        "dirty": open.dirty,
    });
    if !open.dirty {
        out["revision"] = json!(diagram.revision);
    }
    if let Ok(page) = to_page(agent, app, "active_context", &json!({}), json!({}), calls).await {
        for key in ["revision", "title", "view"] {
            if let Some(value) = page.get(key) {
                out[key] = value.clone();
            }
        }
    }
    out
}

// ─── the page ───────────────────────────────────────────────────────────────────────────────────

/// The page request one tool call is waiting on right now, so the connection can cancel it when its
/// client gives up on the call.
#[derive(Default)]
pub struct CallRegistry {
    current: std::sync::Mutex<Option<u64>>,
    /// The agent session the call came from (see `session.rs`).
    pub session: String,
    /// Where this call's progress frames go: its connection's writer, and the call's own id there.
    progress: Option<ProgressSink>,
}

pub type ProgressSink = (tokio::sync::mpsc::Sender<Value>, u64);

impl CallRegistry {
    pub fn new(session: String) -> Self {
        Self {
            current: std::sync::Mutex::default(),
            session,
            progress: None,
        }
    }

    pub fn with_progress(mut self, out: tokio::sync::mpsc::Sender<Value>, call: u64) -> Self {
        self.progress = Some((out, call));
        self
    }

    /// The page is working on `page_id` for this call: cancellable, and its progress routed here.
    fn track(&self, agent: &Agent, page_id: u64) {
        self.set(page_id);
        if let Some(sink) = &self.progress {
            crate::util::lock(&agent.progress).insert(page_id, sink.clone());
        }
    }

    fn untrack(&self, agent: &Agent, page_id: u64) {
        self.clear();
        crate::util::lock(&agent.progress).remove(&page_id);
    }

    fn set(&self, page_id: u64) {
        *crate::util::lock(&self.current) = Some(page_id);
    }

    fn clear(&self) {
        *crate::util::lock(&self.current) = None;
    }

    pub fn current(&self) -> Option<u64> {
        *crate::util::lock(&self.current)
    }
}

/// Sends a request to the page and waits for its answer. A page answer is either
/// `{"ok": true, "value": …}` or `{"ok": false, "error": {…}}`.
async fn to_page(
    agent: &Agent,
    app: &AppHandle,
    tool: &str,
    args: &Value,
    context: Value,
    calls: &CallRegistry,
) -> Result<Value, ToolError> {
    let state = app.state::<AppState>();
    let (id, rx) = agent.page.register();
    let sent = state.events.emit(HostEvent::AgentRequest {
        id,
        tool: tool.to_string(),
        args: args.clone(),
        context,
    });
    if !sent {
        agent.page.forget(id);
        return Err(ToolError::new(
            "APP_STARTING",
            "Draft Canvas is running but its window hasn't finished loading.",
        )
        .hint("Wait a moment and try again.")
        .retryable());
    }
    calls.track(agent, id);
    let answer = agent.page.wait(id, rx, Budgets::default()).await;
    calls.untrack(agent, id);
    let value = answer.map_err(failure_error)?;
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(value.get("value").cloned().unwrap_or(Value::Null));
    }
    Err(page_error(value.get("error")))
}

fn failure_error(failure: Failure) -> ToolError {
    match failure {
        Failure::Unresponsive => ToolError::new(
            "APP_UNRESPONSIVE",
            "Draft Canvas didn't respond. Nothing was changed.",
        )
        .hint("Its window may be suspended while hidden, or showing a dialog. Bring Draft Canvas forward and retry with the same requestId.")
        .retryable(),
        Failure::TimedOutBeforeCommit => ToolError::new(
            "TIMEOUT",
            "Draft Canvas took too long to prepare the change. Nothing was changed.",
        )
        .hint("Retry with the same requestId, or send a smaller batch.")
        .retryable(),
        Failure::OutcomeUnknown => outcome_unknown(),
        Failure::Cancelled => ToolError::new("CANCELLED", "The request was cancelled before anything was changed."),
    }
}

fn outcome_unknown() -> ToolError {
    ToolError::new(
        "OUTCOME_UNKNOWN",
        "The change was being applied when Draft Canvas stopped answering, so whether it took effect is unknown.",
    )
    .hint("Call read_diagram and compare with what you asked for before deciding to send anything again. Retrying the same requestId returns this answer again rather than applying twice.")
}

/// A page-reported failure. Its code is kept only when it is one this bridge knows; anything else
/// becomes a generic failure, so the page can't mint codes the documentation doesn't list.
fn page_error(error: Option<&Value>) -> ToolError {
    const KNOWN: &[&str] = &[
        "INVALID_INPUT",
        "UNSUPPORTED_TYPE",
        "INVALID_REFERENCE",
        "DUPLICATE_ID",
        "CONTAINMENT_CYCLE",
        "REVISION_CONFLICT",
        "CURSOR_STALE",
        "LIMIT_EXCEEDED",
        "LAYOUT_FAILED",
        "LAYOUT_CONSTRAINED",
        "DUPLICATE_FLOW",
        "OUT_OF_SCOPE",
        "SCOPE_TARGET_MISSING",
        "CANCELLED",
        "NOT_ACTIVE",
        "DOCUMENT_BUSY",
        "BUSY",
        "READ_ONLY",
        "NOT_FOUND",
        "UNSUPPORTED",
        "INTERNAL",
    ];
    let error = error.cloned().unwrap_or(Value::Null);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("INTERNAL");
    let code = KNOWN
        .iter()
        .find(|k| **k == code)
        .copied()
        .unwrap_or("INTERNAL");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Draft Canvas couldn't complete the request.")
        .chars()
        .take(500)
        .collect::<String>();
    let mut out = ToolError::new(code, message);
    if let Some(hint) = error.get("hint").and_then(Value::as_str) {
        out = out.hint(hint.chars().take(500).collect::<String>());
    }
    if error.get("retryable").and_then(Value::as_bool) == Some(true) {
        out = out.retryable();
    }
    if let Some(details) = error.get("details") {
        out = out.details(details.clone());
    }
    out
}

/// What the page is told about a diagram a request names.
fn diagram_context(agent: &Agent, diagram: &Diagram, with_text: bool) -> Result<Value, ToolError> {
    let active = agent.active().filter(|a| {
        dunce::canonicalize(&a.path).ok() == dunce::canonicalize(&diagram.absolute).ok()
    });
    let mut context = json!({
        "diagramId": diagram.diagram_id,
        "project": diagram.project,
        "path": diagram.path,
        "displayPath": display_path(&diagram.absolute),
        "open": active.is_some(),
    });
    let app = agent.app().ok_or_else(unavailable)?;
    let handle = app
        .state::<AppState>()
        .grant_file(&diagram.absolute)
        .map_err(|e| ToolError::new("NOT_FOUND", e.message))?;
    context["handle"] = json!(handle);
    if with_text && active.is_none() {
        let read =
            read_document(&diagram.absolute).map_err(|e| ToolError::new("NOT_FOUND", e.message))?;
        context["text"] = json!(read.text);
        context["stamp"] = json!(read.stamp);
    }
    Ok(context)
}

// ─── read_diagram ───────────────────────────────────────────────────────────────────────────────

async fn read(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    let id = diagram_id(args)?;
    let diagram = locate(agent, projects, &id)?;
    let context = diagram_context(agent, &diagram, true)?;
    to_page(agent, app, "read_diagram", args, context, calls).await
}

// ─── read_selection ─────────────────────────────────────────────────────────────────────────────

/// Only the diagram open in Draft Canvas right now has a selection at all; the page refuses
/// (`NOT_ACTIVE`) when `context.open` says otherwise, so this doesn't need `diagram_context`'s
/// on-disk text — nothing here is read from a closed file.
async fn read_selection(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    let id = diagram_id(args)?;
    let diagram = locate(agent, projects, &id)?;
    let context = diagram_context(agent, &diagram, false)?;
    to_page(agent, app, "read_selection", args, context, calls).await
}

// ─── get_implementation_context ────────────────────────────────────────────────────────────────

/// Read-only, and works on a closed diagram too (unlike `read_selection`) — reuses `diagram_context`'s
/// on-disk text the same way `read_diagram` does.
async fn implementation_context(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    let id = diagram_id(args)?;
    let diagram = locate(agent, projects, &id)?;
    let context = diagram_context(agent, &diagram, true)?;
    to_page(
        agent,
        app,
        "get_implementation_context",
        args,
        context,
        calls,
    )
    .await
}

// ─── create_diagram ─────────────────────────────────────────────────────────────────────────────

/// Resolves a request's ledger entry before any work: a replay, a wait for an identical request
/// already running, or a go-ahead holding the key.
async fn admit<'a>(
    agent: &'a Agent,
    tool: &str,
    args: &Value,
    projects: &[Project],
    recover: impl Fn(&Entry) -> Option<Value>,
) -> Result<Admission<'a>, ToolError> {
    let key = format!("{tool}:{}", request_id(args)?);
    let fp = fingerprint(tool, args);
    loop {
        let guard = match agent.claim(&key) {
            Ok(guard) => guard,
            Err(mut done) => {
                // An identical request is running: its outcome is this one's.
                let _ = done.wait_for(|finished| *finished).await;
                continue;
            }
        };
        let begun = agent
            .with_ledger(|l| l.begin(&key, &fp))
            .ok_or_else(ledger_unavailable)?;
        return match begun {
            Begin::Fresh => Ok(Admission::Go { key, fp, guard }),
            Begin::Mismatch => Err(ToolError::new(
                "REQUEST_ID_MISMATCH",
                "This requestId was already used for a different request.",
            )
            .hint("Use a fresh unique requestId (a UUID) for every new change. Reuse an id only to retry exactly the same request.")),
            Begin::Replay(entry) => Ok(Admission::Replay(replay_receipt(&entry, projects)?)),
            Begin::Unresolved(entry) => match recover(&entry) {
                Some(receipt) => {
                    let now = now_ms();
                    let _ = agent.with_ledger(|l| {
                        l.advance(&key, Stage::Committed, now, |e| e.receipt = Some(receipt.clone()))
                    });
                    Ok(Admission::Replay(replay_receipt(
                        &Entry {
                            receipt: Some(receipt),
                            ..entry
                        },
                        projects,
                    )?))
                }
                None if entry.stage == Stage::Pending => Ok(Admission::Go { key, fp, guard }),
                None => Err(outcome_unknown()),
            },
        };
    }
}

enum Admission<'a> {
    Go {
        key: String,
        fp: String,
        guard: InflightGuard<'a>,
    },
    Replay(Value),
}

fn ledger_unavailable() -> ToolError {
    ToolError::new(
        "INTERNAL",
        "Draft Canvas couldn't open its request log, so it can't make changes safely right now.",
    )
    .hint("Turn agent access off and on again in Settings.")
}

/// A stored receipt, checked against today's scope, marked as a replay. Side effects the first
/// answer described (opening the document) are not repeated.
fn replay_receipt(entry: &Entry, projects: &[Project]) -> Result<Value, ToolError> {
    if let Some(path) = &entry.path {
        if in_scope(projects, &PathBuf::from(path)).is_none() {
            return Err(ToolError::new(
                "OUT_OF_SCOPE",
                "That request's diagram is no longer in a folder agents may use.",
            ));
        }
    }
    let mut receipt = entry.receipt.clone().unwrap_or_else(|| json!({}));
    receipt["replayed"] = json!(true);
    if receipt.get("persisted").and_then(Value::as_bool) == Some(false) {
        // The first answer said the change was only in the editor. Whether it outlived an app
        // restart (its recovery copy restored, or not) is something the ledger can't know.
        receipt["durability"] = json!("unverified");
    }
    Ok(receipt)
}

async fn create(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    if projects.is_empty() {
        return Err(not_enabled());
    }
    let project = match args.get("project").and_then(Value::as_str) {
        Some(name) => projects
            .iter()
            .find(|p| p.name == name)
            .cloned()
            .ok_or_else(|| {
                ToolError::new("OUT_OF_SCOPE", format!("{name} isn't a folder agents may use."))
                    .details(json!({"projects": projects.iter().map(|p| &p.name).collect::<Vec<_>>()}))
            })?,
        None if projects.len() == 1 => projects[0].clone(),
        None => {
            return Err(ToolError::new(
                "INVALID_INPUT",
                "More than one folder is open to agents; say which with `project`.",
            )
            .details(json!({"path": "/project", "projects": projects.iter().map(|p| &p.name).collect::<Vec<_>>()})))
        }
    };
    let admission = admit(agent, "create_diagram", args, projects, |entry| {
        recover_create(&agent.index, projects, entry)
    })
    .await?;
    let (key, fp, _guard) = match admission {
        Admission::Replay(receipt) => return Ok(receipt),
        Admission::Go { key, fp, guard } => (key, fp, guard),
    };

    // A second diagram with a title that is already there is nearly always a follow-up mistaken for a
    // new request. Refused, naming the one that exists, unless a separate diagram is asked for — checked
    // after the ledger, so the retry of a create that succeeded is answered from it, not refused here.
    let title_asked = args
        .get("title")
        .and_then(Value::as_str)
        .map(title_key)
        .unwrap_or_default();
    if !title_asked.is_empty()
        && args.get("allowDuplicateTitle").and_then(Value::as_bool) != Some(true)
    {
        let same: Vec<Value> = agent
            .index
            .list(std::slice::from_ref(&project))
            .into_iter()
            .filter(|d| title_key(&d.title) == title_asked)
            .take(5)
            .map(|d| json!({"diagramId": d.diagram_id, "title": d.title, "revision": d.revision, "path": d.path}))
            .collect();
        if !same.is_empty() {
            let e = ToolError::new(
                "DUPLICATE_TITLE",
                "A diagram with this title already exists in that folder. Nothing was created.",
            )
            .hint("If the person is talking about that diagram, change it with update_diagram using its diagramId. Only if they asked for a separate diagram, send this again with allowDuplicateTitle: true, or with a distinct title.")
            .details(json!({"candidates": same}));
            fail(agent, &key, &e);
            return Err(e);
        }
    }

    let diagram_id = format!("d_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    record(
        agent,
        Entry {
            key: key.clone(),
            tool: "create_diagram".into(),
            fingerprint: fp,
            stage: Stage::Pending,
            at: now_ms(),
            diagram_id: Some(diagram_id.clone()),
            path: None,
            receipt: None,
        },
    )?;

    let context = json!({"diagramId": diagram_id, "project": project.name});
    let composed = match to_page(agent, app, "create_diagram", args, context, calls).await {
        Ok(v) => v,
        Err(e) => {
            fail(agent, &key, &e);
            return Err(e);
        }
    };
    let text = composed
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let title = composed
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Diagram")
        .to_string();
    if scope::identity_of(&text).map(|(id, _)| id) != Some(diagram_id.clone()) {
        let e = ToolError::new(
            "INTERNAL",
            "The composed diagram didn't carry its assigned id.",
        );
        fail(agent, &key, &e);
        return Err(e);
    }
    ensure_document_size(text.len()).map_err(|e| {
        let e = ToolError::new("LIMIT_EXCEEDED", e.message);
        fail(agent, &key, &e);
        e
    })?;

    // The write, recorded first so a crash during it is recoverable by looking for the id.
    let folder = project.root.clone();
    let file = unique_name(&folder, &sanitize_stem(&title), &format!(".{DOC_EXT}"));
    let target = folder.join(file);
    let now = now_ms();
    agent
        .with_ledger(|l| {
            l.advance(&key, Stage::Committing, now, |e| {
                e.path = Some(target.to_string_lossy().into())
            })
        })
        .ok_or_else(ledger_unavailable)?
        .map_err(|_| ledger_unavailable())?;
    let stamp = match create_new_atomic(&target, text.as_bytes()) {
        Ok(stamp) => stamp,
        Err(e) => {
            let e = ToolError::new("PERSISTENCE_FAILED", e.message)
                .hint("Nothing was created. Retry with the same requestId.");
            fail(agent, &key, &e);
            return Err(e);
        }
    };
    let rel = target
        .strip_prefix(&project.root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let mut receipt = composed
        .get("receipt")
        .cloned()
        .unwrap_or_else(|| json!({}));
    receipt["diagramId"] = json!(diagram_id);
    receipt["title"] = json!(title);
    receipt["revision"] = json!(scope::file_revision_of_stamp(&stamp).unwrap_or_default());
    receipt["persisted"] = json!(true);
    receipt["state"] = json!("saved");
    receipt["path"] = json!(rel);
    receipt["opened"] = json!(false);
    agent.sessions.note(
        &calls.session,
        super::session::Recent {
            diagram_id: diagram_id.clone(),
            title: title.clone(),
            revision: receipt["revision"].as_str().unwrap_or_default().to_string(),
        },
    );
    let now = now_ms();
    let stored = receipt.clone();
    agent
        .with_ledger(|l| l.advance(&key, Stage::Committed, now, |e| e.receipt = Some(stored)))
        .ok_or_else(ledger_unavailable)?
        .map_err(|_| ledger_unavailable())?;

    // Opening is a side effect of *this* answer only; a replay never repeats it. Asked for by the agent
    // (`open`), or by the page when the person watched it being made where it replaces nothing.
    let open_asked = args.get("open").and_then(Value::as_bool) == Some(true)
        || composed.get("openAfter").and_then(Value::as_bool) == Some(true);
    if open_asked {
        let state = app.state::<AppState>();
        if let Ok(handle) = state.grant_file(&target) {
            let context = json!({
                "handle": handle,
                "name": crate::paths::doc_stem(&target),
                "displayPath": display_path(&target),
                "revision": receipt["revision"],
            });
            match to_page(agent, app, "open_created", &json!({}), context, calls).await {
                Ok(opened) => {
                    receipt["opened"] = opened.get("opened").cloned().unwrap_or(json!(false));
                    if let Some(reason) = opened.get("reason") {
                        receipt["openReason"] = reason.clone();
                    }
                    // The file revision stays: it is valid while the opened document is unchanged,
                    // and after it is closed or the app restarts, which an editor revision isn't.
                }
                Err(e) => receipt["openReason"] = json!(e.message),
            }
        }
    }
    if receipt["opened"] != json!(true) {
        // Not on screen: the page offers to open it.
        let state = app.state::<AppState>();
        state.events.emit(HostEvent::AgentFileWritten {
            id: calls.current().unwrap_or(0),
            handle: state.grant_file(&target).ok(),
            display_path: display_path(&target),
            stamp: stamp.clone(),
            created: true,
        });
    }
    Ok(receipt)
}

/// What an unfinished create left behind, after a crash. The proof it reached the disk is the id minted
/// for this request (and recorded before anything was written) inside a file in scope — nothing else
/// could have put it there. No such file: nothing was written, and the request may run again.
pub(crate) fn recover_create(
    index: &scope::DiagramIndex,
    projects: &[Project],
    entry: &Entry,
) -> Option<Value> {
    let id = entry.diagram_id.as_deref()?;
    let diagram = index.find(projects, id).ok()?;
    let text = read_document(&diagram.absolute).ok()?.text;
    Some(json!({
        "diagramId": id,
        "revision": scope::file_revision(&text),
        "persisted": true,
        "state": "saved",
        "opened": false,
        "path": diagram.path,
        "recovered": true,
    }))
}

fn record(agent: &Agent, entry: Entry) -> Result<(), ToolError> {
    agent
        .with_ledger(|l| l.record(entry))
        .ok_or_else(ledger_unavailable)?
        .map_err(|_| ledger_unavailable())
}

/// A request refused before anything changed: it may run again under the same id.
fn fail(agent: &Agent, key: &str, error: &ToolError) {
    let now = now_ms();
    let code = error.code;
    let _ = agent.with_ledger(|l| {
        l.advance(key, Stage::Failed, now, |e| {
            e.receipt = Some(json!({"error": code}))
        })
    });
}

// ─── update_diagram ─────────────────────────────────────────────────────────────────────────────

async fn update(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    let id = diagram_id(args)?;
    let diagram = locate(agent, projects, &id)?;
    let admission = admit(agent, "update_diagram", args, projects, |_| None).await?;
    let (key, fp, _guard) = match admission {
        Admission::Replay(receipt) => return Ok(receipt),
        Admission::Go { key, fp, guard } => (key, fp, guard),
    };
    record(
        agent,
        Entry {
            key: key.clone(),
            tool: "update_diagram".into(),
            fingerprint: fp,
            stage: Stage::Pending,
            at: now_ms(),
            diagram_id: Some(id),
            path: Some(diagram.absolute.to_string_lossy().into()),
            receipt: None,
        },
    )?;
    // A diagram that isn't open is changed on disk (the page works the change out from this text, and
    // this module writes it under the stamp read here); an open one through the editor.
    let context = diagram_context(agent, &diagram, true)?;
    let stamp_read = context
        .get("stamp")
        .and_then(Value::as_str)
        .map(str::to_string);
    let (page_id, rx) = agent.page.register();
    let sent = app
        .state::<AppState>()
        .events
        .emit(HostEvent::AgentRequest {
            id: page_id,
            tool: "update_diagram".into(),
            args: args.clone(),
            context,
        });
    if !sent {
        agent.page.forget(page_id);
        let e = ToolError::new(
            "APP_STARTING",
            "Draft Canvas's window hasn't finished loading.",
        )
        .retryable();
        fail(agent, &key, &e);
        return Err(e);
    }
    calls.track(agent, page_id);
    // The ledger learns the moment the page passes its gate (see `gate_passed`), so a crash after that
    // is reported as an unknown outcome, never retried blindly.
    crate::util::lock(&agent.gates).insert(page_id, key.clone());
    let answer = agent.page.wait(page_id, rx, Budgets::default()).await;
    calls.untrack(agent, page_id);
    crate::util::lock(&agent.gates).remove(&page_id);
    let passed_gate = agent
        .with_ledger(|l| l.get(&key).map(|e| e.stage == Stage::Committing))
        .flatten()
        .unwrap_or(false);
    match answer {
        Err(Failure::OutcomeUnknown) => Err(outcome_unknown()),
        Err(failure) => {
            let e = failure_error(failure);
            if !passed_gate {
                fail(agent, &key, &e);
            }
            Err(e)
        }
        Ok(value) if value.get("ok").and_then(Value::as_bool) == Some(true) => {
            let mut receipt = value.get("value").cloned().unwrap_or(Value::Null);
            if let Some(write) = receipt.get("write").cloned() {
                receipt = write_in_background(
                    agent,
                    app,
                    &diagram,
                    &key,
                    passed_gate,
                    stamp_read.as_deref(),
                    page_id,
                    &write,
                    receipt,
                )?;
            }
            let now = now_ms();
            let stored = receipt.clone();
            let _ = agent.with_ledger(|l| {
                l.advance(&key, Stage::Committed, now, |e| e.receipt = Some(stored))
            });
            if let (Some(revision), Some(title)) = (
                receipt.get("revision").and_then(Value::as_str),
                receipt.get("title").and_then(Value::as_str),
            ) {
                agent.sessions.note(
                    &calls.session,
                    super::session::Recent {
                        diagram_id: diagram.diagram_id.clone(),
                        title: title.to_string(),
                        revision: revision.to_string(),
                    },
                );
            }
            Ok(receipt)
        }
        Ok(value) => {
            // A refusal. The page says whether anything was applied; nothing was unless it says so.
            let e = page_error(value.get("error"));
            if value.get("applied").and_then(Value::as_bool) == Some(true) {
                let now = now_ms();
                let _ = agent.with_ledger(|l| {
                    l.advance(&key, Stage::Committed, now, |entry| {
                        entry.receipt = Some(e.to_value())
                    })
                });
            } else {
                fail(agent, &key, &e);
            }
            Err(e)
        }
    }
}

/// The second half of an update to a diagram that isn't open. The page worked the change out from the
/// text `diagram_context` read, passed its gate, and handed back the new text; it is written only if
/// the file is still exactly what was read — so an edit made meanwhile in another app, or by a sync,
/// is never overwritten. The page is told afterwards, so it can offer to show the change (and undo
/// it) the next time that file is opened.
#[allow(clippy::too_many_arguments)]
fn write_in_background(
    agent: &Agent,
    app: &AppHandle,
    diagram: &Diagram,
    key: &str,
    passed_gate: bool,
    stamp: Option<&str>,
    page_id: u64,
    write: &Value,
    mut receipt: Value,
) -> Result<Value, ToolError> {
    let refuse = |e: ToolError| {
        fail(agent, key, &e);
        e
    };
    let text = write.get("text").and_then(Value::as_str).unwrap_or("");
    let Some(stamp) = stamp.filter(|_| passed_gate && !text.is_empty()) else {
        return Err(refuse(ToolError::new(
            "INTERNAL",
            "The change couldn't be written safely. Nothing changed.",
        )));
    };
    if scope::identity_of(text).map(|(id, _)| id) != Some(diagram.diagram_id.clone()) {
        return Err(refuse(ToolError::new(
            "INTERNAL",
            "The changed diagram didn't keep its id. Nothing changed.",
        )));
    }
    ensure_document_size(text.len())
        .map_err(|e| refuse(ToolError::new("LIMIT_EXCEEDED", e.message)))?;
    match write_atomic(&diagram.absolute, text.as_bytes(), Some(stamp)) {
        Ok(WriteOutcome::Saved { stamp }) => {
            if let Some(map) = receipt.as_object_mut() {
                map.remove("write");
            }
            receipt["revision"] = json!(scope::file_revision_of_stamp(&stamp).unwrap_or_default());
            receipt["persisted"] = json!(true);
            receipt["state"] = json!("saved");
            receipt["where"] = json!("file");
            let state = app.state::<AppState>();
            state.events.emit(HostEvent::AgentFileWritten {
                id: page_id,
                handle: state.grant_file(&diagram.absolute).ok(),
                display_path: display_path(&diagram.absolute),
                stamp,
                created: false,
            });
            Ok(receipt)
        }
        Ok(WriteOutcome::Conflict) => {
            let current = read_document(&diagram.absolute)
                .ok()
                .map(|r| scope::file_revision(&r.text));
            Err(refuse(
                ToolError::new(
                    "REVISION_CONFLICT",
                    "The file changed on disk while the edit was being prepared. Nothing changed.",
                )
                .hint("Read the diagram again and rebuild the change on the current revision. Don't create a replacement diagram.")
                .details(json!({"currentRevision": current})),
            ))
        }
        Err(e) if e.kind == crate::errors::ErrorKind::ReadOnly => {
            Err(refuse(ToolError::new("READ_ONLY", e.message)))
        }
        Err(e) => Err(refuse(
            ToolError::new("PERSISTENCE_FAILED", e.message)
                .hint("Nothing was changed. Retry with the same requestId."),
        )),
    }
}

// ─── submit_proposal, get_proposal, list_proposals ─────────────────────────────────────────────────
//
// A proposal is never committed from this module — the page's `submit_proposal` handler only
// validates and dry-runs (see `src/agent/proposal.ts`), and resolving one (accept/reject/dismiss) is
// a Tauri command the review UI calls directly (Phase 4b's `agent_proposal_resolve`), never a tool in
// `TOOLS` above and never reachable from `call()`'s dispatch — there is no wire path for an MCP
// client to reach it, not merely an unadvertised one.

async fn submit_proposal(
    agent: &Agent,
    app: &AppHandle,
    projects: &[Project],
    args: &Value,
    calls: &CallRegistry,
) -> ToolResult {
    let id = diagram_id(args)?;
    let diagram = locate(agent, projects, &id)?;

    let admission = admit(agent, "submit_proposal", args, projects, |entry| {
        recover_submit_proposal(agent, entry)
    })
    .await?;
    let (key, fp, _guard) = match admission {
        Admission::Replay(receipt) => return Ok(receipt),
        Admission::Go { key, fp, guard } => (key, fp, guard),
    };

    // A revise is only ever checked here, on a *fresh* admission — a replay above already returned
    // the original call's own receipt, whatever the proposal's status has become since.
    let revises = args
        .get("revises")
        .and_then(Value::as_str)
        .map(str::to_string);
    let existing = match &revises {
        Some(rid) => {
            match agent.with_proposals(|s| s.get(rid).cloned()).flatten() {
                None => {
                    let e = ToolError::new("NOT_FOUND", format!("No proposal with id {rid}."));
                    fail(agent, &key, &e);
                    return Err(e);
                }
                Some(p) if p.status != ProposalStatus::Pending => {
                    let e = ToolError::new(
                    "PROPOSAL_CLOSED",
                    format!("That proposal is already {:?}; submit a new one instead of revising it.", p.status),
                );
                    fail(agent, &key, &e);
                    return Err(e);
                }
                Some(p) => Some(p),
            }
        }
        None => None,
    };

    // Minted (or reused, for a revise) before the page round-trip: the evidence a crash recovery
    // looks for, the same discipline `create_diagram` uses for its own minted id (see `recover_create`).
    let proposal_id = revises
        .clone()
        .unwrap_or_else(|| format!("p_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]));
    record(
        agent,
        Entry {
            key: key.clone(),
            tool: "submit_proposal".into(),
            fingerprint: fp,
            stage: Stage::Pending,
            at: now_ms(),
            diagram_id: Some(proposal_id.clone()),
            path: Some(diagram.absolute.to_string_lossy().into()),
            receipt: None,
        },
    )?;

    let context = diagram_context(agent, &diagram, true)?;
    let composed = match to_page(agent, app, "submit_proposal", args, context, calls).await {
        Ok(v) => v,
        Err(e) => {
            fail(agent, &key, &e);
            return Err(e);
        }
    };

    let now = now_ms();
    let version = existing.as_ref().map_or(1, |p| p.version + 1);
    let created_at = existing.as_ref().map_or(now, |p| p.created_at);
    let no_impact = composed
        .get("noImpact")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let status = if no_impact {
        ProposalStatus::Informational
    } else {
        ProposalStatus::Pending
    };
    let path: Vec<String> = composed
        .get("path")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let strings = |key: &str| -> Vec<String> {
        composed
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };

    let proposal = Proposal {
        id: proposal_id.clone(),
        version,
        diagram_id: id.clone(),
        path,
        status,
        base_revision: composed
            .get("baseRevision")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        ops: composed.get("ops").cloned().unwrap_or_else(|| json!([])),
        layout: composed.get("layout").cloned().filter(|v| !v.is_null()),
        counts: composed.get("counts").cloned().unwrap_or_else(|| json!({})),
        preconditions: composed
            .get("preconditions")
            .cloned()
            .unwrap_or_else(|| json!({})),
        summary: composed
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        rationale: composed
            .get("rationale")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        assumptions: strings("assumptions"),
        open_questions: strings("openQuestions"),
        source_ref: composed.get("sourceRef").cloned().filter(|v| !v.is_null()),
        created_at,
        updated_at: now,
        resolved_at: if no_impact { Some(now) } else { None },
    };

    match agent.with_proposals(|s| s.put(proposal.clone())) {
        Some(Ok(())) => {}
        _ => {
            let e = ToolError::new(
                "INTERNAL",
                "The proposal couldn't be saved. Nothing was recorded.",
            )
            .hint("Retry with the same requestId.");
            fail(agent, &key, &e);
            return Err(e);
        }
    }

    let receipt = json!({
        "proposalId": proposal_id,
        "version": version,
        "status": serde_json::to_value(status).unwrap_or(Value::Null),
        "diagramId": id,
        "revision": proposal.base_revision,
        "counts": proposal.counts,
        "advisories": composed.get("advisories").cloned().unwrap_or_else(|| json!([])),
    });
    let stored = receipt.clone();
    let _ =
        agent.with_ledger(|l| l.advance(&key, Stage::Committed, now, |e| e.receipt = Some(stored)));
    Ok(receipt)
}

/// What an unfinished `submit_proposal` left behind, after a crash. Mirrors `recover_create`: the
/// evidence is the proposal id minted for this request before anything was written — found, it proves
/// the store write succeeded even though the ledger never heard; not found, nothing happened, and the
/// request may run from scratch (the page round-trip has no side effect of its own to repeat safely).
fn recover_submit_proposal(agent: &Agent, entry: &Entry) -> Option<Value> {
    let proposal_id = entry.diagram_id.as_deref()?;
    let proposal = agent
        .with_proposals(|s| s.get(proposal_id).cloned())
        .flatten()?;
    Some(json!({
        "proposalId": proposal.id,
        "version": proposal.version,
        "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null),
        "diagramId": proposal.diagram_id,
        "revision": proposal.base_revision,
        "counts": proposal.counts,
        "recovered": true,
    }))
}

fn get_proposal(agent: &Agent, projects: &[Project], args: &Value) -> ToolResult {
    let proposal_id = args
        .get("proposalId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ToolError::new("INVALID_INPUT", "proposalId is required.")
                .details(json!({"path": "/proposalId"}))
        })?;
    let proposal = agent
        .with_proposals(|s| s.get(proposal_id).cloned())
        .flatten()
        .ok_or_else(|| {
            ToolError::new("NOT_FOUND", format!("No proposal with id {proposal_id}."))
        })?;
    // Re-checked on every read, not cached from submit time: a folder disabled since then hides it.
    let diagram = locate(agent, projects, &proposal.diagram_id)?;
    Ok(proposal_receipt(&proposal, &diagram))
}

fn list_proposals(agent: &Agent, projects: &[Project], args: &Value) -> ToolResult {
    let diagram_filter = args.get("diagramId").and_then(Value::as_str);
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, LIST_PAGE_MAX))
        .unwrap_or(LIST_PAGE_MAX);
    let offset = args
        .get("cursor")
        .and_then(Value::as_str)
        .and_then(|c| c.strip_prefix("o:"))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    let all: Vec<Proposal> = agent
        .with_proposals(|s| s.list(diagram_filter).into_iter().cloned().collect())
        .unwrap_or_default();
    // Only proposals whose diagram is still in a folder agents may use are visible — the same live
    // scope re-check `get_proposal` makes, so nothing here trusts a grant from submit time.
    let byid: HashMap<String, Diagram> = agent
        .index
        .list(projects)
        .into_iter()
        .map(|d| (d.diagram_id.clone(), d))
        .collect();
    let in_scope: Vec<&Proposal> = all
        .iter()
        .filter(|p| byid.contains_key(&p.diagram_id))
        .collect();
    let page: Vec<Value> = in_scope
        .iter()
        .skip(offset)
        .take(limit)
        .map(|p| proposal_summary(p, byid.get(&p.diagram_id)))
        .collect();
    let next = offset + page.len();
    let mut result = json!({ "proposals": page, "complete": next >= in_scope.len() });
    if next < in_scope.len() {
        result["cursor"] = json!(format!("o:{next}"));
    }
    Ok(result)
}

fn proposal_receipt(proposal: &Proposal, diagram: &Diagram) -> Value {
    json!({
        "proposalId": proposal.id,
        "version": proposal.version,
        "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null),
        "diagramId": proposal.diagram_id,
        "summary": proposal.summary,
        "counts": proposal.counts,
        "stale": proposal.base_revision != diagram.revision,
        "createdAt": proposal.created_at,
        "updatedAt": proposal.updated_at,
    })
}

fn proposal_summary(proposal: &Proposal, diagram: Option<&Diagram>) -> Value {
    json!({
        "proposalId": proposal.id,
        "diagramId": proposal.diagram_id,
        "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null),
        "summary": proposal.summary,
        "stale": diagram.is_some_and(|d| proposal.base_revision != d.revision),
        "updatedAt": proposal.updated_at,
    })
}

/// Called from `agent_progress`: a short stage phrase for the call working on `page_id`, passed to
/// its agent as a progress frame. Best effort — a full or closed connection just misses one.
pub fn progress(agent: &Agent, page_id: u64, message: &str) {
    let sink = crate::util::lock(&agent.progress).get(&page_id).cloned();
    if let Some((out, call)) = sink {
        let message: String = message.chars().take(120).collect();
        let _ = out.try_send(json!({"type": "progress", "id": call, "message": message}));
    }
}

/// Called from `agent_gate`: the page is about to change the document for `page_id`.
pub fn gate_passed(agent: &Agent, page_id: u64) -> bool {
    if !agent.page.gate(page_id) {
        return false;
    }
    let key = crate::util::lock(&agent.gates).get(&page_id).cloned();
    if let Some(key) = key {
        let now = now_ms();
        let written = agent
            .with_ledger(|l| l.advance(&key, Stage::Committing, now, |_| {}))
            .map(|r| r.is_ok())
            .unwrap_or(false);
        if !written {
            // The ledger couldn't record the gate: going ahead would make a crash unrecoverable.
            agent.page.cancel(page_id);
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_match_ignoring_case_and_spacing_but_not_words() {
        assert_eq!(title_key("  Order   Processing "), "order processing");
        assert_eq!(title_key("ORDER processing"), title_key("Order Processing"));
        assert_ne!(
            title_key("Order Processing v2"),
            title_key("Order Processing")
        );
        assert!(title_key("Order Processing v2").contains(&title_key("processing")));
    }

    #[test]
    fn a_fingerprint_ignores_key_order_and_the_request_id() {
        let a = json!({"requestId": "1", "title": "T", "nodes": [{"id": "a", "label": "A"}]});
        let b = json!({"nodes": [{"label": "A", "id": "a"}], "title": "T", "requestId": "2"});
        assert_eq!(
            fingerprint("create_diagram", &a),
            fingerprint("create_diagram", &b)
        );
        let c = json!({"nodes": [{"label": "B", "id": "a"}], "title": "T"});
        assert_ne!(
            fingerprint("create_diagram", &a),
            fingerprint("create_diagram", &c)
        );
        assert_ne!(
            fingerprint("create_diagram", &a),
            fingerprint("update_diagram", &a)
        );
    }

    #[test]
    fn page_errors_keep_only_documented_codes() {
        let known = page_error(Some(
            &json!({"code": "REVISION_CONFLICT", "message": "stale"}),
        ));
        assert_eq!(known.code, "REVISION_CONFLICT");
        let unknown = page_error(Some(&json!({"code": "SOMETHING_NEW", "message": "x"})));
        assert_eq!(unknown.code, "INTERNAL");
    }

    fn pending_create(id: &str) -> Entry {
        Entry {
            key: "create_diagram:r".into(),
            tool: "create_diagram".into(),
            fingerprint: "f".into(),
            stage: Stage::Committing,
            at: 0,
            diagram_id: Some(id.into()),
            path: None,
            receipt: None,
        }
    }

    #[test]
    fn a_crash_after_the_file_was_written_recovers_the_create_by_its_minted_id() {
        let dir = tempfile::tempdir().unwrap();
        let projects = vec![Project {
            root: dunce::canonicalize(dir.path()).unwrap(),
            name: "P".into(),
        }];
        let index = scope::DiagramIndex::default();
        // The crash came before the file: nothing to recover, so the request may run again.
        assert_eq!(
            recover_create(&index, &projects, &pending_create("d_minted00001")),
            None
        );
        // The crash came after the file, before the ledger heard: found by the id minted for it.
        std::fs::write(
            dir.path().join("Shop.draftcanvas"),
            r#"{"format":"draft-canvas","version":15,"metadata":{"id":"d_minted00001","title":"Shop"}}"#,
        )
        .unwrap();
        let receipt = recover_create(&index, &projects, &pending_create("d_minted00001")).unwrap();
        assert_eq!(receipt["recovered"], json!(true));
        assert_eq!(receipt["path"], json!("Shop.draftcanvas"));
        // A file with some other id proves nothing about this request.
        assert_eq!(
            recover_create(&index, &projects, &pending_create("d_other000001")),
            None
        );
    }

    #[test]
    fn a_replayed_unsaved_receipt_says_its_durability_is_unverified() {
        let entry = Entry {
            key: "k".into(),
            tool: "update_diagram".into(),
            fingerprint: "f".into(),
            stage: Stage::Committed,
            at: 0,
            diagram_id: None,
            path: None,
            receipt: Some(json!({"persisted": false, "state": "applied-unsaved"})),
        };
        let receipt = replay_receipt(&entry, &[]).unwrap();
        assert_eq!(receipt["replayed"], json!(true));
        assert_eq!(receipt["durability"], json!("unverified"));
    }

    fn stored_proposal(
        id: &str,
        diagram_id: &str,
        status: ProposalStatus,
        updated_at: u64,
    ) -> Proposal {
        Proposal {
            id: id.into(),
            version: 1,
            diagram_id: diagram_id.into(),
            path: vec![],
            status,
            base_revision: "o:1.1".into(),
            ops: json!([{ "op": "update", "id": "a", "set": { "label": "New" } }]),
            layout: None,
            counts: json!({"added": 0, "updated": 1, "removed": 0}),
            preconditions: json!({}),
            summary: "Summary".into(),
            rationale: String::new(),
            assumptions: vec![],
            open_questions: vec![],
            source_ref: None,
            created_at: updated_at,
            updated_at,
            resolved_at: None,
        }
    }

    fn diagram_project(
        dir: &std::path::Path,
        name: &str,
        title: &str,
        diagram_id: &str,
    ) -> Project {
        std::fs::write(
            dir.join(format!("{title}.draftcanvas")),
            format!(r#"{{"format":"draft-canvas","version":15,"metadata":{{"id":"{diagram_id}","title":"{title}"}}}}"#),
        )
        .unwrap();
        Project {
            root: dunce::canonicalize(dir).unwrap(),
            name: name.into(),
        }
    }

    #[test]
    fn a_pending_submit_proposal_recovers_by_its_minted_id_once_the_store_holds_it() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Agent::new(dir.path());
        let entry = Entry {
            key: "submit_proposal:r".into(),
            tool: "submit_proposal".into(),
            fingerprint: "f".into(),
            stage: Stage::Pending,
            at: 0,
            diagram_id: Some("p_minted00001".into()),
            path: None,
            receipt: None,
        };
        // The crash came before the store write: nothing to recover, so the request may run again.
        assert_eq!(recover_submit_proposal(&agent, &entry), None);
        agent
            .with_proposals(|s| {
                s.put(stored_proposal(
                    "p_minted00001",
                    "d_1",
                    ProposalStatus::Pending,
                    1,
                ))
            })
            .unwrap()
            .unwrap();
        // The crash came after the store write, before the ledger heard: found by the minted id.
        let receipt = recover_submit_proposal(&agent, &entry).unwrap();
        assert_eq!(receipt["recovered"], json!(true));
        assert_eq!(receipt["proposalId"], json!("p_minted00001"));
        assert_eq!(receipt["version"], json!(1));
    }

    #[test]
    fn get_proposal_reports_status_and_staleness_against_the_live_diagram_revision() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Agent::new(dir.path());
        let project = diagram_project(dir.path(), "P", "Orders", "d_orders0001");
        agent
            .with_proposals(|s| {
                s.put(stored_proposal(
                    "p1",
                    "d_orders0001",
                    ProposalStatus::Pending,
                    1,
                ))
            })
            .unwrap()
            .unwrap();
        let receipt = get_proposal(&agent, &[project], &json!({"proposalId": "p1"})).unwrap();
        assert_eq!(receipt["status"], json!("pending"));
        assert_eq!(receipt["summary"], json!("Summary"));
        // The proposal's base revision won't match a freshly indexed file's own revision.
        assert_eq!(receipt["stale"], json!(true));
    }

    #[test]
    fn get_proposal_refuses_one_whose_diagram_left_the_enabled_folders() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Agent::new(dir.path());
        agent
            .with_proposals(|s| {
                s.put(stored_proposal(
                    "p1",
                    "d_gone00001",
                    ProposalStatus::Pending,
                    1,
                ))
            })
            .unwrap()
            .unwrap();
        let error = get_proposal(&agent, &[], &json!({"proposalId": "p1"})).unwrap_err();
        assert_eq!(error.code, "NOT_ENABLED");
    }

    #[test]
    fn list_proposals_paginates_and_hides_out_of_scope_diagrams() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Agent::new(dir.path());
        let project = diagram_project(dir.path(), "P", "Orders", "d_orders0001");
        agent
            .with_proposals(|s| {
                s.put(stored_proposal(
                    "older",
                    "d_orders0001",
                    ProposalStatus::Pending,
                    1,
                ))?;
                s.put(stored_proposal(
                    "newer",
                    "d_orders0001",
                    ProposalStatus::Pending,
                    2,
                ))?;
                s.put(stored_proposal(
                    "hidden",
                    "d_not_enabled",
                    ProposalStatus::Pending,
                    3,
                ))
            })
            .unwrap()
            .unwrap();
        let result = list_proposals(&agent, &[project], &json!({"limit": 1})).unwrap();
        let page = result["proposals"].as_array().unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["proposalId"], json!("newer"), "newest first");
        assert_eq!(result["complete"], json!(false));
        let cursor = result["cursor"].as_str().unwrap().to_string();
        let next = list_proposals(
            &agent,
            &[Project {
                root: dunce::canonicalize(dir.path()).unwrap(),
                name: "P".into(),
            }],
            &json!({"cursor": cursor}),
        )
        .unwrap();
        let next_page = next["proposals"].as_array().unwrap();
        assert_eq!(next_page.len(), 1);
        assert_eq!(next_page[0]["proposalId"], json!("older"));
        assert_eq!(
            next["complete"],
            json!(true),
            "the out-of-scope proposal is excluded, not just hidden past the page"
        );
    }
}
