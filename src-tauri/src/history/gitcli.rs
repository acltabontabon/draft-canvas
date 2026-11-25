//! The person's own installed `git`, run only for what gix here cannot do: fetching and pushing a
//! history to a remote the person configured, and reading or updating their own project repository
//! when they explicitly publish a diagram into it.
//!
//! Everything a repository on disk says is untrusted, and so is the environment the app was started
//! in. So every run is built from scratch:
//!
//! - one absolute `git` executable, found once on `PATH` by Rust (never the current directory or a
//!   repository's), at least `MIN_VERSION`;
//! - an environment cleared and refilled from an allowlist, with a `PATH` of git's own folder and
//!   the system folders only, system configuration and attributes off, prompts off, no lazy fetches,
//!   and only `https` and `ssh` transports (`file` too, in tests only);
//! - explicit `--git-dir` (and `--work-tree`), a working directory that is an empty folder of the
//!   app's, and `-c` overrides for everything that can run a program: hooks point at an empty folder,
//!   no fsmonitor, no askpass, ssh in batch mode, and the credential helpers reset and then re-added
//!   from the person's own global (and system) configuration, only when they are a known helper or
//!   an absolute path that exists;
//! - a bounded run: no shell, arguments as a list, a timeout, capped output, and the whole process
//!   tree killed when it runs out of time (a kill-on-close job object on Windows, a process group on
//!   Unix).
//!
//! A project repository's own configuration is scanned first (`scan_config`) and refused outright if
//! it names anything that runs a program, rewrites URLs or pulls in other configuration.
//!
//! Failures are classified (`Failure`) from the exit and Git's (untranslated, `LC_ALL=C`) wording,
//! and only a cleaned line or two of Git's own output ever reaches the page, with any credentials in
//! a URL removed.

use super::{Code, HistoryError, Result};
use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

/// `git` older than this is reported unavailable: 2.38 is the first with every safeguard used here
/// (`safe.bareRepository`, `protocol.*.allow` and `GIT_PROTOCOL_FROM_USER` handling as relied on).
pub const MIN_VERSION: (u32, u32) = (2, 38);
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Each of stdout and stderr. A command whose output is parsed and could legitimately be larger
/// (`ls-tree` of a big folder) asks for more.
pub const OUTPUT_CAP: usize = 1024 * 1024;
/// After the tree is killed, how long its pipes may take to close.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// Copied from the app's environment when set; nothing else is.
const ENV_ALLOW: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ProgramData",
    "TEMP",
    "TMP",
    "SSH_AUTH_SOCK",
    "LANG",
    // Where a person's global Git configuration may live, and what a keyring helper needs to reach it.
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
];

/// Credential helpers Git ships or documents by name.
const KNOWN_HELPERS: &[&str] = &[
    "manager",
    "manager-core",
    "osxkeychain",
    "store",
    "cache",
    "libsecret",
    "wincred",
];

/// Builds an argument list from strings, paths and `OsString`s alike.
macro_rules! args {
    ($($x:expr),* $(,)?) => {
        [$(::std::ffi::OsString::from(AsRef::<::std::ffi::OsStr>::as_ref(&$x))),*]
    };
}
pub(super) use args;

/// What went wrong, as the page switches on it (`reason` in the error it receives).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    Auth,
    HostKey,
    Offline,
    RejectedNonFastForward,
    ProtectedBranch,
    MissingRemoteBranch,
    Shallow,
    RateLimited,
    Timeout,
    Interrupted,
    GitMissing,
    /// Not one of the network failures: Git couldn't record a commit for want of a name and email.
    Identity,
    /// Another Git process holds a lock (`index.lock`, a ref's `.lock`).
    Locked,
    Other,
}

