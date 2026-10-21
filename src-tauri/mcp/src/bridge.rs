//! The connection to the running app (see the app's `agent/bridge.rs` for the frames).
//!
//! Connected lazily, on the first tool call, and again after the app restarts or turns access off and
//! on: a call that finds the connection gone reconnects once before giving up. Nothing here retries a
//! *call* — a change whose answer was lost is the ledger's business, reached by the agent retrying with
//! the same `requestId`.

use crate::endpoint::{self, Missing};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

pub const BRIDGE_VERSION: u32 = 1;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The app's own budgets add to at most ~95 s for a change that passed its commit gate.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// A failure reaching the app, as the error object a tool result carries.
pub fn error(code: &str, message: &str, hint: &str, retryable: bool) -> Value {
    let mut e = json!({"code": code, "message": message, "hint": hint});
    if retryable {
        e["retryable"] = json!(true);
    }
    e
}

fn unavailable(missing: Option<Missing>) -> Value {
    match missing {
        Some(Missing::Unreadable) => error(
            "APP_UNAVAILABLE",
            "Draft Canvas's connection details couldn't be read.",
            "In Draft Canvas, open Settings → AI agents and turn agent access off and on again.",
            false,
        ),
        _ => error(
            "APP_UNAVAILABLE",
            "Draft Canvas isn't running, or agent access is turned off.",
            "Ask the person to open Draft Canvas and turn on Settings → AI agents, then try again.",
            true,
        ),
    }
}

struct Conn {
    out: mpsc::Sender<Value>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    alive: Arc<AtomicBool>,
}

/// Where a call's progress messages go while it runs (see `Bridge::call`).
type ProgressSinks = Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>>;

/// Remove waiters even when a call times out or its future is dropped by the MCP runtime.
struct Registration<T> {
    id: u64,
    entries: Arc<Mutex<HashMap<u64, T>>>,
}

impl<T> Drop for Registration<T> {
    fn drop(&mut self) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

#[derive(Default)]
pub struct Bridge {
    conn: tokio::sync::Mutex<Option<Conn>>,
    next: AtomicU64,
    version: String,
    /// This process's agent session, sent in every hello so a reconnect is still the same session.
    session: String,
    /// Kept across reconnects: a call's sink outlives the connection it was sent on.
    progress: ProgressSinks,
}

impl Bridge {
    pub fn new(version: String) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        Self {
            version,
            session: format!("s{:x}-{nanos:x}", std::process::id()),
            ..Self::default()
        }
    }

    /// Sends a call and waits for its result: `Ok` with the tool's value, `Err` with an error object.
    /// `progress`, when given, receives the app's short stage messages for this call as they arrive.
    pub async fn call(
        &self,
        tool: &str,
        args: Value,
        on_id: impl FnOnce(u64),
        progress: Option<mpsc::UnboundedSender<String>>,
    ) -> Result<Value, Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(sink) = progress {
            self.progress
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id, sink);
        }
        let _progress = Registration {
            id,
            entries: self.progress.clone(),
        };
        self.call_as(id, tool, args, on_id).await
    }

    async fn call_as(
        &self,
        id: u64,
        tool: &str,
        args: Value,
        on_id: impl FnOnce(u64),
    ) -> Result<Value, Value> {
        let (rx, _pending) = {
            let mut guard = self.conn.lock().await;
            if !guard
                .as_ref()
                .is_some_and(|c| c.alive.load(Ordering::SeqCst))
            {
                *guard = Some(self.connect().await?);
            }
            let conn = guard.as_ref().expect("connected above");
            let (tx, rx) = oneshot::channel();
            conn.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id, tx);
            let pending = Registration {
                id,
                entries: conn.pending.clone(),
            };
            let frame = json!({"type": "call", "id": id, "tool": tool, "args": args});
            // The app drops the whole connection on a frame past its cap, and every call in flight
            // with it; the agent, told the connection was lost and to retry, resent the same call.
            if frame.to_string().len() >= APP_MAX_FRAME {
                return Err(too_large());
            }
            if conn.out.send(frame).await.is_err() {
                *guard = None;
                return Err(lost());
            }
            (rx, pending)
        };
        on_id(id);
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(frame)) => {
                if frame.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(frame.get("value").cloned().unwrap_or(Value::Null))
                } else {
                    Err(frame.get("error").cloned().unwrap_or_else(|| {
                        error("INTERNAL", "Draft Canvas reported a failure.", "", false)
                    }))
                }
            }
            _ => Err(lost()),
        }
    }

    /// Asks the app to stop working on a call whose client gave up. Best effort: work past its commit
    /// gate finishes regardless.
    pub async fn cancel(&self, id: u64) {
        if let Some(conn) = self.conn.lock().await.as_ref() {
            let _ = conn.out.send(json!({"type": "cancel", "id": id})).await;
        }
    }

    async fn connect(&self) -> Result<Conn, Value> {
        let info = endpoint::read_info().map_err(|m| unavailable(Some(m)))?;
        if info.v != BRIDGE_VERSION {
            return Err(error(
                "VERSION_MISMATCH",
                "This agent connector and the running Draft Canvas speak different versions of their bridge.",
                "Point your agent's MCP configuration at the draft-canvas-mcp inside the Draft Canvas app you are running (Settings → AI agents shows the path).",
                false,
            ));
        }
        let connected = tokio::time::timeout(CONNECT_TIMEOUT, open(&info.endpoint)).await;
        let (read, write) = match connected {
            Ok(Ok(halves)) => halves,
            _ => return Err(unavailable(None)),
        };
        let mut reader = BufReader::new(read);
        let mut write = write;
        let hello = json!({"type": "hello", "bridge": BRIDGE_VERSION, "sidecar": self.version, "token": info.token, "session": self.session});
        send(&mut write, &hello)
            .await
            .map_err(|_| unavailable(None))?;
        let welcome = tokio::time::timeout(CONNECT_TIMEOUT, read_frame(&mut reader))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .ok_or_else(|| unavailable(None))?;
        match welcome.get("type").and_then(Value::as_str) {
            Some("welcome") => {}
            Some("refused") => {
                let code = welcome
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("UNAUTHORIZED");
                let message = welcome
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Draft Canvas refused the connection.");
                return Err(error(code, message, "", false));
            }
            _ => return Err(unavailable(None)),
        }

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (out, mut out_rx) = mpsc::channel::<Value>(16);
        tokio::spawn(async move {
            while let Some(frame) = out_rx.recv().await {
                if send(&mut write, &frame).await.is_err() {
                    break;
                }
            }
        });
        let (reader_pending, reader_alive) = (pending.clone(), alive.clone());
        let reader_progress = self.progress.clone();
        tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut reader).await {
                match frame.get("type").and_then(Value::as_str) {
                    Some("progress") => {
                        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
                        let message = frame
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .chars()
                            .take(120)
                            .collect::<String>();
                        if let Some(sink) = reader_progress
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .get(&id)
                        {
                            let _ = sink.send(message);
                        }
                    }
                    Some("result") => {
                        let id = frame.get("id").and_then(Value::as_u64).unwrap_or(0);
                        let waiter = reader_pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&id);
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(frame);
                        }
                    }
                    Some("shutdown") => {
                        // The app is quitting or access was turned off: the next call reconnects.
                        reader_alive.store(false, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }
            reader_alive.store(false, Ordering::SeqCst);
            // Every call still waiting learns its connection went away (its sender is dropped here).
            reader_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        });
        Ok(Conn {
            out,
            pending,
            alive,
        })
    }
}

