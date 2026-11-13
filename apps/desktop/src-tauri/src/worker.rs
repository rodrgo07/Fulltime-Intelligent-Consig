//! Execução centralizada em segundo plano: supervisão do motor, fila e reporte ao Supabase.
//!
//! Regras:
//! - A fila só é processada se o motor tem o fluxo do Consig (workflow_ready) e a sessão do Consig
//!   está autenticada. Caso contrário, nada é reservado e o motivo fica visível no painel.
//! - O resultado (número de adesão) é gravado em disco ANTES de ser enviado e só é apagado
//!   depois que o servidor confirma: queda de rede/app não perde resultado.
//! - O payload do cliente só existe em memória, durante o envio ao motor.

use crate::engine::{engine_path, Engine, EngineMsg, JobEvent};
use crate::error::{AppError, AppResult};
use crate::realtime;
use crate::state::{AppState, CurrentJob};
use crate::supabase::now_epoch;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingResult {
    pub job_id: String,
    pub adhesion_number: String,
    pub result_status: Option<String>,
    pub external_operation_id: Option<String>,
}

pub fn load_pending(dir: &Path) -> Vec<PendingResult> {
    std::fs::read(dir.join("pending-results.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save_pending(dir: &Path, items: &[PendingResult]) -> AppResult<()> {
    let path = dir.join("pending-results.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(items)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

pub fn spawn_all(state: Arc<AppState>) {
    tokio::spawn(engine_supervisor(state.clone()));
    tokio::spawn(queue_loop(state.clone()));
    tokio::spawn(realtime_loop(state));
}

async fn set_error(state: &AppState, e: &AppError) {
    state.status.write().await.last_error = Some(e.code());
}

// ------------------------------------------------------------------ motor
async fn engine_supervisor(state: Arc<AppState>) {
    let mut backoff = 2u64;
    loop {
        state.status.write().await.engine_state = "starting".into();
        let level = state.config.read().await.log_level.clone();
        match Engine::spawn(&engine_path(), &state.data_dir, &level).await {
            Ok((engine, rx)) => {
                backoff = 2;
                *state.engine.write().await = Some(engine.clone());
                state.status.write().await.engine_state = "ready".into();
                let _ = apply_ai_config(&state).await;
                state.wake.notify_one();
                handle_engine_messages(&state, engine.clone(), rx).await;
                *state.engine.write().await = None;
                tracing::error!("motor encerrou inesperadamente");
                state.status.write().await.engine_state = "crashed".into();
                on_engine_crash(&state).await;
            }
            Err(e) => {
                tracing::error!(code = %e.code(), "falha ao iniciar o motor");
                state.status.write().await.engine_state = if e.code() == "ENGINE_NOT_FOUND" { "missing".into() } else { "crashed".into() };
                set_error(&state, &e).await;
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
            _ = state.engine_restart.notified() => {}
        }
        backoff = (backoff * 2).min(60);
    }
}

pub async fn apply_ai_config(state: &AppState) -> AppResult<Value> {
    let ai = state.config.read().await.ai.clone();
    state.engine().await?.call("ai.configure", serde_json::to_value(ai)?, 15).await
}

async fn handle_engine_messages(state: &Arc<AppState>, engine: Arc<Engine>, mut rx: mpsc::Receiver<EngineMsg>) {
    while let Some(msg) = rx.recv().await {
        match msg {
            EngineMsg::Exited => return,
            EngineMsg::Event(ev) => {
                let st = state.clone();
                // Eventos do mesmo job são tratados em ordem.
                handle_event(&st, ev).await;
            }
            EngineMsg::HostCall { id, method, params } => {
                let confirmed = if method == "host.confirm_side_effect" { confirm_side_effect(state, &params).await } else { false };
                let _ = engine.respond(&id, json!({ "confirmed": confirmed })).await;
            }
        }
    }
}

/// Registra o "ponto sem retorno" no banco antes de o motor executar a etapa com efeito no Consig.
async fn confirm_side_effect(state: &AppState, params: &Value) -> bool {
    let job_id = params["job_id"].as_str().unwrap_or_default();
    let step = params["step"].as_str().unwrap_or_default();
    let is_current = state.status.read().await.current.as_ref().map(|c| c.job_id == job_id).unwrap_or(false);
    if !is_current {
        return false;
    }
    let ok = match state.client().await {
        Ok((sb, tok)) => sb.rpc::<Value>(&tok, "mark_side_effect_started", json!({ "p_job_id": job_id, "p_step": step })).await.is_ok(),
        Err(_) => false,
    };
    if ok {
        if let Some(c) = state.status.write().await.current.as_mut() {
            c.side_effect = true;
        }
    }
    ok
}

async fn with_retry<F, Fut>(attempts: u32, mut f: F) -> AppResult<Value>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    let mut last = AppError::Code("UNKNOWN");
    for i in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e @ AppError::Api { status, .. }) if status < 500 && status != 429 => return Err(e),
            Err(e) => last = e,
        }
        tokio::time::sleep(Duration::from_secs(2u64.pow(i.min(5)))).await;
    }
    Err(last)
}

async fn report(state: &AppState, func: &'static str, args: Value) -> AppResult<Value> {
    with_retry(5, || {
        let args = args.clone();
        async move {
            let (sb, tok) = state.client().await?;
            sb.rpc::<Value>(&tok, func, args).await
        }
    })
    .await
}

async fn handle_event(state: &Arc<AppState>, ev: JobEvent) {
    let is_current = state.status.read().await.current.as_ref().map(|c| c.job_id == ev.job_id).unwrap_or(false);
    if !is_current {
        tracing::warn!(job_id = %ev.job_id, "evento de job desconhecido ignorado");
        return;
    }
    match ev.kind.as_str() {
        "step_started" | "heartbeat" => {
            if let Some(c) = state.status.write().await.current.as_mut() {
                c.step = ev.step.clone();
            }
            if let Err(e) = report(state, "heartbeat_job", json!({ "p_job_id": ev.job_id, "p_step": ev.step })).await {
                tracing::warn!(code = %e.code(), "heartbeat não registrado");
            }
        }
        "completed" => {
            let pr = PendingResult {
                job_id: ev.job_id.clone(),
                adhesion_number: ev.data["adhesion_number"].as_str().unwrap_or_default().to_string(),
                result_status: ev.data["result_status"].as_str().map(str::to_string),
                external_operation_id: ev.data["external_operation_id"].as_str().map(str::to_string),
            };
            let mut items = load_pending(&state.data_dir);
            items.push(pr);
            if let Err(e) = save_pending(&state.data_dir, &items) {
                tracing::error!(code = %e.code(), "falha ao salvar resultado local");
            }
            tracing::info!(job_id = %ev.job_id, "proposta concluída pelo motor");
            finish_current(state).await;
            flush_pending(state).await;
        }
        "failed" => {
            let args = json!({
                "p_job_id": ev.job_id,
                "p_error_code": ev.data["error_code"].as_str().unwrap_or("ENGINE_ERROR"),
                "p_error_message": ev.data["message"].as_str(),
                "p_retryable": ev.data["retryable"].as_bool().unwrap_or(false),
            });
            if let Err(e) = report(state, "fail_job", args).await {
                tracing::error!(code = %e.code(), "falha não registrada; a reserva expirará e o banco recupera");
            }
            finish_current(state).await;
        }
        "escalated" => {
            let args = json!({
                "p_job_id": ev.job_id,
                "p_reason_code": ev.data["reason_code"].as_str().unwrap_or("NEEDS_HUMAN"),
                "p_message": ev.data["message"].as_str(),
            });
            if let Err(e) = report(state, "escalate_job", args).await {
                tracing::error!(code = %e.code(), "escalonamento não registrado");
            }
            finish_current(state).await;
        }
        other => tracing::warn!(kind = other, "tipo de evento desconhecido"),
    }
}

async fn finish_current(state: &AppState) {
    let mut st = state.status.write().await;
    st.current = None;
    st.processed_since_start += 1;
    drop(st);
    state.wake.notify_one();
}

async fn on_engine_crash(state: &Arc<AppState>) {
    let current = state.status.write().await.current.take();
    if let Some(c) = current {
        let (func, args) = if c.side_effect {
            ("escalate_job", json!({ "p_job_id": c.job_id, "p_reason_code": "ENGINE_CRASHED_AFTER_SIDE_EFFECT", "p_message": null }))
        } else {
            ("fail_job", json!({ "p_job_id": c.job_id, "p_error_code": "ENGINE_CRASHED", "p_error_message": null, "p_retryable": true }))
        };
        let _ = report(state, func, args).await;
    }
}

/// Envia resultados guardados localmente. complete_job é idempotente no servidor.
pub async fn flush_pending(state: &AppState) {
    let items = load_pending(&state.data_dir);
    if items.is_empty() {
        state.status.write().await.pending_results = 0;
        return;
    }
    let mut remaining = Vec::new();
    for item in items {
        let args = json!({
            "p_job_id": item.job_id,
            "p_adhesion_number": item.adhesion_number,
            "p_external_operation_id": item.external_operation_id,
            "p_result_status": item.result_status,
        });
        match report(state, "complete_job", args).await {
            Ok(_) => tracing::info!(job_id = %item.job_id, "resultado confirmado no servidor"),
            // Erro de regra (ex.: número vazio): mantém para tratamento humano, sem perder.
            Err(e) => {
                tracing::error!(job_id = %item.job_id, code = %e.code(), "resultado pendente de confirmação");
                remaining.push(item);
            }
        }
    }
    let _ = save_pending(&state.data_dir, &remaining);
    state.status.write().await.pending_results = remaining.len();
}

// ------------------------------------------------------------------ fila
async fn queue_loop(state: Arc<AppState>) {
    let mut last_heartbeat = 0u64;
    loop {
        let interval = state.config.read().await.poll_interval_s;
        tokio::select! {
            _ = state.wake.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
        }
        if let Err(e) = cycle(&state, &mut last_heartbeat).await {
            let code = e.code();
            if code != "UNAUTHENTICATED" && code != "SUPABASE_NOT_CONFIGURED" {
                tracing::warn!(code = %code, "ciclo da fila falhou");
            }
            set_error(&state, &e).await;
        }
        state.status.write().await.last_cycle_at = Some(now_epoch());
    }
}

async fn block(state: &AppState, reason: &str) {
    state.status.write().await.blocked_reason = Some(reason.to_string());
}

async fn cycle(state: &Arc<AppState>, last_heartbeat: &mut u64) -> AppResult<()> {
    if state.sb.read().await.is_none() {
        block(state, "SUPABASE_NOT_CONFIGURED").await;
        return Ok(());
    }
    let (sb, tok) = match state.client().await {
        Ok(c) => c,
        Err(e) => {
            block(state, "NOT_SIGNED_IN").await;
            return Err(e);
        }
    };
    state.status.write().await.supabase_reachable = Some(true);

    if now_epoch() - *last_heartbeat >= 60 {
        let channel = state.channel;
        sb.rpc::<Value>(&tok, "report_backoffice_heartbeat",
            json!({ "p_app_version": env!("CARGO_PKG_VERSION"), "p_channel": channel })).await?;
        *last_heartbeat = now_epoch();
    }

    flush_pending(state).await;
    sb.rpc::<Value>(&tok, "acknowledge_received_requests", json!({})).await?;

    if state.config.read().await.worker_paused {
        block(state, "PAUSED").await;
        return Ok(());
    }
    if state.status.read().await.current.is_some() {
        block(state, "BUSY").await;
        return Ok(());
    }
    if state.status.read().await.pending_results > 0 {
        block(state, "PENDING_RESULTS").await;
        return Ok(());
    }

    let engine = match state.engine().await {
        Ok(e) => e,
        Err(_) => {
            block(state, "ENGINE_UNAVAILABLE").await;
            return Ok(());
        }
    };
    let health = engine.call("engine.health", json!({}), 15).await?;
    {
        let mut st = state.status.write().await;
        st.workflow_ready = health["workflow_ready"].as_bool().unwrap_or(false);
        st.consig_session = health["session"].as_str().unwrap_or("unknown").to_string();
        st.ai_state = health["ai"].as_str().unwrap_or("unknown").to_string();
    }
    if !health["workflow_ready"].as_bool().unwrap_or(false) {
        block(state, "WORKFLOW_NOT_READY").await;
        return Ok(());
    }
    if health["session"] != "authenticated" {
        block(state, "CONSIG_SESSION_REQUIRED").await;
        return Ok(());
    }

    let claimed: Value = sb.rpc(&tok, "claim_next_job",
        json!({ "p_worker_id": worker_id(), "p_app_version": env!("CARGO_PKG_VERSION") })).await?;
    if claimed.is_null() {
        block(state, "QUEUE_EMPTY").await;
        return Ok(());
    }
    state.status.write().await.blocked_reason = None;
    let job_id = claimed["job_id"].as_str().unwrap_or_default().to_string();
    state.status.write().await.current = Some(CurrentJob {
        job_id: job_id.clone(),
        request_id: claimed["request_id"].as_str().unwrap_or_default().to_string(),
        public_ref: claimed["public_ref"].as_str().unwrap_or_default().to_string(),
        step: None,
        side_effect: false,
        started_at: now_epoch(),
    });
    tracing::info!(job_id = %job_id, "job reservado");

    let start = async {
        sb.rpc::<Value>(&tok, "mark_job_running", json!({ "p_job_id": job_id })).await?;
        let params = json!({
            "job_id": claimed["job_id"], "request_id": claimed["request_id"], "public_ref": claimed["public_ref"],
            "attempt": claimed["attempt"], "form_version": claimed["form_version"],
            "fields": claimed["fields"], "payload": claimed["payload"], "deadline_s": 900,
        });
        engine.call("job.execute", params, 30).await
    };
    if let Err(e) = start.await {
        tracing::warn!(job_id = %job_id, code = %e.code(), "job não iniciado; liberando");
        let _ = sb.rpc::<Value>(&tok, "release_job", json!({ "p_job_id": job_id, "p_reason_code": e.code() })).await;
        state.status.write().await.current = None;
        return Err(e);
    }
    Ok(())
}

fn worker_id() -> String {
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "backoffice".into());
    host.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(60).collect()
}

