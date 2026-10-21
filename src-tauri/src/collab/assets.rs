//! The app's own files, as a guest's browser asks for them. Only a file the app was built with is
//! ever served, found by its exact name: no directory listings, no "nearest match", nothing outside
//! the bundle.

use std::collections::HashSet;
use tauri::AppHandle;

/// Longer request paths are refused before they are looked at.
const MAX_PATH: usize = 1024;

/// Where the files come from: the bundle in the app, or a fixed set in the tests.
pub trait AssetSource: Send + Sync + 'static {
    /// The file at `key` (`/index.html`, `/assets/index-1a2b.js`), exactly that one or nothing.
    fn get(&self, key: &str) -> Option<Vec<u8>>;
}

/// The same files the window loads, through Tauri's asset resolver.
pub struct Bundled {
    app: AppHandle,
    /// Every file in the bundle. The resolver answers an unknown path with `index.html` (the right
    /// thing for the window, the wrong one for a server), so a key is looked up here first. Empty in
    /// development, where the resolver reads the built `dist-desktop` folder instead of a bundle and
    /// has no such fallback.
    keys: Option<HashSet<String>>,
}

impl Bundled {
    pub fn new(app: &AppHandle) -> Self {
        let keys: HashSet<String> = app
            .asset_resolver()
            .iter()
            .map(|(key, _)| key.into_owned())
            .collect();
        Self {
            app: app.clone(),
            keys: (!keys.is_empty()).then_some(keys),
        }
    }
}

impl AssetSource for Bundled {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        if self.keys.as_ref().is_some_and(|keys| !keys.contains(key)) {
            return None;
        }
        self.app
            .asset_resolver()
            .get(key.to_string())
            .map(|asset| asset.bytes)
    }
}

/// The bundle key for a request path, or `None` for anything that isn't plainly a file's name:
/// `..` or `.` segments, empty segments, backslashes, drive letters, control characters, hidden
/// files, or escapes that don't decode to UTF-8. `/` is the app itself.
pub fn key(path: &str) -> Option<String> {
    if path.len() > MAX_PATH || !path.starts_with('/') {
        return None;
    }
    if path == "/" {
        return Some("/index.html".to_string());
    }
    let mut key = String::with_capacity(path.len());
    for segment in path[1..].split('/') {
        let segment = percent_decode(segment)?;
        let plain = !segment.is_empty()
            && !segment.starts_with('.')
            && !segment
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'));
        if !plain {
            return None;
        }
        key.push('/');
        key.push_str(&segment);
    }
    Some(key)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// What a file is, by its extension. Anything unknown is bytes, never sniffed (`nosniff` is set).
pub fn content_type(key: &str) -> &'static str {
    let extension = key
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// `index.html` is always asked for again, so a guest never runs a page older than the owner's app.
/// Vite names everything under `assets/` by its content, so those never change under one name.
pub fn cache_control(key: &str) -> &'static str {
    if key == "/index.html" {
        "no-store"
    } else if key.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}
