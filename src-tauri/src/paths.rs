use std::path::{Path, PathBuf};

pub const DOC_EXT: &str = "draftcanvas";
const DEFAULT_STEM: &str = "Untitled canvas";
const MAX_STEM_CHARS: usize = 120;

/// Case-insensitive, because Finder and Explorer both let a user (or a sync client) hand us `.DraftCanvas`.
pub fn has_doc_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(DOC_EXT))
}

/// What a person calls the file: its name, whatever the OS does to non-UTF-8 bytes.
pub fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// The name without `.draftcanvas`, which is what the app shows as a document's title.
pub fn doc_stem(path: &Path) -> String {
    if has_doc_ext(path) {
        path.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_name(path))
    } else {
        file_name(path)
    }
}

/// The save dialog may return `notes` or `notes.txt`; a document is always saved as `.draftcanvas`.
/// The extension is appended rather than swapped so `plan.v2` keeps its `v2`.
pub fn force_doc_ext(path: PathBuf) -> PathBuf {
    if has_doc_ext(&path) {
        return path;
    }
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{DOC_EXT}"));
    path.with_file_name(name)
}

/// A file name the page suggested, made safe to join onto a folder: no separators, no characters
/// Windows refuses, no leading/trailing dots or spaces, and never empty.
pub fn sanitize_stem(name: &str) -> String {
    let name = name.trim();
    let name = strip_doc_ext(name);
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .take(MAX_STEM_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        DEFAULT_STEM.to_string()
    } else {
        cleaned.to_string()
    }
}

fn strip_doc_ext(name: &str) -> &str {
    let suffix = format!(".{DOC_EXT}");
    match name.len().checked_sub(suffix.len()) {
        Some(at) if name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(&suffix) => {
            &name[..at]
        }
        _ => name,
    }
}

/// A path written for a person: `~` for the home folder on macOS/Linux, and no `\\?\` prefix on
/// Windows (canonicalising adds one, and it is meaningless to the reader).
pub fn display_path(path: &Path) -> String {
    display_path_in(path, home_dir().as_deref())
}

fn display_path_in(path: &Path, home: Option<&Path>) -> String {
    let path = dunce::simplified(path);
    if cfg!(not(windows)) {
        if let Some(rest) = home.and_then(|h| path.strip_prefix(h).ok()) {
            return if rest.as_os_str().is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", rest.display())
            };
        }
    }
    path.display().to_string()
}

fn home_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_check_ignores_case() {
        assert!(has_doc_ext(Path::new("a/b.draftcanvas")));
        assert!(has_doc_ext(Path::new("B.DraftCanvas")));
        assert!(!has_doc_ext(Path::new("b.draftcanvas.txt")));
        assert!(!has_doc_ext(Path::new("draftcanvas")));
    }

    #[test]
    fn document_name_drops_only_the_document_extension() {
        assert_eq!(
            doc_stem(Path::new("/x/payment-flow.draftcanvas")),
            "payment-flow"
        );
        assert_eq!(doc_stem(Path::new("/x/plan.v2.draftcanvas")), "plan.v2");
        assert_eq!(doc_stem(Path::new("/x/readme.txt")), "readme.txt");
    }

    #[test]
    fn forcing_the_extension_appends_instead_of_replacing() {
        assert_eq!(
            force_doc_ext(PathBuf::from("/x/plan")),
            PathBuf::from("/x/plan.draftcanvas")
        );
        assert_eq!(
            force_doc_ext(PathBuf::from("/x/plan.v2")),
            PathBuf::from("/x/plan.v2.draftcanvas")
        );
        assert_eq!(
            force_doc_ext(PathBuf::from("/x/plan.DRAFTCANVAS")),
            PathBuf::from("/x/plan.DRAFTCANVAS")
        );
    }

    #[test]
    fn suggested_names_are_made_safe() {
        assert_eq!(
            sanitize_stem("  Payment / flow: v2? "),
            "Payment - flow- v2-"
        );
        assert_eq!(sanitize_stem("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(sanitize_stem("notes.draftcanvas"), "notes");
        assert_eq!(sanitize_stem(""), "Untitled canvas");
        assert_eq!(sanitize_stem(" ... "), "Untitled canvas");
        assert_eq!(
            sanitize_stem(&"x".repeat(400)).chars().count(),
            MAX_STEM_CHARS
        );
    }

    #[test]
    fn display_path_uses_tilde_for_home() {
        let home = Path::new("/Users/ada");
        if cfg!(not(windows)) {
            assert_eq!(
                display_path_in(Path::new("/Users/ada/work/a.draftcanvas"), Some(home)),
                "~/work/a.draftcanvas"
            );
            assert_eq!(display_path_in(Path::new("/Users/ada"), Some(home)), "~");
            assert_eq!(
                display_path_in(Path::new("/Users/adam/a.draftcanvas"), Some(home)),
                "/Users/adam/a.draftcanvas"
            );
        }
        assert_eq!(display_path_in(Path::new("/tmp/a"), None), "/tmp/a");
    }
}
