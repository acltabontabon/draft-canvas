//! One-click setup for the coding agents whose MCP configuration Draft Canvas can write for the
//! person, from Settings → AI agents.
//!
//! - **Codex** keeps its servers in `config.toml` (in `CODEX_HOME`, `~/.codex` by default), which the
//!   Codex app, CLI and IDE extension all read. Codex may be installed without a CLI on the PATH (the
//!   desktop app bundles its own), so the file is edited here: only the `draft-canvas` table changes,
//!   every other byte — comments, order, other servers — is kept, and an unreadable file is refused
//!   rather than replaced.
//! - **Claude Code** rewrites `~/.claude.json` from every running session, so it is never written here;
//!   its own `claude mcp add --scope user` does it. The file is only read, to say whether it's set up.
//! - **Gemini CLI** keeps its servers in `~/.gemini/settings.json` beside every other setting, in JSON
//!   that may carry comments it preserves on its own saves; so, as for Claude Code, its own
//!   `gemini mcp add --scope user` writes it, and the file is only read.
//! - **Junie** (in JetBrains IDEs and the Junie CLI alike) reads `~/.junie/mcp/mcp.json`, a file of
//!   servers only, and has no command to add one, so it's edited here as Codex's is: only the Draft
//!   Canvas entry changes; every other server keeps its place and the exact text it was written as.
//!
//! Cursor needs none of this: its `cursor://` link has Cursor write its own configuration.

use crate::docio::{self, WriteOutcome};
use crate::errors::{AppError, ErrorKind};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The name every setup registers the connector under.
pub const SERVER_NAME: &str = "draft-canvas";

/// Codex gives a tool 60 seconds by default, but the sidecar waits up to two minutes for the app
/// (`CALL_TIMEOUT` in `mcp/src/bridge.rs`): a large layout would end in Codex's generic timeout
/// instead of the app's own answer. A little past the sidecar's limit, so its message arrives first.
pub const CODEX_TOOL_TIMEOUT_SECS: i64 = 150;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Client {
    Codex,
    ClaudeCode,
    Gemini,
    Junie,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SetupState {
    /// No Draft Canvas server in the client's configuration.
    NotSetUp,
    /// It launches this app's connector.
    Ready,
    /// It launches some other copy of the connector (a moved or older app), or is turned off.
    Outdated,
}

/// Where one client's setup stands, as Settings shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSetup {
    pub client: Client,
    pub state: SetupState,
    /// Whether the button can do the setup itself. False for Claude Code and Gemini CLI when their CLI
    /// can't be found; Settings then offers the command to run instead.
    pub automatic: bool,
    /// The configuration file, written for a person (`~/.codex/config.toml`).
    pub location: Option<String>,
    /// What an outdated entry launches instead of this app's connector.
    pub configured_command: Option<String>,
}

/// The connector the entry names, and whether it's switched on.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    name: String,
    command: Option<String>,
    enabled: bool,
}

fn state_of(entry: Option<&Entry>, sidecar: &Path) -> SetupState {
    match entry {
        None => SetupState::NotSetUp,
        Some(entry)
            if entry.enabled
                && entry
                    .command
                    .as_deref()
                    .is_some_and(|c| same_path(c, sidecar)) =>
        {
            SetupState::Ready
        }
        Some(_) => SetupState::Outdated,
    }
}

fn same_path(command: &str, sidecar: &Path) -> bool {
    let command = Path::new(command);
    command == sidecar
        || dunce::canonicalize(command)
            .ok()
            .zip(dunce::canonicalize(sidecar).ok())
            .is_some_and(|(a, b)| a == b)
}

/// Whether a configured command is a Draft Canvas connector, whatever the server was named: someone
/// who added it by hand as `draftcanvas` gets that entry updated, not a second one beside it.
fn is_connector(command: &str) -> bool {
    let name = Path::new(command)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name == "draft-canvas-mcp" || name == "draft-canvas-mcp.exe"
}

/// The entry named `draft-canvas`, or else the first that launches a connector.
fn pick<'a>(entries: impl Iterator<Item = (&'a str, Option<String>, bool)>) -> Option<Entry> {
    let mut by_command = None;
    for (name, command, enabled) in entries {
        let entry = Entry {
            name: name.to_string(),
            command,
            enabled,
        };
        if name == SERVER_NAME {
            return Some(entry);
        }
        if by_command.is_none() && entry.command.as_deref().is_some_and(is_connector) {
            by_command = Some(entry);
        }
    }
    by_command
}

fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn unavailable(message: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Io, message.into())
}

// --- Codex -------------------------------------------------------------------------------------

/// Codex's own folder: `CODEX_HOME`, else `~/.codex`.
pub(crate) fn codex_home() -> Option<PathBuf> {
    env_dir("CODEX_HOME").or_else(|| home().map(|h| h.join(".codex")))
}

fn codex_config() -> Option<PathBuf> {
    codex_home().map(|dir| dir.join("config.toml"))
}

