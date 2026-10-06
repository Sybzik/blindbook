//! Dump the determinism trace of a native build: `cargo run --release --example trace -- <out.bin>`.
//! CI compares it byte for byte with the wasm32 build's trace (see crates/blindbook-engine-wasm).
use blindbook_engine::vectors::all_vectors;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn main() {
    let out = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "trace-native.bin".into());
    let v = all_vectors();
    std::fs::write(&out, &v).expect("write trace");
    println!(
        "target={} bytes={} fnv1a64={:016x} -> {}",
        std::env::consts::ARCH,
        v.len(),
        fnv1a(&v),
        out
    );
}
