//! A history's remote: one `origin` in the history's own bare repository, set only by the person,
//! fetched and published only when they ask (`commands/history.rs`), always through `gitcli.rs`.
//!
//! - Only `main` and alternatives (`alt/<id>`) are fetched, never tags, into a holding namespace
//!   (`refs/draft-canvas/incoming/`). Every revision a fetched tip reaches must be a diagram revision
//!   (`Repo::is_diagram_history`) before it becomes a remote-tracking branch; one that is not is
//!   dropped, and the fetch reports the history corrupt.
//! - Only `main`, `alt/<id>` and `milestone/<id>` tags are published, each as `<ref>:<ref>`: never
//!   forced, mirrored or `--all`. A remote that moved on is reported, never overwritten.

use super::gitcli::{args, classify, failure_of, sanitize_detail, Failure, Git, Output, Place};
use super::store::{History, Repo};
use super::{is_safe_id, limits, Code, HistoryError, LogQuery, RefEntry, Result};
use gix::ObjectId;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

pub const ORIGIN: &str = "origin";
const INCOMING: &str = "refs/draft-canvas/incoming/";
const TRACKING: &str = "refs/remotes/origin/";
/// Subjects listed per ref in a push preview.
const MAX_SUBJECTS: usize = 20;
/// Outgoing commits counted per ref; more reads as "500 or more".
const MAX_COUNT: usize = limits::MAX_LOG_PAGE;
const MAX_PUSH_REFS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub available: bool,
    pub version: Option<String>,
    pub reason: Option<String>,
}

pub fn git_status(history: &History) -> GitStatus {
    match history.git() {
        Ok(git) => GitStatus {
            available: true,
            version: Some(git.version().to_string()),
            reason: None,
        },
        Err(missing) => GitStatus {
            available: false,
            version: missing.version,
            reason: Some(missing.reason),
        },
    }
}

/// The `git` to run, or the reason there is none as an error.
pub fn require_git(history: &History) -> Result<std::sync::Arc<Git>> {
    history.git().map_err(|missing| {
        HistoryError::new(Code::Unavailable, missing.reason).with_reason("git-missing")
    })
}

