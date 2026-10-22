//! The relay driven over real sockets on loopback: a browser's requests written out by hand, and a
//! real WebSocket client.

use super::server::content_security_policy;
use super::socket::{Bucket, Budget};
use super::*;
use crate::state::HostEvent;
use futures_util::{SinkExt, StreamExt};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::{CloseCode, Data, OpCode};
use tokio_tungstenite::tungstenite::protocol::frame::Frame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const OTHER_TOKEN: &str = "fedcba9876543210fedcba9876543210";
const WAIT: Duration = Duration::from_secs(10);

const LOOPBACK: Bind = Bind {
    v4: Ipv4Addr::LOCALHOST,
    v6: Some(Ipv6Addr::LOCALHOST),
};

#[derive(Default)]
struct Events {
    list: Mutex<Vec<HostEvent>>,
    changed: Notify,
}

impl Sink for Events {
    fn emit(&self, event: HostEvent) {
        lock(&self.list).push(event);
        self.changed.notify_waiters();
    }
}

impl Events {
    fn all(&self) -> Vec<HostEvent> {
        lock(&self.list).clone()
    }

    /// Waits until `found` picks something out of the events so far.
    async fn wait<T>(&self, found: impl Fn(&[HostEvent]) -> Option<T>) -> T {
        timeout(WAIT, async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(value) = found(&lock(&self.list)) {
                    return value;
                }
                changed.await;
            }
        })
        .await
        .expect("the event never came")
    }

    async fn opened(&self, nth: usize) -> String {
        self.wait(|events| {
            events
                .iter()
                .filter_map(|e| match e {
                    HostEvent::CollabLanOpen { conn_id } => Some(conn_id.clone()),
                    _ => None,
                })
                .nth(nth)
        })
        .await
    }

    /// The texts the page has heard from one guest so far.
    fn heard(&self, id: &str) -> Vec<String> {
        lock(&self.list)
            .iter()
            .filter_map(|e| match e {
                HostEvent::CollabLanMessage { conn_id, text } if conn_id == id => {
                    Some(text.clone())
                }
                _ => None,
            })
            .collect()
    }

    /// Waits until the page has heard `count` texts from one guest.
    async fn heard_at_least(&self, id: &str, count: usize) {
        self.wait(|events| {
            let heard = events
                .iter()
                .filter(
                    |e| matches!(e, HostEvent::CollabLanMessage { conn_id, .. } if conn_id == id),
                )
                .count();
            (heard >= count).then_some(())
        })
        .await;
    }

    fn is_closed(&self, id: &str) -> bool {
        lock(&self.list)
            .iter()
            .any(|e| matches!(e, HostEvent::CollabLanClose { conn_id, .. } if conn_id == id))
    }

    async fn closed(&self, id: &str) -> String {
        self.wait(|events| {
            events.iter().find_map(|e| match e {
                HostEvent::CollabLanClose { conn_id, reason } if conn_id == id => {
                    Some(reason.clone())
                }
                _ => None,
            })
        })
        .await
    }
}

struct Files(HashMap<&'static str, &'static [u8]>);

impl AssetSource for Files {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.0.get(key).map(|bytes| bytes.to_vec())
    }
}

fn files() -> Arc<Files> {
    Arc::new(Files(HashMap::from([
        (
            "/index.html",
            &b"<!doctype html><title>Draft Canvas</title>"[..],
        ),
        ("/assets/index-1a2b.js", &b"console.log(1)"[..]),
        ("/assets/index-1a2b.css", &b"body{}"[..]),
        ("/favicon.svg", &b"<svg/>"[..]),
    ])))
}

fn relay_with(limits: Limits) -> (Arc<Events>, Relay) {
    let events = Arc::new(Events::default());
    let relay = Relay::new(events.clone(), files(), limits);
    (events, relay)
}

async fn started(limits: Limits) -> (Arc<Events>, Relay, u16) {
    let (events, relay) = relay_with(limits);
    let started = relay.start_on(TOKEN, LOOPBACK).await.unwrap();
    (events, relay, started.port)
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// One request exactly as written, on its own connection.
async fn http(port: u16, request: &str) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    timeout(WAIT, stream.read_to_end(&mut raw))
        .await
        .unwrap()
        .unwrap();
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a complete response");
    let head = String::from_utf8(raw[..split].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|line| line.split_once(": "))
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect();
    Reply {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

async fn get(port: u16, path: &str) -> Reply {
    http(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    )
    .await
}

type Guest = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Upgrade<'a> {
    origin: Option<String>,
    protocols: Option<&'a str>,
}

impl Upgrade<'_> {
    fn ok(port: u16) -> Self {
        Self {
            origin: Some(format!("http://127.0.0.1:{port}")),
            protocols: Some("draft-canvas.collab.v1, 0123456789abcdef0123456789abcdef"),
        }
    }
}

