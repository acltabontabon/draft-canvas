//! The socket the sidecar connects to, and the conversation on it.
//!
//! Newline-delimited JSON, one frame per line, each at most `MAX_FRAME` bytes:
//!
//! ```text
//! sidecar → app  {"type":"hello","bridge":1,"sidecar":"1.12.0","token":"…","session":"…"}
//! app → sidecar  {"type":"welcome","bridge":1,"app":"1.12.0"}      or {"type":"refused","code":…,"message":…}
//! sidecar → app  {"type":"call","id":7,"tool":"create_diagram","args":{…}}
//! app → sidecar  {"type":"result","id":7,"ok":true,"value":{…}}   or  "ok":false,"error":{…}
//! app → sidecar  {"type":"progress","id":7,"message":"Routing connections"}   (while it works)
//! sidecar → app  {"type":"cancel","id":7}
//! app → sidecar  {"type":"shutdown","reason":"quit"}
//! ```
//!
//! The first frame must be a hello carrying the token from `agent.json`, within `HELLO_TIMEOUT`, or
//! the connection is closed without a word. On macOS the peer's user id is checked as well: the socket
//! sits in a folder only this account can enter, and a connection from another account is refused
//! even so. A connection that goes away mid-call doesn't cancel work past its commit gate — that
//! finishes and is recorded in the ledger, where a retry finds it.
//!
//! `session` is optional (an older sidecar has none): a nonce the sidecar makes up once per process,
//! so its reconnects stay one agent session (`session.rs`). Without it the connection is its own.
//!
//! `run` is optional too: present only when Draft Canvas's companion started the agent. Such a
//! connection is held to its run's limits (`runs.rs`), and refused once the run has ended.

use super::broker::{self, CallRegistry};
use super::endpoint::{self, Info};
use super::{Agent, BRIDGE_VERSION};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc};

/// A whole diagram fits many times over; a runaway client can't make the app buffer without bound.
pub const MAX_FRAME: u64 = 4 * 1024 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// A client that stops reading must not pin a writer, queued replies or access shutdown forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the listener waits after a failed accept before trying again.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// Calls one connection may have running at once. A well-behaved agent sends one at a time.
const MAX_CONCURRENT_CALLS: usize = 4;

/// The listener, while access is on.
pub struct Running {
    stop: broadcast::Sender<String>,
    task: tauri::async_runtime::JoinHandle<()>,
    #[cfg(unix)]
    socket: std::path::PathBuf,
}

impl Running {
    /// Closes the listener and every connection. Work already past its commit gate carries on.
    pub fn stop(self) {
        let _ = self.stop.send("disabled".into());
        self.task.abort();
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket);
    }

    pub fn announce_shutdown(&self, reason: &str) {
        let _ = self.stop.send(reason.to_string());
    }

    /// The socket's file, gone: a sidecar connecting now is told plainly the app isn't running.
    pub fn remove_socket(&self) {
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Starts listening and writes `agent.json` naming the endpoint and a fresh token.
pub fn listen(agent: Arc<Agent>) -> std::io::Result<Running> {
    endpoint::prepare_dir(agent.dir())?;
    let token = endpoint::new_token();
    let (stop, _) = broadcast::channel::<String>(4);

    #[cfg(unix)]
    {
        let socket = endpoint::socket_path(agent.dir());
        // A socket file left by an app that crashed: nothing answers on it, so it can go.
        if socket.exists() {
            if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    "another Draft Canvas is already serving agents",
                ));
            }
            let _ = std::fs::remove_file(&socket);
        }
        let listener = {
            let std_listener = std::os::unix::net::UnixListener::bind(&socket)?;
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
            }
            std_listener.set_nonblocking(true)?;
            std_listener
        };
        write_info(&agent, socket.to_string_lossy().into_owned(), &token)?;
        let stop_rx = stop.clone();
        let task = tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::UnixListener::from_std(listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("Draft Canvas: agent socket unusable ({e})");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    // A lasting failure (out of descriptors) would otherwise spin a core.
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                };
                if !same_user(&stream) {
                    continue;
                }
                let (read, write) = stream.into_split();
                tauri::async_runtime::spawn(serve(
                    agent.clone(),
                    token.clone(),
                    read,
                    write,
                    stop_rx.subscribe(),
                ));
            }
        });
        Ok(Running { stop, task, socket })
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = endpoint::pipe_name();
        // Made here, before anything is written about it, so no other program can claim the name first.
        // Inside the runtime: a pipe server registers with its reactor as it is made.
        let owner_only = OwnerOnly::new()?;
        let first = tauri::async_runtime::block_on(async {
            // SAFETY: the attributes and the descriptor they point at outlive the call.
            unsafe {
                ServerOptions::new()
                    .first_pipe_instance(true)
                    .reject_remote_clients(true)
                    .create_with_security_attributes_raw(&name, owner_only.attributes())
            }
        })?;
        write_info(&agent, name.clone(), &token)?;
        let stop_rx = stop.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut server = first;
            loop {
                if server.connect().await.is_err() {
                    // A client that left before it was connected leaves this instance broken, and
                    // connecting it again failed at once, forever: reset it, and don't spin meanwhile.
                    let _ = server.disconnect();
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                }
                let connected = server;
                // SAFETY: as above — `owner_only` lives as long as this task.
                server = match unsafe {
                    ServerOptions::new()
                        .reject_remote_clients(true)
                        .create_with_security_attributes_raw(&name, owner_only.attributes())
                } {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("Draft Canvas: agent pipe unusable ({e})");
                        return;
                    }
                };
                let (read, write) = tokio::io::split(connected);
                tauri::async_runtime::spawn(serve(
                    agent.clone(),
                    token.clone(),
                    read,
                    write,
                    stop_rx.subscribe(),
                ));
            }
        });
        Ok(Running { stop, task })
    }
}

