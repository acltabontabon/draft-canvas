//! Requests carried to the page and back, and the commit gate that keeps a late page from acting on a
//! request nobody is waiting for any more.
//!
//! Each request has a stage. It starts `Live`; the page must acknowledge it quickly (a page that
//! doesn't is suspended or gone, and the caller hears so at once). Before the page changes anything it
//! asks to pass the gate, which moves the request to `Committing` — or refuses, when the request has
//! expired or been cancelled meanwhile. So a request that timed out before its commit can never be
//! applied later, and one that passed the gate is waited for rather than abandoned mid-change.

use crate::util::lock;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{oneshot, Notify};

/// The page answers "got it" within this or is treated as not answering.
pub const ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// Validation and layout must reach the commit gate within this.
pub const PRE_COMMIT_BUDGET: Duration = Duration::from_secs(30);
/// Past the gate, the page has this long to report how the commit went.
pub const POST_COMMIT_BUDGET: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Live,
    Committing,
    /// Timed out or cancelled before the gate. The gate refuses it from now on.
    Expired,
}

struct Pending {
    stage: Stage,
    started: tokio::time::Instant,
    committing: Option<tokio::time::Instant>,
    acked: bool,
    reply: Option<oneshot::Sender<Reply>>,
}

/// What arrives on a request's channel: the page's answer, or word that it was cancelled.
#[derive(Debug)]
pub enum Reply {
    Answer(Value),
    Cancelled,
}

#[derive(Default)]
pub struct PageLink {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    acks: Notify,
}

/// How waiting on the page ended, when it didn't end with an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Never acknowledged: suspended, busy with a modal, or not there.
    Unresponsive,
    /// Acknowledged but never reached the gate in time. Nothing was changed.
    TimedOutBeforeCommit,
    /// Passed the gate, then went quiet. The change may or may not have been made.
    OutcomeUnknown,
    Cancelled,
}

impl PageLink {
    /// Registers a request and returns its id and the receiver for the page's answer. The caller
    /// sends the event itself, so a failed send can be told apart from a slow page.
    pub fn register(&self) -> (u64, oneshot::Receiver<Reply>) {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        lock(&self.pending).insert(
            id,
            Pending {
                stage: Stage::Live,
                started: tokio::time::Instant::now(),
                committing: None,
                acked: false,
                reply: Some(tx),
            },
        );
        (id, rx)
    }

    pub fn forget(&self, id: u64) {
        lock(&self.pending).remove(&id);
    }

    pub fn ack(&self, id: u64) {
        if let Some(p) = lock(&self.pending).get_mut(&id) {
            p.acked = true;
        }
        self.acks.notify_waiters();
    }

    /// The commit gate. True moves the request to `Committing`; false means stop, change nothing.
    pub fn gate(&self, id: u64) -> bool {
        let passed = match lock(&self.pending).get_mut(&id) {
            Some(p) if p.stage == Stage::Live => {
                p.stage = Stage::Committing;
                // Reaching the gate also proves the page received the request.
                p.acked = true;
                p.committing = Some(tokio::time::Instant::now());
                true
            }
            Some(p) => p.stage == Stage::Committing,
            None => false,
        };
        self.acks.notify_waiters();
        passed
    }

    pub fn respond(&self, id: u64, value: Value) {
        let reply = lock(&self.pending)
            .get_mut(&id)
            .and_then(|p| p.reply.take());
        if let Some(reply) = reply {
            let _ = reply.send(Reply::Answer(value));
        }
    }

    /// Cancels a request that hasn't reached its gate. True if it was stopped in time.
    pub fn cancel(&self, id: u64) -> bool {
        let reply = match lock(&self.pending).get_mut(&id) {
            Some(p) if p.stage == Stage::Live => {
                p.stage = Stage::Expired;
                p.reply.take()
            }
            _ => return false,
        };
        if let Some(reply) = reply {
            let _ = reply.send(Reply::Cancelled);
        }
        true
    }

    fn stage(&self, id: u64) -> Option<(Stage, bool)> {
        lock(&self.pending).get(&id).map(|p| (p.stage, p.acked))
    }

    /// Expires a live request; returns the stage it was left in.
    fn expire_if_live(&self, id: u64) -> Stage {
        let mut pending = lock(&self.pending);
        match pending.get_mut(&id) {
            Some(p) if p.stage == Stage::Live => {
                p.stage = Stage::Expired;
                Stage::Expired
            }
            Some(p) => p.stage,
            None => Stage::Expired,
        }
    }

    /// Waits for the page's answer under the timing rules above. Always forgets the request after.
    pub async fn wait(
        &self,
        id: u64,
        mut rx: oneshot::Receiver<Reply>,
        budgets: Budgets,
    ) -> Result<Value, Failure> {
        let result = self.wait_inner(id, &mut rx, budgets).await;
        self.forget(id);
        result
    }