fn codex_entry(doc: &toml_edit::DocumentMut) -> Option<Entry> {
    let servers = doc.get("mcp_servers")?.as_table_like()?;
    pick(servers.iter().filter_map(|(name, item)| {
        let table = item.as_table_like()?;
        let command = table
            .get("command")
            .and_then(|c| c.as_str())
            .map(str::to_string);
        let enabled = table
            .get("enabled")
            .and_then(|e| e.as_bool())
            .unwrap_or(true);
        Some((name, command, enabled))
    }))
}

fn parse_codex(text: &str) -> Result<toml_edit::DocumentMut, AppError> {
    text.parse::<toml_edit::DocumentMut>().map_err(|e| {
        let line = e
            .span()
            .map(|span| text[..span.start.min(text.len())].lines().count().max(1));
        unavailable(match line {
            Some(line) => format!(
                "Codex’s config.toml has a mistake on line {line}, so Draft Canvas left it alone. Fix it, then try again."
            ),
            None => "Codex’s config.toml couldn’t be read, so Draft Canvas left it alone. Fix it, then try again.".to_string(),
        })
    })
}

/// `text` with the connector set up: the existing Draft Canvas entry pointed at `sidecar` (and
/// switched back on), or a new `[mcp_servers.draft-canvas]` table. Settings someone added to the entry
/// themselves — an approval mode, a longer timeout — are kept.
pub fn codex_with_connector(text: &str, sidecar: &Path) -> Result<String, AppError> {
    let mut doc = parse_codex(text)?;
    let name = codex_entry(&doc).map_or_else(|| SERVER_NAME.to_string(), |e| e.name);
    if doc.get("mcp_servers").is_none() {
        let mut servers = toml_edit::Table::new();
        // Only `[mcp_servers.draft-canvas]` is written, not an empty `[mcp_servers]` above it.
        servers.set_implicit(true);
        doc.insert("mcp_servers", toml_edit::Item::Table(servers));
    }
    let servers = doc["mcp_servers"]
        .as_table_like_mut()
        .ok_or_else(|| unavailable("Codex’s config.toml defines mcp_servers in a way Draft Canvas can’t change. Add the server by hand instead."))?;
    if servers.get(&name).is_none() {
        servers.insert(&name, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    let entry = servers
        .get_mut(&name)
        .and_then(|item| item.as_table_like_mut())
        .ok_or_else(|| unavailable("Codex’s Draft Canvas entry isn’t a table Draft Canvas can change. Remove it, then try again."))?;
    let command = sidecar.to_string_lossy().into_owned();
    match entry
        .get_mut("command")
        .and_then(|item| item.as_value_mut())
    {
        // Repointed in place: `insert` would reset the line, losing a comment beside or above it.
        Some(value) => {
            let decor = value.decor().clone();
            *value = toml_edit::Value::from(command);
            *value.decor_mut() = decor;
        }
        None => {
            entry.insert("command", toml_edit::value(command));
        }
    }
    if entry.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
        entry.remove("enabled");
    }
    if entry.get("tool_timeout_sec").is_none() {
        entry.insert(
            "tool_timeout_sec",
            toml_edit::value(CODEX_TOOL_TIMEOUT_SECS),
        );
    }
    Ok(doc.to_string())
}

fn codex_status(sidecar: &Path) -> ClientSetup {
    let path = codex_config();
    let entry = path
        .as_deref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
        .and_then(|doc| codex_entry(&doc));
    ClientSetup {
        client: Client::Codex,
        state: state_of(entry.as_ref(), sidecar),
        automatic: path.is_some(),
        location: path.as_deref().map(crate::paths::display_path),
        configured_command: entry.and_then(|e| e.command),
    }
}

fn codex_connect(sidecar: &Path) -> Result<(), AppError> {
    let path = codex_config().ok_or_else(|| {
        unavailable("Draft Canvas couldn’t find your home folder to set up Codex.")
    })?;
    edit_config(&path, "Codex", |text| codex_with_connector(text, sidecar))
}

/// Rewrites the agent's configuration file at `path` through `change` (given "" when there is none
/// yet). Read, change, and swap in only if nobody wrote the file meanwhile: the agent itself saves to
/// it (Codex trusting a project, say), and that save must not be lost to this one.
fn edit_config(
    path: &Path,
    agent: &str,
    change: impl Fn(&str) -> Result<String, AppError>,
) -> Result<(), AppError> {
    for _ in 0..3 {
        let outcome = match docio::read_document(path) {
            Ok(read) => {
                let text = change(&read.text)?;
                docio::write_atomic(path, text.as_bytes(), Some(&read.stamp))?
            }
            Err(e) if e.kind == ErrorKind::NotFound => {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| {
                        AppError::from_io(
                            &e,
                            crate::errors::Verb::Save,
                            crate::errors::Subject::Path(dir),
                        )
                    })?;
                }
                let text = change("")?;
                match docio::create_new_atomic(path, text.as_bytes()) {
                    Ok(stamp) => WriteOutcome::Saved { stamp },
                    Err(e) if e.kind == ErrorKind::AlreadyExists => WriteOutcome::Conflict,
                    Err(e) => return Err(e),
                }
            }
            Err(e) => return Err(e),
        };
        if let WriteOutcome::Saved { .. } = outcome {
            return Ok(());
        }
    }
    Err(unavailable(format!(
        "{agent} kept changing its settings while Draft Canvas was saving them. Try again in a moment."
    )))
}

