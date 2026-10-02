//! In memory because a single backend instance is the supported deployment and
//! a throttle needs no durability.

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

const WINDOW: Duration = Duration::from_secs(15 * 60);
const PAIR_LIMIT: usize = 5;
const ADDRESS_LIMIT: usize = 20;
const EMAIL_DELAY_AFTER: usize = 50;
const MAX_DELAY_UNITS: u32 = 30;
/// Full sweeps keep the maps from growing with every address ever seen.
const SWEEP_EVERY: u64 = 256;

#[derive(Debug, PartialEq, Eq)]
pub struct Throttled {
    pub retry_after_secs: u64,
}

type Entries = VecDeque<(u64, Instant)>;

#[derive(Default)]
struct Inner {
    next_id: u64,
    by_pair: HashMap<(String, String), Entries>,
    by_address: HashMap<String, Entries>,
    by_email: HashMap<String, Entries>,
}

pub struct LoginThrottle {
    inner: Mutex<Inner>,
    /// One second in production; tests shrink it so the progressive delay is observable quickly.
    delay_unit: Duration,
}

impl Default for LoginThrottle {
    fn default() -> Self {
        Self::new(Duration::from_secs(1))
    }
}

/// An attempt counts as a failure from the moment it starts, so parallel
/// attempts cannot all pass before any has failed. Dropping it unfinished
/// leaves it counted.
pub struct Attempt {
    throttle: Arc<LoginThrottle>,
    id: u64,
    email: String,
    address: String,
    pub delay: Duration,
}

impl LoginThrottle {
    pub fn new(delay_unit: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            delay_unit,
        }
    }

    /// `email` must already be normalised and `address` already bucketed by `client_key`.
    pub fn begin(self: &Arc<Self>, email: &str, address: &str) -> Result<Attempt, Throttled> {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("throttle lock");
        inner.next_id += 1;
        let id = inner.next_id;
        if id.is_multiple_of(SWEEP_EVERY) {
            inner.sweep(now);
        }

        let pair_key = (email.to_string(), address.to_string());
        let pair = prune(inner.by_pair.entry(pair_key.clone()).or_default(), now);
        if pair >= PAIR_LIMIT {
            let retry = retry_after(&inner.by_pair[&pair_key], now);
            return Err(Throttled {
                retry_after_secs: retry,
            });
        }
        let from_address = prune(
            inner.by_address.entry(address.to_string()).or_default(),
            now,
        );
        if from_address >= ADDRESS_LIMIT {
            let retry = retry_after(&inner.by_address[address], now);
            return Err(Throttled {
                retry_after_secs: retry,
            });
        }
        let for_email = prune(inner.by_email.entry(email.to_string()).or_default(), now);

        let delay = if for_email >= EMAIL_DELAY_AFTER {
            let doublings = u32::try_from(for_email - EMAIL_DELAY_AFTER).unwrap_or(u32::MAX);
            let units = 1u32
                .checked_shl(doublings)
                .unwrap_or(MAX_DELAY_UNITS)
                .min(MAX_DELAY_UNITS);
            self.delay_unit * units
        } else {
            Duration::ZERO
        };

        inner
            .by_pair
            .get_mut(&pair_key)
            .expect("inserted")
            .push_back((id, now));
        inner
            .by_address
            .get_mut(address)
            .expect("inserted")
            .push_back((id, now));
        inner
            .by_email
            .get_mut(email)
            .expect("inserted")
            .push_back((id, now));
        drop(inner);

        Ok(Attempt {
            throttle: Arc::clone(self),
            id,
            email: email.to_string(),
            address: address.to_string(),
            delay,
        })
    }
}

impl Inner {
    fn sweep(&mut self, now: Instant) {
        for entries in self.by_pair.values_mut() {
            prune(entries, now);
        }
        for entries in self.by_address.values_mut() {
            prune(entries, now);
        }
        for entries in self.by_email.values_mut() {
            prune(entries, now);
        }
        self.by_pair.retain(|_, e| !e.is_empty());
        self.by_address.retain(|_, e| !e.is_empty());
        self.by_email.retain(|_, e| !e.is_empty());
    }
}

impl Attempt {
    /// Clears the failures for this email and address only. The per-email
    /// count is left to age out: clearing it would let an attacker who
    /// interleaves with the real user's logins keep guessing at full speed.
    pub fn succeed(self) {
        let mut inner = self.throttle.inner.lock().expect("throttle lock");
        inner
            .by_pair
            .remove(&(self.email.clone(), self.address.clone()));
        remove_attempt(inner.by_address.get_mut(&self.address), self.id);
        remove_attempt(inner.by_email.get_mut(&self.email), self.id);
    }

