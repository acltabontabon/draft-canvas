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

async fn final_rename(dir: &Path) -> Vec<Value> {
    let mut child = Command::new(sidecar())
        .arg("--apply-edit")
        .env("DRAFT_CANVAS_AGENT_DIR", dir)
        .env("DRAFT_CANVAS_RUN", "12345678-1234-1234-1234-123456789abc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(json!({"tool":"update_diagram","args":{"diagramId":"d_1","requestId":"one-edit","rename":{"from":"API","to":"Gateway"},"view":{"inside":["system"]},"scope":{"nodes":["api"]}},"text":""}).to_string().as_bytes()).await.unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn final_rename_confirms_one_authenticated_native_call_without_a_confirmation_model() {
    let dir = tempfile::tempdir().unwrap();
    let app = fake_app(dir.path(), |tool, args| {
        assert_eq!(tool, "update_diagram");
        assert_eq!(
            args,
            &json!({"diagramId":"d_1","requestId":"one-edit","rename":{"from":"API","to":"Gateway"},"view":{"inside":["system"]},"scope":{"nodes":["api"]}})
        );
        json!({"state":"saved","applied":true,"persisted":true,"revision":"f:2","undo":"editor"})
    });
    let events = final_rename(dir.path()).await;
    let frames = app.await.unwrap();
    assert_eq!(frames[0]["run"], "12345678-1234-1234-1234-123456789abc");
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["type"] == "call")
            .count(),
        1
    );
    assert_eq!(events.len(), 4);
    assert_eq!(
        events[2]["text"],
        "Renamed the shape and saved the diagram. You can undo it in the editor."
    );
    assert_eq!(events[3]["reason"]["kind"], "end-turn");
    assert_eq!(events[3]["usage"], Value::Null);
    assert!(
        events.iter().all(|event| event["type"] != "started"),
        "no invented model session"
    );
}

