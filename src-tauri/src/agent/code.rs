//! Read-only access to the one code folder a person granted to a companion run. All callers share
//! these checks so a tool's arguments, a symlink, or a different spelling cannot widen that grant.

use super::broker::{ToolError, ToolResult};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Cursor, Read};
use std::path::{Path, PathBuf};

pub const CODE_TOOLS: &[&str] = &["list_code", "search_code", "read_code"];

const LIST_LIMIT: usize = 400;
const SEARCH_FILES: usize = 4_000;
const SEARCH_BYTES: usize = 2 * 1024 * 1024;
const SEARCH_MATCHES: usize = 60;
const READ_LINES: usize = 400;
const READ_BYTES: usize = 64 * 1024;
const BINARY_SAMPLE: usize = 8 * 1024;
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".idea",
    "coverage",
    "vendor",
];

fn invalid(field: &str, message: &str) -> ToolError {
    ToolError::new("INVALID_INPUT", message).details(json!({"path": field}))
}

fn outside() -> ToolError {
    ToolError::new("OUTSIDE_FOLDER", "That path is outside the allowed folder.")
        .hint("Only the folder the person allowed is readable.")
}

fn unreadable() -> ToolError {
    // OS error messages may contain absolute paths, so never forward them to the agent.
    ToolError::new("UNREADABLE_PATH", "That path could not be read.")
}

fn secret() -> ToolError {
    ToolError::new("SECRET_FILE", "That path contains a secret file.")
        .hint("The app keeps secrets out of the agent's reach.")
}

fn is_secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    (name == ".env" || name.starts_with(".env.")) && name != ".env.example" && name != ".env.sample"
        || [".npmrc", ".pypirc", ".netrc"].contains(&name.as_str())
        || ["id_rsa", "id_ed25519", "credentials"]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn object(args: &Value) -> Result<(), ToolError> {
    if !args.is_object() {
        return Err(invalid("/", "Arguments must be an object."));
    }
    Ok(())
}

fn string_arg<'a>(
    args: &'a Value,
    key: &str,
    default: Option<&'a str>,
) -> Result<&'a str, ToolError> {
    match args.get(key) {
        Some(Value::String(value)) => Ok(value),
        None => default.ok_or_else(|| invalid(&format!("/{key}"), "A string is required.")),
        _ => Err(invalid(&format!("/{key}"), "Expected a string.")),
    }
}

fn number_arg(args: &Value, key: &str, default: u64) -> Result<u64, ToolError> {
    match args.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| invalid(&format!("/{key}"), "Expected a positive integer.")),
    }
}

struct Folder {
    root: PathBuf,
    ignored: Vec<String>,
}

impl Folder {
    fn new(root: &Path) -> Result<Self, ToolError> {
        let root = dunce::canonicalize(root).map_err(|_| unreadable())?;
        if !root.is_dir() {
            return Err(unreadable());
        }
        let mut folder = Self {
            root,
            ignored: Vec::new(),
        };
        // Only the cheap, unambiguous subset is supported. In particular a symlinked .gitignore
        // must never be a way to read a second folder, even though its contents aren't returned.
        let ignore = folder.root.join(".gitignore");
        if fs::symlink_metadata(&ignore).is_ok_and(|m| m.is_file()) {
            if let Ok(file) = File::open(ignore) {
                let mut text = String::new();
                if file
                    .take(READ_BYTES as u64)
                    .read_to_string(&mut text)
                    .is_ok()
                {
                    folder.ignored = text
                        .lines()
                        .map(str::trim)
                        .filter(|line| {
                            !line.is_empty()
                                && !line.starts_with(['#', '!'])
                                && !line.contains(['?', '[', ']', '\\'])
                        })
                        .map(|line| line.trim_matches('/').to_string())
                        .filter(|line| {
                            !line.is_empty()
                                && !line.contains('/')
                                && (!line.contains('*')
                                    || line.starts_with("*.") && !line[1..].contains('*'))
                        })
                        .collect();
                }
            }
        }
        Ok(folder)
    }