impl Failure {
    pub fn reason(self) -> &'static str {
        match self {
            Failure::Auth => "auth",
            Failure::HostKey => "host-key",
            Failure::Offline => "offline",
            Failure::RejectedNonFastForward => "rejected-non-fast-forward",
            Failure::ProtectedBranch => "protected-branch",
            Failure::MissingRemoteBranch => "missing-remote-branch",
            Failure::Shallow => "shallow",
            Failure::RateLimited => "rate-limited",
            Failure::Timeout => "timeout",
            Failure::Interrupted => "interrupted",
            Failure::GitMissing => "git-missing",
            Failure::Identity => "identity",
            Failure::Locked => "locked",
            Failure::Other => "other",
        }
    }

    fn code(self) -> Code {
        match self {
            Failure::RejectedNonFastForward | Failure::ProtectedBranch | Failure::Locked => {
                Code::Conflict
            }
            Failure::MissingRemoteBranch => Code::NotFound,
            Failure::Shallow => Code::UnsupportedFormat,
            Failure::Identity => Code::Invalid,
            _ => Code::Unavailable,
        }
    }

    fn sentence(self) -> &'static str {
        match self {
            Failure::Auth => "The remote didn't accept your credentials. Sign in with your Git credential helper or SSH key, then try again.",
            Failure::HostKey => "The remote's SSH host key isn't one your computer knows, or it has changed. Connect once with ssh to check and accept it, then try again.",
            Failure::Offline => "Draft Canvas couldn't reach the remote. Check your connection and the address.",
            Failure::RejectedNonFastForward => "The remote has changes this copy doesn't have, so nothing was overwritten. Fetch first.",
            Failure::ProtectedBranch => "The remote refused the update: that branch is protected.",
            Failure::MissingRemoteBranch => "The remote doesn't have that branch.",
            Failure::Shallow => "That repository is shallow, which Draft Canvas doesn't publish to or from.",
            Failure::RateLimited => "The remote is limiting requests right now. Try again later.",
            Failure::Timeout => "Git took too long and was stopped.",
            Failure::Interrupted => "Git was stopped before it finished.",
            Failure::GitMissing => "Git isn't installed, or Draft Canvas couldn't find it.",
            Failure::Identity => "Git doesn't know your name and email yet. Set user.name and user.email in Git, then try again.",
            Failure::Locked => "Another Git program is working in that repository. Try again when it has finished.",
            Failure::Other => "Git couldn't finish that.",
        }
    }

    pub fn error(self, detail: Option<&str>) -> HistoryError {
        let message = match detail {
            Some(detail) if !detail.is_empty() && self == Failure::Other => {
                format!("{} Git said: {detail}", self.sentence())
            }
            _ => self.sentence().to_string(),
        };
        HistoryError::new(self.code(), message).with_reason(self.reason())
    }
}

/// From Git's exit and its (untranslated) stderr. Checked most specific first: an SSH auth failure
/// also says "Could not read from remote repository".
pub fn classify(stderr: &str) -> Failure {
    let text = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    if has(&[
        "host key verification failed",
        "remote host identification has changed",
        "host key for",
        "no ed25519 host key is known",
        "no rsa host key is known",
        "no ecdsa host key is known",
    ]) {
        return Failure::HostKey;
    }
    if has(&["shallow update not allowed", "shallow file has changed"]) {
        return Failure::Shallow;
    }
    if has(&[
        "protected branch",
        "gh006",
        "protected_branch",
        "not allowed to push code to protected",
        "not allowed to force push code to a protected",
    ]) {
        return Failure::ProtectedBranch;
    }
    if has(&[
        "too many requests",
        "rate limit",
        "error: 429",
        "returned error: 429",
    ]) {
        return Failure::RateLimited;
    }
    if has(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied (publickey",
        "permission denied (keyboard-interactive",
        "permission denied (password",
        "invalid username or password",
        "http basic: access denied",
        "returned error: 401",
        "returned error: 403",
        "the requested url returned error: 403",
        "access denied",
    ]) {
        return Failure::Auth;
    }
    if has(&["couldn't find remote ref", "could not find remote ref"]) {
        return Failure::MissingRemoteBranch;
    }
    if has(&[
        "non-fast-forward",
        "[rejected]",
        "fetch first",
        "updates were rejected",
        "already exists",
        "stale info",
    ]) {
        return Failure::RejectedNonFastForward;
    }
    if has(&[
        "please tell me who you are",
        "unable to auto-detect email address",
        "empty ident name",
        "author identity unknown",
        "committer identity unknown",
    ]) {
        return Failure::Identity;
    }
    if has(&[
        "index.lock",
        ".lock': file exists",
        "cannot lock ref",
        "unable to create '",
    ]) {
        return Failure::Locked;
    }
    if has(&[
        "could not resolve host",
        "could not resolve hostname",
        "failed to connect",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "no route to host",
        "unable to access",
        "connection reset",
        "could not read from remote repository",
        "the remote end hung up unexpectedly",
        "name or service not known",
        "temporary failure in name resolution",
    ]) {
        return Failure::Offline;
    }
    Failure::Other
}

/// The last few lines of Git's stderr, safe to show: no control characters, no credentials in a
/// URL (`https://user:token@host` becomes `https://host`), bounded.
pub fn sanitize_detail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("hint:"))
        .collect();
    let tail = &lines[lines.len().saturating_sub(2)..];
    let mut out = strip_userinfo(&tail.join(" "));
    out.retain(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'));
    if out.chars().count() > 300 {
        out = out.chars().take(300).collect::<String>() + "…";
    }
    out
}

/// Removes `user[:password]@` after every `scheme://`.
pub fn strip_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(i) => out.push_str(&authority[i + 1..]),
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------------------------
// Remote URLs

