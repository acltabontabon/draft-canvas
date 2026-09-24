//! The real sidecar binary, driven by a real MCP client (rmcp), against a fake app on the bridge.
//! Unix only: the fake listens on a Unix socket as the app does on macOS.
#![cfg(unix)]

use rmcp::model::CallToolRequestParams;
use rmcp::transport::{ConfigureCommandExt, TokioChildProcess};
use rmcp::ServiceExt;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::process::Command;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn sidecar() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_draft-canvas-mcp"))
}

/// A stand-in for the app: authenticates the hello, then answers each call with `answer`.
fn fake_app(dir: &Path, answer: fn(&str, &Value) -> Value) -> tokio::task::JoinHandle<Vec<Value>> {
    let socket = dir.join("bridge.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    std::fs::write(
        dir.join("agent.json"),
        json!({"v": 1, "endpoint": socket, "token": TOKEN, "pid": 1}).to_string(),
    )
    .unwrap();
    tokio::spawn(async move {
        let mut seen = Vec::new();
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let frame: Value = serde_json::from_str(&line).unwrap();
            seen.push(frame.clone());
            let reply = match frame["type"].as_str() {
                Some("hello") if frame["token"] == TOKEN => {
                    json!({"type": "welcome", "bridge": 1, "app": "test"})
                }
                Some("hello") => {
                    json!({"type": "refused", "code": "UNAUTHORIZED", "message": "no"})
                }
                Some("call") => {
                    let value = answer(frame["tool"].as_str().unwrap_or(""), &frame["args"]);
                    let mut reply = json!({"type": "result", "id": frame["id"]});
                    if value.get("error").is_some() {
                        reply["ok"] = json!(false);
                        reply["error"] = value["error"].clone();
                    } else {
                        reply["ok"] = json!(true);
                        reply["value"] = value;
                    }
                    reply
                }
                _ => continue,
            };
            let mut out = serde_json::to_vec(&reply).unwrap();
            out.push(b'\n');
            write.write_all(&out).await.unwrap();
        }
        seen
    })
}

#[tokio::test]
async fn a_real_client_lists_the_tools_and_round_trips_a_call() {
    let dir = tempfile::tempdir().unwrap();
    let app = fake_app(dir.path(), |tool, args| match tool {
        "create_diagram" => {
            json!({"diagramId": "d_x", "revision": "f:1", "persisted": true, "echo": args["title"]})
        }
        _ => json!({"error": {"code": "NOT_FOUND", "message": "nope"}}),
    });
    let agent_dir = dir.path().to_path_buf();
    let client = ()
        .serve(
            TokioChildProcess::new(Command::new(sidecar()).configure(|c| {
                c.env("DRAFT_CANVAS_AGENT_DIR", &agent_dir);
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let info = client.peer_info().expect("initialized");
    assert_eq!(
        info.server_info.as_ref().map(|s| s.name.as_str()),
        Some("draft-canvas")
    );
    let tools = client.list_all_tools().await.unwrap();
    let names: Vec<_> = tools.iter().map(|t| t.name.to_string()).collect();
    assert_eq!(
        names,
        [
            "get_capabilities",
            "list_diagrams",
            "read_diagram",
            "create_diagram",
            "update_diagram"
        ]
    );
    let create = tools.iter().find(|t| t.name == "create_diagram").unwrap();
    assert_eq!(
        create.annotations.as_ref().and_then(|a| a.idempotent_hint),
        Some(true)
    );

    let ok = client
        .call_tool(
            CallToolRequestParams::new("create_diagram").with_arguments(
                json!({"requestId": "r", "title": "Hello"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(ok.is_error, Some(false));
    assert_eq!(ok.structured_content.as_ref().unwrap()["echo"], "Hello");

    let failed = client
        .call_tool(
            CallToolRequestParams::new("read_diagram").with_arguments(
                json!({"diagramId": "d_missing"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        failed.is_error,
        Some(true),
        "an application error is a tool result, not a protocol error"
    );
    assert_eq!(
        failed.structured_content.as_ref().unwrap()["error"]["code"],
        "NOT_FOUND"
    );

    client.cancel().await.unwrap();
    let seen = app.await.unwrap();
    assert_eq!(seen[0]["type"], "hello");
}

#[tokio::test]
async fn with_no_app_running_a_call_says_so_instead_of_hanging() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().to_path_buf();
    let client = ()
        .serve(
            TokioChildProcess::new(Command::new(sidecar()).configure(|c| {
                c.env("DRAFT_CANVAS_AGENT_DIR", &agent_dir);
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let result = client
        .call_tool(
            CallToolRequestParams::new("list_diagrams").with_arguments(serde_json::Map::new()),
        )
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert_eq!(
        result.structured_content.unwrap()["error"]["code"],
        "APP_UNAVAILABLE"
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn stdout_carries_only_protocol_messages_and_stderr_never_the_token() {
    let dir = tempfile::tempdir().unwrap();
    let _app = fake_app(dir.path(), |_, _| json!({"diagrams": []}));
    let mut child = Command::new(sidecar())
        .env("DRAFT_CANVAS_AGENT_DIR", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for message in [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "raw", "version": "0"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_diagrams", "arguments": {}}}),
    ] {
        let mut line = serde_json::to_vec(&message).unwrap();
        line.push(b'\n');
        stdin.write_all(&line).await.unwrap();
    }
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut replies = Vec::new();
    while replies.len() < 2 {
        let line = tokio::time::timeout(std::time::Duration::from_secs(10), stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let value: Value =
            serde_json::from_str(&line).expect("every stdout line is a JSON-RPC message");
        assert_eq!(value["jsonrpc"], "2.0");
        replies.push(value);
    }
    assert_eq!(
        replies[0]["result"]["protocolVersion"], "2025-06-18",
        "the client's version is honoured when supported"
    );
    drop(stdin);
    let output = child.wait_with_output().await.unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains(TOKEN));
}
