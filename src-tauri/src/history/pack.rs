//! Git packs in and out of a history.
//!
//! Out: `PackWriter` writes a version 2 pack of whole objects (no deltas), which Git and gix index
//! like any other. A bundle is that pack behind a text header, which the page adds (`bundle.ts`).
//!
//! In: `scan_pack` is the bounded pre-scan of `src/evolution/packScan.ts`, run before gix inflates
//! anything. gix verifies object ids and the trailer while it indexes, but bounds neither how far a
//! few kilobytes of deflate may inflate nor how deep a delta chain goes, so this walks the pack
//! once with a counted, capped inflater and refuses a bomb while it is still a byte array.

use super::{HistoryError, Result};
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct PackLimits {
    pub max_objects: usize,
    /// Largest inflated object, and largest delta result.
    pub max_object_bytes: u64,
    /// Sum of every inflated object.
    pub max_total_inflated: u64,
    pub max_delta_depth: u32,
}

impl PackLimits {
    pub fn history() -> Self {
        Self {
            max_objects: super::limits::MAX_BUNDLE_OBJECTS,
            max_object_bytes: super::limits::MAX_BLOB_BYTES as u64,
            max_total_inflated: super::limits::MAX_TOTAL_INFLATED,
            max_delta_depth: super::limits::MAX_DELTA_DEPTH,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackSummary {
    pub objects: usize,
    pub inflated: u64,
    pub deltas: usize,
}

fn rejected(message: &str) -> HistoryError {
    HistoryError::corrupt(format!("That history file was refused: {message}"))
}

/// The size varint a delta's data starts with (base size, then result size).
fn delta_varint(data: &[u8], at: usize) -> Result<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    let mut i = at;
    loop {
        if i >= data.len() || shift > 35 {
            return Err(rejected("a delta header is cut short."));
        }
        let byte = data[i];
        value |= u64::from(byte & 0x7f) << shift;
        shift += 7;
        i += 1;
        if byte & 0x80 == 0 {
            return Ok((value, i));
        }
    }
}

/// Inflates the zlib stream at `pack[start..end]`, never producing more than `declared` bytes, and
/// returns where it ends and its first bytes (enough for a delta header). zlib's own checksum is
/// checked by the inflater.
fn inflate_bounded(
    pack: &[u8],
    start: usize,
    end: usize,
    declared: u64,
) -> Result<(usize, Vec<u8>)> {
    let mut inflater = Decompress::new(true);
    let mut scratch = vec![0u8; 64 * 1024];
    let mut head = Vec::with_capacity(32);
    loop {
        let consumed = usize::try_from(inflater.total_in()).map_err(|_| rejected("bad offset."))?;
        let input = &pack[start + consumed..end];
        let produced = inflater.total_out();
        // Room for one byte more than declared, so an object that inflates past its size is caught.
        let room = usize::try_from((declared - produced).saturating_add(1))
            .unwrap_or(usize::MAX)
            .min(scratch.len());
        let status = inflater
            .decompress(input, &mut scratch[..room], FlushDecompress::None)
            .map_err(|_| rejected("an object's compressed data is damaged."))?;
        let wrote = usize::try_from(inflater.total_out() - produced).unwrap_or(usize::MAX);
        let took = inflater.total_in() as usize - consumed;
        if head.len() < 32 {
            let more = (32 - head.len()).min(wrote);
            head.extend_from_slice(&scratch[..more]);
        }
        if inflater.total_out() > declared {
            return Err(rejected("an object inflates to more than it declares."));
        }
        match status {
            Status::StreamEnd => break,
            Status::Ok | Status::BufError if wrote == 0 && took == 0 => {
                return Err(rejected("an object's compressed data is cut short."));
            }
            Status::Ok | Status::BufError => {}
        }
    }
    if inflater.total_out() != declared {
        return Err(rejected("an object inflates to less than it declares."));
    }
    Ok((start + inflater.total_in() as usize, head))
}

/// Walks every entry of a version 2 or 3 pack within `limits`. `pack` includes its 20-byte trailer,
/// which gix checks when it indexes.
pub fn scan_pack(pack: &[u8], limits: PackLimits) -> Result<PackSummary> {
    if pack.len() < 32 {
        return Err(rejected("the pack is too short."));
    }
    if &pack[..4] != b"PACK" {
        return Err(rejected("it is not a Git pack."));
    }
    let word = |at: usize| u32::from_be_bytes([pack[at], pack[at + 1], pack[at + 2], pack[at + 3]]);
    let version = word(4);
    if version != 2 && version != 3 {
        return Err(rejected("its pack version is not supported."));
    }
    let count = word(8) as usize;
    if count > limits.max_objects {
        return Err(HistoryError::too_large(format!(
            "That history file holds {count} objects; at most {} are accepted.",
            limits.max_objects
        )));
    }
    let end = pack.len() - 20;
    let mut depth_at: HashMap<usize, u32> = HashMap::new();
    let mut at = 12;
    let mut inflated = 0u64;
    let mut deltas = 0;
    for _ in 0..count {
        if at >= end {
            return Err(rejected("the pack ends before its last object."));
        }
        let entry_start = at;
        let mut byte = pack[at];
        at += 1;
        let kind = (byte >> 4) & 7;
        if !matches!(kind, 1 | 2 | 3 | 4 | 6 | 7) {
            return Err(rejected("the pack holds an object of unknown type."));
        }
        let mut size = u64::from(byte & 0x0f);
        let mut shift = 4;
        while byte & 0x80 != 0 {
            if at >= end || shift > 35 {
                return Err(rejected("an object header is cut short."));
            }
            byte = pack[at];
            at += 1;
            size |= u64::from(byte & 0x7f) << shift;
            shift += 7;
        }
        let mut depth = 0;
        if kind == 6 {
            if at >= end {
                return Err(rejected("a delta offset is cut short."));
            }
            byte = pack[at];
            at += 1;
            let mut offset = u64::from(byte & 0x7f);
            while byte & 0x80 != 0 {
                if at >= end || offset > (1 << 40) {
                    return Err(rejected("a delta offset is cut short."));
                }
                byte = pack[at];
                at += 1;
                offset = ((offset + 1) << 7) | u64::from(byte & 0x7f);
            }
            let base = (entry_start as u64)
                .checked_sub(offset)
                .filter(|&base| offset > 0 && base >= 12)
                .and_then(|base| depth_at.get(&(base as usize)))
                .ok_or_else(|| rejected("a delta points outside the pack."))?;
            depth = base + 1;
        } else if kind == 7 {
            at += 20;
            if at >= end {
                return Err(rejected("a delta base is cut short."));
            }
            // A base named by id may be anywhere: count it as one more level than nothing.
            depth = 1;
        }
        if depth > limits.max_delta_depth {
            return Err(rejected("a delta chain is deeper than allowed."));
        }
        // A delta's declared size is the size of its instructions; the result is checked below.
        if size > limits.max_object_bytes {
            return Err(HistoryError::too_large(
                "That history file holds an object larger than any diagram.",
            ));
        }
        let (next, head) = inflate_bounded(pack, at, end, size)?;
        if kind == 6 || kind == 7 {
            deltas += 1;
            let (base, after) = delta_varint(&head, 0)?;
            let (result, _) = delta_varint(&head, after)?;
            if base > limits.max_object_bytes || result > limits.max_object_bytes {
                return Err(HistoryError::too_large(
                    "That history file builds an object larger than any diagram.",
                ));
            }
            inflated += result;
        } else {
            inflated += size;
        }
        if inflated > limits.max_total_inflated {
            return Err(HistoryError::too_large(
                "That history file inflates to more than Draft Canvas accepts.",
            ));
        }
        depth_at.insert(entry_start, depth);
        at = next;
    }
    if at != end {
        return Err(rejected("the pack has data after its last object."));
    }
    Ok(PackSummary {
        objects: count,
        inflated,
        deltas,
    })
}

/// A version 2 pack of whole objects, built in memory up to `limit` bytes.
pub struct PackWriter {
    out: Vec<u8>,
    hasher: gix::hash::Hasher,
    flushed: usize,
    remaining: u32,
    limit: usize,
}

fn kind_code(kind: gix::objs::Kind) -> u8 {
    match kind {
        gix::objs::Kind::Commit => 1,
        gix::objs::Kind::Tree => 2,
        gix::objs::Kind::Blob => 3,
        gix::objs::Kind::Tag => 4,
    }
}

impl PackWriter {
    pub fn new(count: u32, limit: usize) -> Self {
        let mut out = Vec::with_capacity(1024);
        out.extend_from_slice(b"PACK");
        out.extend_from_slice(&2u32.to_be_bytes());
        out.extend_from_slice(&count.to_be_bytes());
        Self {
            out,
            hasher: gix::hash::hasher(gix::hash::Kind::Sha1),
            flushed: 0,
            remaining: count,
            limit,
        }
    }

    pub fn add(&mut self, kind: gix::objs::Kind, data: &[u8]) -> Result<()> {
        if self.remaining == 0 {
            return Err(HistoryError::invalid(
                "More objects than the pack declared.",
            ));
        }
        self.remaining -= 1;
        let mut size = data.len() as u64;
        let mut byte = (kind_code(kind) << 4) | (size & 0x0f) as u8;
        size >>= 4;
        while size > 0 {
            self.out.push(byte | 0x80);
            byte = (size & 0x7f) as u8;
            size >>= 7;
        }
        self.out.push(byte);
        let mut deflater = Compress::new(Compression::default(), true);
        let mut input = data;
        loop {
            self.out.reserve(64 * 1024);
            let before_in = deflater.total_in();
            let status = deflater
                .compress_vec(input, &mut self.out, FlushCompress::Finish)
                .map_err(|_| {
                    HistoryError::corrupt("Draft Canvas couldn't compress the history.")
                })?;
            input = &input[(deflater.total_in() - before_in) as usize..];
            if self.out.len() > self.limit {
                return Err(HistoryError::too_large(
                    "This history is larger than Draft Canvas exports.",
                ));
            }
            if status == Status::StreamEnd {
                break;
            }
        }
        self.hash_pending();
        Ok(())
    }

    fn hash_pending(&mut self) {
        self.hasher.update(&self.out[self.flushed..]);
        self.flushed = self.out.len();
    }

    pub fn finish(mut self) -> Result<Vec<u8>> {
        if self.remaining != 0 {
            return Err(HistoryError::invalid(
                "Fewer objects than the pack declared.",
            ));
        }
        self.hash_pending();
        let trailer = self
            .hasher
            .try_finalize()
            .map_err(|_| HistoryError::corrupt("The history's checksum could not be computed."))?;
        self.out.extend_from_slice(trailer.as_bytes());
        Ok(self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_of(objects: &[(gix::objs::Kind, &[u8])]) -> Vec<u8> {
        let mut writer = PackWriter::new(objects.len() as u32, usize::MAX);
        for (kind, data) in objects {
            writer.add(*kind, data).unwrap();
        }
        writer.finish().unwrap()
    }

    #[test]
    fn a_written_pack_scans_cleanly() {
        let big = vec![b'x'; 100_000];
        let pack = pack_of(&[
            (gix::objs::Kind::Blob, b"hello"),
            (gix::objs::Kind::Blob, &big),
            (gix::objs::Kind::Blob, b""),
        ]);
        let summary = scan_pack(&pack, PackLimits::history()).unwrap();
        assert_eq!(summary.objects, 3);
        assert_eq!(summary.inflated, 100_005);
    }

    #[test]
    fn a_bomb_is_refused_before_anything_inflates_it() {
        // Declares 10 bytes, inflates to 100 000.
        let mut pack = pack_of(&[(gix::objs::Kind::Blob, &vec![0u8; 100_000])]);
        // Rewrite the header in place: type blob, size 10, no continuation.
        let header_len = pack[12..].iter().position(|b| b & 0x80 == 0).unwrap() + 1;
        pack.splice(12..12 + header_len, [0x3a]);
        let err = scan_pack(&pack, PackLimits::history()).unwrap_err();
        assert!(
            err.message.contains("more than it declares"),
            "{}",
            err.message
        );
    }

    #[test]
    fn limits_are_enforced() {
        let pack = pack_of(&[(gix::objs::Kind::Blob, &[7u8; 2048])]);
        let small = PackLimits {
            max_object_bytes: 1024,
            ..PackLimits::history()
        };
        assert!(scan_pack(&pack, small).is_err());
        let few = PackLimits {
            max_objects: 0,
            ..PackLimits::history()
        };
        assert!(scan_pack(&pack, few).is_err());
        let total = PackLimits {
            max_total_inflated: 100,
            ..PackLimits::history()
        };
        assert!(scan_pack(&pack, total).is_err());
        assert!(scan_pack(b"PACK", PackLimits::history()).is_err());
        let mut trailing = pack.clone();
        trailing.splice(pack.len() - 20..pack.len() - 20, [0u8; 3]);
        assert!(scan_pack(&trailing, PackLimits::history()).is_err());
    }
}
