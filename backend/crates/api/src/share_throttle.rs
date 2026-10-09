//! In memory for the same reason as the login throttle: one backend instance is
//! the supported deployment, and the per-share comment cap in the database
//! bounds storage even when a restart resets these counters.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

use crate::auth::throttle::Throttled;
use crate::config::Config;

const MINUTE: Duration = Duration::from_secs(60);
const TEN_MINUTES: Duration = Duration::from_secs(10 * 60);
const DAY: Duration = Duration::from_secs(24 * 3600);
/// The scan runs on a background task, off the request path.
const SWEEP_INTERVAL: Duration = MINUTE;
/// Addresses are attacker-spreadable, so without a ceiling a flood of distinct sources grows
/// memory until the next sweep. New addresses are refused rather than evicting old ones,
/// because eviction would let a flood reset the counters of the very addresses it is abusing.
/// Applied to the read and comment tables separately, because comment entries live a day and
/// a comment flood must not be able to lock listeners out of reads.
const DEFAULT_MAX_TRACKED_ADDRESSES: usize = 100_000;

type Hits = VecDeque<Instant>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShareLimits {
    pub reads_per_minute: usize,
    pub comments_per_address_10m: usize,
    pub comments_per_address_day: usize,
    pub comments_per_share_day: usize,
}

impl ShareLimits {
    pub fn from_config(config: &Config) -> Self {
        Self {
            reads_per_minute: config.share_reads_per_minute as usize,
            comments_per_address_10m: config.comments_per_address_10m as usize,
            comments_per_address_day: config.comments_per_address_day as usize,
            comments_per_share_day: config.comments_per_share_day as usize,
        }
    }
}

#[derive(Default)]
struct Inner {
    reads: HashMap<String, Hits>,
    comments: HashMap<String, Hits>,
    shares: HashMap<String, Hits>,
}

