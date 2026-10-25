//! The page's side of the agent companion (`companion/`): which agents are there, sending a prompt,
//! stopping a run, and picking up runs after a reload.

use super::agent::connectable_sidecar;
use super::run_blocking;
use crate::agent::code::candidate_folder;
use crate::agent::proposals::ProposalStatus;
use crate::agent::runs::RunPolicy;
use crate::agent::scope::{self, enabled_projects};
use crate::agent::Agent;
use crate::companion::protocol::{
    AgentInfo, AgentKind, ApplyMode, Availability, CodeFolder, CodeGrant, PromptRequest,
    RunSnapshot,
};
use crate::companion::{self, Companion, Launch, RunSpec, SessionArg, BRIEF};
use crate::docio::write_private;
use crate::errors::{AppError, ErrorKind, Subject};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// Which agents the companion can run, their versions and what they say about sign-in. Asked when the
/// companion opens, not on every refresh: finding `claude` can start a login shell.
#[tauri::command]
pub async fn companion_agents(app: AppHandle) -> Result<Vec<AgentInfo>, AppError> {
    run_blocking(&app, |_, _| {
        Ok(AgentKind::ALL
            .into_iter()
            .map(|kind| {
                let backend = companion::backend(kind);
                let located = backend.locate();
                let sign_in = match (&located.availability, &located.program) {
                    (Availability::Installed, Some(program)) => backend.sign_in(program),
                    _ => Default::default(),
                };
                AgentInfo {
                    agent: kind,
                    name: kind.name().to_string(),
                    availability: located.availability,
                    version: located.version,
                    sign_in,
                }
            })
            .collect())
    })
    .await
}

/// The diagram a request names, if it is the open one and agents may use its folder. A companion run
/// has no more reach than an agent the person connected themselves.
fn open_diagram(
    state: &AppState,
    agent: &Agent,
    diagram_id: &str,
) -> Result<scope::Diagram, AppError> {
    if !state.settings.get().agent_access || !agent.is_running() {
        return Err(AppError::new(
            ErrorKind::PermissionDenied,
            "Turn on agent access in Settings → AI agents first.",
        ));
    }
    let not_open = || {
        AppError::new(
            ErrorKind::NotFound,
            "Open the diagram before asking the companion about it.",
        )
    };
    let active = agent.active().ok_or_else(not_open)?;
    let diagram = agent
        .index
        .find(&enabled_projects(state), diagram_id)
        .map_err(|_| {
            AppError::new(
                ErrorKind::PermissionDenied,
                "Agents can’t use this diagram’s folder. Allow it in Settings → AI agents, or save the diagram in a folder they can use.",
            )
        })?;
    let same = |a: &std::path::Path, b: &std::path::Path| matches!((dunce::canonicalize(a), dunce::canonicalize(b)), (Ok(a), Ok(b)) if a == b);
    if !same(&diagram.absolute, &active.path) {
        return Err(not_open());
    }
    Ok(diagram)
}

/// The project folder `diagram`'s code is in: the one the person chose for it, else the repository
/// it is saved in (or its own folder), canonical, so a grant can't be reached by another spelling.
fn code_folder_of(state: &AppState, diagram_id: &str, file: &Path) -> PathBuf {
    let chosen = state
        .settings
        .get()
        .code_folder_of
        .get(diagram_id)
        .map(PathBuf::from);
    let folder = chosen
        .filter(|f| f.is_dir())
        .unwrap_or_else(|| candidate_folder(file, crate::paths::home_dir().as_deref()));
    dunce::canonicalize(&folder).unwrap_or(folder)
}

/// Whether runs may read `folder`, and for how long.
fn code_grant(state: &AppState, companion: &Companion, folder: &Path) -> Option<CodeGrant> {
    let path = folder.to_string_lossy();
    if state.settings.get().code_folders.iter().any(|f| *f == path) {
        Some(CodeGrant::Always)
    } else if companion.code_allowed_now(folder) {
        Some(CodeGrant::Now)
    } else {
        None
    }
}

fn code_info(state: &AppState, companion: &Companion, folder: &Path) -> CodeFolder {
    CodeFolder {
        name: folder
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| crate::paths::display_path(folder)),
        display_path: crate::paths::display_path(folder),
        allowed: code_grant(state, companion, folder),
    }
}