// --- Claude Code -------------------------------------------------------------------------------

/// `~/.claude.json`, where `claude mcp add --scope user` keeps the servers every project sees.
fn claude_config() -> Option<PathBuf> {
    env_dir("CLAUDE_CONFIG_DIR")
        .or_else(home)
        .map(|dir| dir.join(".claude.json"))
}

/// The Draft Canvas entry in a JSON `mcpServers` object — the shape Claude Code, Gemini CLI and Junie
/// all use.
fn servers_entry(config: &Value) -> Option<Entry> {
    let servers = config.get("mcpServers")?.as_object()?;
    pick(servers.iter().map(|(name, server)| {
        let command = server
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string);
        (name.as_str(), command, true)
    }))
}

fn read_servers_entry(path: Option<PathBuf>) -> Option<Entry> {
    let text = std::fs::read_to_string(path?).ok()?;
    servers_entry(&serde_json::from_str(&without_comments(&text)).ok()?)
}

/// `text` with its `//` and `/* */` comments blanked out, strings left alone: Gemini CLI reads its
/// settings that way, so a commented file must still be seen as set up.
fn without_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                '\\' => out.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while chars.peek().is_some_and(|&n| n != '\n') {
                    chars.next();
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = '\0';
                for n in chars.by_ref() {
                    if n == '\n' {
                        // Kept, so a mistake later in the file is still reported on its own line.
                        out.push('\n');
                    }
                    if last == '*' && n == '/' {
                        break;
                    }
                    last = n;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    out
}

fn read_claude_entry() -> Option<Entry> {
    read_servers_entry(claude_config())
}

/// Where an agent's command (`claude`, `gemini`) is. An app started from the Dock or Start menu
/// doesn't have the PATH a terminal has, so the installers' usual places (`known`) are tried first,
/// then this process's PATH, then (on macOS and Linux) the PATH the person's login shell would give a
/// terminal. `names` are the file names it may have: on Windows an npm install leaves a `.cmd`.
fn find_cli(program: &str, names: &[&str], known: Vec<PathBuf>) -> Option<PathBuf> {
    let mut candidates = known;
    if cfg!(not(windows)) {
        candidates.push(Path::new("/opt/homebrew/bin").join(program));
        candidates.push(Path::new("/usr/local/bin").join(program));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.extend(names.iter().map(|name| dir.join(name)));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .or_else(|| login_shell_find(program))
}

pub(crate) fn find_claude() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let known = home()
        .map(|home| {
            vec![
                home.join(".local/bin").join(exe),
                home.join(".claude/local").join(exe),
            ]
        })
        .unwrap_or_default();
    find_cli("claude", &[exe], known)
}

/// The Codex CLI: its standalone installer's folder, Homebrew, or an npm global (`codex.cmd` on
/// Windows), wherever the person's shell finds it.
pub(crate) fn find_codex() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd"]
    } else {
        &["codex"]
    };
    let known = home()
        .map(|home| {
            vec![
                home.join(".local/bin").join(names[0]),
                home.join(".codex/bin").join(names[0]),
            ]
        })
        .unwrap_or_default();
    find_cli("codex", names, known)
}

/// This process's PATH with `dir` first, or `None` when there is no folder to add.
pub(crate) fn path_with(dir: Option<&Path>) -> Option<std::ffi::OsString> {
    let dir = dir.filter(|d| !d.as_os_str().is_empty())?;
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(
        std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&inherited)),
    )
    .ok()
}

#[cfg(not(windows))]
fn login_shell_find(program: &str) -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty())?;
    let mut command = Command::new(shell);
    command.args(["-l", "-i", "-c", &format!("command -v {program}")]);
    let output = run(command, Duration::from_secs(5)).ok()?;
    // Startup files may print their own lines first; the answer is the last absolute path.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

#[cfg(windows)]
fn login_shell_find(_program: &str) -> Option<PathBuf> {
    None
}

pub(crate) struct Output {
    pub(crate) success: bool,
    pub(crate) stdout: Vec<u8>,
    /// Some CLIs answer a status question here (`codex login status`).
    pub(crate) stderr: Vec<u8>,
}

