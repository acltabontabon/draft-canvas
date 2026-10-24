//! Codex as the companion's agent: `codex exec --json`, its prompt on stdin and its JSONL events on
//! stdout, with the shell tool off and only the Draft Canvas server configured.
//!
//! Flags were checked against codex-cli 0.163.0. Its JSONL is documented but young, so the parser
//! takes only what it recognises and ignores every other line.

use super::protocol::{Availability, RunEvent, SignIn, StopReason, ToolStatus, Usage};
use super::{Backend, Located, Parser, RunSpec, SessionArg};
use crate::agent::clients::{self, SERVER_NAME};
use crate::errors::{AppError, ErrorKind};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// The oldest Codex the companion is known to work with: the version these flags were checked
/// against. Lower it only after checking an older one.
pub const MIN_VERSION: semver::Version = semver::Version::new(0, 163, 0);

pub struct Codex;

impl Backend for Codex {
    fn min_version(&self) -> semver::Version {
        MIN_VERSION
    }

    fn locate(&self) -> Located {
        let Some(program) = clients::find_codex() else {
            return Located {
                availability: Availability::Missing,
                program: None,
                version: None,
            };
        };
        let version = quick(&program, &["--version"]).and_then(|out| version_of(&out));
        let availability = match &version {
            Some(v) if *v < MIN_VERSION => Availability::TooOld,
            _ => Availability::Installed,
        };
        Located {
            availability,
            version: version.map(|v| v.to_string()),
            program: Some(program),
        }
    }

    fn sign_in(&self, program: &Path) -> SignIn {
        let mut sign_in = quick(program, &["login", "status"])
            .map(|out| sign_in_of(&out))
            .unwrap_or_default();
        sign_in.transcripts = sessions_dir();
        sign_in
    }

    fn command(&self, spec: &RunSpec) -> Result<Command, AppError> {
        let mut command = Command::new(spec.program);
        let probe_home = spec.mcp_config.parent().ok_or_else(AppError::internal)?;
        command
            .args(args(spec, &features(spec.program, probe_home)?))
            .current_dir(spec.work_dir);
        if let Some(path) = clients::path_with(spec.program.parent()) {
            command.env("PATH", path);
        }
        Ok(command)
    }

    fn parser(&self) -> Box<dyn Parser> {
        Box::new(Jsonl::default())
    }

    fn resume_args(&self, session: &str) -> Vec<String> {
        vec!["resume".into(), session.into()]
    }
}

/// Codex features that add tools, filesystem context or side effects outside the canvas (a browser,
/// computer use, image generation, sub-agents, plugins and apps, skills, a second shell…), none of
/// which a canvas run can use. Off, a call went from 17.3k tokens to 6.3k before the agent did anything (measured with
/// codex-cli 0.163.0, with web search off too). Only the ones this Codex has are named: it refuses
/// to start on a feature it doesn't know, and the list changes from version to version.
const NOT_FOR_A_CANVAS: &[&str] = &[
    "apps",
    "artifact",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "code_mode",
    "code_mode_host",
    "goals",
    "hooks",
    "image_generation",
    "in_app_browser",
    "in_app_chat",
    "in_app_voice",
    "in_app_local_automation",
    "memories",
    "multi_agent",
    "multi_agent_v2",
    "plugins",
    "realtime_conversation",
    "remote_plugin",
    "request_permissions_tool",
    "shell_snapshot",
    "shell_snapshot_v2",
    "skill_search",
    "skill_mcp_dependency_install",
    "sleep_tool",
    "stable_environment_tools",
    "standalone_web_search",
    "tool_suggest",
    "unified_exec",
    "view_image",
    "worktrees",
    "workspace_dependencies",
];

/// The features this Codex has (`codex features list`), asked once per program per app run.
fn features(program: &Path, probe_home: &Path) -> Result<HashSet<String>, AppError> {
    static KNOWN: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, HashSet<String>>>,
    > = std::sync::OnceLock::new();
    let known = KNOWN.get_or_init(Default::default);
    if let Some(found) = known.lock().ok().and_then(|k| k.get(program).cloned()) {
        return Ok(found);
    }
    // An unavailable probe must not silently leave the person's plugins, apps or browser enabled.
    // Failed probes are not cached: retrying after a transient failure can work.
    // `features list` has no --ignore-user-config flag. Its names need no authentication:
    // inspect defaults in the private run folder, never the person's settings or project.
    let output = quick_in_home(program, &["features", "list"], Some(probe_home));
    let found = checked_features(output.as_deref())?;
    if let Ok(mut k) = known.lock() {
        k.insert(program.to_path_buf(), found.clone());
    }
    Ok(found)
}

