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
        let first = tauri::async_runtime::block_on(async {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&name)
        })?;
        write_info(&agent, name.clone(), &token)?;
        let stop_rx = stop.clone();
        let task = tauri::async_runtime::spawn(async move {
            let mut server = first;
            loop {
                if server.connect().await.is_err() {
                    continue;
                }
                let connected = server;
                server = match ServerOptions::new()
                    .reject_remote_clients(true)
                    .create(&name)
                {
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
    match check_hello(&hello, &token, &version) {
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
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if send(&mut write, &frame).await.is_err() {
                break;
            }
        }
    });

    let calls: Arc<Mutex<HashMap<u64, Arc<CallRegistry>>>> = Arc::default();
    loop {
        tokio::select! {
            frame = read_frame(&mut reader) => {
                let Ok(Some(frame)) = frame else { break };
                match frame.get("type").and_then(Value::as_str) {
                    Some("call") => {
                        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
                        let tool = frame.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
                        let args = frame.get("args").cloned().unwrap_or(Value::Null);
                        if crate::util::lock(&calls).len() >= MAX_CONCURRENT_CALLS {
                            let error = broker::ToolError::new("BUSY", "Too many requests at once on this connection.").retryable();
                            let _ = out_tx.send(json!({"type": "result", "id": id, "ok": false, "error": error.to_value()})).await;
                            continue;
                        }
                        let registry = Arc::new(CallRegistry::new(session.clone()).with_progress(out_tx.clone(), id));
                        crate::util::lock(&calls).insert(id, registry.clone());
                        let (agent, out_tx, calls) = (agent.clone(), out_tx.clone(), calls.clone());
                        tauri::async_runtime::spawn(async move {
                            let result = broker::call(&agent, &tool, args, &registry).await;
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
                        if let Some(page_id) = registry.and_then(|r| r.current()) {
                            agent.page.cancel(page_id);
                        }
                    }
                    _ => {}
                }
            }
            reason = stop.recv() => {
                let reason = reason.unwrap_or_else(|_| "disabled".into());
                let _ = out_tx.send(json!({"type": "shutdown", "reason": reason})).await;
                if reason == "disabled" { break; }
            }
        }
    }
    drop(out_tx);
    let _ = writer.await;
    agent.connection_closed();
}

async fn send<W: AsyncWrite + Unpin>(write: &mut W, frame: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    write.write_all(&line).await?;
    write.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn an_oversized_frame_is_refused_not_buffered() {
        let big = vec![b'x'; (MAX_FRAME + 10) as usize];
        let mut reader = BufReader::new(&big[..]);
        assert!(read_frame(&mut reader).await.is_err());
    }
}