/// Runs `command` without a console window. The deadline covers both exit and pipe EOF: an
/// exited CLI may have left a child holding its pipes. Output and the reader queue are bounded too.
pub(crate) fn run(mut command: Command, limit: Duration) -> std::io::Result<Output> {
    use std::sync::mpsc::{self, RecvTimeoutError};
    const MAX_OUTPUT: usize = 1024 * 1024;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (tx, rx) = mpsc::sync_channel(8);
    let drain = |mut pipe: Box<dyn Read + Send>, stdout: bool| {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(count) = pipe.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if tx.send((stdout, Some(buffer[..count].to_vec()))).is_err() {
                    return;
                }
            }
            let _ = tx.send((stdout, None));
        });
    };
    drain(Box::new(child.stdout.take().expect("piped")), true);
    drain(Box::new(child.stderr.take().expect("piped")), false);
    drop(tx);
    let deadline = Instant::now() + limit;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut status = None;
    let mut closed = 0;
    let result = loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(next) => status = next,
                Err(error) => break Err(error),
            }
        }
        if closed == 2 {
            if let Some(status) = status {
                break Ok(status);
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out",
            ));
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(40))) {
            Ok((is_stdout, Some(bytes))) => {
                if stdout.len() + stderr.len() + bytes.len() > MAX_OUTPUT {
                    break Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "CLI output exceeded its limit",
                    ));
                }
                if is_stdout {
                    stdout.extend(bytes);
                } else {
                    stderr.extend(bytes);
                }
            }
            Ok((_, None)) => closed += 1,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // Both readers finished; wait for process exit without spinning on the closed queue.
                closed = 2;
                std::thread::sleep(remaining.min(Duration::from_millis(40)));
            }
        }
    };
    if result.is_err() {
        stop_probe_tree(&mut child);
        let _ = child.wait();
    }
    let status = result?;
    Ok(Output {
        success: status.success(),
        stdout,
        stderr,
    })
}

/// Stop the whole probe, including children that keep stdout/stderr open after the CLI exited.
fn stop_probe_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: kill takes integers; process_group(0) gave this probe its own group.
            unsafe {
                kill(-pid, 9);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

fn claude_status(sidecar: &Path) -> ClientSetup {
    let entry = read_claude_entry();
    ClientSetup {
        client: Client::ClaudeCode,
        state: state_of(entry.as_ref(), sidecar),
        automatic: find_claude().is_some(),
        location: claude_config().as_deref().map(crate::paths::display_path),
        configured_command: entry.and_then(|e| e.command),
    }
}

fn claude_connect(sidecar: &Path) -> Result<(), AppError> {
    let claude = find_claude().ok_or_else(|| unavailable("Draft Canvas couldn’t find the claude command. Run the command below in a terminal instead."))?;
    // `mcp add` refuses a name that's taken, so an entry pointing elsewhere is removed first.
    if let Some(entry) = read_claude_entry() {
        let _ = run_cli(
            &claude,
            &["mcp", "remove", "--scope", "user", &entry.name],
            None,
        );
    }
    let add = ["mcp", "add", "--scope", "user", SERVER_NAME, "--"];
    added("Claude Code", run_cli(&claude, &add, Some(sidecar)))
}

/// Runs an agent's own command with `args` and then `path`, in the person's home folder — the agent's
/// user-level configuration, not wherever this app happens to be started from.
fn run_cli(program: &Path, args: &[&str], path: Option<&Path>) -> std::io::Result<Output> {
    let mut command = Command::new(program);
    command.args(args).args(path);
    // An npm install's `claude` or `gemini` is a `#!/usr/bin/env node` script, and an app started
    // from the Dock has no `node` on its PATH. npm put `node` beside it, so that folder comes first.
    if let Some(path) = path_with(program.parent()) {
        command.env("PATH", path);
    }
    if let Some(home) = home() {
        command.current_dir(home);
    }
    run(command, Duration::from_secs(20))
}

/// What an agent's `mcp add` came to, worded for Settings.
fn added(agent: &str, output: std::io::Result<Output>) -> Result<(), AppError> {
    let output = output.map_err(|_| {
        unavailable(format!(
            "{agent} didn’t answer. Run the command below in a terminal instead."
        ))
    })?;
    if output.success {
        return Ok(());
    }
    let said = String::from_utf8_lossy(if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    })
    .lines()
    .map(str::trim)
    .find(|l| !l.is_empty())
    .unwrap_or("it didn’t say why")
    .to_string();
    Err(unavailable(format!(
        "{agent} couldn’t add Draft Canvas: {said}"
    )))
}

// --- Gemini CLI --------------------------------------------------------------------------------

/// `~/.gemini/settings.json`, where `gemini mcp add --scope user` keeps the servers every project sees.
fn gemini_config() -> Option<PathBuf> {
    home().map(|h| h.join(".gemini").join("settings.json"))
}

fn find_gemini() -> Option<PathBuf> {
    // npm's global folder on Windows, which an app started from the Start menu may not have on PATH.
    let known = std::env::var_os("APPDATA")
        .filter(|d| cfg!(windows) && !d.is_empty())
        .map(|d| vec![PathBuf::from(d).join("npm").join("gemini.cmd")])
        .unwrap_or_default();
    find_cli("gemini", &["gemini", "gemini.cmd", "gemini.exe"], known)
}

