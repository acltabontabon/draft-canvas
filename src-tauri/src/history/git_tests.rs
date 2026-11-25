//! The hardened `git` runner, history remotes and project-repository publishing, against real Git.
//!
//! Tests that run `git` need it on PATH. Locally they are skipped with a notice when it is missing;
//! under CI (`CI` set) a missing Git fails them. Remotes here are local bare repositories over
//! `file://`, which only a test build allows.

use super::gitcli::{
    acceptable_helper, classify, refused_key, run_raw, strip_userinfo, validate_remote_url,
    Failure, Git, RunError,
};
use super::project::{self, publish_branch_name, ProjectRepo};
use super::remote;
use super::*;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tempfile::TempDir;

// ---------------------------------------------------------------------------------------------
// Pure rules

#[test]
fn remote_urls_are_https_or_ssh_without_credentials_or_tricks() {
    let accepted = [
        (
            "https://github.com/acme/diagrams.git",
            "https://github.com/acme/diagrams.git",
        ),
        (
            "HTTPS://GitHub.com/acme/diagrams",
            "https://github.com/acme/diagrams",
        ),
        (
            "https://git.example.com:8443/a/b.git",
            "https://git.example.com:8443/a/b.git",
        ),
        ("https://[::1]/repo.git", "https://[::1]/repo.git"),
        ("https://host/a%20b.git", "https://host/a%20b.git"),
        (
            "ssh://git@github.com/acme/d.git",
            "ssh://git@github.com/acme/d.git",
        ),
        (
            "ssh://github.com:2222/acme/d.git",
            "ssh://github.com:2222/acme/d.git",
        ),
        (
            "ssh://git@[2001:db8::1]:22/x.git",
            "ssh://git@[2001:db8::1]:22/x.git",
        ),
        ("ssh://me@host/~me/repo.git", "ssh://me@host/~me/repo.git"),
        (
            "git@github.com:acme/diagrams.git",
            "git@github.com:acme/diagrams.git",
        ),
        (
            "deploy@Host.Example:repos/d.git",
            "deploy@host.example:repos/d.git",
        ),
    ];
    for (url, normalized) in accepted {
        assert_eq!(
            validate_remote_url(url, false).as_deref(),
            Ok(normalized),
            "{url}"
        );
    }
    let refused = [
        "",
        "https://user:token@github.com/acme/d.git",
        "https://token@github.com/acme/d.git",
        "https://github.com/acme/d.git?x=1",
        "https://github.com/acme/d.git#frag",
        "https://github.com/acme d.git",
        "https://github.com/acme/d.git\n",
        "https://github.com/acme/\td.git",
        "https://github.com\u{0}/x",
        "https://gіthub.com/acme/d.git", // Cyrillic і
        "https://github.com/acme/\u{202e}tig.d",
        "https://github.com",
        "https://github.com/",
        "https://github.com:0/a",
        "https://github.com:65536/a",
        "https://github.com:22a/a",
        "https://-oProxyCommand=calc/a",
        "https://github.com/../etc/passwd",
        "https://github.com/a/./b",
        "https://host/a\\b",
        "http://github.com/acme/d.git",
        "git://github.com/acme/d.git",
        "ftp://host/x",
        "file:///tmp/repo",
        "file://host/tmp/repo",
        "/tmp/repo",
        "C:\\repo",
        "../repo",
        "ext::sh -c touch% /tmp/pwned",
        "ext::sh",
        "fd::17",
        "fd::7,8",
        "transport::https://host/x",
        "-oProxyCommand=calc",
        "--upload-pack=touch /tmp/x",
        "ssh://-oProxyCommand=calc/x",
        "ssh://git@-oProxyCommand=calc/x",
        "ssh://-git@host/x",
        "ssh://git@host",
        "ssh://git@host:99999/x",
        "git@-host:acme/d.git",
        "git@host:-oProxyCommand=calc",
        "git@host:",
        "-git@host:x",
        "git@host:a b",
        "github.com:acme/d.git",
        "git@ho st:x",
        "git@[::1:x",
        "git@host:a?b",
    ];
    for url in refused {
        assert!(
            validate_remote_url(url, false).is_err(),
            "{url:?} was accepted"
        );
    }
    // `file://` only when a test build asks for it, and then only absolute.
    assert!(validate_remote_url("file:///C:/tmp/remote.git", true).is_ok());
    assert!(validate_remote_url("file://relative/x", true).is_err());
    assert!(validate_remote_url("file:///tmp/../x", true).is_err());
}

#[test]
fn dangerous_configuration_keys_are_recognised() {
    for key in [
        "core.sshcommand",
        "core.askpass",
        "core.gitproxy",
        "core.alternaterefscommand",
        "core.worktree",
        "credential.helper",
        "credential.https://example.com.helper",
        "credential.username",
        "filter.lfs.clean",
        "filter.x.process",
        "diff.x.textconv",
        "diff.x.command",
        "diff.external",
        "merge.x.driver",
        "gpg.program",
        "gpg.ssh.program",
        "gpg.x509.program",
        "include.path",
        "includeif.gitdir:/x/.path",
        "remote.origin.uploadpack",
        "remote.origin.receivepack",
        "remote.origin.vcs",
        "remote.origin.mirror",
        "uploadpack.packobjectshook",
        "url.https://evil.example/.insteadof",
        "url.ssh://evil/.pushinsteadof",
        "sendemail.smtp.helper",
    ] {
        assert!(refused_key(key).is_some(), "{key} was allowed");
    }
    for key in [
        "core.repositoryformatversion",
        "core.bare",
        "core.filemode",
        "core.logallrefupdates",
        "core.ignorecase",
        "core.hookspath",
        "core.fsmonitor",
        "remote.origin.url",
        "remote.origin.fetch",
        "branch.main.remote",
        "branch.main.merge",
        "user.name",
        "user.email",
        "commit.gpgsign",
        "diff.renames",
        "merge.conflictstyle",
        "lfs.repositoryformatversion",
    ] {
        assert!(refused_key(key).is_none(), "{key} was refused");
    }
}

