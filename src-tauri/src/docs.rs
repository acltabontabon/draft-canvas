//! Use in docs: the pictures of a diagram that Markdown files show, kept beside its source — the
//! whole diagram as `<name>.svg`, a level inside it as `<name>.<level>.svg` — and the one line a
//! person may ask to have added to a Markdown file. Pure functions over paths and bytes, like
//! `docio`, so every rule here is tested without a window.
//!
//! The rules, all enforced here rather than trusted to the page:
//! - Only a file Draft Canvas made is ever replaced. An SVG beside the diagram that doesn't carry the
//!   docs note (`MARKER`) is someone else's, and is refused, never overwritten. So is a symlink.
//! - The picture is written whole or not at all (temp file and rename), and not at all when the bytes
//!   are the ones already there, so an unchanged diagram leaves the repository unchanged.
//! - A Markdown file is only ever *added to*: the new text must be the old text with one contiguous
//!   block inserted, and the old text must be the file as the person saw it (its stamp).

use crate::docio::{self, create_new_atomic, write_in_place};
use crate::errors::{AppError, ErrorKind, Subject, Verb};
use crate::paths::file_name;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The docs note's opening tag, exactly as `src/export/docs/marker.ts` writes it.
pub const MARKER: &str = "<metadata id=\"draftcanvas-docs\">";
/// A picture with a large background image inside it can be several megabytes; this is well past that.
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
/// Documentation, not a book: a Markdown file larger than this is refused rather than rewritten.
pub const MAX_MARKDOWN_BYTES: u64 = 4 * 1024 * 1024;
/// One image reference and the blank lines around it; anything longer isn't what the page offered.
const MAX_INSERTION_BYTES: usize = 8 * 1024;
const MARKDOWN_EXTENSIONS: [&str; 3] = ["md", "markdown", "mdx"];
const BOM: &str = "\u{feff}";

/// Pictures of one diagram read per status; a folder holding more is someone's archive, not docs.
pub const MAX_IMAGES: usize = 64;
/// The level part of a picture's name: `ledger`, `online-store.store-api`.
const MAX_LEVEL_CHARS: usize = 200;