fn too_large() -> Value {
    error(
        "LIMIT_EXCEEDED",
        "This request is too large for Draft Canvas to accept in one call.",
        "Split it into smaller update_diagram calls, or shorten long notes and code snippets.",
        false,
    )
}

fn lost() -> Value {
    error(
        "CONNECTION_LOST",
        "The connection to Draft Canvas was lost before its answer arrived.",
        "Retry with the same requestId: Draft Canvas remembers requests, so one that already took effect returns its first result instead of applying twice.",
        true,
    )
}

type Halves = (
    Box<dyn AsyncRead + Unpin + Send>,
    Box<dyn AsyncWrite + Unpin + Send>,
);

#[cfg(unix)]
async fn open(endpoint: &str) -> std::io::Result<Halves> {
    let stream = tokio::net::UnixStream::connect(endpoint).await?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(windows)]
async fn open(endpoint: &str) -> std::io::Result<Halves> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let client = ClientOptions::new().open(endpoint)?;
    let (r, w) = tokio::io::split(client);
    Ok((Box::new(r), Box::new(w)))
}

async fn send<W: AsyncWrite + Unpin>(write: &mut W, frame: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    write.write_all(&line).await?;
    write.flush().await
}

/// The app's own cap on a frame it reads (`MAX_FRAME` in the app's `agent/bridge.rs`), newline included.
const APP_MAX_FRAME: usize = 4 * 1024 * 1024;

/// A generous cap. The app refuses frames past 4 MiB, and the largest it sends is a `render_diagram`
/// answer: a PNG the page caps at 8 MB, which is ~10.7 MB once base64-encoded into the frame.
const MAX_FRAME: usize = 16 * 1024 * 1024;

async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> std::io::Result<Option<Value>> {
    let mut line = Vec::new();
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(None);
        }
        let end = buf.iter().position(|b| *b == b'\n');
        let len = end.unwrap_or(buf.len());
        // Check the final chunk as well, before extending the allocation.
        if len > MAX_FRAME - line.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        line.extend_from_slice(&buf[..len]);
        reader.consume(len + usize::from(end.is_some()));
        if end.is_some() {
            break;
        }
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "not JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_limit_includes_the_chunk_containing_the_newline() {
        let data = format!("\"{}\"\n", "x".repeat(MAX_FRAME - 1));
        let mut reader = BufReader::with_capacity(data.len(), data.as_bytes());
        assert_eq!(
            read_frame(&mut reader).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        let data = format!("\"{}\"\n", "x".repeat(MAX_FRAME - 2));
        let mut reader = BufReader::with_capacity(data.len(), data.as_bytes());
        assert!(read_frame(&mut reader).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn dropping_a_call_cleans_up_its_waiter_and_progress_sink() {
        let (out, mut received) = mpsc::channel(4);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let bridge = Bridge {
            conn: tokio::sync::Mutex::new(Some(Conn {
                out,
                pending: pending.clone(),
                alive: Arc::new(AtomicBool::new(true)),
            })),
            ..Bridge::new("test".into())
        };
        let (progress, _rx) = mpsc::unbounded_channel();
        let mut call = Box::pin(bridge.call("read_diagram", json!({}), |_| {}, Some(progress)));
        tokio::select! {
            answer = &mut call => panic!("no app answer: {answer:?}"),
            frame = received.recv() => assert_eq!(frame.unwrap()["type"], "call"),
        }
        assert_eq!(pending.lock().unwrap().len(), 1);
        assert_eq!(bridge.progress.lock().unwrap().len(), 1);
        drop(call);
        assert!(pending.lock().unwrap().is_empty());
        assert!(bridge.progress.lock().unwrap().is_empty());
    }
}
