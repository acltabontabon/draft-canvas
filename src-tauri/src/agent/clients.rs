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
//! - **OpenCode** reads `opencode.json` and `opencode.jsonc` in `~/.config/opencode`, in two layouts
//!   (servers directly under `mcp` for OpenCode 1, under `mcp.servers` for OpenCode 2). Its own
//!   `opencode mcp add` writes only the newer one, so the file is edited here as Junie's is: one Draft
//!   Canvas entry across both files, and a file with comments is read but never rewritten.
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
    Opencode,
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
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A probe runs in the person's home folder unless its caller chose a folder, never wherever this
    // app was started: a double-clicked diagram starts the app in the diagram's own folder, and a CLI
    // installed by npm is a `.cmd` whose `node` cmd.exe looked for in that folder first.
    if command.get_current_dir().is_none() {
        if let Some(home) = home() {
            command.current_dir(home);
        }
    }
    #[cfg(windows)]
    let (mut child, tree) = crate::process_tree::spawn(&mut command)?;
    #[cfg(not(windows))]
    let mut child = command.spawn()?;
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
                Ok(next) => {
                    status = next;
                    #[cfg(windows)]
                    if status.is_some() {
                        if let Err(error) = tree.terminate() {
                            break Err(error);
                        }
                    }
                }
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
        #[cfg(windows)]
        let _ = tree.terminate();
        #[cfg(unix)]
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
#[cfg(unix)]
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

// --- OpenCode ----------------------------------------------------------------------------------

/// The two global files OpenCode reads, lowest precedence first: both are loaded, and `.jsonc`
/// outranks `.json` in OpenCode 1 and 2 alike.
const OPENCODE_FILES: [&str; 2] = ["opencode.json", "opencode.jsonc"];

/// Named in a file Draft Canvas creates, as OpenCode 1 would otherwise rewrite the file to add it.
const OPENCODE_SCHEMA: &str = "https://opencode.ai/config.json";

/// OpenCode's global configuration folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`,
/// on Windows too. `OPENCODE_CONFIG_DIR` is left out on purpose: OpenCode 2 reads it in place of
/// this folder and OpenCode 1 on top of it, so following it would be wrong for one of them.
fn opencode_dir_in(xdg: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    xdg.or_else(|| home.map(|h| h.join(".config")))
        .map(|dir| dir.join("opencode"))
}

fn opencode_dir() -> Option<PathBuf> {
    opencode_dir_in(env_dir("XDG_CONFIG_HOME"), home())
}

/// `text` as strict JSON, for reading only: comments blanked out and the comma before a closing
/// bracket dropped, both of which OpenCode accepts in `.json` and `.jsonc` alike. Lines keep their
/// numbers, so a mistake is still reported where it is.
fn relaxed_json(text: &str) -> String {
    let text = without_comments(text);
    let mut out = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    for (at, c) in text.char_indices() {
        if in_string {
            out.push(c);
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            ',' if text[at + 1..].trim_start().starts_with(['}', ']']) => out.push(' '),
            _ => {
                in_string = c == '"';
                out.push(c);
            }
        }
    }
    out
}

/// A Draft Canvas server in an OpenCode file: one named `draft-canvas`, or one that launches a
/// connector under any name.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    /// Under `mcp.servers` (OpenCode 2's own layout) rather than directly under `mcp`.
    native: bool,
    name: String,
    /// A `"type": "local"` server with a command line, the only kind Draft Canvas repoints.
    local: bool,
    command: Vec<String>,
    enabled: bool,
}

