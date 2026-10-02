use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::available_parallelism;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher as _, PasswordVerifier as _, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use secrecy::{ExposeSecret, SecretString};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const MIN_PASSWORD_CHARS: usize = 12;
pub const MAX_PASSWORD_CHARS: usize = 256;

const MIN_PERMITS: usize = 2;
const MAX_PERMITS: usize = 4;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PasswordError {
    #[error(
        "The password must be between {MIN_PASSWORD_CHARS} and {MAX_PASSWORD_CHARS} characters."
    )]
    Length,
    /// Distinct from throttling so monitoring can tell a saturated server from a noisy client.
    #[error("The server is busy checking passwords; try again in a moment.")]
    Busy,
    #[error("Password hashing failed.")]
    Internal,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verification {
    Mismatch,
    /// `upgraded_hash` is set when the stored hash used older parameters, so the
    /// caller can persist it without forcing a password reset.
    Match {
        upgraded_hash: Option<String>,
    },
}

pub fn validate_length(password: &str) -> Result<(), PasswordError> {
    let chars = password.chars().count();
    if (MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&chars) {
        Ok(())
    } else {
        Err(PasswordError::Length)
    }
}

pub fn default_permit_count() -> usize {
    available_parallelism()
        .map_or(MIN_PERMITS, usize::from)
        .clamp(MIN_PERMITS, MAX_PERMITS)
}

/// Every hash or verify takes a permit without waiting: each costs ~19 MiB and
/// a core, and queueing would only move that memory into waiting tasks.
#[derive(Clone)]
pub struct PasswordService {
    params: Params,
    permits: Arc<Semaphore>,
    /// Built from the current parameters so a miss costs the same as a real
    /// verify even after the parameters are tuned.
    dummy_hash: Arc<str>,
    in_flight: Arc<AtomicUsize>,
    peak_in_flight: Arc<AtomicUsize>,
}

/// Holds a hashing permit and keeps the in-flight gauge honest, so a test can
/// check that the bound held under a burst.
struct Held {
    _permit: OwnedSemaphorePermit,
    in_flight: Arc<AtomicUsize>,
}

impl Drop for Held {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

impl PasswordService {
    pub fn new() -> Self {
        Self::with_params(Params::default(), default_permit_count())
    }

    pub fn with_params(params: Params, permits: usize) -> Self {
        let dummy_hash = hash_blocking(&params, "dummy password for unknown accounts")
            .expect("argon2 accepts its own default parameters");
        Self {
            params,
            permits: Arc::new(Semaphore::new(permits)),
            dummy_hash: dummy_hash.into(),
            in_flight: Arc::new(AtomicUsize::new(0)),
            peak_in_flight: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn acquire(&self) -> Result<Held, PasswordError> {
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| PasswordError::Busy)?;
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak_in_flight.fetch_max(now, Ordering::SeqCst);
        Ok(Held {
            _permit: permit,
            in_flight: self.in_flight.clone(),
        })
    }

    /// The most hashes ever running at once, for tests of the concurrency bound.
    pub fn peak_in_flight(&self) -> usize {
        self.peak_in_flight.load(Ordering::SeqCst)
    }

    /// Exposed so tests can saturate it and a later metrics layer can read it.
    pub fn permits(&self) -> &Arc<Semaphore> {
        &self.permits
    }

    pub async fn hash(&self, password: &SecretString) -> Result<String, PasswordError> {
        validate_length(password.expose_secret())?;
        let permit = self.acquire()?;
        let params = self.params.clone();
        let password = SecretString::from(password.expose_secret().to_owned());
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            hash_blocking(&params, password.expose_secret())
        })
        .await
        .map_err(|_| PasswordError::Internal)?
    }

    /// `stored` is `None` for an unknown or disabled account: the dummy hash is
    /// verified instead, so the caller's timing does not reveal which case it was.
    pub async fn verify(
        &self,
        stored: Option<&str>,
        password: &SecretString,
    ) -> Result<Verification, PasswordError> {
        let permit = self.acquire()?;
        // An over-long candidate can never be a real password, so it is checked
        // against the dummy rather than the account.
        let usable =
            stored.filter(|_| password.expose_secret().chars().count() <= MAX_PASSWORD_CHARS);
        let stored_is_real = usable.is_some();
        let hash = usable.unwrap_or(&self.dummy_hash).to_owned();
        let params = self.params.clone();
        let password = SecretString::from(password.expose_secret().to_owned());
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            verify_blocking(&params, &hash, stored_is_real, password.expose_secret())
        })
        .await
        .map_err(|_| PasswordError::Internal)?
    }
}

impl Default for PasswordService {
    fn default() -> Self {
        Self::new()
    }
}

fn argon2(params: &Params) -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params.clone())
}

fn hash_blocking(params: &Params, password: &str) -> Result<String, PasswordError> {
    let salt = SaltString::generate(&mut OsRng);
    argon2(params)
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| PasswordError::Internal)
}

fn verify_blocking(
    params: &Params,
    hash: &str,
    stored_is_real: bool,
    password: &str,
) -> Result<Verification, PasswordError> {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return Ok(Verification::Mismatch);
    };
    let matched = argon2(params)
        .verify_password(password.as_bytes(), &parsed)
        .is_ok();
    if !(matched && stored_is_real) {
        return Ok(Verification::Mismatch);
    }
    // Rehashing inside the same permit keeps the memory bound honest.
    let upgraded_hash = if uses_current_params(params, &parsed) {
        None
    } else {
        Some(hash_blocking(params, password)?)
    };
    Ok(Verification::Match { upgraded_hash })
}

