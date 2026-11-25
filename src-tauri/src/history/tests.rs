//! The desktop backend against the shared contract fixtures, standard Git, and hostile input.
//!
//! Tests that run `git` need it on PATH. Locally they are skipped with a notice when it is missing;
//! under CI (`CI` set) a missing Git fails them, as `tests/evolution/realGit.ts` does.

use super::store::Repo;
use super::*;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Barrier};
use std::time::{Duration, SystemTime};
use tempfile::{tempdir, TempDir};

const FIXTURES: &str = include_str!("../../../tests/fixtures/evolution/contract.json");

fn fixture_sig(time: i64) -> Signature {
    Signature {
        name: "Fixture".into(),
        email: "fixture@draftcanvas.invalid".into(),
        timestamp: time,
        timezone_offset: 0,
    }
}

fn meta(id: &str) -> Value {
    json!({
        "repoId": id,
        "documentId": "d_fixture",
        "title": "Payments",
        "createdAt": 1_700_000_000_000_i64,
        "alternatives": [],
    })
}

fn history() -> (TempDir, History) {
    let dir = tempdir().unwrap();
    let history = History::new(dir.path().join("history"));
    (dir, history)
}

fn repo_with(history: &History, id: &str) -> Repo {
    history.create(&meta(id)).unwrap();
    history.open_writable(id).unwrap()
}

/// A commit of `text` on `parents`, at `time`.
fn commit(repo: &Repo, text: &str, parents: &[&str], time: i64, message: &str) -> String {
    repo.write_snapshot(
        text.as_bytes(),
        &SnapshotHead {
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: fixture_sig(time),
            committer: fixture_sig(time),
            message: message.into(),
        },
    )
    .unwrap()
}

fn set(repo: &Repo, name: &str, expected: Option<&str>, next: Option<&str>) -> RefUpdateResult {
    repo.update_ref(&RefUpdate {
        name: name.into(),
        expected: expected.map(str::to_string),
        next: next.map(str::to_string),
    })
    .unwrap()
}

fn git_available() -> bool {
    let ok = Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        assert!(
            std::env::var_os("CI").is_none(),
            "Git is required for the history interoperability tests in CI."
        );
        eprintln!("[history] git not found: interoperability test skipped locally.");
    }
    ok
}

/// Git with no system or global configuration, no hooks and a fixed identity.
fn git(cwd: &Path, args: &[&str], input: Option<&[u8]>) -> Vec<u8> {
    let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut child = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "core.autocrlf=false",
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
        .env("GIT_AUTHOR_DATE", "1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "1700000000 +0000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("git runs");
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().unwrap();
        if let Some(input) = input {
            stdin.write_all(input).unwrap();
        }
    }
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

fn git_text(cwd: &Path, args: &[&str]) -> String {
    String::from_utf8(git(cwd, args, None))
        .unwrap()
        .trim()
        .to_string()
}

fn repo_path(history: &History, id: &str) -> PathBuf {
    history.root().join(format!("{id}.git"))
}

#[test]
fn the_contract_fixtures_reproduce_standard_git_ids() {
    let fixtures: Value = serde_json::from_str(FIXTURES).unwrap();
    let (_dir, history) = history();
    for (n, fixture) in fixtures.as_array().unwrap().iter().enumerate() {
        let repo = repo_with(&history, &format!("fixture-{n}"));
        let expected: Vec<&str> = fixture["expected"]["commits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let mut parent: Option<String> = None;
        for (i, revision) in fixture["revisions"].as_array().unwrap().iter().enumerate() {
            let text = revision["text"].as_str().unwrap();
            let oid = commit(
                &repo,
                text,
                &parent.iter().map(String::as_str).collect::<Vec<_>>(),
                revision["time"].as_i64().unwrap(),
                revision["message"].as_str().unwrap(),
            );
            assert_eq!(oid, expected[i], "{} revision {i}", fixture["name"]);
            assert_eq!(repo.read_snapshot(&oid).unwrap(), text.as_bytes());
            let record = repo.read_commit(&oid).unwrap();
            assert_eq!(record.message, revision["message"].as_str().unwrap());
            assert_eq!(record.parents, parent.iter().cloned().collect::<Vec<_>>());
            // Writing the same snapshot again writes the same commit.
            let again = commit(
                &repo,
                text,
                &parent.iter().map(String::as_str).collect::<Vec<_>>(),
                revision["time"].as_i64().unwrap(),
                revision["message"].as_str().unwrap(),
            );
            assert_eq!(again, oid);
            parent = Some(oid);
        }
    }
}

#[test]
fn time_zones_are_written_the_way_git_reads_them() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "tz");
    let mut sig = fixture_sig(1_700_000_000);
    sig.timezone_offset = -120;
    let oid = repo
        .write_snapshot(
            b"{}",
            &SnapshotHead {
                parents: vec![],
                author: sig.clone(),
                committer: sig.clone(),
                message: "Hi\n".into(),
            },
        )
        .unwrap();
    let record = repo.read_commit(&oid).unwrap();
    assert_eq!(record.author.timezone_offset, -120);
    if git_available() {
        let show = git_text(&repo_path(&history, "tz"), &["cat-file", "-p", &oid]);
        assert!(show.contains("1700000000 +0200"), "{show}");
    }
}