    /// For attempts that never reached a password check, such as a busy server.
    pub fn cancel(self) {
        let mut inner = self.throttle.inner.lock().expect("throttle lock");
        remove_attempt(
            inner
                .by_pair
                .get_mut(&(self.email.clone(), self.address.clone())),
            self.id,
        );
        remove_attempt(inner.by_address.get_mut(&self.address), self.id);
        remove_attempt(inner.by_email.get_mut(&self.email), self.id);
    }
}

fn remove_attempt(entries: Option<&mut Entries>, id: u64) {
    if let Some(entries) = entries {
        entries.retain(|(entry_id, _)| *entry_id != id);
    }
}

fn prune(entries: &mut Entries, now: Instant) -> usize {
    while entries
        .front()
        .is_some_and(|(_, at)| now.duration_since(*at) >= WINDOW)
    {
        entries.pop_front();
    }
    entries.len()
}

fn retry_after(entries: &Entries, now: Instant) -> u64 {
    let oldest = entries.front().map_or(now, |(_, at)| *at);
    let remaining = (oldest + WINDOW).saturating_duration_since(now);
    remaining.as_secs() + 1
}

/// IPv6 hosts and subscribers normally own a whole /64 and could rotate within
/// it to dodge per-address limits, so the prefix is the identity.
pub fn client_key(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn throttle() -> Arc<LoginThrottle> {
        Arc::new(LoginThrottle::new(Duration::from_secs(1)))
    }

    #[tokio::test(start_paused = true)]
    async fn sixth_attempt_for_a_pair_is_refused_even_while_the_first_are_pending() {
        let t = throttle();
        let attempts: Vec<_> = (0..5).map(|_| t.begin("a@x", "1.1.1.1").unwrap()).collect();
        let refused = t.begin("a@x", "1.1.1.1").err().unwrap();
        assert!(refused.retry_after_secs >= 1);
        drop(attempts);
        assert!(t.begin("a@x", "2.2.2.2").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn address_limit_spans_emails() {
        let t = throttle();
        for i in 0..20 {
            t.begin(&format!("user{i}@x"), "1.1.1.1").unwrap();
        }
        assert!(t.begin("another@x", "1.1.1.1").is_err());
        assert!(t.begin("another@x", "2.2.2.2").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn email_failures_from_many_addresses_delay_but_never_refuse() {
        let t = throttle();
        for i in 0..50 {
            let attempt = t.begin("a@x", &format!("10.0.0.{i}")).unwrap();
            assert_eq!(attempt.delay, Duration::ZERO);
        }
        let delays: Vec<u64> = (50..60)
            .map(|i| {
                t.begin("a@x", &format!("10.0.1.{i}"))
                    .unwrap()
                    .delay
                    .as_secs()
            })
            .collect();
        assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30, 30, 30, 30]);
    }

    #[tokio::test(start_paused = true)]
    async fn failures_age_out_after_the_window() {
        let t = throttle();
        for _ in 0..5 {
            t.begin("a@x", "1.1.1.1").unwrap();
        }
        assert!(t.begin("a@x", "1.1.1.1").is_err());
        tokio::time::advance(WINDOW + Duration::from_secs(1)).await;
        assert!(t.begin("a@x", "1.1.1.1").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn success_clears_the_pair_but_not_the_per_email_count() {
        let t = throttle();
        for _ in 0..4 {
            t.begin("a@x", "1.1.1.1").unwrap();
        }
        t.begin("a@x", "1.1.1.1").unwrap().succeed();
        for _ in 0..5 {
            t.begin("a@x", "1.1.1.1").unwrap();
        }
        assert!(t.begin("a@x", "1.1.1.1").is_err());

        let t = throttle();
        for i in 0..51 {
            t.begin("b@x", &format!("10.0.0.{i}")).unwrap();
        }
        t.begin("b@x", "9.9.9.9").unwrap().succeed();
        let next = t.begin("b@x", "9.9.9.8").unwrap();
        assert!(
            next.delay > Duration::ZERO,
            "per-email failures stay counted"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_attempts_are_not_counted() {
        let t = throttle();
        for _ in 0..10 {
            t.begin("a@x", "1.1.1.1").unwrap().cancel();
        }
        assert!(t.begin("a@x", "1.1.1.1").is_ok());
    }

    #[test]
    fn ipv6_is_bucketed_by_its_64_prefix_and_ipv4_is_kept_whole() {
        let a = client_key("2001:db8:1:2:aaaa::1".parse().unwrap());
        let b = client_key("2001:db8:1:2:bbbb::2".parse().unwrap());
        let c = client_key("2001:db8:1:3::1".parse().unwrap());
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(client_key("203.0.113.9".parse().unwrap()), "203.0.113.9");
        assert_eq!(
            client_key("::ffff:203.0.113.9".parse().unwrap()),
            "203.0.113.9"
        );
    }
}