#[test]
fn failures_are_classified_and_credentials_never_shown() {
    let cases = [
        ("fatal: Authentication failed for 'https://github.com/a/b.git/'", Failure::Auth),
        ("fatal: could not read Username for 'https://github.com': terminal prompts disabled", Failure::Auth),
        ("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", Failure::Auth),
        ("Host key verification failed.\nfatal: Could not read from remote repository.", Failure::HostKey),
        ("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", Failure::HostKey),
        ("fatal: unable to access 'https://x/': Could not resolve host: x", Failure::Offline),
        ("ssh: connect to host x port 22: Connection refused", Failure::Offline),
        (" ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs", Failure::RejectedNonFastForward),
        ("remote: error: GH006: Protected branch update failed for refs/heads/main.", Failure::ProtectedBranch),
        ("fatal: couldn't find remote ref refs/heads/main", Failure::MissingRemoteBranch),
        ("! [remote rejected] main (shallow update not allowed)", Failure::Shallow),
        ("error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429", Failure::RateLimited),
        ("*** Please tell me who you are.", Failure::Identity),
        ("fatal: Unable to create '/r/.git/index.lock': File exists.", Failure::Locked),
        ("fatal: something else entirely", Failure::Other),
    ];
    for (stderr, kind) in cases {
        assert_eq!(classify(stderr), kind, "{stderr}");
    }
    assert_eq!(
        strip_userinfo("fatal: unable to access 'https://me:ghp_secret@github.com/a.git/': 403"),
        "fatal: unable to access 'https://github.com/a.git/': 403"
    );
    let shown = Failure::Other.error(Some(&super::gitcli::sanitize_detail(
        "error: https://user:pw@host/x failed\u{1b}[31m\nfatal: ssh://tok@h/x bad",
    )));
    assert!(
        !shown.message.contains("pw@") && !shown.message.contains("tok@"),
        "{}",
        shown.message
    );
    assert!(!shown.message.contains('\u{1b}'));
    assert_eq!(shown.reason, Some("other"));
}

#[test]
fn only_known_or_absolute_existing_credential_helpers_are_kept() {
    for helper in [
        "manager",
        "manager-core",
        "osxkeychain",
        "cache --timeout=3600",
        "store --file=/x/.creds",
        "wincred",
        "libsecret",
    ] {
        assert!(acceptable_helper(helper), "{helper}");
    }
    let exe = std::env::current_exe().unwrap();
    assert!(acceptable_helper(
        &exe.to_string_lossy().replace(' ', "\\ ")
    ));
    for helper in [
        "!f() { cat /etc/passwd; }; f",
        "evil-helper",
        "./relative-helper",
        "manager; rm -rf /",
        "cache --timeout=$(id)",
        "/definitely/not/a/helper/here",
        "manager `id`",
    ] {
        assert!(!acceptable_helper(helper), "{helper}");
    }
}

#[test]
fn publish_branches_are_named_safely_from_the_path() {
    assert_eq!(
        publish_branch_name("docs/arch/payments.draftcanvas"),
        "draft-canvas/docs-arch-payments"
    );
    assert_eq!(
        publish_branch_name("Payments.DraftCanvas"),
        "draft-canvas/Payments"
    );
    assert_eq!(
        publish_branch_name("a b/ü/x..y.lock.draftcanvas"),
        "draft-canvas/a-b-x.y"
    );
    assert_eq!(
        publish_branch_name(".hidden/-x.draftcanvas"),
        "draft-canvas/hidden-x"
    );
    for rel in [
        "docs/arch/payments.draftcanvas",
        "..lock.draftcanvas",
        "@{x}.draftcanvas",
        "~^:?*[.draftcanvas",
    ] {
        let name = format!("refs/heads/{}", publish_branch_name(rel));
        assert!(is_safe_ref_name(&name), "{name}");
    }
}