/// Every Draft Canvas server in one file, in both layouts. OpenCode 1 turns a server off with
/// `enabled: false` and OpenCode 2 with `disabled: true`; each ignores or honours the other's flag
/// differently, so either one counts as off.
fn opencode_found(config: &Value) -> Vec<Found> {
    let Some(mcp) = config.get("mcp").and_then(Value::as_object) else {
        return Vec::new();
    };
    let flat = mcp
        .iter()
        .filter(|(name, _)| name.as_str() != "servers")
        .map(|(name, server)| (false, name, server));
    let native = mcp
        .get("servers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, server)| (true, name, server));
    flat.chain(native)
        .filter_map(|(native, name, server)| {
            let command: Vec<String> = server
                .get("command")
                .and_then(Value::as_array)
                .and_then(|parts| {
                    parts
                        .iter()
                        .map(|part| part.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let ours = name == SERVER_NAME || command.first().is_some_and(|c| is_connector(c));
            ours.then(|| Found {
                native,
                name: name.clone(),
                local: server.get("type").and_then(Value::as_str) == Some("local")
                    && !command.is_empty(),
                enabled: server.get("enabled") != Some(&Value::Bool(false))
                    && server.get("disabled") != Some(&Value::Bool(true)),
                command,
            })
        })
        .collect()
}

/// One OpenCode file as OpenCode reads it. An empty file is an empty configuration.
fn opencode_parsed(text: &str, file: &str) -> Result<Value, AppError> {
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&relaxed_json(text)).map_err(|e| {
        unavailable(format!(
            "OpenCode’s {file} has a mistake on line {}, so Draft Canvas left it alone. Fix it, then try again.",
            e.line().max(1)
        ))
    })
}

/// Whether Draft Canvas can rewrite `text` without losing anything: its writer keeps plain JSON
/// only, so a file with comments or trailing commas is read but never changed.
fn opencode_writable(text: &str) -> bool {
    text.trim().is_empty() || serde_json::from_str::<Value>(text).is_ok()
}

fn opencode_commented(file: &str) -> AppError {
    unavailable(format!(
        "OpenCode’s {file} has comments or trailing commas Draft Canvas can’t keep, so it left the file alone. Paste the config below into it instead."
    ))
}

/// OpenCode 1 and 2 settle two entries for one server in opposite ways (merged or replaced across
/// files, `mcp` or `mcp.servers` first within one), so which of them is in force depends on the
/// version: Draft Canvas never guesses, and never leaves a second one.
fn opencode_several(a: &str, b: &str) -> AppError {
    unavailable(if a == b {
        format!("OpenCode has Draft Canvas set up twice in {a}. Keep one entry, then try again.")
    } else {
        format!("OpenCode has Draft Canvas set up in both {a} and {b}. Keep one, then try again.")
    })
}

/// Which of the two files gets the connector, given the text of each that exists: the one already
/// holding a Draft Canvas server, else the first Draft Canvas can rewrite. A commented
/// `opencode.jsonc` is left as it is and `opencode.json` written beside it, which OpenCode reads too.
fn opencode_target(json: Option<&str>, jsonc: Option<&str>) -> Result<&'static str, AppError> {
    let mut holders = Vec::new();
    for (file, text) in OPENCODE_FILES.into_iter().zip([json, jsonc]) {
        let found = opencode_found(&opencode_parsed(text.unwrap_or(""), file)?);
        holders.extend(found.iter().map(|_| file));
    }
    let [first, second] = OPENCODE_FILES;
    let (file, text) = match holders.as_slice() {
        [] if json.is_none_or(opencode_writable) => (first, json),
        [] if jsonc.is_some_and(opencode_writable) => (second, jsonc),
        [] => (first, json),
        [holder] if *holder == first => (first, json),
        [_] => (second, jsonc),
        [a, .., b] => return Err(opencode_several(a, b)),
    };
    if text.is_none_or(opencode_writable) {
        Ok(file)
    } else {
        Err(opencode_commented(file))
    }
}

/// `text` (the file named `file`) with the connector set up. A Draft Canvas server already there is
/// pointed at `sidecar` and switched on, where it is and in the layout it has, keeping its arguments,
/// environment and timeouts. Otherwise a new one is added directly under `mcp`: the layout every
/// OpenCode reads, where `mcp.servers` alone stops OpenCode 1.18.23 and older from starting. Refused,
/// with nothing changed, when the entry isn't a local connector or there is more than one.
pub fn opencode_with_connector(text: &str, sidecar: &Path, file: &str) -> Result<String, AppError> {
    let new = text.trim().is_empty();
    let source = if new { "{}" } else { text };
    let config = opencode_parsed(source, file)?;
    if !opencode_writable(source) {
        return Err(opencode_commented(file));
    }
    let refuse = || {
        unavailable(format!(
            "OpenCode’s {file} isn’t laid out in a way Draft Canvas can change. Add the server by hand instead."
        ))
    };
    let raw = |value: Value| {
        serde_json::value::to_raw_value(&value)
            .map(Json::Raw)
            .map_err(|_| refuse())
    };
    if config
        .pointer("/mcp/servers")
        .is_some_and(|servers| !servers.is_object())
    {
        return Err(refuse());
    }
    let sidecar = sidecar.to_string_lossy().into_owned();
    let mut root = object_of(source).ok_or_else(refuse)?;
    if new {
        root.push(("$schema".to_string(), raw(OPENCODE_SCHEMA.into())?));
    }
    let mcp = member_object(&mut root, "mcp").ok_or_else(refuse)?;
    match &opencode_found(&config)[..] {
        [] => mcp.push((
            SERVER_NAME.to_string(),
            Json::Object(vec![
                ("type".to_string(), raw("local".into())?),
                ("command".to_string(), raw(vec![sidecar].into())?),
                // Said outright, so OpenCode 1 can't merge in an `enabled: false` from its older
                // `config.json`.
                ("enabled".to_string(), raw(true.into())?),
            ]),
        )),
        [entry] => {
            if !entry.local || !is_connector(&entry.command[0]) {
                return Err(unavailable(format!(
                    "OpenCode already has a different server named {} in {file}. Rename or remove it, then try again.",
                    entry.name
                )));
            }
            let servers = if entry.native {
                member_object(mcp, "servers").ok_or_else(refuse)?
            } else {
                mcp
            };
            let server = member_object(servers, &entry.name).ok_or_else(refuse)?;
            let mut set = |key: &str, value: Value| -> Result<(), AppError> {
                if let Some((_, old)) = server.iter_mut().rfind(|(k, _)| k == key) {
                    *old = raw(value)?;
                }
                Ok(())
            };
            // Left as written when it already points here, so a second run changes nothing.
            if entry.command[0] != sidecar {
                let mut command = entry.command.clone();
                command[0] = sidecar;
                set("command", command.into())?;
            }
            set("enabled", true.into())?;
            set("disabled", false.into())?;
        }
        _ => return Err(opencode_several(file, file)),
    }

    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(indent_of(source).as_bytes());
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    Json::Object(root)
        .serialize(&mut serializer)
        .map_err(|_| refuse())?;
    let mut out = String::from_utf8(out).map_err(|_| refuse())?;
    out.push('\n');
    // The formatter ends lines with `\n`; a file saved on Windows keeps its own endings throughout.
    if text.contains("\r\n") {
        out = out.replace("\r\n", "\n").replace('\n', "\r\n");
    }
    Ok(out)
}

/// What the two files say, as far as they can be read: whether Draft Canvas is configured, which is
/// not the same as connected. A project's own `opencode.json`, `OPENCODE_CONFIG` and managed
/// settings can all override these files and can't be seen from here; `opencode mcp list` can.
fn opencode_setup(dir: Option<&Path>, sidecar: &Path) -> ClientSetup {
    let texts = OPENCODE_FILES.map(|file| std::fs::read_to_string(dir?.join(file)).ok());
    let mut found = Vec::new();
    let mut holder = None;
    for (file, text) in OPENCODE_FILES.into_iter().zip(&texts) {
        // A file that can't be read counts for nothing here; setting up says what is wrong with it.
        let Some(config) = text.as_deref().and_then(|t| opencode_parsed(t, file).ok()) else {
            continue;
        };
        let here = opencode_found(&config);
        if holder.is_none() && !here.is_empty() {
            holder = Some(file);
        }
        found.extend(here);
    }
    let state = if found.is_empty() {
        SetupState::NotSetUp
    } else if found
        .iter()
        .all(|f| f.local && f.enabled && f.command.first().is_some_and(|c| same_path(c, sidecar)))
    {
        SetupState::Ready
    } else {
        SetupState::Outdated
    };
    let file = holder
        .or_else(|| opencode_target(texts[0].as_deref(), texts[1].as_deref()).ok())
        .unwrap_or(OPENCODE_FILES[0]);
    ClientSetup {
        client: Client::Opencode,
        state,
        automatic: dir.is_some(),
        location: dir.map(|d| crate::paths::display_path(&d.join(file))),
        configured_command: found.first().and_then(|f| f.command.first().cloned()),
    }
}

fn opencode_connect_in(dir: &Path, sidecar: &Path) -> Result<(), AppError> {
    let mut texts = [None, None];
    for (file, text) in OPENCODE_FILES.into_iter().zip(&mut texts) {
        let path = dir.join(file);
        *text = match std::fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(AppError::from_io(
                    &e,
                    crate::errors::Verb::Open,
                    crate::errors::Subject::Path(&path),
                ));
            }
        };
    }
    let file = opencode_target(texts[0].as_deref(), texts[1].as_deref())?;
    edit_config(&dir.join(file), "OpenCode", |text| {
        opencode_with_connector(text, sidecar, file)
    })
}

