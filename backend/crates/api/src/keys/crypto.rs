use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng, Payload};
use chacha20poly1305::{AeadCore, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use super::{AiProvider, UserApiKey};
use crate::config::Keyring;

/// Versioned so the AAD layout can change later without old rows decrypting ambiguously.
const AAD_PREFIX: &str = "songbird/user-api-key/v1";

/// Ciphertext and nonce are base64 text because the database layer keeps column types
/// identical across backends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedKey {
    pub key_version: String,
    pub nonce: String,
    pub ciphertext: String,
}

/// Variants carry no detail: the cause of a failure must not help distinguish tampering from
/// a wrong key, and nothing here may echo key material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("no master key has this version")]
    UnknownKeyVersion,
    #[error("the stored key could not be decrypted")]
    Decrypt,
    #[error("the key could not be encrypted")]
    Encrypt,
}

/// Binding user and provider means ciphertext copied into another row fails to authenticate
/// instead of being used.
fn associated_data(user_id: &str, provider: AiProvider) -> Vec<u8> {
    format!("{AAD_PREFIX}\0{user_id}\0{}", provider.as_str()).into_bytes()
}

pub fn encrypt(
    keyring: &Keyring,
    user_id: &str,
    provider: AiProvider,
    key: &UserApiKey,
) -> Result<EncryptedKey, CryptoError> {
    let (version, master) = keyring.current();
    let cipher = XChaCha20Poly1305::new(master.into());
    // 192 bits make a random nonce safe without tracking how often a master key was used.
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: key.expose_secret().as_bytes(),
                aad: &associated_data(user_id, provider),
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;
    Ok(EncryptedKey {
        key_version: version.to_string(),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

pub fn decrypt(
    keyring: &Keyring,
    user_id: &str,
    provider: AiProvider,
    stored: &EncryptedKey,
) -> Result<UserApiKey, CryptoError> {
    let master = keyring
        .get(&stored.key_version)
        .ok_or(CryptoError::UnknownKeyVersion)?;
    let nonce = BASE64
        .decode(&stored.nonce)
        .ok()
        .filter(|n| n.len() == 24)
        .ok_or(CryptoError::Decrypt)?;
    let ciphertext = BASE64
        .decode(&stored.ciphertext)
        .map_err(|_| CryptoError::Decrypt)?;
    let plaintext = Zeroizing::new(
        XChaCha20Poly1305::new(master.into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &associated_data(user_id, provider),
                },
            )
            .map_err(|_| CryptoError::Decrypt)?,
    );
    let text = std::str::from_utf8(&plaintext).map_err(|_| CryptoError::Decrypt)?;
    Ok(UserApiKey::new(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "sk-ant-api03-SENTINELSECRETVALUE";

    fn ring(spec: &str) -> Keyring {
        Keyring::parse(spec).unwrap()
    }

    fn key_entry(version: &str, byte: u8) -> String {
        format!("{version}:{}", BASE64.encode([byte; 32]))
    }

    fn sealed(keyring: &Keyring) -> EncryptedKey {
        encrypt(
            keyring,
            "user-a",
            AiProvider::Anthropic,
            &UserApiKey::new(SECRET.to_string()),
        )
        .unwrap()
    }

    #[test]
    fn round_trips_and_records_the_current_version() {
        let keyring = ring(&format!("{},{}", key_entry("v2", 2), key_entry("v1", 1)));
        let stored = sealed(&keyring);
        assert_eq!(stored.key_version, "v2");
        let key = decrypt(&keyring, "user-a", AiProvider::Anthropic, &stored).unwrap();
        assert_eq!(key.expose_secret(), SECRET);
    }

    #[test]
    fn an_older_version_still_decrypts_through_the_keyring() {
        let old = ring(&key_entry("v1", 1));
        let stored = sealed(&old);
        let rotated = ring(&format!("{},{}", key_entry("v2", 2), key_entry("v1", 1)));
        let key = decrypt(&rotated, "user-a", AiProvider::Anthropic, &stored).unwrap();
        assert_eq!(key.expose_secret(), SECRET);
    }

    #[test]
    fn the_same_key_encrypts_differently_each_time() {
        let keyring = ring(&key_entry("v1", 1));
        let (a, b) = (sealed(&keyring), sealed(&keyring));
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn stored_text_contains_no_part_of_the_key() {
        let stored = sealed(&ring(&key_entry("v1", 1)));
        for text in [&stored.nonce, &stored.ciphertext] {
            assert!(!text.contains("SENTINEL"));
        }
    }

    #[test]
    fn a_swapped_user_or_provider_fails_to_decrypt() {
        let keyring = ring(&key_entry("v1", 1));
        let stored = sealed(&keyring);
        assert_eq!(
            decrypt(&keyring, "user-b", AiProvider::Anthropic, &stored).unwrap_err(),
            CryptoError::Decrypt
        );
        assert_eq!(
            decrypt(&keyring, "user-a", AiProvider::Openai, &stored).unwrap_err(),
            CryptoError::Decrypt
        );
    }

    #[test]
    fn a_different_key_under_the_same_version_fails_to_decrypt() {
        let stored = sealed(&ring(&key_entry("v1", 1)));
        let other = ring(&key_entry("v1", 9));
        assert_eq!(
            decrypt(&other, "user-a", AiProvider::Anthropic, &stored).unwrap_err(),
            CryptoError::Decrypt
        );
    }

    #[test]
    fn a_missing_version_is_reported_as_unknown() {
        let stored = sealed(&ring(&key_entry("v1", 1)));
        let other = ring(&key_entry("v2", 1));
        assert_eq!(
            decrypt(&other, "user-a", AiProvider::Anthropic, &stored).unwrap_err(),
            CryptoError::UnknownKeyVersion
        );
    }

    #[test]
    fn tampered_ciphertext_or_nonce_fails_to_decrypt() {
        let keyring = ring(&key_entry("v1", 1));
        let stored = sealed(&keyring);

        let mut bytes = BASE64.decode(&stored.ciphertext).unwrap();
        bytes[0] ^= 1;
        let flipped = EncryptedKey {
            ciphertext: BASE64.encode(bytes),
            ..stored.clone()
        };
        let mut nonce = BASE64.decode(&stored.nonce).unwrap();
        nonce[0] ^= 1;
        let bad_nonce = EncryptedKey {
            nonce: BASE64.encode(nonce),
            ..stored.clone()
        };
        let truncated = EncryptedKey {
            ciphertext: BASE64.encode(&BASE64.decode(&stored.ciphertext).unwrap()[..8]),
            ..stored.clone()
        };
        let garbage = EncryptedKey {
            nonce: "!!".into(),
            ..stored
        };
        for bad in [flipped, bad_nonce, truncated, garbage] {
            assert_eq!(
                decrypt(&keyring, "user-a", AiProvider::Anthropic, &bad).unwrap_err(),
                CryptoError::Decrypt
            );
        }
    }

    #[test]
    fn the_key_type_never_prints_its_contents() {
        let key = UserApiKey::new(SECRET.to_string());
        assert!(!format!("{key:?}").contains("SENTINEL"));
        assert_eq!(key.last4(), "ALUE");
        assert_eq!(UserApiKey::new("ab".to_string()).last4(), "ab");
    }
}
