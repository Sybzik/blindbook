//! The public files every visitor downloads in the same order (PROTOCOL section 8), written
//! under `<data>/public/v1/` and served as plain files. `.json.gz` files are served as they are
//! (no `Content-Encoding`): the mixnet client can't decompress, so the app does
//! (`DecompressionStream`).

use std::io::Write;
use std::path::{Path, PathBuf};

use blindbook_ledger::delta::{Delta, Head};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Serialize;

pub struct Files {
    root: PathBuf,
}

fn gz(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut e = GzEncoder::new(Vec::new(), Compression::best());
    e.write_all(bytes)?;
    e.finish()
}

/// Write via a temporary file and rename, so a reader never sees half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Files {
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        let root = data_dir.join("public").join("v1");
        std::fs::create_dir_all(root.join("delta"))?;
        std::fs::create_dir_all(root.join("snapshot"))?;
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

    pub fn write_snapshot<T: Serialize>(&self, seq: u64, s: &T) -> std::io::Result<()> {
        let json = serde_json::to_vec(s).map_err(std::io::Error::other)?;
        let bytes = gz(&json)?;
        write_atomic(
            &self.root.join("snapshot").join(format!("{seq}.json.gz")),
            &bytes,
        )?;
        write_atomic(&self.root.join("snapshot").join("latest.json.gz"), &bytes)
    }
}
