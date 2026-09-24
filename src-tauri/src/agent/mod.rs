//! The local bridge that lets an AI agent the person already uses draw in Draft Canvas.
//!
//! The agent launches `draft-canvas-mcp` (the sidecar in `mcp/`), which speaks MCP over its own stdio
//! and nothing else. The sidecar connects here, over a socket (a named pipe on Windows) that only
//! this account can reach, and proves itself with the token in `agent.json`. This module owns what
//! must not be left to a model's good behaviour: whether access is on at all, which folders are in
//! scope, limits, timeouts, and the request ledger. What a request *means* — validating a diagram,
//! laying it out, changing the open document through its store — is the page's, because that is
//! where the document model lives; `broker` carries each request there and back.
//!
//! Off until the person turns it on. With it off there is no listener, no socket and no `agent.json`.

pub mod bridge;
pub mod broker;
pub mod endpoint;
pub mod ledger;
pub mod page;
pub mod proposals;
pub mod scope;
pub mod session;

use crate::util::{lock, now_ms};
use ledger::Ledger;
use proposals::Proposals;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tokio::sync::watch;

/// The bridge protocol spoken between the sidecar and the app. Bumped on any incompatible change to
/// the frames in `bridge`; the sidecar says which it speaks in its hello and is turned away, with a
/// message saying which side to update, when they differ.
pub const BRIDGE_VERSION: u32 = 1;

/// The document the editor has open, as the page last reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveDoc {
    pub handle: String,
    pub path: PathBuf,
    pub dirty: bool,
}

pub struct Agent {
    dir: PathBuf,
    app: OnceLock<AppHandle>,
    running: Mutex<Option<bridge::Running>>,
    pub(crate) page: page::PageLink,
    ledger: Mutex<Option<Ledger>>,
    /// Proposals a coding agent submitted for human review — a distinct, longer-lived store from the
    /// ledger's per-call replay guarantee. See `proposals.rs`.
    proposals: Mutex<Option<Proposals>>,
    /// Requests being worked on right now, by ledger key: a duplicate waits for the first to finish.
    inflight: Mutex<HashMap<String, watch::Receiver<bool>>>,
    pub(crate) index: scope::DiagramIndex,
    active: Mutex<Option<ActiveDoc>>,
    /// Page request id → ledger key, for updates: the gate records itself in the ledger.
    pub(crate) gates: Mutex<HashMap<u64, String>>,
    /// The diagrams each agent session created or changed (see `session`).
    pub(crate) sessions: session::Sessions,
    /// Page request id → where its progress goes (the calling connection), while it is worked on.
    pub(crate) progress: Mutex<HashMap<u64, broker::ProgressSink>>,
    connections: AtomicUsize,
    /// Whether the window was built with background throttling off (macOS 14+ with access on at
    /// launch). Access turned on later needs a restart before a hidden window keeps answering.
    pub(crate) background_ready: AtomicBool,
}