#[test]
fn a_timed_out_run_kills_the_whole_process_tree() {
    // A parent that starts a child holding the output pipes, and outlives the timeout.
    let mut command = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "ping", "-n", "60", "127.0.0.1"]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", "sleep 60 & sleep 60"]);
        c
    };
    let started = Instant::now();
    let result = run_raw(
        &mut command,
        None,
        Duration::from_millis(800),
        1024 * 1024,
        None,
    );
    match result {
        Err(RunError::Timeout { pipes_closed }) => {
            assert!(
                pipes_closed,
                "a child of the timed-out process kept its pipes open"
            );
        }
        Err(other) => panic!("expected a timeout, got {other:?}"),
        Ok(_) => panic!("expected a timeout"),
    }
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn output_beyond_the_cap_is_refused() {
    let mut command = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args([
            "/C",
            "for /L %i in (1,1,5000) do @echo 0123456789012345678901234567890123456789",
        ]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", "i=0; while [ $i -lt 5000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done"]);
        c
    };
    let result = run_raw(&mut command, None, Duration::from_secs(30), 4096, None);
    assert!(
        matches!(result, Err(RunError::Overflow)),
        "{:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------------------------
// Real Git

struct Sandbox {
    dir: TempDir,
}

/// A temp folder, and a check that Git is there (failing under CI if it is not).
fn sandbox() -> Option<Sandbox> {
    let dir = tempfile::tempdir().unwrap();
    match Git::discover(&dir.path().join("probe")) {
        Ok(_) => Some(Sandbox { dir }),
        Err(missing) => {
            assert!(
                std::env::var_os("CI").is_none(),
                "Git is required for the history remote tests in CI: {}",
                missing.reason
            );
            eprintln!(
                "[history] git unavailable ({}): remote test skipped locally.",
                missing.reason
            );
            None
        }
    }
}

impl Sandbox {
    fn path(&self, rel: &str) -> PathBuf {
        let path = self.dir.path().join(rel);
        fs::create_dir_all(&path).unwrap();
        dunce::canonicalize(path).unwrap()
    }

    /// The runner under test, allowed `file://` remotes.
    fn git(&self, name: &str) -> Git {
        let mut git = Git::discover(&self.path(name)).unwrap();
        git.allow_file = true;
        git
    }

    /// Plain Git for setting things up and looking at results: no system or global
    /// configuration, no hooks (they must only ever be the code under test's to run, and never are).
    fn sh_out(&self, cwd: &Path, args: &[&str], input: Option<&[u8]>) -> std::process::Output {
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let hooks = self.path("setup-no-hooks");
        let mut command = Command::new("git");
        command
            .arg("-c")
            .arg(format!("core.hooksPath={}", hooks.display()))
            .args([
                "-c",
                "init.defaultBranch=main",
                "-c",
                "core.autocrlf=false",
                "-c",
                "protocol.file.allow=always",
            ])
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", null)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@draftcanvas.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@draftcanvas.invalid")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().expect("git runs");
        {
            use std::io::Write;
            let mut stdin = child.stdin.take().unwrap();
            if let Some(input) = input {
                stdin.write_all(input).unwrap();
            }
        }
        child.wait_with_output().unwrap()
    }

    fn sh(&self, cwd: &Path, args: &[&str]) -> String {
        let out = self.sh_out(cwd, args, None);
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout)
            .unwrap()
            .trim_end()
            .to_string()
    }

    /// A project repository: one commit holding the diagram and two source files.
    fn project(&self, name: &str) -> (PathBuf, PathBuf) {
        let root = self.path(name);
        self.sh(&root, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Person"),
            ("user.email", "person@example.invalid"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            self.sh(&root, &["config", key, value]);
        }
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("docs/a.draftcanvas"), "{\"v\":1}\n").unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("README.md"), "# Project\n").unwrap();
        self.sh(&root, &["add", "."]);
        self.sh(&root, &["commit", "-q", "-m", "Initial"]);
        let file = dunce::canonicalize(root.join("docs/a.draftcanvas")).unwrap();
        (root, file)
    }

    fn repo(&self, file: &Path) -> ProjectRepo {
        project::discover_below(file, None)
            .unwrap()
            .expect("inside a repository")
    }

    fn bare(&self, name: &str) -> PathBuf {
        let dir = self.path(name);
        self.sh(&dir, &["init", "-q", "--bare"]);
        dir
    }
}

fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

