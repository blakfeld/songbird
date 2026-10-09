//! One implementation for every bearer secret the service hands out (session
//! cookies and share links), so they cannot drift apart in strength or in how
//! they are stored.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use secrecy::SecretString;
use sha2::{Digest, Sha256};

const TOKEN_BYTES: usize = 32;
pub const TOKEN_CHARS: usize = 43;

pub fn generate_token() -> SecretString {
    use argon2::password_hash::rand_core::{OsRng, RngCore};

    let mut bytes = [0u8; TOKEN_BYTES];
    OsRng.fill_bytes(&mut bytes);
    SecretString::from(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn sha256_hex(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Only this digest is stored, so a leaked table cannot be replayed as working credentials.
pub fn hash_token(token: &str) -> String {
    sha256_hex(token)
}

/// Lets a caller refuse garbage before any database work, which also keeps
/// attacker-chosen strings out of queries.
pub fn is_well_formed(token: &str) -> bool {
    token.len() == TOKEN_CHARS
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret;

    use super::*;

    #[test]
    fn generated_tokens_are_well_formed() {
        let token = generate_token();
        assert!(is_well_formed(token.expose_secret()));
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        assert!(!is_well_formed("abc"));
        assert!(!is_well_formed(&"a".repeat(44)));
        assert!(!is_well_formed(&format!("{}!", "a".repeat(42))));
        assert!(!is_well_formed(&"é".repeat(22)));
    }
}