fn stem_of(doc: &Path) -> String {
    doc.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `payments.draftcanvas` → `payments.svg`, in the same folder: the whole diagram's picture.
pub fn image_path(doc: &Path) -> PathBuf {
    doc.with_file_name(format!("{}.svg", stem_of(doc)))
}

/// One dot-separated level part: a name the page made from a shape's name, never a path.
fn is_level_part(part: &str) -> bool {
    !part.is_empty()
        && part
            .chars()
            .all(|c| !(c.is_control() || c.is_whitespace() || "/\\:<>\"|?*.".contains(c)))
}

/// Whether `name` is a picture name of `doc`: `<stem>.svg` or `<stem>.<level>.svg`. The page names
/// the picture; this is what keeps that name one file beside the diagram, never a path out of its
/// folder. Case doesn't matter, as it doesn't to the disks most people use (macOS, Windows): a
/// `Payments.SVG` there is the same file as `payments.svg`.
fn is_picture_name(doc: &Path, name: &str) -> bool {
    let (name, stem) = (name.to_lowercase(), stem_of(doc).to_lowercase());
    let Some(rest) = name
        .strip_prefix(stem.as_str())
        .and_then(|rest| rest.strip_suffix(".svg"))
    else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    rest.strip_prefix('.').is_some_and(|level| {
        level.chars().count() <= MAX_LEVEL_CHARS && level.split('.').all(is_level_part)
    })
}

/// The picture of `doc` called `name`, beside it — or an error when `name` isn't one of its pictures.
pub fn named_image_path(doc: &Path, name: &str) -> Result<PathBuf, AppError> {
    if !is_picture_name(doc, name) {
        return Err(AppError::bad_request(&format!(
            "{name} isn't a picture name for {}",
            file_name(doc)
        )));
    }
    Ok(doc.with_file_name(name))
}

/// Every file beside `doc` named like one of its pictures, by name, with what is in each. Whether a
/// picture of ours was drawn from *this* diagram is its note's to say; the page reads that. With
/// `full` false only the start of each file is read, for its note: what a save's redraw needs,
/// without carrying megabytes of picture back and forth on every save.
pub fn list_images(doc: &Path, full: bool) -> Result<Vec<(String, ImageRead)>, AppError> {
    let Some(dir) = doc.parent() else {
        return Ok(Vec::new());
    };
    let entries =
        fs::read_dir(dir).map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(dir)))?;
    let mut names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_picture_name(doc, name))
        .collect();
    names.sort();
    names.truncate(MAX_IMAGES);
    names
        .into_iter()
        .map(|name| {
            // One unreadable file is listed as someone else's, not a failure of the whole listing:
            // a listing that failed left the page unable to tell which names were free.
            let read = read_image(&dir.join(&name), full).unwrap_or(ImageRead {
                state: ImageState::Foreign,
                text: None,
                marker: None,
                modified_ms: None,
            });
            Ok((name, read))
        })
        .filter(|read| {
            !matches!(
                read,
                Ok((
                    _,
                    ImageRead {
                        state: ImageState::None,
                        ..
                    }
                ))
            )
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageState {
    /// Nothing there yet.
    None,
    /// A picture Draft Canvas published: it may be replaced.
    Ours,
    /// Something else with that name — never written over.
    Foreign,
}

pub struct ImageRead {
    pub state: ImageState,
    /// The SVG's text, only when it is ours and was read in full.
    pub text: Option<String>,
    /// The note's JSON (`{"v":1,"source":…}`), only when it is ours.
    pub marker: Option<String>,
    pub modified_ms: Option<f64>,
}

/// The note sits right after the `<svg>` tag and its `<title>`; this much of a file always holds it.
const NOTE_WITHIN_BYTES: u64 = 64 * 1024;

/// The note's JSON in `text`, unescaped as `escapeXmlText` escaped it.
fn marker_of(text: &str) -> Option<String> {
    let start = text.find(MARKER)? + MARKER.len();
    let end = start + text[start..].find("</metadata>")?;
    Some(
        text[start..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

/// Whether a note names `doc` as the diagram its picture was drawn from.
fn drawn_from(doc: &Path, marker: Option<&str>) -> bool {
    let source = marker
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|note| note.get("source")?.as_str().map(str::to_lowercase));
    source.is_some_and(|source| source == file_name(doc).to_lowercase())
}

/// What is at `path` now, read without following a symlink: the whole file with `full`, else only
/// as much as holds its note.
pub fn read_image(path: &Path, full: bool) -> Result<ImageRead, AppError> {
    let io_err = |e: io::Error| AppError::from_io(&e, Verb::Open, Subject::Path(path));
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(ImageRead {
                state: ImageState::None,
                text: None,
                marker: None,
                modified_ms: None,
            })
        }
        Err(e) => return Err(io_err(e)),
    };
    let foreign = ImageRead {
        state: ImageState::Foreign,
        text: None,
        marker: None,
        modified_ms: None,
    };
    if !meta.file_type().is_file() || meta.len() > MAX_IMAGE_BYTES {
        return Ok(foreign);
    }
    let limit = if full {
        MAX_IMAGE_BYTES + 1
    } else {
        NOTE_WITHIN_BYTES
    };
    let mut bytes = Vec::with_capacity(meta.len().min(limit) as usize);
    File::open(path)
        .map_err(io_err)?
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(io_err)?;
    let text = if full {
        let Ok(text) = String::from_utf8(bytes) else {
            return Ok(foreign);
        };
        text
    } else {
        // Cut anywhere, perhaps mid-character: only the note near the start is wanted.
        String::from_utf8_lossy(&bytes).into_owned()
    };
    let Some(marker) = marker_of(&text) else {
        return Ok(foreign);
    };
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64);
    Ok(ImageRead {
        state: ImageState::Ours,
        text: full.then_some(text),
        marker: Some(marker),
        modified_ms,
    })
}

/// What the page sends must be a docs picture and nothing more: an SVG, with the note, and none of
/// what would make an image on a documentation page run or fetch anything.
pub fn check_image(bytes: &[u8]) -> Result<&str, AppError> {
    let refuse = |why: &str| {
        AppError::new(
            ErrorKind::NotADocument,
            format!("Draft Canvas made a picture it won't publish ({why})."),
        )
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(AppError::new(
            ErrorKind::TooLarge,
            format!(
                "This picture is too large to publish (the limit is {} MB).",
                MAX_IMAGE_BYTES / (1024 * 1024)
            ),
        ));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| refuse("not text"))?;
    if !text.trim_start().starts_with("<svg") {
        return Err(refuse("not an SVG"));
    }
    if !text.contains(MARKER) {
        return Err(refuse("no source note"));
    }
    let lower = text.to_ascii_lowercase();
    // Element names only appear unescaped as markup: a label that says "<script>" is written as
    // `&lt;script&gt;` and never matches.
    for banned in ["<script", "<foreignobject", "<iframe"] {
        if lower.contains(banned) {
            return Err(refuse("active content"));
        }
    }
    if has_script_link(&lower) {
        return Err(refuse("active content"));
    }
    Ok(text)
}

/// A `javascript:` URL as a link or source *attribute* (`href="javascript:…"`), not the words in a
/// label: a shape named "Frontend (JavaScript: React)" refused every publish of its diagram.
fn has_script_link(lower: &str) -> bool {
    lower.match_indices("javascript:").any(|(at, _)| {
        let before = lower[..at].trim_end();
        let Some(before) = before.strip_suffix(['"', '\'']) else {
            return false;
        };
        let Some(before) = before.trim_end().strip_suffix('=') else {
            return false;
        };
        let name = before.trim_end();
        name.ends_with("href") || name.ends_with("src")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Published {
    Written,
    Unchanged,
}

fn foreign_image(path: &Path) -> AppError {
    AppError::new(
        ErrorKind::AlreadyExists,
        format!(
            "{} already exists beside this diagram and wasn't made by Draft Canvas, so it was left alone. Rename one of them to publish.",
            file_name(path)
        ),
    )
    .at(Some(crate::paths::display_path(path)))
}

fn taken_image(path: &Path, why: &str) -> AppError {
    AppError::new(
        ErrorKind::AlreadyExists,
        format!("{} {why}, so it was left alone.", file_name(path)),
    )
    .at(Some(crate::paths::display_path(path)))
}

/// Writes the picture of `doc` called `name` beside it. Refuses a file that isn't ours, and one of
/// ours drawn from another diagram; skips identical bytes. With `fresh` (the page found the name
/// free) it only ever creates: a picture that took the name since is never replaced.
pub fn publish_image(
    doc: &Path,
    name: &str,
    bytes: &[u8],
    fresh: bool,
) -> Result<Published, AppError> {
    check_image(bytes)?;
    let target = named_image_path(doc, name)?;
    let current = read_image(&target, true)?;
    match current.state {
        ImageState::Foreign => Err(foreign_image(&target)),
        ImageState::Ours if fresh => Err(taken_image(
            &target,
            "appeared beside the diagram since Draft Canvas looked",
        )),
        ImageState::Ours if !drawn_from(doc, current.marker.as_deref()) => {
            Err(taken_image(&target, "is a picture of another diagram"))
        }
        ImageState::Ours if current.text.as_deref().map(str::as_bytes) == Some(bytes) => {
            Ok(Published::Unchanged)
        }
        ImageState::Ours => {
            // Never written through a link: one that appeared since the look above is replaced,
            // not followed.
            write_in_place(&target, bytes)?;
            Ok(Published::Written)
        }
        // Created only if still absent: a file that appeared since the look above is never replaced.
        ImageState::None => match create_new_atomic(&target, bytes) {
            Ok(_) => Ok(Published::Written),
            Err(e) if e.kind == ErrorKind::AlreadyExists => Err(foreign_image(&target)),
            Err(e) => Err(e),
        },
    }
}

/// A Markdown file the person picked: real, a regular file, a Markdown extension, a size worth editing.
pub fn validate_markdown(path: &Path) -> Result<PathBuf, AppError> {
    let canonical = dunce::canonicalize(path)
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(path)))?;
    let markdown = canonical
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|m| m.eq_ignore_ascii_case(e))
        });
    if !markdown {
        return Err(AppError::invalid_path(format!(
            "{} isn't a Markdown file.",
            file_name(path)
        )));
    }
    let meta = fs::metadata(&canonical)
        .map_err(|e| AppError::from_io(&e, Verb::Open, Subject::Path(path)))?;
    if !meta.is_file() {
        return Err(AppError::invalid_path(format!(
            "{} isn't a file.",
            file_name(path)
        )));
    }
    if meta.len() > MAX_MARKDOWN_BYTES {
        return Err(AppError::too_large(path, Verb::Open, MAX_MARKDOWN_BYTES));
    }
    Ok(canonical)
}

