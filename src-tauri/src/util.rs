use sha2::{Digest, Sha256};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// A poisoned lock only means another thread panicked mid-update. Every guarded value here is plain
/// data that stays valid, and refusing to read it would turn one bug into a dead app.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes).as_slice())
}

#[cfg(test)]
mod tests {
    use super::sha256_hex;

    #[test]
    fn sha256_hex_preserves_leading_zeroes() {
        assert_eq!(
            sha256_hex(b"draft-canvas-828"),
            "00936c9bdd3a9a25a66794c8adf312db941e57e5f1a913951150d134bd2ffb56"
        );
    }
}
