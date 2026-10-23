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
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
/// The largest text frame the page may send a guest: a whole diagram (a snapshot) with room to spare.
pub const MAX_TEXT: usize = 16 * 1024 * 1024;
/// The largest text message a guest may send the page. Keep it equal to `MAX_GUEST_MESSAGE_BYTES` in
/// `src/collab/protocol.ts`, which counts the same UTF-8 bytes: a guest only ever sends edits, and
/// anything larger the page would drop anyway, after paying to receive it. Refused here, while it is
/// still being read, with 1009 `too-large`.
pub const MAX_GUEST_TEXT: usize = 4 * 1024 * 1024;
/// The page makes a 128-bit token and sends it as 32 lowercase hex characters.
const TOKEN_LEN: usize = 32;
/// Above this much text waiting for one guest, presence for them is dropped rather than queued (the
/// page's own `LAN_PRESENCE_BACKLOG_BYTES`): only this side knows what is really still waiting, and
/// pointers from several people would otherwise fill the queue until the guest was closed as `congested`.
pub const PRESENCE_BACKLOG: usize = 64 * 1024;
/// How long `stop` waits for every guest to be sent its close before saying the server stopped: a
/// close that takes all of `socket`'s grace, then all of the wait for the guest's answer, with room.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(4);

/// A sustained rate per second, and the burst allowed above it before the rate applies.
#[derive(Debug, Clone, Copy)]
pub struct Rate {
    pub per_second: u64,
    pub burst: u64,
}

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
    /// Bytes and messages (pings and pongs included) one guest may send, checked as each arrives and
    /// before the page hears it. Past either the guest is closed with 1008 `rate`: the page can't
    /// refuse what it is never given a chance to look at, so a flood stops here.
    pub inbound_bytes: Rate,
    pub inbound_messages: Rate,
    /// Guest places one address may hold at once. Anyone with the link (or who read it off the
    /// network) could otherwise open all `MAX_CONNECTIONS`, wait at the door, and keep everyone
    /// else out; a person on two devices or in a few tabs still fits.
    pub guests_per_address: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            ping_every: Duration::from_secs(10),
            pong_timeout: Duration::from_secs(30),
            queue_bytes: 2 * MAX_TEXT,
            queue_messages: 1024,
            send_timeout: Duration::from_secs(30),
            // The page's own byte budget for a guest (`BYTE_RATE`, `BYTE_BURST` in
            // `src/collab/hostSession.ts`): two of the largest messages back to back, then 1 MiB/s.
            inbound_bytes: Rate {
                per_second: 1024 * 1024,
                burst: 2 * MAX_GUEST_TEXT as u64,
            },
            // A guest's page sends its cursor and a held gesture's edits at most every 50 ms each,
            // plus a heartbeat every few seconds: well under this, which is the page's own patch
            // limit (`PATCH_RATE`, `PATCH_BURST`).
            inbound_messages: Rate {
                per_second: 60,
                burst: 240,
            },
            guests_per_address: 3,
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
    /// Set once the page no longer wants to hear from this guest: it closed it, it was killed, or the
    /// server is stopping. Its reader stops reading at once and forwards nothing more. The reader
    /// checks it under the channel's lock as it hands a message on, so once this is set (setting it
    /// waits for a message being handed on) not one more reaches the page.
    closing: watch::Sender<bool>,
}

impl Conn {
    fn stop_reading(&self) {
        self.closing
            .send_if_modified(|closing| !std::mem::replace(closing, true));
    }

    fn kill(&self, reason: &str, code: u16) {
        self.stop_reading();
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
    /// Bumped whenever the page starts a new session on the running server (a new token). A guest
    /// is checked against the session it was authorized in as it registers, so one that passed with
    /// the old token while the token changed can't slip in after the old guests were closed.
    session: AtomicU64,
    conns: Mutex<HashMap<String, Conn>>,
    /// Connections being upgraded or open, counted before the upgrade is accepted so that eleven
    /// simultaneous requests can't all slip past the cap.
    slots: AtomicUsize,
    /// Of those, how many each address holds (`Limits::guests_per_address`).
    by_address: Mutex<HashMap<IpAddr, usize>>,
    pub(crate) shutdown: watch::Sender<bool>,
    drained: Notify,
}

impl Shared {
    /// Whether the offered token is this session's, compared in constant time.
    pub(crate) fn token_is(&self, offered: &[u8]) -> bool {
        let token = lock(&self.token);
        offered.len() == TOKEN_LEN && bool::from(offered.ct_eq(&token[..]))
    }

