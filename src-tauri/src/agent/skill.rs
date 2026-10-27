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
use std::io::{Error, ErrorKind as IoErrorKind, Read};
use std::path::{Path, PathBuf};

/// The skill's folder name, and the `name` in its SKILL.md.
pub const SKILL_NAME: &str = "draft-canvas";

/// Written beside the skill's files on install; never part of the skill itself.
pub const MANIFEST: &str = ".draft-canvas-skill.json";

/// A bundled skill is small. An edited folder must not make startup read arbitrary amounts of data.
const MAX_TREE_BYTES: usize = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 1024;
const MAX_MANIFEST_BYTES: usize = 4096;

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

fn read_file(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let kind = std::fs::symlink_metadata(path)?;
    if !kind.is_file() || kind.len() > limit as u64 {
        return Err(Error::new(
            IoErrorKind::InvalidData,
            "not a bounded regular file",
        ));
    }
    // Bound the read too: a file may grow after its metadata was checked.
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(Error::new(IoErrorKind::InvalidData, "skill is too large"));
    }
    Ok(bytes)
}

/// Every file under `dir` but the manifest, as (relative path with `/`, bytes). Unknown entries fail
/// closed: ignoring a person's symlink made an edited old skill look safe to replace without backup.
fn read_tree(dir: &Path) -> std::io::Result<Vec<(String, Vec<u8>)>> {
    if !std::fs::symlink_metadata(dir)?.is_dir() {
        return Err(Error::new(
            IoErrorKind::InvalidData,
            "not a skill directory",
        ));
    }
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    let mut entries = 0;
    let mut remaining = MAX_TREE_BYTES;
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current)? {
            let entry = entry?;
            entries += 1;
            if entries > MAX_TREE_ENTRIES {
                return Err(Error::new(
                    IoErrorKind::InvalidData,
                    "too many skill entries",
                ));
            }
            let path = entry.path();
            let kind = entry.file_type()?;
            if !kind.is_dir() && !kind.is_file() {
                return Err(Error::new(
                    IoErrorKind::InvalidData,
                    "unsupported skill entry",
                ));
            }
            if kind.is_dir() {
                if entry.file_name() == "__pycache__" {
                    continue;
                }
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
                    let bytes = read_file(&path, remaining)?;
                    remaining -= bytes.len();
                    out.push((rel, bytes));
                }
            }
        }
    }
    Ok(out)
}

