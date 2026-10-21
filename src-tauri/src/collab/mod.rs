//! Collaboration with guests on the same network. The canvas owner's page runs the session (its sync
//! logic lives in the page's own JavaScript); this is only the door it opens while sharing: a small
//! HTTP server that hands a guest's browser the app's own files, and one WebSocket path whose text
//! frames are carried to and from the page verbatim. Nothing here reads a diagram.
//!
//! The server listens only between `start` and `stop`, on a port the OS picks, and stops on its own
//! when the window closes, the page reloads or the app quits. A guest is let in only with the token
//! the page made for this session, from a page this server itself served (see `server`).

mod assets;
mod net;
mod server;
mod socket;

#[cfg(test)]
mod tests;

pub use assets::{AssetSource, Bundled};

use crate::errors::{AppError, ErrorKind};
use crate::state::{AppState, HostEvent};
use crate::util::lock;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;

/// The subprotocol a guest asks for, beside its token; the one echoed back.
pub const PROTOCOL: &str = "draft-canvas.collab.v1";
/// The WebSocket path.
pub const SOCKET_PATH: &str = "/collab";
/// Guests at once. The 11th is turned away until someone leaves.
pub const MAX_CONNECTIONS: usize = 10;
/// The largest text frame either way: a whole diagram with room to spare.
pub const MAX_TEXT: usize = 16 * 1024 * 1024;
/// The page makes a 128-bit token and sends it as 32 lowercase hex characters.
const TOKEN_LEN: usize = 32;
/// How long `stop` waits for every guest to be sent its close before saying the server stopped.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// The timings and bounds of one connection; the tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub ping_every: Duration,
    /// A guest that answers no ping for this long is gone (asleep, off the network).
    pub pong_timeout: Duration,
    /// Text waiting to go to one guest, sent or not yet sent. Past it the guest is too slow to keep
    /// up and is closed as `congested` rather than letting the owner's memory grow without end.
    pub queue_bytes: usize,
    pub queue_messages: usize,
    /// One frame that takes longer than this to leave is a guest that stopped reading.
    pub send_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            ping_every: Duration::from_secs(10),
            pong_timeout: Duration::from_secs(30),
            queue_bytes: 2 * MAX_TEXT,
            queue_messages: 1024,
            send_timeout: Duration::from_secs(30),
        }
    }
}

/// Where the page hears about guests. The app sends to the page's event channel; the tests collect.
pub trait Sink: Send + Sync + 'static {
    fn emit(&self, event: HostEvent);
}

struct AppSink(AppHandle);

impl Sink for AppSink {
    fn emit(&self, event: HostEvent) {
        if let Some(state) = self.0.try_state::<AppState>() {
            state.events.emit(event);
        }
    }
}

/// What `collabLanStart` answers: the port, and the addresses a guest can open it at, best first.
/// IPv6 addresses are bare (`fd12::5`); a URL puts them in brackets.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "CollabLanStarted")]
pub struct Started {
    pub port: u16,
    pub addresses: Vec<String>,
}

/// The addresses to listen on. The app listens on every interface; the tests only on loopback.
#[derive(Debug, Clone, Copy)]
pub struct Bind {
    pub v4: Ipv4Addr,
    pub v6: Option<Ipv6Addr>,
}

impl Bind {
    pub const ANY: Bind = Bind {
        v4: Ipv4Addr::UNSPECIFIED,
        v6: Some(Ipv6Addr::UNSPECIFIED),
    };
}

/// A message on its way to one guest, in the order the page sent it.
pub(crate) enum Outbound {
    Text(String),
    Close(String),
}

/// Ends a connection now, ahead of anything still queued: (reason, WebSocket close code).
pub(crate) type Kill = Option<(String, u16)>;

/// One guest's way out, as the page's sends reach it.
pub(crate) struct Conn {
    outbound: mpsc::Sender<Outbound>,
    queued: Arc<AtomicUsize>,
    kill: watch::Sender<Kill>,
}

impl Conn {
    fn kill(&self, reason: &str, code: u16) {
        self.kill.send_if_modified(|kill| {
            if kill.is_some() {
                return false;
            }
            *kill = Some((reason.to_string(), code));
            true
        });
    }
}

/// Everything one running server shares between its listeners and connections.
pub(crate) struct Shared {
    pub(crate) port: u16,
    pub(crate) limits: Limits,
    pub(crate) sink: Arc<dyn Sink>,
    pub(crate) assets: Arc<dyn AssetSource>,
    token: Mutex<[u8; TOKEN_LEN]>,
    conns: Mutex<HashMap<String, Conn>>,
    /// Connections being upgraded or open, counted before the upgrade is accepted so that eleven
    /// simultaneous requests can't all slip past the cap.
    slots: AtomicUsize,
    pub(crate) shutdown: watch::Sender<bool>,
    drained: Notify,
}

