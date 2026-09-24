//! The page's side of the agent bridge (`agent/`): answering requests, and the Settings controls.

use super::projects::project_info;
use super::run_blocking;
use crate::agent::proposals::{Proposal, ProposalStatus};
use crate::agent::scope::{self, enabled_projects};
use crate::agent::{broker, sidecar_path, sidecar_warning, Agent, AgentStatus, BackgroundSupport};
use crate::errors::{AppError, ErrorKind};
use crate::state::{AppState, HostEvent};
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// The page has the request and is working on it.
#[tauri::command]
pub async fn agent_ack(agent: State<'_, Arc<Agent>>, id: u64) -> Result<(), AppError> {
    agent.page.ack(id);
    Ok(())
}

/// The commit gate: true means go ahead and change the document; false means the request expired or
/// was cancelled, and nothing may be changed for it.
#[tauri::command]
pub async fn agent_gate(agent: State<'_, Arc<Agent>>, id: u64) -> Result<bool, AppError> {
    Ok(broker::gate_passed(&agent, id))
}

/// The person cancelled a request from the status line. Only a request still before its commit gate
/// can be cancelled (the gate then refuses it, and nothing changes); `false` means it was already
/// being applied — Undo is the way back from that.
#[tauri::command]
pub async fn agent_cancel(agent: State<'_, Arc<Agent>>, id: u64) -> Result<bool, AppError> {
    Ok(agent.page.cancel(id))
}

/// Where a request is, told to the agent that sent it as MCP progress (when its client asked for
/// progress): a short stage phrase, never document content or geometry.
#[tauri::command]
pub async fn agent_progress(
    agent: State<'_, Arc<Agent>>,
    id: u64,
    message: String,
) -> Result<(), AppError> {
    broker::progress(&agent, id, &message);
    Ok(())
}