    fn check_names(&self, path: &Path) -> Result<(), ToolError> {
        let relative = path.strip_prefix(&self.root).map_err(|_| outside())?;
        let mut current = self.root.clone();
        for part in relative.iter() {
            let name = part.to_str().ok_or_else(unreadable)?;
            current.push(part);
            if is_secret(name) {
                return Err(secret());
            }
            let directory = current.is_dir();
            if directory && SKIP_DIRS.contains(&name.to_ascii_lowercase().as_str())
                || self.ignored.iter().any(|pattern| {
                    pattern
                        .strip_prefix('*')
                        .map_or(directory && pattern == name, |suffix| {
                            name.ends_with(suffix)
                        })
                })
            {
                return Err(ToolError::new(
                    "EXCLUDED_PATH",
                    "That path is excluded from code access.",
                ));
            }
        }
        Ok(())
    }

    fn resolve(&self, path: &str, walking: bool) -> Result<PathBuf, ToolError> {
        // Reject Windows drive/UNC spellings on Unix too. Backslashes are not this API's separator.
        if path.starts_with('/') || path.starts_with('\\') || path.as_bytes().get(1) == Some(&b':')
        {
            return Err(outside());
        }
        if path.contains(['\\', '\0', ':']) {
            return Err(invalid(
                "/path",
                "Use a relative path with forward slashes.",
            ));
        }
        let mut depth = 0_usize;
        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." if depth == 0 => return Err(outside()),
                ".." => depth -= 1,
                _ => depth += 1,
            }
        }
        let mut current = self.root.clone();
        for part in path.split('/') {
            match part {
                "" | "." => continue,
                ".." => {
                    if current == self.root || !current.pop() {
                        return Err(outside());
                    }
                }
                name => current.push(name),
            }
            // Check every prefix before consuming '..': normalizing first could hide an escape
            // through a symlink or a visit to an excluded directory.
            let canonical = dunce::canonicalize(&current).map_err(|_| unreadable())?;
            if !canonical.starts_with(&self.root) {
                return Err(outside());
            }
            self.check_names(&current)?;
            self.check_names(&canonical)?;
            if walking
                && fs::symlink_metadata(&current)
                    .map_err(|_| unreadable())?
                    .is_symlink()
            {
                return Err(unreadable());
            }
        }
        let canonical = dunce::canonicalize(&current).map_err(|_| unreadable())?;
        if !canonical.starts_with(&self.root) {
            return Err(outside());
        }
        self.check_names(&canonical)?;
        Ok(canonical)
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(Path::new(""))
            .iter()
            .filter_map(|part| part.to_str())
            .collect::<Vec<_>>()
            .join("/")
    }

    fn children(&self, path: &Path) -> Result<Vec<(PathBuf, bool)>, ToolError> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(path).map_err(|_| unreadable())?.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) {
                continue;
            }
            let path = entry.path();
            let Some(relative) = path.strip_prefix(&self.root).ok().and_then(Path::to_str) else {
                continue;
            };
            // Recheck containment and exclusions at the point of use, not just at the walk's root.
            if self
                .resolve(&relative.replace(std::path::MAIN_SEPARATOR, "/"), true)
                .is_err()
            {
                continue;
            }
            entries.push((path, kind.is_dir()));
        }
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(entries)
    }
}

/// Lists ordinary files and directories to a bounded depth, without following symlinks.
pub fn list_code(root: &Path, args: &Value) -> ToolResult {
    object(args)?;
    let path = string_arg(args, "path", Some(""))?;
    let depth = number_arg(args, "depth", 2)?;
    if depth > 4 {
        return Err(invalid("/depth", "Depth must be between 1 and 4."));
    }
    let folder = Folder::new(root)?;
    let base = folder.resolve(path, true)?;
    let mut pending = vec![(base.clone(), depth)];
    let mut entries = Vec::new();
    while let Some((directory, remaining)) = pending.pop() {
        for (path, is_dir) in folder.children(&directory)? {
            if is_dir && remaining > 1 {
                pending.push((path.clone(), remaining - 1));
            }
            entries.push((folder.relative(&path), is_dir));
            if entries.len() > LIST_LIMIT {
                break;
            }
        }
        if entries.len() > LIST_LIMIT {
            break;
        }
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let truncated = entries.len() > LIST_LIMIT;
    entries.truncate(LIST_LIMIT);
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(path, dir)| json!({"path": path, "type": if dir { "directory" } else { "file" }}))
        .collect();
    Ok(json!({"path": folder.relative(&base), "entries": entries, "truncated": truncated}))
}