/// Checks a remote URL and returns it normalised (scheme and host in lower case). Accepted:
/// `https://host[:port]/path`, `ssh://[user@]host[:port]/path` and scp-like `user@host:path`.
/// Refused: anything else, userinfo in an https URL, control characters, spaces, non-ASCII, a
/// leading `-` anywhere Git or ssh might read as an option. `allow_file` (tests only) admits
/// `file:///absolute/path`.
pub fn validate_remote_url(
    url: &str,
    allow_file: bool,
) -> std::result::Result<String, &'static str> {
    if url.is_empty() || url.len() > 2048 {
        return Err("That remote address is empty or too long.");
    }
    if !url.is_ascii() {
        return Err("A remote address may only use plain ASCII characters.");
    }
    if url
        .bytes()
        .any(|b| b.is_ascii_control() || b == b' ' || b == b'\\')
    {
        return Err("A remote address can't contain spaces, backslashes or control characters.");
    }
    if url.starts_with('-') {
        return Err("A remote address can't start with '-'.");
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").map(|_| &url[8..]) {
        let (authority, path) = split_authority(rest)?;
        if authority.contains('@') {
            return Err("Put credentials in your Git credential helper, not in the address.");
        }
        let host = check_host_port(authority)?;
        check_path(path, true)?;
        return Ok(format!("https://{host}{path}"));
    }
    if let Some(rest) = lower.strip_prefix("ssh://").map(|_| &url[6..]) {
        let (authority, path) = split_authority(rest)?;
        let (user, hostport) = match authority.rsplit_once('@') {
            Some((user, hostport)) => (Some(user), hostport),
            None => (None, authority),
        };
        if let Some(user) = user {
            check_user(user)?;
        }
        let host = check_host_port(hostport)?;
        check_path(path, true)?;
        let user = user.map(|u| format!("{u}@")).unwrap_or_default();
        return Ok(format!("ssh://{user}{host}{path}"));
    }
    if allow_file {
        if let Some(path) = lower.strip_prefix("file://").map(|_| &url[7..]) {
            if path.starts_with('/') && !path.contains("..") {
                return Ok(format!("file://{path}"));
            }
            return Err("Not a file address.");
        }
    }
    // `<transport>::<address>` (ext::, fd::, a remote helper): the `::` comes before any `@`.
    let helper_syntax = match (lower.find("::"), lower.find('@')) {
        (Some(colons), Some(at)) => colons < at,
        (Some(_), None) => true,
        _ => false,
    };
    if lower.contains("://") || helper_syntax {
        return Err("Draft Canvas publishes only over https:// or ssh.");
    }
    // scp-like: user@host:path, with no slash before the colon.
    let Some((user, rest)) = url.split_once('@') else {
        return Err("Draft Canvas publishes only over https:// or ssh.");
    };
    check_user(user)?;
    let (host, path) = if let Some(after) = rest.strip_prefix('[') {
        let close = after.find(']').ok_or("That address's host isn't valid.")?;
        let inner = &after[..close];
        inner
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| "That address's host isn't valid.")?;
        let path = after[close + 1..]
            .strip_prefix(':')
            .ok_or("That address has no repository path.")?;
        (format!("[{}]", inner.to_ascii_lowercase()), path)
    } else {
        let (host, path) = rest
            .split_once(':')
            .ok_or("That address has no repository path.")?;
        if host.contains('/') {
            return Err("Draft Canvas publishes only over https:// or ssh.");
        }
        check_hostname(host)?;
        (host.to_ascii_lowercase(), path)
    };
    if path.starts_with('-') {
        return Err("A repository path can't start with '-'.");
    }
    check_path(path, false)?;
    Ok(format!("{user}@{host}:{path}"))
}

fn split_authority(rest: &str) -> std::result::Result<(&str, &str), &'static str> {
    let slash = rest
        .find('/')
        .ok_or("That address has no repository path.")?;
    Ok((&rest[..slash], &rest[slash..]))
}

fn check_user(user: &str) -> std::result::Result<(), &'static str> {
    let ok = !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err("That address's user name isn't valid.")
    }
}

/// `host`, `host:port` or `[v6]`/`[v6]:port`; returns it with the host lower-cased.
fn check_host_port(authority: &str) -> std::result::Result<String, &'static str> {
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        let close = after.find(']').ok_or("That address's host isn't valid.")?;
        let inner = &after[..close];
        inner
            .parse::<std::net::Ipv6Addr>()
            .map_err(|_| "That address's host isn't valid.")?;
        let rest = &after[close + 1..];
        let port = match rest {
            "" => None,
            _ => Some(
                rest.strip_prefix(':')
                    .ok_or("That address's host isn't valid.")?,
            ),
        };
        (format!("[{}]", inner.to_ascii_lowercase()), port)
    } else {
        let (host, port) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        check_hostname(host)?;
        (host.to_ascii_lowercase(), port)
    };
    match port {
        None => Ok(host),
        Some(port) => {
            let valid = !port.is_empty()
                && port.len() <= 5
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u32>().is_ok_and(|p| (1..=65535).contains(&p));
            if valid {
                Ok(format!("{host}:{port}"))
            } else {
                Err("That address's port isn't valid.")
            }
        }
    }
}