#[test]
fn compare_and_swap_creates_updates_deletes_and_reports_conflicts() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "cas");
    let a = commit(&repo, "a", &[], 1, "a\n");
    let b = commit(&repo, "b", &[&a], 2, "b\n");
    let main = "refs/heads/main";
    assert_eq!(repo.read_ref(main).unwrap(), None);
    assert!(set(&repo, main, None, Some(&a)).ok);
    assert_eq!(repo.read_ref(main).unwrap().as_deref(), Some(a.as_str()));
    // Must not exist yet: it does.
    assert_eq!(
        set(&repo, main, None, Some(&b)),
        RefUpdateResult::missed(Some(a.clone()))
    );
    // Stale expectation.
    assert_eq!(
        set(&repo, main, Some(&b), Some(&a)),
        RefUpdateResult::missed(Some(a.clone()))
    );
    assert!(set(&repo, main, Some(&a), Some(&b)).ok);
    assert_eq!(repo.read_ref(main).unwrap().as_deref(), Some(b.as_str()));
    assert!(set(&repo, main, Some(&b), None).ok);
    assert_eq!(repo.read_ref(main).unwrap(), None);
    assert_eq!(
        set(&repo, main, Some(&b), None),
        RefUpdateResult::missed(None)
    );
    // A ref may only name an object the history holds.
    let missing = "0".repeat(40);
    let err = repo
        .update_ref(&RefUpdate {
            name: main.into(),
            expected: None,
            next: Some(missing),
        })
        .unwrap_err();
    assert_eq!(err.code, Code::NotFound);
    // The JSON shape the page reads.
    assert_eq!(
        serde_json::to_value(RefUpdateResult::applied()).unwrap(),
        json!({"ok": true})
    );
    assert_eq!(
        serde_json::to_value(RefUpdateResult::missed(None)).unwrap(),
        json!({"ok": false, "actual": null})
    );
}

