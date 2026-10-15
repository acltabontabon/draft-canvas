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
//!
//! Cursor needs neither: its `cursor://` link has Cursor write its own configuration.

use crate::docio::{self, WriteOutcome};
use crate::errors::{AppError, ErrorKind};
use serde::{Deserialize, Serialize};
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
    /// Whether the button can do the setup itself. False for Claude Code when its CLI can't be found;
    /// Settings then offers the command to run instead.
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

fn codex_config() -> Option<PathBuf> {
    env_dir("CODEX_HOME")
        .or_else(|| home().map(|h| h.join(".codex")))
        .map(|dir| dir.join("config.toml"))
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
    entry.insert(
        "command",
        toml_edit::value(sidecar.to_string_lossy().as_ref()),
    );
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
    // Read, change, and swap in only if nobody wrote the file meanwhile: Codex itself saves to it
    // (trusting a project, say), and that save must not be lost to this one.
    for _ in 0..3 {
        let outcome = match docio::read_document(&path) {
            Ok(read) => {
                let text = codex_with_connector(&read.text, sidecar)?;
                docio::write_atomic(&path, text.as_bytes(), Some(&read.stamp))?
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
                let text = codex_with_connector("", sidecar)?;
                match docio::create_new_atomic(&path, text.as_bytes()) {
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
    Err(unavailable("Codex kept changing its settings while Draft Canvas was saving them. Try again in a moment."))
}

// --- Claude Code -------------------------------------------------------------------------------

/// `~/.claude.json`, where `claude mcp add --scope user` keeps the servers every project sees.
fn claude_config() -> Option<PathBuf> {
    env_dir("CLAUDE_CONFIG_DIR")
        .or_else(home)
        .map(|dir| dir.join(".claude.json"))
}

fn claude_entry(config: &Value) -> Option<Entry> {
    let servers = config.get("mcpServers")?.as_object()?;
    pick(servers.iter().map(|(name, server)| {
        let command = server
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string);
        (name.as_str(), command, true)
    }))
}

fn read_claude_entry() -> Option<Entry> {
    let text = std::fs::read_to_string(claude_config()?).ok()?;
    claude_entry(&serde_json::from_str(&text).ok()?)
}

/// Where the `claude` command is. An app started from the Dock or Start menu doesn't have the PATH a
/// terminal has, so the installers' usual places are tried first, then this process's PATH, then (on
/// macOS and Linux) the PATH the person's login shell would give a terminal.
fn find_claude() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home() {
        candidates.push(home.join(".local/bin").join(exe));
        candidates.push(home.join(".claude/local").join(exe));
    }
    if cfg!(not(windows)) {
        candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
        candidates.push(PathBuf::from("/usr/local/bin/claude"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(exe)));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .or_else(login_shell_claude)
}

#[cfg(not(windows))]
fn login_shell_claude() -> Option<PathBuf> {
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty())?;
    let mut command = Command::new(shell);
    command.args(["-l", "-i", "-c", "command -v claude"]);
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
fn login_shell_claude() -> Option<PathBuf> {
    None
}

struct Output {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Runs `command` without a console window, giving up (and stopping it) after `limit`.
fn run(mut command: Command, limit: Duration) -> std::io::Result<Output> {
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
    // Drained on their own threads so a chatty command can't block on a full pipe while it's waited for.
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            bytes
        })
    };
    let stdout = drain(Box::new(child.stdout.take().expect("piped")));
    let stderr = drain(Box::new(child.stderr.take().expect("piped")));
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    Ok(Output {
        success: status.success(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
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
    let claude_cmd = || {
        let mut command = Command::new(&claude);
        // Claude Code's own config folder, not wherever this app happens to be started from.
        if let Some(home) = home() {
            command.current_dir(home);
        }
        command
    };
    // `mcp add` refuses a name that's taken, so an entry pointing elsewhere is removed first.
    if let Some(entry) = read_claude_entry() {
        let mut remove = claude_cmd();
        remove.args(["mcp", "remove", "--scope", "user", &entry.name]);
        let _ = run(remove, Duration::from_secs(20));
    }
    let mut add = claude_cmd();
    add.args(["mcp", "add", "--scope", "user", SERVER_NAME, "--"])
        .arg(sidecar);
    let output = run(add, Duration::from_secs(20)).map_err(|_| {
        unavailable("Claude Code didn’t answer. Run the command below in a terminal instead.")
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
        "Claude Code couldn’t add Draft Canvas: {said}"
    )))
}

// --- Settings ----------------------------------------------------------------------------------

pub fn status(sidecar: &Path) -> Vec<ClientSetup> {
    vec![codex_status(sidecar), claude_status(sidecar)]
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
        let entry = claude_entry(&config).unwrap();
        assert_eq!(entry.name, "dc");
        assert_eq!(
            state_of(Some(&entry), Path::new(SIDECAR)),
            SetupState::Outdated
        );

        let config: Value =
            serde_json::json!({ "mcpServers": { "draft-canvas": { "command": SIDECAR } } });
        assert_eq!(
            state_of(claude_entry(&config).as_ref(), Path::new(SIDECAR)),
            SetupState::Ready
        );
        assert_eq!(claude_entry(&serde_json::json!({ "projects": {} })), None);
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
