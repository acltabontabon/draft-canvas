//! Which diagrams an agent may see: `.draftcanvas` files inside the project folders the person switched
//! agent access on for — nothing else, whatever id or path a request names. Every tool call resolves its
//! diagram through here, so scope is checked on each call rather than trusted from an earlier one.
//!
//! A diagram is addressed by the id inside it (`metadata.id`), never by a path from the caller. Ids are
//! read from each file once per modification and remembered, so listing a folder of diagrams stays one
//! directory walk plus whatever changed since.

use crate::docio::read_document;
use crate::project::{scan, Limits};
use crate::state::AppState;
use crate::util::lock;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// A project folder agents may use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub root: PathBuf,
    pub name: String,
}

pub fn enabled_projects(state: &AppState) -> Vec<Project> {
    state
        .settings
        .get()
        .projects
        .iter()
        .filter(|p| p.agent)
        .filter_map(|p| {
            let root = dunce::canonicalize(&p.path).ok()?;
            root.is_dir().then(|| Project {
                root,
                name: p.name.clone(),
            })
        })
        .collect()
}

/// Whether `path` lies inside one of `projects`, compared on canonical paths so a symlink can't lead
/// out of scope.
pub fn in_scope(projects: &[Project], path: &Path) -> Option<Project> {
    let canonical = dunce::canonicalize(path).ok()?;
    projects
        .iter()
        .find(|p| canonical.starts_with(&p.root))
        .cloned()
}

/// What an agent is told about one diagram.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagram {
    pub diagram_id: String,
    pub title: String,
    pub project: String,
    /// Relative to the project, `/`-separated. For showing a person; never accepted back as input.
    pub path: String,
    /// The revision of the file as it is on disk (`f:…`). An open document may be ahead of it.
    pub revision: String,
    #[serde(skip)]
    pub absolute: PathBuf,
}

#[derive(Clone)]
struct Known {
    mtime_ms: u64,
    size: u64,
    id: Option<String>,
    title: String,
    revision: String,
}

#[derive(Default)]
pub struct DiagramIndex {
    known: Mutex<HashMap<PathBuf, Known>>,
}

/// The file revision an agent sees for a document on disk: a short digest of its bytes. The page
/// derives the same value from a stamp (`v1:<mtime>:<size>:<sha256>`), so a clean open document
/// answers to it too.
pub fn file_revision_of_sha(sha_hex: &str) -> String {
    format!("f:{}", &sha_hex[..16.min(sha_hex.len())])
}

pub fn file_revision_of_stamp(stamp: &str) -> Option<String> {
    stamp.rsplit(':').next().map(file_revision_of_sha)
}

/// The first 16 hex digits of the text's SHA-256, as a file revision.
pub fn file_revision(text: &str) -> String {
    file_revision_of_sha(&format!("{:x}", Sha256::digest(text.as_bytes())))
}

/// The id and title inside a document's text, without validating the rest of it.
pub fn identity_of(text: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("format")?.as_str()? != "draft-canvas" {
        return None;
    }
    let metadata = value.get("metadata")?;
    let id = metadata.get("id")?.as_str()?.to_string();
    let title = metadata
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    Some((id, title))
}

