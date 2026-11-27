//! A person's own software repository, when a saved diagram lives inside one (ADR-4). Recording
//! history never touches it; only an explicit publish does, and then as narrowly as Git allows:
//!
//! - **Publish to a branch of its own** (`publish_branch`): a commit whose tree is its parent's with
//!   exactly the diagram's path replaced by the saved file's bytes, on `draft-canvas/<path>`, moved by
//!   compare-and-swap. HEAD, the index and the working tree are never touched.
//! - **Commit to the current branch** (`commit_current`): the same commit on HEAD's branch, allowed
//!   only when nothing about the repository's state makes it surprising (`Refusal`), then exactly one
//!   index entry updated so the person's other staged changes stay staged.
//! - **Push** (`push`): one branch, to the same name on the existing `origin`, never forced.
//!
//! The file is named by the handle the page already holds for it (`grants.rs`), never by a path from
//! the page. Before Git runs anything else in the repository its configuration is scanned
//! (`scan_config`); a repository that configures programs, URL rewriting or includes is refused.

use super::gitcli::{
    args, failure_of, overridden_key, refused_key, Git, Place, LOCAL_TIMEOUT, OUTPUT_CAP,
};
use super::remote::{checked_effective_urls, clean_subject, push_result, ORIGIN};
use super::{is_safe_ref_name, limits, Code, HistoryError, Result};
use crate::docio::MAX_DOC_BYTES;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const ZERO_OID: &str = "0000000000000000000000000000000000000000";
/// Directories walked up from a diagram looking for its repository.
const MAX_DEPTH: usize = 64;
/// One level of a tree, as `ls-tree` lists it: a folder of a large monorepo can be big.
const TREE_CAP: usize = 32 * 1024 * 1024;
const MAX_OUTGOING: usize = 10_000;

/// What `history_project_repo` tells the page about the repository holding a diagram.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepoInfo {
    /// The repository folder's own name, for display.
    pub root_name: String,
    /// HEAD's branch, `None` when HEAD is detached.
    pub branch: Option<String>,
    /// The diagram's path in the repository, with forward slashes.
    pub rel_path: String,
    pub head_oid: Option<String>,
    pub merging: bool,
    pub rebasing: bool,
    pub cherry_picking: bool,
    pub reverting: bool,
    pub bisecting: bool,
    /// The index holds a version of the diagram that differs from HEAD's.
    pub path_staged: bool,
    /// ...and from the file on disk too: committing would lose one of them.
    pub path_partially_staged: bool,
    pub path_untracked: bool,
    pub path_ignored: bool,
    /// A filter, end-of-line conversion, encoding or `ident` would change the file on commit.
    pub filtered: bool,
    pub sparse_excluded: bool,
    pub signing_required: bool,
    pub has_origin: bool,
    /// The branch `publish_branch` uses for this diagram.
    pub publish_branch: String,
    /// Why Draft Canvas won't run Git in this repository, if it won't.
    pub config_refused: Option<String>,
    /// Settings found in the repository that Draft Canvas overrides on every run (hooks, fsmonitor).
    pub config_overridden: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub branch: String,
    pub oid: String,
    /// False when the branch already held exactly this file: nothing was written.
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPushPreview {
    pub branch: String,
    pub local: String,
    pub remote: Option<String>,
    /// Commits the remote's branches don't have yet: every one of them would be published, the
    /// person's own source commits included. At most `MAX_OUTGOING`.
    pub outgoing: u32,
    pub subjects: Vec<String>,
    pub fast_forward: bool,
}

/// Where the repository is, as found from the diagram's own path.
#[derive(Debug, Clone)]
pub struct ProjectRepo {
    /// The working tree's root.
    pub root: PathBuf,
    /// This working tree's git dir (`.git`, or `.git/worktrees/<name>` of the main repository).
    pub git_dir: PathBuf,
    /// The repository's common dir: objects, refs and config.
    pub common_dir: PathBuf,
    pub rel_path: String,
    pub file: PathBuf,
}

impl ProjectRepo {
    fn place(&self) -> Place<'_> {
        Place::Project {
            git_dir: &self.git_dir,
            work_tree: &self.root,
        }
    }
}

fn unsupported(reason: &'static str, message: impl Into<String>) -> HistoryError {
    HistoryError::new(Code::UnsupportedFormat, message).with_reason(reason)
}

fn refusal(reason: &'static str, message: &str) -> HistoryError {
    let code = if reason == "head-moved" {
        Code::Conflict
    } else {
        Code::UnsupportedFormat
    };
    HistoryError::new(code, message).with_reason(reason)
}

fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|h| !h.is_empty())
        .and_then(|h| dunce::canonicalize(h).ok())
}