#[test]
fn two_writers_racing_on_one_ref_exactly_one_wins() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "race");
    let base = commit(&repo, "base", &[], 1, "base\n");
    assert!(set(&repo, "refs/heads/main", None, Some(&base)).ok);
    let ours = commit(&repo, "ours", &[&base], 2, "ours\n");
    let theirs = commit(&repo, "theirs", &[&base], 2, "theirs\n");
    let history = Arc::new(history);
    for round in 0..10 {
        let start = repo.read_ref("refs/heads/main").unwrap().unwrap();
        let (one, two) = if round % 2 == 0 {
            (&ours, &theirs)
        } else {
            (&theirs, &ours)
        };
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = [one.clone(), two.clone()]
            .into_iter()
            .map(|next| {
                let history = Arc::clone(&history);
                let barrier = Arc::clone(&barrier);
                let start = start.clone();
                std::thread::spawn(move || {
                    let repo = history.open_writable("race").unwrap();
                    barrier.wait();
                    repo.update_ref(&RefUpdate {
                        name: "refs/heads/main".into(),
                        expected: Some(start),
                        next: Some(next),
                    })
                    .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.ok).count(), 1, "{results:?}");
        let now = repo.read_ref("refs/heads/main").unwrap().unwrap();
        let loser = results.iter().find(|r| !r.ok).unwrap();
        assert_eq!(loser.actual, Some(Some(now.clone())));
        // Put it back for the next round.
        assert!(set(&repo, "refs/heads/main", Some(&now), Some(&base)).ok);
    }
}

#[test]
fn log_lists_newest_first_ties_by_id_and_honours_hide() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "log");
    let a = commit(&repo, "a", &[], 10, "a\n");
    let b = commit(&repo, "b", &[&a], 20, "b\n");
    let c1 = commit(&repo, "c1", &[&b], 30, "c1\n");
    let c2 = commit(&repo, "c2", &[&b], 30, "c2\n");
    let m = commit(&repo, "m", &[&c1, &c2], 40, "m\n");
    let query = |from: &[&str], hide: Option<&[&str]>, limit: i64| LogQuery {
        from: from.iter().map(|s| s.to_string()).collect(),
        limit,
        hide: hide.map(|h| h.iter().map(|s| s.to_string()).collect()),
    };
    let ids = |records: Vec<CommitRecord>| records.into_iter().map(|r| r.oid).collect::<Vec<_>>();
    let (lo, hi) = if c1 < c2 { (&c1, &c2) } else { (&c2, &c1) };
    assert_eq!(
        ids(repo.log(&query(&[&m], None, 100)).unwrap()),
        vec![m.clone(), lo.clone(), hi.clone(), b.clone(), a.clone()]
    );
    assert_eq!(
        ids(repo.log(&query(&[&m], None, 2)).unwrap()),
        vec![m.clone(), lo.clone()]
    );
    assert_eq!(
        ids(repo.log(&query(&[&m], Some(&[&c1]), 100)).unwrap()),
        vec![m.clone(), c2.clone()]
    );
    assert_eq!(
        ids(repo.log(&query(&[&c1, &c2], None, 100)).unwrap()),
        vec![lo.clone(), hi.clone(), b.clone(), a.clone()]
    );
    assert!(repo.log(&query(&[&m], None, -5)).unwrap().is_empty());
    assert_eq!(repo.log(&query(&[&m], None, 10_000)).unwrap().len(), 5);
    assert!(repo.is_ancestor(&a, &m).unwrap());
    assert!(repo.is_ancestor(&m, &m).unwrap());
    assert!(!repo.is_ancestor(&m, &a).unwrap());
    assert!(!repo.is_ancestor(&c1, &c2).unwrap());
}

#[test]
fn merge_bases_include_both_sides_of_a_criss_cross() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "criss");
    let root = commit(&repo, "root", &[], 1, "root\n");
    let x = commit(&repo, "x", &[&root], 2, "x\n");
    let y = commit(&repo, "y", &[&root], 3, "y\n");
    // Each side merges the other: two best common ancestors.
    let left = commit(&repo, "left", &[&x, &y], 4, "left\n");
    let right = commit(&repo, "right", &[&y, &x], 5, "right\n");
    let mut expected = vec![x.clone(), y.clone()];
    expected.sort();
    assert_eq!(repo.merge_bases(&left, &right).unwrap(), expected);
    assert_eq!(repo.merge_bases(&x, &y).unwrap(), vec![root.clone()]);
    assert_eq!(repo.merge_bases(&left, &x).unwrap(), vec![x.clone()]);
    if git_available() {
        let dir = repo_path(&history, "criss");
        let mut git_bases: Vec<String> = git_text(&dir, &["merge-base", "--all", &left, &right])
            .lines()
            .map(str::to_string)
            .collect();
        git_bases.sort();
        assert_eq!(git_bases, expected);
    }
}