/// Hooks that would leave `marker` behind if Git ever ran them.
fn install_hooks(dir: &Path, marker: &Path) {
    fs::create_dir_all(dir).unwrap();
    let script = format!(
        "#!/bin/sh\necho \"$0\" >> \"{}\"\n",
        marker.to_string_lossy().replace('\\', "/")
    );
    for hook in [
        "pre-commit",
        "commit-msg",
        "post-commit",
        "pre-push",
        "post-checkout",
        "post-index-change",
        "reference-transaction",
        "pre-receive",
        "update",
        "post-receive",
        "post-update",
        "push-to-checkout",
    ] {
        let path = dir.join(hook);
        fs::write(&path, &script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn reason(result: Result<impl std::fmt::Debug>) -> &'static str {
    match result {
        Ok(value) => panic!("expected a refusal, got {value:?}"),
        Err(e) => e
            .reason
            .unwrap_or_else(|| panic!("no reason: {}", e.message)),
    }
}

#[test]
fn git_is_found_by_absolute_path_and_reports_its_version() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");
    assert!(super::gitcli::parse_version(git.version())
        .is_some_and(|v| v >= super::gitcli::MIN_VERSION));
    for helper in git.helpers() {
        assert!(acceptable_helper(helper), "{helper}");
    }
    let history = History::new(sb.path("history"));
    history.set_git(sb.git("run2"));
    let status = remote::git_status(&history);
    assert!(status.available && status.version.is_some(), "{status:?}");
}

// --- Configuration scan -------------------------------------------------------------------------

#[test]
fn a_project_whose_configuration_runs_programs_is_refused() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");
    let (root, file) = sb.project("p");
    let repo = sb.repo(&file);
    let marker = sb.dir.path().join("ran.txt");
    let evil = format!(
        "sh -c 'echo ran > \"{}\"'",
        marker.to_string_lossy().replace('\\', "/")
    );
    let keys = [
        "core.sshCommand",
        "core.askPass",
        "core.gitProxy",
        "core.alternateRefsCommand",
        "credential.helper",
        "credential.https://example.com.helper",
        "filter.x.clean",
        "filter.x.smudge",
        "diff.x.textconv",
        "diff.x.command",
        "merge.x.driver",
        "gpg.program",
        "gpg.ssh.program",
        "include.path",
        "includeIf.gitdir:/elsewhere/.path",
        "remote.origin.uploadpack",
        "remote.origin.receivepack",
        "remote.origin.vcs",
        "uploadpack.packObjectsHook",
        "url.https://evil.example/.insteadOf",
        "url.https://evil.example/.pushInsteadOf",
    ];
    let head = sb.sh(&root, &["rev-parse", "HEAD"]);
    // Written as a plain file: Git itself won't start in a repository with a broken include.
    let config = root.join(".git/config").to_string_lossy().into_owned();
    let outside = sb.path("outside");
    for key in keys {
        sb.sh(&outside, &["config", "--file", &config, key, &evil]);
        let info = project::inspect(&git, &repo).unwrap();
        let refused = info
            .config_refused
            .unwrap_or_else(|| panic!("{key} was not refused"));
        assert!(
            refused
                .to_ascii_lowercase()
                .starts_with(&key.to_ascii_lowercase()),
            "{refused}"
        );
        assert_eq!(
            reason(project::publish_branch(&git, &repo, "Publish")),
            "config-refused",
            "{key}"
        );
        assert_eq!(
            reason(project::commit_current(&git, &repo, "Commit", &head)),
            "config-refused",
            "{key}"
        );
        sb.sh(&outside, &["config", "--file", &config, "--unset-all", key]);
    }
    assert!(!marker.exists(), "a configured program ran");
    // Settings Draft Canvas overrides anyway are reported, not refused.
    sb.sh(&root, &["config", "core.hooksPath", "elsewhere"]);
    let info = project::inspect(&git, &repo).unwrap();
    assert_eq!(info.config_refused, None);
    assert_eq!(info.config_overridden, vec!["core.hookspath".to_string()]);
    sb.sh(&root, &["config", "--unset", "core.hooksPath"]);
    // Borrowed objects.
    let alternates = root.join(".git/objects/info/alternates");
    fs::write(&alternates, "/elsewhere/objects\n").unwrap();
    assert!(project::inspect(&git, &repo)
        .unwrap()
        .config_refused
        .unwrap()
        .contains("alternates"));
    assert_eq!(
        reason(project::publish_branch(&git, &repo, "Publish")),
        "config-refused"
    );
    fs::remove_file(alternates).unwrap();
    assert_eq!(project::inspect(&git, &repo).unwrap().config_refused, None);
}

#[test]
fn a_filtered_diagram_is_flagged_and_its_filter_config_refused() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");
    let (root, file) = sb.project("p");
    fs::write(root.join(".gitattributes"), "*.draftcanvas filter=x\n").unwrap();
    sb.sh(&root, &["add", ".gitattributes"]);
    sb.sh(&root, &["commit", "-q", "-m", "Attributes"]);
    let repo = sb.repo(&file);
    let info = project::inspect(&git, &repo).unwrap();
    assert!(info.filtered && info.config_refused.is_none(), "{info:?}");
    let head = info.head_oid.clone().unwrap();
    fs::write(&file, "{\"v\":2}\n").unwrap();
    assert_eq!(
        reason(project::commit_current(&git, &repo, "Commit", &head)),
        "filtered"
    );
    assert_eq!(
        reason(project::publish_branch(&git, &repo, "Publish")),
        "filtered"
    );
    let marker = sb.dir.path().join("filtered.txt");
    let clean = format!(
        "sh -c 'echo ran > \"{}\"; cat'",
        marker.to_string_lossy().replace('\\', "/")
    );
    sb.sh(&root, &["config", "filter.x.clean", &clean]);
    assert!(project::inspect(&git, &repo)
        .unwrap()
        .config_refused
        .is_some());
    assert_eq!(
        reason(project::publish_branch(&git, &repo, "Publish")),
        "config-refused"
    );
    assert!(!marker.exists());
    // Line-end rules only matter when the file has CRLF in it.
    sb.sh(&root, &["config", "--unset", "filter.x.clean"]);
    fs::write(root.join(".gitattributes"), "* text=auto\n").unwrap();
    assert!(!project::inspect(&git, &repo).unwrap().filtered);
    fs::write(&file, "{\"v\":2}\r\n").unwrap();
    assert!(project::inspect(&git, &repo).unwrap().filtered);
}

