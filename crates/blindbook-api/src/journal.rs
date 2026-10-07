//! The API's append-only journal: every applied operation with the signer's exclusions and
//! signatures, and every block close. State after a restart = replaying it with `ops::apply`.
//!
//! **No slip secrets on disk.** Before an operation is written, each spent slip's secret and `C`
//! are replaced by placeholders; only its `Y` (public in the spent set), keyset and amount stay.
//! Replay never re-checks those fields (the request passed the checks when it arrived), so a
//! stolen journal holds nothing spendable.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use blindbook_ledger::delta::ChainStats;
use blindbook_ledger::ops::Op;
use blindbook_ledger::wire::{BlindSignature, Input};
use serde::{Deserialize, Serialize};

/// A placeholder curve point (the format checks only look at its shape).
pub const REDACTED_POINT: &str =
    "020000000000000000000000000000000000000000000000000000000000000000";
pub const REDACTED_SECRET: &str = "redacted";

// One line per entry; the size difference between variants doesn't matter here.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "entry", rename_all = "snake_case")]
pub enum Entry {
    Op {
        op: Op,
        invalid: Vec<usize>,
        signatures: Vec<BlindSignature>,
    },
    Close {
        height: u64,
        chain: ChainStats,
    },
}

fn redact_inputs(inputs: &mut [Input]) {
    for i in inputs {
        i.proof.secret = REDACTED_SECRET.into();
        i.proof.c = REDACTED_POINT.into();
    }
}

/// The operation with every spent slip's secret and signature removed.
pub fn redact(op: &Op) -> Op {
    let mut op = op.clone();
    match &mut op {
        Op::Trades { reqs, .. } => {
            for r in reqs {
                redact_inputs(&mut r.inputs);
            }
        }
        Op::Swap { inputs, .. } | Op::Redeem { inputs, .. } | Op::Withdraw { inputs, .. } => {
            redact_inputs(inputs)
        }
        Op::ListMarket { .. } | Op::Credit { .. } | Op::Resolve { .. } => {}
    }
    op
}

pub struct Journal {
    path: PathBuf,
    file: File,
}

impl Journal {
    /// Open (or create) the journal and return the entries already in it.
    pub fn open(path: &Path) -> std::io::Result<(Journal, Vec<Entry>)> {
        let mut entries = Vec::new();
        if path.exists() {
            for (n, line) in BufReader::new(File::open(path)?).lines().enumerate() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let e = serde_json::from_str(&line)
                    .map_err(|e| std::io::Error::other(format!("journal line {}: {e}", n + 1)))?;
                entries.push(e);
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok((
            Journal {
                path: path.to_owned(),
                file,
            },
            entries,
        ))
    }

    /// Append one entry and flush it to disk before anyone gets an answer.
    pub fn append(&mut self, e: &Entry) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(e).map_err(std::io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.file.sync_data()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blindbook_ledger::wire::Proof;

    #[test]
    fn redaction_keeps_only_public_fields() {
        let input = Input {
            proof: Proof {
                amount: 8,
                id: "01aa".into(),
                secret: "very secret".into(),
                c: "03".to_string() + &"11".repeat(32),
            },
            y: "02".to_string() + &"22".repeat(32),
        };
        let op = Op::Swap {
            inputs: vec![input.clone()],
            outputs: vec![],
        };
        let r = redact(&op);
        let Op::Swap { inputs, .. } = &r else {
            panic!()
        };
        assert_eq!(inputs[0].proof.secret, REDACTED_SECRET);
        assert_eq!(inputs[0].proof.c, REDACTED_POINT);
        assert_eq!(inputs[0].y, input.y);
        assert_eq!(inputs[0].proof.amount, 8);
        let text = serde_json::to_string(&r).unwrap();
        assert!(!text.contains("very secret") && !text.contains(&"11".repeat(32)));
    }

    #[test]
    fn append_and_reopen() {
        let dir = std::env::temp_dir().join(format!("bb-journal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("journal.jsonl");
        let _ = std::fs::remove_file(&path);
        let (mut j, old) = Journal::open(&path).unwrap();
        assert!(old.is_empty());
        let e = Entry::Close {
            height: 5,
            chain: ChainStats::default(),
        };
        j.append(&e).unwrap();
        drop(j);
        let (_, old) = Journal::open(&path).unwrap();
        assert_eq!(old, vec![e]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