/// What is in `dir` (a skill folder), against what this app carries.
pub fn state_of(dir: &Path) -> (SkillState, Option<String>) {
    match std::fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error) if error.kind() == IoErrorKind::NotFound => {
            return (SkillState::NotInstalled, None);
        }
        _ => return (SkillState::Modified, None),
    }
    let manifest: Option<Manifest> = read_file(&dir.join(MANIFEST), MAX_MANIFEST_BYTES)
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
    let untouched =
        manifest.skill == SKILL_NAME && on_disk.as_deref() == Some(manifest.hash.as_str());
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
    match std::fs::rename(from, to) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == IoErrorKind::CrossesDevices => {}
        Err(error) => return Err(error),
    }
    copy_dir(from, to)?;
    std::fs::remove_dir_all(from)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    if !std::fs::symlink_metadata(from)?.is_dir() {
        return Err(Error::new(
            IoErrorKind::InvalidData,
            "not a skill directory",
        ));
    }
    // Never merge a backup with a previous one or follow a link outside the skill. If copying cannot
    // preserve it, fail while the original is still in place and remove only our incomplete copy.
    std::fs::create_dir(to)?;
    let result = (|| {
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                copy_dir(&entry.path(), &target)?;
            } else if kind.is_file() {
                std::fs::copy(entry.path(), &target)?;
            } else {
                return Err(Error::new(
                    IoErrorKind::InvalidData,
                    "unsupported skill entry",
                ));
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(to);
    }
    result
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
    if std::fs::symlink_metadata(&dir).is_ok() {
        let keep = matches!(state, SkillState::Modified | SkillState::Newer);
        let aside = if keep {
            let stamp = crate::util::now_ms();
            if let Err(error) = std::fs::create_dir_all(backups) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(fail("back up", error));
            }
            backups.join(format!("{SKILL_NAME}-{stamp}-{}", unique_suffix()))
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
    if std::fs::symlink_metadata(&dir).is_err_and(|error| error.kind() == IoErrorKind::NotFound) {
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
            let aside = backups.join(format!(
                "{SKILL_NAME}-{}-{}",
                crate::util::now_ms(),
                unique_suffix()
            ));
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
        (
            "8",
            "0fb3519ba92fb133c59d0cb9f2dd4ca88c48f5cdb1353239b37a58fc8d5b0ae8",
        ),
        (
            "9",
            "3a3793a7a78497e094f70fbfcc2a60e9500f48f408ede9cda5f0a7d78ffed837",
        ),
        (
            "10",
            "825a1201bfb2f108f12fde862a8c4bec802dcb7a9387c1aeb48e920fd758ec4a",
        ),
        (
            "11",
            "1e132506dc0a993d3140c4c06798df2b7b0140a18d422699103f49d13641d39c",
        ),
        (
            "12",
            "b3037114e2b970717af06d5cce0f06a3707dfd0eb125f3999c0ba71241bbf7cc",
        ),
        (
            "13",
            "ad2536c95466865bcb3c2e3b1746eb87c717f234d94d3a53996a9b48de428c7e",
        ),
        (
            "14",
            "d6ed80d825e5e5d27d553eec3f9973e08583dc595e5aeee79cb58c1c1d1c7e7f",
        ),
        (
            "15",
            "74c59c9d2b2251fe0250280203c9b8efab7d3accde4942e7505a16ed8a2c1253",
        ),
        (
            "16",
            "8149acfb9a50e6338733f3a14f7c44c40b83a6eae17c1b894e02dba2101e0ad0",
        ),
        (
            "17",
            "a24236f85f83009b529ac35f6e76881b2e69c28634245618d1241a84e21acab9",
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

    #[cfg(unix)]
    #[test]
    fn an_extra_link_in_an_old_skill_is_modified_and_preserved_on_replace() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        install_into(&root, &backups).unwrap();
        pretend_older(&installed(&root), "0.5");
        let personal = tmp.path().join("personal.md");
        std::fs::write(&personal, "my instructions").unwrap();
        symlink(&personal, installed(&root).join("personal.md")).unwrap();
        assert_eq!(state_of(&installed(&root)).0, SkillState::Modified);

        let backup = install_into(&root, &backups).unwrap().expect("kept");
        assert_eq!(
            std::fs::read_link(backup.join("personal.md")).unwrap(),
            personal
        );
        assert_eq!(state_of(&installed(&root)).0, SkillState::Ready);
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_skill_even_when_dangling_is_modified_and_its_target_is_left_alone() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        std::fs::create_dir(&root).unwrap();
        let target = tmp.path().join("personal");
        symlink(&target, installed(&root)).unwrap();
        assert_eq!(state_of(&installed(&root)).0, SkillState::Modified);
        let backup = remove_from(&root, &backups).unwrap().expect("kept");
        assert_eq!(std::fs::read_link(backup).unwrap(), target);
        assert!(std::fs::symlink_metadata(installed(&root)).is_err());
    }

    #[test]
    fn oversized_files_and_manifests_are_modified_without_reading_them_whole() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        install_into(&root, &backups).unwrap();
        let extra = installed(&root).join("huge.dat");
        std::fs::File::create(&extra)
            .unwrap()
            .set_len(MAX_TREE_BYTES as u64 + 1)
            .unwrap();
        assert!(read_tree(&installed(&root)).is_err());
        assert_eq!(state_of(&installed(&root)).0, SkillState::Modified);
        std::fs::remove_file(extra).unwrap();
        let manifest = installed(&root).join(MANIFEST);
        std::fs::File::create(&manifest)
            .unwrap()
            .set_len(MAX_MANIFEST_BYTES as u64 + 1)
            .unwrap();
        assert!(read_file(&manifest, MAX_MANIFEST_BYTES).is_err());
    }

    #[test]
    fn many_empty_directories_cannot_make_status_walk_without_a_bound() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..=MAX_TREE_ENTRIES {
            std::fs::create_dir(tmp.path().join(format!("d{i}"))).unwrap();
        }
        assert!(read_tree(tmp.path()).is_err());
        assert_eq!(state_of(tmp.path()).0, SkillState::Modified);
    }

    #[test]
    fn copying_a_backup_never_merges_with_an_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let previous = tmp.path().join("previous");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&previous).unwrap();
        std::fs::write(source.join("notes.md"), "new").unwrap();
        std::fs::write(previous.join("notes.md"), "old").unwrap();
        assert!(copy_dir(&source, &previous).is_err());
        assert_eq!(
            std::fs::read_to_string(previous.join("notes.md")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(source.join("notes.md")).unwrap(),
            "new"
        );
    }

    #[test]
    fn a_backup_failure_leaves_the_edited_skill_without_an_abandoned_staging_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let backups = tmp.path().join("backups");
        install_into(&root, &backups).unwrap();
        std::fs::write(installed(&root).join("notes.md"), "mine").unwrap();
        std::fs::write(&backups, "not a directory").unwrap();
        assert!(install_into(&root, &backups).is_err());
        assert_eq!(
            std::fs::read_to_string(installed(&root).join("notes.md")).unwrap(),
            "mine"
        );
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn copying_a_backup_refuses_links_without_touching_the_original() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let backup = tmp.path().join("backup");
        std::fs::create_dir(&source).unwrap();
        symlink(tmp.path().join("missing"), source.join("notes.md")).unwrap();
        assert!(copy_dir(&source, &backup).is_err());
        assert!(std::fs::read_link(source.join("notes.md")).is_ok());
        assert!(!backup.exists());
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