#[test]
fn a_diagram_in_a_submodule_or_dot_git_is_not_published() {
    let Some(sb) = sandbox() else { return };
    let (root, _) = sb.project("p");
    // A .git file pointing anywhere but a linked worktree of its own repository.
    let sub = sb.path("p/vendor/sub");
    fs::write(
        sub.join(".git"),
        format!("gitdir: {}\n", root.join(".git").display()),
    )
    .unwrap();
    fs::write(sub.join("x.draftcanvas"), "{}").unwrap();
    let file = dunce::canonicalize(sub.join("x.draftcanvas")).unwrap();
    assert_eq!(
        project::discover_below(&file, None).unwrap_err().reason,
        Some("submodule")
    );
    // Inside the git dir itself: not a working-tree file at all.
    fs::write(root.join(".git/x.draftcanvas"), "{}").unwrap();
    let inside = dunce::canonicalize(root.join(".git/x.draftcanvas")).unwrap();
    assert!(project::discover_below(&inside, None).unwrap().is_none());
    // A linked worktree is followed to its repository.
    let linked = sb.dir.path().join("linked");
    sb.sh(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "side",
            &linked.to_string_lossy(),
        ],
    );
    let linked_file = dunce::canonicalize(linked.join("docs/a.draftcanvas")).unwrap();
    let repo = project::discover_below(&linked_file, None)
        .unwrap()
        .unwrap();
    assert_eq!(repo.rel_path, "docs/a.draftcanvas");
    assert_eq!(
        repo.common_dir,
        dunce::canonicalize(root.join(".git")).unwrap()
    );
    let git = sb.git("run");
    assert_eq!(
        project::inspect(&git, &repo).unwrap().branch.as_deref(),
        Some("side")
    );
}

// --- Publishing into a project ------------------------------------------------------------------

#[test]
fn publishing_to_a_branch_of_its_own_leaves_head_index_and_work_tree_alone() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");
    let (root, file) = sb.project("p");
    fs::write(&file, "{\"v\":2}\n").unwrap();
    fs::write(root.join("src/main.rs"), "fn main() { staged(); }\n").unwrap();
    sb.sh(&root, &["add", "src/main.rs"]);
    fs::write(root.join("README.md"), "# Project, unstaged\n").unwrap();
    fs::write(root.join("new.txt"), "untracked\n").unwrap();
    let status = |sb: &Sandbox| {
        sb.sh_out(
            &root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            None,
        )
        .stdout
    };
    let before = (
        status(&sb),
        sb.sh(&root, &["ls-files", "-s"]),
        sb.sh(&root, &["rev-parse", "HEAD"]),
        sb.sh(&root, &["symbolic-ref", "HEAD"]),
    );

    let repo = sb.repo(&file);
    let first = project::publish_branch(&git, &repo, "Update the payments diagram").unwrap();
    assert!(first.changed);
    assert_eq!(first.branch, "draft-canvas/docs-a");
    let after = (
        status(&sb),
        sb.sh(&root, &["ls-files", "-s"]),
        sb.sh(&root, &["rev-parse", "HEAD"]),
        sb.sh(&root, &["symbolic-ref", "HEAD"]),
    );
    assert_eq!(before, after, "HEAD, index or working tree changed");

    let head = before.2.clone();
    assert_eq!(
        sb.sh(&root, &["rev-parse", "refs/heads/draft-canvas/docs-a"]),
        first.oid
    );
    assert_eq!(
        sb.sh(&root, &["rev-parse", &format!("{}^", first.oid)]),
        head
    );
    assert_eq!(
        sb.sh(
            &root,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                &head,
                &first.oid
            ]
        ),
        "docs/a.draftcanvas"
    );
    assert_eq!(
        sb.sh(
            &root,
            &["show", &format!("{}:docs/a.draftcanvas", first.oid)]
        ),
        "{\"v\":2}"
    );
    assert_eq!(
        sb.sh(&root, &["log", "-1", "--format=%s", &first.oid]),
        "Update the payments diagram"
    );

    // The next publish builds on the branch, not on HEAD; publishing the same bytes writes nothing.
    fs::write(&file, "{\"v\":3}\n").unwrap();
    let second = project::publish_branch(&git, &repo, "Again").unwrap();
    assert_eq!(
        sb.sh(&root, &["rev-parse", &format!("{}^", second.oid)]),
        first.oid
    );
    let same = project::publish_branch(&git, &repo, "Again").unwrap();
    assert!(!same.changed);
    assert_eq!(same.oid, second.oid);
    assert_eq!(before.2, sb.sh(&root, &["rev-parse", "HEAD"]));
    assert_eq!(sb.sh(&root, &["fsck", "--no-progress"]), "");
}

#[test]
fn committing_to_the_current_branch_keeps_other_staged_changes_staged() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");
    let (root, file) = sb.project("p");
    fs::write(root.join("src/main.rs"), "fn main() { staged(); }\n").unwrap();
    sb.sh(&root, &["add", "src/main.rs"]);
    fs::write(root.join("README.md"), "# Project, unstaged\n").unwrap();
    fs::write(&file, "{\"v\":2}\n").unwrap();
    let repo = sb.repo(&file);
    let info = project::inspect(&git, &repo).unwrap();
    assert_eq!(info.branch.as_deref(), Some("main"));
    assert!(!info.path_staged && !info.path_partially_staged && !info.path_untracked);
    let head = info.head_oid.unwrap();

    let done = project::commit_current(&git, &repo, "Diagram: add the queue", &head).unwrap();
    assert!(done.changed);
    assert_eq!(done.branch, "main");
    assert_eq!(sb.sh(&root, &["rev-parse", "HEAD"]), done.oid);
    assert_eq!(sb.sh(&root, &["rev-parse", "HEAD^"]), head);
    assert_eq!(
        sb.sh(
            &root,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]
        ),
        "docs/a.draftcanvas"
    );
    assert_eq!(
        sb.sh(&root, &["diff", "--cached", "--name-only"]),
        "src/main.rs",
        "the other staged change"
    );
    assert_eq!(sb.sh(&root, &["show", "HEAD:src/main.rs"]), "fn main() {}");
    assert_eq!(
        sb.sh(
            &root,
            &["status", "--porcelain", "--", "docs/a.draftcanvas"]
        ),
        ""
    );
    assert_eq!(
        sb.sh(&root, &["status", "--porcelain", "--", "README.md"]),
        " M README.md"
    );
}

