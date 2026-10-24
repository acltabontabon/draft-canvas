//! The page's side of the agent bridge (`agent/`): answering requests, and the Settings controls.

use super::projects::project_info_unwatched;
use super::run_blocking;
use crate::agent::clients::{self, Client, ClientSetup};
use crate::agent::proposals::{Proposal, ProposalStatus};
use crate::agent::scope::{self, enabled_projects};
use crate::agent::skill::{self, SkillSetup, SkillTarget};
use crate::agent::{broker, sidecar_path, sidecar_warning, Agent, AgentStatus, BackgroundSupport};
use crate::errors::{AppError, ErrorKind};
use crate::state::{AppState, HostEvent};
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    /// The nearest other listed folder this one sits inside, by handle. Access is granted by prefix
    /// (`scope::in_scope`), so a ticked parent already reaches everything in here — Settings says so.
    pub within: Option<String>,
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
    let projects: Vec<(AgentProject, PathBuf)> = settings
        .projects
        .iter()
        .filter_map(|p| {
            let info = project_info_unwatched(state, Path::new(&p.path)).ok()?;
            let root = state.project(&info.handle).ok()?.root;
            Some((
                AgentProject {
                    handle: info.handle,
                    name: info.name,
                    display_path: info.display_path,
                    agent: p.agent,
                    within: None,
                },
                root,
            ))
        })
        .collect();
    let roots: Vec<&Path> = projects.iter().map(|(_, root)| root.as_path()).collect();
    let within: Vec<Option<String>> = nearest_containers(&roots)
        .into_iter()
        .map(|container| container.map(|i| projects[i].0.handle.clone()))
        .collect();
    let projects = projects
        .into_iter()
        .zip(within)
        .map(|((project, _), within)| AgentProject { within, ..project })
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

/// For each root, the index of the deepest *other* root that contains it — the same component-wise
/// `starts_with` test `scope::in_scope` grants access by, on the same canonical roots. Two entries for
/// one folder don't contain each other.
fn nearest_containers(roots: &[&Path]) -> Vec<Option<usize>> {
    roots
        .iter()
        .map(|root| {
            roots
                .iter()
                .enumerate()
                .filter(|(_, other)| *other != root && root.starts_with(other))
                .max_by_key(|(_, other)| other.components().count())
                .map(|(i, _)| i)
        })
        .collect()
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
        let turning_off = patch.enabled == Some(false);
        configure(state, &agent, patch)?;
        // A companion run can't reach the diagram any more; it is stopped rather than left to fail.
        if turning_off {
            if let Some(companion) = app.try_state::<Arc<crate::companion::Companion>>() {
                companion.stop_all(std::time::Duration::ZERO);
            }
        }
        state.events.emit(HostEvent::AgentChanged);
        Ok(settings_of(state, &agent))
    })
    .await
}

/// The connector this app ships, if a client's configuration may be pointed at it now.
pub(crate) fn connectable_sidecar() -> Result<PathBuf, AppError> {
    let path = sidecar_path().ok_or_else(|| {
        AppError::new(
            ErrorKind::NotFound,
            "This build of Draft Canvas doesn’t include the agent connector.",
        )
    })?;
    if let Some(warning) = sidecar_warning(&path) {
        return Err(AppError::new(ErrorKind::InvalidPath, warning));
    }
    Ok(path)
}

/// Whether each agent Settings can set up already launches this app's connector (`agent/clients.rs`).
/// Asked when Settings shows the setup, not with every status refresh: finding `claude` or `gemini`
/// can start a shell.
#[tauri::command]
pub async fn agent_clients(app: AppHandle) -> Result<Vec<ClientSetup>, AppError> {
    run_blocking(&app, |_, _| match sidecar_path() {
        Some(path) => Ok(clients::status(&path)),
        None => Ok(Vec::new()),
    })
    .await
}

/// Adds Draft Canvas to `client`'s MCP configuration, or points an existing entry at this app.
#[tauri::command]
pub async fn agent_connect_client(app: AppHandle, client: Client) -> Result<ClientSetup, AppError> {
    run_blocking(&app, move |_, _| {
        clients::connect(client, &connectable_sidecar()?)
    })
    .await
}

/// Where an edited skill is kept when Settings replaces or removes it: the app's own folder, never
/// beside the skill, where an agent would load it as a second one.
fn skill_backups(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("skill-backups"))
        .map_err(|_| {
            AppError::new(
                ErrorKind::NotFound,
                "Draft Canvas couldn’t find its data folder.",
            )
        })
}

/// Where the Draft Canvas agent skill stands for each place agents read skills from (`agent/skill.rs`).
#[tauri::command]
pub async fn agent_skills(app: AppHandle) -> Result<Vec<SkillSetup>, AppError> {
    run_blocking(&app, |_, _| {
        Ok(skill::TARGETS.iter().map(|t| skill::status(*t)).collect())
    })
    .await
}