impl Shared {
    /// Whether the offered token is this session's, compared in constant time.
    pub(crate) fn token_is(&self, offered: &[u8]) -> bool {
        let token = lock(&self.token);
        offered.len() == TOKEN_LEN && bool::from(offered.ct_eq(&token[..]))
    }

    pub(crate) fn stopping(&self) -> bool {
        *self.shutdown.borrow()
    }

    pub(crate) fn reserve(self: &Arc<Self>) -> Option<Slot> {
        self.slots
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_CONNECTIONS).then_some(n + 1)
            })
            .ok()?;
        Some(Slot(self.clone()))
    }

    /// Takes a freshly upgraded connection onto the books, unless the server is stopping. The check
    /// and the insert are one step under the lock, so `stop` never misses a connection.
    pub(crate) fn register(&self, id: &str, conn: Conn) -> bool {
        let mut conns = lock(&self.conns);
        if self.stopping() {
            return false;
        }
        conns.insert(id.to_string(), conn);
        true
    }

    pub(crate) fn unregister(&self, id: &str) {
        lock(&self.conns).remove(id);
    }

    fn close_all(&self, reason: &str, code: u16) {
        for conn in lock(&self.conns).values() {
            conn.kill(reason, code);
        }
    }

    async fn drained(&self) {
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.slots.load(Ordering::SeqCst) == 0 {
                return;
            }
            notified.await;
        }
    }
}

/// A place among the `MAX_CONNECTIONS`, given back when the connection ends or its upgrade fails.
pub(crate) struct Slot(Arc<Shared>);

impl Slot {
    pub(crate) fn shared(&self) -> &Arc<Shared> {
        &self.0
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.slots.fetch_sub(1, Ordering::SeqCst);
        self.0.drained.notify_waiters();
    }
}

struct Running {
    shared: Arc<Shared>,
    ipv6: bool,
    listeners: Vec<JoinHandle<()>>,
}

impl Running {
    fn started(&self) -> Started {
        Started {
            port: self.shared.port,
            addresses: net::lan_addresses(self.ipv6)
                .iter()
                .map(ToString::to_string)
                .collect(),
        }
    }
}

/// The relay, managed by Tauri. At most one server runs at a time.
pub struct Relay {
    sink: Arc<dyn Sink>,
    assets: Arc<dyn AssetSource>,
    limits: Limits,
    /// Starting and stopping take turns, so two `start`s can't both bind.
    life: tokio::sync::Mutex<Option<Running>>,
    /// The running server for sends and closes, which must not wait behind a `stop` in progress.
    current: Mutex<Option<Arc<Shared>>>,
}

impl Relay {
    pub fn new(sink: Arc<dyn Sink>, assets: Arc<dyn AssetSource>, limits: Limits) -> Self {
        Self {
            sink,
            assets,
            limits,
            life: tokio::sync::Mutex::new(None),
            current: Mutex::new(None),
        }
    }

    pub fn for_app(app: &AppHandle) -> Self {
        Self::new(
            Arc::new(AppSink(app.clone())),
            Arc::new(Bundled::new(app)),
            Limits::default(),
        )
    }

    pub async fn start(&self, token: &str) -> Result<Started, AppError> {
        self.start_on(token, Bind::ANY).await
    }

    /// Starts listening, or answers the server already running. A different token means the page
    /// began a new session: guests let in with the old one are closed and only the new one opens.
    pub async fn start_on(&self, token: &str, bind: Bind) -> Result<Started, AppError> {
        let token = parse_token(token)?;
        let mut life = self.life.lock().await;
        if let Some(running) = life.as_ref() {
            if !running.shared.token_is(&token) {
                *lock(&running.shared.token) = token;
                running.shared.close_all("token-changed", 1008);
            }
            return Ok(running.started());
        }
        let (listeners, port) = net::bind(bind).map_err(|_| {
            AppError::new(
                ErrorKind::Io,
                "Draft Canvas couldn't start sharing on your network.",
            )
        })?;
        let shared = Arc::new(Shared {
            port,
            limits: self.limits,
            sink: self.sink.clone(),
            assets: self.assets.clone(),
            token: Mutex::new(token),
            conns: Mutex::new(HashMap::new()),
            slots: AtomicUsize::new(0),
            shutdown: watch::channel(false).0,
            drained: Notify::new(),
        });
        let ipv6 = listeners
            .iter()
            .any(|l| l.local_addr().is_ok_and(|a: SocketAddr| a.is_ipv6()));
        let mut tasks = Vec::with_capacity(listeners.len());
        for listener in listeners {
            let listener = tokio::net::TcpListener::from_std(listener).map_err(|_| {
                AppError::new(
                    ErrorKind::Io,
                    "Draft Canvas couldn't start sharing on your network.",
                )
            })?;
            tasks.push(tokio::spawn(server::serve(listener, shared.clone())));
        }
        *lock(&self.current) = Some(shared.clone());
        let running = Running {
            shared,
            ipv6,
            listeners: tasks,
        };
        let started = running.started();
        *life = Some(running);
        Ok(started)
    }

