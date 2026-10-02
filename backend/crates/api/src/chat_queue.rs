//! The hand-off between a streamed chat's task and its response body. Hyper stops polling a body
//! whose socket is full, so a client that never reads would otherwise let an unbounded queue
//! grow for as long as the provider keeps streaming. Here the only unbounded-looking part, reply
//! text, is coalesced and capped, and everything else is a handful of events per request.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use futures_util::task::AtomicWaker;
use music::chat::{ChatEvent, ChatReplyDelta};

/// Enough for any realistic chat reply, small enough that a stalled client costs little.
/// Text past it is dropped for the rest of the attempt; the `result` still carries the reply.
pub const MAX_UNSENT_REPLY_BYTES: usize = 64 * 1024;

enum Entry {
    Event(ChatEvent),
    /// Reply text not yet written to the client, kept apart from the events so consecutive
    /// fragments merge into one `reply_delta` while keeping their place among the other events.
    Text(String),
}

#[derive(Default)]
struct Queue {
    entries: VecDeque<Entry>,
    unsent_text_bytes: usize,
    /// Once any text of an attempt is dropped, later text must be too, or the client would see
    /// a gap and the deltas would stop being a prefix of the reply.
    text_capped: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    waker: AtomicWaker,
    senders: AtomicUsize,
}

pub struct EventSender(Arc<Shared>);

pub struct EventReceiver(Arc<Shared>);

pub fn channel() -> (EventSender, EventReceiver) {
    let shared = Arc::new(Shared {
        queue: Mutex::default(),
        waker: AtomicWaker::new(),
        senders: AtomicUsize::new(1),
    });
    (EventSender(shared.clone()), EventReceiver(shared))
}

impl EventSender {
    pub fn send(&self, event: ChatEvent) {
        let mut queue = self
            .0
            .queue
            .lock()
            .expect("no panic while the lock is held");
        match event {
            ChatEvent::ReplyDelta(ChatReplyDelta { text }) => queue.push_text(text),
            ChatEvent::ReplyReset(reset) => {
                // The client discards its text on a reset, so text it has not been sent yet is
                // dead weight and is dropped rather than delivered just to be thrown away.
                queue
                    .entries
                    .retain(|entry| !matches!(entry, Entry::Text(_)));
                queue.unsent_text_bytes = 0;
                queue.text_capped = false;
                queue
                    .entries
                    .push_back(Entry::Event(ChatEvent::ReplyReset(reset)));
            }
            other => queue.entries.push_back(Entry::Event(other)),
        }
        drop(queue);
        self.0.waker.wake();
    }
}

impl Queue {
    fn push_text(&mut self, text: String) {
        if self.text_capped || self.unsent_text_bytes + text.len() > MAX_UNSENT_REPLY_BYTES {
            self.text_capped = true;
            return;
        }
        self.unsent_text_bytes += text.len();
        match self.entries.back_mut() {
            Some(Entry::Text(pending)) => pending.push_str(&text),
            _ => self.entries.push_back(Entry::Text(text)),
        }
    }
}

impl Clone for EventSender {
    fn clone(&self) -> Self {
        self.0.senders.fetch_add(1, Ordering::SeqCst);
        Self(self.0.clone())
    }
}

impl Drop for EventSender {
    fn drop(&mut self) {
        if self.0.senders.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.waker.wake();
        }
    }
}

