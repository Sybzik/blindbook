//! Bit-exact trace of every f64 intermediate and integer output, used to compare
//! native x86_64 against wasm32. Disabled traces cost one branch per push.

use alloc::vec::Vec;

pub struct Trace {
    on: bool,
    words: Vec<u64>,
}

impl Trace {
    pub fn off() -> Self {
        Trace {
            on: false,
            words: Vec::new(),
        }
    }
    pub fn on() -> Self {
        Trace {
            on: true,
            words: Vec::with_capacity(1 << 16),
        }
    }
    #[inline]
    pub fn f(&mut self, x: f64) {
        if self.on {
            self.words.push(x.to_bits());
        }
    }
    #[inline]
    pub fn u(&mut self, x: u64) {
        if self.on {
            self.words.push(x);
        }
    }
    #[inline]
    pub fn i(&mut self, x: i64) {
        if self.on {
            self.words.push(x as u64);
        }
    }
    /// Section marker so a diff can be located.
    #[inline]
    pub fn tag(&mut self, t: u32) {
        if self.on {
            self.words.push(0xB10B_0000_0000_0000 | t as u64);
        }
    }
    pub fn len(&self) -> usize {
        self.words.len()
    }
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }
    pub fn words(&self) -> &[u64] {
        &self.words
    }
    pub fn to_le_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.words.len() * 8);
        for w in &self.words {
            out.extend_from_slice(&w.to_le_bytes());
        }
        out
    }
}
