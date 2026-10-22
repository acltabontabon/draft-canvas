//! The Draft Canvas agent skill (`skills/draft-canvas/` in the repository): instructions, scripts and
//! references that teach a coding agent to draw a repository well through the MCP tools. The files
//! are compiled into the app and installed, from Settings → AI agents, where agents look for skills
//! for every project:
//!
//! - **Claude Code** reads `~/.claude/skills` (`$CLAUDE_CONFIG_DIR/skills` when that is set).
//! - **Codex**, **Cursor**, **Gemini CLI** and **Junie** all read `~/.agents/skills`, the folder the
//!   open Agent Skills convention names. (Cursor reads Claude Code's folder too, so one install is
//!   enough for it.)
//!
//! Updates are the point of keeping a manifest. Every install writes `.draft-canvas-skill.json` beside
//! the files: the skill's version and a hash of exactly what was written. From that the app can tell
//! a copy it wrote and nobody touched (safe to replace when a newer app brings a newer skill — done at
//! launch, see `refresh`) from one the person edited (never replaced silently; Settings offers to, and
//! keeps the edited copy as a backup) and from one a newer Draft Canvas installed (never downgraded).
//! A new version is staged beside the skills folder and swapped in whole, so a file the new version
//! dropped is gone too, and an agent never sees half of each.

use crate::errors::{AppError, ErrorKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The skill's folder name, and the `name` in its SKILL.md.
pub const SKILL_NAME: &str = "draft-canvas";

/// Written beside the skill's files on install; never part of the skill itself.
pub const MANIFEST: &str = ".draft-canvas-skill.json";

/// The skill's files, relative to its folder. `every_file_in_the_skill_folder_is_bundled` keeps this
/// list and the folder in step.
pub const FILES: &[(&str, &[u8])] = &[
    (
        "SKILL.md",
        include_bytes!("../../../skills/draft-canvas/SKILL.md"),
    ),
    (
        "scripts/draft.py",
        include_bytes!("../../../skills/draft-canvas/scripts/draft.py"),
    ),
    (
        "scripts/scan_repo.py",
        include_bytes!("../../../skills/draft-canvas/scripts/scan_repo.py"),
    ),
    (
        "scripts/check_diagram.py",
        include_bytes!("../../../skills/draft-canvas/scripts/check_diagram.py"),
    ),
    (
        "scripts/pairings.json",
        include_bytes!("../../../skills/draft-canvas/scripts/pairings.json"),
    ),
    (
        "references/modeling.md",
        include_bytes!("../../../skills/draft-canvas/references/modeling.md"),
    ),
    (
        "references/vocabulary.md",
        include_bytes!("../../../skills/draft-canvas/references/vocabulary.md"),
    ),
    (
        "references/mcp-playbook.md",
        include_bytes!("../../../skills/draft-canvas/references/mcp-playbook.md"),
    ),
    (
        "references/example-create.json",
        include_bytes!("../../../skills/draft-canvas/references/example-create.json"),
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillTarget {
    /// `~/.claude/skills`.
    ClaudeCode,
    /// `~/.agents/skills`, read by Codex, Cursor, Gemini CLI and Junie.
    Agents,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillState {
    NotInstalled,
    /// The version this app carries, as written.
    Ready,
    /// An older version Draft Canvas wrote and nobody changed: replaced at launch.
    Outdated,
    /// Changed since Draft Canvas wrote it, or put there by someone else: left alone unless asked.
    Modified,
    /// Written by a newer Draft Canvas: left alone, never downgraded.
    Newer,
}

/// Where one target's skill stands, as Settings shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSetup {
    pub target: SkillTarget,
    pub state: SkillState,
    /// The skill's folder, written for a person (`~/.claude/skills/draft-canvas`).
    pub location: Option<String>,
    /// The version found there, when Draft Canvas wrote it.
    pub installed_version: Option<String>,
    /// The version this app carries.
    pub bundled_version: String,
    /// Where the person's edited copy was kept, after a replace.
    pub backup: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    skill: String,
    version: String,
    /// `content_hash` of the files as written.
    hash: String,
}

/// The `version` in the bundled SKILL.md's metadata.
pub fn bundled_version() -> String {
    let text = String::from_utf8_lossy(FILES[0].1);
    text.lines()
        .take_while(|line| !line.starts_with("# "))
        .find_map(|line| line.trim().strip_prefix("version:"))
        .map(|v| v.trim().trim_matches('"').to_string())
        .unwrap_or_else(|| "0".to_string())
}

/// One hash over a set of files, independent of the order they were listed or read in.
fn content_hash<'a>(files: impl IntoIterator<Item = (String, &'a [u8])>) -> String {
    let mut files: Vec<(String, &[u8])> = files.into_iter().collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (path, bytes) in files {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    format!("{:x}", hasher.finalize())
}

pub fn bundled_hash() -> String {
    content_hash(FILES.iter().map(|(p, b)| (p.to_string(), *b)))
}

/// Versions compare as dotted numbers ("2" > "1.9"); anything unreadable counts as 0.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| {
        v.split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (a, b) = (parts(a), parts(b));
    let len = a.len().max(b.len());
    (0..len)
        .map(|i| {
            a.get(i)
                .copied()
                .unwrap_or(0)
                .cmp(&b.get(i).copied().unwrap_or(0))
        })
        .find(|o| o.is_ne())
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// The folder that holds skills for `target` — not the skill's own folder.
pub fn skills_root(target: SkillTarget) -> Option<PathBuf> {
    match target {
        SkillTarget::ClaudeCode => std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".claude")))
            .map(|dir| dir.join("skills")),
        SkillTarget::Agents => home().map(|h| h.join(".agents").join("skills")),
    }
}