async fn connect(port: u16, upgrade: Upgrade<'_>) -> Result<Guest, u16> {
    let mut request = format!("ws://127.0.0.1:{port}/collab")
        .into_client_request()
        .unwrap();
    let headers = request.headers_mut();
    if let Some(origin) = upgrade.origin {
        headers.insert("Origin", HeaderValue::from_str(&origin).unwrap());
    }
    if let Some(protocols) = upgrade.protocols {
        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(protocols).unwrap(),
        );
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((guest, response)) => {
            assert_eq!(
                response.headers()["sec-websocket-protocol"],
                PROTOCOL,
                "the protocol is echoed, never the token"
            );
            Ok(guest)
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(response.status().as_u16())
        }
        Err(other) => panic!("{other}"),
    }
}

async fn guest(port: u16) -> Guest {
    connect(port, Upgrade::ok(port)).await.expect("let in")
}

/// The next frame the guest isn't answering on its own.
async fn next(guest: &mut Guest) -> Option<Message> {
    loop {
        match timeout(WAIT, guest.next()).await.expect("a frame") {
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(message)) => return Some(message),
            Some(Err(_)) | None => return None,
        }
    }
}

async fn close_of(guest: &mut Guest) -> (u16, String) {
    match next(guest).await {
        Some(Message::Close(Some(frame))) => (u16::from(frame.code), frame.reason.to_string()),
        other => panic!("expected a close, got {other:?}"),
    }
}

/// The close a guest gets for being cut off mid-flood or mid-frame (`rate`, `too-large`). The relay
/// stops reading such a guest, and Windows resets a socket dropped with bytes still unread, which can
/// cost the guest the close queued ahead of the reset — so there, a reset in its place passes. The
/// app's own guests never get here (they keep to both limits), and what the page is told is asserted
/// separately, on every platform.
async fn assert_cut_off(guest: &mut Guest, code: u16, reason: &str) {
    match next(guest).await {
        Some(Message::Close(Some(frame))) => {
            assert_eq!(
                (u16::from(frame.code), frame.reason.as_str()),
                (code, reason)
            );
        }
        None if cfg!(windows) => {}
        other => panic!("expected a close, got {other:?}"),
    }
}