fn opencode_connect(sidecar: &Path) -> Result<(), AppError> {
    let dir = opencode_dir().ok_or_else(|| {
        unavailable("Draft Canvas couldn’t find your home folder to set up OpenCode.")
    })?;
    opencode_connect_in(&dir, sidecar)
}

// --- Settings ----------------------------------------------------------------------------------

pub fn status(sidecar: &Path) -> Vec<ClientSetup> {
    vec![
        codex_status(sidecar),
        claude_status(sidecar),
        gemini_status(sidecar),
        junie_status(sidecar),
        opencode_setup(opencode_dir().as_deref(), sidecar),
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
        Client::Opencode => {
            opencode_connect(sidecar)?;
            Ok(opencode_setup(opencode_dir().as_deref(), sidecar))
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

    #[cfg(windows)]
    #[test]
    fn cli_probe_jobs_end_on_timeout_and_on_parent_exit_with_inherited_pipes() {
        let command = crate::companion::runner::tests::shell("", "ping -n 30 127.0.0.1 >nul");
        let started = Instant::now();
        assert_eq!(
            run(command, Duration::from_millis(200))
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        let command = crate::companion::runner::tests::shell(
            "",
            r#"start "" /b ping -n 30 127.0.0.1 & exit /b 0"#,
        );
        let started = Instant::now();
        let output = run(command, Duration::from_secs(2)).unwrap();
        assert!(output.success);
        assert!(started.elapsed() < Duration::from_secs(2));
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

    const OC_FILE: &str = "opencode.json";
    const OC_COMMENTED: &str = "{\n  // mine\n  \"theme\": \"dark\",\n}\n";

    fn oc(text: &str) -> Result<String, AppError> {
        opencode_with_connector(text, Path::new(SIDECAR), OC_FILE)
    }

    fn oc_found(text: &str) -> Vec<Found> {
        opencode_found(&opencode_parsed(text, OC_FILE).unwrap())
    }

    /// A configuration folder holding the given `opencode.json` and `opencode.jsonc`.
    fn oc_dir(json: Option<&str>, jsonc: Option<&str>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (file, text) in OPENCODE_FILES.into_iter().zip([json, jsonc]) {
            if let Some(text) = text {
                std::fs::write(dir.path().join(file), text).unwrap();
            }
        }
        dir
    }

    fn oc_state(json: Option<&str>, jsonc: Option<&str>) -> SetupState {
        opencode_setup(Some(oc_dir(json, jsonc).path()), Path::new(SIDECAR)).state
    }

    /// `text` without its Draft Canvas servers, to compare what else a file holds.
    fn oc_rest(text: &str) -> Value {
        let mut config = opencode_parsed(text, OC_FILE).unwrap();
        for found in opencode_found(&config) {
            let at = if found.native { "/mcp/servers" } else { "/mcp" };
            let servers = config.pointer_mut(at).unwrap().as_object_mut().unwrap();
            servers.remove(&found.name);
        }
        config
    }

    #[test]
    fn opencode_keeps_its_settings_in_the_same_folder_on_every_platform() {
        let home = || Some(PathBuf::from("/home/ada"));
        assert_eq!(
            opencode_dir_in(None, home()),
            Some(PathBuf::from("/home/ada/.config/opencode"))
        );
        assert_eq!(
            opencode_dir_in(Some(PathBuf::from("/xdg")), home()),
            Some(PathBuf::from("/xdg/opencode"))
        );
        // No %APPDATA% on Windows: OpenCode uses .config in the user folder there too.
        assert_eq!(
            opencode_dir_in(None, Some(PathBuf::from(r"C:\Users\ada"))),
            Some(Path::new(r"C:\Users\ada").join(".config").join("opencode"))
        );
        assert_eq!(opencode_dir_in(None, None), None);
    }

    #[test]
    fn an_empty_opencode_config_gets_the_schema_and_one_server() {
        let entry = format!(
            "  \"mcp\": {{\n    \"draft-canvas\": {{\n      \"type\": \"local\",\n      \"command\": [\"{SIDECAR}\"],\n      \"enabled\": true\n    }}\n  }}\n}}\n"
        );
        for empty in ["", "\n"] {
            assert_eq!(
                oc(empty).unwrap(),
                format!("{{\n  \"$schema\": \"https://opencode.ai/config.json\",\n{entry}")
            );
        }
        // A file that is already there keeps its own choice of schema line.
        let text = oc("{}").unwrap();
        assert_eq!(text, format!("{{\n{entry}"));
        assert_eq!(oc_state(Some(&text), None), SetupState::Ready);
    }

    #[test]
    fn everything_else_in_the_opencode_config_is_kept() {
        // A server of each layout that isn't ours: the new one goes directly under `mcp` all the
        // same, the layout every OpenCode reads.
        let before = "{\n    \"theme\": \"dark\",\n    \"mcp\": {\n        \"zeta\": {\n            \"type\": \"local\",\n            \"command\": [\"npx\", \"-y\", \"z\"]\n        },\n        \"servers\": {\n            \"x\": { \"type\": \"remote\", \"url\": \"https://example.com/mcp\" }\n        }\n    },\n    \"model\": \"a/b\"\n}\n";
        let after = oc(before).unwrap();
        assert_eq!(
            after,
            before.replace(
                "        }\n    },\n    \"model\"",
                &format!("        }},\n        \"draft-canvas\": {{\n            \"type\": \"local\",\n            \"command\": [\"{SIDECAR}\"],\n            \"enabled\": true\n        }}\n    }},\n    \"model\"")
            )
        );
        assert_eq!(oc_found(&after).len(), 1);
        assert!(!oc_found(&after)[0].native);
        // Doing it again changes nothing.
        assert_eq!(oc(&after).unwrap(), after);

        // Spacing is the writer's own where it had to open an object; what the file says is not.
        let compact = r#"{"mcp":{"x":{"type":"remote","url":"u"}},"agent":{"b":[1,2]}}"#;
        let after = oc(compact).unwrap();
        assert_eq!(oc_rest(&after), oc_rest(compact));
        assert!(after.contains(r#"{"b":[1,2]}"#), "{after}");
        assert_eq!(oc(&after).unwrap(), after);

        let windows = before.replace('\n', "\r\n");
        let after = oc(&windows).unwrap();
        assert_eq!(oc_rest(&after), oc_rest(&windows));
        assert_eq!(after.matches('\n').count(), after.matches("\r\n").count());
        assert_eq!(oc(&after).unwrap(), after);
    }

    #[test]
    fn an_opencode_1_entry_is_repointed_in_place_keeping_what_the_person_added() {
        let before = "{\n  \"mcp\": {\n    \"dc\": {\n      \"type\": \"local\",\n      \"command\": [\"/old/draft-canvas-mcp\", \"--full-tools\"],\n      \"environment\": { \"A\": \"1\" },\n      \"timeout\": 5000,\n      \"enabled\": false\n    }\n  }\n}\n";
        assert_eq!(oc_state(Some(before), None), SetupState::Outdated);
        let after = oc(before).unwrap();
        assert_eq!(
            after,
            before
                .replace(
                    "[\"/old/draft-canvas-mcp\", \"--full-tools\"]",
                    &format!("[\"{SIDECAR}\",\"--full-tools\"]")
                )
                .replace("\"enabled\": false", "\"enabled\": true")
        );
        let found = oc_found(&after);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "dc");
        assert_eq!(oc_state(Some(&after), None), SetupState::Ready);
        assert_eq!(oc(&after).unwrap(), after);
    }

    #[test]
    fn an_opencode_2_entry_stays_under_servers() {
        let before = "{\n  \"mcp\": {\n    \"servers\": {\n      \"draft-canvas\": {\n        \"type\": \"local\",\n        \"command\": [\"/old/draft-canvas-mcp\"],\n        \"cwd\": \".\",\n        \"codemode\": false,\n        \"timeout\": { \"execution\": 600000 },\n        \"disabled\": true,\n        \"enabled\": false\n      }\n    }\n  }\n}\n";
        assert_eq!(oc_state(Some(before), None), SetupState::Outdated);
        let after = oc(before).unwrap();
        assert_eq!(
            after,
            before
                .replace("/old/draft-canvas-mcp", SIDECAR)
                .replace("\"disabled\": true", "\"disabled\": false")
                .replace("\"enabled\": false", "\"enabled\": true")
        );
        let found = oc_found(&after);
        assert_eq!(found.len(), 1);
        assert!(found[0].native);
        assert_eq!(oc_state(Some(&after), None), SetupState::Ready);
        assert_eq!(oc(&after).unwrap(), after);
    }

    #[test]
    fn an_opencode_entry_turned_off_either_way_is_not_ready() {
        // OpenCode 1 honours `enabled` on an entry under `servers` and OpenCode 2 ignores it, so
        // neither flag alone may read as set up.
        for flags in ["\"enabled\": false", "\"disabled\": true"] {
            for (open, close) in [("", ""), ("\"servers\": {", "}")] {
                let text = format!(
                    "{{ \"mcp\": {{ {open} \"draft-canvas\": {{ \"type\": \"local\", \"command\": [\"{SIDECAR}\"], {flags} }} {close} }} }}"
                );
                assert_eq!(oc_state(Some(&text), None), SetupState::Outdated, "{text}");
                let after = oc(&text).unwrap();
                assert_eq!(oc_state(Some(&after), None), SetupState::Ready, "{after}");
            }
        }
    }

    #[test]
    fn an_opencode_config_draft_canvas_cant_change_is_refused_not_replaced() {
        let broken = oc("{\n  \"mcp\": {\n").unwrap_err();
        assert!(broken.message.contains("line 3"), "{}", broken.message);
        let late = oc("{\n  // fine\n  \"mcp\": {},\n  \"a\": nope,\n}\n").unwrap_err();
        assert!(late.message.contains("line 4"), "{}", late.message);
        // Valid for OpenCode, but nothing Draft Canvas could write back whole.
        let commented = oc(OC_COMMENTED).unwrap_err();
        assert!(
            commented.message.contains("comments"),
            "{}",
            commented.message
        );
        for odd in ["[]", r#"{ "mcp": "x" }"#, r#"{ "mcp": { "servers": [] } }"#] {
            let refused = oc(odd).unwrap_err();
            assert!(
                refused.message.contains("laid out"),
                "{odd}: {}",
                refused.message
            );
        }
        // A server of that name that isn't the connector is someone else's: never turned into ours.
        for other in [
            r#"{ "mcp": { "draft-canvas": { "type": "remote", "url": "https://example.com/mcp" } } }"#,
            r#"{ "mcp": { "draft-canvas": { "type": "local", "command": ["npx", "-y", "other"] } } }"#,
            r#"{ "mcp": { "draft-canvas": { "type": "local", "command": "draft-canvas-mcp" } } }"#,
            r#"{ "mcp": { "servers": { "draft-canvas": { "enabled": false } } } }"#,
        ] {
            assert_eq!(oc_state(Some(other), None), SetupState::Outdated, "{other}");
            let refused = oc(other).unwrap_err();
            assert!(
                refused.message.contains("different server"),
                "{other}: {}",
                refused.message
            );
        }
        // Both layouts in one file: OpenCode 1 takes the first, OpenCode 2 the second.
        let twice = format!(
            r#"{{ "mcp": {{ "draft-canvas": {{ "type": "local", "command": ["{SIDECAR}"] }}, "servers": {{ "dc": {{ "type": "local", "command": ["{SIDECAR}"] }} }} }} }}"#
        );
        let refused = oc(&twice).unwrap_err();
        assert!(refused.message.contains("twice"), "{}", refused.message);
    }

    #[test]
    fn opencode_settings_with_comments_and_trailing_commas_are_still_read() {
        let text = format!(
            "// mine\n{{\n  \"theme\": \"a // b,}}\", /* note */\n  \"mcp\": {{\n    \"draft-canvas\": {{\n      \"type\": \"local\",\n      \"command\": [\"{SIDECAR}\",],\n    }},\n  }},\n}}\n"
        );
        let relaxed = relaxed_json(&text);
        assert_eq!(relaxed.lines().count(), text.lines().count());
        let config: Value = serde_json::from_str(&relaxed).unwrap();
        assert_eq!(config["theme"], "a // b,}");
        assert_eq!(oc_state(None, Some(&text)), SetupState::Ready);
        assert_eq!(
            relaxed_json(r#"{"a": ",}", "b": [1, 2,], }"#),
            r#"{"a": ",}", "b": [1, 2 ]  }"#
        );
        assert_eq!(relaxed_json(r#"{"a": "\",}"}"#), r#"{"a": "\",}"}"#);
        // A mistake stays one: a comma with nothing before it is not a trailing comma.
        assert!(opencode_parsed("{ \"a\": 1,, }", OC_FILE).is_err());
        assert_eq!(oc_state(Some("{ \"mcp\": "), None), SetupState::NotSetUp);
    }

    #[test]
    fn opencode_gets_the_connector_in_the_one_file_that_can_take_it() {
        let ours = format!(
            "{{\n  // ours\n  \"mcp\": {{ \"draft-canvas\": {{ \"type\": \"local\", \"command\": [\"{SIDECAR}\"] }} }}\n}}\n"
        );
        let plain = ours.replace("  // ours\n", "");
        let target = |json, jsonc| opencode_target(json, jsonc).map_err(|e| e.message);
        assert_eq!(target(None, None), Ok("opencode.json"));
        assert_eq!(target(Some("{}"), None), Ok("opencode.json"));
        assert_eq!(target(Some("{}"), Some("{}")), Ok("opencode.json"));
        assert_eq!(target(None, Some("{}")), Ok("opencode.json"));
        // A commented file is left alone when the other can be written.
        assert_eq!(target(None, Some(OC_COMMENTED)), Ok("opencode.json"));
        assert_eq!(target(Some(OC_COMMENTED), Some("{}")), Ok("opencode.jsonc"));
        for jsonc in [None, Some(OC_COMMENTED)] {
            let refused = target(Some(OC_COMMENTED), jsonc).unwrap_err();
            assert!(refused.contains("opencode.json has comments"), "{refused}");
        }
        // An entry is updated where it is, never joined by a second one in the other file.
        assert_eq!(target(None, Some(&plain)), Ok("opencode.jsonc"));
        assert_eq!(target(Some("{}"), Some(&plain)), Ok("opencode.jsonc"));
        assert_eq!(target(Some(&plain), Some("{}")), Ok("opencode.json"));
        let refused = target(Some("{}"), Some(&ours)).unwrap_err();
        assert!(refused.contains("opencode.jsonc has comments"), "{refused}");
        let refused = target(Some(&plain), Some(&ours)).unwrap_err();
        assert!(
            refused.contains("both opencode.json and opencode.jsonc"),
            "{refused}"
        );
        let refused = target(Some("{}"), Some("{\n\"a\": \n}")).unwrap_err();
        assert!(
            refused.contains("opencode.jsonc has a mistake on line 3"),
            "{refused}"
        );
    }

    #[test]
    fn two_opencode_files_that_disagree_are_not_ready() {
        let entry = |command: &str| {
            format!(
                r#"{{ "mcp": {{ "draft-canvas": {{ "type": "local", "command": ["{command}"] }} }} }}"#
            )
        };
        // OpenCode lets the .jsonc entry win over, or merge into, the .json one.
        let (current, stale) = (entry(SIDECAR), entry("/old/draft-canvas-mcp"));
        assert_eq!(oc_state(Some(&current), Some(&stale)), SetupState::Outdated);
        assert_eq!(oc_state(Some(&current), Some(&current)), SetupState::Ready);
        let dir = oc_dir(Some(&current), Some(&stale));
        assert!(opencode_connect_in(dir.path(), Path::new(SIDECAR)).is_err());
        for (file, text) in OPENCODE_FILES.into_iter().zip([&current, &stale]) {
            assert_eq!(
                &std::fs::read_to_string(dir.path().join(file)).unwrap(),
                text
            );
        }
    }

    #[test]
    fn windows_paths_are_escaped_for_opencode() {
        let sidecar = r"C:\Program Files\Draft Canvas\draft-canvas-mcp.exe";
        let text = opencode_with_connector("", Path::new(sidecar), OC_FILE).unwrap();
        assert!(text.contains(r#"["C:\\Program Files\\Draft Canvas\\draft-canvas-mcp.exe"]"#));
        assert_eq!(oc_found(&text)[0].command, [sidecar]);
    }

    #[test]
    fn an_opencode_config_written_in_a_new_home_reads_back_ready() {
        // No OpenCode yet, so no folder: the file is there for when it's installed.
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".config/opencode");
        let sidecar = Path::new(SIDECAR);
        assert_eq!(
            opencode_setup(Some(&dir), sidecar).state,
            SetupState::NotSetUp
        );
        opencode_connect_in(&dir, sidecar).unwrap();
        let setup = opencode_setup(Some(&dir), sidecar);
        assert_eq!(setup.state, SetupState::Ready);
        assert!(setup.location.unwrap().ends_with("opencode.json"));
        let first = std::fs::read_to_string(dir.join("opencode.json")).unwrap();
        opencode_connect_in(&dir, sidecar).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("opencode.json")).unwrap(),
            first
        );
        assert!(!dir.join("opencode.jsonc").exists());
    }

    #[test]
    fn a_commented_opencode_file_is_left_alone_and_its_neighbour_written() {
        let dir = oc_dir(None, Some(OC_COMMENTED));
        let sidecar = Path::new(SIDECAR);
        opencode_connect_in(dir.path(), sidecar).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("opencode.jsonc")).unwrap(),
            OC_COMMENTED
        );
        let setup = opencode_setup(Some(dir.path()), sidecar);
        assert_eq!(setup.state, SetupState::Ready);
        assert!(setup.location.unwrap().ends_with("opencode.json"));
        // With nowhere safe to write, nothing is written at all.
        let dir = oc_dir(Some(OC_COMMENTED), Some(OC_COMMENTED));
        assert!(opencode_connect_in(dir.path(), sidecar).is_err());
        for file in OPENCODE_FILES {
            assert_eq!(
                std::fs::read_to_string(dir.path().join(file)).unwrap(),
                OC_COMMENTED
            );
        }
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
