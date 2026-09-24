//! The page's side of the agent bridge (`agent/`): answering requests, and the Settings controls.

use super::projects::project_info;
use super::run_blocking;
use crate::agent::{broker, sidecar_path, sidecar_warning, Agent, AgentStatus, BackgroundSupport};
use crate::errors::AppError;
use crate::state::{AppState, HostEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
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
