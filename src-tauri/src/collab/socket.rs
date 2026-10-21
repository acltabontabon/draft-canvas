//! One guest's WebSocket: text in goes to the page as it arrives, text the page sends goes out in
//! order, and a ping every few seconds finds a guest that has quietly gone.

use super::{new_conn, Kill, Limits, Outbound, Shared, Slot};
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
    let (conn, outbound, queued, kill) = new_conn(&shared.limits);
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
    let reason = drive(socket, &shared, &id, outbound, queued, kill).await;
    shared.unregister(&id);
    shared.sink.emit(HostEvent::CollabLanClose {
        conn_id: id,
        reason,
    });
    drop(slot);
}

async fn drive(
    socket: WebSocket,
    shared: &Shared,
    id: &str,
    outbound: mpsc::Receiver<Outbound>,
    queued: std::sync::Arc<AtomicUsize>,
    kill: watch::Receiver<Kill>,
) -> String {
    let (mut sink, mut stream) = socket.split();
    let alive = Mutex::new(Instant::now());
    let shutdown = shared.shutdown.subscribe();
    // Reading and writing run side by side, so a guest that is slow to read still has its messages
    // heard. Whichever ends first decides why the connection ended; the other is dropped mid-wait,
    // which loses nothing (a frame half written stays in the socket's buffer).
    let end = tokio::select! {
        end = read(&mut stream, &alive, shared, id) => end,
        end = write(&mut sink, &alive, &shared.limits, outbound, &queued, kill, shutdown) => end,
    };
    let _ = timeout(CLOSE_GRACE, async {
        if let Some(code) = end.code {
            let _ = sink.send(close_frame(&end.reason, code)).await;
        }
        let _ = sink.close().await;
    })
    .await;
    end.reason
}

fn touch(alive: &Mutex<Instant>) {
    *lock(alive) = Instant::now();
}

async fn read(
    stream: &mut SplitStream<WebSocket>,
    alive: &Mutex<Instant>,
    shared: &Shared,
    id: &str,
) -> End {
    while let Some(message) = stream.next().await {
        // Any frame shows the guest is there; browsers answer pings on their own.
        touch(alive);
        match message {
            Ok(Message::Text(text)) => shared.sink.emit(HostEvent::CollabLanMessage {
                conn_id: id.to_string(),
                text: text.as_str().to_owned(),
            }),
            Ok(Message::Binary(_)) => return End::close("binary", UNSUPPORTED),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(Message::Close(_)) => return End::quiet("closed"),
            Err(error) => return read_error(error),
        }
    }
    End::quiet("closed")
}

/// A frame over `MAX_TEXT` is the guest's to hear about; anything else means the socket broke.
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