fn glob_arg(args: &Value) -> Result<&str, ToolError> {
    let glob = string_arg(args, "glob", Some("**"))?;
    if glob.is_empty()
        || glob.chars().count() > 512
        || glob.starts_with('/')
        || glob.contains(['\\', ':', '?', '[', ']', '{', '}', '\0'])
        || glob.split('/').any(|part| part == "..")
    {
        return Err(invalid(
            "/glob",
            "Use a relative glob with only * and ** wildcards.",
        ));
    }
    Ok(glob)
}

fn star_matches(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    let (mut p, mut t, mut star, mut retry) = (0, 0, None, 0);
    while t < text.len() {
        if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = t;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some(at) = star {
            retry += 1;
            t = retry;
            p = at + 1;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|b| *b == b'*')
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    if !pattern.contains('/') {
        return star_matches(pattern, path.rsplit('/').next().unwrap_or(path));
    }
    let parts: Vec<_> = path.split('/').collect();
    let mut matched = vec![false; parts.len() + 1];
    matched[0] = true;
    for pattern in pattern.split('/') {
        let mut next = vec![false; parts.len() + 1];
        for i in 0..=parts.len() {
            if pattern == "**" {
                next[i] = matched[i] || i > 0 && next[i - 1];
            } else if i > 0 {
                next[i] = matched[i - 1] && star_matches(pattern, parts[i - 1]);
            }
        }
        matched = next;
    }
    matched[parts.len()]
}

fn text_reader(path: &Path) -> Result<impl BufRead, ToolError> {
    let mut file = File::open(path).map_err(|_| unreadable())?;
    if !file.metadata().map_err(|_| unreadable())?.is_file() {
        return Err(unreadable());
    }
    let mut sample = Vec::new();
    Read::by_ref(&mut file)
        .take(BINARY_SAMPLE as u64)
        .read_to_end(&mut sample)
        .map_err(|_| unreadable())?;
    if sample.contains(&0) {
        return Err(ToolError::new(
            "BINARY_FILE",
            "Binary files cannot be read as code.",
        ));
    }
    // Replay the sample from memory so search's byte budget includes binary detection.
    Ok(BufReader::new(Cursor::new(sample).chain(file)))
}

/// Searches literal text, with Unicode lowercase matching and paths relative to the granted root.
pub fn search_code(root: &Path, args: &Value) -> ToolResult {
    object(args)?;
    let query = string_arg(args, "query", None)?;
    if !(1..=200).contains(&query.chars().count()) {
        return Err(invalid("/query", "Query must contain 1 to 200 characters."));
    }
    let path = string_arg(args, "path", Some(""))?;
    let glob = glob_arg(args)?;
    let folder = Folder::new(root)?;
    let base = folder.resolve(path, true)?;
    let mut pending = vec![base];
    let mut scanned = 0;
    let mut matches = Vec::new();
    let mut truncated = false;
    let query = query.to_lowercase();
    'walk: while let Some(path) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let mut children = folder.children(&path)?;
            children.reverse();
            pending.extend(children.into_iter().map(|(path, _)| path));
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if scanned == SEARCH_FILES {
            truncated = true;
            break;
        }
        scanned += 1;
        let relative = folder.relative(&path);
        if !glob_matches(glob, &relative) {
            continue;
        }
        let Ok(mut reader) = text_reader(&path) else {
            continue;
        };
        let mut bytes = Vec::new();
        if Read::by_ref(&mut reader)
            .take(SEARCH_BYTES as u64)
            .read_to_end(&mut bytes)
            .is_err()
        {
            continue;
        }
        if metadata.len() > SEARCH_BYTES as u64 {
            truncated = true;
            // Do not report a partial final line as a complete match.
            bytes.truncate(SEARCH_BYTES);
            let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            bytes.truncate(end);
        }
        for (line, text) in String::from_utf8_lossy(&bytes).lines().enumerate() {
            if text.to_lowercase().contains(&query) {
                if matches.len() == SEARCH_MATCHES {
                    truncated = true;
                    break 'walk;
                }
                matches.push(json!({
                    "path": relative,
                    "line": line + 1,
                    "text": text.trim().chars().take(200).collect::<String>(),
                }));
            }
        }
    }
    Ok(json!({"matches": matches, "truncated": truncated}))
}