/// The project folder Nodi would read for this diagram, and whether it may.
#[tauri::command]
pub async fn companion_code(app: AppHandle, diagram_id: String) -> Result<CodeFolder, AppError> {
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        let diagram = open_diagram(state, &agent, &diagram_id)?;
        let companion = app.state::<Arc<Companion>>();
        let folder = code_folder_of(state, &diagram_id, &diagram.absolute);
        Ok(code_info(state, &companion, &folder))
    })
    .await
}

/// The person's answer to Nodi asking to read the project: until the app quits, or always.
#[tauri::command]
pub async fn companion_allow_code(
    app: AppHandle,
    diagram_id: String,
    grant: CodeGrant,
) -> Result<CodeFolder, AppError> {
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        let diagram = open_diagram(state, &agent, &diagram_id)?;
        let companion = app.state::<Arc<Companion>>();
        let folder = code_folder_of(state, &diagram_id, &diagram.absolute);
        match grant {
            CodeGrant::Now => companion.allow_code_now(folder.clone()),
            CodeGrant::Always => {
                let path = folder.to_string_lossy().into_owned();
                state.settings.update(|s| {
                    if !s.code_folders.contains(&path) {
                        s.code_folders.insert(0, path);
                        s.code_folders.truncate(crate::settings::CODE_FOLDERS_CAP);
                    }
                })?;
            }
        }
        state.events.emit(crate::state::HostEvent::AgentChanged);
        Ok(code_info(state, &companion, &folder))
    })
    .await
}

/// Another folder for this diagram's code, picked in the system's own dialog: remembered as this
/// diagram's, and not yet allowed (the person still says how long). `None` when they cancel.
#[tauri::command]
pub async fn companion_choose_code(
    app: AppHandle,
    diagram_id: String,
) -> Result<Option<CodeFolder>, AppError> {
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        let diagram = open_diagram(state, &agent, &diagram_id)?;
        let companion = app.state::<Arc<Companion>>();
        let start = code_folder_of(state, &diagram_id, &diagram.absolute);
        let Some(picked) = crate::dialogs::pick_folder(app, Some(start)) else {
            return Ok(None);
        };
        let folder = dunce::canonicalize(&picked).unwrap_or(picked);
        let path = folder.to_string_lossy().into_owned();
        state.settings.update(|s| {
            s.code_folder_of.insert(diagram_id.clone(), path);
            while s.code_folder_of.len() > crate::settings::CODE_FOLDERS_CAP {
                let Some(first) = s.code_folder_of.keys().next().cloned() else {
                    break;
                };
                s.code_folder_of.remove(&first);
            }
        })?;
        Ok(Some(code_info(state, &companion, &folder)))
    })
    .await
}