/// Every file under `dir` but the manifest, as (relative path with `/`, bytes).
fn read_tree(dir: &Path) -> std::io::Result<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current)? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                let rel = path
                    .strip_prefix(dir)
                    .unwrap_or(&path)
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                if rel != MANIFEST
                    && rel != ".DS_Store"
                    && !rel.ends_with("/.DS_Store")
                    && !rel.contains("__pycache__/")
                {
                    out.push((rel, std::fs::read(&path)?));
                }
            }
        }
    }
    Ok(out)
}

/// What is in `dir` (a skill folder), against what this app carries.
pub fn state_of(dir: &Path) -> (SkillState, Option<String>) {
    if !dir.exists() {
        return (SkillState::NotInstalled, None);
    }
    let manifest: Option<Manifest> = std::fs::read(dir.join(MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let on_disk = read_tree(dir)
        .map(|files| content_hash(files.iter().map(|(p, b)| (p.clone(), b.as_slice()))))
        .ok();
    let bundled = bundled_hash();
    let Some(manifest) = manifest else {
        // A copy put there by hand (from the repository, say) that matches exactly is as good as ours.
        return if on_disk.as_deref() == Some(bundled.as_str()) {
            (SkillState::Ready, None)
        } else {
            (SkillState::Modified, None)
        };
    };
    let untouched = on_disk.as_deref() == Some(manifest.hash.as_str());
    let state = if !untouched {
        SkillState::Modified
    } else if manifest.hash == bundled {
        SkillState::Ready
    } else if version_cmp(&manifest.version, &bundled_version()).is_gt() {
        SkillState::Newer
    } else {
        SkillState::Outdated
    };
    (state, Some(manifest.version))
}

pub fn status(target: SkillTarget) -> SkillSetup {
    let dir = skills_root(target).map(|root| root.join(SKILL_NAME));
    let (state, installed_version) = dir
        .as_deref()
        .map_or((SkillState::NotInstalled, None), state_of);
    SkillSetup {
        target,
        state,
        location: dir.as_deref().map(crate::paths::display_path),
        installed_version,
        bundled_version: bundled_version(),
        backup: None,
    }
}

fn io_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Io, message.into())
}

