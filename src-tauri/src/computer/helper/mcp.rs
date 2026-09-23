//! A minimal MCP client for the driver's stdio: `initialize`, then
//! `tools/call`, multiplexed by JSON-RPC id.
//!
//! Minimal on purpose. The driver is the only server this ever talks to, and
//! the helper only ever calls the handful of tools `ops` names; everything
//! MCP offers beyond that (resources, prompts, sampling, subscriptions) is
//! something the helper has no use for and so does not implement. A request
//! the driver sends *to* the helper gets "method not found" rather than
//! silence, so the driver is never left waiting on it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, watch};

/// The protocol revision the helper asks for. The driver speaks this one and
/// a newer one; this is the older, stabler of the two.
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Longest line accepted from the driver. A window screenshot rides inside
/// one line as base64, so the bound is generous; it exists so a driver gone
/// wrong cannot make the helper buffer without end.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// How long one message may take to go out. The driver reads its input as it
/// comes, so a write that cannot finish means a driver that stopped reading:
/// wedged. Half a message on the pipe cannot be taken back, so the client is
/// closed and the next call starts another driver.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpError {
    /// The driver closed its side, or exited.
    Closed,
    Timeout,
    /// The driver answered with a JSON-RPC error.
    Rpc {
        code: i64,
        message: String,
    },
    /// The driver answered with something that is not a JSON-RPC reply.
    Protocol(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::Closed => f.write_str("the driver closed its connection"),
            McpError::Timeout => f.write_str("the driver did not answer in time"),
            McpError::Rpc { code, message } => {
                write!(f, "the driver refused the call ({code}): {message}")
            }
            McpError::Protocol(why) => {
                write!(f, "the driver answered in an unexpected shape: {why}")
            }
        }
    }
}

/// A `tools/call` result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolCallResult {
    pub is_error: bool,
    pub content: Vec<Value>,
    pub structured: Option<Value>,
}

impl ToolCallResult {
    fn from_value(value: Value) -> Result<Self, McpError> {
        let Value::Object(mut map) = value else {
            return Err(McpError::Protocol(
                "a tools/call result that is not an object".into(),
            ));
        };
        let content = match map.remove("content") {
            Some(Value::Array(items)) => items,
            Some(Value::Null) | None => Vec::new(),
            Some(_) => return Err(McpError::Protocol("`content` is not an array".into())),
        };
        Ok(Self {
            is_error: map.get("isError").and_then(Value::as_bool).unwrap_or(false),
            content,
            structured: map.remove("structuredContent").filter(|v| !v.is_null()),
        })
    }

    /// Every text block, joined — the driver's own words for a refusal.
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The first image block, as `(base64, mime)`.
    pub fn image(&self) -> Option<(&str, &str)> {
        self.content.iter().find_map(|c| {
            (c.get("type").and_then(Value::as_str) == Some("image")).then_some(())?;
            Some((
                c.get("data").and_then(Value::as_str)?,
                c.get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png"),
            ))
        })
    }
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, McpError>>>>>;

fn fail_pending(pending: &Pending) {
    let waiting: Vec<_> = pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .map(|(_, tx)| tx)
        .collect();
    for tx in waiting {
        let _ = tx.send(Err(McpError::Closed));
    }
}

pub struct McpClient {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: Arc<watch::Sender<bool>>,
}

impl McpClient {
    /// Start reading `reader` in the background and return a client that
    /// writes to `writer`.
    pub fn start<R, W>(reader: R, writer: W) -> Arc<Self>
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(watch::Sender::new(false));
        let closed_tx = closed.clone();
        let client = Arc::new(Self {
            writer: tokio::sync::Mutex::new(Box::new(writer)),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            closed,
        });
        let weak = Arc::downgrade(&client);
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match read_line_bounded(&mut lines, &mut buf).await {
                    Ok(true) => {}
                    Ok(false) | Err(_) => break,
                }
                let Ok(message) = serde_json::from_slice::<Value>(&buf) else {
                    continue;
                };
                let id = message.get("id").and_then(Value::as_u64);
                let is_reply = message.get("result").is_some() || message.get("error").is_some();
                match (id, is_reply) {
                    (Some(id), true) => {
                        let tx = pending
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id);
                        if let Some(tx) = tx {
                            let _ = tx.send(reply_value(message));
                        }
                    }
                    // A request from the driver to us. Answer it so it is not
                    // left pending; the helper offers nothing.
                    (_, false)
                        if message.get("method").is_some() && message.get("id").is_some() =>
                    {
                        if let Some(client) = weak.upgrade() {
                            let answer = json!({
                                "jsonrpc": "2.0",
                                "id": message["id"].clone(),
                                "error": { "code": -32601, "message": "method not found" },
                            });
                            let _ = client.write_message(&answer).await;
                        }
                    }
                    // Notifications (progress, logging): nothing to do.
                    _ => {}
                }
            }
            closed_tx.send_replace(true);
            fail_pending(&pending);
        });
        client
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Give up on the driver: every call waiting on it is told so, and
    /// [`is_closed`](Self::is_closed) says so from now on.
    fn close(&self) {
        self.closed.send_replace(true);
        fail_pending(&self.pending);
    }

    async fn write_message(&self, message: &Value) -> Result<(), McpError> {
        let mut line =
            serde_json::to_vec(message).map_err(|e| McpError::Protocol(e.to_string()))?;
        line.push(b'\n');
        let write = async {
            let mut writer = self.writer.lock().await;
            writer.write_all(&line).await?;
            writer.flush().await
        };
        match tokio::time::timeout(WRITE_TIMEOUT, write).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(McpError::Closed),
            Err(_) => {
                self.close();
                Err(McpError::Timeout)
            }
        }
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, McpError> {
        if self.is_closed() {
            return Err(McpError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_message(&message).await {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(McpError::Closed),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(McpError::Timeout)
            }
        }
    }

    /// The MCP handshake. Must complete before any tool call.
    pub async fn initialize(&self, timeout: Duration) -> Result<Value, McpError> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "codeg-computer-helper", "version": env!("CARGO_PKG_VERSION") },
                }),
                timeout,
            )
            .await?;
        self.write_message(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await?;
        Ok(result)
    }

    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<ToolCallResult, McpError> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
                timeout,
            )
            .await?;
        ToolCallResult::from_value(result)
    }
}