// ------------------------------------------------------------------ realtime
async fn realtime_loop(state: Arc<AppState>) {
    let mut backoff = 2u64;
    loop {
        let ready = async {
            let (sb, tok) = state.client().await.ok()?;
            Some((realtime::socket_url(sb.base_url(), sb.anon_key()), tok))
        }
        .await;
        match ready {
            Some((url, tok)) => {
                match realtime::run_once(&url, &tok, &state.wake, &state.realtime_connected).await {
                    Ok(()) => backoff = 2,
                    Err(e) => tracing::warn!(error = %e.chars().take(120).collect::<String>(), "realtime desconectado"),
                }
                state.realtime_connected.store(false, Ordering::Relaxed);
                state.wake.notify_one(); // consulta logo após reconectar: nada se perde
            }
            None => backoff = 10,
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_results_survive_restart() {
        let dir = std::env::temp_dir().join(format!("fic-pending-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_pending(&dir).is_empty());
        let item = PendingResult { job_id: "j".into(), adhesion_number: "ADE-1".into(), result_status: None, external_operation_id: None };
        save_pending(&dir, std::slice::from_ref(&item)).unwrap();
        assert_eq!(load_pending(&dir), vec![item]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn worker_id_is_sanitized() {
        assert!(worker_id().chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    }
}