    /// The token, as the page wrote it (lowercase hex, checked by `parse_token`).
    fn token_text(&self) -> String {
        String::from_utf8_lossy(&lock(&self.token)[..]).into_owned()
    }

    /// The session a request is authorized in: read before its token is checked.
    pub(crate) fn session(&self) -> u64 {
        self.session.load(Ordering::SeqCst)
    }

    /// A new session on the running server: the new token, and every guest of the old one closed.
    /// Under the lock `register` checks the session under, so an upgrade still on its way either
    /// registers before this and is closed here, or sees the new session and is refused.
    fn renew(&self, token: [u8; TOKEN_LEN]) {
        let conns = lock(&self.conns);
        self.session.fetch_add(1, Ordering::SeqCst);
        *lock(&self.token) = token;
        for conn in conns.values() {
            conn.kill("token-changed", 1008);
        }
    }

    pub(crate) fn stopping(&self) -> bool {
        *self.shutdown.borrow()
    }

    pub(crate) fn reserve(self: &Arc<Self>, session: u64, address: IpAddr) -> Option<Slot> {
        // The address's count is held while the overall one is taken, so the two agree.
        let mut by_address = lock(&self.by_address);
        let held = by_address.get(&address).copied().unwrap_or(0);
        if held >= self.limits.guests_per_address {
            return None;
        }
        // A bounded increment, spelled out: `fetch_update` is deprecated from Rust 1.99 (renamed
        // `try_update`, which the 1.88 floor in Cargo.toml doesn't have), and CI denies warnings.
        let mut n = self.slots.load(Ordering::SeqCst);
        loop {
            if n >= MAX_CONNECTIONS {
                return None;
            }
            match self
                .slots
                .compare_exchange_weak(n, n + 1, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => break,
                Err(current) => n = current,
            }
        }
        by_address.insert(address, held + 1);
        Some(Slot(self.clone(), session, address))
    }

    /// Takes a freshly upgraded connection onto the books, unless the server is stopping. The check
    /// and the insert are one step under the lock, so `stop` never misses a connection.
    pub(crate) fn register(&self, id: &str, conn: Conn, session: u64) -> bool {
        let mut conns = lock(&self.conns);
        if self.stopping() || self.session() != session {
            return false;
        }
        conns.insert(id.to_string(), conn);
        true
    }

    pub(crate) fn unregister(&self, id: &str) {
        lock(&self.conns).remove(id);
    }