fn checked_features(output: Option<&str>) -> Result<HashSet<String>, AppError> {
    let found = output.map(features_of).unwrap_or_default();
    if !found.contains("shell_tool") {
        return Err(AppError::new(ErrorKind::PermissionDenied,
            "Draft Canvas couldn’t verify Codex’s tool restrictions. Check that codex features list works in Terminal, then try again."));
    }
    Ok(found)
}

/// `browser_use   stable   true` → `browser_use`, one per line.
fn features_of(text: &str) -> HashSet<String> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let name = words.next()?;
            let rest: Vec<_> = words.collect();
            (rest.len() >= 2
                && matches!(rest.last(), Some(&"true" | &"false"))
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
            .then(|| name.to_string())
        })
        .collect()
}

/// Everything but the prompt, which goes on stdin (`-`) so it never shows in a process list.
///
/// Sessions are kept (no `--ephemeral`): a conversation's next turn resumes the thread. Settings that
/// `codex exec resume` has no flag for are given as `-c` overrides, so a first turn and a resumed one
/// run under exactly the same rules.
fn args(spec: &RunSpec, available: &HashSet<String>) -> Vec<String> {
    let mut args = vec!["exec".to_string()];
    if let SessionArg::Resume(_) = spec.session {
        args.push("resume".into());
    }
    args.extend(
        [
            "--json",
            "--skip-git-repo-check",
            // The person's command rules and the shell are for coding, not for a canvas: with the shell
            // off and a read-only sandbox, the Draft Canvas tools are all Codex can act through.
            "--ignore-rules",
            // Config tables merge: setting mcp_servers never removes the person's other servers.
            // Keep auth and sessions in CODEX_HOME while omitting all user configuration instead.
            "--ignore-user-config",
            "--disable",
            "shell_tool",
            "-c",
            r#"sandbox_mode="read-only""#,
            "-c",
            r#"approval_policy="never""#,
        ]
        .map(String::from),
    );
    for feature in NOT_FOR_A_CANVAS.iter().filter(|f| available.contains(**f)) {
        args.push("--disable".into());
        args.push((*feature).to_string());
    }
    if available.contains("skip_host_skill_discovery") {
        args.extend([
            "--enable".to_string(),
            "skip_host_skill_discovery".to_string(),
        ]);
    }
    // No web search: its tool goes with every call, and a canvas run answers from the diagram.
    args.push("-c".into());
    args.push(r#"web_search="disabled""#.into());
    // With user config omitted above, this configures only this run's connector. A table override
    // alone would merge with the user's servers and expose their tools to the companion.
    args.push("-c".into());
    args.push(format!(
        "mcp_servers={}",
        server_table(spec.server, spec.server_env)
    ));
    // The brief instead of Codex's own instructions, which are about coding in a repository (and a
    // further 2.5k tokens a call), not beside them.
    args.push("-c".into());
    args.push(format!(
        "model_instructions_file={}",
        toml_string(&spec.brief_file.to_string_lossy())
    ));
    if let SessionArg::Resume(thread) = spec.session {
        args.push(thread.to_string());
    }
    args.push("-".into());
    args
}

/// `{"draft-canvas"={command="…",args=[],env={DRAFT_CANVAS_RUN="…",…},default_tools_approval_mode="approve"}}`
/// as an inline TOML table.
///
/// The tools are pre-approved for Codex because Draft Canvas is where the approval happens: the run
/// policy lets a run change one diagram, by proposal unless the person chose direct, and a proposal
/// lands only when the person accepts it. Codex asks for its own approval before a tool that writes,
/// and with `approval_policy="never"` that ask is a refusal ("MCP tool call requires approval, but
/// approval policy is never") — every change Nodi tried failed with nothing to click.
fn server_table(command: &Path, env: &[(&'static str, String)]) -> String {
    let env = env
        .iter()
        .map(|(key, value)| format!("{key}={}", toml_string(value)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{{}={{command={},args=[],env={{{env}}},default_tools_approval_mode=\"approve\"}}}}",
        toml_string(SERVER_NAME),
        toml_string(&command.to_string_lossy())
    )
}

/// A TOML basic string. JSON's escapes are a subset of TOML's, and serde never writes `\/`.
fn toml_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// Where Codex keeps its sessions, for the person to see.
fn sessions_dir() -> Option<String> {
    clients::codex_home().map(|home| crate::paths::display_path(&home.join("sessions")))
}

/// A short question to the CLI itself (`--version`, `login status`), never a model turn.
fn quick(program: &Path, args: &[&str]) -> Option<String> {
    quick_in_home(program, args, None)
}

fn quick_in_home(program: &Path, args: &[&str], home: Option<&Path>) -> Option<String> {
    let mut command = Command::new(program);
    if let Some(home) = home {
        command.env("CODEX_HOME", home).current_dir(home);
    }
    command.args(args);
    if let Some(path) = clients::path_with(program.parent()) {
        command.env("PATH", path);
    }
    let output = clients::run(command, Duration::from_secs(10)).ok()?;
    if args == ["features", "list"] && !output.success {
        return None;
    }
    // `codex login status` answers on stderr (codex-cli 0.163.0).
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(text)
}

/// `codex-cli 0.163.0` → 0.163.0.
fn version_of(text: &str) -> Option<semver::Version> {
    text.split_whitespace()
        .find_map(|word| semver::Version::parse(word).ok())
}

/// `Logged in using ChatGPT`, `Logged in using an API key - sk-…`, `Not logged in`.
fn sign_in_of(text: &str) -> SignIn {
    let lower = text.to_lowercase();
    let logged_in = if lower.contains("not logged in") {
        Some(false)
    } else if lower.contains("logged in") {
        Some(true)
    } else {
        None
    };
    let method = if lower.contains("api key") {
        Some("api_key".to_string())
    } else if lower.contains("chatgpt") {
        Some("chatgpt".to_string())
    } else {
        None
    };
    SignIn {
        logged_in,
        method,
        transcripts: None,
    }
}

/// Error text from the agent, kept to a length a card can show.
const ERROR_CHARS: usize = 500;

fn clipped(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(ERROR_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

#[derive(Default)]
struct Jsonl {
    /// Tool calls this run has started, so each is announced once and finished once.
    calls: HashSet<String>,
    /// A message already went out: the next one starts a new paragraph.
    spoke: bool,
    /// The last error Codex reported, for a turn that fails without saying why.
    last_error: Option<String>,
}

impl Parser for Jsonl {
    fn parse(&mut self, line: &str) -> Vec<RunEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value["type"].as_str() {
            Some("thread.started") => value["thread_id"]
                .as_str()
                .map(|thread| RunEvent::Started {
                    session: thread.to_string(),
                })
                .into_iter()
                .collect(),
            Some("item.started") => self.item(&value["item"], false),
            Some("item.completed") => self.item(&value["item"], true),
            Some("turn.completed") => vec![RunEvent::Stopped {
                reason: StopReason::EndTurn,
                summary: None,
                cost_micro_usd: None,
                usage: usage(&value["usage"]),
            }],
            Some("turn.failed") => {
                let message = value["error"]["message"]
                    .as_str()
                    .map(clipped)
                    .or_else(|| self.last_error.take())
                    .unwrap_or_else(|| "Codex ran into an error.".to_string());
                vec![RunEvent::Stopped {
                    reason: StopReason::Failed { message },
                    summary: None,
                    cost_micro_usd: None,
                    usage: None,
                }]
            }
            Some("error") => {
                self.last_error = value["message"].as_str().map(clipped);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

impl Jsonl {
    fn item(&mut self, item: &Value, done: bool) -> Vec<RunEvent> {
        let Some(id) = item["id"].as_str() else {
            return Vec::new();
        };
        match item["type"].as_str() {
            Some("agent_message") if done => {
                let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) else {
                    return Vec::new();
                };
                let text = if self.spoke {
                    format!("\n\n{text}")
                } else {
                    text.to_string()
                };
                self.spoke = true;
                vec![RunEvent::MessageChunk { text }]
            }
            Some("mcp_tool_call") => {
                let mut events = Vec::new();
                if self.calls.insert(id.to_string()) {
                    events.push(RunEvent::ToolCall {
                        id: id.to_string(),
                        tool: item["tool"].as_str().unwrap_or("tool").to_string(),
                        status: ToolStatus::InProgress,
                    });
                }
                if done {
                    let failed = item["status"] == "failed" || !item["error"].is_null();
                    events.push(RunEvent::ToolCallUpdate {
                        id: id.to_string(),
                        status: if failed {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        },
                        error: failed.then(|| tool_error(item)).flatten(),
                    });
                }
                events
            }
            _ => Vec::new(),
        }
    }
}

/// A failed call's reason: Codex's own error, else the tool's (`structured_content.error.message`).
fn tool_error(item: &Value) -> Option<String> {
    item["error"]["message"]
        .as_str()
        .or_else(|| item["error"].as_str())
        .or_else(|| item["result"]["structured_content"]["error"]["message"].as_str())
        .map(clipped)
}

/// The turn's tokens. `input_tokens` already counts the cached part, which `cached_input_tokens`
/// breaks out; `output_tokens` already counts reasoning.
fn usage(value: &Value) -> Option<Usage> {
    let input = value["input_tokens"].as_u64()?;
    Some(Usage {
        input,
        cached: value["cached_input_tokens"]
            .as_u64()
            .unwrap_or(0)
            .min(input),
        output: value["output_tokens"].as_u64().unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real turn (codex-cli 0.163.0, signed in with ChatGPT) against a connector pointed at an empty
    /// agent folder: one Draft Canvas call that fails with APP_UNAVAILABLE, two messages, the usage.
    const REAL_TURN: &str = include_str!("fixtures/codex-real-turn.jsonl");

    fn parse_all(text: &str) -> Vec<RunEvent> {
        let mut parser = Codex.parser();
        text.lines().flat_map(|line| parser.parse(line)).collect()
    }

    #[test]
    fn a_real_turn_reads_as_the_thread_its_call_its_reply_and_its_tokens() {
        let events = parse_all(REAL_TURN);
        assert_eq!(
            events[0],
            RunEvent::Started {
                session: "01a16b26-519e-7da1-845b-2a484e9f17a1".into()
            }
        );
        let calls: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::ToolCall { tool, .. } => Some(tool.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(calls, ["get_capabilities"]);
        assert!(events.iter().any(|e| matches!(
            e,
            RunEvent::ToolCallUpdate { status: ToolStatus::Failed, error: Some(message), .. }
                if message.contains("isn't running")
        )));
        let reply: String = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::MessageChunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(reply.starts_with("I’ll find and call"));
        assert!(reply.contains("\n\nCalled `get_capabilities` once"));
        assert_eq!(
            events.last(),
            Some(&RunEvent::Stopped {
                reason: StopReason::EndTurn,
                summary: None,
                cost_micro_usd: None,
                usage: Some(Usage {
                    input: 51_672,
                    cached: 46_208,
                    output: 145
                }),
            })
        );
    }

    #[test]
    fn a_failed_turn_says_why() {
        let events = parse_all(
            "{\"type\":\"error\",\"message\":\"stream disconnected\"}\n{\"type\":\"turn.failed\",\"error\":{}}",
        );
        assert_eq!(
            events,
            [RunEvent::Stopped {
                reason: StopReason::Failed {
                    message: "stream disconnected".into()
                },
                summary: None,
                cost_micro_usd: None,
                usage: None,
            }]
        );
    }

    fn spec_args(session: SessionArg) -> Vec<String> {
        let env = vec![("DRAFT_CANVAS_RUN", "run-1".to_string())];
        let available = features_of("browser_use stable true\nunified_exec stable true\nshell_tool stable true\nhooks stable true\nskill_mcp_dependency_install stable true\nworkspace_dependencies stable true\nin_app_local_automation stable true\nmemories stable false\nshell_snapshot stable true\ncode_mode_host stable true\nskip_host_skill_discovery under development false\n");
        args(
            &RunSpec {
                program: Path::new("/bin/codex"),
                work_dir: Path::new("/work"),
                mcp_config: Path::new("/run/mcp.json"),
                server: Path::new("/App/draft-canvas-mcp"),
                server_env: &env,
                brief: "Say \"hi\".\nThen stop.",
                brief_file: Path::new("/run/brief.md"),
                session,
            },
            &available,
        )
    }

    #[cfg(unix)]
    #[test]
    fn feature_probes_use_a_private_home_and_do_not_cache_failed_output() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("run");
        std::fs::create_dir(&home).unwrap();
        std::fs::write(home.join("mcp.json"), "private run marker").unwrap();
        let program = dir.path().join("codex-probe");
        // Even a plausible feature table from an unsuccessful CLI must not count as verification.
        std::fs::write(
            &program,
            "#!/bin/sh\nprintf 'shell_tool stable true\\n'\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(features(&program, &home).is_err());
        std::fs::write(&program, "#!/bin/sh\ntest -f \"$CODEX_HOME/mcp.json\" || exit 1\ntest -f ./mcp.json || exit 1\nprintf 'shell_tool stable true\\napps experimental true\\n'\n").unwrap();
        let found = features(&program, &home).unwrap();
        assert!(found.contains("apps"));
        assert!(found.contains("shell_tool"));
    }

    #[test]
    fn feature_discovery_fails_closed_instead_of_leaving_extra_tools_enabled() {
        for output in [
            None,
            Some(""),
            Some("error unavailable"),
            Some("browser_use stable true"),
        ] {
            assert!(checked_features(output).is_err());
        }
        let found = checked_features(Some(
            "shell_tool stable true\napps experimental true\nbrowser_use under development false\n",
        ))
        .unwrap();
        assert!(found.contains("apps"));
        assert!(found.contains("browser_use"));
        assert!(!features_of("error: cannot read configuration").contains("error"));
    }

    #[test]
    fn a_turn_runs_with_only_draft_canvas_and_no_shell() {
        let args = spec_args(SessionArg::New("ignored"));
        assert_eq!(args[..2], ["exec", "--json"]);
        assert!(args.windows(2).any(|w| w == ["--disable", "shell_tool"]));
        assert!(args.contains(&"--ignore-user-config".to_string()));
        assert!(args.contains(&r#"sandbox_mode="read-only""#.to_string()));
        assert!(args.contains(&r#"approval_policy="never""#.to_string()));
        let servers = args.iter().find(|a| a.starts_with("mcp_servers=")).unwrap();
        assert_eq!(
            servers,
            r#"mcp_servers={"draft-canvas"={command="/App/draft-canvas-mcp",args=[],env={DRAFT_CANVAS_RUN="run-1"},default_tools_approval_mode="approve"}}"#
        );
        assert!(servers.parse::<toml_edit::DocumentMut>().is_ok());
        let brief = args
            .iter()
            .find(|a| a.starts_with("model_instructions_file="))
            .unwrap();
        let parsed: toml_edit::DocumentMut = brief.parse().unwrap();
        assert_eq!(
            parsed["model_instructions_file"].as_str(),
            Some("/run/brief.md")
        );
        // The tool-bringing features off, the ones this Codex has; none it doesn't (it would refuse).
        assert!(args.windows(2).any(|w| w == ["--disable", "browser_use"]));
        assert!(args.windows(2).any(|w| w == ["--disable", "unified_exec"]));
        assert!(!args.windows(2).any(|w| w == ["--disable", "computer_use"]));
        for feature in [
            "hooks",
            "skill_mcp_dependency_install",
            "workspace_dependencies",
            "in_app_local_automation",
            "memories",
            "shell_snapshot",
            "code_mode_host",
        ] {
            assert!(args.windows(2).any(|w| w == ["--disable", feature]));
        }
        assert!(args
            .windows(2)
            .any(|w| w == ["--enable", "skip_host_skill_discovery"]));
        assert!(args.contains(&r#"web_search="disabled""#.to_string()));
        assert_eq!(args.last().map(String::as_str), Some("-"));
        assert!(!args.contains(&"--ephemeral".to_string()));
    }

    #[test]
    fn new_and_resumed_turns_keep_user_config_skills_and_side_effects_out() {
        for session in [SessionArg::New("fresh"), SessionArg::Resume("existing")] {
            let args = spec_args(session);
            assert!(args.contains(&"--ignore-user-config".to_string()));
            for feature in [
                "shell_tool",
                "hooks",
                "skill_mcp_dependency_install",
                "workspace_dependencies",
                "in_app_local_automation",
                "memories",
                "shell_snapshot",
                "code_mode_host",
            ] {
                assert!(
                    args.windows(2).any(|pair| pair == ["--disable", feature]),
                    "{feature}"
                );
            }
            assert!(args
                .windows(2)
                .any(|pair| pair == ["--enable", "skip_host_skill_discovery"]));
        }
    }

    #[test]
    fn a_later_turn_resumes_its_thread_under_the_same_rules() {
        let args = spec_args(SessionArg::Resume("01a16b26-519e"));
        assert_eq!(args[..3], ["exec", "resume", "--json"]);
        assert_eq!(args[args.len() - 2..], ["01a16b26-519e", "-"]);
        assert!(args.windows(2).any(|w| w == ["--disable", "shell_tool"]));
        assert!(args.contains(&"--ignore-user-config".to_string()));
    }

    #[test]
    fn sign_in_reads_codexs_own_words() {
        assert_eq!(
            sign_in_of("Logged in using ChatGPT\n"),
            SignIn {
                logged_in: Some(true),
                method: Some("chatgpt".into()),
                transcripts: None
            }
        );
        assert_eq!(sign_in_of("Not logged in").logged_in, Some(false));
        assert_eq!(
            sign_in_of("Logged in using an API key - sk-…")
                .method
                .as_deref(),
            Some("api_key")
        );
        assert_eq!(version_of("codex-cli 0.163.0"), Some(MIN_VERSION));
    }
}