    async fn wait_inner(
        &self,
        id: u64,
        rx: &mut oneshot::Receiver<Reply>,
        budgets: Budgets,
    ) -> Result<Value, Failure> {
        let settle = |reply: Result<Reply, oneshot::error::RecvError>, dropped: Failure| match reply
        {
            Ok(Reply::Answer(value)) => Ok(value),
            Ok(Reply::Cancelled) => Err(Failure::Cancelled),
            Err(_) => Err(dropped),
        };
        // 1. The acknowledgement.
        let started = lock(&self.pending)
            .get(&id)
            .map(|p| p.started)
            .unwrap_or_else(tokio::time::Instant::now);
        let ack_deadline = started + budgets.ack;
        loop {
            // Registered before looking, so an ack landing in between still wakes this.
            let notified = self.acks.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.stage(id).is_some_and(|(_, acked)| acked) {
                break;
            }
            tokio::select! {
                reply = &mut *rx => return settle(reply, Failure::Unresponsive),
                _ = notified => {}
                _ = tokio::time::sleep_until(ack_deadline) => {
                    if self.stage(id).is_some_and(|(_, acked)| acked) { break; }
                    self.expire_if_live(id);
                    return Err(Failure::Unresponsive);
                }
            }
        }
        // 2. Measure each deadline from the event it bounds. Waiting out the pre-commit budget
        // before starting the receipt timer gave an early commit an extra thirty seconds.
        loop {
            let notified = self.acks.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let committing = lock(&self.pending).get(&id).and_then(|p| p.committing);
            let deadline =
                committing.map_or(started + budgets.pre_commit, |at| at + budgets.post_commit);
            tokio::select! {
                biased;
                reply = &mut *rx => return settle(reply, Failure::OutcomeUnknown),
                _ = notified => continue,
                _ = tokio::time::sleep_until(deadline) => {}
            }
            if committing.is_some() {
                return Err(Failure::OutcomeUnknown);
            }
            if self.expire_if_live(id) == Stage::Expired {
                return Err(Failure::TimedOutBeforeCommit);
            }
            // The gate raced the pre-commit deadline. Its own timestamp now bounds the receipt.
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Budgets {
    pub ack: Duration,
    pub pre_commit: Duration,
    pub post_commit: Duration,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            ack: ACK_TIMEOUT,
            pre_commit: PRE_COMMIT_BUDGET,
            post_commit: POST_COMMIT_BUDGET,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    fn quick() -> Budgets {
        Budgets {
            ack: Duration::from_millis(40),
            pre_commit: Duration::from_millis(80),
            post_commit: Duration::from_millis(80),
        }
    }

    #[tokio::test]
    async fn an_answer_is_delivered() {
        let link = Arc::new(PageLink::default());
        let (id, rx) = link.register();
        let page = link.clone();
        tokio::spawn(async move {
            page.ack(id);
            page.respond(id, json!({"ok": true}));
        });
        assert_eq!(link.wait(id, rx, quick()).await, Ok(json!({"ok": true})));
    }

    #[tokio::test]
    async fn a_page_that_never_acknowledges_is_unresponsive_and_can_not_commit_later() {
        let link = PageLink::default();
        let (id, rx) = link.register();
        assert_eq!(link.wait(id, rx, quick()).await, Err(Failure::Unresponsive));
        // The page wakes up (a suspended window shown again) and tries to go ahead: refused.
        assert!(!link.gate(id));
    }

    #[tokio::test]
    async fn a_late_page_is_refused_at_the_gate_after_the_pre_commit_budget() {
        let link = Arc::new(PageLink::default());
        let (id, rx) = link.register();
        link.ack(id);
        let result = link.wait(id, rx, quick()).await;
        assert_eq!(result, Err(Failure::TimedOutBeforeCommit));
        assert!(
            !link.gate(id),
            "nothing can be applied after the caller was told it wasn't"
        );
    }

    #[tokio::test]
    async fn past_the_gate_the_answer_is_waited_for_and_silence_is_an_unknown_outcome() {
        let link = Arc::new(PageLink::default());
        let (id, rx) = link.register();
        link.ack(id);
        assert!(link.gate(id));
        assert_eq!(
            link.wait(id, rx, quick()).await,
            Err(Failure::OutcomeUnknown)
        );

        let (id, rx) = link.register();
        link.ack(id);
        assert!(link.gate(id));
        let page = link.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            page.respond(id, json!("late but committed"));
        });
        assert_eq!(
            link.wait(id, rx, quick()).await,
            Ok(json!("late but committed"))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_receipt_deadline_starts_at_the_gate_and_not_after_the_pre_commit_wait() {
        let link = PageLink::default();
        let (id, rx) = link.register();
        link.ack(id);
        assert!(link.gate(id));
        let started = tokio::time::Instant::now();
        assert_eq!(
            link.wait(id, rx, Budgets::default()).await,
            Err(Failure::OutcomeUnknown)
        );
        assert_eq!(started.elapsed(), POST_COMMIT_BUDGET);
    }

    #[tokio::test]
    async fn a_cancelled_request_can_not_pass_the_gate() {
        let link = PageLink::default();
        let (id, rx) = link.register();
        link.ack(id);
        assert!(link.cancel(id));
        assert!(!link.gate(id));
        assert_eq!(link.wait(id, rx, quick()).await, Err(Failure::Cancelled));
        assert!(!link.gate(id));
        let (id, _rx) = link.register();
        assert!(link.gate(id));
        assert!(!link.cancel(id), "too late: it is being committed");
    }
}
