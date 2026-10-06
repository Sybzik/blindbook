//! Plain C-ABI exports so Node can run the engine's determinism vectors without wasm-bindgen.
//! The trace is left in a thread-local buffer; JS reads it through `buf_ptr` / `buf_len`.

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