impl Agent {
    pub fn new(local_data_dir: &Path) -> Self {
        Self {
            dir: endpoint::agent_dir(local_data_dir),
            app: OnceLock::new(),
            running: Mutex::new(None),
            page: page::PageLink::default(),
            ledger: Mutex::new(None),
            proposals: Mutex::new(None),
            inflight: Mutex::default(),
            index: scope::DiagramIndex::default(),
            active: Mutex::new(None),
            gates: Mutex::default(),
            sessions: session::Sessions::default(),
            progress: Mutex::default(),
            connections: AtomicUsize::new(0),
            background_ready: AtomicBool::new(false),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub(crate) fn app(&self) -> Option<&AppHandle> {
        self.app.get()
    }

    /// Starts listening if the person has turned access on. Called once at startup.
    pub fn start(self: &Arc<Self>, app: &AppHandle, enabled: bool) {
        let _ = self.app.set(app.clone());
        if enabled {
            if let Err(e) = self.enable() {
                eprintln!("Draft Canvas: agent access couldn't start ({e})");
            }
        } else {
            // A token left behind by a run that didn't shut down cleanly must not outlive the setting.
            endpoint::remove_info(&self.dir);
        }
    }

    /// Opens the listener and writes `agent.json`. A no-op when already running.
    pub fn enable(self: &Arc<Self>) -> std::io::Result<()> {
        let mut running = lock(&self.running);
        if running.is_some() {
            return Ok(());
        }
        self.ensure_ledger()?;
        self.ensure_proposals()?;
        *running = Some(bridge::listen(self.clone())?);
        Ok(())
    }

    /// Stops new access at once: the listener closes, `agent.json` goes, and every connection is told
    /// to go away. A request already past its commit gate finishes — a commit is never cut in half.
    pub fn disable(&self) {
        if let Some(running) = lock(&self.running).take() {
            running.stop();
        }
        endpoint::remove_info(&self.dir);
    }

    /// Everything a connected sidecar should be told before the app goes away — and the connection
    /// file and socket removed, so nothing points at an app that isn't there. The listener itself is
    /// left to die with the process, so the goodbye frames still go out.
    pub fn shutdown(&self, reason: &str) {
        if let Some(running) = lock(&self.running).as_ref() {
            running.announce_shutdown(reason);
            running.remove_socket();
        }
        endpoint::remove_info(&self.dir);
    }

    pub fn is_running(&self) -> bool {
        lock(&self.running).is_some()
    }

    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    pub(crate) fn connection_opened(&self) {
        self.connections.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn connection_closed(&self) {
        self.connections.fetch_sub(1, Ordering::SeqCst);
    }

    fn ensure_ledger(&self) -> std::io::Result<()> {
        let mut ledger = lock(&self.ledger);
        if ledger.is_none() {
            *ledger = Some(Ledger::open(&self.dir, now_ms())?);
        }
        Ok(())
    }

    /// Runs `work` with the ledger. `None` when it couldn't be opened, which `enable` already reported.
    pub(crate) fn with_ledger<T>(&self, work: impl FnOnce(&mut Ledger) -> T) -> Option<T> {
        lock(&self.ledger).as_mut().map(work)
    }

    fn ensure_proposals(&self) -> std::io::Result<()> {
        let mut proposals = lock(&self.proposals);
        if proposals.is_none() {
            *proposals = Some(Proposals::open(&self.dir, now_ms())?);
        }
        Ok(())
    }

    /// Runs `work` with the proposal store, opening it on first use — unlike the ledger, review of a
    /// proposal already submitted must work even if agent access is currently off, so this isn't gated
    /// behind `enable()`. `None` only if the store couldn't be opened at all (a disk error).
    pub(crate) fn with_proposals<T>(&self, work: impl FnOnce(&mut Proposals) -> T) -> Option<T> {
        if self.ensure_proposals().is_err() {
            return None;
        }
        lock(&self.proposals).as_mut().map(work)
    }

    pub fn set_active(&self, active: Option<ActiveDoc>) {
        *lock(&self.active) = active;
    }

    pub fn active(&self) -> Option<ActiveDoc> {
        lock(&self.active).clone()
    }

    /// Claims `key` for this request. `Err` hands back a receiver that fires when whoever holds it
    /// now is done, so a duplicate can wait and then look at the ledger again.
    pub(crate) fn claim(&self, key: &str) -> Result<InflightGuard<'_>, watch::Receiver<bool>> {
        let mut inflight = lock(&self.inflight);
        if let Some(rx) = inflight.get(key) {
            return Err(rx.clone());
        }
        let (tx, rx) = watch::channel(false);
        inflight.insert(key.to_string(), rx);
        Ok(InflightGuard {
            agent: self,
            key: key.to_string(),
            done: tx,
        })
    }
}

/// Releases a claimed request key, and wakes any duplicate waiting on it, however the work ended.
pub(crate) struct InflightGuard<'a> {
    agent: &'a Agent,
    key: String,
    done: watch::Sender<bool>,
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        lock(&self.agent.inflight).remove(&self.key);
        let _ = self.done.send(true);
    }
}

/// What Settings shows about the integration. Never the token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub enabled: bool,
    pub listening: bool,
    pub connections: usize,
    /// The sidecar an agent's configuration should launch, when it can be found beside the app.
    pub sidecar_path: Option<String>,
    /// Why that path shouldn't be copied into a configuration yet (macOS runs a downloaded app from a
    /// temporary, randomised location until it is moved to Applications).
    pub sidecar_warning: Option<String>,
    /// Access was turned on after this window was made: a hidden window may stop answering until the
    /// app restarts (macOS 14+), or can't be kept answering at all on this system.
    pub background: BackgroundSupport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundSupport {
    /// The window keeps running when hidden.
    Ready,
    /// It will, after a restart.
    RestartNeeded,
    /// This system offers no way to keep a hidden window running; agents work while it is visible.
    Unverified,
}

/// Where the sidecar sits: next to the app's own executable, where the bundler puts external binaries
/// (with the target triple stripped), and where `cargo build` puts it in development.
pub fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "draft-canvas-mcp.exe"
    } else {
        "draft-canvas-mcp"
    };
    let path = dir.join(name);
    path.is_file().then_some(path)
}

/// A path that won't be there next launch: macOS's App Translocation runs a quarantined app from a
/// random read-only mount until the person moves it.
pub fn sidecar_warning(path: &Path) -> Option<String> {
    let text = path.to_string_lossy();
    if text.contains("/AppTranslocation/") {
        return Some(
            "Move Draft Canvas to your Applications folder first: macOS is running it from a temporary \
             location that changes every launch."
                .to_string(),
        );
    }
    None
}