// ─── Files ──────────────────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn the_app_is_served_with_the_web_builds_policy_and_this_socket() {
    let (_, relay, port) = started(Limits::default()).await;
    let reply = get(port, "/").await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, b"<!doctype html><title>Draft Canvas</title>");
    assert_eq!(
        reply.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(reply.header("referrer-policy"), Some("no-referrer"));
    let policy = reply.header("content-security-policy").unwrap();
    assert!(
        policy.contains(&format!("connect-src 'self' ws://127.0.0.1:{port};")),
        "{policy}"
    );
    assert!(reply.header("cross-origin-opener-policy").is_none());
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn each_file_has_its_type_and_heads_and_other_methods_are_answered() {
    let (_, relay, port) = started(Limits::default()).await;
    let script = get(port, "/assets/index-1a2b.js").await;
    assert_eq!(script.status, 200);
    assert_eq!(
        script.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        script.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert_eq!(
        get(port, "/assets/index-1a2b.css")
            .await
            .header("content-type"),
        Some("text/css; charset=utf-8")
    );
    assert_eq!(
        get(port, "/favicon.svg").await.header("content-type"),
        Some("image/svg+xml")
    );
    let head = http(
        port,
        &format!(
            "HEAD /index.html HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        ),
    )
    .await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    let post = http(
        port,
        &format!("POST / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    )
    .await;
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some("GET, HEAD"));
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn anything_not_exactly_a_bundled_file_is_not_found() {
    let (_, relay, port) = started(Limits::default()).await;
    for path in [
        "/nope.js",
        "/assets/",
        "/assets",
        "/index.html/",
        "/../index.html",
        "/assets/../index.html",
        "/%2e%2e/index.html",
        "/assets/%2e%2e/index.html",
        "/assets%2f..%2findex.html",
        "/assets/..%5cindex.html",
        "/assets\\..\\index.html",
        "//index.html",
        "/./index.html",
        "/.env",
        "/C:/Windows/win.ini",
        "/%00",
        "/%ff",
        "/%zz",
    ] {
        let reply = get(port, path).await;
        assert_eq!(reply.status, 404, "{path}");
        assert_eq!(reply.header("x-content-type-options"), Some("nosniff"));
        assert!(
            !reply.body.starts_with(b"<!doctype"),
            "{path} fell back to the app"
        );
    }
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_for_some_other_name_is_refused() {
    let (_, relay, port) = started(Limits::default()).await;
    for host in [
        format!("evil.example:{port}"),
        format!("127.0.0.1:{}", port.wrapping_add(1)),
        "127.0.0.1".to_string(),
        format!("127.0.0.1.nip.io:{port}"),
    ] {
        let reply = http(
            port,
            &format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
        )
        .await;
        assert_eq!(reply.status, 400, "{host}");
    }
    relay.stop("stopped").await;
}

#[test]
fn request_paths_become_bundle_keys_only_when_they_plainly_name_a_file() {
    assert_eq!(assets::key("/").as_deref(), Some("/index.html"));
    assert_eq!(
        assets::key("/assets/a%20b.js").as_deref(),
        Some("/assets/a b.js")
    );
    for bad in [
        "",
        "index.html",
        "/..",
        "/a/../b",
        "/%2E%2E/b",
        "/a%2fb",
        "/a%5cb",
        "/a\\b",
        "/a//b",
        "/a/",
        "/.git/config",
        "/c:",
        "/%0a",
        "/%e2%28%a1",
    ] {
        assert_eq!(assets::key(bad), None, "{bad}");
    }
    assert_eq!(assets::key(&format!("/{}", "a".repeat(2000))), None);
}

#[test]
fn the_policy_is_the_web_builds_own() {
    // The web build's policy as `vite.config.ts` writes it, without the collaboration relay: a page
    // served over the local network talks only to this server — it never reaches the internet, the
    // rendezvous relay included (a LAN guest joins by its link's token, with no knock to relay).
    const VITE: &str = include_str!("../../../vite.config.ts");
    let start = VITE
        .find("const contentSecurityPolicyFor = (relay: string) => [")
        .expect("the policy in vite.config.ts");
    let end = start + VITE[start..].find("].join('; ')").expect("its end");
    let body = &VITE[start..end];
    assert!(
        body.contains(r#": "connect-src 'self'","#),
        "the relay-less connect-src"
    );
    let mut directives: Vec<&str> = body
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix('"')?.strip_suffix("\","))
        .collect();
    assert_eq!(directives.len(), 8, "{directives:?}");
    let font = directives
        .iter()
        .position(|d| d.starts_with("font-src"))
        .expect("font-src");
    directives.insert(font + 1, "connect-src 'self'");
    assert_eq!(content_security_policy(None), directives.join("; "));
    assert_eq!(
        content_security_policy(Some("10.0.0.2:5000")),
        directives.join("; ").replace(
            "connect-src 'self'",
            "connect-src 'self' ws://10.0.0.2:5000"
        )
    );
}

// ─── Who is let in ──────────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn the_sessions_token_lets_a_guest_in_and_text_goes_both_ways_verbatim() {
    let (events, relay, port) = started(Limits::default()).await;
    let mut guest = guest(port).await;
    let id = events.opened(0).await;
    let text = r#"{"t":"op","ops":[{"k":"add","id":"n1","label":"ü 🎨"}]}"#;
    guest.send(Message::text(text)).await.unwrap();
    let heard = events
        .wait(|all| {
            all.iter().find_map(|e| match e {
                HostEvent::CollabLanMessage { conn_id, text } if *conn_id == id => {
                    Some(text.clone())
                }
                _ => None,
            })
        })
        .await;
    assert_eq!(heard, text);
    relay.send(&id, "first".into()).unwrap();
    relay.send(&id, "second".into()).unwrap();
    assert_eq!(next(&mut guest).await, Some(Message::text("first")));
    assert_eq!(next(&mut guest).await, Some(Message::text("second")));
    relay.close(&id, "kicked");
    assert_eq!(close_of(&mut guest).await, (1000, "kicked".to_string()));
    assert_eq!(events.closed(&id).await, "kicked");
    // Open first, close last, each once.
    let all = events.all();
    assert!(matches!(all.first(), Some(HostEvent::CollabLanOpen { .. })));
    assert!(matches!(all.last(), Some(HostEvent::CollabLanClose { .. })));
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_or_missing_token_is_refused_before_the_upgrade() {
    let (events, relay, port) = started(Limits::default()).await;
    let offered = [
        None,
        Some("draft-canvas.collab.v1"),
        Some("0123456789abcdef0123456789abcdef"),
        Some("draft-canvas.collab.v1, 0123456789abcdef0123456789abcdee"),
        Some("draft-canvas.collab.v1, 0123456789ABCDEF0123456789ABCDEF"),
        Some("draft-canvas.collab.v1, 0123456789abcdef0123456789abcdef0"),
        Some("draft-canvas.collab.v1, 0123456789abcdef"),
        Some("draft-canvas.collab.v2, 0123456789abcdef0123456789abcdef"),
    ];
    for protocols in offered {
        let upgrade = Upgrade {
            protocols,
            ..Upgrade::ok(port)
        };
        assert_eq!(
            connect(port, upgrade).await.err(),
            Some(401),
            "{protocols:?}"
        );
    }
    assert!(events.all().is_empty(), "nobody was let in");
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_page_this_server_served_may_open_the_socket() {
    let (_, relay, port) = started(Limits::default()).await;
    for origin in [
        None,
        Some("null".to_string()),
        Some("http://evil.example".to_string()),
        Some(format!("http://evil.example:{port}")),
        Some(format!("https://127.0.0.1:{port}")),
        Some(format!("http://127.0.0.1:{}", port.wrapping_add(1))),
        Some(format!("http://localhost:{port}")),
    ] {
        let upgrade = Upgrade {
            origin: origin.clone(),
            ..Upgrade::ok(port)
        };
        assert_eq!(connect(port, upgrade).await.err(), Some(403), "{origin:?}");
    }
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_eleventh_guest_waits_for_someone_to_leave() {
    let (events, relay, port) = started(Limits::default()).await;
    let mut guests = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        guests.push(guest(port).await);
    }
    assert_eq!(connect(port, Upgrade::ok(port)).await.err(), Some(503));
    let first = events.opened(0).await;
    let mut leaving = guests.remove(0);
    leaving.close(None).await.unwrap();
    assert_eq!(events.closed(&first).await, "closed");
    guests.push(guest(port).await);
    events.opened(MAX_CONNECTIONS).await;
    relay.stop("stopped").await;
}

// ─── Frames ─────────────────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_over_the_limit_or_a_binary_one_closes_the_guest() {
    let (events, relay, port) = started(Limits::default()).await;

    let mut big = guest(port).await;
    let id = events.opened(0).await;
    let at_limit = "x".repeat(MAX_GUEST_TEXT);
    big.send(Message::text(at_limit.clone())).await.unwrap();
    let heard = events
        .wait(|all| {
            all.iter().find_map(|e| match e {
                HostEvent::CollabLanMessage { text, .. } => Some(text.len()),
                _ => None,
            })
        })
        .await;
    assert_eq!(heard, MAX_GUEST_TEXT, "exactly the limit gets through");
    let _ = big.send(Message::text(at_limit + "x")).await;
    assert_cut_off(&mut big, u16::from(CloseCode::Size), "too-large").await;
    assert_eq!(events.closed(&id).await, "too-large");
    assert_eq!(
        events.heard(&id).len(),
        1,
        "the oversized one never reached the page"
    );

    // Frames each under the limit that add up to a message over it.
    let mut pieces = guest(port).await;
    let id = events.opened(1).await;
    let piece = "y".repeat(MAX_GUEST_TEXT / 2);
    let frames = [
        Frame::message(piece.clone(), OpCode::Data(Data::Text), false),
        Frame::message(piece.clone(), OpCode::Data(Data::Continue), false),
        Frame::message(piece, OpCode::Data(Data::Continue), true),
    ];
    for frame in frames {
        if pieces.send(Message::Frame(frame)).await.is_err() {
            break;
        }
    }
    assert_cut_off(&mut pieces, u16::from(CloseCode::Size), "too-large").await;
    assert_eq!(events.closed(&id).await, "too-large");
    assert!(events.heard(&id).is_empty());

    let mut binary = guest(port).await;
    let id = events.opened(2).await;
    binary.send(Message::binary(vec![1, 2, 3])).await.unwrap();
    assert_eq!(
        close_of(&mut binary).await,
        (u16::from(CloseCode::Unsupported), "binary".to_string())
    );
    assert_eq!(events.closed(&id).await, "binary");

    assert!(relay.send("anyone", "y".repeat(MAX_TEXT + 1)).is_err());
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guest_that_stops_answering_pings_is_dropped() {
    let limits = Limits {
        ping_every: Duration::from_millis(50),
        pong_timeout: Duration::from_millis(300),
        ..Limits::default()
    };
    let (events, relay, port) = started(limits).await;
    // This one reads, so its client answers every ping.
    let mut awake = guest(port).await;
    let awake_id = events.opened(0).await;
    let reading = tokio::spawn(async move {
        while let Some(Ok(message)) = awake.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    });
    // This one never reads again, so its pongs never go.
    let _asleep = guest(port).await;
    let asleep_id = events.opened(1).await;
    assert_eq!(events.closed(&asleep_id).await, "timeout");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !events.all().iter().any(
            |e| matches!(e, HostEvent::CollabLanClose { conn_id, .. } if *conn_id == awake_id)
        ),
        "a guest that answers stays"
    );
    relay.stop("stopped").await;
    let _ = reading.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guest_too_slow_to_keep_up_is_closed_as_congested() {
    let limits = Limits {
        queue_bytes: 1024 * 1024,
        ..Limits::default()
    };
    let (events, relay, port) = started(limits).await;
    let _slow = guest(port).await;
    let id = events.opened(0).await;
    let chunk = "z".repeat(256 * 1024);
    // The socket's buffers take the first few megabytes; the queue then fills and the next send
    // finds no room.
    for _ in 0..1024 {
        relay.send(&id, chunk.clone()).unwrap();
        if lock(&events.list)
            .iter()
            .any(|e| matches!(e, HostEvent::CollabLanClose { .. }))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(events.closed(&id).await, "congested");
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_page_may_still_send_a_guest_a_whole_diagram() {
    let (events, relay, port) = started(Limits::default()).await;
    let mut guest = guest(port).await;
    let id = events.opened(0).await;
    let snapshot = "s".repeat(MAX_TEXT);
    relay.send(&id, snapshot.clone()).unwrap();
    assert_eq!(next(&mut guest).await, Some(Message::text(snapshot)));
    relay.stop("stopped").await;
}

#[test]
fn the_guest_message_cap_is_the_pages_own() {
    const PROTOCOL_TS: &str = include_str!("../../../src/collab/protocol.ts");
    let line = PROTOCOL_TS
        .lines()
        .find_map(|line| line.strip_prefix("export const MAX_GUEST_MESSAGE_BYTES = "))
        .expect("MAX_GUEST_MESSAGE_BYTES in src/collab/protocol.ts");
    let bytes: usize = line
        .trim_end_matches(';')
        .split('*')
        .map(|factor| factor.trim().parse::<usize>().expect("a number"))
        .product();
    assert_eq!(bytes, MAX_GUEST_TEXT);
}

// ─── What a guest may send ──────────────────────────────────────────────────────────────────────

#[test]
fn a_bucket_spends_its_burst_then_refills_at_its_rate_up_to_the_burst() {
    let start = Instant::now();
    let rate = Rate {
        per_second: 10,
        burst: 30,
    };
    let mut bucket = Bucket::new(rate, start);
    assert!(bucket.take(30, start), "the whole burst at once");
    assert!(!bucket.take(1, start));
    let half = start + Duration::from_millis(500);
    assert!(!bucket.take(6, half), "half a second is five more, not six");
    assert!(bucket.take(5, half));
    // A long quiet spell fills it to the burst and no further.
    let later = half + Duration::from_secs(60);
    assert!(!bucket.take(31, later));
    assert!(bucket.take(30, later));
    // Time going backwards adds nothing.
    assert!(!bucket.take(1, start));

    let limits = Limits::default();
    let mut budget = Budget::new(&limits, start);
    assert!(budget.admit(MAX_GUEST_TEXT, start));
    assert!(
        budget.admit(MAX_GUEST_TEXT, start),
        "two of the largest at once"
    );
    assert!(!budget.admit(1, start), "but not a third byte");
    let mut budget = Budget::new(&limits, start);
    for _ in 0..limits.inbound_messages.burst {
        assert!(budget.admit(0, start));
    }
    assert!(
        !budget.admit(0, start),
        "an empty message is still a message"
    );
}

/// Sends until the guest's socket refuses (the relay closed it), returning how many went.
async fn flood(guest: &mut Guest, message: impl Fn() -> Message, count: usize) -> usize {
    for sent in 0..count {
        if guest.send(message()).await.is_err() {
            return sent;
        }
    }
    count
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guest_sending_past_its_budget_is_closed_as_rate() {
    let (events, relay, port) = started(Limits::default()).await;
    let burst = usize::try_from(Limits::default().inbound_messages.burst).unwrap();

    // Messages: the burst goes through, a stream doesn't.
    let mut chatty = guest(port).await;
    let id = events.opened(0).await;
    flood(&mut chatty, || Message::text("{}"), 4 * burst).await;
    assert_cut_off(&mut chatty, 1008, "rate").await;
    assert_eq!(events.closed(&id).await, "rate");
    let heard = events.heard(&id).len();
    assert!((burst..2 * burst).contains(&heard), "heard {heard}");

    // Pings count as messages, though the page never sees them.
    let mut pinging = guest(port).await;
    let id = events.opened(1).await;
    flood(&mut pinging, || Message::Ping(Vec::new().into()), 4 * burst).await;
    assert_cut_off(&mut pinging, 1008, "rate").await;
    assert_eq!(events.closed(&id).await, "rate");

    // Bytes: two of the largest messages back to back, then not a third.
    let mut bulky = guest(port).await;
    let id = events.opened(2).await;
    let largest = "b".repeat(MAX_GUEST_TEXT);
    flood(&mut bulky, || Message::text(largest.clone()), 3).await;
    assert_cut_off(&mut bulky, 1008, "rate").await;
    assert_eq!(events.closed(&id).await, "rate");
    assert_eq!(events.heard(&id).len(), 2);

    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn traffic_within_the_budget_reaches_the_page() {
    let (events, relay, port) = started(Limits::default()).await;
    let mut busy = guest(port).await;
    let id = events.opened(0).await;
    // Most of both bursts: a large paste, a smaller one, and a flurry of edits and pings.
    busy.send(Message::text("p".repeat(MAX_GUEST_TEXT)))
        .await
        .unwrap();
    busy.send(Message::text("q".repeat(3 * 1024 * 1024)))
        .await
        .unwrap();
    for n in 0..150 {
        busy.send(Message::text(format!("{{\"n\":{n}}}")))
            .await
            .unwrap();
    }
    for _ in 0..50 {
        busy.send(Message::Ping(Vec::new().into())).await.unwrap();
    }
    events.heard_at_least(&id, 152).await;
    busy.send(Message::text("last")).await.unwrap();
    events.heard_at_least(&id, 153).await;
    assert!(!events.is_closed(&id));
    relay.stop("stopped").await;

    // A guest that keeps to the rate may go on sending past the burst.
    let limits = Limits {
        inbound_messages: Rate {
            per_second: 50,
            burst: 20,
        },
        ..Limits::default()
    };
    let (events, relay, port) = started(limits).await;
    let mut steady = guest(port).await;
    let id = events.opened(0).await;
    for round in 1..=3 {
        for _ in 0..20 {
            steady.send(Message::text("tick")).await.unwrap();
        }
        events.heard_at_least(&id, 20 * round).await;
        // Refills at least 30, so the whole burst again.
        tokio::time::sleep(Duration::from_millis(600)).await;
    }
    assert!(!events.is_closed(&id));
    flood(&mut steady, || Message::text("tick"), 200).await;
    assert_cut_off(&mut steady, 1008, "rate").await;
    relay.stop("stopped").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_from_a_guest_reaches_the_page_after_the_page_closes_it() {
    let limits = Limits {
        queue_bytes: 256 * 1024 * 1024,
        ..Limits::default()
    };
    let (events, relay, port) = started(limits).await;
    let mut guest = guest(port).await;
    let id = events.opened(0).await;
    // More than the sockets' buffers hold, to a guest not reading: the close waits behind it.
    let chunk = "c".repeat(1024 * 1024);
    let chunks = 48;
    for _ in 0..chunks {
        relay.send(&id, chunk.clone()).unwrap();
    }
    guest.send(Message::text("early")).await.unwrap();
    events.heard_at_least(&id, 1).await;

    relay.close(&id, "bye");
    for _ in 0..10 {
        guest.send(Message::text("late")).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !events.is_closed(&id),
        "still open, sending what was queued before the close"
    );
    assert_eq!(events.heard(&id), ["early"]);

    // Everything queued before the close still arrives, then the close.
    for _ in 0..chunks {
        assert_eq!(next(&mut guest).await, Some(Message::text(chunk.clone())));
    }
    assert_eq!(close_of(&mut guest).await, (1000, "bye".to_string()));
    assert_eq!(events.closed(&id).await, "bye");
    assert_eq!(events.heard(&id), ["early"]);
    relay.stop("stopped").await;
}

// ─── Starting and stopping ──────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn starting_twice_is_the_same_server_and_stopping_twice_says_so_once() {
    let (events, relay) = relay_with(Limits::default());
    let first = relay.start_on(TOKEN, LOOPBACK).await.unwrap();
    let again = relay.start_on(TOKEN, LOOPBACK).await.unwrap();
    assert_eq!(first.port, again.port);
    for address in &first.addresses {
        let ip: IpAddr = address.parse().unwrap();
        assert!(!ip.is_loopback() && !ip.is_unspecified(), "{ip}");
    }

    relay.stop("stopped").await;
    relay.stop("stopped").await;
    let stopped: Vec<_> = events
        .all()
        .into_iter()
        .filter(|e| matches!(e, HostEvent::CollabLanStopped { .. }))
        .collect();
    assert_eq!(
        stopped,
        vec![HostEvent::CollabLanStopped {
            reason: "stopped".into()
        }]
    );
    assert!(
        TcpStream::connect(("127.0.0.1", first.port)).await.is_err(),
        "nothing listens once stopped"
    );

    let restarted = relay.start_on(TOKEN, LOOPBACK).await.unwrap();
    assert_eq!(get(restarted.port, "/").await.status, 200);
    relay.stop("stopped").await;
    // Sends and closes after a stop are quietly nothing.
    relay.send("gone", "late".into()).unwrap();
    relay.close("gone", "late");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_token_never_starts_a_server() {
    let (_, relay) = relay_with(Limits::default());
    for token in [
        "",
        "0123",
        &TOKEN.to_uppercase(),
        &format!("{TOKEN}0"),
        "g123456789abcdef0123456789abcdef",
    ] {
        assert!(relay.start_on(token, LOOPBACK).await.is_err(), "{token}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_closes_every_guest_before_saying_the_server_stopped() {
    let (events, relay, port) = started(Limits::default()).await;
    let mut a = guest(port).await;
    let mut b = guest(port).await;
    let a_id = events.opened(0).await;
    let b_id = events.opened(1).await;
    relay.stop("window-closed").await;
    assert_eq!(close_of(&mut a).await, (1001, "server-stopped".to_string()));
    assert_eq!(close_of(&mut b).await, (1001, "server-stopped".to_string()));
    let all = events.all();
    let position = |wanted: &dyn Fn(&HostEvent) -> bool| all.iter().position(wanted).unwrap();
    let stopped = position(&|e| {
        *e == HostEvent::CollabLanStopped {
            reason: "window-closed".into(),
        }
    });
    for id in [&a_id, &b_id] {
        let closed = position(
            &|e| matches!(e, HostEvent::CollabLanClose { conn_id, reason } if conn_id == id && reason == "server-stopped"),
        );
        assert!(closed < stopped);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_token_sends_the_old_sessions_guests_away_and_keeps_the_port() {
    let (events, relay, port) = started(Limits::default()).await;
    let mut old = guest(port).await;
    let old_id = events.opened(0).await;
    let again = relay.start_on(OTHER_TOKEN, LOOPBACK).await.unwrap();
    assert_eq!(again.port, port);
    assert_eq!(
        close_of(&mut old).await,
        (1008, "token-changed".to_string())
    );
    assert_eq!(events.closed(&old_id).await, "token-changed");
    assert_eq!(connect(port, Upgrade::ok(port)).await.err(), Some(401));
    let upgrade = Upgrade {
        protocols: Some("draft-canvas.collab.v1, fedcba9876543210fedcba9876543210"),
        ..Upgrade::ok(port)
    };
    assert!(connect(port, upgrade).await.is_ok());
    relay.stop("stopped").await;
}

// ─── Names and addresses ────────────────────────────────────────────────────────────────────────

#[test]
fn a_host_is_an_address_or_localhost_with_this_port() {
    use super::net::{canonical_host, same_origin};
    assert_eq!(
        canonical_host("192.168.1.20:5000", 5000).as_deref(),
        Some("192.168.1.20:5000")
    );
    assert_eq!(
        canonical_host("LOCALHOST:5000", 5000).as_deref(),
        Some("localhost:5000")
    );
    assert_eq!(
        canonical_host("[FD00:0:0::1]:5000", 5000).as_deref(),
        Some("[fd00::1]:5000")
    );
    for bad in [
        "192.168.1.20",
        "192.168.1.20:5001",
        "192.168.1.20:+5000",
        "192.168.01.20:5000",
        "example.com:5000",
        "[fe80::1%25en0]:5000",
        "fd00::1:5000",
        "192.168.1.20:5000/x",
        "",
    ] {
        assert_eq!(canonical_host(bad, 5000), None, "{bad}");
    }
    assert!(same_origin(
        "http://192.168.1.20:5000",
        "192.168.1.20:5000",
        5000
    ));
    assert!(same_origin("HTTP://[fd00::1]:5000", "[fd00::1]:5000", 5000));
    assert!(!same_origin(
        "https://192.168.1.20:5000",
        "192.168.1.20:5000",
        5000
    ));
    assert!(!same_origin(
        "http://localhost:5000",
        "192.168.1.20:5000",
        5000
    ));
    assert!(!same_origin("null", "192.168.1.20:5000", 5000));
}

#[test]
fn addresses_put_the_home_network_first_and_leave_out_what_no_guest_can_open() {
    let found = [
        ("lo0", "127.0.0.1"),
        ("lo0", "::1"),
        ("utun3", "100.101.1.2"),
        ("en0", "fe80::1"),
        ("en0", "2001:db8::5"),
        ("en0", "fd12::5"),
        ("bridge100", "192.168.64.1"),
        ("en0", "169.254.3.3"),
        ("en0", "192.168.1.20"),
        ("en1", "192.168.1.20"),
        ("en5", "100.70.0.1"),
        ("en0", "::ffff:192.168.1.20"),
        // Public: reachable from the internet, so never offered (and refused by `local_peer`).
        ("en0", "203.0.113.9"),
    ];
    let parsed: Vec<(&str, IpAddr)> = found
        .iter()
        .map(|(name, ip)| (*name, ip.parse().unwrap()))
        .collect();
    let ranked = |ipv6| {
        net::rank(parsed.iter().map(|(n, ip)| (*n, *ip)), ipv6)
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ranked(true),
        [
            "192.168.1.20",
            "100.70.0.1",
            "fd12::5",
            "192.168.64.1",
            "100.101.1.2"
        ]
    );
    assert_eq!(
        ranked(false),
        ["192.168.1.20", "100.70.0.1", "192.168.64.1", "100.101.1.2"]
    );
}

#[test]
fn only_local_network_peers_are_served() {
    for local in [
        "127.0.0.1",
        "192.168.1.30",
        "10.0.0.4",
        "172.16.9.9",
        "169.254.3.3",
        "100.70.0.1",
        "::1",
        "fd12::7",
        "fe80::1",
        "::ffff:192.168.1.30",
    ] {
        assert!(net::local_peer(local.parse().unwrap()), "{local} is local");
    }
    for remote in [
        "8.8.8.8",
        "203.0.113.9",
        "2001:db8::5",
        "2606:4700::1111",
        "::ffff:8.8.8.8",
    ] {
        assert!(
            !net::local_peer(remote.parse().unwrap()),
            "{remote} is not local"
        );
    }
}

#[test]
fn content_types_follow_the_extension() {
    assert_eq!(
        assets::content_type("/a.MJS"),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(assets::content_type("/a.woff2"), "font/woff2");
    assert_eq!(
        assets::content_type("/THIRD_PARTY_LICENSES.txt"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(
        assets::content_type("/noextension"),
        "application/octet-stream"
    );
    assert_eq!(assets::cache_control("/favicon.svg"), "no-cache");
}
