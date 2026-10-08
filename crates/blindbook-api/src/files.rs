//! The public files every visitor downloads in the same order (PROTOCOL section 8), written
//! under `<data>/public/v1/` and served as plain files. `.json.gz` files are served as they are
//! (no `Content-Encoding`): the mixnet client can't decompress, so the app does
//! (`DecompressionStream`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use blindbook_ledger::delta::{Delta, Head};
use flate2::Compression;
use flate2::write::GzEncoder;

/// Deltas per segment. `segment/{k}.jsonl.gz` holds deltas `k·SEGMENT + 1 ..= (k + 1)·SEGMENT`,
/// one per line, each byte for byte as in `delta/`, and is written once the last of them exists:
/// a client reads a long log in a few hundred requests instead of one per block.
pub const SEGMENT: u64 = 128;

pub struct Files {
    root: PathBuf,
}

pub(crate) fn gz(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut e = GzEncoder::new(Vec::new(), Compression::best());
    e.write_all(bytes)?;
    e.finish()
}

/// Write via a temporary file and rename, so a reader never sees half a file.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Files {
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        let root = data_dir.join("public").join("v1");
        std::fs::create_dir_all(root.join("delta"))?;
        std::fs::create_dir_all(root.join("segment"))?;
        Ok(Files { root })
    }

    /// The directory served at `/v1/`.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_delta(&self, d: &Delta) -> std::io::Result<()> {
        let json = serde_json::to_vec(d).map_err(std::io::Error::other)?;
        write_atomic(
            &self.root.join("delta").join(format!("{}.json.gz", d.seq)),
            &gz(&json)?,
        )
    }

    pub fn write_head(&self, h: &Head) -> std::io::Result<()> {
        let json = serde_json::to_vec(h).map_err(std::io::Error::other)?;
        write_atomic(&self.root.join("head.json"), &json)
    }

    /// Write every complete segment up to `head_seq` that doesn't exist yet (newest first; after
    /// a restart with an older log, all of them).
    pub fn write_segments(&self, head_seq: u64) -> std::io::Result<()> {
        for k in (0..head_seq / SEGMENT).rev() {
            let path = self.root.join("segment").join(format!("{k}.jsonl.gz"));
            if path.exists() {
                break;
            }
            let mut lines = Vec::new();
            for seq in k * SEGMENT + 1..=(k + 1) * SEGMENT {
                let packed = std::fs::read(self.root.join("delta").join(format!("{seq}.json.gz")))?;
                flate2::read::GzDecoder::new(&packed[..]).read_to_end(&mut lines)?;
                lines.push(b'\n');
            }
            write_atomic(&path, &gz(&lines)?)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blindbook_ledger::H32;
    use blindbook_ledger::delta::ChainStats;

    fn delta(seq: u64) -> Delta {
        Delta {
            v: 1,
            seq,
            height: 1_000 + seq,
            prev_root: H32([seq as u8; 32]),
            batches: Vec::new(),
            issued: Vec::new(),
            spent: Vec::new(),
            events: Vec::new(),
            chain: ChainStats::default(),
        }
    }

    #[test]
    fn segments_hold_the_delta_files_byte_for_byte() {
        let dir = std::env::temp_dir().join(format!("bb-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let f = Files::new(&dir).unwrap();
        let unzip = |p: PathBuf| {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(&std::fs::read(p).unwrap()[..])
                .read_to_end(&mut out)
                .unwrap();
            out
        };
        for seq in 1..=SEGMENT + 5 {
            f.write_delta(&delta(seq)).unwrap();
            f.write_segments(seq).unwrap();
        }
        let seg = f.root().join("segment");
        assert!(seg.join("0.jsonl.gz").exists());
        assert!(!seg.join("1.jsonl.gz").exists(), "incomplete: not written");
        let text = unzip(seg.join("0.jsonl.gz"));
        let lines: Vec<&[u8]> = text
            .split(|&b| b == b'\n')
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(lines.len() as u64, SEGMENT);
        for (i, line) in lines.iter().enumerate() {
            let file = unzip(f.root().join("delta").join(format!("{}.json.gz", i + 1)));
            assert_eq!(*line, &file[..]);
        }
        // After a restart with segments missing, the next block writes all of them.
        std::fs::remove_file(seg.join("0.jsonl.gz")).unwrap();
        for seq in SEGMENT + 6..=2 * SEGMENT {
            f.write_delta(&delta(seq)).unwrap();
        }
        f.write_segments(2 * SEGMENT).unwrap();
        assert!(seg.join("0.jsonl.gz").exists() && seg.join("1.jsonl.gz").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