    /// Stops listening and closes every guest, then tells the page why. Stopping a server that isn't
    /// running does nothing, and says nothing.
    pub async fn stop(&self, reason: &str) {
        let mut life = self.life.lock().await;
        let Some(running) = life.take() else {
            return;
        };
        lock(&self.current).take();
        running.shared.shutdown.send_replace(true);
        // Each listener task owns its socket: once it has returned, the port is free again.
        for listener in running.listeners {
            let _ = listener.await;
        }
        let _ = tokio::time::timeout(DRAIN_TIMEOUT, running.shared.drained()).await;
        self.sink.emit(HostEvent::CollabLanStopped {
            reason: reason.to_string(),
        });
    }

    /// For the app's last moments, where nothing can be awaited: every socket is told to close and
    /// the listeners stop accepting. Nobody is left to hear about it.
    pub fn shutdown_now(&self) {
        if let Some(shared) = lock(&self.current).take() {
            shared.shutdown.send_replace(true);
        }
    }

    /// Queues `text` for one guest. A guest that has gone (its `collab-lan-close` is on its way) is
    /// not an error; one too slow to keep up is closed as `congested`.
    pub fn send(&self, conn_id: &str, text: String) -> Result<(), AppError> {
        if text.len() > MAX_TEXT {
            return Err(AppError::new(
                ErrorKind::TooLarge,
                format!(
                    "That is too large to send to a guest (the limit is {} MB).",
                    MAX_TEXT / (1024 * 1024)
                ),
            ));
        }
        let Some(shared) = lock(&self.current).clone() else {
            return Ok(());
        };
        let conns = lock(&shared.conns);
        let Some(conn) = conns.get(conn_id) else {
            return Ok(());
        };
        let len = text.len();
        let queued = conn.queued.load(Ordering::SeqCst);
        if queued.saturating_add(len) > shared.limits.queue_bytes {
            conn.kill("congested", 1008);
            return Ok(());
        }
        conn.queued.fetch_add(len, Ordering::SeqCst);
        if let Err(error) = conn.outbound.try_send(Outbound::Text(text)) {
            conn.queued.fetch_sub(len, Ordering::SeqCst);
            if matches!(error, mpsc::error::TrySendError::Full(_)) {
                conn.kill("congested", 1008);
            }
        }
        Ok(())
    }

    /// Closes one guest once everything already sent to it has gone.
    pub fn close(&self, conn_id: &str, reason: &str) {
        let Some(shared) = lock(&self.current).clone() else {
            return;
        };
        let conns = lock(&shared.conns);
        let Some(conn) = conns.get(conn_id) else {
            return;
        };
        if conn
            .outbound
            .try_send(Outbound::Close(reason.to_string()))
            .is_err()
        {
            conn.kill(reason, 1000);
        }
    }
}

/// `stop`, from code that can't wait for it (a window event).
pub fn stop_in_background(app: &AppHandle, reason: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(relay) = app.try_state::<Relay>() {
            relay.stop(reason).await;
        }
    });
}

fn parse_token(token: &str) -> Result<[u8; TOKEN_LEN], AppError> {
    let bytes = token.as_bytes();
    if bytes.len() != TOKEN_LEN || !bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(AppError::bad_request(
            "a collaboration token is 32 lowercase hex characters",
        ));
    }
    let mut out = [0; TOKEN_LEN];
    out.copy_from_slice(bytes);
    Ok(out)
}

/// Builds a connection's book entry and the ends its task reads from.
pub(crate) fn new_conn(
    limits: &Limits,
) -> (
    Conn,
    mpsc::Receiver<Outbound>,
    Arc<AtomicUsize>,
    watch::Receiver<Kill>,
) {
    let (outbound, outbound_rx) = mpsc::channel(limits.queue_messages);
    let queued = Arc::new(AtomicUsize::new(0));
    let (kill, kill_rx) = watch::channel(None);
    (
        Conn {
            outbound,
            queued: queued.clone(),
            kill,
        },
        outbound_rx,
        queued,
        kill_rx,
    )
}