#[tauri::command]
pub async fn agent_respond(
    agent: State<'_, Arc<Agent>>,
    id: u64,
    outcome: Value,
) -> Result<(), AppError> {
    agent.page.respond(id, outcome);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProject {
    pub handle: String,
    pub name: String,
    pub display_path: String,
    pub agent: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    #[serde(flatten)]
    pub status: AgentStatus,
    pub projects: Vec<AgentProject>,
}

fn background(agent: &Agent) -> BackgroundSupport {
    if agent.background_ready.load(Ordering::SeqCst) {
        BackgroundSupport::Ready
    } else if cfg!(target_os = "macos") && crate::lifecycle::can_keep_running_hidden() {
        BackgroundSupport::RestartNeeded
    } else {
        BackgroundSupport::Unverified
    }
}

fn settings_of(state: &AppState, agent: &Agent) -> AgentSettings {
    let settings = state.settings.get();
    let sidecar = sidecar_path();
    let projects = settings
        .projects
        .iter()
        .filter_map(|p| {
            let info = project_info(state, Path::new(&p.path)).ok()?;
            Some(AgentProject {
                handle: info.handle,
                name: info.name,
                display_path: info.display_path,
                agent: p.agent,
            })
        })
        .collect();
    AgentSettings {
        status: AgentStatus {
            enabled: settings.agent_access,
            listening: agent.is_running(),
            connections: agent.connections(),
            sidecar_warning: sidecar.as_deref().and_then(sidecar_warning),
            sidecar_path: sidecar.map(|p| p.to_string_lossy().into_owned()),
            background: background(agent),
        },
        projects,
    }
}

#[tauri::command]
pub async fn agent_status(app: AppHandle) -> Result<AgentSettings, AppError> {
    run_blocking(&app, |app, state| {
        let agent = app.state::<Arc<Agent>>();
        Ok(settings_of(state, &agent))
    })
    .await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPatch {
    pub enabled: Option<bool>,
    /// A project folder, by handle, and whether agents may use it.
    pub project: Option<ProjectAccess>,
    /// Issue a new token: every connected agent is turned away and must reconnect.
    pub rotate: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAccess {
    pub handle: String,
    pub agent: bool,
}

pub(crate) fn configure(
    state: &AppState,
    agent: &Arc<Agent>,
    patch: AgentPatch,
) -> Result<(), AppError> {
    if let Some(access) = patch.project {
        let root = state.project(&access.handle)?.root;
        let path = root.to_string_lossy().into_owned();
        state.settings.update(|s| {
            for p in s.projects.iter_mut() {
                let same = dunce::canonicalize(&p.path).ok().as_deref() == Some(root.as_path())
                    || p.path == path;
                if same {
                    p.agent = access.agent;
                }
            }
        })?;
    }
    if let Some(enabled) = patch.enabled {
        state.settings.update(|s| s.agent_access = enabled)?;
        if enabled {
            agent.enable().map_err(|e| {
                AppError::new(
                    crate::errors::ErrorKind::Io,
                    format!("Agent access couldn't start: {e}"),
                )
            })?;
        } else {
            agent.disable();
        }
    }
    if patch.rotate == Some(true) && agent.is_running() {
        agent.disable();
        agent.enable().map_err(|e| {
            AppError::new(
                crate::errors::ErrorKind::Io,
                format!("Agent access couldn't restart: {e}"),
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_configure(app: AppHandle, patch: AgentPatch) -> Result<AgentSettings, AppError> {
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        configure(state, &agent, patch)?;
        state.events.emit(HostEvent::AgentChanged);
        Ok(settings_of(state, &agent))
    })
    .await
}

// ─── Proposal review (native UI only — never reachable from the MCP bridge; see `agent/broker.rs`) ──
//
// These four commands are the whole surface the review UI needs, and the whole surface that can ever
// resolve a proposal: `agent_ack`/`agent_gate`/... above answer the sidecar's requests, but nothing
// here is registered as (or reachable from) a tool the sidecar can call. Accept is deliberately split
// into two commands — `begin_accept` durably records `Accepting` *before* the document commit is
// attempted, `resolve` records the terminal outcome *after* — so a crash between them leaves clear,
// recoverable evidence (a proposal stuck at `Accepting`) instead of an ambiguous state. Deciding what
// that evidence means (Cases A/B/C: never applied, already applied, or genuinely unknown) is the
// review panel's job — `src/ui/Editor/ProposalPanel.tsx` — not this module's; it re-runs the same
// dry-run `prepareProposal` already uses and reads the outcome.

fn diagram_for(state: &AppState, agent: &Agent, diagram_id: &str) -> Option<scope::Diagram> {
    let projects = enabled_projects(state);
    agent
        .index
        .list(&projects)
        .into_iter()
        .find(|d| d.diagram_id == diagram_id)
}

/// The full record the review UI needs to render a diff and act on it. `stale` is a courtesy — the
/// panel always re-checks the live document itself before ever offering Accept.
fn proposal_json(proposal: &Proposal, diagram: Option<&scope::Diagram>) -> Value {
    json!({
        "proposalId": proposal.id,
        "version": proposal.version,
        "diagramId": proposal.diagram_id,
        "path": proposal.path,
        "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null),
        "baseRevision": proposal.base_revision,
        "ops": proposal.ops,
        "layout": proposal.layout,
        "preconditions": proposal.preconditions,
        "counts": proposal.counts,
        "summary": proposal.summary,
        "rationale": proposal.rationale,
        "assumptions": proposal.assumptions,
        "openQuestions": proposal.open_questions,
        "sourceRef": proposal.source_ref,
        "createdAt": proposal.created_at,
        "updatedAt": proposal.updated_at,
        "resolvedAt": proposal.resolved_at,
        "stale": diagram.is_some_and(|d| proposal.base_revision != d.revision),
    })
}

#[tauri::command]
pub async fn agent_proposal_list(
    app: AppHandle,
    diagram_id: Option<String>,
) -> Result<Vec<Value>, AppError> {
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        let all: Vec<Proposal> = agent
            .with_proposals(|s| s.list(diagram_id.as_deref()).into_iter().cloned().collect())
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't open the proposal store."))?;
        Ok(all
            .iter()
            .map(|p| proposal_json(p, diagram_for(state, &agent, &p.diagram_id).as_ref()))
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn agent_proposal_get(app: AppHandle, id: String) -> Result<Option<Value>, AppError> {
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        let proposal = agent
            .with_proposals(|s| s.get(&id).cloned())
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't open the proposal store."))?;
        Ok(proposal
            .as_ref()
            .map(|p| proposal_json(p, diagram_for(state, &agent, &p.diagram_id).as_ref())))
    })
    .await
}

/// Durably records `Pending → Accepting` *before* the review panel attempts the document commit —
/// checking the exact four things the spec calls for: proposal version, diagram identity, depth path
/// and (implicitly, by the panel re-snapshotting immediately before calling this) document revision.
/// Refuses without changing anything if any of the first three no longer match what the panel is
/// showing; the panel is expected to have already re-checked the document's own revision itself.
#[tauri::command]
pub async fn agent_proposal_begin_accept(
    app: AppHandle,
    id: String,
    version: u32,
    diagram_id: String,
    path: Vec<String>,
) -> Result<Value, AppError> {
    run_blocking(&app, move |app, _state| {
        let agent = app.state::<Arc<Agent>>();
        let Some(mut proposal) = agent
            .with_proposals(|s| s.get(&id).cloned())
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't open the proposal store."))?
        else {
            return Ok(json!({"ok": false, "code": "NOT_FOUND"}));
        };
        // `Accepting` is allowed here too — not just `Pending` — so a restart-recovered proposal the
        // review panel found was never actually committed (Case A) can simply be retried through the
        // ordinary flow, re-checked against the exact same identity, rather than needing a separate
        // "un-accept" transition back to `Pending` that would just be this same check again.
        if !matches!(proposal.status, ProposalStatus::Pending | ProposalStatus::Accepting) {
            return Ok(json!({"ok": false, "code": "WRONG_STAGE", "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null)}));
        }
        if proposal.version != version || proposal.diagram_id != diagram_id || proposal.path != path {
            return Ok(json!({"ok": false, "code": "PROPOSAL_CHANGED", "proposal": proposal_json(&proposal, None)}));
        }
        proposal.status = ProposalStatus::Accepting;
        agent
            .with_proposals(|s| s.put(proposal.clone()))
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't record the proposal was being accepted."))?
            .map_err(|e| AppError::new(ErrorKind::Io, format!("Couldn't record the proposal was being accepted: {e}")))?;
        Ok(json!({"ok": true, "proposal": proposal_json(&proposal, None)}))
    })
    .await
}

/// What the review UI may resolve a proposal to. Deliberately excludes `Pending`, `Accepting` and
/// `Informational`: those are never a person's explicit resolve action.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProposalResolution {
    Accepted,
    Rejected,
    Dismissed,
}

impl From<ProposalResolution> for ProposalStatus {
    fn from(value: ProposalResolution) -> Self {
        match value {
            ProposalResolution::Accepted => ProposalStatus::Accepted,
            ProposalResolution::Rejected => ProposalStatus::Rejected,
            ProposalResolution::Dismissed => ProposalStatus::Dismissed,
        }
    }
}

/// What resolving a proposal to `target` should do, given its `current` status — pulled out of the
/// command itself so the three cases (idempotent replay, conflicting terminal status, wrong stage)
/// are each a plain, testable rule rather than buried in a Tauri command's plumbing.
enum ResolveOutcome {
    /// Already exactly this status: succeed without writing anything again.
    AlreadyThere,
    /// A *different* terminal status is already recorded — never silently overridden.
    Conflict,
    /// Not reachable from here (e.g. "accepted" without `begin_accept` having run first).
    WrongStage,
    Proceed,
}

fn resolve_outcome(current: ProposalStatus, target: ProposalStatus) -> ResolveOutcome {
    if current == target {
        return ResolveOutcome::AlreadyThere;
    }
    if current.is_terminal() {
        return ResolveOutcome::Conflict;
    }
    let valid = matches!(
        (current, target),
        (ProposalStatus::Accepting, ProposalStatus::Accepted)
            | (
                ProposalStatus::Pending,
                ProposalStatus::Rejected | ProposalStatus::Dismissed
            )
            // A restart-recovered proposal the review panel could not explain (Case C: neither clearly
            // applied nor clearly not) is never reapplied or silently reopened — a person inspects the
            // document directly and, from there, dismisses it.
            | (ProposalStatus::Accepting, ProposalStatus::Dismissed)
    );
    if valid {
        ResolveOutcome::Proceed
    } else {
        ResolveOutcome::WrongStage
    }
}

/// The terminal transition — never a commit itself. Idempotent when the stored status already equals
/// `status`; refused with the *actual* stored status (never silently overridden) when it's a
/// different terminal one, or when the requested transition doesn't fit the proposal's current stage
/// (e.g. resolving "accepted" without having gone through `begin_accept` first).
#[tauri::command]
pub async fn agent_proposal_resolve(
    app: AppHandle,
    id: String,
    status: ProposalResolution,
) -> Result<Value, AppError> {
    let target = ProposalStatus::from(status);
    run_blocking(&app, move |app, _state| {
        let agent = app.state::<Arc<Agent>>();
        let Some(mut proposal) = agent
            .with_proposals(|s| s.get(&id).cloned())
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't open the proposal store."))?
        else {
            return Ok(json!({"ok": false, "code": "NOT_FOUND"}));
        };
        match resolve_outcome(proposal.status, target) {
            ResolveOutcome::AlreadyThere => Ok(json!({"ok": true, "proposal": proposal_json(&proposal, None)})),
            ResolveOutcome::Conflict => Ok(json!({"ok": false, "code": "ALREADY_RESOLVED", "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null)})),
            ResolveOutcome::WrongStage => Ok(json!({"ok": false, "code": "WRONG_STAGE", "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null)})),
            ResolveOutcome::Proceed => {
                proposal.status = target;
                proposal.resolved_at = Some(now_ms());
                agent
                    .with_proposals(|s| s.put(proposal.clone()))
                    .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't record the decision."))?
                    .map_err(|e| AppError::new(ErrorKind::Io, format!("Couldn't record the decision: {e}")))?;
                Ok(json!({"ok": true, "proposal": proposal_json(&proposal, None)}))
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolving_to_the_same_status_is_idempotent() {
        assert!(matches!(
            resolve_outcome(ProposalStatus::Accepted, ProposalStatus::Accepted),
            ResolveOutcome::AlreadyThere
        ));
        assert!(matches!(
            resolve_outcome(ProposalStatus::Rejected, ProposalStatus::Rejected),
            ResolveOutcome::AlreadyThere
        ));
    }

    #[test]
    fn resolving_to_a_different_terminal_status_is_a_conflict_not_an_override() {
        assert!(matches!(
            resolve_outcome(ProposalStatus::Accepted, ProposalStatus::Rejected),
            ResolveOutcome::Conflict
        ));
        assert!(matches!(
            resolve_outcome(ProposalStatus::Dismissed, ProposalStatus::Accepted),
            ResolveOutcome::Conflict
        ));
    }

    #[test]
    fn accept_only_proceeds_from_accepting_never_directly_from_pending() {
        assert!(matches!(
            resolve_outcome(ProposalStatus::Accepting, ProposalStatus::Accepted),
            ResolveOutcome::Proceed
        ));
        assert!(matches!(
            resolve_outcome(ProposalStatus::Pending, ProposalStatus::Accepted),
            ResolveOutcome::WrongStage
        ));
    }

    #[test]
    fn reject_and_dismiss_only_proceed_from_pending() {
        assert!(matches!(
            resolve_outcome(ProposalStatus::Pending, ProposalStatus::Rejected),
            ResolveOutcome::Proceed
        ));
        assert!(matches!(
            resolve_outcome(ProposalStatus::Pending, ProposalStatus::Dismissed),
            ResolveOutcome::Proceed
        ));
        assert!(matches!(
            resolve_outcome(ProposalStatus::Accepting, ProposalStatus::Rejected),
            ResolveOutcome::WrongStage
        ));
    }

    #[test]
    fn a_restart_recovered_proposal_stuck_accepting_can_only_be_dismissed_not_rejected() {
        // Case C (ambiguous restart recovery): dismiss is the only way out of `Accepting` besides
        // finishing the accept — never silently reopened, never silently discarded as a rejection.
        assert!(matches!(
            resolve_outcome(ProposalStatus::Accepting, ProposalStatus::Dismissed),
            ResolveOutcome::Proceed
        ));
    }
}
