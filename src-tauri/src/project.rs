//! Listing the `.draftcanvas` files under a folder the user opened as a project. Names, modification
//! times and sizes only: a document is never opened or parsed here, so a folder of thousands of
//! diagrams lists in one directory walk.

use crate::errors::{AppError, Subject, Verb};
use crate::paths::{doc_stem, has_doc_ext};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// Directories that are never worth walking: dependencies and build output would swamp the list and
/// spend the scan's budget on files that are not diagrams.
const SKIPPED_DIRS: [&str; 5] = ["node_modules", "target", "dist", "dist-desktop", "build"];

pub struct Limits {
    /// Sub-folder levels below the root that are entered.
    pub max_depth: usize,
    /// Directory entries looked at, files and folders alike.
    pub max_entries: usize,
    pub max_results: usize,
    pub max_duration: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_depth: 6,
            max_entries: 20_000,
            max_results: 2_000,
            max_duration: Duration::from_millis(1_500),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// Relative to the project, `/`-separated on every OS.
    pub rel_path: String,
    /// The file name without `.draftcanvas`.
    pub name: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct Scan {
    pub files: Vec<ProjectFile>,
    /// Some limit stopped the walk, so the list may be missing files.
    pub truncated: bool,
}

pub fn scan(root: &Path, limits: &Limits) -> Result<Scan, AppError> {
    let started = Instant::now();
    let mut files = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut pending = vec![(root.to_path_buf(), String::new(), 0usize)];

    'walk: while let Some((dir, rel, depth)) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if depth == 0 => {
                return Err(AppError::from_io(&e, Verb::Open, Subject::Path(root)))
            }
            // A sub-folder we may not read is skipped, not fatal: the rest of the project still lists.
            Err(_) => continue,
        };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            visited += 1;
            if visited > limits.max_entries || started.elapsed() >= limits.max_duration {
                truncated = true;
                break 'walk;
            }
            let os_name = entry.file_name();
            // A name that isn't valid Unicode can't travel to the page as JSON, so it isn't listed.
            let Some(name) = os_name.to_str() else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Symlinks are skipped whole: following one could leave the folder the user opened, and a
            // listed file the project can't open would be a dead entry.
            if kind.is_symlink() {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            if kind.is_dir() {
                if SKIPPED_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name)) {
                    continue;
                }
                if depth >= limits.max_depth {
                    truncated = true;
                    continue;
                }
                pending.push((entry.path(), child_rel, depth + 1));
            } else if kind.is_file() && has_doc_ext(Path::new(name)) {
                if files.len() >= limits.max_results {
                    truncated = true;
                    break 'walk;
                }
                let Ok(meta) = entry.metadata() else { continue };
                files.push(ProjectFile {
                    name: doc_stem(Path::new(name)),
                    rel_path: child_rel,
                    mtime_ms: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                    size: meta.len(),
                });
            }
        }
    }

    files.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(Scan { files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::ErrorKind;
    use tempfile::tempdir;

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "{}").unwrap();
    }

    fn rels(scan: &Scan) -> Vec<&str> {
        scan.files.iter().map(|f| f.rel_path.as_str()).collect()
    }

    #[test]
    fn lists_documents_sorted_case_insensitively_with_slashes() {
        let dir = tempdir().unwrap();
        for rel in [
            "b.draftcanvas",
            "A.draftcanvas",
            "sub/z.DraftCanvas",
            "sub/deep/c.draftcanvas",
            "notes.txt",
            "sub/readme.md",
        ] {
            touch(dir.path(), rel);
        }
        let scan = scan(dir.path(), &Limits::default()).unwrap();
        assert!(!scan.truncated);
        assert_eq!(
            rels(&scan),
            [
                "A.draftcanvas",
                "b.draftcanvas",
                "sub/deep/c.draftcanvas",
                "sub/z.DraftCanvas"
            ]
        );
        assert_eq!(scan.files[0].name, "A");
        assert_eq!(scan.files[0].size, 2);
        assert!(scan.files[0].mtime_ms > 0);
    }

    #[test]
    fn never_parses_a_document() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("garbage.draftcanvas"), [0xff, 0xfe]).unwrap();
        let scan = scan(dir.path(), &Limits::default()).unwrap();
        assert_eq!(rels(&scan), ["garbage.draftcanvas"]);
    }

    #[test]
    fn skips_dot_entries_and_dependency_folders() {
        let dir = tempdir().unwrap();
        for rel in [
            "keep.draftcanvas",
            ".hidden.draftcanvas",
            ".git/x.draftcanvas",
            ".cache/y.draftcanvas",
            "node_modules/a/z.draftcanvas",
            "target/t.draftcanvas",
            "dist/d.draftcanvas",
            "dist-desktop/d.draftcanvas",
            "Build/b.draftcanvas",
            "src/ok.draftcanvas",
        ] {
            touch(dir.path(), rel);
        }
        assert_eq!(
            rels(&scan(dir.path(), &Limits::default()).unwrap()),
            ["keep.draftcanvas", "src/ok.draftcanvas"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_or_listed() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        touch(outside.path(), "secret.draftcanvas");
        touch(dir.path(), "real.draftcanvas");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.draftcanvas"),
            dir.path().join("alias.draftcanvas"),
        )
        .unwrap();
        let scan = scan(dir.path(), &Limits::default()).unwrap();
        assert_eq!(rels(&scan), ["real.draftcanvas"]);
        assert!(!scan.truncated);
    }

    #[test]
    fn depth_is_bounded_and_flags_truncation() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "a/b/c/deep.draftcanvas");
        touch(dir.path(), "a/near.draftcanvas");
        let limits = Limits {
            max_depth: 2,
            ..Limits::default()
        };
        let scan = scan(dir.path(), &limits).unwrap();
        assert_eq!(rels(&scan), ["a/near.draftcanvas"]);
        assert!(scan.truncated);

        let roomy = Limits {
            max_depth: 3,
            ..Limits::default()
        };
        let scan = super::scan(dir.path(), &roomy).unwrap();
        assert_eq!(
            rels(&scan),
            ["a/b/c/deep.draftcanvas", "a/near.draftcanvas"]
        );
        assert!(!scan.truncated);
    }

    #[test]
    fn the_result_count_is_capped_and_flagged() {
        let dir = tempdir().unwrap();
        for i in 0..5 {
            touch(dir.path(), &format!("f{i}.draftcanvas"));
        }
        let scan5 = scan(
            dir.path(),
            &Limits {
                max_results: 5,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(scan5.files.len(), 5);
        assert!(!scan5.truncated, "exactly at the cap is not truncated");
        let scan3 = scan(
            dir.path(),
            &Limits {
                max_results: 3,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(scan3.files.len(), 3);
        assert!(scan3.truncated);
    }

    #[test]
    fn the_number_of_entries_visited_is_capped() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            touch(dir.path(), &format!("n{i}.txt"));
        }
        let scan = scan(
            dir.path(),
            &Limits {
                max_entries: 4,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(scan.truncated);
    }

    #[test]
    fn the_clock_is_respected() {
        let dir = tempdir().unwrap();
        touch(dir.path(), "a.draftcanvas");
        let scan = scan(
            dir.path(),
            &Limits {
                max_duration: Duration::ZERO,
                ..Limits::default()
            },
        )
        .unwrap();
        assert!(scan.truncated);
        assert!(scan.files.is_empty());
    }

    #[test]
    fn an_unreadable_root_is_an_error_but_an_empty_one_is_not() {
        let dir = tempdir().unwrap();
        let empty = scan(dir.path(), &Limits::default()).unwrap();
        assert!(empty.files.is_empty() && !empty.truncated);
        let err = scan(&dir.path().join("gone"), &Limits::default())
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::NotFound);
    }

    #[test]
    fn serializes_with_camel_case_fields() {
        let file = ProjectFile {
            rel_path: "a/b.draftcanvas".into(),
            name: "b".into(),
            mtime_ms: 5,
            size: 7,
        };
        assert_eq!(
            serde_json::to_value(file).unwrap(),
            serde_json::json!({"relPath": "a/b.draftcanvas", "name": "b", "mtimeMs": 5, "size": 7})
        );
    }
}