pub struct MarkdownText {
    /// Without a leading byte-order mark; `add_to_markdown` puts it back.
    pub text: String,
    pub stamp: String,
}

pub fn read_markdown(path: &Path) -> Result<MarkdownText, AppError> {
    let doc = docio::read_document(path).map_err(|e| {
        if e.kind == ErrorKind::NotADocument {
            AppError::invalid_path(format!("{} isn't UTF-8 text.", file_name(path)))
        } else {
            e
        }
    })?;
    if doc.text.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(AppError::too_large(path, Verb::Open, MAX_MARKDOWN_BYTES));
    }
    Ok(MarkdownText {
        text: doc.text,
        stamp: doc.stamp,
    })
}

/// `to` as a Markdown link from a file in `from_dir`, with `/` between segments: `diagrams/a.svg`,
/// `../docs/a.svg`. `None` when there is no relative way there (another drive, on Windows).
pub fn relative_path(from_dir: &Path, to: &Path) -> Option<String> {
    let from: Vec<Component> = from_dir.components().collect();
    let target: Vec<Component> = to.components().collect();
    if from.first() != target.first() {
        return None;
    }
    let shared = from.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = Vec::new();
    for component in &from[shared..] {
        match component {
            Component::Normal(_) => parts.push("..".into()),
            _ => return None,
        }
    }
    for component in &target[shared..] {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Whether `new` is `old` with exactly one contiguous run of characters added, and nothing removed
/// or changed — and a short run at that.
pub fn is_single_insertion(old: &str, new: &str) -> bool {
    if new.len() <= old.len() || new.len() - old.len() > MAX_INSERTION_BYTES {
        return false;
    }
    let (old, new) = (old.as_bytes(), new.as_bytes());
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    prefix + suffix == old.len()
}

#[derive(Debug, PartialEq, Eq)]
pub enum MarkdownWrite {
    Saved {
        stamp: String,
    },
    /// The file changed since the person looked at it; nothing was written.
    Conflict,
}

/// Adds to the Markdown file at `path`, if it is still exactly what was read (`expected_stamp`) and
/// `new_text` only adds to it. A byte-order mark the file started with is kept.
pub fn add_to_markdown(
    path: &Path,
    new_text: &str,
    expected_stamp: &str,
) -> Result<MarkdownWrite, AppError> {
    let current = read_markdown(path)?;
    if current.stamp != expected_stamp {
        return Ok(MarkdownWrite::Conflict);
    }
    if !is_single_insertion(&current.text, new_text) {
        return Err(AppError::new(
            ErrorKind::Io,
            "Draft Canvas only adds the image to a Markdown file and never changes what is already there; this change did more, so nothing was written.",
        ));
    }
    let had_bom = fs::read(path)
        .map(|bytes| bytes.starts_with(BOM.as_bytes()))
        .unwrap_or(false);
    let bytes = if had_bom {
        format!("{BOM}{new_text}").into_bytes()
    } else {
        new_text.as_bytes().to_vec()
    };
    Ok(
        match docio::write_atomic(path, &bytes, Some(expected_stamp))? {
            docio::WriteOutcome::Saved { stamp } => MarkdownWrite::Saved { stamp },
            docio::WriteOutcome::Conflict => MarkdownWrite::Conflict,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A docs picture drawn from `payments.draftcanvas`.
    fn svg(body: &str) -> String {
        drawn_by("payments.draftcanvas", body)
    }

    fn drawn_by(source: &str, body: &str) -> String {
        format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{MARKER}{{&quot;v&quot;:1}}</metadata>{body}</svg>")
            .replace("{&quot;v&quot;:1}", &format!("{{\"v\":1,\"source\":\"{source}\"}}"))
    }

    #[test]
    fn the_image_sits_beside_its_source_under_the_same_name() {
        assert_eq!(
            image_path(Path::new("/repo/docs/Payment Flow.draftcanvas")),
            Path::new("/repo/docs/Payment Flow.svg")
        );
    }

    #[test]
    fn a_level_has_its_own_name_and_nothing_else_is_a_picture_name() {
        let doc = Path::new("/repo/docs/payments.draftcanvas");
        assert_eq!(
            named_image_path(doc, "payments.ledger.svg").unwrap(),
            Path::new("/repo/docs/payments.ledger.svg")
        );
        assert!(named_image_path(doc, "payments.svg").is_ok());
        assert!(named_image_path(doc, "payments.設計.svg").is_ok());
        assert!(named_image_path(doc, "payments.api.handler.svg").is_ok());
        for bad in [
            "other.svg",
            "payments.png",
            "payments..svg",
            "payments.a..b.svg",
            "payments.../x.svg",
            "payments.a/b.svg",
            "payments.a\\b.svg",
            "payments.a b.svg",
            "payments.svg.svg.",
            "paymentsx.svg",
        ] {
            assert!(named_image_path(doc, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn listing_finds_every_picture_of_the_diagram_and_nothing_else() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("payments.draftcanvas");
        fs::write(&doc, "{}").unwrap();
        fs::write(dir.path().join("payments.svg"), svg("<rect/>")).unwrap();
        fs::write(dir.path().join("payments.ledger.svg"), svg("<circle/>")).unwrap();
        fs::write(dir.path().join("payments.notes.svg"), "<svg/>").unwrap();
        fs::write(dir.path().join("payroll.svg"), svg("")).unwrap();
        fs::write(dir.path().join("payments.md"), "x").unwrap();
        let found: Vec<(String, ImageState)> = list_images(&doc, true)
            .unwrap()
            .into_iter()
            .map(|(name, read)| (name, read.state))
            .collect();
        assert_eq!(
            found,
            vec![
                ("payments.ledger.svg".to_string(), ImageState::Ours),
                ("payments.notes.svg".to_string(), ImageState::Foreign),
                ("payments.svg".to_string(), ImageState::Ours),
            ]
        );
        assert_eq!(
            publish_image(
                &doc,
                "payments.ledger.svg",
                svg("<line/>").as_bytes(),
                false
            )
            .unwrap(),
            Published::Written
        );
        assert!(publish_image(&doc, "payments.notes.svg", svg("").as_bytes(), false).is_err());
        assert!(publish_image(&doc, "../payments.svg", svg("").as_bytes(), false).is_err());
    }

    #[test]
    fn a_new_picture_never_replaces_one_that_took_its_name_and_another_diagrams_is_left_alone() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("payments.draftcanvas");
        fs::write(dir.path().join("payments.ledger.svg"), svg("<rect/>")).unwrap();
        // The page found the name free; a picture appeared there since.
        assert!(publish_image(
            &doc,
            "payments.ledger.svg",
            svg("<circle/>").as_bytes(),
            true
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("payments.ledger.svg")).unwrap(),
            svg("<rect/>")
        );
        // Ours, but drawn from payments.ledger.draftcanvas: not this diagram's to replace.
        let theirs = drawn_by("payments.ledger.draftcanvas", "<rect/>");
        fs::write(dir.path().join("payments.ledger.svg"), &theirs).unwrap();
        let error = publish_image(
            &doc,
            "payments.ledger.svg",
            svg("<circle/>").as_bytes(),
            false,
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(dir.path().join("payments.ledger.svg")).unwrap(),
            theirs
        );
        // A fresh name is created.
        assert_eq!(
            publish_image(&doc, "payments.api.svg", svg("<line/>").as_bytes(), true).unwrap(),
            Published::Written
        );
    }

    #[test]
    fn picture_names_match_whatever_their_case_and_a_listing_reads_only_the_note() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("Payments.draftcanvas");
        fs::write(
            dir.path().join("payments.SVG"),
            drawn_by("Payments.draftcanvas", "<rect/>"),
        )
        .unwrap();
        let listed = list_images(&doc, false).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, "payments.SVG");
        assert_eq!(listed[0].1.state, ImageState::Ours);
        assert!(listed[0].1.text.is_none());
        assert!(listed[0]
            .1
            .marker
            .as_deref()
            .unwrap()
            .contains("Payments.draftcanvas"));
        assert!(named_image_path(&doc, "PAYMENTS.Ledger.svg").is_ok());
    }

    #[test]
    fn publishing_writes_once_then_skips_identical_bytes() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("payments.draftcanvas");
        fs::write(&doc, "{}").unwrap();
        let first = svg("<rect/>");
        assert_eq!(
            publish_image(&doc, "payments.svg", first.as_bytes(), false).unwrap(),
            Published::Written
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("payments.svg")).unwrap(),
            first
        );
        assert_eq!(
            publish_image(&doc, "payments.svg", first.as_bytes(), false).unwrap(),
            Published::Unchanged
        );
        let second = svg("<circle/>");
        assert_eq!(
            publish_image(&doc, "payments.svg", second.as_bytes(), false).unwrap(),
            Published::Written
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("payments.svg")).unwrap(),
            second
        );
    }

    #[test]
    fn an_svg_draft_canvas_did_not_make_is_never_replaced() {
        let dir = tempdir().unwrap();
        let doc = dir.path().join("payments.draftcanvas");
        let theirs = dir.path().join("payments.svg");
        fs::write(&theirs, "<svg><rect/></svg>").unwrap();
        let error = publish_image(&doc, "payments.svg", svg("").as_bytes(), false).unwrap_err();
        assert_eq!(error.kind, ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&theirs).unwrap(), "<svg><rect/></svg>");
        assert_eq!(
            read_image(&theirs, true).unwrap().state,
            ImageState::Foreign
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_image_place_is_never_written_through() {
        let dir = tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere.svg");
        fs::write(&elsewhere, svg("<rect/>")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.path().join("payments.svg")).unwrap();
        let doc = dir.path().join("payments.draftcanvas");
        assert!(publish_image(&doc, "payments.svg", svg("<circle/>").as_bytes(), false).is_err());
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), svg("<rect/>"));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_appears_at_the_image_path_is_replaced_not_followed() {
        let dir = tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere.svg");
        fs::write(&elsewhere, "keep me").unwrap();
        let target = dir.path().join("payments.svg");
        std::os::unix::fs::symlink(&elsewhere, &target).unwrap();
        docio::write_in_place(&target, svg("<rect/>").as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "keep me");
        assert!(!fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), svg("<rect/>"));
    }

    #[test]
    fn only_a_docs_svg_without_active_content_is_accepted() {
        assert!(check_image(svg("<rect/>").as_bytes()).is_ok());
        assert!(check_image(b"<svg><rect/></svg>").is_err());
        assert!(check_image(b"<html>nope</html>").is_err());
        assert!(check_image(svg("<script>alert(1)</script>").as_bytes()).is_err());
        assert!(check_image(svg("<foreignObject/>").as_bytes()).is_err());
        assert!(check_image(svg("<a href=\"javascript:x\"/>").as_bytes()).is_err());
        assert!(check_image(svg("<a xlink:href = 'JavaScript:x'/>").as_bytes()).is_err());
        // The words in a label are not a link.
        assert!(check_image(svg("<text>Frontend (JavaScript: React)</text>").as_bytes()).is_ok());
        assert!(check_image(svg("<text>&lt;script&gt;</text>").as_bytes()).is_ok());
        assert!(check_image(&[0xff, 0xfe]).is_err());
    }

    #[test]
    fn relative_paths_walk_up_and_down_with_forward_slashes() {
        let rel = |a: &str, b: &str| relative_path(Path::new(a), Path::new(b));
        assert_eq!(
            rel("/repo", "/repo/docs/diagrams/a b.svg").as_deref(),
            Some("docs/diagrams/a b.svg")
        );
        assert_eq!(
            rel("/repo/docs/adr", "/repo/docs/diagrams/a.svg").as_deref(),
            Some("../diagrams/a.svg")
        );
        assert_eq!(
            rel("/repo/docs", "/repo/docs/a.svg").as_deref(),
            Some("a.svg")
        );
    }

    #[test]
    fn a_change_that_does_more_than_add_is_refused() {
        assert!(is_single_insertion("a\nb\n", "a\n\n![x](y)\n\nb\n"));
        assert!(is_single_insertion("", "![x](y)\n"));
        assert!(is_single_insertion("a", "a\n\n![x](y)\n"));
        assert!(!is_single_insertion("a\nb\n", "a\nc\n![x](y)\n"));
        assert!(!is_single_insertion("a\nb\n", "a\n"));
        assert!(!is_single_insertion("same", "same"));
        assert!(!is_single_insertion(
            "",
            &"x".repeat(MAX_INSERTION_BYTES + 1)
        ));
    }

    #[test]
    fn markdown_is_added_to_only_while_it_is_what_was_read() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("README.md");
        fs::write(&path, format!("{BOM}# Title\r\n\r\nText\r\n")).unwrap();
        let read = read_markdown(&path).unwrap();
        assert_eq!(read.text, "# Title\r\n\r\nText\r\n");
        let next = format!("{}\r\n![x](y.svg)\r\n", read.text);
        assert!(matches!(
            add_to_markdown(&path, &next, &read.stamp).unwrap(),
            MarkdownWrite::Saved { .. }
        ));
        // The mark and every original byte survive.
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("{BOM}{next}"));
        // The old stamp no longer describes the file.
        assert_eq!(
            add_to_markdown(&path, &format!("{next}more"), &read.stamp).unwrap(),
            MarkdownWrite::Conflict
        );
    }

    #[test]
    fn a_rewrite_of_markdown_is_refused_and_leaves_the_file_alone() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("README.md");
        fs::write(&path, "# Title\n\nKeep me\n").unwrap();
        let read = read_markdown(&path).unwrap();
        assert!(add_to_markdown(&path, "# Title\n\n![x](y)\n", &read.stamp).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Title\n\nKeep me\n");
    }

    #[test]
    fn only_markdown_files_are_accepted() {
        let dir = tempdir().unwrap();
        for name in ["a.md", "b.MARKDOWN", "c.mdx"] {
            fs::write(dir.path().join(name), "x").unwrap();
            assert!(validate_markdown(&dir.path().join(name)).is_ok(), "{name}");
        }
        fs::write(dir.path().join("d.txt"), "x").unwrap();
        assert!(validate_markdown(&dir.path().join("d.txt")).is_err());
    }
}