/// The repository whose working tree holds `file` (canonical), or `None`. Walks up at most
/// `MAX_DEPTH` folders, never into the home folder itself or the file system's root, and never
/// for a file inside a `.git` folder. A `.git` file is followed only to a standard linked
/// worktree of a repository whose `.git` folder is where it says; a submodule's, or one pointing
/// anywhere else, is refused.
pub fn discover(file: &Path) -> Result<Option<ProjectRepo>> {
    discover_below(file, home().as_deref())
}

pub fn discover_below(file: &Path, stop: Option<&Path>) -> Result<Option<ProjectRepo>> {
    if file
        .components()
        .any(|c| matches!(c, Component::Normal(n) if n.eq_ignore_ascii_case(".git")))
    {
        return Ok(None);
    }
    let mut dir = file.parent();
    for _ in 0..MAX_DEPTH {
        let Some(here) = dir else { return Ok(None) };
        if here.parent().is_none() || Some(here) == stop {
            return Ok(None);
        }
        let dotgit = here.join(".git");
        match fs::symlink_metadata(&dotgit) {
            Ok(meta) if meta.is_dir() => {
                if dotgit.join("commondir").exists() {
                    return Err(unsupported("redirected-git-dir", "This repository's Git folder is set up in a way Draft Canvas doesn't publish to."));
                }
                return Ok(Some(found(here, dotgit.clone(), dotgit, file)?));
            }
            Ok(meta) if meta.is_file() => {
                let (git_dir, common) = linked_worktree(here, &dotgit)?;
                return Ok(Some(found(here, git_dir, common, file)?));
            }
            Ok(_) => {
                return Err(unsupported(
                    "redirected-git-dir",
                    "This repository's .git is a link, which Draft Canvas doesn't follow.",
                ));
            }
            Err(_) => {}
        }
        dir = here.parent();
    }
    Ok(None)
}

fn found(root: &Path, git_dir: PathBuf, common: PathBuf, file: &Path) -> Result<ProjectRepo> {
    let rel = file.strip_prefix(root).map_err(|_| {
        unsupported(
            "outside",
            "The diagram isn't inside that repository's folder.",
        )
    })?;
    let mut parts = Vec::new();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return Err(unsupported(
                "path",
                "The diagram's path can't be used in Git.",
            ));
        };
        let name = name
            .to_str()
            .ok_or_else(|| unsupported("path", "The diagram's path isn't valid text."))?;
        parts.push(name.to_string());
    }
    if parts.is_empty() {
        return Err(unsupported(
            "path",
            "The diagram's path can't be used in Git.",
        ));
    }
    Ok(ProjectRepo {
        root: root.to_path_buf(),
        git_dir: dunce::canonicalize(&git_dir).unwrap_or(git_dir),
        common_dir: dunce::canonicalize(&common).unwrap_or(common),
        rel_path: parts.join("/"),
        file: file.to_path_buf(),
    })
}

/// A small regular file's text. Anything else (a FIFO, a device, a directory, a link) is not read:
/// opening a FIFO would block for ever.
fn read_small(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_string(&mut text)
        .ok()?;
    Some(text.trim().to_string())
}

/// A `.git` file: accepted only when it names `<main>/.git/worktrees/<name>`, whose `commondir`
/// is `<main>/.git` and whose `gitdir` names this `.git` file back.
fn linked_worktree(root: &Path, dotgit: &Path) -> Result<(PathBuf, PathBuf)> {
    let refuse = || {
        unsupported(
            "submodule",
            "This diagram is inside a submodule or a repository whose Git folder lives elsewhere, which Draft Canvas doesn't publish to.",
        )
    };
    let text = read_small(dotgit).ok_or_else(refuse)?;
    let target = text.strip_prefix("gitdir:").ok_or_else(refuse)?.trim();
    let target = Path::new(target);
    let git_dir = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root.join(target)
    };
    let git_dir = dunce::canonicalize(git_dir).map_err(|_| refuse())?;
    let common_rel = read_small(&git_dir.join("commondir")).ok_or_else(refuse)?;
    let common_path = Path::new(&common_rel);
    let common = if common_path.is_absolute() {
        common_path.to_path_buf()
    } else {
        git_dir.join(common_path)
    };
    let common = dunce::canonicalize(common).map_err(|_| refuse())?;
    let in_worktrees = git_dir.parent() == Some(common.join("worktrees").as_path());
    let named_git = common
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case(".git"));
    let back = read_small(&git_dir.join("gitdir")).and_then(|p| dunce::canonicalize(p).ok());
    let points_back = back.as_deref() == dunce::canonicalize(dotgit).ok().as_deref();
    if !(in_worktrees && named_git && points_back) {
        return Err(refuse());
    }
    Ok((git_dir, common))
}

/// What a repository's own configuration says, as far as running Git in it goes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigScan {
    pub refused: Option<String>,
    pub overridden: Vec<String>,
}