impl Inner {
    fn sweep(&mut self, now: Instant) {
        for (map, retention) in [
            (&mut self.reads, MINUTE),
            (&mut self.comments, DAY),
            (&mut self.shares, DAY),
        ] {
            for hits in map.values_mut() {
                prune(hits, now, retention);
            }
            map.retain(|_, hits| !hits.is_empty());
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Use {
    Record,
    Peek,
}

pub struct ShareThrottle {
    limits: ShareLimits,
    max_tracked_addresses: usize,
    inner: Mutex<Inner>,
}

impl ShareThrottle {
    pub fn new(limits: ShareLimits) -> Self {
        Self::with_address_cap(limits, DEFAULT_MAX_TRACKED_ADDRESSES)
    }

    pub fn with_address_cap(limits: ShareLimits, max_tracked_addresses: usize) -> Self {
        Self {
            limits,
            max_tracked_addresses,
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn sweep(&self) {
        self.inner
            .lock()
            .expect("share throttle lock")
            .sweep(Instant::now());
    }

    pub fn spawn_sweeper(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
            loop {
                ticker.tick().await;
                self.sweep();
            }
        })
    }

    /// `address` must already be bucketed by `client_key`.
    pub fn check_read(&self, address: &str) -> Result<(), Throttled> {
        let limit = self.limits.reads_per_minute;
        self.admit(
            |inner| &mut inner.reads,
            address,
            &[(MINUTE, limit)],
            MINUTE,
            Use::Record,
            true,
        )
    }

    /// Called before the body is parsed, so a request that later fails
    /// validation has already been counted and cannot be used as a free probe.
    pub fn check_comment_address(&self, address: &str) -> Result<(), Throttled> {
        let windows = [
            (TEN_MINUTES, self.limits.comments_per_address_10m),
            (DAY, self.limits.comments_per_address_day),
        ];
        self.admit(
            |inner| &mut inner.comments,
            address,
            &windows,
            DAY,
            Use::Record,
            true,
        )
    }

    /// Does not count the attempt: invalid and honeypot posts must not use up the
    /// link's budget, or one bot could silence a link for every real listener.
    pub fn check_comment_share(&self, share_id: &str) -> Result<(), Throttled> {
        self.admit_share(share_id, Use::Peek)
    }

    /// Called only once a comment is stored. Share ids come from stored links, so
    /// this map is bounded by the database rather than by the address cap.
    pub fn record_comment_share(&self, share_id: &str) {
        let _ = self.admit_share(share_id, Use::Record);
    }

    fn admit_share(&self, share_id: &str, usage: Use) -> Result<(), Throttled> {
        let limit = self.limits.comments_per_share_day;
        self.admit(
            |inner| &mut inner.shares,
            share_id,
            &[(DAY, limit)],
            DAY,
            usage,
            false,
        )
    }

    /// A refused request is not recorded, so `Retry-After` stays accurate
    /// instead of being pushed out by the client's own retries.
    fn admit(
        &self,
        map: impl Fn(&mut Inner) -> &mut HashMap<String, Hits>,
        key: &str,
        windows: &[(Duration, usize)],
        retention: Duration,
        usage: Use,
        counts_toward_cap: bool,
    ) -> Result<(), Throttled> {
        let now = Instant::now();
        let mut inner = self.inner.lock().expect("share throttle lock");

        let map = map(&mut inner);
        let is_new = !map.contains_key(key);
        if is_new && counts_toward_cap && map.len() >= self.max_tracked_addresses {
            // Room opens only when entries age out, which takes at most the retention plus one
            // sweep; the exact time would need a scan under the lock, so this is an upper bound.
            return Err(Throttled {
                retry_after_secs: (retention + SWEEP_INTERVAL).as_secs(),
            });
        }

        if is_new && usage == Use::Peek {
            return Ok(());
        }
        let hits = map.entry(key.to_string()).or_default();
        prune(hits, now, retention);
        let mut retry_after: Option<u64> = None;
        for &(window, limit) in windows {
            let in_window = hits
                .iter()
                .rev()
                .take_while(|at| now.duration_since(**at) < window)
                .count();
            if in_window >= limit {
                let blocking = hits[hits.len() - limit];
                let wait = window.saturating_sub(now.duration_since(blocking));
                let seconds = wait.as_secs() + 1;
                retry_after = Some(retry_after.map_or(seconds, |current| current.max(seconds)));
            }
        }
        if let Some(retry_after_secs) = retry_after {
            return Err(Throttled { retry_after_secs });
        }
        if usage == Use::Record {
            hits.push_back(now);
        }
        Ok(())
    }

    #[cfg(test)]
    fn tracked_keys(&self) -> usize {
        let inner = self.inner.lock().unwrap();
        inner.reads.len() + inner.comments.len() + inner.shares.len()
    }
}

fn prune(hits: &mut Hits, now: Instant, retention: Duration) {
    while hits
        .front()
        .is_some_and(|at| now.duration_since(*at) >= retention)
    {
        hits.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn throttle(reads: usize, ten_min: usize, day: usize, share_day: usize) -> ShareThrottle {
        ShareThrottle::new(limits(reads, ten_min, day, share_day))
    }

    fn limits(reads: usize, ten_min: usize, day: usize, share_day: usize) -> ShareLimits {
        ShareLimits {
            reads_per_minute: reads,
            comments_per_address_10m: ten_min,
            comments_per_address_day: day,
            comments_per_share_day: share_day,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn reads_are_limited_per_address_per_minute() {
        let t = throttle(3, 5, 30, 200);
        for _ in 0..3 {
            t.check_read("a").unwrap();
        }
        let refused = t.check_read("a").unwrap_err();
        assert!((1..=61).contains(&refused.retry_after_secs));
        t.check_read("b").unwrap();

        tokio::time::advance(MINUTE).await;
        t.check_read("a").unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn retry_after_counts_down_to_the_oldest_hit_leaving() {
        let t = throttle(2, 5, 30, 200);
        t.check_read("a").unwrap();
        tokio::time::advance(Duration::from_secs(40)).await;
        t.check_read("a").unwrap();
        let refused = t.check_read("a").unwrap_err();
        assert_eq!(refused.retry_after_secs, 21);
    }

    #[tokio::test(start_paused = true)]
    async fn comments_have_a_ten_minute_window_per_address() {
        let t = throttle(60, 2, 30, 200);
        t.check_comment_address("a").unwrap();
        t.check_comment_address("a").unwrap();
        assert!(t.check_comment_address("a").is_err());
        t.check_comment_address("b").unwrap();

        tokio::time::advance(TEN_MINUTES).await;
        t.check_comment_address("a").unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn comments_have_a_daily_window_per_address() {
        let t = throttle(60, 2, 3, 200);
        for _ in 0..3 {
            t.check_comment_address("a").unwrap();
            tokio::time::advance(TEN_MINUTES).await;
        }
        let refused = t.check_comment_address("a").unwrap_err();
        assert!(refused.retry_after_secs > TEN_MINUTES.as_secs());

        tokio::time::advance(DAY).await;
        t.check_comment_address("a").unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn only_recorded_comments_use_up_a_shares_daily_budget() {
        let t = throttle(60, 5, 30, 2);
        for _ in 0..10 {
            t.check_comment_share("s1").unwrap();
        }
        t.record_comment_share("s1");
        t.check_comment_share("s1").unwrap();
        t.record_comment_share("s1");
        assert!(t.check_comment_share("s1").is_err());
        t.check_comment_share("s2").unwrap();

        tokio::time::advance(DAY).await;
        t.check_comment_share("s1").unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn checking_a_share_without_recording_creates_no_entry() {
        let t = throttle(60, 5, 30, 2);
        t.check_comment_share("s1").unwrap();
        assert_eq!(t.tracked_keys(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_request_does_not_extend_the_window() {
        let t = throttle(1, 5, 30, 200);
        t.check_read("a").unwrap();
        for _ in 0..10 {
            assert!(t.check_read("a").is_err());
        }
        tokio::time::advance(MINUTE).await;
        t.check_read("a").unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn sweeping_drops_idle_keys() {
        let t = throttle(60, 5, 30, 200);
        for n in 0..10 {
            t.check_read(&format!("addr-{n}")).unwrap();
            t.check_comment_address(&format!("addr-{n}")).unwrap();
            t.check_comment_share(&format!("share-{n}")).unwrap();
            t.record_comment_share(&format!("share-{n}"));
        }
        assert_eq!(t.tracked_keys(), 30);

        tokio::time::advance(DAY).await;
        t.sweep();
        assert_eq!(t.tracked_keys(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn requests_do_not_sweep_so_the_scan_stays_off_the_request_path() {
        let t = throttle(60, 5, 30, 200);
        t.check_read("old").unwrap();
        tokio::time::advance(DAY).await;
        for n in 0..1000 {
            t.check_read(&format!("fresh-{n}")).unwrap();
        }
        assert_eq!(t.inner.lock().unwrap().reads.len(), 1001);
    }

    #[tokio::test(start_paused = true)]
    async fn the_background_task_sweeps_on_its_interval() {
        let t = Arc::new(throttle(60, 5, 30, 200));
        t.check_read("a").unwrap();
        let task = t.clone().spawn_sweeper();

        tokio::time::advance(SWEEP_INTERVAL + MINUTE).await;
        tokio::task::yield_now().await;
        assert_eq!(t.tracked_keys(), 0);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn new_addresses_are_refused_at_the_cap_but_known_ones_continue() {
        let t = ShareThrottle::with_address_cap(limits(60, 5, 30, 200), 2);
        t.check_read("a").unwrap();
        t.check_read("b").unwrap();

        let refused = t.check_read("c").unwrap_err();
        assert_eq!(
            refused.retry_after_secs,
            (MINUTE + SWEEP_INTERVAL).as_secs()
        );
        assert_eq!(t.tracked_keys(), 2);

        t.check_read("a").unwrap();

        tokio::time::advance(MINUTE).await;
        t.sweep();
        t.check_read("c").unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_full_comments_table_does_not_block_reads() {
        let t = ShareThrottle::with_address_cap(limits(60, 5, 30, 200), 2);
        t.check_comment_address("a").unwrap();
        t.check_comment_address("b").unwrap();

        let refused = t.check_comment_address("c").unwrap_err();
        assert_eq!(refused.retry_after_secs, (DAY + SWEEP_INTERVAL).as_secs());
        t.check_read("c").unwrap();
        t.check_read("d").unwrap();
        assert!(t.check_read("e").is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn the_cap_does_not_stop_recording_stored_comments_for_a_share() {
        let t = ShareThrottle::with_address_cap(limits(60, 5, 30, 1), 1);
        t.check_read("a").unwrap();
        t.record_comment_share("s1");
        assert!(t.check_comment_share("s1").is_err());
    }
}