impl DiagramIndex {
    /// Every diagram in scope, in a stable order (project, then path). Files whose content isn't a
    /// diagram are left out.
    pub fn list(&self, projects: &[Project]) -> Vec<Diagram> {
        let mut out = Vec::new();
        let mut known = lock(&self.known);
        for project in projects {
            let Ok(found) = scan(&project.root, &Limits::default()) else {
                continue;
            };
            for file in found.files {
                let absolute = project.root.join(&file.rel_path);
                let fresh = known
                    .get(&absolute)
                    .filter(|k| k.mtime_ms == file.mtime_ms && k.size == file.size)
                    .cloned();
                let entry = match fresh {
                    Some(k) => k,
                    None => {
                        let read = read_document(&absolute).ok();
                        let identity = read.as_ref().and_then(|d| identity_of(&d.text));
                        let k = Known {
                            mtime_ms: file.mtime_ms,
                            size: file.size,
                            id: identity.as_ref().map(|(id, _)| id.clone()),
                            title: identity.map(|(_, t)| t).unwrap_or_default(),
                            revision: read
                                .as_ref()
                                .and_then(|d| file_revision_of_stamp(&d.stamp))
                                .unwrap_or_default(),
                        };
                        known.insert(absolute.clone(), k.clone());
                        k
                    }
                };
                let Some(id) = entry.id else { continue };
                let revision = entry.revision;
                out.push(Diagram {
                    diagram_id: id,
                    title: if entry.title.is_empty() {
                        file.name.clone()
                    } else {
                        entry.title
                    },
                    project: project.name.clone(),
                    path: file.rel_path,
                    revision,
                    absolute,
                });
            }
        }
        out.sort_by(|a, b| a.project.cmp(&b.project).then_with(|| a.path.cmp(&b.path)));
        out
    }

    /// The one diagram with this id in scope. Two files carrying the same id (a copied file) are
    /// ambiguous, and said to be, rather than one chosen silently.
    pub fn find(&self, projects: &[Project], id: &str) -> Result<Diagram, Lookup> {
        let mut matches: Vec<Diagram> = self
            .list(projects)
            .into_iter()
            .filter(|d| d.diagram_id == id)
            .collect();
        match matches.len() {
            0 => Err(Lookup::NotFound),
            1 => Ok(matches.remove(0)),
            _ => Err(Lookup::Ambiguous(
                matches.into_iter().map(|d| d.path).collect(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    NotFound,
    Ambiguous(Vec<String>),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn diagram(id: &str, title: &str) -> String {
        format!(
            r#"{{"format":"draft-canvas","version":15,"metadata":{{"id":"{id}","title":"{title}"}},"nodes":[],"edges":[]}}"#
        )
    }

    #[test]
    fn lists_only_diagrams_inside_enabled_folders_and_finds_them_by_id() {
        let dir = tempdir().unwrap();
        let inside = dir.path().join("inside");
        let outside = dir.path().join("outside");
        fs::create_dir_all(inside.join("docs")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(inside.join("docs/a.draftcanvas"), diagram("d_a", "Alpha")).unwrap();
        fs::write(inside.join("b.draftcanvas"), "not json").unwrap();
        fs::write(outside.join("c.draftcanvas"), diagram("d_c", "Gamma")).unwrap();
        let projects = vec![Project {
            root: dunce::canonicalize(&inside).unwrap(),
            name: "Inside".into(),
        }];
        let index = DiagramIndex::default();
        let listed = index.list(&projects);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].diagram_id, "d_a");
        assert_eq!(listed[0].path, "docs/a.draftcanvas");
        assert!(listed[0].revision.starts_with("f:"));
        assert!(index.find(&projects, "d_a").is_ok());
        assert_eq!(
            index.find(&projects, "d_c").unwrap_err(),
            Lookup::NotFound,
            "a diagram outside every enabled folder doesn't exist as far as an agent can tell"
        );
        assert!(in_scope(&projects, &outside.join("c.draftcanvas")).is_none());
    }

    #[test]
    fn a_copied_file_makes_its_id_ambiguous() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.draftcanvas"), diagram("d_same", "A")).unwrap();
        fs::write(
            dir.path().join("a copy.draftcanvas"),
            diagram("d_same", "A"),
        )
        .unwrap();
        let projects = vec![Project {
            root: dunce::canonicalize(dir.path()).unwrap(),
            name: "P".into(),
        }];
        assert!(matches!(
            DiagramIndex::default().find(&projects, "d_same"),
            Err(Lookup::Ambiguous(paths)) if paths.len() == 2
        ));
    }

    #[test]
    fn the_file_revision_is_the_same_from_text_and_from_a_stamp() {
        let text = diagram("d", "t");
        let sha = format!("{:x}", Sha256::digest(text.as_bytes()));
        assert_eq!(
            file_revision(&text),
            file_revision_of_stamp(&format!("v1:1:2:{sha}")).unwrap()
        );
    }
}