#[tokio::test]
async fn final_rename_preserves_native_refusals_without_retrying_or_confirming() {
    let dir = tempfile::tempdir().unwrap();
    let app = fake_app(
        dir.path(),
        |_, _| json!({"error":{"code":"PROPOSAL_ONLY","message":"Review is required.","hint":"Submit a proposal."}}),
    );
    let events = final_rename(dir.path()).await;
    let frames = app.await.unwrap();
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["type"] == "call")
            .count(),
        1
    );
    assert_eq!(events.last().unwrap()["reason"]["kind"], "failed");
    assert!(events.last().unwrap()["reason"]["message"]
        .as_str()
        .unwrap()
        .contains("Review is required."));
    assert!(events.iter().all(|event| event["type"] != "message-chunk"));
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
        "render_diagram" => json!({
            "diagramId": "d_x", "revision": "f:1", "format": "png", "mimeType": "image/png",
            "width": 1, "height": 1, "scale": 1, "bytes": 8, "data": "iVBORw0KGgo="
        }),
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
    assert_eq!(names, ["diagram_tool"]);
    assert!(serde_json::to_vec(&tools).unwrap().len() <= 700);
    assert_eq!(
        tools[0].annotations.as_ref().and_then(|a| a.read_only_hint),
        Some(false)
    );
    let help = client
        .call_tool(
            CallToolRequestParams::new("diagram_tool").with_arguments(
                json!({"tool":"help","args":{"tool":"create_diagram"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        help.structured_content.as_ref().unwrap()["annotations"]["idempotentHint"],
        true
    );

    let ok = client
        .call_tool(
            CallToolRequestParams::new("diagram_tool").with_arguments(
                json!({"tool":"create_diagram","args":{"requestId": "r", "title": "Hello"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(ok.is_error, Some(false));
    assert_eq!(ok.structured_content.as_ref().unwrap()["echo"], "Hello");

    // A rendered diagram reaches the client as MCP image content, through the real protocol.
    let rendered = client
        .call_tool(
            CallToolRequestParams::new("render_diagram")
                .with_arguments(json!({"diagramId": "d_x"}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    assert_eq!(rendered.is_error, Some(false));
    let rmcp::model::ContentBlock::Image(image) = &rendered.content[0] else {
        panic!("the first content block is the image");
    };
    assert_eq!(image.mime_type, "image/png");
    assert_eq!(image.data, "iVBORw0KGgo=");
    assert_eq!(
        rendered.structured_content.as_ref().unwrap()["revision"],
        "f:1"
    );

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
    assert!(
        seen[0].get("run").is_none(),
        "an agent the person connected is no run"
    );
}

#[tokio::test]
async fn full_tools_keeps_individual_annotations_available() {
    let client = ()
        .serve(
            TokioChildProcess::new(Command::new(sidecar()).configure(|c| {
                c.arg("--full-tools");
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let tools = client.list_all_tools().await.unwrap();
    let names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    assert_eq!(
        names,
        [
            "get_capabilities",
            "list_diagrams",
            "read_diagram",
            "read_attachment",
            "read_selection",
            "get_implementation_context",
            "render_diagram",
            "create_diagram",
            "update_diagram",
            "preview_diagram",
            "submit_proposal",
            "get_proposal",
            "list_proposals"
        ]
    );
    let create = tools
        .iter()
        .find(|tool| tool.name == "create_diagram")
        .unwrap();
    assert_eq!(
        create.annotations.as_ref().and_then(|a| a.idempotent_hint),
        Some(true)
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn an_agent_the_companion_started_names_its_run_in_the_hello() {
    let dir = tempfile::tempdir().unwrap();
    let app = fake_app(dir.path(), |_, _| json!({"diagrams": []}));
    let agent_dir = dir.path().to_path_buf();
    let client = ()
        .serve(
            TokioChildProcess::new(Command::new(sidecar()).configure(|c| {
                c.env("DRAFT_CANVAS_AGENT_DIR", &agent_dir)
                    .env("DRAFT_CANVAS_RUN", "3f1c2a4e-0000-4000-8000-000000000001");
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    client
        .call_tool(
            CallToolRequestParams::new("get_capabilities").with_arguments(serde_json::Map::new()),
        )
        .await
        .unwrap();
    client.cancel().await.unwrap();
    let seen = app.await.unwrap();
    assert_eq!(seen[0]["type"], "hello");
    assert_eq!(seen[0]["run"], "3f1c2a4e-0000-4000-8000-000000000001");
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

#[tokio::test]
async fn the_newest_protocol_is_negotiated_down_to_one_with_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(sidecar())
        .env("DRAFT_CANVAS_AGENT_DIR", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    for message in [
        // Stateless, without initialize: progress and cancellation need a session, so refused.
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {"_meta": meta}}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "raw", "version": "0"}}}),
    ] {
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut replies = Vec::new();
    while replies.len() < 2 {
        let line = tokio::time::timeout(std::time::Duration::from_secs(10), stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        replies.push(serde_json::from_str::<Value>(&line).unwrap());
    }
    assert_eq!(replies[0]["id"], 1);
    // UNSUPPORTED_PROTOCOL_VERSION.
    assert_eq!(replies[0]["error"]["code"], -32022, "{}", replies[0]);
    assert_eq!(replies[1]["result"]["protocolVersion"], "2025-11-25");
}

#[tokio::test]
async fn cancelling_during_the_bridge_handshake_never_sends_the_tool_call() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("bridge.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    std::fs::write(
        dir.path().join("agent.json"),
        json!({"v": 1, "endpoint": socket, "token": TOKEN, "pid": 1}).to_string(),
    )
    .unwrap();
    let (greeted, hello_received) = tokio::sync::oneshot::channel();
    let app = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut lines = BufReader::new(stream).lines();
        let hello: Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(hello["type"], "hello");
        greeted.send(()).unwrap();
        // The app has not welcomed it yet: there is no registered bridge-call id to cancel.
        // Cancellation must release the connection now, rather than finishing the handshake later.
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
    });
    let mut child = Command::new(sidecar())
        .env("DRAFT_CANVAS_AGENT_DIR", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for message in [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "raw", "version": "0"}}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_diagrams", "arguments": {}}}),
    ] {
        let line = format!("{message}\n");
        stdin.write_all(line.as_bytes()).await.unwrap();
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), hello_received)
        .await
        .unwrap()
        .unwrap();
    stdin.write_all(format!("{}\n", json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 2}})).as_bytes()).await.unwrap();
    app.await.unwrap();
    drop(stdin);
    tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn an_unknown_tool_is_a_tool_error_even_without_a_running_app() {
    let dir = tempfile::tempdir().unwrap();
    let client = ()
        .serve(
            TokioChildProcess::new(Command::new(sidecar()).configure(|c| {
                c.env("DRAFT_CANVAS_AGENT_DIR", dir.path());
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    let result = client
        .call_tool(CallToolRequestParams::new("unknown_tool"))
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert_eq!(
        result.structured_content.unwrap()["error"]["code"],
        "UNKNOWN_TOOL"
    );
    client.cancel().await.unwrap();
}

/// The path a Junie run took to its action limit: the one dispatcher tool, help for update_diagram,
/// an update the app refuses, then the corrected one. What the client is handed at each step has to
/// be enough for the next: the op grammar, then the app's refusal whole (which op, which field, what
/// to send, and that nothing changed), as structured content and as text for clients that read only text.
#[tokio::test]
async fn a_refused_update_reaches_the_client_whole_and_its_correction_goes_through() {
    let dir = tempfile::tempdir().unwrap();
    let app = fake_app(dir.path(), |tool, args| {
        assert_eq!(tool, "update_diagram");
        if args["ops"][0]["id"] == "api" {
            return json!({"diagramId": "d_1", "revision": "f:2", "applied": true, "persisted": true, "updated": 1});
        }
        json!({"error": {
            "code": "INVALID_REFERENCE",
            "message": "/ops/0/id: nothing with id \"Orders API\" in this view; that is the label of id \"api\", and an op takes the id",
            "hint": "Nothing was changed. An op takes ids, and only those of the view it addresses.",
            "details": {"path": "/ops/0/id", "problems": [{"code": "INVALID_REFERENCE", "path": "/ops/0/id", "message": "nothing with id \"Orders API\" in this view"}]}
        }})
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
    let call = |arguments: Value| {
        client.call_tool(
            CallToolRequestParams::new("diagram_tool")
                .with_arguments(arguments.as_object().unwrap().clone()),
        )
    };
    let help = call(json!({"tool": "help", "args": {"tool": "update_diagram"}}))
        .await
        .unwrap();
    let ops = &help.structured_content.as_ref().unwrap()["inputSchema"]["properties"]["ops"];
    assert!(ops["description"]
        .as_str()
        .unwrap()
        .contains("element: label,type,description,technology"));

    // Answered by the sidecar: the app is never asked about a call it could not read.
    let misplaced = call(json!({"tool": "update_diagram", "args": {}, "diagramId": "d_1"}))
        .await
        .unwrap();
    assert_eq!(misplaced.is_error, Some(true));
    assert_eq!(
        misplaced.structured_content.as_ref().unwrap()["error"]["code"],
        "INVALID_INPUT"
    );

    let update = |id: &str, request: &str| {
        json!({"tool": "update_diagram", "args": {"requestId": request, "diagramId": "d_1", "expectedRevision": "f:1",
            "ops": [{"op": "update", "id": id, "set": {"technology": "Kotlin"}}]}})
    };
    let refused = call(update("Orders API", "first")).await.unwrap();
    assert_eq!(refused.is_error, Some(true));
    let error = &refused.structured_content.as_ref().unwrap()["error"];
    assert_eq!(error["code"], "INVALID_REFERENCE");
    assert_eq!(error["details"]["path"], "/ops/0/id");
    assert!(error["hint"]
        .as_str()
        .unwrap()
        .starts_with("Nothing was changed."));
    assert!(
        error.get("retryable").is_none(),
        "a mistake in the request is not a transient failure"
    );
    let text = serde_json::to_string(&refused.content).unwrap();
    assert!(
        text.contains("label of id") && text.contains("Nothing was changed."),
        "a client that reads only text content gets the same refusal: {text}"
    );

    let corrected = call(update("api", "second")).await.unwrap();
    assert_eq!(corrected.is_error, Some(false));
    assert_eq!(corrected.structured_content.unwrap()["revision"], "f:2");

    client.cancel().await.unwrap();
    let calls: Vec<Value> = app
        .await
        .unwrap()
        .into_iter()
        .filter(|frame| frame["type"] == "call")
        .collect();
    assert_eq!(
        calls.len(),
        2,
        "help and the malformed call never reach the app"
    );
    assert!(calls.iter().all(|frame| frame["tool"] == "update_diagram"));
}
