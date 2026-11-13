//! Supabase Realtime (Phoenix sobre WebSocket): só acorda o worker quando chega solicitação nova.
//! Não é a única fonte: o worker também consulta periodicamente (reconexão e quedas não perdem nada).

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

pub fn socket_url(base: &str, anon: &str) -> String {
    let ws = base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1);
    format!("{ws}/realtime/v1/websocket?apikey={anon}&vsn=1.0.0")
}

pub fn join_message(access_token: &str) -> Value {
    json!({
        "topic": "realtime:fic-backoffice",
        "event": "phx_join",
        "ref": "1",
        "payload": {
            "config": { "postgres_changes": [{ "event": "*", "schema": "public", "table": "proposal_requests" }] },
            "access_token": access_token
        }
    })
}

/// Uma conexão até cair. Retorna quando o socket fecha ou o token precisa ser trocado.
pub async fn run_once(url: &str, access_token: &str, wake: &Notify, connected: &Arc<AtomicBool>) -> Result<(), String> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
    ws.send(Message::Text(join_message(access_token).to_string().into())).await.map_err(|e| e.to_string())?;
    let mut hb = tokio::time::interval(Duration::from_secs(25));
    // Reconecta a cada 30 min para usar um token de acesso novo.
    let rotate = tokio::time::sleep(Duration::from_secs(1800));
    tokio::pin!(rotate);
    let mut n: u64 = 1;
    loop {
        tokio::select! {
            _ = hb.tick() => {
                n += 1;
                let msg = json!({ "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": n.to_string() });
                ws.send(Message::Text(msg.to_string().into())).await.map_err(|e| e.to_string())?;
            }
            _ = &mut rotate => return Ok(()),
            msg = ws.next() => {
                let Some(msg) = msg else { return Ok(()) };
                let Message::Text(text) = msg.map_err(|e| e.to_string())? else { continue };
                let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                match v["event"].as_str() {
                    Some("phx_reply") if v["ref"] == "1" => {
                        let ok = v["payload"]["status"] == "ok";
                        connected.store(ok, Ordering::Relaxed);
                        if !ok { return Err("join rejected".into()); }
                    }
                    Some("postgres_changes") => wake.notify_one(),
                    Some("phx_error") | Some("phx_close") => return Err("channel closed".into()),
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_secure_socket_url_and_join() {
        assert_eq!(socket_url("https://abc.supabase.co", "k"), "wss://abc.supabase.co/realtime/v1/websocket?apikey=k&vsn=1.0.0");
        let j = join_message("tok");
        assert_eq!(j["payload"]["config"]["postgres_changes"][0]["table"], "proposal_requests");
        assert_eq!(j["payload"]["access_token"], "tok");
    }
}