/// A pipe only this account can open. By default a named pipe's DACL lets every local account read it
/// — and another signed-in user could then connect to it, or hold a listening instance to shut the
/// sidecar out. The token still guards every request; this keeps the door itself closed. `OW` is the
/// pipe's owner (the account running Draft Canvas), `SY` the system, and `P` stops inherited entries
/// from adding anyone back.
#[cfg(windows)]
struct OwnerOnly {
    descriptor: *mut core::ffi::c_void,
    attributes: windows_sys::Win32::Security::SECURITY_ATTRIBUTES,
}

// SAFETY: the descriptor is immutable once built and only ever read by the pipe calls.
#[cfg(windows)]
unsafe impl Send for OwnerOnly {}
#[cfg(windows)]
unsafe impl Sync for OwnerOnly {}

#[cfg(windows)]
impl OwnerOnly {
    fn new() -> std::io::Result<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        let sddl: Vec<u16> = std::ffi::OsStr::new("D:P(A;;GA;;;OW)(A;;GA;;;SY)")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut descriptor: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated; on success Windows allocates `descriptor`, freed in `drop`.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            },
        })
    }

    fn attributes(&self) -> *mut core::ffi::c_void {
        &self.attributes as *const _ as *mut core::ffi::c_void
    }
}

#[cfg(windows)]
impl Drop for OwnerOnly {
    fn drop(&mut self) {
        // SAFETY: allocated by `ConvertStringSecurityDescriptorToSecurityDescriptorW`, freed once.
        unsafe {
            windows_sys::Win32::Foundation::LocalFree(self.descriptor);
        }
    }
}

fn write_info(agent: &Agent, endpoint: String, token: &str) -> std::io::Result<()> {
    endpoint::write_info(
        agent.dir(),
        &Info {
            v: BRIDGE_VERSION,
            endpoint,
            token: token.to_string(),
            pid: std::process::id(),
        },
    )
    .map_err(|e| std::io::Error::other(e.message))
}

#[cfg(target_os = "macos")]
fn same_user(stream: &tokio::net::UnixStream) -> bool {
    extern "C" {
        fn getuid() -> u32;
    }
    match stream.peer_cred() {
        Ok(cred) => cred.uid() == unsafe { getuid() },
        Err(_) => false,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn same_user(_stream: &tokio::net::UnixStream) -> bool {
    true
}

/// Reads one frame. `Ok(None)` at a clean end of stream.
async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> std::io::Result<Option<Value>> {
    let mut line = Vec::new();
    let read = (&mut *reader)
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut line)
        .await?;
    if read == 0 {
        return Ok(None);
    }
    if line.len() as u64 > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "not a JSON frame"))
}