/// How a local branch stands against its remote-tracking branch after a fetch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    /// `refs/heads/main` or `refs/heads/alt/<id>`.
    pub branch: String,
    pub local: Option<String>,
    pub remote: Option<String>,
    /// Commits only the local branch has, at most `MAX_COUNT`.
    pub ahead: u32,
    /// Commits only the remote has.
    pub behind: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOutcome {
    /// Every remote-tracking branch (`refs/remotes/origin/...`) after the fetch.
    pub refs: Vec<RefEntry>,
    pub branches: Vec<BranchState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreview {
    #[serde(rename = "ref")]
    pub name: String,
    pub destination: String,
    pub local: String,
    /// What this device last saw on the remote for that ref, if anything.
    pub remote: Option<String>,
    pub outgoing: u32,
    /// First lines of the outgoing commits, newest first, at most `MAX_SUBJECTS`.
    pub subjects: Vec<String>,
    pub fast_forward: bool,
    pub up_to_date: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushedRef {
    #[serde(rename = "ref")]
    pub name: String,
    pub oid: String,
    pub up_to_date: bool,
}

fn place(dir: &Path) -> Place<'_> {
    Place::Managed(dir)
}

/// Refuses a history repository whose own configuration names a program (someone edited it by
/// hand): the same scan a project repository gets.
fn check_config(git: &Git, dir: &Path) -> Result<()> {
    let scan = super::project::scan_config(git, dir, dir)?;
    if let Some(refused) = scan.refused {
        return Err(HistoryError::new(
            Code::UnsupportedFormat,
            format!("This history's Git configuration was changed outside Draft Canvas ({refused}), so it won't be used with a remote."),
        )
        .with_reason("config-refused"));
    }
    Ok(())
}

fn configured_url(git: &Git, dir: &Path) -> Result<Option<String>> {
    let out = git.run(
        &place(dir),
        &args!["config", "--get", "remote.origin.url"],
        None,
        super::gitcli::LOCAL_TIMEOUT,
        super::gitcli::OUTPUT_CAP,
    )?;
    match out.code() {
        Some(0) => Ok(Some(out.text())),
        Some(1) => Ok(None),
        _ => Err(failure_of(&out)),
    }
}

/// The addresses Git will really use for `origin` (after any `insteadOf` in the person's own
/// configuration), each checked again.
pub(super) fn checked_effective_urls(
    git: &Git,
    place: &Place<'_>,
    push: bool,
) -> Result<Vec<String>> {
    let mut args = Vec::from(args!["remote", "get-url", "--all"]);
    if push {
        args.push("--push".into());
    }
    args.push(ORIGIN.into());
    let out = git.run(
        place,
        &args,
        None,
        super::gitcli::LOCAL_TIMEOUT,
        super::gitcli::OUTPUT_CAP,
    )?;
    if !out.ok() {
        return Err(
            HistoryError::not_found("No remote is set up for this.").with_reason("no-remote")
        );
    }
    let urls: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if urls.is_empty() {
        return Err(
            HistoryError::not_found("No remote is set up for this.").with_reason("no-remote")
        );
    }
    for url in &urls {
        if git.validate_url(url).is_err() {
            return Err(HistoryError::invalid(
                "Your Git configuration turns this remote's address into one Draft Canvas doesn't publish to (https:// or ssh only, no credentials in it).",
            )
            .with_reason("url-rewritten"));
        }
    }
    Ok(urls)
}

/// Validates `url` and makes it this history's `origin`. Returns the address as stored.
pub fn remote_set(history: &History, git: &Git, repo_id: &str, url: &str) -> Result<String> {
    let normalized = git
        .validate_url(url.trim())
        .map_err(|m| HistoryError::invalid(m).with_reason("invalid-url"))?;
    let dir = history.managed_dir(repo_id)?;
    check_config(git, &dir)?;
    let at = place(&dir);
    let previous = configured_url(git, &dir)?;
    let verb = if previous.is_some() { "set-url" } else { "add" };
    git.local(&at, &args!["remote", verb, ORIGIN, &normalized], None)?;
    if let Err(e) =
        checked_effective_urls(git, &at, false).and_then(|_| checked_effective_urls(git, &at, true))
    {
        // Put things back as they were.
        let _ = match &previous {
            Some(old) => git.local(&at, &args!["remote", "set-url", ORIGIN, old], None),
            None => git.local(&at, &args!["remote", "remove", ORIGIN], None),
        };
        return Err(e);
    }
    Ok(normalized)
}

/// Forgets `origin` and its remote-tracking branches. Nothing on the remote changes.
pub fn remote_remove(history: &History, git: &Git, repo_id: &str) -> Result<()> {
    let dir = history.managed_dir(repo_id)?;
    check_config(git, &dir)?;
    if configured_url(git, &dir)?.is_none() {
        return Ok(());
    }
    git.local(&place(&dir), &args!["remote", "remove", ORIGIN], None)?;
    Ok(())
}

/// The local name a fetched branch is allowed to have: `main` or `alt/<id>`.
fn fetched_name_ok(rest: &str) -> bool {
    rest == "main" || rest.strip_prefix("alt/").is_some_and(is_safe_id)
}

/// Fetches `main` and every alternative into the holding namespace, checks every revision they
/// reach, and moves the acceptable ones to `refs/remotes/origin/`. Branches gone from the remote
/// are pruned. If any fetched branch is not a diagram history it is left out (and its old
/// remote-tracking branch removed), and the result is an error.
pub fn fetch(history: &History, git: &Git, repo_id: &str) -> Result<FetchOutcome> {
    let dir = history.managed_dir(repo_id)?;
    check_config(git, &dir)?;
    let at = place(&dir);
    checked_effective_urls(git, &at, false)?;
    // The holding namespace starts empty, so afterwards it is exactly what the remote has.
    {
        let repo = history.open_writable(repo_id)?;
        for (name, id) in repo.refs_raw(INCOMING)? {
            repo.set_tracking_ref(&name, Some(id), None)?;
        }
    }
    let fetch_args = |with_main: bool| {
        let mut a = Vec::from(args![
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            ORIGIN,
        ]);
        if with_main {
            a.push("+refs/heads/main:refs/draft-canvas/incoming/main".into());
        }
        a.push("+refs/heads/alt/*:refs/draft-canvas/incoming/alt/*".into());
        a
    };
    let mut out = git.network(&at, &fetch_args(true))?;
    if !out.ok() && classify(&out.stderr) == Failure::MissingRemoteBranch {
        // A remote with no `main` yet (nothing published): fetch the alternatives alone.
        out = git.network(&at, &fetch_args(false))?;
    }
    if !out.ok() {
        return Err(failure_of(&out));
    }

    let repo = history.open_writable(repo_id)?;
    let incoming = repo.refs_raw(INCOMING)?;
    let tracking = repo.refs_raw(TRACKING)?;
    let mut checked: HashSet<ObjectId> = HashSet::new();
    let mut accepted: BTreeMap<String, ObjectId> = BTreeMap::new();
    let mut refused = 0usize;
    for (name, id) in &incoming {
        let rest = &name[INCOMING.len()..];
        if fetched_name_ok(rest) && repo.is_diagram_history(*id, &mut checked) {
            accepted.insert(format!("{TRACKING}{rest}"), *id);
        } else {
            refused += 1;
        }
    }
    // Remote-tracking branches: exactly the accepted ones.
    for (name, id) in &tracking {
        match accepted.get(name) {
            Some(next) if next == id => {}
            Some(next) => repo.set_tracking_ref(name, Some(*id), Some(*next))?,
            None => repo.set_tracking_ref(name, Some(*id), None)?,
        }
    }
    let known: HashSet<&String> = tracking.iter().map(|(n, _)| n).collect();
    for (name, id) in &accepted {
        if !known.contains(name) {
            repo.set_tracking_ref(name, None, Some(*id))?;
        }
    }
    for (name, id) in &incoming {
        repo.set_tracking_ref(name, Some(*id), None)?;
    }
    if refused > 0 {
        return Err(HistoryError::corrupt(
            "Something on the remote isn't a Draft Canvas diagram history, so it was left out.",
        )
        .with_reason("invalid-remote-history"));
    }
    outcome(&repo)
}

fn outcome(repo: &Repo) -> Result<FetchOutcome> {
    let tracking = repo.refs_raw(TRACKING)?;
    let mut local = repo.list_refs("refs/heads")?;
    local.retain(|r| fetched_name_ok(&r.name["refs/heads/".len()..]));
    let mut names: Vec<String> = local
        .iter()
        .map(|r| r.name["refs/heads/".len()..].to_string())
        .collect();
    for (name, _) in &tracking {
        let rest = name[TRACKING.len()..].to_string();
        if !names.contains(&rest) {
            names.push(rest);
        }
    }
    names.sort();
    let mut branches = Vec::new();
    for rest in names {
        let local_oid = local
            .iter()
            .find(|r| r.name[11..] == rest)
            .map(|r| r.oid.clone());
        let remote_oid = tracking
            .iter()
            .find(|(n, _)| n[TRACKING.len()..] == rest)
            .map(|(_, id)| id.to_string());
        let count = |from: &Option<String>, hide: &Option<String>| -> Result<u32> {
            let Some(from) = from else { return Ok(0) };
            let commits = repo.log(&LogQuery {
                from: vec![from.clone()],
                limit: MAX_COUNT as i64,
                hide: hide.clone().map(|h| vec![h]),
            })?;
            Ok(commits.len() as u32)
        };
        branches.push(BranchState {
            ahead: count(&local_oid, &remote_oid)?,
            behind: count(&remote_oid, &local_oid)?,
            branch: format!("refs/heads/{rest}"),
            local: local_oid,
            remote: remote_oid,
        });
    }
    Ok(FetchOutcome {
        refs: tracking
            .into_iter()
            .map(|(name, id)| RefEntry {
                name,
                oid: id.to_string(),
            })
            .collect(),
        branches,
    })
}

/// A ref a history may publish, and its remote-tracking name (`None` for a tag).
fn publishable(name: &str) -> Result<Option<String>> {
    if name == "refs/heads/main" {
        return Ok(Some(format!("{TRACKING}main")));
    }
    if let Some(id) = name.strip_prefix("refs/heads/alt/") {
        if is_safe_id(id) {
            return Ok(Some(format!("{TRACKING}alt/{id}")));
        }
    }
    if let Some(id) = name.strip_prefix("refs/tags/milestone/") {
        if is_safe_id(id) {
            return Ok(None);
        }
    }
    Err(
        HistoryError::invalid("Only main, alternatives and milestones are published.")
            .with_reason("not-publishable"),
    )
}

fn checked_refs(refs: &[String]) -> Result<Vec<(String, Option<String>)>> {
    if refs.is_empty() || refs.len() > MAX_PUSH_REFS {
        return Err(HistoryError::invalid("Choose what to publish."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for name in refs {
        let tracking = publishable(name)?;
        if seen.insert(name.clone()) {
            out.push((name.clone(), tracking));
        }
    }
    Ok(out)
}

/// One line, no control or direction characters, bounded: a subject as the page may show it.
pub(super) fn clean_subject(message: &str) -> String {
    let first = message.lines().next().unwrap_or("").trim();
    let mut out: String = first
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .collect();
    if out.chars().count() > 200 {
        out = out.chars().take(200).collect::<String>() + "…";
    }
    out
}

/// What publishing `refs` would send, judged against what this device last fetched. No network.
pub fn push_preview(history: &History, repo_id: &str, refs: &[String]) -> Result<Vec<PushPreview>> {
    let refs = checked_refs(refs)?;
    let repo = history.open_writable(repo_id)?;
    let remote_tips: Vec<String> = repo
        .refs_raw(TRACKING)?
        .into_iter()
        .map(|(_, id)| id.to_string())
        .collect();
    let mut out = Vec::new();
    for (name, tracking) in refs {
        let local = repo
            .read_ref(&name)?
            .ok_or_else(|| HistoryError::not_found("That branch or milestone doesn't exist."))?;
        let commit = repo.peel_to_commit(super::parse_oid(&local)?)?.to_string();
        let remote = match &tracking {
            Some(t) => repo
                .refs_raw(t)?
                .into_iter()
                .find(|(n, _)| n == t)
                .map(|(_, id)| id.to_string()),
            None => None,
        };
        let outgoing = repo.log(&LogQuery {
            from: vec![commit.clone()],
            limit: MAX_COUNT as i64,
            hide: Some(remote_tips.clone()),
        })?;
        let fast_forward = match &remote {
            Some(r) => repo.is_ancestor(r, &commit)?,
            None => true,
        };
        out.push(PushPreview {
            destination: name.clone(),
            up_to_date: remote.as_deref() == Some(local.as_str()),
            name,
            local,
            remote,
            outgoing: outgoing.len() as u32,
            subjects: outgoing
                .iter()
                .take(MAX_SUBJECTS)
                .map(|c| clean_subject(&c.message))
                .collect(),
            fast_forward,
        });
    }
    Ok(out)
}

/// Reads `git push --porcelain`: success, or the most telling failure. A ref the remote refused as
/// not a fast-forward is `RejectedNonFastForward` whatever else stderr says.
pub(super) fn push_result(out: &Output) -> Result<Vec<(String, bool)>> {
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut results = Vec::new();
    let mut rejected: Option<Failure> = None;
    for line in stdout.lines() {
        let mut fields = line.splitn(3, '\t');
        let (Some(flag), Some(refs), summary) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let summary = summary.unwrap_or("").to_ascii_lowercase();
        let destination = refs.rsplit(':').next().unwrap_or("").to_string();
        match flag {
            "!" => {
                let kind = if summary.contains("non-fast-forward")
                    || summary.contains("fetch first")
                    || summary.contains("already exists")
                    || summary.contains("stale info")
                {
                    Failure::RejectedNonFastForward
                } else {
                    classify(&format!("{summary}\n{}", out.stderr))
                };
                rejected.get_or_insert(kind);
            }
            "=" => results.push((destination, true)),
            " " | "*" => results.push((destination, false)),
            _ => {}
        }
    }
    if let Some(kind) = rejected {
        return Err(kind.error(Some(&sanitize_detail(&out.stderr))));
    }
    if !out.ok() {
        return Err(failure_of(out));
    }
    Ok(results)
}

/// Publishes `refs`, each to the same name on `origin`, never forced. Remote-tracking branches
/// follow what was published.
pub fn push(
    history: &History,
    git: &Git,
    repo_id: &str,
    refs: &[String],
) -> Result<Vec<PushedRef>> {
    let refs = checked_refs(refs)?;
    let dir = history.managed_dir(repo_id)?;
    check_config(git, &dir)?;
    let at = place(&dir);
    checked_effective_urls(git, &at, true)?;
    let repo = history.open_writable(repo_id)?;
    let mut locals = Vec::new();
    for (name, _) in &refs {
        let local = repo
            .read_ref(name)?
            .ok_or_else(|| HistoryError::not_found("That branch or milestone doesn't exist."))?;
        locals.push(local);
    }
    let mut args = Vec::from(args![
        "push",
        "--porcelain",
        "--no-verify",
        "--recurse-submodules=no",
        ORIGIN
    ]);
    for (name, _) in &refs {
        args.push(format!("{name}:{name}").into());
    }
    let out = git.network(&at, &args)?;
    let results = push_result(&out)?;
    // Git moves remote-tracking branches itself where its fetch refspec maps them; say so explicitly.
    let repo = history.open_writable(repo_id)?;
    let mut pushed = Vec::new();
    for ((name, tracking), local) in refs.iter().zip(locals) {
        let up_to_date = results.iter().any(|(dest, same)| dest == name && *same);
        if let Some(tracking) = tracking {
            let next = super::parse_oid(&local)?;
            let current = repo
                .refs_raw(tracking)?
                .into_iter()
                .find(|(n, _)| n == tracking)
                .map(|(_, id)| id);
            if current != Some(next) {
                repo.set_tracking_ref(tracking, current, Some(next))?;
            }
        }
        pushed.push(PushedRef {
            name: name.clone(),
            oid: local,
            up_to_date,
        });
    }
    Ok(pushed)
}