impl EventReceiver {
    pub fn poll_recv(&mut self, cx: &mut Context<'_>) -> Poll<Option<ChatEvent>> {
        // Registered before looking, so a send that lands in between still wakes this task.
        self.0.waker.register(cx.waker());
        let mut queue = self
            .0
            .queue
            .lock()
            .expect("no panic while the lock is held");
        match queue.entries.pop_front() {
            Some(Entry::Event(event)) => Poll::Ready(Some(event)),
            Some(Entry::Text(text)) => {
                queue.unsent_text_bytes -= text.len();
                Poll::Ready(Some(ChatEvent::ReplyDelta(ChatReplyDelta { text })))
            }
            None if self.0.senders.load(Ordering::SeqCst) == 0 => Poll::Ready(None),
            None => Poll::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use music::chat::{ChatProgress, ChatReplyReset, ChatResponse};

    fn delta(text: &str) -> ChatEvent {
        ChatEvent::ReplyDelta(ChatReplyDelta { text: text.into() })
    }

    fn drain(receiver: &mut EventReceiver) -> Vec<ChatEvent> {
        let waker = futures_util::task::noop_waker();
        let mut cx = Context::from_waker(&waker);
        std::iter::from_fn(|| match receiver.poll_recv(&mut cx) {
            Poll::Ready(event) => event,
            Poll::Pending => None,
        })
        .collect()
    }

    #[test]
    fn deltas_produced_while_nobody_reads_arrive_as_one_event() {
        let (tx, mut rx) = channel();
        tx.send(ChatEvent::Progress(ChatProgress::Planning));
        for fragment in ["Add", "ing ", "drums"] {
            tx.send(delta(fragment));
        }
        tx.send(ChatEvent::Progress(ChatProgress::Writing {
            name: "D".into(),
            instrument: "drums".into(),
        }));
        tx.send(delta("late"));

        let events = drain(&mut rx);
        assert_eq!(events.len(), 4);
        assert_eq!(events[1], delta("Adding drums"));
        assert_eq!(events[3], delta("late"));
        assert!(matches!(events[2], ChatEvent::Progress(_)));
    }

    #[test]
    fn unsent_text_is_capped_and_later_text_is_dropped_so_the_prefix_holds() {
        let (tx, mut rx) = channel();
        let chunk = "x".repeat(MAX_UNSENT_REPLY_BYTES / 2);
        tx.send(delta(&chunk));
        tx.send(delta(&chunk));
        tx.send(delta("over the cap"));
        // Fits, but must still be dropped: the earlier fragment was lost.
        tx.send(delta("a"));
        let result = ChatEvent::Result(ChatResponse::reply_only("full reply"));
        tx.send(result.clone());

        let events = drain(&mut rx);
        assert_eq!(events.len(), 2);
        let ChatEvent::ReplyDelta(ChatReplyDelta { text }) = &events[0] else {
            panic!("expected the coalesced delta");
        };
        assert_eq!(text.len(), MAX_UNSENT_REPLY_BYTES);
        assert_eq!(events[1], result);
    }

    #[test]
    fn a_reset_clears_unsent_text_and_lifts_the_cap() {
        let (tx, mut rx) = channel();
        tx.send(delta(&"x".repeat(MAX_UNSENT_REPLY_BYTES)));
        tx.send(delta("dropped"));
        tx.send(ChatEvent::ReplyReset(ChatReplyReset {}));
        tx.send(delta("second attempt"));

        assert_eq!(
            drain(&mut rx),
            vec![
                ChatEvent::ReplyReset(ChatReplyReset {}),
                delta("second attempt")
            ]
        );
    }

    #[test]
    fn text_already_taken_stops_counting_toward_the_cap() {
        let (tx, mut rx) = channel();
        let chunk = "x".repeat(MAX_UNSENT_REPLY_BYTES - 1);
        tx.send(delta(&chunk));
        assert_eq!(drain(&mut rx).len(), 1);
        tx.send(delta("more"));
        assert_eq!(drain(&mut rx), vec![delta("more")]);
    }

    #[test]
    fn the_receiver_ends_only_after_every_sender_is_gone_and_the_queue_is_empty() {
        let (tx, mut rx) = channel();
        let second = tx.clone();
        tx.send(delta("a"));
        drop(tx);
        let waker = futures_util::task::noop_waker();
        let mut cx = Context::from_waker(&waker);
        assert!(matches!(rx.poll_recv(&mut cx), Poll::Ready(Some(_))));
        assert!(rx.poll_recv(&mut cx).is_pending());
        drop(second);
        assert!(matches!(rx.poll_recv(&mut cx), Poll::Ready(None)));
    }
}