/// Constant-time comparison, so the time a refusal takes says nothing about how much of a guessed
/// token was right.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The agent session a connection belongs to: the sidecar's nonce when it sent a plausible one, or
/// one made up for this connection alone.
pub fn session_of(hello: &Value) -> String {
    hello
        .get("session")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

/// The companion run a hello names, if it names a plausible one.
pub fn run_of(hello: &Value) -> Option<String> {
    hello
        .get("run")
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        .map(str::to_string)
}

/// A run named in a hello that isn't open: refused, so a stale or made-up name reaches nothing.
fn check_run(agent: &Agent, run: Option<&str>) -> Result<(), Value> {
    match run {
        Some(run) if agent.runs.policy(run).is_none() => Err(json!({
            "type": "refused",
            "code": "RUN_ENDED",
            "message": "This request from the Draft Canvas companion has already ended.",
        })),
        _ => Ok(()),
    }
}

/// Checks a hello frame. `Err` carries the refusal to send before closing.
pub fn check_hello(frame: &Value, token: &str, app_version: &str) -> Result<Value, Option<Value>> {
    if frame.get("type").and_then(Value::as_str) != Some("hello") {
        return Err(None);
    }
    let offered = frame.get("token").and_then(Value::as_str).unwrap_or("");
    if !same_secret(offered, token) {
        // Said without detail: a caller without the token learns nothing about why.
        return Err(Some(
            json!({"type": "refused", "code": "UNAUTHORIZED", "message": "Draft Canvas didn't recognise this connection. Turn agent access off and on again if this persists."}),
        ));
    }
    let bridge = frame.get("bridge").and_then(Value::as_u64).unwrap_or(0);
    if bridge != u64::from(BRIDGE_VERSION) {
        let newer = bridge > u64::from(BRIDGE_VERSION);
        return Err(Some(json!({
            "type": "refused",
            "code": "VERSION_MISMATCH",
            "message": if newer {
                "The agent connector is newer than this Draft Canvas. Update Draft Canvas."
            } else {
                "The agent connector is older than this Draft Canvas. Point your agent at the draft-canvas-mcp inside the current app."
            },
            "app": app_version,
            "bridge": BRIDGE_VERSION,
        })));
    }
    Ok(json!({"type": "welcome", "bridge": BRIDGE_VERSION, "app": app_version}))
}

async fn serve<R, W>(
    agent: Arc<Agent>,
    token: String,
    read: R,
    mut write: W,
    mut stop: broadcast::Receiver<String>,
) where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut reader = BufReader::new(read);
    let version = agent
        .app()
        .map(|a| a.package_info().version.to_string())
        .unwrap_or_default();
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut reader)).await {
        Ok(Ok(Some(frame))) => frame,
        _ => return,
    };
    let run = run_of(&hello);
    let checked = check_hello(&hello, &token, &version).and_then(|welcome| {
        match check_run(&agent, run.as_deref()) {
            Ok(()) => Ok(welcome),
            Err(refusal) => Err(Some(refusal)),
        }
    });
    match checked {
        Ok(welcome) => {
            if send(&mut write, &welcome).await.is_err() {
                return;
            }
        }
        Err(refusal) => {
            if let Some(refusal) = refusal {
                let _ = send(&mut write, &refusal).await;
            }
            return;
        }
    }
    agent.connection_opened();
    let session = session_of(&hello);

    // Writes funnel through one task so concurrent results never interleave within a line.
    let (out_tx, mut out_rx) = mpsc::channel::<Value>(32);
    let mut writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if send(&mut write, &frame).await.is_err() {
                break;
            }
        }
    });

    let calls: Arc<Mutex<HashMap<u64, Arc<CallRegistry>>>> = Arc::default();
    let mut writer_done = false;
    loop {
        tokio::select! {
            _ = &mut writer => {
                writer_done = true;
                break;
            }
            frame = read_frame(&mut reader) => {
                let Ok(Some(frame)) = frame else { break };
                match frame.get("type").and_then(Value::as_str) {
                    Some("call") => {
                        let id = frame.get("id").and_then(Value::as_u64);
                        let tool = frame.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
                        let args = frame.get("args").cloned().unwrap_or(Value::Null);
                        let admitted = admit(&crate::util::lock(&calls), id);
                        let id = match admitted {
                            Ok(id) => id,
                            Err(error) => {
                                let _ = out_tx.send(json!({"type": "result", "id": id.unwrap_or(0), "ok": false, "error": error.to_value()})).await;
                                continue;
                            }
                        };
                        let registry = Arc::new(CallRegistry::new(session.clone()).with_run(run.clone()).with_progress(out_tx.clone(), id));
                        // A run's calls are tracked so ending the run can cancel them; a run that
                        // has ended admits nothing more.
                        if let Some(run) = &run {
                            if !agent.runs.track(run, &registry) {
                                let _ = out_tx.send(json!({"type": "result", "id": id, "ok": false, "error": super::runs::ended().to_value()})).await;
                                continue;
                            }
                        }
                        agent.track_call(&registry);
                        crate::util::lock(&calls).insert(id, registry.clone());
                        let (agent, out_tx, calls) = (agent.clone(), out_tx.clone(), calls.clone());
                        tauri::async_runtime::spawn(async move {
                            // A call walks project folders, reads and writes diagram files and fsyncs
                            // the ledger between its waits on the page, all synchronously; on a
                            // blocking thread none of that stalls the runtime's few workers, which
                            // keep every connection's frames moving meanwhile.
                            let result = {
                                let (agent, registry) = (agent.clone(), registry.clone());
                                tauri::async_runtime::spawn_blocking(move || {
                                    tauri::async_runtime::block_on(broker::call(&agent, &tool, args, &registry))
                                })
                                .await
                                .unwrap_or_else(|_| Err(broker::ToolError::new("INTERNAL", "The request failed unexpectedly.")))
                            };
                            crate::util::lock(&calls).remove(&id);
                            let frame = match result {
                                Ok(value) => json!({"type": "result", "id": id, "ok": true, "value": value}),
                                Err(error) => json!({"type": "result", "id": id, "ok": false, "error": error.to_value()}),
                            };
                            // The client may be gone; the outcome is in the ledger for its retry.
                            let _ = out_tx.send(frame).await;
                        });
                    }
                    Some("cancel") => {
                        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
                        let registry = crate::util::lock(&calls).get(&id).cloned();
                        if let Some(registry) = registry {
                            registry.cancel(&agent);
                        }
                    }
                    _ => {}
                }
            }
            reason = stop.recv() => {
                let reason = reason.unwrap_or_else(|_| "disabled".into());
                if reason == "disabled" {
                    cancel_calls(&agent, &calls);
                }
                let _ = out_tx.send(json!({"type": "shutdown", "reason": reason})).await;
                if reason == "disabled" { break; }
            }
        }
    }
    drop(out_tx);
    if !writer_done {
        // In-flight calls may retain senders while they finish at the commit gate. Their ledger
        // outcomes survive the connection, so waiting for every sender here serves no purpose.
        let _ = tokio::time::timeout(WRITE_TIMEOUT, &mut writer).await;
        writer.abort();
    }
    agent.connection_closed();
}