fn check_hostname(host: &str) -> std::result::Result<(), &'static str> {
    let bad = "That address's host isn't valid.";
    if host.is_empty() || host.len() > 253 || host.starts_with('-') || host.starts_with('.') {
        return Err(bad);
    }
    let host = host.strip_suffix('.').unwrap_or(host);
    for label in host.split('.') {
        let ok = !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !ok {
            return Err(bad);
        }
    }
    Ok(())
}

/// A repository path: a conservative character set, `%XX` escapes only, no `.`/`..` segments, no
/// query or fragment.
fn check_path(path: &str, absolute: bool) -> std::result::Result<(), &'static str> {
    let bad = "That address's repository path isn't valid.";
    if path.is_empty() || (absolute && (!path.starts_with('/') || path == "/")) {
        return Err(bad);
    }
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let hex = bytes.get(i + 1..i + 3).ok_or(bad)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return Err(bad);
            }
            i += 3;
            continue;
        }
        if !(b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-' | b'~' | b'+')) {
            return Err(bad);
        }
        i += 1;
    }
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(bad);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Configuration a project repository may not have

/// Why a repository-local configuration key is refused, or `None` when it is harmless. Keys arrive
/// as Git lists them: section and key lower-cased, a subsection as written.
pub fn refused_key(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    let (section, rest) = lower.split_once('.')?;
    let last = lower.rsplit('.').next().unwrap_or("");
    let has_sub = rest.contains('.');
    if matches!(
        lower.as_str(),
        "core.sshcommand"
            | "core.askpass"
            | "core.gitproxy"
            | "core.alternaterefscommand"
            | "core.worktree"
            | "diff.external"
            | "uploadpack.packobjectshook"
            | "gpg.program"
    ) {
        return Some("it names a program for Git to run or moves the working tree");
    }
    match section {
        "credential" => return Some("it configures credentials"),
        "filter" => return Some("it defines a content filter"),
        "include" | "includeif" => return Some("it includes other configuration"),
        "url" if has_sub && matches!(last, "insteadof" | "pushinsteadof") => {
            return Some("it rewrites remote addresses")
        }
        "diff" if has_sub && matches!(last, "textconv" | "command") => {
            return Some("it names a diff program")
        }
        "merge" if has_sub && last == "driver" => return Some("it names a merge driver"),
        "gpg" if has_sub && last == "program" => return Some("it names a signing program"),
        "remote" if has_sub && matches!(last, "uploadpack" | "receivepack" | "vcs" | "mirror") => {
            return Some("it changes how Git talks to a remote")
        }
        _ => {}
    }
    if last == "helper" {
        return Some("it names a helper program");
    }
    None
}

/// Keys whose value Draft Canvas overrides on every run anyway: reported, not refused.
pub fn overridden_key(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "core.hookspath" | "core.fsmonitor"
    )
}

// ---------------------------------------------------------------------------------------------
// The executable

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable {
    pub reason: String,
    pub version: Option<String>,
}

/// Where a run points Git.
pub enum Place<'a> {
    /// One of the app's own bare history repositories.
    Managed(&'a Path),
    /// A person's repository: its git dir (per worktree) and its working tree root.
    Project {
        git_dir: &'a Path,
        work_tree: &'a Path,
    },
}

impl Place<'_> {
    fn ceiling(&self) -> Option<&Path> {
        match self {
            Place::Managed(dir) => dir.parent(),
            Place::Project { work_tree, .. } => work_tree.parent(),
        }
    }
}

pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.status.success()
    }

    pub fn code(&self) -> Option<i32> {
        self.status.code()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }
}

/// One resolved `git`, shared by every run.
#[derive(Debug)]
pub struct Git {
    exe: PathBuf,
    version: String,
    path_env: OsString,
    /// Validated `credential.helper` values from the person's global and system configuration.
    helpers: Vec<String>,
    /// Harmless transport settings from the system configuration that a fresh `git` would have read
    /// (`http.sslBackend`, `http.sslCAInfo` on Windows), since system configuration is off.
    system: Vec<String>,
    hooks: PathBuf,
    cwd: PathBuf,
    #[cfg(test)]
    pub(super) allow_file: bool,
}

impl Git {
    /// Finds and checks `git`. `state` is a folder of the app's own where an empty hooks folder and
    /// an empty working directory are kept.
    pub fn discover(state: &Path) -> std::result::Result<Git, Unavailable> {
        let missing = |reason: &str| Unavailable {
            reason: reason.to_string(),
            version: None,
        };
        let exe =
            find_git().ok_or_else(|| missing("Git isn't installed, or isn't on your PATH."))?;
        Self::with_exe(exe, state)
    }