fn reply_value(message: Value) -> Result<Value, McpError> {
    if let Some(error) = message.get("error") {
        return Err(McpError::Rpc {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(message.get("result").cloned().unwrap_or(Value::Null))
}

/// Read one `\n`-terminated line into `buf`, without the newline. `Ok(false)`
/// at end of stream; an error for a line longer than [`MAX_LINE_BYTES`].
async fn read_line_bounded<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    buf: &mut Vec<u8>,
) -> std::io::Result<bool> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(!buf.is_empty());
        }
        if let Some(pos) = available.iter().position(|b| *b == b'\n') {
            buf.extend_from_slice(&available[..pos]);
            reader.consume(pos + 1);
            if buf.len() > MAX_LINE_BYTES {
                return Err(std::io::Error::other("line too long"));
            }
            return Ok(true);
        }
        let len = available.len();
        buf.extend_from_slice(available);
        reader.consume(len);
        if buf.len() > MAX_LINE_BYTES {
            return Err(std::io::Error::other("line too long"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt};

    /// A fake driver on the other end of an in-memory pipe: answers
    /// `initialize` and `tools/call` out of order, sends a notification and a
    /// request of its own in between, and the client sorts it all out.
    #[tokio::test]
    async fn replies_find_their_callers_whatever_order_they_arrive_in() {
        let (client_side, server_side) = duplex(1 << 20);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (server_read, mut server_write) = tokio::io::split(server_side);
        let client = McpClient::start(client_read, client_write);

        let server = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            // initialize
            let init: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(init["method"], "initialize");
            let reply = json!({"jsonrpc":"2.0","id":init["id"],"result":{"protocolVersion":MCP_PROTOCOL_VERSION}});
            server_write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .unwrap();
            let note: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(note["method"], "notifications/initialized");
            // Two calls; answer the second first.
            let a: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            let b: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            server_write
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n",
                )
                .await
                .unwrap();
            server_write
                .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"srv-1\",\"method\":\"roots/list\"}\n")
                .await
                .unwrap();
            for (call, text) in [(&b, "second"), (&a, "first")] {
                let reply = json!({"jsonrpc":"2.0","id":call["id"],"result":{
                    "content":[{"type":"text","text":text}],"structuredContent":{"which":text}}});
                server_write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
            // The client answered our request with "method not found".
            let answer: Value =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(answer["id"], "srv-1");
            assert_eq!(answer["error"]["code"], -32601);
        });

        client.initialize(Duration::from_secs(5)).await.unwrap();
        let (first, second) = tokio::join!(
            client.call_tool("list_apps", json!({}), Duration::from_secs(5)),
            client.call_tool("list_windows", json!({}), Duration::from_secs(5)),
        );
        assert_eq!(first.unwrap().text(), "first");
        assert_eq!(second.unwrap().structured.unwrap()["which"], "second");
        server.await.unwrap();
    }

    /// A driver that goes away fails every waiting call at once, and every
    /// later one immediately.
    #[tokio::test]
    async fn a_closed_driver_fails_calls_instead_of_hanging_them() {
        let (client_side, server_side) = duplex(1024);
        let (client_read, client_write) = tokio::io::split(client_side);
        let client = McpClient::start(client_read, client_write);
        let call = {
            let client = client.clone();
            tokio::spawn(async move {
                client
                    .call_tool("list_apps", json!({}), Duration::from_secs(30))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(server_side);
        assert_eq!(call.await.unwrap(), Err(McpError::Closed));
        assert_eq!(
            client
                .call_tool("list_apps", json!({}), Duration::from_secs(1))
                .await,
            Err(McpError::Closed)
        );
    }

    #[test]
    fn tool_results_expose_their_text_and_image() {
        let result = ToolCallResult::from_value(json!({
            "content": [
                {"type": "image", "data": "iVBOR", "mimeType": "image/png"},
                {"type": "text", "text": "window_id=1"}
            ],
            "isError": false
        }))
        .unwrap();
        assert_eq!(result.image(), Some(("iVBOR", "image/png")));
        assert_eq!(result.text(), "window_id=1");
        assert!(result.structured.is_none());
    }

    /// A driver that stops reading its input is given up on: the call fails
    /// in bounded time instead of waiting on the pipe for ever, and the
    /// client reports itself closed, so the next call starts another driver.
    #[tokio::test(start_paused = true)]
    async fn a_driver_that_stops_reading_is_given_up_on() {
        let (client_side, server_side) = duplex(64);
        let (client_read, client_write) = tokio::io::split(client_side);
        let client = McpClient::start(client_read, client_write);
        let big = "x".repeat(4096);
        let err = client
            .call_tool("get_window_state", json!({ "query": big }), Duration::from_secs(60))
            .await
            .unwrap_err();
        assert_eq!(err, McpError::Timeout);
        assert!(client.is_closed());
        drop(server_side);
    }
}
