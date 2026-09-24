//! A real MCP client (rmcp) that launches the real sidecar and runs a script of tool calls against
//! whatever Draft Canvas is running — how the integration is exercised end to end without an agent.
//!
//!   cargo run -p draft-canvas-mcp --example probe -- script.json [path/to/draft-canvas-mcp]
//!
//! `script.json` is `[{"tool": "...", "args": {...}}, ...]`; `args` may use `"$revision"` to mean the
//! revision the previous result returned. Each result is printed as one JSON line.
use rmcp::model::CallToolRequestParams;
use rmcp::transport::TokioChildProcess;
use rmcp::ServiceExt;
use serde_json::Value;
use tokio::process::Command;

fn substitute(value: &mut Value, revision: &Option<String>) {
    match value {
        Value::String(s) if s == "$revision" => {
            if let Some(r) = revision {
                *s = r.clone();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| substitute(v, revision)),
        Value::Object(map) => map.values_mut().for_each(|v| substitute(v, revision)),
        _ => {}
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let script: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&args[0])?)?;
    let sidecar = args.get(1).cloned().unwrap_or_else(|| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/debug/draft-canvas-mcp"
        )
        .to_string()
    });
    let started = std::time::Instant::now();
    let client = ().serve(TokioChildProcess::new(Command::new(&sidecar))?).await?;
    let info = client.peer_info();
    println!(
        "{}",
        serde_json::json!({"initialized_ms": started.elapsed().as_millis(), "server": info.map(|i| serde_json::to_value(i).unwrap_or_default())})
    );
    let tools = client.list_all_tools().await?;
    let schema_bytes: usize = tools
        .iter()
        .map(|t| serde_json::to_string(t).map(|s| s.len()).unwrap_or(0))
        .sum();
    println!(
        "{}",
        serde_json::json!({"tools": tools.iter().map(|t| t.name.to_string()).collect::<Vec<_>>(), "toolSchemaBytes": schema_bytes})
    );
    let mut revision: Option<String> = None;
    for step in script {
        let tool = step["tool"].as_str().unwrap_or("").to_string();
        let mut call_args = step["args"].clone();
        substitute(&mut call_args, &revision);
        let request_bytes = call_args.to_string().len();
        let t = std::time::Instant::now();
        let params = CallToolRequestParams::new(tool.clone())
            .with_arguments(call_args.as_object().cloned().unwrap_or_default());
        let result = client.call_tool(params).await;
        let ms = t.elapsed().as_millis();
        match result {
            Ok(r) => {
                let value = r.structured_content.clone().unwrap_or(Value::Null);
                if let Some(rev) = value.get("revision").and_then(Value::as_str) {
                    revision = Some(rev.to_string());
                }
                let text = value.to_string();
                println!(
                    "{}",
                    serde_json::json!({"tool": tool, "ms": ms, "isError": r.is_error, "requestBytes": request_bytes, "responseBytes": text.len(), "result": if text.len() > 1500 { Value::String(format!("{}…", &text[..1500])) } else { value }})
                );
            }
            Err(e) => println!(
                "{}",
                serde_json::json!({"tool": tool, "ms": ms, "protocolError": e.to_string()})
            ),
        }
    }
    client.cancel().await?;
    Ok(())
}