/// Starts the agent on one turn. Its events arrive as `HostEvent::Companion` under `request.runId`,
/// the last always `stopped`.
#[tauri::command]
pub async fn companion_send(app: AppHandle, request: PromptRequest) -> Result<(), AppError> {
    companion::validate(&request)?;
    let companion = app.state::<Arc<Companion>>().inner().clone();
    let preparation = companion.prepare(&request)?;
    run_blocking(&app, move |app, state| {
        let agent = app.state::<Arc<Agent>>();
        let diagram = open_diagram(state, &agent, &request.diagram_id)?;

        let backend = companion::backend(request.agent);
        let located = backend.locate();
        let program = match (located.availability, located.program) {
            (Availability::Installed, Some(program)) => program,
            (Availability::TooOld, _) => {
                return Err(AppError::new(
                    ErrorKind::NotFound,
                    format!(
                        "Update {} to use Nodi: it needs version {} or later.",
                        request.agent.name(),
                        backend.min_version()
                    ),
                ))
            }
            _ => {
                return Err(AppError::new(
                    ErrorKind::NotFound,
                    format!(
                        "Draft Canvas couldn’t find {} on this computer.",
                        request.agent.name()
                    ),
                ))
            }
        };
        let sidecar = connectable_sidecar()?;
        // The project folder, only when the person said this run may read it.
        let code = {
            let folder = code_folder_of(state, &request.diagram_id, &diagram.absolute);
            code_grant(state, &companion, &folder).map(|_| folder)
        };
        let code_name = code
            .as_ref()
            .map(|folder| code_info(state, &companion, folder).name);

        let work_dir = companion.work_dir()?;
        let run_dir = companion.run_dir(&request.run_id)?;
        let config = run_dir.join("mcp.json");
        let written = write_private(
            &config,
            &companion::mcp_config(&sidecar, &request.run_id, agent.dir(), code.is_some()),
            Subject::Preferences,
        );
        // The brief as a file too, for an agent that reads its instructions from one (Codex).
        let brief_file = run_dir.join("brief.md");
        let written = written
            .and_then(|()| write_private(&brief_file, BRIEF.as_bytes(), Subject::Preferences));
        if let Err(error) = written {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(error);
        }

        let resume = companion.session_for(&request.diagram_id, request.agent);
        let fresh = uuid::Uuid::new_v4().to_string();
        let server_env = companion::server_env(&request.run_id, agent.dir(), code.is_some());
        let command = match backend.command(&RunSpec {
            program: &program,
            work_dir: &work_dir,
            mcp_config: &config,
            server: &sidecar,
            server_env: &server_env,
            brief: BRIEF,
            brief_file: &brief_file,
            session: match &resume {
                Some(session) => SessionArg::Resume(session),
                None => SessionArg::New(&fresh),
            },
        }) {
            Ok(command) => command,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&run_dir);
                return Err(error);
            }
        };
        // The newest proposal this diagram's conversations submitted that still waits on the person.
        let waiting = agent
            .with_proposals(|store| {
                store
                    .list(Some(&request.diagram_id))
                    .into_iter()
                    .find(|p| p.status == ProposalStatus::Pending && p.run.is_some())
                    .map(|p| (p.id.clone(), p.version, p.summary.clone()))
            })
            .flatten();
        let started = companion.start_prepared(
            Launch {
                stdin: companion::turn_prompt(
                    &request,
                    &diagram.title,
                    waiting
                        .as_ref()
                        .map(|(proposal_id, version, summary)| companion::Waiting {
                            proposal_id,
                            version: *version,
                            summary,
                        }),
                    code_name.as_deref(),
                ),
                run_id: request.run_id.clone(),
                diagram_id: request.diagram_id.clone(),
                agent: request.agent,
                text: request.text.clone(),
                command,
                dir: run_dir.clone(),
            },
            preparation,
            || {
                agent.runs.open(
                    &request.run_id,
                    RunPolicy {
                        diagram_id: request.diagram_id.clone(),
                        direct: request.mode == ApplyMode::Direct,
                        code,
                    },
                );
            },
        );
        if started.is_err() {
            agent.end_run(&request.run_id);
            let _ = std::fs::remove_dir_all(&run_dir);
        }
        started
    })
    .await
}

/// Stops a run: `false` when it had already ended.
#[tauri::command]
pub async fn companion_cancel(
    companion: State<'_, Arc<Companion>>,
    run_id: String,
) -> Result<bool, AppError> {
    Ok(companion.cancel(&run_id))
}

/// Runs still going, with everything they have said, for a page that has just loaded.
#[tauri::command]
pub async fn companion_runs(
    companion: State<'_, Arc<Companion>>,
) -> Result<Vec<RunSnapshot>, AppError> {
    Ok(companion.snapshot())
}

/// The shell line that carries this diagram's conversation with `agent` on in the agent's own
/// terminal UI, or none when there is no conversation (or no agent) to carry on.
#[tauri::command]
pub async fn companion_continue(
    app: AppHandle,
    diagram_id: String,
    agent: AgentKind,
) -> Result<Option<String>, AppError> {
    run_blocking(&app, move |app, _| {
        let companion = app.state::<Arc<Companion>>();
        let Some(session) = companion.session_for(&diagram_id, agent) else {
            return Ok(None);
        };
        let backend = companion::backend(agent);
        let Some(program) = backend.locate().program else {
            return Ok(None);
        };
        Ok(Some(companion::continue_line(
            &companion.work_dir()?,
            &program,
            &backend.resume_args(&session),
        )))
    })
    .await
}

/// The next prompt on this diagram starts a new conversation.
#[tauri::command]
pub async fn companion_forget(
    app: AppHandle,
    diagram_id: String,
    agent: Option<AgentKind>,
) -> Result<(), AppError> {
    run_blocking(&app, move |app, _| {
        app.state::<Arc<Companion>>().forget(&diagram_id, agent)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testing::test_state;

    #[test]
    fn nothing_runs_while_agent_access_is_off() {
        let (dir, state) = test_state();
        let agent = Agent::new(&dir.path().join("data"));
        let error = open_diagram(&state, &agent, "d_1").unwrap_err();
        assert_eq!(error.kind, ErrorKind::PermissionDenied);
        assert!(error.message.contains("agent access"));
    }
}