    pub fn with_exe(exe: PathBuf, state: &Path) -> std::result::Result<Git, Unavailable> {
        let missing = |reason: &str| Unavailable {
            reason: reason.to_string(),
            version: None,
        };
        if !exe.is_absolute() {
            return Err(missing("Git must be found by its full path."));
        }
        let hooks = state.join("no-hooks");
        let cwd = state.join("empty");
        for dir in [&hooks, &cwd] {
            empty_dir(dir)
                .map_err(|_| missing("Draft Canvas couldn't prepare a folder to run Git in."))?;
        }
        let mut git = Git {
            path_env: limited_path(&exe),
            exe,
            version: String::new(),
            helpers: Vec::new(),
            system: Vec::new(),
            hooks,
            cwd,
            #[cfg(test)]
            allow_file: false,
        };
        let out = git
            .bare_run(&args!["--version"], false)
            .map_err(|_| missing("Git is installed but couldn't be run."))?;
        let text = out.text();
        let version = text
            .strip_prefix("git version ")
            .unwrap_or(&text)
            .to_string();
        let Some((major, minor)) = parse_version(&version) else {
            return Err(Unavailable {
                reason: "Draft Canvas couldn't tell which version of Git is installed.".into(),
                version: Some(version),
            });
        };
        if (major, minor) < MIN_VERSION {
            return Err(Unavailable {
                reason: format!(
                    "Git {version} is older than Draft Canvas supports ({}.{} or newer).",
                    MIN_VERSION.0, MIN_VERSION.1
                ),
                version: Some(version),
            });
        }
        git.version = version;
        git.helpers = git.read_helpers();
        git.system = git.read_system_transport();
        Ok(git)
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    #[cfg(test)]
    pub(super) fn helpers(&self) -> &[String] {
        &self.helpers
    }

    fn allows_file(&self) -> bool {
        #[cfg(test)]
        {
            self.allow_file
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    pub fn validate_url(&self, url: &str) -> std::result::Result<String, &'static str> {
        validate_remote_url(url, self.allows_file())
    }

    /// `git <args>` with the allowlisted environment and no repository at all (version, global
    /// configuration reads). `system` leaves system configuration readable for that one read.
    fn bare_run(&self, args: &[OsString], system: bool) -> Result<Output> {
        let mut command = Command::new(&self.exe);
        self.base_env(&mut command);
        if system {
            command.env_remove("GIT_CONFIG_NOSYSTEM");
        }
        // No repository is found from the (empty) working directory, nor above it.
        if let Some(parent) = self.cwd.parent() {
            command.env("GIT_CEILING_DIRECTORIES", parent);
        }
        command.current_dir(&self.cwd).args(args);
        run_bounded(command, None, Duration::from_secs(15), OUTPUT_CAP, None)
    }

    /// The key names a configuration file sets, read by Git's own parser as a plain file (no
    /// repository, no includes followed). An unreadable file is an error.
    pub fn config_names(&self, file: &Path) -> Result<Vec<String>> {
        let out = self.bare_run(
            &args![
                "config",
                "--file",
                file,
                "--no-includes",
                "--list",
                "--name-only",
                "-z"
            ],
            false,
        )?;
        if !out.ok() {
            return Err(HistoryError::corrupt(
                "A Git configuration file could not be read.",
            ));
        }
        Ok(out
            .stdout
            .split(|b| *b == 0)
            .map(|name| String::from_utf8_lossy(name).trim().to_string())
            .filter(|name| !name.is_empty())
            .collect())
    }

    fn base_env(&self, command: &mut Command) {
        command.env_clear();
        for key in ENV_ALLOW {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let protocols = if self.allows_file() {
            "https:ssh:file"
        } else {
            "https:ssh"
        };
        command
            .env("PATH", &self.path_env)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_PROTOCOL_FROM_USER", "0")
            .env("GIT_ALLOW_PROTOCOL", protocols)
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_ADVICE", "0")
            // Git's own words, untranslated: failures are classified by them.
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C");
    }

    /// The person's own credential helpers, read once with only their global configuration (and,
    /// separately, the system one, where Git for Windows keeps its credential manager). Anything that
    /// is not a known helper or an absolute path that exists is ignored.
    fn read_helpers(&self) -> Vec<String> {
        let mut out = Vec::new();
        for (scope, system) in [("--system", true), ("--global", false)] {
            let Ok(found) = self.bare_run(
                &args!["config", scope, "--get-all", "credential.helper"],
                system,
            ) else {
                continue;
            };
            if !found.ok() {
                continue;
            }
            for value in String::from_utf8_lossy(&found.stdout).lines() {
                let value = value.trim();
                if value.is_empty() {
                    // Git's own meaning: an empty value resets the list so far.
                    out.clear();
                } else if acceptable_helper(value) && !out.iter().any(|h| h == value) {
                    out.push(value.to_string());
                }
            }
        }
        out
    }

    fn read_system_transport(&self) -> Vec<String> {
        let mut out = Vec::new();
        let get = |key: &str| -> Option<String> {
            let found = self
                .bare_run(&args!["config", "--system", "--get", key], true)
                .ok()?;
            found.ok().then(|| found.text())
        };
        if let Some(backend) = get("http.sslBackend") {
            if matches!(
                backend.as_str(),
                "schannel" | "openssl" | "gnutls" | "secure-transport"
            ) {
                out.push(format!("http.sslBackend={backend}"));
            }
        }
        if let Some(cainfo) = get("http.sslCAInfo") {
            if Path::new(&cainfo).is_absolute()
                && Path::new(&cainfo).is_file()
                && !cainfo.chars().any(char::is_control)
            {
                out.push(format!("http.sslCAInfo={cainfo}"));
            }
        }
        out
    }

    /// A `git` command for `place`, everything fixed except the subcommand's own arguments.
    fn command(&self, place: &Place<'_>) -> Command {
        let mut command = Command::new(&self.exe);
        self.base_env(&mut command);
        if let Some(ceiling) = place.ceiling() {
            command.env("GIT_CEILING_DIRECTORIES", ceiling);
        }
        command.current_dir(&self.cwd);
        command.arg("--no-pager");
        match place {
            Place::Managed(dir) => {
                command.arg(concat_os("--git-dir=", dir.as_os_str()));
            }
            Place::Project { git_dir, work_tree } => {
                command.arg(concat_os("--git-dir=", git_dir.as_os_str()));
                command.arg(concat_os("--work-tree=", work_tree.as_os_str()));
            }
        }
        let mut config: Vec<OsString> = vec![concat_os("core.hooksPath=", self.hooks.as_os_str())];
        let fixed = [
            "core.fsmonitor=false",
            "core.sshCommand=ssh -o BatchMode=yes",
            "core.askPass=",
            "credential.helper=",
        ];
        config.extend(fixed.iter().map(OsString::from));
        config.extend(
            self.helpers
                .iter()
                .map(|h| OsString::from(format!("credential.helper={h}"))),
        );
        let mut rest = vec![
            "protocol.allow=never",
            "protocol.https.allow=always",
            "protocol.ssh.allow=always",
            "submodule.recurse=false",
            "fetch.recurseSubmodules=false",
            "diff.external=",
            "gc.auto=0",
            "maintenance.auto=false",
            "transfer.fsckObjects=true",
            "fetch.fsckObjects=true",
            "receive.fsckObjects=true",
            "core.autocrlf=false",
            "push.followTags=false",
            "push.gpgSign=false",
            "push.recurseSubmodules=no",
            "fetch.writeCommitGraph=false",
            "log.showSignature=false",
        ];
        if self.allows_file() {
            rest.push("protocol.file.allow=always");
        }
        if matches!(place, Place::Managed(_)) {
            rest.push("commit.gpgsign=false");
        }
        config.extend(rest.iter().map(OsString::from));
        config.extend(self.system.iter().map(OsString::from));
        for entry in config {
            command.arg("-c").arg(entry);
        }
        command
    }

    /// Runs `git <args>` against `place` and returns its output whatever its exit.
    pub fn run(
        &self,
        place: &Place<'_>,
        args: &[OsString],
        input: Option<&[u8]>,
        timeout: Duration,
        cap: usize,
    ) -> Result<Output> {
        let mut command = self.command(place);
        command.args(args);
        run_bounded(command, input.map(<[u8]>::to_vec), timeout, cap, None)
    }

    /// A local command that must succeed: its stdout, or a classified failure.
    pub fn local(
        &self,
        place: &Place<'_>,
        args: &[OsString],
        input: Option<&[u8]>,
    ) -> Result<Vec<u8>> {
        self.local_capped(place, args, input, OUTPUT_CAP)
    }

    pub fn local_capped(
        &self,
        place: &Place<'_>,
        args: &[OsString],
        input: Option<&[u8]>,
        cap: usize,
    ) -> Result<Vec<u8>> {
        let out = self.run(place, args, input, LOCAL_TIMEOUT, cap)?;
        if out.ok() {
            Ok(out.stdout)
        } else {
            Err(failure_of(&out))
        }
    }

    /// A network command (fetch, push). Its output is returned whatever its exit, for the caller to
    /// read per-ref results; failures are classified by `failure_of`.
    pub fn network(&self, place: &Place<'_>, args: &[OsString]) -> Result<Output> {
        self.run(place, args, None, NETWORK_TIMEOUT, OUTPUT_CAP)
    }
}

pub fn failure_of(out: &Output) -> HistoryError {
    let kind = classify(&out.stderr);
    kind.error(Some(&sanitize_detail(&out.stderr)))
}

fn concat_os(prefix: &str, value: &OsStr) -> OsString {
    let mut out = OsString::from(prefix);
    out.push(value);
    out
}

/// `2.56.0.windows.4` → `(2, 56)`.
pub fn parse_version(text: &str) -> Option<(u32, u32)> {
    let mut parts = text.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// A known helper name with plain arguments (`cache --timeout=3600`), or an absolute path to a file
/// that exists (spaces escaped as Git's shell expects, nothing else a shell would act on).
pub fn acceptable_helper(value: &str) -> bool {
    if value.starts_with('!') || value.chars().any(|c| c.is_control()) {
        return false;
    }
    let shell_free = |s: &str| {
        !s.chars().any(|c| {
            matches!(
                c,
                ';' | '|'
                    | '&'
                    | '$'
                    | '`'
                    | '<'
                    | '>'
                    | '('
                    | ')'
                    | '\''
                    | '"'
                    | '*'
                    | '?'
                    | '{'
                    | '}'
                    | '\n'
            )
        })
    };
    let mut words = value.split_whitespace();
    let first = words.next().unwrap_or("");
    if KNOWN_HELPERS.contains(&first) {
        return words.all(|w| {
            !w.is_empty()
                && w.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'-' | b'=' | b'.' | b'_' | b'/' | b':' | b'~')
                })
        });
    }
    // An absolute path, possibly with Git-style escaped spaces, and nothing after it.
    if !shell_free(value) {
        return false;
    }
    let unescaped = value.replace("\\ ", " ");
    if unescaped.contains('\\') && !cfg!(windows) {
        return false;
    }
    if value.contains(' ') && !value.contains("\\ ") {
        // An unescaped space would split it into a program and arguments.
        return false;
    }
    let path = Path::new(&unescaped);
    path.is_absolute() && path.is_file()
}

/// Every absolute `PATH` entry that holds `git`, in order. Relative entries (`.` among them) are
/// skipped, so neither the app's working directory nor a repository can supply `git`. On Windows
/// an entry ending in `Git\cmd` (Git for Windows' own launcher) is preferred, then the standard
/// install folders if `PATH` holds none.
fn find_git() -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut found: Vec<PathBuf> = std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .filter(|exe| exe.is_file())
        .collect();
    if cfg!(windows) {
        for var in ["ProgramW6432", "ProgramFiles", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(var) {
                let root = PathBuf::from(root);
                let exe = if var == "LOCALAPPDATA" {
                    root.join("Programs").join("Git").join("cmd").join(name)
                } else {
                    root.join("Git").join("cmd").join(name)
                };
                if exe.is_absolute() && exe.is_file() {
                    found.push(exe);
                }
            }
        }
        if let Some(i) = found.iter().position(|exe| {
            exe.parent()
                .and_then(|d| d.file_name())
                .is_some_and(|n| n.eq_ignore_ascii_case("cmd"))
        }) {
            let preferred = found.remove(i);
            found.insert(0, preferred);
        }
    }
    found
        .into_iter()
        .find_map(|exe| dunce::canonicalize(exe).ok())
}