#[test]
fn committing_to_the_current_branch_refuses_whatever_would_surprise() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");

    // Partially staged: a different version of the diagram is staged.
    let (root, file) = sb.project("partial");
    fs::write(&file, "{\"v\":2}\n").unwrap();
    sb.sh(&root, &["add", "docs/a.draftcanvas"]);
    fs::write(&file, "{\"v\":3}\n").unwrap();
    let repo = sb.repo(&file);
    let info = project::inspect(&git, &repo).unwrap();
    assert!(info.path_staged && info.path_partially_staged);
    let head = info.head_oid.unwrap();
    assert_eq!(
        reason(project::commit_current(&git, &repo, "x", &head)),
        "partially-staged"
    );
    // Staged exactly as on disk is fine to commit over.
    sb.sh(&root, &["add", "docs/a.draftcanvas"]);
    assert!(
        project::commit_current(&git, &repo, "x", &head)
            .unwrap()
            .changed
    );

    // HEAD moved since the page looked.
    let (root, file) = sb.project("moved");
    let repo = sb.repo(&file);
    let stale = sb.sh(&root, &["rev-parse", "HEAD"]);
    fs::write(root.join("src/main.rs"), "fn main() { moved(); }\n").unwrap();
    sb.sh(&root, &["commit", "-q", "-am", "Moved on"]);
    fs::write(&file, "{\"v\":2}\n").unwrap();
    assert_eq!(
        reason(project::commit_current(&git, &repo, "x", &stale)),
        "head-moved"
    );

    // A merge in progress.
    let (root, file) = sb.project("merging");
    let repo = sb.repo(&file);
    let head = sb.sh(&root, &["rev-parse", "HEAD"]);
    fs::write(root.join(".git/MERGE_HEAD"), format!("{head}\n")).unwrap();
    fs::write(&file, "{\"v\":2}\n").unwrap();
    assert!(project::inspect(&git, &repo).unwrap().merging);
    assert_eq!(
        reason(project::commit_current(&git, &repo, "x", &head)),
        "operation-in-progress"
    );

    // Detached HEAD.
    let (root, file) = sb.project("detached");
    sb.sh(&root, &["checkout", "-q", "--detach"]);
    let repo = sb.repo(&file);
    let head = sb.sh(&root, &["rev-parse", "HEAD"]);
    fs::write(&file, "{\"v\":2}\n").unwrap();
    assert_eq!(project::inspect(&git, &repo).unwrap().branch, None);
    assert_eq!(
        reason(project::commit_current(&git, &repo, "x", &head)),
        "detached"
    );
    // The isolated branch is still offered.
    assert!(project::publish_branch(&git, &repo, "x").unwrap().changed);

    // Signing required.
    let (root, file) = sb.project("signing");
    sb.sh(&root, &["config", "commit.gpgsign", "true"]);
    let repo = sb.repo(&file);
    let head = sb.sh(&root, &["rev-parse", "HEAD"]);
    fs::write(&file, "{\"v\":2}\n").unwrap();
    assert_eq!(
        reason(project::commit_current(&git, &repo, "x", &head)),
        "signing-required"
    );

    // Sparse: the diagram is skip-worktree.
    let (root, file) = sb.project("sparse");
    sb.sh(
        &root,
        &["update-index", "--skip-worktree", "docs/a.draftcanvas"],
    );
    let repo = sb.repo(&file);
    let head = sb.sh(&root, &["rev-parse", "HEAD"]);
    assert_eq!(
        reason(project::commit_current(&git, &repo, "x", &head)),
        "sparse"
    );
}