/// Installs this app's skill for `target`, replacing what is there (an edited copy is kept aside).
#[tauri::command]
pub async fn agent_install_skill(
    app: AppHandle,
    target: SkillTarget,
) -> Result<SkillSetup, AppError> {
    run_blocking(&app, move |app, _| {
        skill::install(target, &skill_backups(app)?)
    })
    .await
}

/// Takes the skill out of `target`'s folder (an edited copy is kept aside).
#[tauri::command]
pub async fn agent_remove_skill(
    app: AppHandle,
    target: SkillTarget,
) -> Result<SkillSetup, AppError> {
    run_blocking(&app, move |app, _| {
        skill::remove(target, &skill_backups(app)?)
    })
    .await
}

/// At launch: a skill this app installed earlier, and nobody changed, is brought up to the version
/// this app carries. Off the main thread; it only touches the skills folders.
pub fn refresh_skills(app: &AppHandle) {
    if let Ok(backups) = skill_backups(app) {
        tauri::async_runtime::spawn_blocking(move || skill::refresh(&backups));
    }
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

/// Every in-scope diagram by id, from one walk of the enabled folders. A list of proposals looks
/// each one's diagram up here instead of walking the folders once per proposal. The first file seen
/// with an id wins, as in `diagram_for`.
fn diagrams_by_id(state: &AppState, agent: &Agent) -> HashMap<String, scope::Diagram> {
    let projects = enabled_projects(state);
    let mut by_id = HashMap::new();
    for diagram in agent.index.list(&projects) {
        by_id.entry(diagram.diagram_id.clone()).or_insert(diagram);
    }
    by_id
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
        "scope": proposal.scope,
        "preconditions": proposal.preconditions,
        "counts": proposal.counts,
        "summary": proposal.summary,
        "rationale": proposal.rationale,
        "assumptions": proposal.assumptions,
        "openQuestions": proposal.open_questions,
        "sourceRef": proposal.source_ref,
        "run": proposal.run,
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
        // Nothing to mark stale: don't walk every project to learn that.
        if all.is_empty() {
            return Ok(Vec::new());
        }
        let diagrams = diagrams_by_id(state, &agent);
        Ok(all
            .iter()
            .map(|p| proposal_json(p, diagrams.get(&p.diagram_id)))
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
        // Checked and written under one hold of the store: an agent's revise landing between a
        // separate read and write had its newer version overwritten by this one's older content.
        agent
            .with_proposals(|store| {
                let Some(mut proposal) = store.get(&id).cloned() else {
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
                store
                    .put(proposal.clone())
                    .map_err(|e| AppError::new(ErrorKind::Io, format!("Couldn't record the proposal was being accepted: {e}")))?;
                Ok(json!({"ok": true, "proposal": proposal_json(&proposal, None)}))
            })
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't open the proposal store."))?
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
        // One hold of the store for the check and the write, as in `agent_proposal_begin_accept`.
        agent
            .with_proposals(|store| {
                let Some(mut proposal) = store.get(&id).cloned() else {
                    return Ok(json!({"ok": false, "code": "NOT_FOUND"}));
                };
                match resolve_outcome(proposal.status, target) {
                    ResolveOutcome::AlreadyThere => Ok(json!({"ok": true, "proposal": proposal_json(&proposal, None)})),
                    ResolveOutcome::Conflict => Ok(json!({"ok": false, "code": "ALREADY_RESOLVED", "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null)})),
                    ResolveOutcome::WrongStage => Ok(json!({"ok": false, "code": "WRONG_STAGE", "status": serde_json::to_value(proposal.status).unwrap_or(Value::Null)})),
                    ResolveOutcome::Proceed => {
                        proposal.status = target;
                        proposal.resolved_at = Some(now_ms());
                        store
                            .put(proposal.clone())
                            .map_err(|e| AppError::new(ErrorKind::Io, format!("Couldn't record the decision: {e}")))?;
                        Ok(json!({"ok": true, "proposal": proposal_json(&proposal, None)}))
                    }
                }
            })
            .ok_or_else(|| AppError::new(ErrorKind::Io, "Couldn't open the proposal store."))?
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

    #[test]
    fn a_folder_inside_another_listed_folder_names_the_nearest_one() {
        let roots = [
            Path::new("/work/app"),
            Path::new("/work/app/web"),
            Path::new("/work/app/web/docs"),
            Path::new("/work/app-web"),
            Path::new("/work"),
        ];
        assert_eq!(
            nearest_containers(&roots),
            vec![Some(4), Some(0), Some(1), Some(4), None]
        );
    }

    #[test]
    fn the_same_folder_listed_twice_is_not_inside_itself() {
        let roots = [Path::new("/work/app"), Path::new("/work/app")];
        assert_eq!(nearest_containers(&roots), vec![None, None]);
    }
}