#[test]
fn a_revision_whose_tree_is_anything_but_one_diagram_is_refused() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "shape");
    let odb = &repo.repo_for_tests().objects;
    let blob = gix::objs::Write::write_buf(odb, gix::objs::Kind::Blob, b"{}").unwrap();
    let sig = "Fixture <fixture@draftcanvas.invalid> 1 +0000";
    let mut trees = Vec::new();
    // Executable, wrong name, two entries, a subdirectory.
    for (mode, name) in [
        ("100755", "diagram.draftcanvas"),
        ("100644", "other.draftcanvas"),
    ] {
        let mut t = format!("{mode} {name}\0").into_bytes();
        t.extend_from_slice(blob.as_bytes());
        trees.push(t);
    }
    let mut two = objects::tree_bytes(&blob);
    two.extend_from_slice(b"100644 extra\0");
    two.extend_from_slice(blob.as_bytes());
    trees.push(two);
    for tree in trees {
        let tree = gix::objs::Write::write_buf(odb, gix::objs::Kind::Tree, &tree).unwrap();
        let body = format!("tree {tree}\nauthor {sig}\ncommitter {sig}\n\nbad\n");
        let oid =
            gix::objs::Write::write_buf(odb, gix::objs::Kind::Commit, body.as_bytes()).unwrap();
        let err = repo.read_snapshot(&oid.to_string()).unwrap_err();
        assert_eq!(err.code, Code::Corrupt, "{tree}");
    }
    // A blob that is not UTF-8.
    let bad = gix::objs::Write::write_buf(odb, gix::objs::Kind::Blob, &[0xff, 0xfe]).unwrap();
    let tree = gix::objs::Write::write_buf(odb, gix::objs::Kind::Tree, &objects::tree_bytes(&bad))
        .unwrap();
    let body = format!("tree {tree}\nauthor {sig}\ncommitter {sig}\n\nbad\n");
    let oid = gix::objs::Write::write_buf(odb, gix::objs::Kind::Commit, body.as_bytes()).unwrap();
    assert_eq!(
        repo.read_snapshot(&oid.to_string()).unwrap_err().code,
        Code::Corrupt
    );
    // Reading a blob as a commit.
    assert_eq!(
        repo.read_commit(&bad.to_string()).unwrap_err().code,
        Code::Corrupt
    );
    assert_eq!(
        repo.read_commit(&"1".repeat(40)).unwrap_err().code,
        Code::NotFound
    );
}

#[test]
fn journal_entries_round_trip_and_bad_ids_are_refused() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "journal");
    assert!(repo.journal_list().unwrap().is_empty());
    let entry = |id: &str, step: &str| json!({"opId": id, "kind": "merge", "step": step, "at": 1, "data": {"ours": "x"}});
    repo.journal_put(&entry("op-2", "start")).unwrap();
    repo.journal_put(&entry("op-1", "start")).unwrap();
    repo.journal_put(&entry("op-1", "refs")).unwrap();
    let listed = repo.journal_list().unwrap();
    assert_eq!(listed, vec![entry("op-1", "refs"), entry("op-2", "start")]);
    repo.journal_delete("op-1").unwrap();
    repo.journal_delete("op-1").unwrap();
    assert_eq!(repo.journal_list().unwrap(), vec![entry("op-2", "start")]);
    for bad in ["../x", "A", "", ".x", "a/b"] {
        assert_eq!(
            repo.journal_put(&entry(bad, "s")).unwrap_err().code,
            Code::Invalid,
            "{bad}"
        );
        assert_eq!(
            repo.journal_delete(bad).unwrap_err().code,
            Code::Invalid,
            "{bad}"
        );
    }
    assert_eq!(
        repo.journal_put(&json!({"opId": "x"})).unwrap_err().code,
        Code::Invalid
    );
}

fn age(path: &Path, by: Duration) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - by).unwrap();
}

fn loose_path(history: &History, id: &str, oid: &str) -> PathBuf {
    repo_path(history, id)
        .join("objects")
        .join(&oid[..2])
        .join(&oid[2..])
}

#[test]
fn maintenance_refuses_while_a_journal_entry_is_open_and_prunes_only_old_unreachable_objects() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "gc");
    let kept = commit(&repo, "kept", &[], 1, "kept\n");
    assert!(set(&repo, "refs/heads/main", None, Some(&kept)).ok);
    let old_orphan = commit(&repo, "old orphan", &[], 2, "old\n");
    let young_orphan = commit(&repo, "young orphan", &[], 3, "young\n");
    let held = commit(&repo, "held", &[], 4, "held\n");
    assert!(set(&repo, "refs/draft-canvas/merge/op/ours", None, Some(&held)).ok);
    let month = Duration::from_secs(30 * 24 * 60 * 60);
    for oid in [&kept, &old_orphan, &held] {
        age(&loose_path(&history, "gc", oid), month);
    }
    let later = SystemTime::now();
    repo.journal_put(&json!({"opId": "op", "kind": "merge", "step": "s", "at": 1, "data": {}}))
        .unwrap();
    let refused = repo.maintain(later).unwrap();
    assert_eq!(refused.skipped.as_deref(), Some("journal"));
    assert!(loose_path(&history, "gc", &old_orphan).exists());
    repo.journal_delete("op").unwrap();
    let done = repo.maintain(later).unwrap();
    assert_eq!(done.skipped, None);
    assert_eq!(done.pruned, 1);
    assert!(!loose_path(&history, "gc", &old_orphan).exists());
    assert!(loose_path(&history, "gc", &young_orphan).exists());
    assert_eq!(repo.read_snapshot(&kept).unwrap(), b"kept");
    assert_eq!(repo.read_snapshot(&held).unwrap(), b"held");
    let usage = repo.usage().unwrap();
    assert!(usage.bytes > 0 && usage.objects >= 9, "{usage:?}");
}

