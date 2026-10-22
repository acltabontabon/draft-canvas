//! One guest's WebSocket: text in goes to the page as it arrives, within the guest's budget and
//! until the page closes it; text the page sends goes out in order; and a ping every few seconds
//! finds a guest that has quietly gone.

use super::{new_conn, Ends, Kill, Limits, Outbound, Rate, Shared, Slot};
use crate::state::HostEvent;
use crate::util::lock;
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;

/// How long the last frame (the close) gets to leave before the socket is simply dropped.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// How long, after its close has gone, a guest gets to answer with its own (a browser answers at
/// once). See `Reader::drain`.
const CLOSE_REPLY_WAIT: Duration = Duration::from_secs(1);
/// A close frame's reason is at most 123 bytes.
const MAX_CLOSE_REASON: usize = 123;

const NORMAL: u16 = 1000;
const GOING_AWAY: u16 = 1001;
const UNSUPPORTED: u16 = 1003;
const POLICY: u16 = 1008;
const TOO_BIG: u16 = 1009;

/// How a connection ended: the reason the page is told and, when the guest should be told too,
/// the close code to send it.
struct End {
    reason: String,
    code: Option<u16>,
}

impl End {
    fn close(reason: impl Into<String>, code: u16) -> Self {
        Self {
            reason: reason.into(),
            code: Some(code),
        }
    }

    /// The guest closed, or the socket broke: there is nobody to send a close to.
    fn quiet(reason: &str) -> Self {
        Self {
            reason: reason.to_string(),
            code: None,
        }
    }
}

/// Resolves once the server is stopping (or gone).
pub(super) async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stop| *stop).await;
}

/// The page hears `collab-lan-open` before any message from the guest, and exactly one
/// `collab-lan-close` after the last.
pub(super) async fn run(socket: WebSocket, slot: Slot) {
    let shared = slot.shared().clone();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (conn, ends) = new_conn(&shared.limits);
    if !shared.register(&id, conn) {
        let mut socket = socket;
        let _ = timeout(
            CLOSE_GRACE,
            socket.send(close_frame("server-stopped", GOING_AWAY)),
        )
        .await;
        return;
    }
    shared.sink.emit(HostEvent::CollabLanOpen {
        conn_id: id.clone(),
    });
    let reason = drive(socket, &shared, &id, ends).await;
    shared.unregister(&id);
    shared.sink.emit(HostEvent::CollabLanClose {
        conn_id: id,
        reason,
    });
    drop(slot);
}

async fn drive(socket: WebSocket, shared: &Shared, id: &str, ends: Ends) -> String {
    let Ends {
        outbound,
        queued,
        kill,
        closing,
    } = ends;
    let (mut sink, mut stream) = socket.split();
    let alive = Mutex::new(Instant::now());
    let mut reader = Reader {
        shared,
        id,
        budget: Budget::new(&shared.limits, Instant::now()),
        closing,
        shutdown: shared.shutdown.subscribe(),
    };
    let shutdown = shared.shutdown.subscribe();
    // Reading and writing run side by side, so a guest that is slow to read still has its messages
    // heard. Whichever ends first decides why the connection ended; the other is dropped mid-wait,
    // which loses nothing (a frame half written stays in the socket's buffer). Once the page closes
    // the guest, reading stops for good and writing alone decides, after what was queued has gone.
    let (end, writer_ended) = tokio::select! {
        end = reader.read(&mut stream, &alive) => (end, false),
        end = write(&mut sink, &alive, &shared.limits, outbound, &queued, kill, shutdown) => (end, true),
    };
    let _ = timeout(CLOSE_GRACE, async {
        if let Some(code) = end.code {
            let _ = sink.send(close_frame(&end.reason, code)).await;
        }
        let _ = sink.close().await;
    })
    .await;
    // When reading ended the connection, the guest closed, the socket broke, or it is being cut off
    // mid-flood: there is nothing to wait for, and after a read error nothing more may be read.
    if writer_ended {
        reader.drain(&mut stream).await;
    }
    end.reason
}

