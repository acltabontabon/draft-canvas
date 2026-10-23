//! The HTTP side: accepting connections, serving files, and the checks a WebSocket upgrade passes
//! before it is accepted.

use super::{assets, net, socket, Shared, MAX_GUEST_TEXT, PROTOCOL, SOCKET_PATH};
use axum::body::Body;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Extension;
use axum::Router;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

/// Plain HTTP connections at once (a browser opens several to load the app). Upgraded WebSockets
/// leave this count and are bound by `MAX_CONNECTIONS` instead.
pub(super) const MAX_HTTP_CONNECTIONS: usize = 64;
/// Of those, from one address: a browser loading the app opens about six. One machine on the network
/// can't take every place and keep the people the link was sent to from loading the page.
pub(super) const MAX_HTTP_CONNECTIONS_PER_PEER: usize = 16;
/// A request whose headers haven't arrived by now is dropped, so idle sockets can't pile up.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// The longest a plain HTTP connection lives. Only the header has its own timeout; a client that asks
/// for the largest file and never reads the reply would otherwise hold its place for good, and a few
/// such connections keep everyone else from loading the app or reconnecting. A browser just opens
/// another connection. An upgrade to a WebSocket finishes the connection's own future, so a socket is
/// never cut by this.
const HTTP_CONNECTION_LIFETIME: Duration = Duration::from_secs(30);
/// How long a newcomer waits for the connection closed to make room for it to let go of its place.
const EVICTION_WAIT: Duration = Duration::from_millis(200);
/// After a failed accept (out of file descriptors, say), a pause instead of a hot loop.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// Accepts connections until the server stops. Dropping the set of connections on the way out ends
/// every plain HTTP one with it; WebSockets watch the same signal and close themselves.
pub(super) async fn serve(listener: TcpListener, shared: Arc<Shared>) {
    let router = router(shared.clone());
    let mut shutdown = shared.shutdown.subscribe();
    let mut connections = JoinSet::new();
    // Each connection holds a clone of its address's marker, so the count is the clones beyond ours.
    let mut peers: HashMap<IpAddr, Arc<()>> = HashMap::new();
    loop {
        tokio::select! {
            () = socket::stopped(&mut shutdown) => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else {
                    tokio::time::sleep(ACCEPT_BACKOFF).await;
                    continue;
                };
                // Local network only: see `net::local_peer`.
                if !net::local_peer(peer.ip()) {
                    drop(stream);
                    continue;
                }
                while connections.try_join_next().is_some() {}
                peers.retain(|_, held| Arc::strong_count(held) > 1);
                let held = peers.entry(peer.ip()).or_default();
                if Arc::strong_count(held) > MAX_HTTP_CONNECTIONS_PER_PEER {
                    continue;
                }
                let permit = match shared.http_connections.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    // Full: room is made by closing the oldest of whoever holds the most, never
                    // by turning away someone who holds fewer.
                    Err(_) if shared.evict_for(peer.ip()) => {
                        match tokio::time::timeout(EVICTION_WAIT, shared.http_connections.clone().acquire_owned()).await {
                            Ok(Ok(permit)) => permit,
                            _ => continue,
                        }
                    }
                    Err(_) => continue,
                };
                let held = held.clone();
                // Who is asking, for the guest-places-per-address limit at the upgrade.
                let router = router.clone().layer(Extension(Peer(peer.ip())));
                let id = shared.next_http_id();
                let address = peer.ip();
                let tracked = shared.clone();
                let handle = connections.spawn(async move {
                    let _held = held;
                    let _permit = permit;
                    let _tracked = Untrack(tracked, address, id);
                    serve_connection(stream, router).await;
                });
                shared.track_http(address, id, handle);
            }
        }
    }
}

/// Takes a connection off `Shared::http_open` when it ends, however it ends (closed, aborted).
struct Untrack(Arc<Shared>, IpAddr, u64);

impl Drop for Untrack {
    fn drop(&mut self) {
        self.0.untrack_http(self.1, self.2);
    }
}

async fn serve_connection(stream: TcpStream, router: Router) {
    let _ = stream.set_nodelay(true);
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .max_buf_size(MAX_HEADER_BYTES);
    let connection = builder
        .serve_connection(TokioIo::new(stream), TowerToHyperService::new(router))
        .with_upgrades();
    let _ = tokio::time::timeout(HTTP_CONNECTION_LIFETIME, connection).await;
}