#[test]
fn tags_are_annotated_created_once_and_listed() {
    let (_dir, history) = history();
    let repo = repo_with(&history, "tags");
    let a = commit(&repo, "a", &[], 1, "a\n");
    let tag = TagWrite {
        name_ref: "refs/tags/milestone/m1".into(),
        target: a.clone(),
        name: "milestone/m1".into(),
        tagger: fixture_sig(5),
        message: "Launch\n".into(),
    };
    let oid = repo.write_tag(&tag).unwrap();
    assert_eq!(repo.write_tag(&tag).unwrap_err().code, Code::Conflict);
    // A lightweight tag is not a milestone.
    assert!(set(&repo, "refs/tags/milestone/light", None, Some(&a)).ok);
    let tags = repo.list_tags("refs/tags/milestone/").unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].oid, oid);
    assert_eq!(tags[0].target, a);
    assert_eq!(tags[0].message, "Launch\n");
    assert_eq!(tags[0].tagger, fixture_sig(5));
    let mismatched = TagWrite {
        name_ref: "refs/tags/milestone/m2".into(),
        name: "milestone/other".into(),
        ..tag
    };
    assert_eq!(repo.write_tag(&mismatched).unwrap_err().code, Code::Invalid);
    if git_available() {
        let dir = repo_path(&history, "tags");
        assert_eq!(git_text(&dir, &["cat-file", "-t", &oid]), "tag");
        assert_eq!(git_text(&dir, &["rev-parse", "milestone/m1^{commit}"]), a);
    }
}

#[test]
fn malicious_ids_refs_and_payloads_are_refused() {
    let (dir, history) = history();
    let repo = repo_with(&history, "safe");
    for bad in [
        "../x",
        "..",
        "",
        "A",
        "-x",
        "x/y",
        "x\\y",
        "C:",
        "con",
        "nul",
        "com1",
        ".staging-../x",
        &"a".repeat(65),
    ] {
        assert!(history.open(bad).is_err(), "{bad}");
        assert_eq!(
            history.create(&meta(bad)).unwrap_err().code,
            Code::Invalid,
            "{bad}"
        );
        assert!(history.remove(bad).is_err(), "{bad}");
    }
    // Nothing was created outside the history folder.
    let outside: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(outside, vec![std::ffi::OsString::from("history")]);
    let a = commit(&repo, "a", &[], 1, "a\n");
    for bad in [
        "refs/heads/../x",
        "-x",
        "refs/heads/-x",
        "HEAD",
        "refs/heads/x.lock",
        "refs/heads/a b",
        "refs/heads/a~1",
        "refs/heads/.hidden",
        "refs//x",
        "refs/heads/x/",
        "refs/heads/@{1}",
        "refs/heads/ü",
    ] {
        assert!(!is_safe_ref_name(bad), "{bad}");
        let err = repo
            .update_ref(&RefUpdate {
                name: bad.into(),
                expected: None,
                next: Some(a.clone()),
            })
            .unwrap_err();
        assert_eq!(err.code, Code::Invalid, "{bad}");
        assert_eq!(repo.read_ref(bad).unwrap_err().code, Code::Invalid, "{bad}");
    }
    for bad_oid in ["", "xyz", &"A".repeat(40), &"a".repeat(39), &"a".repeat(41)] {
        assert_eq!(
            repo.read_commit(bad_oid).unwrap_err().code,
            Code::Invalid,
            "{bad_oid}"
        );
    }
    let huge = vec![b'x'; limits::MAX_BLOB_BYTES + 1];
    let err = repo
        .write_snapshot(
            &huge,
            &SnapshotHead {
                parents: vec![],
                author: fixture_sig(1),
                committer: fixture_sig(1),
                message: "big\n".into(),
            },
        )
        .unwrap_err();
    assert_eq!(err.code, Code::TooLarge);
    let err = repo
        .write_snapshot(
            &[0xff],
            &SnapshotHead {
                parents: vec!["nope".into()],
                author: fixture_sig(1),
                committer: fixture_sig(1),
                message: "m\n".into(),
            },
        )
        .unwrap_err();
    assert_eq!(err.code, Code::Invalid);
    // repo.json must keep naming its own history.
    assert_eq!(
        repo.write_meta(&meta("other")).unwrap_err().code,
        Code::Invalid
    );
    repo.write_meta(&meta("safe")).unwrap();
    assert_eq!(
        history.create(&meta("safe")).unwrap_err().code,
        Code::Conflict
    );
}