fn gemini_status(sidecar: &Path) -> ClientSetup {
    let path = gemini_config();
    let entry = read_servers_entry(path.clone());
    ClientSetup {
        client: Client::Gemini,
        state: state_of(entry.as_ref(), sidecar),
        automatic: find_gemini().is_some(),
        location: path.as_deref().map(crate::paths::display_path),
        configured_command: entry.and_then(|e| e.command),
    }
}

fn gemini_connect(sidecar: &Path) -> Result<(), AppError> {
    let gemini = find_gemini().ok_or_else(|| unavailable("Draft Canvas couldn’t find the gemini command. Run the command below in a terminal instead."))?;
    // Removed first so a hand-made entry under another name doesn't stay beside the new one.
    if let Some(entry) = read_servers_entry(gemini_config()) {
        let _ = run_cli(
            &gemini,
            &["mcp", "remove", "--scope", "user", &entry.name],
            None,
        );
    }
    // No `--` before the command: Gemini CLI would take it for the end of the positional arguments.
    let add = ["mcp", "add", "--scope", "user", SERVER_NAME];
    added("Gemini CLI", run_cli(&gemini, &add, Some(sidecar)))
}

// --- Junie -------------------------------------------------------------------------------------

/// `~/.junie/mcp/mcp.json`, the servers Junie gives every project, in the IDE and the CLI alike.
fn junie_config() -> Option<PathBuf> {
    home().map(|h| h.join(".junie").join("mcp").join("mcp.json"))
}

/// A JSON value as it's rewritten: an object Draft Canvas changes inside, or the exact text it was
/// read as — so whatever it doesn't touch keeps its order, spacing and spelling.
enum Json {
    Raw(Box<RawValue>),
    Object(Vec<(String, Json)>),
}

impl Serialize for Json {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Json::Raw(raw) => raw.serialize(serializer),
            Json::Object(members) => {
                let mut map = serializer.serialize_map(Some(members.len()))?;
                for (key, value) in members {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

/// An object's members in the order they were written, each value kept as its own text.
struct Members(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Members;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Members, A::Error> {
                let mut members = Vec::new();
                while let Some(member) = map.next_entry::<String, Box<RawValue>>()? {
                    members.push(member);
                }
                Ok(Members(members))
            }
        }
        deserializer.deserialize_map(Visit)
    }
}

fn object_of(text: &str) -> Option<Vec<(String, Json)>> {
    let Members(members) = serde_json::from_str(text).ok()?;
    Some(
        members
            .into_iter()
            .map(|(k, v)| (k, Json::Raw(v)))
            .collect(),
    )
}

/// The object at `key` among `members`, opened up for changing; added when it's missing. `None` when
/// `key` holds something other than an object. The last of repeated keys, as JSON readers take.
fn member_object<'a>(
    members: &'a mut Vec<(String, Json)>,
    key: &str,
) -> Option<&'a mut Vec<(String, Json)>> {
    let at = match members.iter().rposition(|(k, _)| k == key) {
        Some(at) => at,
        None => {
            members.push((key.to_string(), Json::Object(Vec::new())));
            members.len() - 1
        }
    };
    let value = &mut members[at].1;
    if let Json::Raw(raw) = value {
        *value = Json::Object(object_of(raw.get())?);
    }
    match value {
        Json::Object(inner) => Some(inner),
        Json::Raw(_) => None,
    }
}

/// The indent the file was written with, so what's rewritten lines up with what's kept.
fn indent_of(text: &str) -> &str {
    text.lines()
        .skip(1)
        .find(|line| !line.trim().is_empty())
        .map(|line| &line[..line.len() - line.trim_start_matches([' ', '\t']).len()])
        .filter(|indent| !indent.is_empty())
        .unwrap_or("  ")
}

/// `text` with the connector set up: the existing Draft Canvas entry pointed at `sidecar`, or a new
/// `draft-canvas` server. Other servers, and anything the person added to the entry, are kept.
pub fn junie_with_connector(text: &str, sidecar: &Path) -> Result<String, AppError> {
    let text = if text.trim().is_empty() { "{}" } else { text };
    let config: Value = serde_json::from_str(text).map_err(|e| {
        unavailable(format!(
            "Junie’s mcp.json has a mistake on line {}, so Draft Canvas left it alone. Fix it, then try again.",
            e.line().max(1)
        ))
    })?;
    let refuse = || {
        unavailable("Junie’s mcp.json isn’t laid out in a way Draft Canvas can change. Add the server by hand instead.")
    };
    let name = servers_entry(&config).map_or_else(|| SERVER_NAME.to_string(), |e| e.name);
    let mut root = object_of(text).ok_or_else(refuse)?;
    let servers = member_object(&mut root, "mcpServers").ok_or_else(refuse)?;
    let entry = member_object(servers, &name).ok_or_else(refuse)?;
    let command = Json::Raw(
        serde_json::value::to_raw_value(&sidecar.to_string_lossy()).map_err(|_| refuse())?,
    );
    match entry.iter_mut().rfind(|(k, _)| k == "command") {
        Some((_, value)) => *value = command,
        None => entry.insert(0, ("command".to_string(), command)),
    }

    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent_of(text).as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    Json::Object(root)
        .serialize(&mut serializer)
        .map_err(|_| refuse())?;
    let mut out = String::from_utf8(out).map_err(|_| refuse())?;
    out.push('\n');
    Ok(out)
}