// Keep memory bounded even for a generated file containing one enormous line. The rest of that
// line is consumed to preserve line numbering and totalLines, without retaining it in memory.
fn bounded_line(reader: &mut impl BufRead) -> Result<Option<(String, bool)>, ToolError> {
    let mut bytes = Vec::new();
    let mut seen = false;
    let mut clipped = false;
    loop {
        let buffer = reader.fill_buf().map_err(|_| unreadable())?;
        if buffer.is_empty() {
            if !seen {
                return Ok(None);
            }
            break;
        }
        seen = true;
        let newline = buffer.iter().position(|b| *b == b'\n');
        let content = newline.unwrap_or(buffer.len());
        let keep = content.min(READ_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        clipped |= keep < content;
        reader.consume(content + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    Ok(Some((
        String::from_utf8_lossy(&bytes).into_owned(),
        clipped,
    )))
}

fn byte_prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Reads a numbered range. totalLines counts the file, including lines outside the returned range.
pub fn read_code(root: &Path, args: &Value) -> ToolResult {
    object(args)?;
    let path = string_arg(args, "path", None)?;
    if path.is_empty() {
        return Err(invalid("/path", "A file path is required."));
    }
    let start = number_arg(args, "startLine", 1)?;
    let end = number_arg(args, "endLine", u64::MAX)?;
    if end < start {
        return Err(invalid("/endLine", "endLine must be at least startLine."));
    }
    let folder = Folder::new(root)?;
    let path = folder.resolve(path, false)?;
    let mut reader = text_reader(&path)?;
    let mut text = String::new();
    let mut total = 0_u64;
    let mut last = start - 1;
    let mut count = 0;
    let mut truncated = false;
    while let Some((line, clipped)) = bounded_line(&mut reader)? {
        total += 1;
        if total < start || total > end {
            continue;
        }
        if count == READ_LINES || truncated {
            truncated = true;
            continue;
        }
        let prefix = format!("{total}: ");
        let available = READ_BYTES.saturating_sub(text.len());
        if available < prefix.len() + 1 {
            truncated = true;
            continue;
        }
        let content = byte_prefix(&line, available - prefix.len() - 1);
        truncated |= clipped || content.len() < line.len();
        text.push_str(&prefix);
        text.push_str(content);
        text.push('\n');
        last = total;
        count += 1;
    }
    let mut result = json!({
        "path": folder.relative(&path),
        "startLine": start,
        "endLine": last,
        "totalLines": total,
        "text": text,
        "truncated": truncated,
    });
    if truncated {
        result["hint"] = json!("Ask for the next line range to continue reading.");
    }
    Ok(result)
}

/// The nearest repository above a diagram, bounded by home; otherwise the diagram's own folder.
pub fn candidate_folder(diagram_file: &Path, home: Option<&Path>) -> PathBuf {
    let own = diagram_file.parent().unwrap_or(Path::new(""));
    let own = dunce::canonicalize(own).unwrap_or_else(|_| own.to_path_buf());
    let home = home.map(|path| dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()));
    for ancestor in own.ancestors() {
        if home
            .as_ref()
            .is_some_and(|home| !ancestor.starts_with(home))
        {
            break;
        }
        if fs::symlink_metadata(ancestor.join(".git")).is_ok() {
            return ancestor.to_path_buf();
        }
    }
    own
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(root: &Path, path: &str, contents: impl AsRef<[u8]>) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn error(root: &Path, args: Value, code: &str) -> ToolError {
        let error = read_code(root, &args).unwrap_err();
        assert_eq!(error.code, code);
        error
    }

    #[test]
    fn tool_names_and_defaults() {
        assert_eq!(CODE_TOOLS, &["list_code", "search_code", "read_code"]);
        let dir = TempDir::new().unwrap();
        write(dir.path(), "src/main.rs", "Hello\nWorld\n");
        let list = list_code(dir.path(), &json!({})).unwrap();
        assert_eq!(list["path"], "");
        assert_eq!(
            list["entries"][0],
            json!({"path": "src", "type": "directory"})
        );
        assert_eq!(list["entries"][1]["path"], "src/main.rs");
        assert_eq!(list["truncated"], false);
        let read = read_code(dir.path(), &json!({"path": "src/./main.rs"})).unwrap();
        assert_eq!(
            read,
            json!({
                "path": "src/main.rs", "startLine": 1, "endLine": 2,
                "totalLines": 2, "text": "1: Hello\n2: World\n", "truncated": false,
            })
        );
    }

    #[test]
    fn rejects_absolute_and_escaping_paths_for_every_tool() {
        let dir = TempDir::new().unwrap();
        for path in [
            "/etc/passwd",
            "../outside",
            "a/../../outside",
            "C:/secret",
            "\\\\host\\share",
        ] {
            fs::create_dir_all(dir.path().join("a")).unwrap();
            let error = error(dir.path(), json!({"path": path}), "OUTSIDE_FOLDER");
            assert!(error.hint.unwrap().contains("folder the person allowed"));
            assert_eq!(
                list_code(dir.path(), &json!({"path": path}))
                    .unwrap_err()
                    .code,
                "OUTSIDE_FOLDER"
            );
            assert_eq!(
                search_code(dir.path(), &json!({"path": path, "query": "x"}))
                    .unwrap_err()
                    .code,
                "OUTSIDE_FOLDER"
            );
        }
        write(dir.path(), "a/file", "safe");
        assert!(read_code(dir.path(), &json!({"path": "a/../a/file"})).is_ok());
    }

    #[test]
    fn skips_and_refuses_every_excluded_directory() {
        let dir = TempDir::new().unwrap();
        for name in SKIP_DIRS {
            write(dir.path(), &format!("{name}/hidden.txt"), "needle");
            error(
                dir.path(),
                json!({"path": format!("{name}/hidden.txt")}),
                "EXCLUDED_PATH",
            );
            assert!(list_code(dir.path(), &json!({"path": name})).is_err());
            assert!(search_code(dir.path(), &json!({"path": name, "query": "needle"})).is_err());
        }
        assert_eq!(
            list_code(dir.path(), &json!({})).unwrap()["entries"],
            json!([])
        );
        assert_eq!(
            search_code(dir.path(), &json!({"query": "needle"})).unwrap()["matches"],
            json!([])
        );
    }

    #[test]
    fn skips_and_refuses_secrets_but_keeps_examples() {
        let dir = TempDir::new().unwrap();
        for name in [
            ".env",
            ".env.local",
            ".env.production",
            "cert.pem",
            "private.key",
            "cert.p12",
            "cert.pfx",
            "app.keystore",
            "id_rsa",
            "id_rsa.pub",
            "id_ed25519_backup",
            ".npmrc",
            ".pypirc",
            ".netrc",
            "credentials",
            "credentials.json",
            "vault.kdbx",
            "PRIVATE.KEY",
        ] {
            write(dir.path(), name, "needle");
            let err = error(dir.path(), json!({"path": name}), "SECRET_FILE");
            assert!(err.hint.unwrap().contains("keeps secrets out"));
        }
        for name in [".env.example", ".env.sample"] {
            write(dir.path(), name, "needle");
            assert!(read_code(dir.path(), &json!({"path": name})).is_ok());
        }
        assert_eq!(
            list_code(dir.path(), &json!({})).unwrap()["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            search_code(dir.path(), &json!({"query": "needle"})).unwrap()["matches"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn respects_simple_root_gitignore() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            ".gitignore",
            "# generated\ncache/\n*.log\n!unsupported\n",
        );
        write(dir.path(), "cache/a.txt", "needle");
        write(dir.path(), "nested/cache/a.txt", "needle");
        write(dir.path(), "nested/file.log", "needle");
        write(dir.path(), "src/file.rs", "needle");
        error(dir.path(), json!({"path": "cache/a.txt"}), "EXCLUDED_PATH");
        error(
            dir.path(),
            json!({"path": "nested/file.log"}),
            "EXCLUDED_PATH",
        );
        let found = search_code(dir.path(), &json!({"query": "needle"})).unwrap();
        assert_eq!(
            found["matches"],
            json!([{"path": "src/file.rs", "line": 1, "text": "needle"}])
        );
    }

    #[test]
    fn rejects_binary_files_in_first_eight_kib_and_search_skips_them() {
        let dir = TempDir::new().unwrap();
        let mut bytes = vec![b'x'; BINARY_SAMPLE];
        bytes[BINARY_SAMPLE - 1] = 0;
        write(dir.path(), "binary.dat", bytes);
        error(dir.path(), json!({"path": "binary.dat"}), "BINARY_FILE");
        assert_eq!(
            search_code(dir.path(), &json!({"query": "x"})).unwrap()["matches"],
            json!([])
        );
    }

    #[test]
    fn list_depth_order_and_limit() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "z-dir/nested/deep/file", "");
        write(dir.path(), "a-dir/child", "");
        write(dir.path(), "a-file", "");
        let one = list_code(dir.path(), &json!({"depth": 1})).unwrap();
        let paths: Vec<_> = one["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, ["a-dir", "z-dir", "a-file"]);
        assert_eq!(
            list_code(dir.path(), &json!({"depth": 4})).unwrap()["entries"]
                .as_array()
                .unwrap()
                .len(),
            7
        );
        for index in 0..405 {
            write(dir.path(), &format!("f{index:03}"), "");
        }
        let listed = list_code(dir.path(), &json!({})).unwrap();
        assert_eq!(listed["entries"].as_array().unwrap().len(), LIST_LIMIT);
        assert_eq!(listed["truncated"], true);
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries[0]["type"], "directory");
        assert_eq!(entries[1]["type"], "directory");
    }

    #[test]
    fn search_is_literal_case_insensitive_and_supports_globs() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "src/main.rs",
            "  HELLO.* ÉCOLE  \nhello anything\n",
        );
        write(dir.path(), "src/nested/lib.rs", "hello.* école\n");
        write(dir.path(), "src/main.ts", "hello.* école\n");
        write(dir.path(), "elsewhere/lib.rs", "hello.* école\n");
        let found = search_code(
            dir.path(),
            &json!({"query": "hello.* école", "glob": "src/**/*.rs"}),
        )
        .unwrap();
        assert_eq!(found["matches"].as_array().unwrap().len(), 2);
        assert_eq!(
            found["matches"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["path"] == "src/main.rs")
                .unwrap(),
            &json!({"path": "src/main.rs", "line": 1, "text": "HELLO.* ÉCOLE"})
        );
        let found = search_code(
            dir.path(),
            &json!({"query": "HELLO", "path": "src", "glob": "*.ts"}),
        )
        .unwrap();
        assert_eq!(found["matches"].as_array().unwrap().len(), 1);
        assert_eq!(found["matches"][0]["path"], "src/main.ts");
        assert!(glob_matches("src/**/a*.rs", "src/a.rs"));
        assert!(glob_matches("src/**/a*.rs", "src/a/b/abc.rs"));
        assert!(!glob_matches("src/*.rs", "src/a/b.rs"));
        assert!(!glob_matches("*.rs", "file.ts"));
    }

    #[test]
    fn search_caps_matches_and_unicode_text() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "many.txt",
            format!("  {}  \n", "É".repeat(230)).repeat(61),
        );
        let found = search_code(dir.path(), &json!({"query": "é"})).unwrap();
        assert_eq!(found["matches"].as_array().unwrap().len(), SEARCH_MATCHES);
        assert_eq!(
            found["matches"][0]["text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            200
        );
        assert_eq!(found["truncated"], true);
        write(dir.path(), "many.txt", "x\n".repeat(60));
        assert_eq!(
            search_code(dir.path(), &json!({"query": "x"})).unwrap()["truncated"],
            false
        );
    }

    #[test]
    fn search_caps_file_size() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "large.txt",
            format!("needle\n{}\nneedle", "x".repeat(SEARCH_BYTES)),
        );
        let found = search_code(dir.path(), &json!({"query": "needle"})).unwrap();
        assert_eq!(found["matches"].as_array().unwrap().len(), 1);
        assert_eq!(found["truncated"], true);
        write(
            dir.path(),
            "large.txt",
            format!("{}needle", "x".repeat(SEARCH_BYTES - 6)),
        );
        let exact = search_code(dir.path(), &json!({"query": "needle"})).unwrap();
        assert_eq!(exact["matches"].as_array().unwrap().len(), 1);
        assert_eq!(exact["truncated"], false);
    }

    #[test]
    fn search_caps_scanned_files_even_when_glob_does_not_match() {
        let dir = TempDir::new().unwrap();
        for index in 0..SEARCH_FILES {
            write(dir.path(), &format!("{index:04}.txt"), "");
        }
        write(dir.path(), "z.rs", "needle");
        let found = search_code(dir.path(), &json!({"query": "needle", "glob": "*.rs"})).unwrap();
        assert_eq!(found["matches"], json!([]));
        assert_eq!(found["truncated"], true);
    }

    #[test]
    fn read_ranges_line_limit_empty_files_and_line_endings() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "lines.txt", "first\r\n\r\nlast");
        let read = read_code(
            dir.path(),
            &json!({"path": "lines.txt", "startLine": 2, "endLine": 3}),
        )
        .unwrap();
        assert_eq!(read["text"], "2: \n3: last\n");
        assert_eq!(read["totalLines"], 3);
        assert_eq!(read["endLine"], 3);
        assert_eq!(read["truncated"], false);
        write(dir.path(), "lines.txt", "line\n".repeat(450));
        let read = read_code(dir.path(), &json!({"path": "lines.txt"})).unwrap();
        assert_eq!(read["totalLines"], 450);
        assert_eq!(read["endLine"], 400);
        let range = read_code(dir.path(), &json!({"path": "lines.txt", "endLine": 400})).unwrap();
        assert_eq!(range["truncated"], false);
        assert_eq!(read["text"].as_str().unwrap().lines().count(), READ_LINES);
        assert_eq!(read["truncated"], true);
        assert!(read["hint"].as_str().unwrap().contains("next line range"));
        let next = read_code(dir.path(), &json!({"path": "lines.txt", "startLine": 401})).unwrap();
        assert_eq!(next["endLine"], 450);
        assert_eq!(next["truncated"], false);
        write(dir.path(), "empty.txt", "");
        let empty = read_code(dir.path(), &json!({"path": "empty.txt"})).unwrap();
        assert_eq!(empty["totalLines"], 0);
        assert_eq!(empty["endLine"], 0);
        assert_eq!(empty["text"], "");
        assert_eq!(empty["truncated"], false);
        let beyond =
            read_code(dir.path(), &json!({"path": "lines.txt", "startLine": 999})).unwrap();
        assert_eq!(beyond["text"], "");
        assert_eq!(beyond["truncated"], false);
    }

    #[test]
    fn read_caps_bytes_including_prefixes_and_handles_enormous_lines() {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "huge.txt",
            format!("{}\nnext\n", "é".repeat(READ_BYTES * 2)),
        );
        let read = read_code(dir.path(), &json!({"path": "huge.txt"})).unwrap();
        assert!(read["text"].as_str().unwrap().len() <= READ_BYTES);
        assert_eq!(read["totalLines"], 2);
        assert_eq!(read["endLine"], 1);
        assert_eq!(read["truncated"], true);
        let next = read_code(dir.path(), &json!({"path": "huge.txt", "startLine": 2})).unwrap();
        assert_eq!(next["text"], "2: next\n");
        assert_eq!(next["truncated"], false);
        write(
            dir.path(),
            "huge.txt",
            format!("{}\n", "x".repeat(200)).repeat(400),
        );
        let read = read_code(dir.path(), &json!({"path": "huge.txt"})).unwrap();
        assert!(read["text"].as_str().unwrap().len() <= READ_BYTES);
        assert_eq!(read["truncated"], true);
        assert_eq!(read["totalLines"], 400);
    }

    #[test]
    fn invalid_arguments_have_json_pointer_details() {
        let dir = TempDir::new().unwrap();
        for (args, field) in [
            (json!({}), "/path"),
            (json!({"path": 3}), "/path"),
            (json!({"path": ""}), "/path"),
            (json!({"path": "a\\b"}), "/path"),
            (json!({"path": "x", "startLine": 0}), "/startLine"),
            (json!({"path": "x", "startLine": 1.5}), "/startLine"),
            (json!({"path": "x", "endLine": -1}), "/endLine"),
            (
                json!({"path": "x", "startLine": 5, "endLine": 4}),
                "/endLine",
            ),
            (json!([]), "/"),
        ] {
            let err = error(dir.path(), args, "INVALID_INPUT");
            assert_eq!(err.details, Some(json!({"path": field})));
        }
        for depth in [json!(0), json!(5), json!(1.5), Value::Null, json!("2")] {
            let err = list_code(dir.path(), &json!({"depth": depth})).unwrap_err();
            assert_eq!(err.code, "INVALID_INPUT");
            assert_eq!(err.details, Some(json!({"path": "/depth"})));
        }
        for args in [
            json!({}),
            json!({"query": ""}),
            json!({"query": "x".repeat(201)}),
            json!({"query": true}),
        ] {
            let err = search_code(dir.path(), &args).unwrap_err();
            assert_eq!(err.code, "INVALID_INPUT");
            assert_eq!(err.details, Some(json!({"path": "/query"})));
        }
        for glob in ["", "/absolute", "../escape", "?.rs", "[ab].rs", "a\\b"] {
            let err = search_code(dir.path(), &json!({"query": "x", "glob": glob})).unwrap_err();
            assert_eq!(err.code, "INVALID_INPUT");
            assert_eq!(err.details, Some(json!({"path": "/glob"})));
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_or_disguise_secrets_and_walks_skip_them() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        write(outside_dir.path(), "outside.txt", "needle");
        symlink(outside_dir.path(), dir.path().join("escape")).unwrap();
        for path in ["escape", "escape/outside.txt", "escape/../x"] {
            error(dir.path(), json!({"path": path}), "OUTSIDE_FOLDER");
            assert_eq!(
                list_code(dir.path(), &json!({"path": path}))
                    .unwrap_err()
                    .code,
                "OUTSIDE_FOLDER"
            );
            assert_eq!(
                search_code(dir.path(), &json!({"query": "needle", "path": path}))
                    .unwrap_err()
                    .code,
                "OUTSIDE_FOLDER"
            );
        }
        write(dir.path(), ".env", "needle");
        write(dir.path(), "target/file.rs", "needle");
        write(dir.path(), "safe/file.rs", "needle");
        symlink(dir.path().join(".env"), dir.path().join("alias.txt")).unwrap();
        symlink(dir.path().join("target"), dir.path().join("alias-dir")).unwrap();
        symlink(dir.path().join("safe"), dir.path().join("safe-link")).unwrap();
        symlink(dir.path(), dir.path().join("loop")).unwrap();
        error(dir.path(), json!({"path": "alias.txt"}), "SECRET_FILE");
        error(
            dir.path(),
            json!({"path": "alias-dir/file.rs"}),
            "EXCLUDED_PATH",
        );
        assert!(list_code(dir.path(), &json!({"path": "safe-link"})).is_err());
        assert!(search_code(dir.path(), &json!({"query": "needle", "path": "safe-link"})).is_err());
        symlink(
            outside_dir.path().join("outside.txt"),
            dir.path().join(".gitignore"),
        )
        .unwrap();
        let listed = list_code(dir.path(), &json!({"depth": 4})).unwrap();
        assert_eq!(listed["entries"].as_array().unwrap().len(), 2);
        let found = search_code(dir.path(), &json!({"query": "needle"})).unwrap();
        assert_eq!(
            found["matches"],
            json!([{"path": "safe/file.rs", "line": 1, "text": "needle"}])
        );
        assert!(!listed.to_string().contains(dir.path().to_str().unwrap()));
        assert!(!found
            .to_string()
            .contains(outside_dir.path().to_str().unwrap()));
    }

    #[test]
    fn candidate_uses_nearest_git_entry_and_stops_at_home() {
        let dir = TempDir::new().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let own = root.join("home/project/docs");
        fs::create_dir_all(&own).unwrap();
        let diagram = own.join("diagram.draftcanvas");
        assert_eq!(candidate_folder(&diagram, Some(&root.join("home"))), own);
        fs::create_dir(root.join(".git")).unwrap();
        assert_eq!(candidate_folder(&diagram, Some(&root.join("home"))), own);
        assert_eq!(candidate_folder(&diagram, None), root);
        // Worktrees use a .git file; repository discovery must accept either kind of entry.
        write(&root, "home/project/.git", "gitdir: elsewhere");
        assert_eq!(
            candidate_folder(&diagram, Some(&root.join("home"))),
            root.join("home/project")
        );
        fs::create_dir(own.join(".git")).unwrap();
        assert_eq!(candidate_folder(&diagram, Some(&own)), own);
        assert_eq!(
            candidate_folder(&diagram, Some(&root.join("unrelated"))),
            own
        );
    }

    #[test]
    fn errors_do_not_expose_machine_paths() {
        let dir = TempDir::new().unwrap();
        let err = error(dir.path(), json!({"path": "missing"}), "UNREADABLE_PATH");
        assert!(!serde_json::to_string(&err)
            .unwrap()
            .contains(dir.path().to_str().unwrap()));
        assert!(read_code(dir.path(), &json!({"path": "."})).is_err());
    }
}