/// Lists the repository's own configuration files (shared and per-worktree) by name, read as plain
/// files with no repository loaded and no includes followed, and finds anything that runs a
/// program, rewrites addresses or includes more. Also refuses borrowed object stores
/// (`objects/info/alternates`). `git_dir` is this working tree's git dir, `common` the repository's
/// common dir. Nothing at all is run in the repository before this: even starting Git there reads
/// its configuration, includes and all.
pub fn scan_config(git: &Git, git_dir: &Path, common: &Path) -> Result<ConfigScan> {
    let mut scan = ConfigScan::default();
    let mut files = vec![common.join("config")];
    for extra in [
        common.join("config.worktree"),
        git_dir.join("config.worktree"),
    ] {
        if !files.contains(&extra) {
            files.push(extra);
        }
    }
    let mut names = Vec::new();
    for file in files {
        if !file.exists() {
            continue;
        }
        match git.config_names(&file) {
            Ok(found) => names.extend(found),
            Err(_) => {
                scan.refused =
                    Some("config: Git can't read this repository's configuration".into());
                return Ok(scan);
            }
        }
    }
    for name in names {
        if name.is_empty() {
            continue;
        }
        if let Some(reason) = refused_key(&name) {
            if scan.refused.is_none() {
                scan.refused = Some(format!("{name}: {reason}"));
            }
        } else if overridden_key(&name) && !scan.overridden.contains(&name) {
            scan.overridden.push(name);
        }
    }
    let info = common.join("objects").join("info");
    if scan.refused.is_none()
        && (info.join("alternates").exists() || info.join("http-alternates").exists())
    {
        scan.refused =
            Some("objects/info/alternates: it borrows objects from another repository".into());
    }
    Ok(scan)
}

fn require_scan(git: &Git, repo: &ProjectRepo) -> Result<ConfigScan> {
    let scan = scan_config(git, &repo.git_dir, &repo.common_dir)?;
    if let Some(refused) = &scan.refused {
        return Err(unsupported(
            "config-refused",
            format!("Draft Canvas won't run Git in this repository because of its configuration ({refused})."),
        ));
    }
    Ok(scan)
}

/// `draft-canvas/<path without .draftcanvas, slashes as dashes>`, safe as a ref name.
pub fn publish_branch_name(rel_path: &str) -> String {
    let stem = rel_path
        .strip_suffix(".draftcanvas")
        .or_else(|| {
            let lower = rel_path.to_ascii_lowercase();
            lower
                .ends_with(".draftcanvas")
                .then(|| &rel_path[..rel_path.len() - ".draftcanvas".len()])
        })
        .unwrap_or(rel_path);
    let mut slug = String::new();
    for c in stem.chars() {
        let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
        let next = if keep { c } else { '-' };
        if next == '-' && slug.ends_with('-') {
            continue;
        }
        if next == '.' && slug.ends_with('.') {
            continue;
        }
        slug.push(next);
    }
    let mut slug = slug.trim_matches(|c| c == '-' || c == '.').to_string();
    if slug.len() > 100 {
        slug.truncate(100);
        slug = slug.trim_end_matches(['-', '.']).to_string();
    }
    while slug.ends_with(".lock") {
        slug.truncate(slug.len() - 5);
    }
    if slug.is_empty() {
        slug = "diagram".into();
    }
    format!("draft-canvas/{slug}")
}

fn is_hex_oid(text: &str) -> bool {
    super::is_oid(text)
}

/// A commit the repository has, by revision expression, or `None`.
fn resolve(git: &Git, repo: &ProjectRepo, rev: &str) -> Result<Option<String>> {
    let out = git.run(
        &repo.place(),
        &args!["rev-parse", "-q", "--verify", "--end-of-options", rev],
        None,
        LOCAL_TIMEOUT,
        OUTPUT_CAP,
    )?;
    if !out.ok() {
        return Ok(None);
    }
    let oid = out.text();
    if !is_hex_oid(&oid) {
        return Err(unsupported(
            "sha256",
            "This repository uses SHA-256 object ids, which Draft Canvas doesn't publish to yet.",
        ));
    }
    Ok(Some(oid))
}

/// One entry of `ls-tree -z`, kept as bytes: names are whatever the repository holds.
#[derive(Debug, Clone)]
struct TreeEntry {
    mode: String,
    kind: String,
    oid: String,
    name: Vec<u8>,
}