#[test]
fn no_hook_ever_runs_when_publishing_or_pushing() {
    let Some(sb) = sandbox() else { return };
    let git = sb.git("run");
    let (root, file) = sb.project("p");
    let marker = sb.dir.path().join("hook-ran.txt");
    install_hooks(&root.join(".git/hooks"), &marker);
    // A remote's own receive hooks are the server's business and run there; over the test-only
    // `file://` transport that "server" is a local `git receive-pack`, so they get a marker of their own.
    let served = sb.dir.path().join("served.txt");
    let remote = sb.bare("remote.git");
    install_hooks(&remote.join("hooks"), &served);
    sb.sh(&root, &["remote", "add", "origin", &file_url(&remote)]);
    let repo = sb.repo(&file);

    fs::write(&file, "{\"v\":2}\n").unwrap();
    let published = project::publish_branch(&git, &repo, "Publish").unwrap();
    let preview = project::push_preview(&git, &repo, &published.branch).unwrap();
    assert_eq!(preview.outgoing, 2, "{preview:?}");
    assert_eq!(
        preview.subjects,
        vec!["Publish".to_string(), "Initial".to_string()]
    );
    assert!(preview.fast_forward && preview.remote.is_none());
    project::push(&git, &repo, &published.branch).unwrap();
    assert_eq!(
        sb.sh(
            &remote,
            &["rev-parse", &format!("refs/heads/{}", published.branch)]
        ),
        published.oid
    );
    let head = sb.sh(&root, &["rev-parse", "HEAD"]);
    fs::write(&file, "{\"v\":3}\n").unwrap();
    project::commit_current(&git, &repo, "Commit", &head).unwrap();
    project::push(&git, &repo, "main").unwrap();
    // Hooks named by the repository's own configuration don't run either.
    let elsewhere = root.join("my-hooks");
    install_hooks(&elsewhere, &marker);
    sb.sh(&root, &["config", "core.hooksPath", "my-hooks"]);
    fs::write(&file, "{\"v\":4}\n").unwrap();
    project::publish_branch(&git, &repo, "Again").unwrap();

    // The managed side: a history pushed to a remote with every hook installed.
    let history = History::new(sb.path("history"));
    history.set_git(sb.git("run2"));
    let repo = history
        .create(&history_meta("h1"))
        .and_then(|()| history.open_writable("h1"))
        .unwrap();
    let tip = snapshot(&repo, "{}", &[], 1);
    move_ref(&repo, "refs/heads/main", None, &tip);
    let managed_remote = sb.bare("managed-remote.git");
    install_hooks(&managed_remote.join("hooks"), &served);
    install_hooks(&history.root().join("h1.git").join("hooks"), &marker);
    remote::remote_set(&history, &git, "h1", &file_url(&managed_remote)).unwrap();
    remote::push(&history, &git, "h1", &["refs/heads/main".to_string()]).unwrap();
    remote::fetch(&history, &git, "h1").unwrap();
    assert!(
        !marker.exists(),
        "a hook ran: {:?}",
        fs::read_to_string(&marker)
    );
    let receive = [
        "pre-receive",
        "update",
        "post-receive",
        "post-update",
        "reference-transaction",
    ];
    for line in fs::read_to_string(&served).unwrap_or_default().lines() {
        assert!(
            receive.iter().any(|h| line.ends_with(h)),
            "{line} ran on the pushing side"
        );
    }
}

// --- History remotes ----------------------------------------------------------------------------

fn history_meta(id: &str) -> serde_json::Value {
    json!({ "repoId": id, "documentId": "d", "title": "T", "createdAt": 1, "alternatives": [] })
}

fn sig(time: i64) -> Signature {
    Signature {
        name: "Fixture".into(),
        email: "fixture@draftcanvas.invalid".into(),
        timestamp: time,
        timezone_offset: 0,
    }
}

fn snapshot(repo: &super::store::Repo, text: &str, parents: &[&str], time: i64) -> String {
    repo.write_snapshot(
        text.as_bytes(),
        &SnapshotHead {
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: sig(time),
            committer: sig(time),
            message: format!("Revision at {time}"),
        },
    )
    .unwrap()
}

fn move_ref(repo: &super::store::Repo, name: &str, expected: Option<&str>, next: &str) {
    let result = repo
        .update_ref(&RefUpdate {
            name: name.into(),
            expected: expected.map(str::to_string),
            next: Some(next.to_string()),
        })
        .unwrap();
    assert!(result.ok);
}