fn touch(alive: &Mutex<Instant>) {
    *lock(alive) = Instant::now();
}

/// A token bucket: full to start with, refilled at a steady rate, never above its burst.
pub(super) struct Bucket {
    level: f64,
    rate: Rate,
    last: Instant,
}

impl Bucket {
    pub(super) fn new(rate: Rate, now: Instant) -> Self {
        Self {
            level: rate.burst as f64,
            rate,
            last: now,
        }
    }

    /// Spends `amount`, or says there isn't that much left (and spends nothing).
    pub(super) fn take(&mut self, amount: u64, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        let refill = elapsed * self.rate.per_second as f64;
        self.level = (self.level + refill).min(self.rate.burst as f64);
        let amount = amount as f64;
        if amount > self.level {
            return false;
        }
        self.level -= amount;
        true
    }
}

/// What one guest may still send: bytes and messages, each its own bucket.
pub(super) struct Budget {
    bytes: Bucket,
    messages: Bucket,
}

impl Budget {
    pub(super) fn new(limits: &Limits, now: Instant) -> Self {
        Self {
            bytes: Bucket::new(limits.inbound_bytes, now),
            messages: Bucket::new(limits.inbound_messages, now),
        }
    }

    /// Spends one message of `len` bytes, or says the guest is sending faster than it may. A refusal
    /// closes the connection, so what a refused message spent doesn't matter.
    pub(super) fn admit(&mut self, len: usize, now: Instant) -> bool {
        self.messages.take(1, now) && self.bytes.take(len as u64, now)
    }
}

/// The reading half of a connection: what arrives goes to the page, within the guest's budget, until
/// the page closes the guest or the server stops.
struct Reader<'a> {
    shared: &'a Shared,
    id: &'a str,
    budget: Budget,
    closing: watch::Receiver<bool>,
    shutdown: watch::Receiver<bool>,
}

impl Reader<'_> {
    /// Returns why the connection ended; never returns once the page closed the guest or the server
    /// is stopping, which leaves the writer to send what was queued and then the close.
    async fn read(&mut self, stream: &mut SplitStream<WebSocket>, alive: &Mutex<Instant>) -> End {
        loop {
            let message = tokio::select! {
                biased;
                () = stopped(&mut self.shutdown) => break,
                // An error is the connection leaving the books: stop just the same.
                _ = self.closing.wait_for(|closing| *closing) => break,
                message = stream.next() => message,
            };
            let message = match message {
                Some(Ok(message)) => message,
                Some(Err(error)) => return read_error(error),
                None => return End::quiet("closed"),
            };
            // Any frame shows the guest is there; browsers answer pings on their own.
            touch(alive);
            let Some(len) = payload_len(&message) else {
                return End::quiet("closed");
            };
            if !self.budget.admit(len, Instant::now()) {
                return End::close("rate", POLICY);
            }
            match message {
                Message::Text(text) => {
                    if !self.forward(text.as_str()) {
                        break;
                    }
                }
                Message::Binary(_) => return End::close("binary", UNSUPPORTED),
                _ => {}
            }
        }
        // Not reading leaves anything more the guest sends in its own socket, unread.
        std::future::pending().await
    }

    /// After the close has gone, reads what the guest still sends, dropping it, until the guest's own
    /// close. A socket dropped with frames unread in it is reset rather than closed, and a reset can
    /// cost the guest the last frames sent to it, the close among them. Bounded by
    /// `CLOSE_REPLY_WAIT` and the guest's budget; the page hears none of it.
    async fn drain(&mut self, stream: &mut SplitStream<WebSocket>) {
        let _ = timeout(CLOSE_REPLY_WAIT, async {
            while let Some(Ok(message)) = stream.next().await {
                match payload_len(&message) {
                    Some(len) if self.budget.admit(len, Instant::now()) => {}
                    _ => return,
                }
            }
        })
        .await;
    }

    /// Hands one message to the page unless the page has closed the guest or the server is stopping.
    /// `closing` stays borrowed until the message is handed on, so a close waits for it and nothing
    /// is handed on after a close returns.
    fn forward(&self, text: &str) -> bool {
        let closing = self.closing.borrow();
        if *closing || self.shared.stopping() {
            return false;
        }
        self.shared.sink.emit(HostEvent::CollabLanMessage {
            conn_id: self.id.to_string(),
            text: text.to_owned(),
        });
        true
    }
}

