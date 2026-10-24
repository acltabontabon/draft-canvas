//! Claude Code as the companion's agent: `claude -p`, its prompt on stdin and its stream-json on
//! stdout, with only the Draft Canvas tools available.
//!
//! Flags were checked against Claude Code 2.1.295. Its stream-json is not a published contract, so
//! the parser takes only what it recognises and ignores every other line.

use super::protocol::{Availability, RunEvent, SignIn, StopReason, ToolStatus, Usage};
use super::{Backend, Located, Parser, RunSpec, SessionArg};
use crate::agent::clients::{self, SERVER_NAME};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// The oldest Claude Code the companion is known to work with: the version these flags were checked
/// against. Lower it only after checking an older one.
pub const MIN_VERSION: semver::Version = semver::Version::new(2, 1, 295);

/// Draft Canvas's tools, as Claude Code names MCP tools.
fn tool_prefix() -> String {
    format!("mcp__{SERVER_NAME}__")
}

pub struct ClaudeCode;

impl Backend for ClaudeCode {
    fn min_version(&self) -> semver::Version {
        MIN_VERSION
    }

    fn locate(&self) -> Located {
        let Some(program) = clients::find_claude() else {
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
        quick(program, &["auth", "status", "--json"])
            .map(|out| sign_in_of(&out))
            .unwrap_or_default()
    }

    fn command(&self, spec: &RunSpec) -> Command {
        let mut command = Command::new(spec.program);
        command.args(args(spec)).current_dir(spec.work_dir);
        if let Some(path) = clients::path_with(spec.program.parent()) {
            command.env("PATH", path);
        }
        command
    }

    fn parser(&self) -> Box<dyn Parser> {
        Box::new(StreamJson::default())
    }

    fn resume_args(&self, session: &str) -> Vec<String> {
        vec!["--resume".into(), session.into()]
    }
}

/// Everything but the prompt, which goes on stdin so it never shows in a process list.
fn args(spec: &RunSpec) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        // No built-in tools at all: no shell, no file reads or edits, no web.
        "--tools",
        "",
        "--permission-prompts",
        "none",
        // Hooks from the person's settings don't run for a prompt typed on a canvas.
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ]
    .map(String::from)
    .to_vec();
    args.push("--mcp-config".into());
    args.push(spec.mcp_config.to_string_lossy().into_owned());
    args.push("--allowedTools".into());
    args.push(format!("{}*", tool_prefix()));
    // The brief is the whole system prompt, not an addition to Claude Code's own: that one is about
    // coding in a repository, which a canvas run can't do (no built-in tools), and it cost every model
    // call of a turn 2,300 tokens more (measured, 2.1.310).
    args.push("--system-prompt".into());
    args.push(spec.brief.to_string());
    match spec.session {
        SessionArg::New(id) => args.extend(["--session-id".into(), id.to_string()]),
        SessionArg::Resume(id) => args.extend(["--resume".into(), id.to_string()]),
    }
    args
}