#[test]
fn a_history_round_trips_through_a_remote_and_never_overwrites_it() {
    let Some(sb) = sandbox() else { return };
    let history = History::new(sb.path("history"));
    history.set_git(sb.git("run"));
    let git = history.git().unwrap();
    let remote_dir = sb.bare("remote.git");
    let url = file_url(&remote_dir);

    history.create(&history_meta("alpha")).unwrap();
    let alpha = history.open_writable("alpha").unwrap();
    let one = snapshot(&alpha, "{\"v\":1}", &[], 100);
    let two = snapshot(&alpha, "{\"v\":2}", &[&one], 200);
    move_ref(&alpha, "refs/heads/main", None, &two);
    let alt = snapshot(&alpha, "{\"v\":\"alt\"}", &[&one], 150);
    move_ref(&alpha, "refs/heads/alt/a1", None, &alt);
    alpha
        .write_tag(&TagWrite {
            name_ref: "refs/tags/milestone/m1".into(),
            target: one.clone(),
            name: "milestone/m1".into(),
            tagger: sig(120),
            message: "First".into(),
        })
        .unwrap();

    assert_eq!(
        remote::remote_set(&history, &git, "alpha", &url).unwrap(),
        url
    );
    // Not a URL, not a ref this history publishes.
    assert_eq!(
        reason(remote::remote_set(&history, &git, "alpha", "ext::sh -c id")),
        "invalid-url"
    );
    let refs = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
    assert_eq!(
        reason(remote::push(
            &history,
            &git,
            "alpha",
            &refs(&["refs/heads/archive/x"])
        )),
        "not-publishable"
    );
    assert_eq!(
        reason(remote::push_preview(
            &history,
            "alpha",
            &refs(&["refs/draft-canvas/x"])
        )),
        "not-publishable"
    );

    let preview = remote::push_preview(
        &history,
        "alpha",
        &refs(&["refs/heads/main", "refs/tags/milestone/m1"]),
    )
    .unwrap();
    assert_eq!(preview[0].outgoing, 2);
    assert_eq!(
        preview[0].subjects,
        vec!["Revision at 200", "Revision at 100"]
    );
    assert!(preview[0].fast_forward && preview[0].remote.is_none());
    let pushed = remote::push(
        &history,
        &git,
        "alpha",
        &refs(&[
            "refs/heads/main",
            "refs/heads/alt/a1",
            "refs/tags/milestone/m1",
        ]),
    )
    .unwrap();
    assert_eq!(pushed.len(), 3);
    assert_eq!(sb.sh(&remote_dir, &["rev-parse", "refs/heads/main"]), two);
    assert_eq!(
        sb.sh(
            &remote_dir,
            &["rev-parse", "refs/tags/milestone/m1^{commit}"]
        ),
        one
    );
    assert_eq!(
        alpha
            .read_ref("refs/remotes/origin/main")
            .unwrap()
            .as_deref(),
        Some(two.as_str())
    );
    let again = remote::push_preview(&history, "alpha", &refs(&["refs/heads/main"])).unwrap();
    assert!(again[0].up_to_date && again[0].outgoing == 0);

    // A second device's copy of the same history fetches it.
    history.create(&history_meta("beta")).unwrap();
    remote::remote_set(&history, &git, "beta", &url).unwrap();
    let fetched = remote::fetch(&history, &git, "beta").unwrap();
    let names: Vec<&str> = fetched.refs.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["refs/remotes/origin/alt/a1", "refs/remotes/origin/main"]
    );
    let main = fetched
        .branches
        .iter()
        .find(|b| b.branch == "refs/heads/main")
        .unwrap();
    assert_eq!(
        (
            main.local.as_deref(),
            main.remote.as_deref(),
            main.ahead,
            main.behind
        ),
        (None, Some(two.as_str()), 0, 2)
    );
    let beta = history.open_writable("beta").unwrap();
    assert!(
        beta.list_refs("refs/draft-canvas").unwrap().is_empty(),
        "the holding namespace is emptied"
    );
    assert!(
        beta.list_refs("refs/tags").unwrap().is_empty(),
        "tags are never fetched"
    );

    // Beta records something else on main: publishing it would overwrite alpha's work.
    let other = snapshot(&beta, "{\"v\":\"beta\"}", &[], 300);
    move_ref(&beta, "refs/heads/main", None, &other);
    let preview = remote::push_preview(&history, "beta", &refs(&["refs/heads/main"])).unwrap();
    assert!(!preview[0].fast_forward);
    assert_eq!(
        reason(remote::push(
            &history,
            &git,
            "beta",
            &refs(&["refs/heads/main"])
        )),
        "rejected-non-fast-forward"
    );
    assert_eq!(
        sb.sh(&remote_dir, &["rev-parse", "refs/heads/main"]),
        two,
        "the remote was not overwritten"
    );

    // Something on the remote that isn't a diagram history is never taken in.
    let work = sb.path("work");
    sb.sh(&work, &["init", "-q"]);
    fs::write(work.join("diagram.draftcanvas"), "{}").unwrap();
    fs::write(work.join("payload.sh"), "echo hi").unwrap();
    sb.sh(&work, &["add", "."]);
    sb.sh(&work, &["commit", "-q", "-m", "Not a diagram history"]);
    sb.sh(&work, &["push", "-q", &url, "HEAD:refs/heads/alt/bad"]);
    let err = remote::fetch(&history, &git, "beta").unwrap_err();
    assert_eq!(
        (err.code, err.reason),
        (Code::Corrupt, Some("invalid-remote-history"))
    );
    let beta = history.open_writable("beta").unwrap();
    let tracking: Vec<String> = beta
        .list_refs("refs/remotes/origin")
        .unwrap()
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(
        tracking,
        vec!["refs/remotes/origin/alt/a1", "refs/remotes/origin/main"]
    );
    assert!(beta.list_refs("refs/draft-canvas").unwrap().is_empty());
    // A branch gone from the remote is pruned.
    sb.sh(&remote_dir, &["update-ref", "-d", "refs/heads/alt/bad"]);
    sb.sh(&remote_dir, &["update-ref", "-d", "refs/heads/alt/a1"]);
    let fetched = remote::fetch(&history, &git, "beta").unwrap();
    assert_eq!(fetched.refs.len(), 1);
    let main = fetched
        .branches
        .iter()
        .find(|b| b.branch == "refs/heads/main")
        .unwrap();
    assert_eq!((main.ahead, main.behind), (1, 2));

    remote::remote_remove(&history, &git, "beta").unwrap();
    assert!(history
        .open_writable("beta")
        .unwrap()
        .list_refs("refs/remotes")
        .unwrap()
        .is_empty());
    assert_eq!(reason(remote::fetch(&history, &git, "beta")), "no-remote");
}

#[test]
fn fetching_from_an_empty_remote_finds_nothing_to_take() {
    let Some(sb) = sandbox() else { return };
    let history = History::new(sb.path("history"));
    history.set_git(sb.git("run"));
    let git = history.git().unwrap();
    let remote_dir = sb.bare("empty.git");
    history.create(&history_meta("gamma")).unwrap();
    remote::remote_set(&history, &git, "gamma", &file_url(&remote_dir)).unwrap();
    let fetched = remote::fetch(&history, &git, "gamma").unwrap();
    assert!(fetched.refs.is_empty() && fetched.branches.is_empty());
}