fn junie_status(sidecar: &Path) -> ClientSetup {
    let path = junie_config();
    let entry = read_servers_entry(path.clone());
    ClientSetup {
        client: Client::Junie,
        state: state_of(entry.as_ref(), sidecar),
        automatic: path.is_some(),
        location: path.as_deref().map(crate::paths::display_path),
        configured_command: entry.and_then(|e| e.command),
    }
}

fn junie_connect(sidecar: &Path) -> Result<(), AppError> {
    let path = junie_config().ok_or_else(|| {
        unavailable("Draft Canvas couldn’t find your home folder to set up Junie.")
    })?;
    edit_config(&path, "Junie", |text| junie_with_connector(text, sidecar))
}

// --- Settings ----------------------------------------------------------------------------------

pub fn status(sidecar: &Path) -> Vec<ClientSetup> {
    vec![
        codex_status(sidecar),
        claude_status(sidecar),
        gemini_status(sidecar),
        junie_status(sidecar),
    ]
}

pub fn connect(client: Client, sidecar: &Path) -> Result<ClientSetup, AppError> {
    match client {
        Client::Codex => {
            codex_connect(sidecar)?;
            Ok(codex_status(sidecar))
        }
        Client::ClaudeCode => {
            claude_connect(sidecar)?;
            Ok(claude_status(sidecar))
        }
        Client::Gemini => {
            gemini_connect(sidecar)?;
            Ok(gemini_status(sidecar))
        }
        Client::Junie => {
            junie_connect(sidecar)?;
            Ok(junie_status(sidecar))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIDECAR: &str = "/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp";

    fn entry_of(text: &str) -> Option<Entry> {
        codex_entry(&text.parse().unwrap())
    }

    #[test]
    fn cli_probes_bound_output_and_keep_nonzero_exit_status() {
        let mut command = crate::companion::runner::tests::shell(
            "echo hello; echo denied >&2; exit 3",
            "(echo hello& echo denied 1>&2& exit /b 3)",
        );
        let output = run(command, Duration::from_secs(5)).unwrap();
        assert!(!output.success);
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("denied"));
        command = crate::companion::runner::tests::shell(
            "while :; do echo 0123456789012345678901234567890123456789; done",
            "for /L %i in (1,1,100000) do @echo 0123456789012345678901234567890123456789",
        );
        assert_eq!(
            run(command, Duration::from_secs(5)).err().unwrap().kind(),
            std::io::ErrorKind::InvalidData
        );
    }

    #[cfg(unix)]
    #[test]
    fn cli_probe_timeout_includes_pipes_inherited_by_children() {
        let command = crate::companion::runner::tests::shell("sleep 30 & exit 0", "");
        let started = Instant::now();
        assert_eq!(
            run(command, Duration::from_millis(200))
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn an_empty_codex_config_gets_one_server_table_and_nothing_else() {
        let text = codex_with_connector("", Path::new(SIDECAR)).unwrap();
        assert_eq!(
            text,
            format!(
                "[mcp_servers.draft-canvas]\ncommand = \"{SIDECAR}\"\ntool_timeout_sec = {CODEX_TOOL_TIMEOUT_SECS}\n"
            )
        );
        let entry = entry_of(&text).unwrap();
        assert_eq!(entry.command.as_deref(), Some(SIDECAR));
        assert_eq!(
            state_of(Some(&entry), Path::new(SIDECAR)),
            SetupState::Ready
        );
    }

    #[test]
    fn everything_else_in_the_codex_config_is_kept_byte_for_byte() {
        let before = "# my settings\nmodel = \"gpt-5\"   # keep this comment\n\n[mcp_servers.other]\ncommand = \"npx\"\nargs = [\"-y\", \"x\"]\n\n[projects.\"/work\"]\ntrust_level = \"trusted\"\n";
        let after = codex_with_connector(before, Path::new(SIDECAR)).unwrap();
        // The new table goes beside the other servers; taking it out again gives back the original.
        let table = format!(
            "[mcp_servers.draft-canvas]\ncommand = \"{SIDECAR}\"\ntool_timeout_sec = {CODEX_TOOL_TIMEOUT_SECS}\n\n"
        );
        assert!(
            after.contains(&format!("args = [\"-y\", \"x\"]\n\n{table}[projects.")),
            "{after}"
        );
        assert_eq!(after.replace(&table, ""), before);
        // Doing it again changes nothing.
        assert_eq!(
            codex_with_connector(&after, Path::new(SIDECAR)).unwrap(),
            after
        );
    }

    #[test]
    fn an_existing_entry_is_repointed_in_place_keeping_what_the_person_added() {
        let before = "[mcp_servers.draftcanvas]\ncommand = \"/old/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp\"\nenabled = false\ntool_timeout_sec = 600\ndefault_tools_approval_mode = \"writes\"\n";
        let old = entry_of(before).unwrap();
        assert_eq!(old.name, "draftcanvas");
        assert_eq!(
            state_of(Some(&old), Path::new(SIDECAR)),
            SetupState::Outdated
        );

        let after = codex_with_connector(before, Path::new(SIDECAR)).unwrap();
        assert!(
            !after.contains("[mcp_servers.draft-canvas]"),
            "no second entry: {after}"
        );
        assert!(after.contains("tool_timeout_sec = 600"));
        assert!(after.contains("default_tools_approval_mode = \"writes\""));
        assert!(!after.contains("enabled"));
        assert_eq!(
            state_of(entry_of(&after).as_ref(), Path::new(SIDECAR)),
            SetupState::Ready
        );
    }

    #[test]
    fn claude_runs_with_its_own_folder_first_on_the_path() {
        let dir = if cfg!(windows) {
            r"C:\Users\me\AppData\Roaming\npm"
        } else {
            "/Users/me/.nvm/versions/node/v22.14.0/bin"
        };
        let path = path_with(Some(Path::new(dir))).unwrap();
        assert_eq!(
            std::env::split_paths(&path).next().as_deref(),
            Some(Path::new(dir))
        );
        assert!(path_with(None).is_none());
        assert!(path_with(Some(Path::new(""))).is_none());
    }

    #[test]
    fn repointing_keeps_the_comments_on_the_command_line() {
        let before = "[mcp_servers.draft-canvas]\n# installed by Draft Canvas\ncommand = \"/old/draft-canvas-mcp\" # moved later\ntool_timeout_sec = 150\n";
        let after = codex_with_connector(before, Path::new(SIDECAR)).unwrap();
        assert_eq!(
            after,
            format!("[mcp_servers.draft-canvas]\n# installed by Draft Canvas\ncommand = \"{SIDECAR}\" # moved later\ntool_timeout_sec = 150\n")
        );
    }

    #[test]
    fn inline_server_tables_are_changed_where_they_are() {
        let before = "mcp_servers = { other = { command = \"x\" } }\n";
        let after = codex_with_connector(before, Path::new(SIDECAR)).unwrap();
        let entry = entry_of(&after).unwrap();
        assert_eq!(entry.command.as_deref(), Some(SIDECAR));
        assert!(after.contains("other"));
    }

    #[test]
    fn windows_paths_are_quoted_for_toml() {
        let sidecar = r"C:\Program Files\Draft Canvas\draft-canvas-mcp.exe";
        let text = codex_with_connector("", Path::new(sidecar)).unwrap();
        assert_eq!(entry_of(&text).unwrap().command.as_deref(), Some(sidecar));
    }

    #[test]
    fn a_broken_codex_config_is_refused_not_replaced() {
        let error =
            codex_with_connector("model = \"a\"\n[mcp_servers\n", Path::new(SIDECAR)).unwrap_err();
        assert!(error.message.contains("line 2"), "{}", error.message);
    }

    #[test]
    fn claude_code_entries_are_found_by_name_or_by_connector() {
        let config: Value = serde_json::json!({
            "mcpServers": {
                "other": { "type": "stdio", "command": "npx" },
                "dc": { "type": "stdio", "command": "/old/draft-canvas-mcp" }
            }
        });
        let entry = servers_entry(&config).unwrap();
        assert_eq!(entry.name, "dc");
        assert_eq!(
            state_of(Some(&entry), Path::new(SIDECAR)),
            SetupState::Outdated
        );

        let config: Value =
            serde_json::json!({ "mcpServers": { "draft-canvas": { "command": SIDECAR } } });
        assert_eq!(
            state_of(servers_entry(&config).as_ref(), Path::new(SIDECAR)),
            SetupState::Ready
        );
        assert_eq!(servers_entry(&serde_json::json!({ "projects": {} })), None);
    }

    fn junie_entry(text: &str) -> Option<Entry> {
        servers_entry(&serde_json::from_str(text).unwrap())
    }

    #[test]
    fn an_empty_junie_config_gets_one_server_and_nothing_else() {
        for empty in ["", "\n", "{}"] {
            let text = junie_with_connector(empty, Path::new(SIDECAR)).unwrap();
            assert_eq!(
                text,
                format!("{{\n  \"mcpServers\": {{\n    \"draft-canvas\": {{\n      \"command\": \"{SIDECAR}\"\n    }}\n  }}\n}}\n")
            );
            assert_eq!(
                state_of(junie_entry(&text).as_ref(), Path::new(SIDECAR)),
                SetupState::Ready
            );
        }
    }

    #[test]
    fn other_junie_servers_keep_their_order_and_text() {
        // Junie's IDE writes four spaces; the new entry follows suit, and the others aren't touched.
        let before = "{\n    \"mcpServers\": {\n        \"zeta\": {\n            \"command\": \"npx\",\n            \"args\": [\"-y\", \"z\"],\n            \"env\": { \"KEY\": \"v\" }\n        },\n        \"alpha\": {\n            \"url\": \"https://example.com/mcp\"\n        }\n    },\n    \"other\": 1\n}\n";
        let after = junie_with_connector(before, Path::new(SIDECAR)).unwrap();
        assert_eq!(
            after,
            format!("{{\n    \"mcpServers\": {{\n        \"zeta\": {{\n            \"command\": \"npx\",\n            \"args\": [\"-y\", \"z\"],\n            \"env\": {{ \"KEY\": \"v\" }}\n        }},\n        \"alpha\": {{\n            \"url\": \"https://example.com/mcp\"\n        }},\n        \"draft-canvas\": {{\n            \"command\": \"{SIDECAR}\"\n        }}\n    }},\n    \"other\": 1\n}}\n")
        );
        // Doing it again changes nothing.
        assert_eq!(
            junie_with_connector(&after, Path::new(SIDECAR)).unwrap(),
            after
        );
    }

    #[test]
    fn a_junie_entry_is_repointed_in_place_keeping_what_the_person_added() {
        let before = "{\n  \"mcpServers\": {\n    \"dc\": {\n      \"env\": { \"A\": \"1\" },\n      \"command\": \"/old/draft-canvas-mcp\"\n    }\n  }\n}\n";
        assert_eq!(
            state_of(junie_entry(before).as_ref(), Path::new(SIDECAR)),
            SetupState::Outdated
        );
        let after = junie_with_connector(before, Path::new(SIDECAR)).unwrap();
        assert_eq!(after, before.replace("/old/draft-canvas-mcp", SIDECAR));
        let entry = junie_entry(&after).unwrap();
        assert_eq!(entry.name, "dc");
        assert_eq!(
            state_of(Some(&entry), Path::new(SIDECAR)),
            SetupState::Ready
        );
    }

    #[test]
    fn windows_paths_are_escaped_for_junie() {
        let sidecar = r"C:\Program Files\Draft Canvas\draft-canvas-mcp.exe";
        let text = junie_with_connector("", Path::new(sidecar)).unwrap();
        assert!(text.contains(r#""C:\\Program Files\\Draft Canvas\\draft-canvas-mcp.exe""#));
        assert_eq!(
            junie_entry(&text).unwrap().command.as_deref(),
            Some(sidecar)
        );
    }

    #[test]
    fn a_junie_config_draft_canvas_cant_change_is_refused_not_replaced() {
        let broken =
            junie_with_connector("{\n  \"mcpServers\": {\n", Path::new(SIDECAR)).unwrap_err();
        assert!(broken.message.contains("line 3"), "{}", broken.message);
        for odd in [
            "[]",
            "{ \"mcpServers\": [] }",
            "{ \"mcpServers\": { \"draft-canvas\": \"x\" } }",
        ] {
            assert!(
                junie_with_connector(odd, Path::new(SIDECAR)).is_err(),
                "{odd}"
            );
        }
    }

    #[test]
    fn a_junie_config_written_in_a_new_home_reads_back_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".junie/mcp/mcp.json");
        edit_config(&path, "Junie", |text| {
            junie_with_connector(text, Path::new(SIDECAR))
        })
        .unwrap();
        assert_eq!(
            state_of(
                read_servers_entry(Some(path.clone())).as_ref(),
                Path::new(SIDECAR)
            ),
            SetupState::Ready
        );
        // A second run over the file it wrote leaves it as it was.
        let first = std::fs::read_to_string(&path).unwrap();
        edit_config(&path, "Junie", |text| {
            junie_with_connector(text, Path::new(SIDECAR))
        })
        .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
    }

    #[test]
    fn gemini_settings_with_comments_are_still_read() {
        let text = format!(
            "// my settings\n{{\n  /* servers */\n  \"theme\": \"a // not a comment\",\n  \"mcpServers\": {{\n    \"draft-canvas\": {{ \"command\": \"{SIDECAR}\" }} // added by Draft Canvas\n  }}\n}}\n"
        );
        let stripped = without_comments(&text);
        assert_eq!(stripped.lines().count(), text.lines().count());
        let config: Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(config["theme"], "a // not a comment");
        assert_eq!(
            state_of(servers_entry(&config).as_ref(), Path::new(SIDECAR)),
            SetupState::Ready
        );
        assert_eq!(without_comments(r#"{"a": "\"/*"}"#), r#"{"a": "\"/*"}"#);
    }

    #[test]
    fn a_codex_config_written_in_a_new_home_reads_back_ready() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "model = \"a\"\n").unwrap();
        let read = docio::read_document(&path).unwrap();
        let text = codex_with_connector(&read.text, Path::new(SIDECAR)).unwrap();
        assert!(matches!(
            docio::write_atomic(&path, text.as_bytes(), Some(&read.stamp)).unwrap(),
            WriteOutcome::Saved { .. }
        ));
        let back = std::fs::read_to_string(&path).unwrap();
        assert!(back.starts_with("model = \"a\"\n"));
        assert_eq!(entry_of(&back).unwrap().command.as_deref(), Some(SIDECAR));
    }
}
