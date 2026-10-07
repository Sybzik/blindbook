//! Plain C-ABI exports, no wasm-bindgen: the engine's determinism vectors (CI), and the replay of
//! the public record's batches for the browser verifier. Results are left in a thread-local
//! buffer; JS reads them through `buf_ptr` / `buf_len`, and writes input into memory it got from
//! `alloc`.

use blindbook_engine::vectors::all_vectors;
use std::cell::RefCell;

thread_local! {
    static BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Run the full determinism vector set; returns the trace length in bytes.
#[unsafe(no_mangle)]
pub extern "C" fn vectors_run() -> u32 {
    let v = all_vectors();
    let n = v.len() as u32;
    BUF.with(|b| *b.borrow_mut() = v);
    n
}

#[unsafe(no_mangle)]
pub extern "C" fn buf_ptr() -> *const u8 {
    BUF.with(|b| b.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn buf_len() -> u32 {
    BUF.with(|b| b.borrow().len() as u32)
}

/// Memory for JS to write `len` bytes of input into (freed by the next `replay`).
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    INPUT.with(|i| {
        let mut v = i.borrow_mut();
        *v = vec![0; len as usize];
        v.as_mut_ptr()
    })
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Replay every batch of the deltas in the input (a JSON array of deltas as published, in log
/// order: parsed here, so no number passes through a JS double). The buffer gets
/// `{"batches": n, "failures": [...]}`; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn replay() -> u32 {
    let out = INPUT.with(|i| {
        let input = std::mem::take(&mut *i.borrow_mut());
        match serde_json::from_slice::<Vec<blindbook_ledger::delta::Delta>>(&input) {
            Ok(deltas) => {
                let batches: Vec<_> = deltas.into_iter().flat_map(|d| d.batches).collect();
                serde_json::json!({
                    "batches": batches.len(),
                    "failures": blindbook_ledger::replay::replay_all(&batches),
                })
            }
            Err(e) => {
                serde_json::json!({ "batches": 0, "failures": [format!("unreadable deltas: {e}")] })
            }
        }
    });
    let bytes = out.to_string().into_bytes();
    let n = bytes.len() as u32;
    BUF.with(|b| *b.borrow_mut() = bytes);
    n
}