/// What a message costs against the byte budget; `None` for a close.
fn payload_len(message: &Message) -> Option<usize> {
    match message {
        Message::Text(text) => Some(text.len()),
        Message::Binary(bytes) | Message::Ping(bytes) | Message::Pong(bytes) => Some(bytes.len()),
        Message::Close(_) => None,
    }
}

/// A message over `MAX_GUEST_TEXT` is the guest's to hear about; anything else means the socket
/// broke.
fn read_error(error: axum::Error) -> End {
    match error.into_inner().downcast::<tungstenite::Error>() {
        Ok(error) if matches!(*error, tungstenite::Error::Capacity(_)) => {
            End::close("too-large", TOO_BIG)
        }
        _ => End::quiet("error"),
    }
}

async fn write(
    sink: &mut SplitSink<WebSocket, Message>,
    alive: &Mutex<Instant>,
    limits: &Limits,
    mut outbound: mpsc::Receiver<Outbound>,
    queued: &AtomicUsize,
    mut kill: watch::Receiver<Kill>,
    mut shutdown: watch::Receiver<bool>,
) -> End {
    let start = tokio::time::Instant::now() + limits.ping_every;
    let mut ping = tokio::time::interval_at(start, limits.ping_every);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            biased;
            () = stopped(&mut shutdown) => return End::close("server-stopped", GOING_AWAY),
            (reason, code) = killed(&mut kill) => return End::close(reason, code),
            next = outbound.recv() => match next {
                Some(Outbound::Text(text)) => {
                    let len = text.len();
                    let end = send(sink, Message::Text(text.into()), limits, &mut kill, &mut shutdown).await;
                    queued.fetch_sub(len, Ordering::SeqCst);
                    if let Some(end) = end {
                        return end;
                    }
                }
                Some(Outbound::Close(reason)) => return End::close(reason, NORMAL),
                None => return End::close("server-stopped", GOING_AWAY),
            },
            _ = ping.tick() => {
                if lock(alive).elapsed() >= limits.pong_timeout {
                    return End::close("timeout", GOING_AWAY);
                }
                if let Some(end) = send(sink, Message::Ping(Bytes::new()), limits, &mut kill, &mut shutdown).await {
                    return end;
                }
            }
        }
    }
}

/// One frame out, or why the connection ends instead. A send stuck on a guest that stopped reading
/// still gives way to a stop or a `congested` close as soon as one is asked for.
async fn send(
    sink: &mut SplitSink<WebSocket, Message>,
    message: Message,
    limits: &Limits,
    kill: &mut watch::Receiver<Kill>,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<End> {
    tokio::select! {
        biased;
        () = stopped(shutdown) => Some(End::close("server-stopped", GOING_AWAY)),
        (reason, code) = killed(kill) => Some(End::close(reason, code)),
        sent = timeout(limits.send_timeout, sink.send(message)) => match sent {
            Ok(Ok(())) => None,
            Ok(Err(_)) => Some(End::quiet("error")),
            // Its socket is full and nothing more is getting through.
            Err(_) => Some(End::close("congested", POLICY)),
        },
    }
}

/// Resolves with the reason once something asked for this connection to end now.
async fn killed(kill: &mut watch::Receiver<Kill>) -> (String, u16) {
    match kill.wait_for(Option::is_some).await {
        Ok(kill) => kill
            .clone()
            .unwrap_or_else(|| ("closed".to_string(), NORMAL)),
        Err(_) => ("server-stopped".to_string(), GOING_AWAY),
    }
}

fn close_frame(reason: &str, code: u16) -> Message {
    let mut end = reason.len().min(MAX_CLOSE_REASON);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    Message::Close(Some(CloseFrame {
        code,
        reason: reason[..end].into(),
    }))
}