    /// Tells every connection and listener to stop. Under the lock `register` checks `stopping`
    /// under, so a connection either sees the stop when it registers or is told here.
    fn begin_stop(&self) {
        let conns = lock(&self.conns);
        for conn in conns.values() {
            conn.stop_reading();
        }
        self.shutdown.send_replace(true);
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
pub(crate) struct Slot(Arc<Shared>, u64, IpAddr);

impl Slot {
    pub(crate) fn shared(&self) -> &Arc<Shared> {
        &self.0
    }

    /// The session the connection was authorized in.
    pub(crate) fn session(&self) -> u64 {
        self.1
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        {
            let mut by_address = lock(&self.0.by_address);
            if let Some(held) = by_address.get_mut(&self.2) {
                *held -= 1;
                if *held == 0 {
                    by_address.remove(&self.2);
                }
            }
        }
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
                running.shared.renew(token);
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
            session: AtomicU64::new(0),
            conns: Mutex::new(HashMap::new()),
            slots: AtomicUsize::new(0),
            by_address: Mutex::new(HashMap::new()),
            shutdown: watch::channel(false).0,
            drained: Notify::new(),
        });
        let ipv6 = listeners
            .iter()
            .any(|l| l.local_addr().is_ok_and(|a: SocketAddr| a.is_ipv6()));
        // Every listener is taken over before any starts serving: one failing after another had
        // started would leave that one running, with nothing on the books to stop it.
        let listeners = listeners
            .into_iter()
            .map(tokio::net::TcpListener::from_std)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                AppError::new(
                    ErrorKind::Io,
                    "Draft Canvas couldn't start sharing on your network.",
                )
            })?;
        let tasks = listeners
            .into_iter()
            .map(|listener| tokio::spawn(server::serve(listener, shared.clone())))
            .collect();
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
        self.stop_if(reason, |_| true).await;
    }

    /// Stops the server only while it runs `token`'s session. The page's stop for a session it has
    /// since replaced (sharing turned off and straight back on, the first start answering late) would
    /// otherwise end the new one, whose links it had just shown.
    pub async fn stop_session(&self, token: &str, reason: &str) {
        let Ok(token) = parse_token(token) else {
            return;
        };
        self.stop_if(reason, |shared| shared.token_is(&token)).await;
    }

    /// Decided under the same lock `start_on` holds, so no start can come between the check and the stop.
    async fn stop_if(&self, reason: &str, matches: impl FnOnce(&Shared) -> bool) {
        let mut life = self.life.lock().await;
        if !life
            .as_ref()
            .is_some_and(|running| matches(running.shared.as_ref()))
        {
            return;
        }
        let Some(running) = life.take() else {
            return;
        };
        lock(&self.current).take();
        let token = running.shared.token_text();
        running.shared.begin_stop();
        // Each listener task owns its socket: once it has returned, the port is free again.
        for listener in running.listeners {
            let _ = listener.await;
        }
        let _ = tokio::time::timeout(DRAIN_TIMEOUT, running.shared.drained()).await;
        self.sink.emit(HostEvent::CollabLanStopped {
            reason: reason.to_string(),
            token,
        });
    }

    /// For the app's last moments, where nothing can be awaited: every socket is told to close and
    /// the listeners stop accepting. Nobody is left to hear about it.
    pub fn shutdown_now(&self) {
        if let Some(shared) = lock(&self.current).take() {
            shared.begin_stop();
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

    /// `send` for presence (pointers, selections): dropped, not queued, while the guest is behind.
    /// Fresh presence follows soon enough; a backlog of stale presence only delays what matters.
    pub fn send_presence(&self, conn_id: &str, text: String) -> Result<(), AppError> {
        let behind = lock(&self.current).as_ref().is_some_and(|shared| {
            lock(&shared.conns)
                .get(conn_id)
                .is_some_and(|conn| conn.queued.load(Ordering::SeqCst) > PRESENCE_BACKLOG)
        });
        if behind {
            return Ok(());
        }
        self.send(conn_id, text)
    }

    /// Closes one guest once everything already sent to it has gone. Nothing more from the guest
    /// reaches the page once this returns.
    pub fn close(&self, conn_id: &str, reason: &str) {
        let Some(shared) = lock(&self.current).clone() else {
            return;
        };
        let conns = lock(&shared.conns);
        let Some(conn) = conns.get(conn_id) else {
            return;
        };
        conn.stop_reading();
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

/// The ends of one connection its task holds; the `Conn` on the books holds the others.
pub(crate) struct Ends {
    pub(crate) outbound: mpsc::Receiver<Outbound>,
    pub(crate) queued: Arc<AtomicUsize>,
    pub(crate) kill: watch::Receiver<Kill>,
    pub(crate) closing: watch::Receiver<bool>,
}

/// Builds a connection's book entry and the ends its task reads from.
pub(crate) fn new_conn(limits: &Limits) -> (Conn, Ends) {
    let (outbound, outbound_rx) = mpsc::channel(limits.queue_messages);
    let queued = Arc::new(AtomicUsize::new(0));
    let (kill, kill_rx) = watch::channel(None);
    let (closing, closing_rx) = watch::channel(false);
    (
        Conn {
            outbound,
            queued: queued.clone(),
            kill,
            closing,
        },
        Ends {
            outbound: outbound_rx,
            queued,
            kill: kill_rx,
            closing: closing_rx,
        },
    )
}