fn uses_current_params(current: &Params, stored: &PasswordHash<'_>) -> bool {
    let Ok(stored_params) = Params::try_from(stored) else {
        return false;
    };
    stored.algorithm == Algorithm::Argon2id.ident()
        && stored.version == Some(Version::V0x13.into())
        && stored_params.m_cost() == current.m_cost()
        && stored_params.t_cost() == current.t_cost()
        && stored_params.p_cost() == current.p_cost()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(m_cost: u32, permits: usize) -> PasswordService {
        PasswordService::with_params(Params::new(m_cost, 1, 1, None).unwrap(), permits)
    }

    fn secret(s: &str) -> SecretString {
        SecretString::from(s.to_string())
    }

    #[tokio::test]
    async fn hash_is_argon2id_and_does_not_contain_the_password() {
        let password = "correct horse battery";
        let hash = service(8, 2).hash(&secret(password)).await.unwrap();
        assert!(hash.starts_with("$argon2id$"), "{hash}");
        assert!(!hash.contains(password));
    }

    #[tokio::test]
    async fn default_parameters_match_the_documented_cost() {
        let hash = PasswordService::new()
            .hash(&secret("correct horse battery"))
            .await
            .unwrap();
        assert!(hash.contains("m=19456,t=2,p=1"), "{hash}");
    }

    #[tokio::test]
    async fn password_length_rule_is_enforced_on_characters() {
        let svc = service(8, 2);
        for bad in ["", "short", &"x".repeat(11), &"x".repeat(257)] {
            assert_eq!(
                svc.hash(&secret(bad)).await.unwrap_err(),
                PasswordError::Length
            );
        }
        // Counted in characters, not bytes: 12 two-byte characters are allowed.
        assert!(svc.hash(&secret(&"é".repeat(12))).await.is_ok());
        assert!(svc.hash(&secret(&"x".repeat(256))).await.is_ok());
    }

    #[tokio::test]
    async fn verify_accepts_the_right_password_and_rejects_others() {
        let svc = service(8, 2);
        let hash = svc.hash(&secret("correct horse battery")).await.unwrap();
        assert_eq!(
            svc.verify(Some(&hash), &secret("correct horse battery"))
                .await
                .unwrap(),
            Verification::Match {
                upgraded_hash: None
            }
        );
        assert_eq!(
            svc.verify(Some(&hash), &secret("wrong horse battery"))
                .await
                .unwrap(),
            Verification::Mismatch
        );
    }

    #[tokio::test]
    async fn unknown_account_and_overlong_candidate_never_match() {
        let svc = service(8, 2);
        assert_eq!(
            svc.verify(None, &secret("dummy password for unknown accounts"))
                .await
                .unwrap(),
            Verification::Mismatch
        );
        let hash = svc.hash(&secret(&"x".repeat(256))).await.unwrap();
        assert_eq!(
            svc.verify(Some(&hash), &secret(&"x".repeat(257)))
                .await
                .unwrap(),
            Verification::Mismatch
        );
    }

    #[tokio::test]
    async fn dummy_hash_uses_the_current_parameters() {
        let svc = service(16, 2);
        let parsed = PasswordHash::new(&svc.dummy_hash).unwrap();
        assert!(uses_current_params(&svc.params, &parsed));
    }

    #[tokio::test]
    async fn hash_with_older_params_is_replaced_after_a_successful_verify() {
        let old = service(8, 2);
        let current = service(16, 2);
        let old_hash = old.hash(&secret("correct horse battery")).await.unwrap();

        let Verification::Match {
            upgraded_hash: Some(new_hash),
        } = current
            .verify(Some(&old_hash), &secret("correct horse battery"))
            .await
            .unwrap()
        else {
            panic!("expected an upgraded hash");
        };
        assert!(new_hash.contains("m=16,t=1,p=1"), "{new_hash}");
        assert_eq!(
            current
                .verify(Some(&new_hash), &secret("correct horse battery"))
                .await
                .unwrap(),
            Verification::Match {
                upgraded_hash: None
            }
        );

        assert_eq!(
            current
                .verify(Some(&old_hash), &secret("wrong horse battery"))
                .await
                .unwrap(),
            Verification::Mismatch
        );
    }

    #[tokio::test]
    async fn saturated_semaphore_answers_busy_without_hashing() {
        let svc = service(8, 1);
        let held = svc.permits().clone().try_acquire_owned().unwrap();
        assert_eq!(
            svc.hash(&secret("correct horse battery"))
                .await
                .unwrap_err(),
            PasswordError::Busy
        );
        assert_eq!(
            svc.verify(None, &secret("correct horse battery"))
                .await
                .unwrap_err(),
            PasswordError::Busy
        );
        drop(held);
        assert!(svc.hash(&secret("correct horse battery")).await.is_ok());
    }

    #[test]
    fn permit_count_is_clamped() {
        assert!((MIN_PERMITS..=MAX_PERMITS).contains(&default_permit_count()));
    }
}
