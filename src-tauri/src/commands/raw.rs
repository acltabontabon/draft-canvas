//! Commands that carry a document take it as a raw binary body, with their small arguments in an
//! `x-meta` header, because passing megabytes through JSON would copy and re-encode every save.
//! The page sends `invoke(cmd, bytes, { headers: { "x-meta": encodeURIComponent(JSON.stringify(meta)) } })`.

use crate::errors::{AppError, ErrorKind};
use serde::de::DeserializeOwned;
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};

/// A document tops out at 24 MiB; this is the ceiling on what is even looked at.
pub const MAX_BODY_BYTES: usize = 25 * 1024 * 1024;
const META_HEADER: &str = "x-meta";

/// The arguments from the `x-meta` header and the raw bytes of the body.
pub fn raw_request<'a, M: DeserializeOwned>(
    request: &'a Request<'_>,
) -> Result<(M, &'a [u8]), AppError> {
    parse_raw(request.body(), request.headers())
}

/// `raw_request` without the Tauri wrapper, so the parsing can be tested on its own.
pub fn parse_raw<'a, M: DeserializeOwned>(
    body: &'a InvokeBody,
    headers: &HeaderMap,
) -> Result<(M, &'a [u8]), AppError> {
    let InvokeBody::Raw(bytes) = body else {
        return Err(AppError::bad_request("expected a binary body"));
    };
    if bytes.len() > MAX_BODY_BYTES {
        return Err(AppError::new(
            ErrorKind::TooLarge,
            format!(
                "That is too large for Draft Canvas to handle (the limit is {} MB).",
                MAX_BODY_BYTES / (1024 * 1024)
            ),
        ));
    }
    let meta = headers
        .get(META_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::bad_request("missing x-meta"))?;
    let json = percent_decode(meta)
        .ok_or_else(|| AppError::bad_request("x-meta isn't encoded properly"))?;
    let meta = serde_json::from_str(&json)
        .map_err(|_| AppError::bad_request("x-meta isn't the expected shape"))?;
    Ok((meta, bytes))
}

/// The inverse of `encodeURIComponent`: `%XX` escapes are bytes of UTF-8, everything else (including
/// `+`, which that function never produces for a space) is taken literally.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            // `from_str_radix` would also accept a sign, which is not a valid escape.
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;
    use tauri::http::HeaderValue;

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Meta {
        handle: String,
        expected_stamp: Option<String>,
    }

    /// What the page's `encodeURIComponent(JSON.stringify(meta))` produces.
    fn encoded(value: serde_json::Value) -> String {
        let mut out = String::new();
        for b in value.to_string().bytes() {
            match b {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'!'
                | b'~'
                | b'*'
                | b'\''
                | b'('
                | b')' => out.push(b as char),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    fn headers(value: &str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(META_HEADER, HeaderValue::from_str(value).unwrap());
        map
    }

    #[test]
    fn decodes_what_encode_uri_component_makes() {
        let header = encoded(json!({"handle": "h_1", "expectedStamp": "v1:12:3:abc"}));
        assert!(
            header.starts_with("%7B%22") && header.contains("%22handle%22%3A%22h_1%22"),
            "{header}"
        );
        let body = InvokeBody::Raw(b"{\"doc\":1}".to_vec());
        let (meta, bytes): (Meta, _) = parse_raw(&body, &headers(&header)).unwrap();
        assert_eq!(
            meta,
            Meta {
                handle: "h_1".into(),
                expected_stamp: Some("v1:12:3:abc".into())
            }
        );
        assert_eq!(bytes, b"{\"doc\":1}");
    }

    #[test]
    fn non_ascii_and_reserved_characters_survive() {
        let header =
            encoded(json!({"handle": "h \u{2014} caf\u{e9} & 100% +1", "expectedStamp": null}));
        let body = InvokeBody::Raw(Vec::new());
        let (meta, _): (Meta, _) = parse_raw(&body, &headers(&header)).unwrap();
        assert_eq!(meta.handle, "h \u{2014} caf\u{e9} & 100% +1");
        assert_eq!(meta.expected_stamp, None);
    }

    #[test]
    fn the_header_name_is_case_insensitive() {
        let mut map = HeaderMap::new();
        map.insert(
            "X-Meta",
            HeaderValue::from_str(&encoded(json!({"handle": "h"}))).unwrap(),
        );
        let body = InvokeBody::Raw(vec![1, 2, 3]);
        let (meta, bytes): (Meta, _) = parse_raw(&body, &map).unwrap();
        assert_eq!(meta.handle, "h");
        assert_eq!(bytes, [1, 2, 3]);
    }

    #[test]
    fn the_body_is_returned_untouched() {
        let raw: Vec<u8> = (0..=255).collect();
        let body = InvokeBody::Raw(raw.clone());
        let (_, bytes): (Meta, _) =
            parse_raw(&body, &headers(&encoded(json!({"handle": "h"})))).unwrap();
        assert_eq!(bytes, raw.as_slice());
    }

    #[test]
    fn a_json_body_is_refused() {
        let body = InvokeBody::Json(json!({"handle": "h"}));
        let err = parse_raw::<Meta>(&body, &headers(&encoded(json!({"handle": "h"}))))
            .err()
            .unwrap();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("binary body"));
    }

    #[test]
    fn a_missing_header_is_refused() {
        let body = InvokeBody::Raw(vec![0]);
        let err = parse_raw::<Meta>(&body, &HeaderMap::new()).err().unwrap();
        assert!(err.message.contains("missing x-meta"));
    }

    #[test]
    fn bad_encoding_or_bad_json_is_refused() {
        let body = InvokeBody::Raw(vec![0]);
        for bad in [
            "%zz",
            "%7B%22handle",
            "%E2%80",
            "not json",
            "%5B%5D",
            "%7B%7D",
        ] {
            assert!(parse_raw::<Meta>(&body, &headers(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_body_over_25_megabytes_is_too_large() {
        let header = encoded(json!({"handle": "h"}));
        let at_limit = InvokeBody::Raw(vec![0; MAX_BODY_BYTES]);
        assert!(parse_raw::<Meta>(&at_limit, &headers(&header)).is_ok());
        let over = InvokeBody::Raw(vec![0; MAX_BODY_BYTES + 1]);
        let err = parse_raw::<Meta>(&over, &headers(&header)).err().unwrap();
        assert_eq!(err.kind, ErrorKind::TooLarge);
        assert!(err.message.contains("25 MB"));
    }

    #[test]
    fn percent_decoding_edge_cases() {
        assert_eq!(percent_decode("a%20b").as_deref(), Some("a b"));
        assert_eq!(percent_decode("%E2%80%94").as_deref(), Some("\u{2014}"));
        assert_eq!(percent_decode("plain+text").as_deref(), Some("plain+text"));
        assert_eq!(percent_decode("").as_deref(), Some(""));
        assert_eq!(percent_decode("%"), None);
        assert_eq!(percent_decode("%2"), None);
        assert_eq!(percent_decode("%GG"), None);
        assert_eq!(percent_decode("%+1"), None);
        assert_eq!(percent_decode("%FF"), None, "a lone 0xFF is not UTF-8");
    }
}
