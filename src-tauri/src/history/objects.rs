//! Commit, tag and tree objects, written and read exactly as the browser backend does.
//!
//! The two backends must produce the same object ids for the same revision, so the bytes are
//! formatted here rather than by gix: isomorphic-git's `GitCommit.render` and `GitAnnotatedTag.render`
//! are the reference, and its readers (`parseHeaders`, `parseAuthor`, `normalizeNewlines`) decide
//! what a record says. Standard Git computes the same ids for every message Draft Canvas writes
//! (one trailing newline, no carriage returns), which `contract.json` checks.

use super::{limits, CommitRecord, HistoryError, Result, Signature, DIAGRAM_PATH};

/// isomorphic-git's `normalizeNewlines`: no carriage returns, no leading newlines, exactly one
/// trailing newline.
pub fn normalize_newlines(text: &str) -> String {
    let without_cr: String = text.chars().filter(|&c| c != '\r').collect();
    let trimmed = without_cr.trim_start_matches('\n').trim_end_matches('\n');
    format!("{trimmed}\n")
}

/// Refuses what would make a signature line ambiguous or corrupt: Git itself would never write one.
fn check_signature(sig: &Signature) -> Result<()> {
    let bad = |s: &str| {
        s.chars()
            .any(|c| matches!(c, '\n' | '\r' | '\0' | '<' | '>'))
    };
    if bad(&sig.name) || bad(&sig.email) || sig.name.len() > 1024 || sig.email.len() > 1024 {
        return Err(HistoryError::invalid(
            "A signature names someone Git can't record.",
        ));
    }
    // Four digits of hours and minutes, which is all Git's offset holds.
    if sig.timezone_offset.unsigned_abs() > 99 * 60 + 59 {
        return Err(HistoryError::invalid(
            "A signature's time zone is out of range.",
        ));
    }
    // JavaScript numbers are exact up to 2^53; nothing a person records is outside that.
    if !(0..=(1_i64 << 53)).contains(&sig.timestamp) {
        return Err(HistoryError::invalid("A signature's time is out of range."));
    }
    Ok(())
}

/// isomorphic-git's `formatTimezoneOffset`: minutes west of UTC become Git's `+hhmm` east of it.
fn format_offset(minutes: i32) -> String {
    let east = -minutes;
    let sign = if east < 0 { '-' } else { '+' };
    let abs = east.unsigned_abs();
    format!("{sign}{:02}{:02}", abs / 60, abs % 60)
}

fn format_signature(sig: &Signature) -> String {
    format!(
        "{} <{}> {} {}",
        sig.name,
        sig.email,
        sig.timestamp,
        format_offset(sig.timezone_offset)
    )
}

fn check_message(message: &str) -> Result<()> {
    if message.len() > limits::MAX_MESSAGE_BYTES {
        return Err(HistoryError::too_large(
            "That description is longer than history records.",
        ));
    }
    Ok(())
}

/// The commit object's bytes, as `GitCommit.render` makes them.
pub fn commit_bytes(
    tree: &str,
    parents: &[String],
    author: &Signature,
    committer: &Signature,
    message: &str,
) -> Result<Vec<u8>> {
    check_signature(author)?;
    check_signature(committer)?;
    check_message(message)?;
    let mut out = format!("tree {tree}\n");
    for parent in parents {
        out.push_str(&format!("parent {parent}\n"));
    }
    out.push_str(&format!("author {}\n", format_signature(author)));
    out.push_str(&format!("committer {}\n", format_signature(committer)));
    out.push('\n');
    out.push_str(&normalize_newlines(message));
    Ok(out.into_bytes())
}

/// The tag object's bytes, as `GitAnnotatedTag.render` makes them: the message as given, plus one newline.
pub fn tag_bytes(target: &str, name: &str, tagger: &Signature, message: &str) -> Result<Vec<u8>> {
    check_signature(tagger)?;
    check_message(message)?;
    Ok(format!(
        "object {target}\ntype commit\ntag {name}\ntagger {}\n\n{message}\n",
        format_signature(tagger)
    )
    .into_bytes())
}

/// The only tree a revision may have: one regular file, `diagram.draftcanvas`.
pub fn tree_bytes(blob: &gix::oid) -> Vec<u8> {
    let mut out = format!("100644 {DIAGRAM_PATH}\0").into_bytes();
    out.extend_from_slice(blob.as_bytes());
    out
}