fn unique_suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Writes the bundled files and the manifest into `dir`, which must not exist yet.
fn write_skill(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for (rel, bytes) in FILES {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, bytes)?;
        #[cfg(unix)]
        if rel.starts_with("scripts/") {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    let manifest = Manifest {
        skill: SKILL_NAME.to_string(),
        version: bundled_version(),
        hash: bundled_hash(),
    };
    std::fs::write(
        dir.join(MANIFEST),
        serde_json::to_vec_pretty(&manifest).unwrap_or_default(),
    )
}

/// Moves a folder, copying when a rename can't cross volumes.
fn move_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir(from, to)?;
    std::fs::remove_dir_all(from)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Puts this app's skill in `root/draft-canvas`, replacing what is there. A copy that isn't one
/// Draft Canvas wrote unchanged is first moved into `backups` (never into the skills folder, where an
/// agent would load it as a second skill), and that place is returned.
pub fn install_into(root: &Path, backups: &Path) -> Result<Option<PathBuf>, AppError> {
    let dir = root.join(SKILL_NAME);
    let fail = |what: &str, e: std::io::Error| {
        io_error(format!(
            "Draft Canvas couldn’t {what} the skill in {}: {e}",
            crate::paths::display_path(root)
        ))
    };
    std::fs::create_dir_all(root).map_err(|e| fail("install", e))?;
    // Staged beside the skills folder, not in it: an agent scanning skills mid-install must never
    // find a second, half-written draft-canvas.
    let parent = root.parent().unwrap_or(root);
    let staging = parent.join(format!(".{SKILL_NAME}-skill-{}", unique_suffix()));
    if let Err(e) = write_skill(&staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(fail("write", e));
    }
    let (state, _) = state_of(&dir);
    let mut backup = None;
    let mut retired = None;
    if dir.exists() {
        let keep = matches!(state, SkillState::Modified | SkillState::Newer);
        let aside = if keep {
            let stamp = crate::util::now_ms();
            std::fs::create_dir_all(backups).map_err(|e| fail("back up", e))?;
            backups.join(format!("{SKILL_NAME}-{stamp}"))
        } else {
            parent.join(format!(".{SKILL_NAME}-skill-old-{}", unique_suffix()))
        };
        if let Err(e) = move_dir(&dir, &aside) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(fail("replace", e));
        }
        if keep {
            backup = Some(aside);
        } else {
            retired = Some(aside);
        }
    }
    if let Err(e) = std::fs::rename(&staging, &dir) {
        // Put back what was there, so a failed update leaves the old skill working.
        if let Some(previous) = backup.as_ref().or(retired.as_ref()) {
            let _ = move_dir(previous, &dir);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(fail("install", e));
    }
    if let Some(old) = retired {
        let _ = std::fs::remove_dir_all(old);
    }
    Ok(backup)
}

pub fn install(target: SkillTarget, backups: &Path) -> Result<SkillSetup, AppError> {
    let root = skills_root(target).ok_or_else(|| {
        io_error("Draft Canvas couldn’t find your home folder to install the skill.")
    })?;
    let backup = install_into(&root, &backups.join(target_slug(target)))?;
    let mut setup = status(target);
    setup.backup = backup.as_deref().map(crate::paths::display_path);
    Ok(setup)
}

/// Takes the skill out of `root`. An edited copy is kept in `backups`, as on a replace.
pub fn remove_from(root: &Path, backups: &Path) -> Result<Option<PathBuf>, AppError> {
    let dir = root.join(SKILL_NAME);
    if !dir.exists() {
        return Ok(None);
    }
    let fail = |e: std::io::Error| {
        io_error(format!(
            "Draft Canvas couldn’t remove the skill from {}: {e}",
            crate::paths::display_path(root)
        ))
    };
    match state_of(&dir).0 {
        SkillState::Modified | SkillState::Newer => {
            std::fs::create_dir_all(backups).map_err(fail)?;
            let aside = backups.join(format!("{SKILL_NAME}-{}", crate::util::now_ms()));
            move_dir(&dir, &aside).map_err(fail)?;
            Ok(Some(aside))
        }
        _ => std::fs::remove_dir_all(&dir).map(|_| None).map_err(fail),
    }
}

pub fn remove(target: SkillTarget, backups: &Path) -> Result<SkillSetup, AppError> {
    let root = skills_root(target)
        .ok_or_else(|| io_error("Draft Canvas couldn’t find your home folder."))?;
    let backup = remove_from(&root, &backups.join(target_slug(target)))?;
    let mut setup = status(target);
    setup.backup = backup.as_deref().map(crate::paths::display_path);
    Ok(setup)
}

fn target_slug(target: SkillTarget) -> &'static str {
    match target {
        SkillTarget::ClaudeCode => "claude-code",
        SkillTarget::Agents => "agents",
    }
}