/// git's own folder and the system folders, nothing from the inherited `PATH`.
fn limited_path(exe: &Path) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        dirs.push(dir.to_path_buf());
    }
    if cfg!(windows) {
        // Git for Windows' own tools (ssh, the credential manager) when `git.exe` was found in
        // `mingw64\bin` rather than its `cmd` launcher, which adds them itself.
        for install in exe.ancestors().skip(2).take(2) {
            for sub in [["mingw64", "bin"], ["usr", "bin"]] {
                let dir = install.join(sub[0]).join(sub[1]);
                let tools = dir.join("git.exe").is_file() || dir.join("ssh.exe").is_file();
                if tools && !dirs.contains(&dir) {
                    dirs.push(dir);
                }
            }
        }
        if let Some(root) = std::env::var_os("SystemRoot") {
            let root = PathBuf::from(root);
            if root.is_absolute() {
                dirs.push(root.join("System32"));
                dirs.push(root.clone());
            }
        }
    } else {
        for dir in ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            dirs.push(PathBuf::from(dir));
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Creates `dir` if needed and makes sure it is empty: hooks and the working directory must hold
/// nothing for Git to find.
fn empty_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    if fs::read_dir(dir)?.next().is_some() {
        fs::remove_dir_all(dir)?;
        fs::create_dir_all(dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Bounded execution

/// Runs `command` with no shell, `input` on stdin, both outputs capped at `cap` bytes, and the
/// whole process tree killed if it outlives `timeout` or `cancel` is set. Waits for the pipes to
/// close as well as the process to exit: a child of Git (ssh, a credential helper) can outlive it.
pub fn run_bounded(
    mut command: Command,
    input: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Output> {
    match run_raw(&mut command, input, timeout, cap, cancel) {
        Ok(out) => Ok(out),
        Err(RunError::Spawn(e)) if e.kind() == io::ErrorKind::NotFound => {
            Err(Failure::GitMissing.error(None))
        }
        Err(RunError::Spawn(e)) | Err(RunError::Io(e)) => {
            eprintln!("Draft Canvas: git could not be run ({})", e.kind());
            Err(Failure::Other.error(None))
        }
        Err(RunError::Timeout { pipes_closed }) | Err(RunError::Cancelled { pipes_closed })
            if !pipes_closed =>
        {
            // Not expected: the job object or process group should end every descendant.
            eprintln!("Draft Canvas: a process git started outlived it");
            Err(Failure::Timeout.error(None))
        }
        Err(RunError::Timeout { .. }) => Err(Failure::Timeout.error(None)),
        Err(RunError::Cancelled { .. }) => Err(Failure::Interrupted.error(None)),
        Err(RunError::Overflow) => Err(HistoryError::too_large(
            "Git's answer was larger than Draft Canvas reads.",
        )),
    }
}

#[derive(Debug)]
pub enum RunError {
    Spawn(io::Error),
    Io(io::Error),
    /// `pipes_closed`: every process that held the output pipes was gone within `KILL_GRACE`.
    Timeout {
        pipes_closed: bool,
    },
    Cancelled {
        pipes_closed: bool,
    },
    Overflow,
}

pub fn run_raw(
    command: &mut Command,
    input: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
    cancel: Option<&AtomicBool>,
) -> std::result::Result<Output, RunError> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    let (mut child, tree) = crate::process_tree::spawn(command).map_err(RunError::Spawn)?;
    #[cfg(not(windows))]
    let mut child = command.spawn().map_err(RunError::Spawn)?;

    let kill = |child: &mut std::process::Child| {
        #[cfg(windows)]
        let _ = tree.terminate();
        #[cfg(unix)]
        kill_group(child);
        let _ = child.kill();
    };

    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            std::thread::spawn(move || {
                let _ = stdin.write_all(&input);
                // Dropped here: Git sees end of input.
            });
        }
    }
    let (tx, rx) = mpsc::sync_channel::<(bool, Option<Vec<u8>>)>(16);
    let drain = |mut pipe: Box<dyn Read + Send>, is_stdout: bool| {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send((is_stdout, Some(buffer[..n].to_vec()))).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send((is_stdout, None));
        });
    };
    drain(Box::new(child.stdout.take().expect("piped")), true);
    drain(Box::new(child.stderr.take().expect("piped")), false);
    drop(tx);

    let deadline = Instant::now() + timeout;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut status: Option<ExitStatus> = None;
    let mut closed = 0;
    enum Stop {
        Timeout,
        Cancelled,
        Overflow,
        Io(io::Error),
    }
    let stop = loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(next) => status = next,
                Err(e) => break Stop::Io(e),
            }
        }
        if closed >= 2 {
            if let Some(status) = status {
                #[cfg(windows)]
                let _ = tree.terminate();
                return Ok(Output {
                    status,
                    stdout,
                    stderr: String::from_utf8_lossy(&stderr).into_owned(),
                });
            }
        }
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            break Stop::Cancelled;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Stop::Timeout;
        }
        match rx.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok((is_stdout, Some(bytes))) => {
                let target = if is_stdout { &mut stdout } else { &mut stderr };
                if target.len() + bytes.len() > cap {
                    break Stop::Overflow;
                }
                target.extend(bytes);
            }
            Ok((_, None)) => closed += 1,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                closed = 2;
                std::thread::sleep(remaining.min(Duration::from_millis(10)));
            }
        }
    };
    kill(&mut child);
    let _ = child.wait();
    // Every holder of the pipes is gone once the tree is: their readers see end of file.
    let grace = Instant::now() + KILL_GRACE;
    while closed < 2 {
        match rx.recv_timeout(grace.saturating_duration_since(Instant::now())) {
            Ok((_, None)) => closed += 1,
            Ok(_) => {}
            Err(RecvTimeoutError::Disconnected) => closed = 2,
            Err(RecvTimeoutError::Timeout) => break,
        }
    }
    let pipes_closed = closed >= 2;
    Err(match stop {
        Stop::Timeout => RunError::Timeout { pipes_closed },
        Stop::Cancelled => RunError::Cancelled { pipes_closed },
        Stop::Overflow => RunError::Overflow,
        Stop::Io(e) => RunError::Io(e),
    })
}

#[cfg(unix)]
fn kill_group(child: &std::process::Child) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: kill(2) takes plain integers; `process_group(0)` made the child lead its own group,
        // so a negative pid names exactly the tree started here.
        unsafe {
            kill(-pid, 9);
        }
    }
}