/// The blob a revision's tree names, or `None` when the tree is anything but exactly `tree_bytes`.
pub fn diagram_blob_of(tree: &[u8]) -> Option<gix::ObjectId> {
    let prefix = format!("100644 {DIAGRAM_PATH}\0");
    let rest = tree.strip_prefix(prefix.as_bytes())?;
    if rest.len() != 20 {
        return None;
    }
    Some(gix::ObjectId::from_bytes_or_panic(rest))
}

/// isomorphic-git's `parseTimezoneOffset`: `+0200` is `-120`.
fn parse_offset(text: &str) -> Option<i32> {
    let b = text.as_bytes();
    // Its pattern is unanchored; the first `[+-]dddd` wins.
    (0..b.len().saturating_sub(4)).find_map(|i| {
        let sign = match b[i] {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let digits = &b[i + 1..i + 5];
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let num = |d: &[u8]| i32::from(d[0] - b'0') * 10 + i32::from(d[1] - b'0');
        Some(-(sign * (num(&digits[..2]) * 60 + num(&digits[2..]))))
    })
}

/// isomorphic-git's `parseAuthor`: `^(.*) <(.*)> (.*) (.*)$`, greedy.
fn parse_signature(text: &str) -> Option<Signature> {
    // `.` does not match a newline, so a folded header never parses.
    if text.contains('\n') {
        return None;
    }
    let (rest, offset) = text.rsplit_once(' ')?;
    let (rest, timestamp) = rest.rsplit_once(' ')?;
    let rest = rest.strip_suffix('>')?;
    let (name, email) = rest.rsplit_once(" <")?;
    Some(Signature {
        name: name.to_string(),
        email: email.to_string(),
        timestamp: timestamp.parse().ok()?,
        timezone_offset: parse_offset(offset)?,
    })
}

/// Header lines, with continuation lines (a leading space) folded into the one before.
fn header_lines(headers: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in headers.split('\n') {
        match (line.strip_prefix(' '), out.last_mut()) {
            (Some(rest), Some(last)) => {
                last.push('\n');
                last.push_str(rest);
            }
            _ => out.push(line.to_string()),
        }
    }
    out
}

fn key_value(line: &str) -> (&str, &str) {
    line.split_once(' ').unwrap_or((line, ""))
}

/// A commit object as `GitCommit.parseHeaders` reads it: one `tree` first, the run of `parent` lines
/// right after it, and the first `author` and `committer` after that.
pub fn parse_commit(oid: &str, data: &[u8]) -> Result<CommitRecord> {
    let corrupt = || HistoryError::corrupt("That revision could not be read.");
    let text = String::from_utf8_lossy(data);
    let split = text.find("\n\n").ok_or_else(corrupt)?;
    let lines = header_lines(&text[..split]);
    let message = normalize_newlines(&text[split + 2..]);
    let mut lines = lines.iter().map(|l| key_value(l));
    let tree = match lines.next() {
        Some(("tree", value)) if super::is_oid(value) => value.to_string(),
        _ => return Err(corrupt()),
    };
    let mut parents = Vec::new();
    let mut author = None;
    let mut committer = None;
    let mut in_parents = true;
    for (key, value) in lines {
        if in_parents && key == "parent" {
            if !super::is_oid(value) {
                return Err(corrupt());
            }
            parents.push(value.to_string());
            continue;
        }
        in_parents = false;
        match key {
            "author" if author.is_none() => author = Some(value),
            "committer" if committer.is_none() => committer = Some(value),
            _ => {}
        }
    }
    let author = author.and_then(parse_signature).ok_or_else(corrupt)?;
    let committer = committer.and_then(parse_signature).ok_or_else(corrupt)?;
    Ok(CommitRecord {
        oid: oid.to_string(),
        tree,
        parents,
        author,
        committer,
        message,
    })
}

pub struct ParsedTag {
    pub object: String,
    pub kind: String,
    pub message: String,
    pub tagger: Option<Signature>,
}

const SIGNATURE_MARK: &str = "\n-----BEGIN PGP SIGNATURE-----";

/// A tag object as `GitAnnotatedTag.parse` reads it: first occurrence of each header wins, and the
/// message is everything after the headers once the whole object is normalized, without a signature.
pub fn parse_tag(data: &[u8]) -> Option<ParsedTag> {
    let text = String::from_utf8_lossy(data);
    let split = text.find("\n\n")?;
    let mut object = None;
    let mut kind = None;
    let mut tagger = None;
    for line in header_lines(&text[..split]) {
        let (key, value) = key_value(&line);
        match key {
            "object" if object.is_none() => object = Some(value.to_string()),
            "type" if kind.is_none() => kind = Some(value.to_string()),
            "tagger" if tagger.is_none() => tagger = Some(value.to_string()),
            _ => {}
        }
    }
    let normalized = normalize_newlines(&text);
    let unsigned = match normalized.rfind(SIGNATURE_MARK) {
        Some(at) => &normalized[..at],
        None => normalized.as_str(),
    };
    let message = unsigned
        .find("\n\n")
        .map(|at| unsigned[at + 2..].to_string())
        .unwrap_or_default();
    Some(ParsedTag {
        object: object?,
        kind: kind?,
        message,
        tagger: tagger.as_deref().and_then(parse_signature),
    })
}

/// The `object` a tag names and the `tree` and `parent`s a commit names: what a reachability walk follows.
pub fn tag_target(data: &[u8]) -> Option<gix::ObjectId> {
    let text = String::from_utf8_lossy(data);
    let headers = &text[..text.find("\n\n").unwrap_or(text.len())];
    headers
        .split('\n')
        .find_map(|line| line.strip_prefix("object "))
        .filter(|value| super::is_oid(value))
        .and_then(|value| gix::ObjectId::from_hex(value.as_bytes()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(offset: i32) -> Signature {
        Signature {
            name: "Ada".into(),
            email: "ada@example.invalid".into(),
            timestamp: 1_700_000_000,
            timezone_offset: offset,
        }
    }

    #[test]
    fn offsets_are_minutes_west_of_utc() {
        assert_eq!(format_offset(0), "+0000");
        assert_eq!(format_offset(-120), "+0200");
        assert_eq!(format_offset(300), "-0500");
        assert_eq!(format_offset(-330), "+0530");
        assert_eq!(parse_offset("+0200"), Some(-120));
        assert_eq!(parse_offset("-0500"), Some(300));
        assert_eq!(parse_offset("+0000"), Some(0));
        assert_eq!(parse_offset("+0530"), Some(-330));
    }

    #[test]
    fn a_commit_round_trips_with_a_normalized_message() {
        let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        let bytes = commit_bytes(tree, &[], &sig(-120), &sig(-120), "\n\nHello\r\n\n\n").unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.contains("author Ada <ada@example.invalid> 1700000000 +0200\n"));
        assert!(text.ends_with("\n\nHello\n"));
        let record = parse_commit("x", &bytes).unwrap();
        assert_eq!(record.message, "Hello\n");
        assert_eq!(record.author, sig(-120));
        assert_eq!(record.tree, tree);
    }

    #[test]
    fn a_signature_git_could_not_record_is_refused() {
        let tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        for bad in ["a\nb", "a<b", "a>b"] {
            let mut s = sig(0);
            s.name = bad.into();
            assert!(
                commit_bytes(tree, &[], &s, &sig(0), "m").is_err(),
                "{bad:?}"
            );
        }
        let mut s = sig(0);
        s.timezone_offset = 100 * 60;
        assert!(commit_bytes(tree, &[], &s, &sig(0), "m").is_err());
        let long = "x".repeat(limits::MAX_MESSAGE_BYTES + 1);
        let err = commit_bytes(tree, &[], &sig(0), &sig(0), &long).unwrap_err();
        assert_eq!(err.code, super::super::Code::TooLarge);
    }

    #[test]
    fn a_tag_keeps_its_message_and_reads_back_normalized() {
        let target = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        let bytes = tag_bytes(target, "milestone/m1", &sig(60), "Ship it\n").unwrap();
        assert!(String::from_utf8(bytes.clone())
            .unwrap()
            .ends_with("\n\nShip it\n\n"));
        let tag = parse_tag(&bytes).unwrap();
        assert_eq!(tag.object, target);
        assert_eq!(tag.kind, "commit");
        assert_eq!(tag.message, "Ship it\n");
        assert_eq!(tag.tagger, Some(sig(60)));
    }

    #[test]
    fn only_the_canonical_tree_names_a_diagram() {
        let blob = gix::ObjectId::from_hex(b"0123456789abcdef0123456789abcdef01234567").unwrap();
        assert_eq!(diagram_blob_of(&tree_bytes(&blob)), Some(blob));
        let mut exec = tree_bytes(&blob);
        exec[..6].copy_from_slice(b"100755");
        assert_eq!(diagram_blob_of(&exec), None);
        let mut two = tree_bytes(&blob);
        two.extend_from_slice(b"100644 other\0");
        two.extend_from_slice(blob.as_bytes());
        assert_eq!(diagram_blob_of(&two), None);
        assert_eq!(diagram_blob_of(b""), None);
    }
}