#[test]
fn list_create_and_remove() {
    let (_dir, history) = history();
    assert!(history.list().unwrap().is_empty());
    history.create(&meta("b")).unwrap();
    history.create(&meta("a")).unwrap();
    let ids: Vec<_> = history
        .list()
        .unwrap()
        .into_iter()
        .map(|m| m["repoId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["a", "b"]);
    assert_eq!(history.open("a").unwrap().meta().unwrap(), meta("a"));
    // A bare repository Git recognises, on `main`.
    let head = std::fs::read_to_string(repo_path(&history, "a").join("HEAD")).unwrap();
    assert_eq!(head.trim(), "ref: refs/heads/main");
    history.remove("a").unwrap();
    assert_eq!(history.open("a").unwrap_err().code, Code::NotFound);
    assert_eq!(history.remove("a").unwrap_err().code, Code::NotFound);
    assert_eq!(history.list().unwrap().len(), 1);
}

#[test]
fn bindings_round_trip_under_validation() {
    let (_dir, history) = history();
    let binding = Binding {
        copy_id: "file_/Users/ada/payments.draftcanvas".into(),
        repo_id: "r1".into(),
        alt_id: None,
        document_id: "d_1".into(),
        last_seen: Some("a".repeat(40)),
        at: 5,
    };
    assert_eq!(history.binding_get(&binding.copy_id).unwrap(), None);
    history.binding_put(&binding).unwrap();
    assert_eq!(
        history.binding_get(&binding.copy_id).unwrap(),
        Some(binding.clone())
    );
    assert_eq!(history.binding_list().unwrap(), vec![binding.clone()]);
    assert_eq!(
        serde_json::to_value(&binding).unwrap(),
        json!({"copyId": binding.copy_id, "repoId": "r1", "altId": null, "documentId": "d_1", "lastSeen": "a".repeat(40), "at": 5})
    );
    for bad in [
        Binding {
            repo_id: "../x".into(),
            ..binding.clone()
        },
        Binding {
            alt_id: Some("A".into()),
            ..binding.clone()
        },
        Binding {
            last_seen: Some("x".into()),
            ..binding.clone()
        },
        Binding {
            copy_id: String::new(),
            ..binding.clone()
        },
    ] {
        assert_eq!(history.binding_put(&bad).unwrap_err().code, Code::Invalid);
    }
    history.binding_delete(&binding.copy_id).unwrap();
    assert!(history.binding_list().unwrap().is_empty());
    // An unreadable registry is set aside, not lost.
    std::fs::write(history.root().join("bindings.json"), b"{not json").unwrap();
    assert!(history.binding_list().unwrap().is_empty());
    assert!(std::fs::read_dir(history.root())
        .unwrap()
        .flatten()
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("bindings.unreadable-")));
}

/// A linear history of three revisions on main, plus a milestone.
fn sample(history: &History, id: &str) -> (Repo, Vec<String>, String) {
    let repo = repo_with(history, id);
    let a = commit(&repo, "{\"a\":1}\n", &[], 1, "a\n");
    let b = commit(&repo, "{\"b\":2}\n", &[&a], 2, "b\n");
    let c = commit(&repo, "{\"c\":3}\n", &[&b], 3, "c\n");
    assert!(set(&repo, "refs/heads/main", None, Some(&c)).ok);
    let tag = repo
        .write_tag(&TagWrite {
            name_ref: "refs/tags/milestone/m1".into(),
            target: b.clone(),
            name: "milestone/m1".into(),
            tagger: fixture_sig(4),
            message: "M1\n".into(),
        })
        .unwrap();
    (repo, vec![a, b, c], tag)
}

#[test]
fn an_exported_pack_is_a_bundle_git_clones() {
    if !git_available() {
        return;
    }
    let (dir, history) = history();
    let (repo, commits, tag) = sample(&history, "export");
    let pack = repo
        .pack_reachable(&[commits[2].clone(), tag.clone()])
        .unwrap();
    let work = dir.path().join("git");
    std::fs::create_dir_all(&work).unwrap();
    // `git index-pack` checks every object id and the trailer.
    std::fs::write(work.join("history.pack"), &pack).unwrap();
    git(&work, &["index-pack", "history.pack"], None);
    let mut bundle = format!(
        "# v2 git bundle\n{} refs/heads/main\n{} refs/tags/milestone/m1\n\n",
        commits[2], tag
    )
    .into_bytes();
    bundle.extend_from_slice(&pack);
    std::fs::write(work.join("history.bundle"), &bundle).unwrap();
    let heads = String::from_utf8(git(
        &work,
        &["bundle", "list-heads", "history.bundle"],
        None,
    ))
    .unwrap();
    assert!(heads.contains("refs/heads/main"), "{heads}");
    git(
        &work,
        &["clone", "-q", "--bare", "history.bundle", "clone.git"],
        None,
    );
    let clone = work.join("clone.git");
    git(&clone, &["fsck", "--strict"], None);
    assert_eq!(
        git_text(&clone, &["rev-parse", "refs/heads/main"]),
        commits[2]
    );
    assert_eq!(
        git_text(
            &clone,
            &["show", &format!("{}:diagram.draftcanvas", commits[1])]
        ),
        "{\"b\":2}"
    );
    assert_eq!(
        git_text(&clone, &["rev-parse", "milestone/m1^{commit}"]),
        commits[1]
    );
    // And the repository itself passes fsck.
    git(&repo_path(&history, "export"), &["fsck", "--strict"], None);
}

#[test]
fn a_pack_git_wrote_with_deltas_imports_and_reads_back() {
    if !git_available() {
        return;
    }
    let (dir, history) = history();
    // A Git-made history with deltas: similar large revisions.
    let src = dir.path().join("src.git");
    std::fs::create_dir_all(&src).unwrap();
    git(&src, &["init", "-q", "--bare"], None);
    let mut parent: Option<String> = None;
    let mut texts = Vec::new();
    for i in 0..6 {
        let body: String = (0..400)
            .map(|n| format!("  \"line{n}\": {},\n", n * (i + 1) % 7))
            .collect();
        let text = format!("{{\n{body}  \"end\": {i}\n}}\n");
        let blob = String::from_utf8(git(
            &src,
            &["hash-object", "-w", "--stdin"],
            Some(text.as_bytes()),
        ))
        .unwrap()
        .trim()
        .to_string();
        let tree_in = format!("100644 blob {blob}\tdiagram.draftcanvas\n");
        let tree = String::from_utf8(git(&src, &["mktree"], Some(tree_in.as_bytes())))
            .unwrap()
            .trim()
            .to_string();
        let mut args = vec!["commit-tree".to_string(), tree];
        if let Some(p) = &parent {
            args.extend(["-p".to_string(), p.clone()]);
        }
        args.extend(["-m".to_string(), format!("rev {i}")]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let oid = String::from_utf8(git(&src, &args, None))
            .unwrap()
            .trim()
            .to_string();
        parent = Some(oid);
        texts.push(text);
    }
    let tip = parent.unwrap();
    git(&src, &["update-ref", "refs/heads/main", &tip], None);
    let pack = git(
        &src,
        &["pack-objects", "--stdout", "--revs", "--window=10"],
        Some(format!("{tip}\n").as_bytes()),
    );
    let summary = pack::scan_pack(&pack, pack::PackLimits::history()).unwrap();
    assert!(
        summary.deltas > 0,
        "git should have written deltas: {summary:?}"
    );

    let staging = history.import_begin(&meta("imported"), &pack).unwrap();
    assert!(staging.starts_with(".staging-"));
    // Invisible to the list, readable through the ordinary read commands, not writable.
    assert!(history.list().unwrap().is_empty());
    let staged = history.open(&staging).unwrap();
    assert_eq!(staged.read_snapshot(&tip).unwrap(), texts[5].as_bytes());
    assert_eq!(
        staged
            .log(&LogQuery {
                from: vec![tip.clone()],
                limit: 100,
                hide: None
            })
            .unwrap()
            .len(),
        6
    );
    assert_eq!(
        staged
            .journal_put(&json!({"opId": "x", "kind": "k", "step": "s", "at": 1, "data": {}}))
            .unwrap_err()
            .code,
        Code::Invalid
    );
    assert!(history.open_writable(&staging).is_err());
    drop(staged);

    let refs = vec![RefEntry {
        name: "refs/heads/main".into(),
        oid: tip.clone(),
    }];
    assert_eq!(history.import_commit(&staging, &refs).unwrap(), "imported");
    let repo = history.open_writable("imported").unwrap();
    assert_eq!(
        repo.read_ref("refs/heads/main").unwrap().as_deref(),
        Some(tip.as_str())
    );
    let log = repo
        .log(&LogQuery {
            from: vec![tip.clone()],
            limit: 100,
            hide: None,
        })
        .unwrap();
    for (record, text) in log.iter().zip(texts.iter().rev()) {
        assert_eq!(repo.read_snapshot(&record.oid).unwrap(), text.as_bytes());
    }
    assert_eq!(history.list().unwrap().len(), 1);
    // The import is now an ordinary history: it can grow and be removed.
    let next = commit(&repo, "next", &[&tip], 10, "next\n");
    assert!(set(&repo, "refs/heads/main", Some(&tip), Some(&next)).ok);
    drop(repo);
    history.remove("imported").unwrap();
}

#[test]
fn imports_are_refused_or_aborted_cleanly() {
    let (_dir, history) = history();
    let (repo, commits, _) = sample(&history, "source");
    let pack = repo.pack_reachable(&[commits[2].clone()]).unwrap();
    // Damaged trailer: gix refuses while indexing, and nothing is left behind.
    let mut damaged = pack.clone();
    let last = damaged.len() - 1;
    damaged[last] ^= 0xff;
    assert!(history.import_begin(&meta("copy"), &damaged).is_err());
    let leftovers: Vec<_> = std::fs::read_dir(history.root())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // An id already in use.
    assert_eq!(
        history
            .import_begin(&meta("source"), &pack)
            .unwrap_err()
            .code,
        Code::Conflict
    );
    // A ref naming something the pack doesn't hold, a bad ref, then an abort.
    let staging = history.import_begin(&meta("copy"), &pack).unwrap();
    let missing = vec![RefEntry {
        name: "refs/heads/main".into(),
        oid: "1".repeat(40),
    }];
    assert_eq!(
        history.import_commit(&staging, &missing).unwrap_err().code,
        Code::NotFound
    );
    let bad = vec![RefEntry {
        name: "refs/heads/../x".into(),
        oid: commits[0].clone(),
    }];
    assert_eq!(
        history.import_commit(&staging, &bad).unwrap_err().code,
        Code::Invalid
    );
    history.import_abort(&staging).unwrap();
    assert!(history.open(&staging).is_err());
    history.import_abort(&staging).unwrap();
    for bad in ["staging-x", ".staging-../x", ".staging-", "../.staging-x"] {
        assert_eq!(
            history.import_abort(bad).unwrap_err().code,
            Code::Invalid,
            "{bad}"
        );
    }
    // Too large is refused before anything is read.
    let err = history.import_begin(&meta("copy"), b"PACK").unwrap_err();
    assert_eq!(err.code, Code::Corrupt);
}

#[test]
fn sha256_repositories_are_refused_by_name() {
    let (_dir, history) = history();
    history.create(&meta("s256")).unwrap();
    let config = repo_path(&history, "s256").join("config");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str("[extensions]\n\tobjectFormat = sha256\n");
    std::fs::write(&config, text).unwrap();
    assert_eq!(
        history.open("s256").unwrap_err().code,
        Code::UnsupportedFormat
    );
}

#[cfg(unix)]
#[test]
fn removing_a_history_never_follows_a_link_out_of_it() {
    let (dir, history) = history();
    history.create(&meta("linked")).unwrap();
    let outside = dir.path().join("precious");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
    std::os::unix::fs::symlink(&outside, repo_path(&history, "linked").join("escape")).unwrap();
    history.remove("linked").unwrap();
    assert!(outside.join("keep.txt").exists());
}