pub(super) fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route(SOCKET_PATH, any(upgrade))
        .fallback(file)
        .with_state(shared)
}

/// The web build's production policy (`vite.config.ts`), with the one socket a guest's page talks to.
pub(super) fn content_security_policy(host: Option<&str>) -> String {
    let connect = match host {
        Some(host) => format!("connect-src 'self' ws://{host}"),
        None => "connect-src 'self'".to_string(),
    };
    [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        &connect,
        "form-action 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        // Never inside another page's frame, which could lay its own buttons over the guest's.
        "frame-ancestors 'none'",
    ]
    .join("; ")
}

/// Every response carries the policy and the two headers that keep a guest's browser from guessing
/// at content or telling other sites where it came from. Never `Cross-Origin-Opener-Policy`.
fn secure(mut response: Response, host: Option<&str>) -> Response {
    let headers = response.headers_mut();
    if let Ok(policy) = HeaderValue::from_str(&content_security_policy(host)) {
        headers.insert(header::CONTENT_SECURITY_POLICY, policy);
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

fn plain(status: StatusCode, text: &'static str, host: Option<&str>) -> Response {
    let mut response = (status, text).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    secure(response, host)
}

fn host_of(headers: &HeaderMap, port: u16) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    net::canonical_host(host, port)
}

async fn file(
    State(shared): State<Arc<Shared>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(host) = host_of(&headers, shared.port) else {
        return plain(StatusCode::BAD_REQUEST, "Unknown host", None);
    };
    let host = Some(host.as_str());
    if method != Method::GET && method != Method::HEAD {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed", host);
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let Some(key) = assets::key(uri.path()) else {
        return plain(StatusCode::NOT_FOUND, "Not found", host);
    };
    let Some(bytes) = shared.assets.get(&key) else {
        return plain(StatusCode::NOT_FOUND, "Not found", host);
    };
    let length = bytes.len();
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(assets::content_type(&key)),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(assets::cache_control(&key)),
    );
    secure(response, host)
}

/// The subprotocols a guest offered (one header or several), trimmed.
fn offered_protocols(headers: &HeaderMap) -> impl Iterator<Item = &[u8]> {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .flat_map(|value| value.as_bytes().split(|&b| b == b','))
        .map(<[u8]>::trim_ascii)
}

/// Whether the guest asked for this protocol. The session's token is not offered here: a header
/// crosses the network in clear, and anyone on it could read the token off a guest's upgrade. The
/// guest proves it after the upgrade instead, answering a challenge (`socket::run`).
fn offers_protocol(headers: &HeaderMap) -> bool {
    offered_protocols(headers).any(|offered| offered == PROTOCOL.as_bytes())
}

/// The address a connection came from.
#[derive(Clone, Copy)]
struct Peer(IpAddr);

/// Checked in order, cheapest first, and all before the upgrade is accepted: the server's own
/// name, a page this server served, the protocol, a well-formed upgrade, a place to answer the
/// challenge in. The token, and a guest place, come after (`socket::run`).
async fn upgrade(
    State(shared): State<Arc<Shared>>,
    Extension(Peer(address)): Extension<Peer>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Some(host) = host_of(&headers, shared.port) else {
        return plain(StatusCode::BAD_REQUEST, "Unknown host", None);
    };
    let same_origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| net::same_origin(origin, &host, shared.port));
    let host = Some(host.as_str());
    if !same_origin {
        return plain(StatusCode::FORBIDDEN, "Forbidden", host);
    }
    // Read before the token is proved: a token change in between leaves this request in the old session.
    let session = shared.session();
    if !offers_protocol(&headers) {
        return plain(StatusCode::UNAUTHORIZED, "Unauthorized", host);
    }
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return secure(rejection.into_response(), host),
    };
    if shared.stopping() {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "Stopping", host);
    }
    let Some(proving) = shared.reserve_proving(address) else {
        return plain(StatusCode::SERVICE_UNAVAILABLE, "Too many guests", host);
    };
    // A failed upgrade drops the callback, and the place with it. Both limits bound only what the
    // guest sends, checked as each frame's header arrives and as fragments add up, before the rest
    // is buffered. The page's sends to the guest are bounded by `MAX_TEXT` in `Relay::send` instead.
    let response = upgrade
        .protocols([PROTOCOL])
        .max_message_size(MAX_GUEST_TEXT)
        .max_frame_size(MAX_GUEST_TEXT)
        .on_upgrade(move |ws| socket::run(ws, shared, proving, session, address));
    secure(response, host)
}