/// Turning access off is an explicit cancellation; a dropped socket alone is not. Copy the
/// registries before taking their locks, so a finishing broker can still remove itself.
fn cancel_calls(agent: &Agent, calls: &Mutex<HashMap<u64, Arc<CallRegistry>>>) {
    let calls: Vec<_> = crate::util::lock(calls).values().cloned().collect();
    for call in calls {
        call.cancel(agent);
    }
}

/// Why a call can't start on this connection, if it can't. An id already in flight would replace that
/// call's entry, slipping past the cap and sending a cancel for either to the wrong one.
fn admit<T>(calls: &HashMap<u64, T>, id: Option<u64>) -> Result<u64, broker::ToolError> {
    let Some(id) = id else {
        return Err(broker::ToolError::new(
            "INVALID_INPUT",
            "A request needs a numeric id.",
        ));
    };
    if calls.contains_key(&id) {
        return Err(broker::ToolError::new(
            "INVALID_INPUT",
            "A request with this id is already running on this connection.",
        ));
    }
    if calls.len() >= MAX_CONCURRENT_CALLS {
        return Err(broker::ToolError::new(
            "BUSY",
            "Too many requests at once on this connection.",
        )
        .retryable());
    }
    Ok(id)
}

async fn send<W: AsyncWrite + Unpin>(write: &mut W, frame: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    tokio::time::timeout(WRITE_TIMEOUT, async {
        write.write_all(&line).await?;
        write.flush().await
    })
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "bridge write stalled"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hello_naming_a_run_is_refused_unless_that_run_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Agent::new(dir.path());
        let run = "3f1c2a4e-0000-4000-8000-000000000001";
        assert_eq!(
            run_of(&json!({"type": "hello", "run": run})).as_deref(),
            Some(run)
        );
        assert_eq!(run_of(&json!({"type": "hello"})), None);
        assert_eq!(run_of(&json!({"type": "hello", "run": "a b"})), None);
        assert!(check_run(&agent, None).is_ok(), "an ordinary agent");
        assert_eq!(
            check_run(&agent, Some(run)).unwrap_err()["code"],
            "RUN_ENDED"
        );
        agent.runs.open(
            run,
            super::super::runs::RunPolicy {
                diagram_id: "d_1".into(),
                direct: false,
                code: None,
            },
        );
        assert!(check_run(&agent, Some(run)).is_ok());
        agent.end_run(run);
        assert!(check_run(&agent, Some(run)).is_err());
    }

    #[test]
    fn a_hello_keeps_its_session_nonce_and_a_missing_or_odd_one_gets_a_fresh_session() {
        let hello = |session: Value| json!({"type": "hello", "session": session});
        assert_eq!(session_of(&hello(json!("s1f-abc"))), "s1f-abc");
        let fresh = session_of(&json!({"type": "hello"}));
        assert!(!fresh.is_empty());
        assert_ne!(
            fresh,
            session_of(&json!({"type": "hello"})),
            "each connection alone"
        );
        assert_ne!(session_of(&hello(json!("a b"))), "a b", "not a nonce");
        assert_ne!(session_of(&hello(json!("x".repeat(65)))).len(), 65);
    }

    #[test]
    fn a_hello_needs_the_token_and_the_same_bridge_version() {
        let good = json!({"type": "hello", "bridge": BRIDGE_VERSION, "token": "secret"});
        assert_eq!(
            check_hello(&good, "secret", "1.0.0").unwrap()["type"],
            "welcome"
        );
        let wrong = json!({"type": "hello", "bridge": BRIDGE_VERSION, "token": "guess"});
        let refusal = check_hello(&wrong, "secret", "1.0.0").unwrap_err().unwrap();
        assert_eq!(refusal["code"], "UNAUTHORIZED");
        assert!(!refusal.to_string().contains("secret"));
        let old = json!({"type": "hello", "bridge": 0, "token": "secret"});
        assert_eq!(
            check_hello(&old, "secret", "1.0.0").unwrap_err().unwrap()["code"],
            "VERSION_MISMATCH"
        );
        assert!(check_hello(&json!({"type": "call"}), "secret", "1")
            .unwrap_err()
            .is_none());
    }

    #[test]
    fn secrets_compare_without_early_exit_semantics() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"));
    }

    #[test]
    fn a_call_needs_an_id_not_already_running_and_room_under_the_cap() {
        let mut calls: HashMap<u64, ()> = HashMap::new();
        assert_eq!(admit(&calls, Some(1)), Ok(1));
        assert_eq!(admit(&calls, None).unwrap_err().code, "INVALID_INPUT");
        calls.insert(1, ());
        assert_eq!(
            admit(&calls, Some(1)).unwrap_err().code,
            "INVALID_INPUT",
            "a duplicate would replace the running call"
        );
        for id in 2..=MAX_CONCURRENT_CALLS as u64 {
            calls.insert(id, ());
        }
        assert_eq!(admit(&calls, Some(99)).unwrap_err().code, "BUSY");
    }

    #[test]
    fn disabling_access_cancels_calls_even_before_they_reach_the_page() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Agent::new(dir.path());
        let call = Arc::new(CallRegistry::new("external".into()));
        let calls = Mutex::new(HashMap::from([(1, call.clone())]));
        cancel_calls(&agent, &calls);
        // Register through the update path after shutdown, as a folder lookup could do.
        assert!(call.is_cancelled());
    }

    #[tokio::test(start_paused = true)]
    async fn a_nonreading_client_cannot_hold_a_bridge_write_forever() {
        let (mut writer, _nonreading_client) = tokio::io::duplex(64);
        let started = tokio::time::Instant::now();
        let error = send(&mut writer, &json!({"value": "x".repeat(4096)}))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(started.elapsed(), WRITE_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_welcome_does_not_retain_an_authenticated_connection() {
        let dir = tempfile::tempdir().unwrap();
        let agent = Arc::new(Agent::new(dir.path()));
        let (socket, client) = tokio::io::duplex(1);
        let (read, write) = tokio::io::split(socket);
        let (_stop, stopped) = broadcast::channel(1);
        let (_nonreading_client, mut client_writer) = tokio::io::split(client);
        let hello = async {
            send(
                &mut client_writer,
                &json!({"type": "hello", "bridge": BRIDGE_VERSION, "token": "secret"}),
            )
            .await
            .unwrap();
        };
        let serve = serve(agent, "secret".into(), read, write, stopped);
        let started = tokio::time::Instant::now();
        tokio::join!(serve, hello);
        assert_eq!(started.elapsed(), WRITE_TIMEOUT);
    }

    #[tokio::test]
    async fn an_oversized_frame_is_refused_not_buffered() {
        let big = vec![b'x'; (MAX_FRAME + 10) as usize];
        let mut reader = BufReader::new(&big[..]);
        assert!(read_frame(&mut reader).await.is_err());
    }
}
