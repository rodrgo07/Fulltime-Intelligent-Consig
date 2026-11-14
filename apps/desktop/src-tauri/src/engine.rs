//! Processo filho do motor RPA (sidecar) e cliente JSON-RPC sobre stdin/stdout.
//! Nenhuma porta de rede é aberta; o processo morre junto com o app (kill_on_drop).

use crate::error::{AppError, AppResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

pub const CONTRACT_VERSION: u64 = 2;

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct JobEvent {
    pub job_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub step: Option<String>,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug)]
pub enum EngineMsg {
    Event(JobEvent),
    HostCall { id: String, method: String, params: Value },
    Exited,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, AppError>>>>>;

pub struct Engine {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Pending,
    next_id: AtomicU64,
    pub pid: Option<u32>,
}

/// Caminho do executável: variável FIC_ENGINE_EXE (desenvolvimento) ou ao lado do app (sidecar).
pub fn engine_path() -> PathBuf {
    if let Ok(p) = std::env::var("FIC_ENGINE_EXE") {
        return PathBuf::from(p);
    }
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("fic-engine.exe"))).unwrap_or_default()
}

/// Mensagem de saída do motor já validada. Linhas inválidas são ignoradas (e registradas).
/// Ok = resposta a uma chamada nossa (id, resultado); Err = mensagem espontânea do motor.
pub type Classified = Result<(u64, Result<Value, AppError>), EngineMsg>;

pub fn classify_line(line: &str) -> Option<Classified> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("jsonrpc")? != "2.0" {
        return None;
    }
    if let Some(method) = v.get("method").and_then(Value::as_str) {
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        if method == "job.event" {
            return serde_json::from_value(params).ok().map(|e| Err(EngineMsg::Event(e)));
        }
        let id = v.get("id")?.as_str()?.to_string();
        if !method.starts_with("host.") {
            return None;
        }
        return Some(Err(EngineMsg::HostCall { id, method: method.to_string(), params }));
    }
    let id = v.get("id")?.as_u64()?;
    if let Some(err) = v.get("error") {
        let code = err.pointer("/data/code").and_then(Value::as_str)
            .or_else(|| err.get("message").and_then(Value::as_str)).unwrap_or("ENGINE_ERROR");
        return Some(Ok((id, Err(AppError::Engine(code.chars().take(64).collect())))));
    }
    Some(Ok((id, Ok(v.get("result").cloned().unwrap_or(Value::Null)))))
}

impl Engine {
    pub async fn spawn(exe: &Path, data_dir: &Path, log_level: &str) -> AppResult<(Arc<Engine>, mpsc::Receiver<EngineMsg>)> {
        if !exe.is_file() {
            return Err(AppError::Code("ENGINE_NOT_FOUND"));
        }
        let mut cmd = Command::new(exe);
        cmd.arg("--data-dir").arg(data_dir).arg("--log-level").arg(log_level)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|_| AppError::Code("ENGINE_SPAWN_FAILED"))?;
        let stdin = child.stdin.take().ok_or(AppError::Code("ENGINE_SPAWN_FAILED"))?;
        let stdout = child.stdout.take().ok_or(AppError::Code("ENGINE_SPAWN_FAILED"))?;
        let stderr = child.stderr.take().ok_or(AppError::Code("ENGINE_SPAWN_FAILED"))?;
        let pid = child.id();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel(256);

        let p2 = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match classify_line(&line) {
                    Some(Ok((id, res))) => {
                        if let Some(waiter) = p2.lock().await.remove(&id) {
                            let _ = waiter.send(res);
                        }
                    }
                    Some(Err(msg)) => {
                        let _ = tx.send(msg).await;
                    }
                    None => tracing::warn!(target: "engine", "linha inválida do motor ignorada"),
                }
            }
            for (_, w) in p2.lock().await.drain() {
                let _ = w.send(Err(AppError::Code("ENGINE_EXITED")));
            }
            let _ = tx.send(EngineMsg::Exited).await;
        });

        tokio::spawn(async move {
            // O motor já escreve JSON redigido (sem dados pessoais) no stderr.
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "engine", "{}", line.chars().take(2000).collect::<String>());
            }
        });

        let engine = Arc::new(Engine { stdin: Mutex::new(stdin), child: Mutex::new(child), pending, next_id: AtomicU64::new(1), pid });
        let hello = engine.call("engine.hello", json!({ "contract_version": CONTRACT_VERSION }), 30).await?;
        tracing::info!(engine_version = %hello["engine_version"], "motor iniciado");
        Ok((engine, rx))
    }

    async fn write(&self, msg: &Value) -> AppResult<()> {
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&line).await.map_err(|_| AppError::Code("ENGINE_EXITED"))?;
        stdin.flush().await.map_err(|_| AppError::Code("ENGINE_EXITED"))
    }

    pub async fn call(&self, method: &str, params: Value, timeout_s: u64) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        match tokio::time::timeout(Duration::from_secs(timeout_s), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(AppError::Code("ENGINE_EXITED")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AppError::Code("ENGINE_TIMEOUT"))
            }
        }
    }

    pub async fn respond(&self, id: &str, result: Value) -> AppResult<()> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).await
    }

    pub async fn shutdown(&self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.call("engine.shutdown", json!({}), 5)).await;
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(10), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/contracts/fixtures/engine-rpc").join(name);
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn parses_contract_fixtures() {
        for name in ["completed", "failed", "escalated"] {
            let params = fixture(&format!("job.event.{name}.json"));
            let line = json!({ "jsonrpc": "2.0", "method": "job.event", "params": params }).to_string();
            match classify_line(&line) {
                Some(Err(EngineMsg::Event(e))) => assert_eq!(e.kind, name),
                other => panic!("unexpected {other:?}"),
            }
        }
        let line = json!({ "jsonrpc": "2.0", "id": "h1", "method": "host.confirm_side_effect",
                           "params": fixture("host.confirm_side_effect.params.json") }).to_string();
        assert!(matches!(classify_line(&line), Some(Err(EngineMsg::HostCall { .. }))));
    }

    #[test]
    fn maps_engine_errors_and_rejects_unknown_calls() {
        let line = r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"x","data":{"code":"WORKFLOW_NOT_READY"}}}"#;
        match classify_line(line) {
            Some(Ok((7, Err(e)))) => assert_eq!(e.code(), "WORKFLOW_NOT_READY"),
            other => panic!("unexpected {other:?}"),
        }
        // O motor não pode chamar métodos arbitrários do host.
        assert!(classify_line(r#"{"jsonrpc":"2.0","id":"h2","method":"system.exec","params":{}}"#).is_none());
        assert!(classify_line("lixo").is_none());
    }
}