pub const TARGETS: [SkillTarget; 2] = [SkillTarget::ClaudeCode, SkillTarget::Agents];

/// At launch: brings every copy this app wrote earlier, and nobody changed since, up to the version
/// it carries now. Anything else — not installed, edited, newer — is left exactly as it is.
pub fn refresh(backups: &Path) {
    for target in TARGETS {
        if status(target).state != SkillState::Outdated {
            continue;
        }
        if let Err(e) = install(target, backups) {
            eprintln!(
                "Draft Canvas: couldn’t update the agent skill ({})",
                e.message
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills/draft-canvas")
    }

    #[test]
    fn every_file_in_the_skill_folder_is_bundled() {
        let mut on_disk: Vec<String> = read_tree(&skill_dir())
            .unwrap()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        on_disk.sort();
        let mut bundled: Vec<String> = FILES.iter().map(|(p, _)| p.to_string()).collect();
        bundled.sort();
        assert_eq!(
            on_disk, bundled,
            "add new skill files to FILES in agent/skill.rs"
        );
    }

    /// Every version of the skill a release has carried, with the hash of its files. Two apps that
    /// carried different files under one version would each take the other's copy for "outdated"
    /// and replace it on every launch; a new entry for every change keeps "version N" meaning one set
    /// of files. When this fails: bump `metadata.version` in SKILL.md and add the pair it prints.
    const PUBLISHED: &[(&str, &str)] = &[
        (
            "1",
            "833df6a7954d9567b384b04d2dbeae507915a4908a94bceeba926da407fbb768",
        ),
        (
            "2",
            "5dfcf6a6bffad74ba6a6f95df83eaaec46142279ff741f17d1a6d8e7d15c2cd3",
        ),
        (
            "3",
            "4e929ec354859e9a04df109e1fa152654b0269fd3d6ed844742d1efc15f57132",
        ),
        (
            "4",
            "6fdefbde5e9bed0c1fc4884a92136c553cca96b952da186b5bce86a55122e473",
        ),
        (
            "5",
            "84aed3fee5399a160dffe37ad59c07ea8852baefade384091a737eb9f8a4d688",
        ),
        (
            "6",
            "bb862773b28eb8ac532113d51b08292c3d8a690032ada8f571c5018af366083e",
        ),
        (
            "7",
            "a582a5524f3ebd64b9f7aaba753dc75210069bc23d867b29d881eb60dfdbcdb2",
        ),
    ];

    #[test]
    fn a_changed_skill_has_a_new_version() {
        let current = (bundled_version(), bundled_hash());
        let last = PUBLISHED.last().unwrap();
        assert_eq!(
            (last.0, last.1),
            (current.0.as_str(), current.1.as_str()),
            "the skill's files changed: bump metadata.version in skills/draft-canvas/SKILL.md and add {current:?} to PUBLISHED"
        );
        let versions: Vec<&str> = PUBLISHED.iter().map(|(v, _)| *v).collect();
        assert!(
            versions.windows(2).all(|w| version_cmp(w[0], w[1]).is_lt()),
            "versions only go up"
        );
    }

    #[test]
    fn the_bundled_skill_has_a_version_and_its_name() {
        assert_ne!(bundled_version(), "0");
        let text = String::from_utf8_lossy(FILES[0].1);
        assert!(text.contains(&format!("name: {SKILL_NAME}\n")));
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert!(version_cmp("10", "9").is_gt());
        assert!(version_cmp("1.10", "1.9").is_gt());
        assert!(version_cmp("2", "2.0").is_eq());
        assert!(version_cmp("1", "2").is_lt());
    }

    fn installed(root: &Path) -> PathBuf {
        root.join(SKILL_NAME)
    }

    #[test]
    fn a_fresh_install_is_ready_with_its_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        assert_eq!(state_of(&installed(&root)).0, SkillState::NotInstalled);
        assert_eq!(
            install_into(&root, &tmp.path().join("backups")).unwrap(),
            None
        );
        assert_eq!(
            state_of(&installed(&root)),
            (SkillState::Ready, Some(bundled_version()))
        );
        assert!(installed(&root).join("scripts/scan_repo.py").is_file());
        // Nothing but the skill is left in the skills folder or beside it.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(installed(&root).join("scripts/check_diagram.py"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111);
        }
    }

    /// Rewrites the installed manifest as if an older Draft Canvas had written `files` as `version`.
    fn pretend_older(dir: &Path, version: &str) {
        std::fs::write(
            dir.join("references/retired.md"),
            "dropped in the newer version",
        )
        .unwrap();
        let files = read_tree(dir).unwrap();
        let hash = content_hash(files.iter().map(|(p, b)| (p.clone(), b.as_slice())));
        let manifest = Manifest {
            skill: SKILL_NAME.into(),
            version: version.into(),
            hash,
        };
        std::fs::write(dir.join(MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn an_untouched_older_copy_is_outdated_and_replaced_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        install_into(&root, &backups).unwrap();
        pretend_older(&installed(&root), "0.5");
        assert_eq!(state_of(&installed(&root)).0, SkillState::Outdated);

        assert_eq!(
            install_into(&root, &backups).unwrap(),
            None,
            "nothing of the person's to keep"
        );
        assert_eq!(state_of(&installed(&root)).0, SkillState::Ready);
        assert!(
            !installed(&root).join("references/retired.md").exists(),
            "a file the new version dropped is gone"
        );
        assert!(!backups.exists());
    }

    #[test]
    fn an_edited_copy_is_modified_and_kept_as_a_backup_when_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        install_into(&root, &backups).unwrap();
        std::fs::write(installed(&root).join("SKILL.md"), "my own instructions").unwrap();
        assert_eq!(state_of(&installed(&root)).0, SkillState::Modified);

        let backup = install_into(&root, &backups)
            .unwrap()
            .expect("the edited copy is kept");
        assert!(backup.starts_with(&backups));
        assert_eq!(
            std::fs::read_to_string(backup.join("SKILL.md")).unwrap(),
            "my own instructions"
        );
        assert_eq!(state_of(&installed(&root)).0, SkillState::Ready);
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            1,
            "the backup is not in the skills folder"
        );
    }

    #[test]
    fn a_copy_from_a_newer_app_is_never_downgraded_by_refresh() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        install_into(&root, &tmp.path().join("backups")).unwrap();
        pretend_older(&installed(&root), "999");
        assert_eq!(state_of(&installed(&root)).0, SkillState::Newer);
    }

    #[test]
    fn someone_elses_folder_of_that_name_is_modified_and_one_copied_by_hand_is_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let theirs = tmp.path().join("theirs");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(theirs.join("SKILL.md"), "---\nname: draft-canvas\n---\n").unwrap();
        assert_eq!(state_of(&theirs).0, SkillState::Modified);

        let by_hand = tmp.path().join("by-hand");
        copy_dir(&skill_dir(), &by_hand).unwrap();
        assert_eq!(state_of(&by_hand), (SkillState::Ready, None));
    }

    #[test]
    fn removing_deletes_our_copy_and_keeps_an_edited_one() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        install_into(&root, &backups).unwrap();
        assert_eq!(remove_from(&root, &backups).unwrap(), None);
        assert!(!installed(&root).exists());

        install_into(&root, &backups).unwrap();
        std::fs::write(installed(&root).join("notes.md"), "mine").unwrap();
        let kept = remove_from(&root, &backups).unwrap().expect("kept");
        assert!(kept.join("notes.md").is_file());
        assert!(!installed(&root).exists());
    }
}