fn parse_tree(out: &[u8]) -> Result<Vec<TreeEntry>> {
    let bad = || HistoryError::corrupt("A folder of the repository could not be read.");
    let mut entries = Vec::new();
    for record in out.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let tab = record.iter().position(|b| *b == b'\t').ok_or_else(bad)?;
        let head = std::str::from_utf8(&record[..tab]).map_err(|_| bad())?;
        let mut fields = head.split(' ');
        let (Some(mode), Some(kind), Some(oid)) = (fields.next(), fields.next(), fields.next())
        else {
            return Err(bad());
        };
        entries.push(TreeEntry {
            mode: mode.to_string(),
            kind: kind.to_string(),
            oid: oid.to_string(),
            name: record[tab + 1..].to_vec(),
        });
    }
    Ok(entries)
}

fn list_tree(git: &Git, repo: &ProjectRepo, tree: &str) -> Result<Vec<TreeEntry>> {
    let out = git.local_capped(
        &repo.place(),
        &args!["ls-tree", "-z", "--full-tree", tree],
        None,
        TREE_CAP,
    )?;
    parse_tree(&out)
}

fn make_tree(git: &Git, repo: &ProjectRepo, entries: &[TreeEntry]) -> Result<String> {
    let mut input = Vec::new();
    for e in entries {
        input.extend_from_slice(format!("{} {} {}\t", e.mode, e.kind, e.oid).as_bytes());
        input.extend_from_slice(&e.name);
        input.push(0);
    }
    let out = git.local(
        &repo.place(),
        &args!["mktree", "-z", "--missing"],
        Some(&input),
    )?;
    let oid = String::from_utf8_lossy(&out).trim().to_string();
    if !is_hex_oid(&oid) {
        return Err(HistoryError::corrupt("Git didn't write the folder."));
    }
    Ok(oid)
}

/// `tree` (or an empty tree) with `parts` set to `blob`, rebuilding each folder on the way. Only a
/// regular file may be replaced, and only folders may lie on the way to it.
fn replace_path(
    git: &Git,
    repo: &ProjectRepo,
    tree: Option<&str>,
    parts: &[&str],
    blob: &str,
) -> Result<String> {
    let mut entries = match tree {
        Some(tree) => list_tree(git, repo, tree)?,
        None => Vec::new(),
    };
    let (name, rest) = parts
        .split_first()
        .ok_or_else(|| HistoryError::invalid("No path."))?;
    let existing = entries.iter().position(|e| e.name == name.as_bytes());
    if rest.is_empty() {
        let mode = match existing.map(|i| &entries[i]) {
            None => "100644".to_string(),
            Some(e) if e.kind == "blob" && (e.mode == "100644" || e.mode == "100755") => e.mode.clone(),
            Some(_) => {
                return Err(unsupported(
                    "not-a-file",
                    "In this repository the diagram's path is a link, submodule or folder, so Draft Canvas won't replace it.",
                ))
            }
        };
        let entry = TreeEntry {
            mode,
            kind: "blob".into(),
            oid: blob.to_string(),
            name: name.as_bytes().to_vec(),
        };
        match existing {
            Some(i) => entries[i] = entry,
            None => entries.push(entry),
        }
    } else {
        let sub = match existing.map(|i| &entries[i]) {
            None => None,
            Some(e) if e.kind == "tree" && e.mode == "040000" => Some(e.oid.clone()),
            Some(_) => return Err(unsupported(
                "not-a-file",
                "A folder on the diagram's path is a file, link or submodule in this repository.",
            )),
        };
        let oid = replace_path(git, repo, sub.as_deref(), rest, blob)?;
        let entry = TreeEntry {
            mode: "040000".into(),
            kind: "tree".into(),
            oid,
            name: name.as_bytes().to_vec(),
        };
        match existing {
            Some(i) => entries[i] = entry,
            None => entries.push(entry),
        }
    }
    make_tree(git, repo, &entries)
}

fn read_file(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| HistoryError::io(&e, crate::errors::Verb::Open))?;
    let mut bytes = Vec::new();
    file.take(MAX_DOC_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| HistoryError::io(&e, crate::errors::Verb::Open))?;
    if bytes.len() as u64 > MAX_DOC_BYTES {
        return Err(HistoryError::too_large(
            "This diagram is larger than Draft Canvas publishes.",
        ));
    }
    Ok(bytes)
}

fn blob_id(bytes: &[u8]) -> String {
    gix::objs::compute_hash(gix::hash::Kind::Sha1, gix::objs::Kind::Blob, bytes)
        .map(|id| id.to_string())
        .unwrap_or_default()
}

/// Writes the file's exact bytes as a blob (no filters) and checks Git agrees on its id.
fn write_blob(git: &Git, repo: &ProjectRepo, bytes: &[u8]) -> Result<String> {
    let out = git.local(
        &repo.place(),
        &args!["hash-object", "-w", "--no-filters", "--stdin"],
        Some(bytes),
    )?;
    let oid = String::from_utf8_lossy(&out).trim().to_string();
    if !is_hex_oid(&oid) {
        return Err(unsupported(
            "sha256",
            "This repository uses SHA-256 object ids, which Draft Canvas doesn't publish to yet.",
        ));
    }
    if oid != blob_id(bytes) {
        return Err(HistoryError::corrupt(
            "Git stored the diagram differently than it was saved.",
        ));
    }
    Ok(oid)
}