/// A short question to the CLI itself (`--version`, `auth status`), never a model turn.
fn quick(program: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(path) = clients::path_with(program.parent()) {
        command.env("PATH", path);
    }
    let output = clients::run(command, Duration::from_secs(10)).ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `2.1.295 (Claude Code)` → 2.1.295.
fn version_of(text: &str) -> Option<semver::Version> {
    text.split_whitespace()
        .find_map(|word| semver::Version::parse(word).ok())
}

fn sign_in_of(json: &str) -> SignIn {
    let Ok(status) = serde_json::from_str::<Value>(json) else {
        return SignIn::default();
    };
    SignIn {
        logged_in: status["loggedIn"].as_bool(),
        method: status["authMethod"].as_str().map(str::to_string),
        transcripts: status["projectsDirectory"]
            .as_str()
            .map(|p| crate::paths::display_path(Path::new(p))),
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
struct StreamJson {
    /// Tool calls this run has started, so a result is only reported for one of them.
    calls: HashSet<String>,
    /// Text already arrived as deltas since the last whole message: the message would repeat it.
    streamed: bool,
    /// Claude Code said it couldn't sign in: the result is worded as that, with what to do about it.
    signed_out: bool,
}

/// What a person can do about a run that failed to sign in.
const SIGNED_OUT: &str =
    "Claude Code isn’t signed in. Run claude once in Terminal to sign in, then try again.";

impl Parser for StreamJson {
    fn parse(&mut self, line: &str) -> Vec<RunEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value["type"].as_str() {
            Some("system") if value["subtype"] == "init" => self.init(&value),
            Some("stream_event") => self.delta(&value),
            Some("assistant") => self.assistant(&value),
            Some("user") => self.tool_results(&value),
            Some("result") => vec![result(&value, self.signed_out)],
            _ => Vec::new(),
        }
    }
}

impl StreamJson {
    fn init(&self, value: &Value) -> Vec<RunEvent> {
        let mut events = Vec::new();
        if let Some(session) = value["session_id"].as_str() {
            events.push(RunEvent::Started {
                session: session.to_string(),
            });
        }
        let connected = value["mcp_servers"].as_array().is_none_or(|servers| {
            servers
                .iter()
                .find(|s| s["name"] == SERVER_NAME)
                .is_some_and(|s| s["status"] == "connected")
        });
        if !connected {
            events.push(RunEvent::Stopped {
                reason: StopReason::Failed {
                    message: "Claude Code couldn’t reach Draft Canvas. Check that agent access is on in Settings → AI agents.".into(),
                },
                summary: None,
                cost_micro_usd: None,
                usage: None,
            });
        }
        events
    }

    fn delta(&mut self, value: &Value) -> Vec<RunEvent> {
        let delta = &value["event"]["delta"];
        if value["event"]["type"] != "content_block_delta" || delta["type"] != "text_delta" {
            return Vec::new();
        }
        match delta["text"].as_str() {
            Some(text) if !text.is_empty() => {
                self.streamed = true;
                vec![RunEvent::MessageChunk {
                    text: text.to_string(),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn assistant(&mut self, value: &Value) -> Vec<RunEvent> {
        let streamed = std::mem::take(&mut self.streamed);
        // An error Claude Code reports as a message of its own (a failed sign-in, say) isn't the
        // agent's reply: the result that follows says it, once.
        if value["is_api_error_message"] == true {
            self.signed_out |= value["error"] == "authentication_failed";
            return Vec::new();
        }
        let mut events = Vec::new();
        for block in value["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") if !streamed => {
                    if let Some(text) = block["text"].as_str().filter(|t| !t.is_empty()) {
                        events.push(RunEvent::MessageChunk {
                            text: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str())
                    else {
                        continue;
                    };
                    self.calls.insert(id.to_string());
                    let prefix = tool_prefix();
                    events.push(RunEvent::ToolCall {
                        id: id.to_string(),
                        tool: name.strip_prefix(&prefix).unwrap_or(name).to_string(),
                        status: ToolStatus::InProgress,
                    });
                }
                _ => {}
            }
        }
        events
    }

    fn tool_results(&mut self, value: &Value) -> Vec<RunEvent> {
        let mut events = Vec::new();
        for block in value["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_result" {
                continue;
            }
            let Some(id) = block["tool_use_id"]
                .as_str()
                .filter(|id| self.calls.remove(*id))
            else {
                continue;
            };
            let failed = block["is_error"].as_bool() == Some(true);
            events.push(RunEvent::ToolCallUpdate {
                id: id.to_string(),
                status: if failed {
                    ToolStatus::Failed
                } else {
                    ToolStatus::Completed
                },
                error: failed.then(|| clipped(&text_of_result(&block["content"]))),
            });
        }
        events
    }
}

/// A tool result's text: a string, or the text parts of a list.
fn text_of_result(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The last line of a turn. Read from `is_error`, `subtype` and `stop_reason` together: a result can
/// say `success` and still be an error.
fn result(value: &Value, signed_out: bool) -> RunEvent {
    let subtype = value["subtype"].as_str().unwrap_or("");
    let is_error = value["is_error"].as_bool() == Some(true) || subtype.starts_with("error");
    let text = value["result"].as_str().unwrap_or("").trim();
    let reason = if subtype == "error_max_turns" {
        StopReason::MaxTurns
    } else if is_error {
        let detail = value["errors"]
            .as_array()
            .and_then(|errors| errors.iter().find_map(Value::as_str))
            .unwrap_or(text);
        StopReason::Failed {
            message: if signed_out {
                SIGNED_OUT.to_string()
            } else if detail.is_empty() {
                "Claude Code ran into an error.".to_string()
            } else {
                clipped(detail)
            },
        }
    } else if value["stop_reason"] == "refusal" {
        StopReason::Refusal
    } else {
        StopReason::EndTurn
    };
    let cost = value["total_cost_usd"]
        .as_f64()
        .filter(|c| c.is_finite() && *c >= 0.0)
        .map(|c| (c * 1_000_000.0).round() as u64);
    RunEvent::Stopped {
        summary: (!is_error && !text.is_empty()).then(|| text.to_string()),
        reason,
        cost_micro_usd: cost,
        usage: usage(&value["usage"]),
    }
}

/// The turn's tokens from the result's `usage`. Claude counts what it read in three parts: fresh
/// input, what it wrote to the prompt cache, and what it read back from it; all three were read in.
fn usage(value: &Value) -> Option<Usage> {
    let count = |key: &str| value[key].as_u64();
    let fresh = count("input_tokens")?;
    let output = count("output_tokens")?;
    let written = count("cache_creation_input_tokens").unwrap_or(0);
    let cached = count("cache_read_input_tokens").unwrap_or(0);
    Some(Usage {
        input: fresh.saturating_add(written).saturating_add(cached),
        cached,
        output,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A whole turn in Claude Code's stream-json, written from its documented shape (not recorded
    /// from a real run): init, streamed text, a tool call and its result, the whole message, result.
    pub(crate) const TURN: &str = include_str!("fixtures/claude-turn.jsonl");

    fn parse_all(text: &str) -> Vec<RunEvent> {
        let mut parser = ClaudeCode.parser();
        text.lines().flat_map(|line| parser.parse(line)).collect()
    }

    #[test]
    fn a_turn_becomes_started_text_tool_calls_and_a_stop() {
        let events = parse_all(TURN);
        assert_eq!(
            events,
            vec![
                RunEvent::Started {
                    session: "3f1c2a4e-0000-4000-8000-000000000001".into()
                },
                RunEvent::ToolCall {
                    id: "toolu_1".into(),
                    tool: "read_diagram".into(),
                    status: ToolStatus::InProgress
                },
                RunEvent::ToolCallUpdate {
                    id: "toolu_1".into(),
                    status: ToolStatus::Completed,
                    error: None
                },
                RunEvent::ToolCall {
                    id: "toolu_2".into(),
                    tool: "submit_proposal".into(),
                    status: ToolStatus::InProgress
                },
                RunEvent::ToolCallUpdate {
                    id: "toolu_2".into(),
                    status: ToolStatus::Failed,
                    error: Some("OUT_OF_SCOPE: n9 is outside the scope.".into())
                },
                RunEvent::MessageChunk {
                    text: "I proposed ".into()
                },
                RunEvent::MessageChunk {
                    text: "a cache.".into()
                },
                RunEvent::Stopped {
                    reason: StopReason::EndTurn,
                    summary: Some("I proposed a cache.".into()),
                    cost_micro_usd: Some(41_200),
                    usage: None,
                },
            ]
        );
    }

    /// Recorded from a real run of Claude Code 2.1.295 with the companion's own command line, signed
    /// out (2026-10-24). Trimmed to the fields read here; paths replaced.
    const SIGNED_OUT_RUN: &str = include_str!("fixtures/claude-signed-out.jsonl");

    /// Recorded from a real, signed-in run of Claude Code 2.1.295 with the companion's own command line
    /// (2026-10-24), against a connector with no app behind it: one tool call that fails, then a
    /// streamed reply. Trimmed to the fields read here; paths replaced.
    const REAL_TURN: &str = include_str!("fixtures/claude-real-turn.jsonl");

    #[test]
    fn a_real_turn_offers_only_draft_canvas_tools_and_reads_cleanly() {
        let init: Value = serde_json::from_str(REAL_TURN.lines().next().unwrap()).unwrap();
        let tools: Vec<&str> = init["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(!tools.is_empty());
        assert!(
            tools.iter().all(|t| t.starts_with("mcp__draft-canvas__")),
            "no built-in tool reaches a Nodi run: {tools:?}"
        );

        let events = parse_all(REAL_TURN);
        assert!(matches!(&events[0], RunEvent::Started { .. }));
        assert!(
            matches!(&events[1], RunEvent::ToolCall { tool, status: ToolStatus::InProgress, .. } if tool == "get_capabilities")
        );
        assert!(matches!(
            &events[2],
            RunEvent::ToolCallUpdate { status: ToolStatus::Failed, error: Some(e), .. } if e.contains("APP_UNAVAILABLE")
        ));
        let reply: String = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::MessageChunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(reply.starts_with("I called get_capabilities once"));
        // Streamed in pieces, then repeated whole: the whole message isn't counted twice.
        assert_eq!(reply.matches("I called").count(), 1);
        assert!(matches!(
            events.last(),
            Some(RunEvent::Stopped {
                reason: StopReason::EndTurn,
                cost_micro_usd: Some(126_415),
                usage: Some(Usage {
                    input: 60_953,
                    cached: 30_392,
                    output: 114,
                }),
                ..
            })
        ));
    }

    #[test]
    fn a_real_signed_out_run_says_how_to_sign_in_once() {
        let events = parse_all(SIGNED_OUT_RUN);
        assert_eq!(
            events,
            vec![
                RunEvent::Started {
                    session: "3f1c2a4e-0000-4000-8000-0000000000a2".into()
                },
                RunEvent::Stopped {
                    reason: StopReason::Failed {
                        message: SIGNED_OUT.into()
                    },
                    summary: None,
                    cost_micro_usd: Some(0),
                    usage: Some(Usage::default()),
                },
            ]
        );
    }

    #[test]
    fn a_whole_message_counts_only_when_nothing_was_streamed() {
        let mut parser = ClaudeCode.parser();
        let message =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#;
        assert_eq!(
            parser.parse(message),
            vec![RunEvent::MessageChunk {
                text: "Hello".into()
            }]
        );
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#;
        assert_eq!(parser.parse(delta).len(), 1);
        assert!(parser.parse(message).is_empty());
    }

    #[test]
    fn a_result_is_read_from_more_than_its_subtype() {
        let parse = |line: &str| ClaudeCode.parser().parse(line);
        assert_eq!(
            parse(
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"#
            ),
            vec![RunEvent::Stopped {
                reason: StopReason::Failed {
                    message: "Invalid API key · Please run /login".into()
                },
                summary: None,
                cost_micro_usd: None,
                usage: None
            }]
        );
        assert!(matches!(
            parse(r#"{"type":"result","subtype":"error_max_turns","is_error":false}"#)[..],
            [RunEvent::Stopped {
                reason: StopReason::MaxTurns,
                ..
            }]
        ));
        assert!(matches!(
            parse(
                r#"{"type":"result","subtype":"success","stop_reason":"refusal","result":"No."}"#
            )[..],
            [RunEvent::Stopped {
                reason: StopReason::Refusal,
                ..
            }]
        ));
        assert!(matches!(
            &parse(r#"{"type":"result","subtype":"error_during_execution","errors":["Boom"]}"#)[..],
            [RunEvent::Stopped {
                reason: StopReason::Failed { message },
                ..
            }] if message == "Boom"
        ));
    }

    #[test]
    fn draft_canvas_missing_from_the_agent_stops_the_run_at_once() {
        let line = r#"{"type":"system","subtype":"init","session_id":"s","mcp_servers":[{"name":"draft-canvas","status":"failed"}]}"#;
        let events = ClaudeCode.parser().parse(line);
        assert!(matches!(
            &events[..],
            [
                RunEvent::Started { .. },
                RunEvent::Stopped {
                    reason: StopReason::Failed { .. },
                    ..
                }
            ]
        ));
    }

    #[test]
    fn noise_and_unknown_lines_are_ignored() {
        let mut parser = ClaudeCode.parser();
        for line in [
            "",
            "not json",
            r#"{"type":"rate_limit_event"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"never-started"}]}}"#,
        ] {
            assert!(parser.parse(line).is_empty(), "{line}");
        }
    }

    #[test]
    fn the_command_keeps_the_agent_to_draft_canvas_and_the_prompt_off_the_command_line() {
        let spec = RunSpec {
            program: Path::new("/bin/claude"),
            work_dir: Path::new("/tmp/work"),
            mcp_config: Path::new("/tmp/runs/r/mcp.json"),
            server: Path::new("/App/draft-canvas-mcp"),
            server_env: &[],
            brief: "BRIEF",
            session: SessionArg::New("s-new"),
        };
        let args = args(&spec);
        let after = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args[i + 1].as_str())
        };
        assert_eq!(after("--tools"), Some(""));
        assert_eq!(after("--allowedTools"), Some("mcp__draft-canvas__*"));
        assert_eq!(after("--permission-prompts"), Some("none"));
        assert_eq!(after("--mcp-config"), Some("/tmp/runs/r/mcp.json"));
        assert_eq!(after("--session-id"), Some("s-new"));
        assert_eq!(after("--system-prompt"), Some("BRIEF"));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(after("--resume").is_none());
        let resumed = super::args(&RunSpec {
            session: SessionArg::Resume("s-old"),
            ..spec
        });
        assert!(resumed.windows(2).any(|w| w == ["--resume", "s-old"]));
        assert!(!resumed.contains(&"--session-id".to_string()));
    }

    #[test]
    fn version_and_sign_in_are_read_from_the_cli_answers() {
        assert_eq!(
            version_of("2.1.295 (Claude Code)\n"),
            Some(semver::Version::new(2, 1, 295))
        );
        assert_eq!(version_of("garbage"), None);
        let signed = sign_in_of(
            r#"{"loggedIn":true,"authMethod":"claude.ai","projectsDirectory":"/Users/x/.claude/projects"}"#,
        );
        assert_eq!(signed.logged_in, Some(true));
        assert_eq!(signed.method.as_deref(), Some("claude.ai"));
        assert!(signed.transcripts.is_some());
        assert_eq!(sign_in_of("nope"), SignIn::default());
    }
}
