//! The network side: the sockets the server listens on, the addresses a guest can reach it at, and
//! which `Host` a request may name.

use super::Bind;
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};

const BACKLOG: i32 = 64;

/// One listener for IPv4 on a port the OS picks, and one for IPv6 on the same port where the
/// system has IPv6. The IPv6 socket is IPv6-only: otherwise Linux would map IPv4 onto it too and
/// the second bind would fail.
pub fn bind(bind: Bind) -> std::io::Result<(Vec<TcpListener>, u16)> {
    let v4 = listen(SocketAddr::new(IpAddr::V4(bind.v4), 0))?;
    let port = v4.local_addr()?.port();
    let mut listeners = vec![v4];
    if let Some(v6) = bind.v6 {
        if let Ok(listener) = listen(SocketAddr::new(IpAddr::V6(v6), port)) {
            listeners.push(listener);
        }
    }
    Ok((listeners, port))
}

fn listen(address: SocketAddr) -> std::io::Result<TcpListener> {
    let socket = Socket::new(
        Domain::for_address(address),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    if address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    // No SO_REUSEADDR: on Windows it would let another program bind the same port over ours. Nor is
    // leaving it off enough there: a program that sets it on its own socket can still take the port,
    // and hear the guests meant for this one, unless this socket holds it exclusively.
    #[cfg(windows)]
    exclusive(&socket)?;
    socket.set_nonblocking(true)?;
    socket.bind(&address.into())?;
    socket.listen(BACKLOG)?;
    Ok(socket.into())
}

#[cfg(windows)]
fn exclusive(socket: &Socket) -> std::io::Result<()> {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{
        setsockopt, SOCKET, SOCKET_ERROR, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
    };
    let on: i32 = 1;
    // SAFETY: the socket is open for the whole call, and the option points at an `i32` of the
    // length given, which outlives it.
    let result = unsafe {
        setsockopt(
            socket.as_raw_socket() as SOCKET,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&on as *const i32).cast(),
            std::mem::size_of::<i32>() as i32,
        )
    };
    if result == SOCKET_ERROR {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Every address of this machine a guest on the same network could open, best first.
pub fn lan_addresses(ipv6: bool) -> Vec<IpAddr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    rank(interfaces.iter().map(|i| (i.name.as_str(), i.ip())), ipv6)
}

/// Orders addresses by how likely a guest beside the owner is to reach them: a real network
/// interface before a VPN or virtual machine bridge, a private IPv4 address before anything else.
/// Loopback, link-local and multicast are left out, as is IPv6 when the server isn't listening on it.
pub(crate) fn rank<'a>(found: impl Iterator<Item = (&'a str, IpAddr)>, ipv6: bool) -> Vec<IpAddr> {
    let mut scored: Vec<((u8, u8), IpAddr)> = found
        .filter_map(|(name, ip)| Some((score(name, ip, ipv6)?, ip)))
        .collect();
    scored.sort();
    let mut seen = HashSet::new();
    scored
        .into_iter()
        .filter(|(_, ip)| seen.insert(*ip))
        .map(|(_, ip)| ip)
        .collect()
}

fn score(interface: &str, ip: IpAddr, ipv6: bool) -> Option<(u8, u8)> {
    let address = match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
            {
                return None;
            }
            if v4.is_private() {
                0
            } else if is_shared_v4(v4) {
                2
            } else {
                // A public address: guests reaching it would come from the internet, and
                // `local_peer` turns those away — so it is not offered either.
                return None;
            }
        }
        IpAddr::V6(v6) => {
            if !ipv6
                || v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || is_link_local_v6(v6)
                || v6.to_ipv4_mapped().is_some()
            {
                return None;
            }
            if is_unique_local_v6(v6) {
                3
            } else {
                // Global IPv6 is reachable from anywhere, with no NAT in front of it.
                return None;
            }
        }
    };
    Some((u8::from(is_virtual(interface)), address))
}

/// Whether a connection comes from the local network (or a VPN overlay such as Tailscale) rather
/// than the internet. The server listens on every interface so any LAN address works, but a machine
/// with a public or global IPv6 address would otherwise be serving the diagram to the world:
/// anything else is closed before a byte is read.
pub fn local_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || is_shared_v4(v4)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => local_peer(IpAddr::V4(v4)),
            // Not fe80::/10: a browser can't be given the zone to open one, so only a hand-written
            // client arrives from there — and it can make up any number of such addresses to get
            // round every per-address limit.
            None => v6.is_loopback() || is_unique_local_v6(v6),
        },
    }
}

/// 100.64.0.0/10, carrier-grade NAT and the range VPNs such as Tailscale hand out.
fn is_shared_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..128).contains(&b)
}

/// fe80::/10. Opening one needs a zone (`%en0`) that a guest's browser can't be given.
fn is_link_local_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80
}

/// fc00::/7.
fn is_unique_local_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

/// VPN tunnels, virtual machine and container bridges, Apple's peer-to-peer links. macOS and Linux
/// name interfaces by kind; Windows gives adapters descriptive names.
fn is_virtual(interface: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "utun",
        "tun",
        "tap",
        "awdl",
        "llw",
        "bridge",
        "docker",
        "br-",
        "veth",
        "vmnet",
        "vboxnet",
        "virbr",
        "zt",
        "tailscale",
        "wg",
        "anpi",
        "gif",
        "stf",
        "ipsec",
        "ppp",
    ];
    const WORDS: &[&str] = &[
        "virtual",
        "vmware",
        "virtualbox",
        "hyper-v",
        "vethernet",
        "wsl",
        "vpn",
        "tailscale",
        "zerotier",
        "wireguard",
    ];
    let name = interface.to_ascii_lowercase();
    PREFIXES.iter().any(|p| name.starts_with(p)) || WORDS.iter().any(|w| name.contains(w))
}

/// The `Host` (or an origin's authority) a request named, if it names this server: an IP address or
/// `localhost`, with this server's port. Anything else is refused, so a web page on some other
/// name that happens to resolve here (DNS rebinding) is never served. Returns the canonical
/// spelling, which is what a browser puts in `Origin`.
pub fn canonical_host(value: &str, port: u16) -> Option<String> {
    let (host, given_port) = if let Some(rest) = value.strip_prefix('[') {
        let (inside, after) = rest.split_once(']')?;
        let ip: Ipv6Addr = inside.parse().ok()?;
        (format!("[{ip}]"), after.strip_prefix(':')?)
    } else {
        let (name, given_port) = value.rsplit_once(':')?;
        let host = if name.eq_ignore_ascii_case("localhost") {
            "localhost".to_string()
        } else {
            name.parse::<Ipv4Addr>().ok()?.to_string()
        };
        (host, given_port)
    };
    if given_port.is_empty() || !given_port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    (given_port.parse::<u16>().ok()? == port).then(|| format!("{host}:{port}"))
}

/// Whether `origin` is the page this server serves at `host` (already canonical).
pub fn same_origin(origin: &str, host: &str, port: u16) -> bool {
    let Some(authority) = origin
        .get(..7)
        .filter(|scheme| scheme.eq_ignore_ascii_case("http://"))
        .and_then(|_| origin.get(7..))
    else {
        return false;
    };
    canonical_host(authority, port).as_deref() == Some(host)
}