/// A commit message as the page sent it, made safe: LF line ends, no control characters but tabs
/// and line breaks, not empty, bounded.
pub fn clean_message(message: &str) -> Result<String> {
    let text = message.replace("\r\n", "\n").replace('\r', "\n");
    let mut text: String = text
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .filter(|c| !matches!(c, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .collect();
    text = text.trim().to_string();
    if text.is_empty() {
        return Err(HistoryError::invalid("Write a message for the commit."));
    }
    if text.len() > limits::MAX_MESSAGE_BYTES {
        return Err(HistoryError::too_large("That commit message is too long."));
    }
    text.push('\n');
    Ok(text)
}

fn commit_tree(
    git: &Git,
    repo: &ProjectRepo,
    tree: &str,
    parent: Option<&str>,
    message: &str,
) -> Result<String> {
    let mut a = Vec::from(args!["commit-tree", "--no-gpg-sign"]);
    if let Some(parent) = parent {
        a.push("-p".into());
        a.push(parent.into());
    }
    a.push("-F".into());
    a.push("-".into());
    a.push(tree.into());
    let out = git.local(&repo.place(), &a, Some(message.as_bytes()))?;
    let oid = String::from_utf8_lossy(&out).trim().to_string();
    if !is_hex_oid(&oid) {
        return Err(HistoryError::corrupt("Git didn't record the commit."));
    }
    Ok(oid)
}

/// Moves `name` from `expected` (`None`: must not exist) to `next`, under Git's own ref lock.
fn update_ref(
    git: &Git,
    repo: &ProjectRepo,
    name: &str,
    next: &str,
    expected: Option<&str>,
    note: &str,
) -> Result<()> {
    let out = git.run(
        &repo.place(),
        &args![
            "update-ref",
            "-m",
            note,
            "--no-deref",
            name,
            next,
            expected.unwrap_or(ZERO_OID)
        ],
        None,
        LOCAL_TIMEOUT,
        OUTPUT_CAP,
    )?;
    if out.ok() {
        return Ok(());
    }
    let lower = out.stderr.to_ascii_lowercase();
    if lower.contains("but expected")
        || lower.contains("reference already exists")
        || lower.contains("unable to resolve reference")
        || lower.contains("is at ")
    {
        return Err(refusal("head-moved", "The branch moved while Draft Canvas was committing, so nothing was changed. Try again."));
    }
    Err(failure_of(&out))
}

fn tree_of(git: &Git, repo: &ProjectRepo, commit: &str) -> Result<String> {
    resolve(git, repo, &format!("{commit}^{{tree}}"))?
        .ok_or_else(|| HistoryError::corrupt("A commit of the repository could not be read."))
}

/// Builds a commit of `parent`'s tree with the diagram replaced by `blob`; `None` when that tree
/// is `parent`'s own (nothing to commit).
fn diagram_commit(
    git: &Git,
    repo: &ProjectRepo,
    parent: Option<&str>,
    blob: &str,
    message: &str,
) -> Result<Option<String>> {
    let base = match parent {
        Some(p) => Some(tree_of(git, repo, p)?),
        None => None,
    };
    let parts: Vec<&str> = repo.rel_path.split('/').collect();
    let tree = replace_path(git, repo, base.as_deref(), &parts, blob)?;
    if base.as_deref() == Some(tree.as_str()) {
        return Ok(None);
    }
    commit_tree(git, repo, &tree, parent, message).map(Some)
}

/// The attributes that change bytes on commit, as `check-attr` reports them for the diagram.
fn conversions(git: &Git, repo: &ProjectRepo, bytes: &[u8]) -> Result<(bool, bool)> {
    let out = git.local(
        &repo.place(),
        &args![
            "check-attr",
            "-z",
            "filter",
            "eol",
            "text",
            "working-tree-encoding",
            "ident",
            "--",
            &repo.rel_path
        ],
        None,
    )?;
    let fields: Vec<&[u8]> = out.split(|b| *b == 0).collect();
    let mut filter = false;
    let mut converts = false;
    for triple in fields.chunks(3) {
        let [_, attr, value] = triple else { continue };
        let value = String::from_utf8_lossy(value);
        let set = value != "unspecified" && value != "unset";
        match &**attr {
            b"filter" | b"working-tree-encoding" if set => filter = true,
            b"text" | b"eol" if set && value != "false" => {
                // Converting line ends on commit only ever turns CRLF into LF.
                if bytes.contains(&b'\r') {
                    converts = true;
                }
            }
            b"ident" if set && bytes.windows(3).any(|w| w == b"$Id") => converts = true,
            _ => {}
        }
    }
    Ok((filter, converts))
}

/// HEAD's branch (without `refs/heads/`) or `None` when detached.
fn head_branch(git: &Git, repo: &ProjectRepo) -> Result<Option<String>> {
    let out = git.run(
        &repo.place(),
        &args!["symbolic-ref", "-q", "HEAD"],
        None,
        LOCAL_TIMEOUT,
        OUTPUT_CAP,
    )?;
    if !out.ok() {
        return Ok(None);
    }
    Ok(out.text().strip_prefix("refs/heads/").map(str::to_string))
}

struct IndexEntry {
    mode: String,
    oid: String,
    stage: String,
    skip_worktree: bool,
}

fn index_entry(git: &Git, repo: &ProjectRepo) -> Result<Option<IndexEntry>> {
    let out = git.local(
        &repo.place(),
        &args!["ls-files", "-v", "-s", "-z", "--", &repo.rel_path],
        None,
    )?;
    let Some(record) = out.split(|b| *b == 0).find(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(record);
    let (head, _) = text.split_once('\t').unwrap_or((&text, ""));
    let mut fields = head.split(' ');
    let (Some(tag), Some(mode), Some(oid), Some(stage)) =
        (fields.next(), fields.next(), fields.next(), fields.next())
    else {
        return Ok(None);
    };
    Ok(Some(IndexEntry {
        skip_worktree: tag == "S" || tag == "s",
        mode: mode.to_string(),
        oid: oid.to_string(),
        stage: stage.to_string(),
    }))
}

fn head_entry(git: &Git, repo: &ProjectRepo, head: &str) -> Result<Option<TreeEntry>> {
    let out = git.local(
        &repo.place(),
        &args!["ls-tree", "-z", "--full-tree", head, "--", &repo.rel_path],
        None,
    )?;
    Ok(parse_tree(&out)?.into_iter().next())
}

fn state_flags(git_dir: &Path) -> [bool; 5] {
    let has = |name: &str| git_dir.join(name).exists();
    [
        has("MERGE_HEAD"),
        has("rebase-merge") || has("rebase-apply"),
        has("CHERRY_PICK_HEAD"),
        has("REVERT_HEAD"),
        has("BISECT_LOG"),
    ]
}

fn read_head_file(git_dir: &Path) -> Option<String> {
    read_small(&git_dir.join("HEAD"))?
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

/// Everything the page shows before offering to publish. When the configuration is refused, only
/// what can be read without running Git in the repository is filled in.
pub fn inspect(git: &Git, repo: &ProjectRepo) -> Result<ProjectRepoInfo> {
    let scan = scan_config(git, &repo.git_dir, &repo.common_dir)?;
    let [merging, rebasing, cherry_picking, reverting, bisecting] = state_flags(&repo.git_dir);
    let mut info = ProjectRepoInfo {
        root_name: repo
            .root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        branch: read_head_file(&repo.git_dir),
        rel_path: repo.rel_path.clone(),
        head_oid: None,
        merging,
        rebasing,
        cherry_picking,
        reverting,
        bisecting,
        path_staged: false,
        path_partially_staged: false,
        path_untracked: false,
        path_ignored: false,
        filtered: false,
        sparse_excluded: false,
        signing_required: false,
        has_origin: false,
        publish_branch: publish_branch_name(&repo.rel_path),
        config_refused: scan.refused.clone(),
        config_overridden: scan.overridden.clone(),
    };
    if scan.refused.is_some() {
        return Ok(info);
    }
    let bytes = read_file(&repo.file)?;
    let worktree = blob_id(&bytes);
    info.branch = head_branch(git, repo)?;
    info.head_oid = resolve(git, repo, "HEAD^{commit}")?;
    let head = match &info.head_oid {
        Some(h) => head_entry(git, repo, h)?,
        None => None,
    };
    match index_entry(git, repo)? {
        Some(entry) => {
            let differs_from_head = head
                .as_ref()
                .is_none_or(|h| h.oid != entry.oid || h.mode != entry.mode || entry.stage != "0");
            info.path_staged = differs_from_head;
            info.path_partially_staged = differs_from_head && entry.oid != worktree;
            info.sparse_excluded = entry.skip_worktree;
        }
        None => {
            info.path_untracked = true;
            let ignored = git.run(
                &repo.place(),
                &args!["check-ignore", "-q", "--", &repo.rel_path],
                None,
                LOCAL_TIMEOUT,
                OUTPUT_CAP,
            )?;
            info.path_ignored = ignored.code() == Some(0);
        }
    }
    let (filter, converts) = conversions(git, repo, &bytes)?;
    info.filtered = filter || converts;
    let signing = git.run(
        &repo.place(),
        &args!["config", "--type=bool", "--get", "commit.gpgsign"],
        None,
        LOCAL_TIMEOUT,
        OUTPUT_CAP,
    )?;
    info.signing_required = signing.ok() && signing.text() == "true";
    let origin = git.run(
        &repo.place(),
        &args!["config", "--get", "remote.origin.url"],
        None,
        LOCAL_TIMEOUT,
        OUTPUT_CAP,
    )?;
    info.has_origin = origin.ok();
    Ok(info)
}

/// Publishes the saved diagram to `draft-canvas/<path>`: on top of that branch if it exists, else
/// on HEAD's commit. HEAD, the index and the working tree are untouched.
pub fn publish_branch(git: &Git, repo: &ProjectRepo, message: &str) -> Result<Published> {
    let message = clean_message(message)?;
    require_scan(git, repo)?;
    let bytes = read_file(&repo.file)?;
    let (filter, _) = conversions(git, repo, &bytes)?;
    if filter {
        return Err(refusal("filtered", "This repository runs the diagram through a filter (such as Git LFS) when committing, which Draft Canvas doesn't do."));
    }
    let branch = publish_branch_name(&repo.rel_path);
    let name = format!("refs/heads/{branch}");
    if !is_safe_ref_name(&name) {
        return Err(HistoryError::invalid(
            "That diagram's path can't name a branch.",
        ));
    }
    let existing = resolve(git, repo, &format!("{name}^{{commit}}"))?;
    let head = resolve(git, repo, "HEAD^{commit}")?;
    let parent = existing.clone().or(head);
    let blob = write_blob(git, repo, &bytes)?;
    let Some(commit) = diagram_commit(git, repo, parent.as_deref(), &blob, &message)? else {
        return Ok(Published {
            branch,
            oid: parent.unwrap_or_default(),
            changed: false,
        });
    };
    update_ref(
        git,
        repo,
        &name,
        &commit,
        existing.as_deref(),
        "draft-canvas: publish diagram",
    )?;
    Ok(Published {
        branch,
        oid: commit,
        changed: true,
    })
}

/// Commits the saved diagram to HEAD's branch, only if HEAD is still `expected_head` and nothing
/// about the repository makes that surprising; each refusal names its reason so the page can offer
/// the branch of its own instead. Exactly one index entry changes; other staged changes stay staged.
pub fn commit_current(
    git: &Git,
    repo: &ProjectRepo,
    message: &str,
    expected_head: &str,
) -> Result<Published> {
    let message = clean_message(message)?;
    if !is_hex_oid(expected_head) {
        return Err(HistoryError::invalid("Not an object id."));
    }
    let info = inspect(git, repo)?;
    if let Some(refused) = &info.config_refused {
        return Err(unsupported(
            "config-refused",
            format!("Draft Canvas won't run Git in this repository because of its configuration ({refused})."),
        ));
    }
    let Some(branch) = info.branch.clone() else {
        return Err(refusal(
            "detached",
            "HEAD isn't on a branch, so there is no current branch to commit to.",
        ));
    };
    let Some(head) = info.head_oid.clone() else {
        return Err(refusal("no-commits", "This branch has no commits yet."));
    };
    if head != expected_head {
        return Err(refusal(
            "head-moved",
            "The branch has moved since you looked, so nothing was committed.",
        ));
    }
    if info.merging || info.rebasing || info.cherry_picking || info.reverting || info.bisecting {
        return Err(refusal(
            "operation-in-progress",
            "A merge, rebase, cherry-pick, revert or bisect is in progress in this repository.",
        ));
    }
    if info.path_partially_staged {
        return Err(refusal(
            "partially-staged",
            "Another version of this diagram is staged, which committing would lose.",
        ));
    }
    if info.filtered {
        return Err(refusal("filtered", "Git would change this diagram's bytes when committing (a filter, line-ending or encoding rule)."));
    }
    if info.sparse_excluded {
        return Err(refusal(
            "sparse",
            "This diagram is outside the repository's sparse checkout.",
        ));
    }
    if info.signing_required {
        return Err(refusal(
            "signing-required",
            "This repository signs its commits, which Draft Canvas doesn't do.",
        ));
    }
    let name = format!("refs/heads/{branch}");
    if !is_safe_ref_name(&name) {
        return Err(refusal(
            "detached",
            "HEAD's branch has a name Draft Canvas doesn't write to.",
        ));
    }
    let bytes = read_file(&repo.file)?;
    let blob = write_blob(git, repo, &bytes)?;
    let mode = head_entry(git, repo, &head)?
        .filter(|e| e.kind == "blob" && e.mode == "100755")
        .map_or("100644", |_| "100755");
    let Some(commit) = diagram_commit(git, repo, Some(&head), &blob, &message)? else {
        return Ok(Published {
            branch,
            oid: head,
            changed: false,
        });
    };
    update_ref(
        git,
        repo,
        &name,
        &commit,
        Some(&head),
        "draft-canvas: commit diagram",
    )?;
    let cacheinfo = format!("{mode},{blob},{}", repo.rel_path);
    // `--add`: a diagram that was untracked has no index entry to replace.
    let indexed = git.run(
        &repo.place(),
        &args!["update-index", "--add", "--cacheinfo", &cacheinfo],
        None,
        LOCAL_TIMEOUT,
        OUTPUT_CAP,
    );
    if !indexed.as_ref().is_ok_and(|out| out.ok()) {
        let index_state = if info.path_untracked {
            "Git's index doesn't list it yet, so `git status` shows it as deleted and your next commit would remove it"
        } else {
            "Git's index still holds the version from before, so `git status` shows the diagram as changed back"
        };
        return Err(HistoryError::new(
            Code::Unavailable,
            format!(
                "The commit {} is on {branch} with the diagram, but {index_state}. Your other staged changes are untouched. Stage {} (git add) to put things right.",
                &commit[..12],
                repo.rel_path
            ),
        )
        .with_reason("index-not-updated"));
    }
    Ok(Published {
        branch,
        oid: commit,
        changed: true,
    })
}

/// Only the diagram's own publish branch, or the branch HEAD is on, may be pushed from here.
fn require_pushable(git: &Git, repo: &ProjectRepo, branch: &str) -> Result<()> {
    if branch == publish_branch_name(&repo.rel_path)
        || head_branch(git, repo)?.as_deref() == Some(branch)
    {
        return Ok(());
    }
    Err(HistoryError::invalid(
        "Draft Canvas pushes only this diagram's own branch or the branch you're on.",
    )
    .with_reason("not-publishable"))
}

fn checked_branch(git: &Git, repo: &ProjectRepo, branch: &str) -> Result<(String, String)> {
    let name = format!("refs/heads/{branch}");
    if !is_safe_ref_name(&name) {
        return Err(HistoryError::invalid(
            "Not a branch name Draft Canvas publishes.",
        ));
    }
    let local = resolve(git, repo, &format!("{name}^{{commit}}"))?.ok_or_else(|| {
        HistoryError::not_found("That branch doesn't exist.").with_reason("missing-branch")
    })?;
    Ok((name, local))
}

/// What pushing `branch` would send: every commit no remote-tracking branch of `origin` has,
/// counted and listed, so commits other than the diagram's show before anything is published.
pub fn push_preview(git: &Git, repo: &ProjectRepo, branch: &str) -> Result<ProjectPushPreview> {
    require_scan(git, repo)?;
    require_pushable(git, repo, branch)?;
    checked_effective_urls(git, &repo.place(), true)?;
    let (name, local) = checked_branch(git, repo, branch)?;
    let remote = resolve(
        git,
        repo,
        &format!("refs/remotes/{ORIGIN}/{branch}^{{commit}}"),
    )?;
    let count = git.local(
        &repo.place(),
        &args![
            "rev-list",
            "--count",
            format!("--max-count={MAX_OUTGOING}"),
            &name,
            "--not",
            format!("--remotes={ORIGIN}")
        ],
        None,
    )?;
    let outgoing = String::from_utf8_lossy(&count)
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    let subjects = git.local(
        &repo.place(),
        &args![
            "rev-list",
            "--max-count=20",
            "--no-commit-header",
            "--format=%s",
            &name,
            "--not",
            format!("--remotes={ORIGIN}")
        ],
        None,
    )?;
    let fast_forward = match &remote {
        Some(r) => {
            let out = git.run(
                &repo.place(),
                &args!["merge-base", "--is-ancestor", r, &local],
                None,
                LOCAL_TIMEOUT,
                OUTPUT_CAP,
            )?;
            out.code() == Some(0)
        }
        None => true,
    };
    Ok(ProjectPushPreview {
        branch: branch.to_string(),
        local,
        remote,
        outgoing,
        subjects: String::from_utf8_lossy(&subjects)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(clean_subject)
            .collect(),
        fast_forward,
    })
}

/// Pushes exactly `refs/heads/<branch>` to the same name on the existing `origin`. Never forced.
pub fn push(git: &Git, repo: &ProjectRepo, branch: &str) -> Result<()> {
    require_scan(git, repo)?;
    require_pushable(git, repo, branch)?;
    checked_effective_urls(git, &repo.place(), true)?;
    let (name, _) = checked_branch(git, repo, branch)?;
    let out = git.network(
        &repo.place(),
        &args![
            "push",
            "--porcelain",
            "--no-verify",
            "--recurse-submodules=no",
            ORIGIN,
            format!("{name}:{name}")
        ],
    )?;
    push_result(&out)?;
    Ok(())
}
