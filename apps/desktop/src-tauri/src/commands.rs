//! Comandos chamados pela interface. Cada um valida sua entrada; regras de negócio ficam no
//! banco (funções SQL) e no motor — aqui só há orquestração e validação de fronteira.

use crate::auth::AuthStatus;
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, WorkerStatus};
use crate::worker;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;

type S<'a> = State<'a, Arc<AppState>>;

const STATUSES: [&str; 8] = ["received", "queued", "preparing", "running", "awaiting_confirmation", "completed", "failed", "cancelled"];

fn uuid(s: &str) -> AppResult<&str> {
    let ok = s.len() == 36 && s.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() });
    if ok { Ok(s) } else { Err(AppError::Code("INVALID_ID")) }
}

fn bounded(s: &str, max: usize) -> AppResult<String> {
    let t = s.trim();
    if t.chars().count() > max || t.chars().any(|c| c.is_control()) {
        return Err(AppError::Code("INVALID_INPUT"));
    }
    Ok(t.to_string())
}

// ---------------------------------------------------------------- app / config
#[tauri::command]
pub async fn app_info(app: AppHandle, state: S<'_>) -> AppResult<Value> {
    Ok(json!({
        "version": app.package_info().version.to_string(),
        "channel": state.channel,
        "identifier": app.config().identifier,
        "data_dir": state.data_dir,
        "log_dir": state.log_dir,
        "intro_seen": state.config.read().await.intro_seen,
    }))
}

#[tauri::command]
pub async fn config_get(state: S<'_>) -> AppResult<Value> {
    Ok(state.config.read().await.masked())
}

/// Aplica um patch parcial. Campos mascarados vindos da UI são ignorados (não sobrescrevem o valor real).
#[tauri::command]
pub async fn config_update(app: AppHandle, state: S<'_>, patch: Value) -> AppResult<Value> {
    let current = state.config.read().await.clone();
    let mut merged = serde_json::to_value(&current)?;
    let Value::Object(map) = patch else { return Err(AppError::Code("INVALID_INPUT")) };
    for (k, v) in map {
        if !merged.as_object().is_some_and(|m| m.contains_key(&k)) || k == "intro_seen" {
            return Err(AppError::Code("UNKNOWN_SETTING"));
        }
        if k == "supabase_anon_key" && v.as_str().is_some_and(|s| s.starts_with('•')) {
            continue;
        }
        merged[k] = v;
    }
    let cfg: AppConfig = serde_json::from_value(merged).map_err(|_| AppError::Code("INVALID_INPUT"))?;
    state.config_store.save(&cfg)?;
    let supabase_changed = cfg.supabase_url != current.supabase_url || cfg.supabase_anon_key != current.supabase_anon_key;
    *state.config.write().await = cfg.clone();
    if supabase_changed {
        state.auth.logout(None).await;
        state.rebuild_client().await;
    }
    if cfg.autostart != current.autostart {
        let al = app.autolaunch();
        let _ = if cfg.autostart { al.enable() } else { al.disable() };
    }
    tracing::info!("configuração atualizada");
    state.wake.notify_one();
    Ok(cfg.masked())
}

#[tauri::command]
pub async fn intro_mark_seen(state: S<'_>) -> AppResult<()> {
    let mut cfg = state.config.read().await.clone();
    cfg.intro_seen = true;
    state.config_store.save(&cfg)?;
    *state.config.write().await = cfg;
    Ok(())
}

// ---------------------------------------------------------------- autenticação
#[tauri::command]
pub async fn auth_status(state: S<'_>) -> AppResult<AuthStatus> {
    let sb = state.sb.read().await.clone();
    Ok(state.auth.status(sb.as_ref()).await)
}

#[tauri::command]
pub async fn auth_login(state: S<'_>, email: String, password: String) -> AppResult<AuthStatus> {
    let sb = state.supabase().await?;
    let st = state.auth.login(&sb, &email, &password).await;
    if st.is_err() {
        tracing::warn!("tentativa de login recusada");
    }
    st
}

#[tauri::command]
pub async fn auth_mfa_enroll(state: S<'_>) -> AppResult<Value> {
    let sb = state.supabase().await?;
    let (factor_id, qr) = state.auth.mfa_enroll(&sb).await?;
    Ok(json!({ "factor_id": factor_id, "qr_code": qr }))
}

#[tauri::command]
pub async fn auth_mfa_verify(state: S<'_>, code: String, factor_id: Option<String>) -> AppResult<AuthStatus> {
    let sb = state.supabase().await?;
    if let Some(f) = &factor_id {
        uuid(f)?;
    }
    let st = state.auth.mfa_verify(&sb, factor_id, code.trim()).await?;
    tracing::info!("login do backoffice concluído com MFA");
    state.wake.notify_one();
    Ok(st)
}

#[tauri::command]
pub async fn auth_logout(state: S<'_>) -> AppResult<()> {
    let sb = state.sb.read().await.clone();
    state.auth.logout(sb.as_ref()).await;
    tracing::info!("logout do backoffice");
    Ok(())
}

// ---------------------------------------------------------------- operação
#[tauri::command]
pub async fn worker_status(state: S<'_>) -> AppResult<WorkerStatus> {
    Ok(state.status.read().await.clone())
}

#[tauri::command]
pub async fn worker_set_paused(state: S<'_>, paused: bool) -> AppResult<()> {
    let mut cfg = state.config.read().await.clone();
    cfg.worker_paused = paused;
    state.config_store.save(&cfg)?;
    *state.config.write().await = cfg;
    tracing::info!(paused, "fila {}", if paused { "pausada" } else { "retomada" });
    state.wake.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn dashboard(state: S<'_>) -> AppResult<Value> {
    let worker = state.status.read().await.clone();
    let realtime = state.realtime_connected.load(Ordering::Relaxed);
    let (sb, tok) = state.client().await?;
    let rows = sb.select(&tok, "proposal_requests?select=status&limit=10000").await?;
    let mut counts = serde_json::Map::new();
    for s in STATUSES {
        counts.insert(s.into(), json!(0));
    }
    for r in rows.as_array().into_iter().flatten() {
        if let Some(s) = r["status"].as_str() {
            let n = counts.get(s).and_then(Value::as_u64).unwrap_or(0) + 1;
            counts.insert(s.into(), json!(n));
        }
    }
    let storage = sb.rpc::<Value>(&tok, "storage_usage", json!({})).await.ok();
    let recent = sb.select(&tok, "audit_logs?select=occurred_at,action,actor_role,request_id&order=occurred_at.desc&limit=25").await.unwrap_or(json!([]));
    Ok(json!({ "counts": counts, "storage": storage, "worker": worker, "realtime_connected": realtime, "recent_activity": recent }))
}

const REQUEST_SELECT: &str = "id,public_ref,status,status_reason,received_at,updated_at,completed_at,pii_expires_at,pii_purged_at,form_version,\
submitter:operators!proposal_requests_submitted_by_fkey(operator_code),\
owner:operators!proposal_requests_owner_operator_id_fkey(operator_code),\
proposal_results(adhesion_number,result_status,completed_at,source),\
automation_jobs(id,attempt,status,current_step,error_code,error_message,created_at,finished_at,side_effect_started_at)";

#[tauri::command]
pub async fn requests_list(state: S<'_>, status: Option<String>, limit: Option<u32>) -> AppResult<Value> {
    let (sb, tok) = state.client().await?;
    let mut q = format!("proposal_requests?select={REQUEST_SELECT}&order=received_at.desc&limit={}", limit.unwrap_or(200).min(500));
    if let Some(s) = status {
        if !STATUSES.contains(&s.as_str()) {
            return Err(AppError::Code("INVALID_STATUS"));
        }
        q.push_str(&format!("&status=eq.{s}"));
    }
    sb.select(&tok, &q).await
}

#[tauri::command]
pub async fn request_detail(state: S<'_>, id: String) -> AppResult<Value> {
    let id = uuid(&id)?;
    let (sb, tok) = state.client().await?;
    let req = sb.select(&tok, &format!("proposal_requests?select={REQUEST_SELECT}&id=eq.{id}")).await?;
    let audit = sb.select(&tok, &format!("audit_logs?select=occurred_at,action,actor_role,details&request_id=eq.{id}&order=occurred_at.asc")).await?;
    let notif = sb.select(&tok, &format!("notification_queue?select=status,attempts,last_error,sent_at,next_attempt_at&request_id=eq.{id}")).await?;
    Ok(json!({ "request": req.get(0), "audit": audit, "notifications": notif }))
}

#[tauri::command]
pub async fn request_resolve(state: S<'_>, id: String, resolution: String, adhesion_number: Option<String>,
                             result_status: Option<String>, note: Option<String>) -> AppResult<Value> {
    let id = uuid(&id)?;
    if !["completed", "requeue", "failed"].contains(&resolution.as_str()) {
        return Err(AppError::Code("INVALID_RESOLUTION"));
    }
    let adhesion = adhesion_number.map(|a| bounded(&a, 64)).transpose()?;
    let status = result_status.map(|a| bounded(&a, 64)).transpose()?;
    let note = note.map(|a| bounded(&a, 300)).transpose()?;
    let (sb, tok) = state.client().await?;
    let r = sb.rpc(&tok, "resolve_awaiting_request", json!({
        "p_request_id": id, "p_resolution": resolution, "p_adhesion_number": adhesion,
        "p_result_status": status, "p_note": note,
    })).await?;
    tracing::info!(request_id = %id, resolution = %resolution, "decisão humana registrada");
    state.wake.notify_one();
    Ok(r)
}

#[tauri::command]
pub async fn request_requeue(state: S<'_>, id: String) -> AppResult<()> {
    let id = uuid(&id)?;
    let (sb, tok) = state.client().await?;
    sb.rpc::<Value>(&tok, "requeue_failed_request", json!({ "p_request_id": id })).await?;
    state.wake.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn request_cancel(state: S<'_>, id: String, reason: String) -> AppResult<()> {
    let id = uuid(&id)?;
    let reason = bounded(&reason, 300)?;
    let (sb, tok) = state.client().await?;
    sb.rpc::<Value>(&tok, "cancel_request_backoffice", json!({ "p_request_id": id, "p_reason": reason })).await?;
    Ok(())
}

// ---------------------------------------------------------------- motor / Consig / IA
#[tauri::command]
pub async fn consig_session_open(state: S<'_>) -> AppResult<Value> {
    let url = state.config.read().await.consig_start_url.clone();
    let params = if url.is_empty() { json!({}) } else { json!({ "start_url": url }) };
    state.engine().await?.call("session.open", params, 120).await
}

#[tauri::command]
pub async fn engine_restart(state: S<'_>) -> AppResult<()> {
    if state.status.read().await.current.is_some() {
        return Err(AppError::Code("JOB_RUNNING"));
    }
    if let Ok(e) = state.engine().await {
        e.shutdown().await;
    }
    state.engine_restart.notify_one();
    Ok(())
}

// ---------------------------------------------------------------- logs e diagnóstico
#[tauri::command]
pub async fn logs_tail(state: S<'_>, level: Option<String>, limit: Option<usize>) -> AppResult<Vec<Value>> {
    let min = match level.as_deref() { Some("DEBUG") => 0, Some("WARNING") | Some("WARN") => 2, Some("ERROR") => 3, _ => 1 };
    let rank = |l: &str| match l { "DEBUG" | "TRACE" => 0, "INFO" => 1, "WARN" | "WARNING" => 2, _ => 3 };
    let mut files: Vec<_> = std::fs::read_dir(&state.log_dir)?.flatten().map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "log")).collect();
    files.sort();
    let Some(last) = files.last() else { return Ok(vec![]) };
    let text = std::fs::read_to_string(last)?;
    let mut out: Vec<Value> = text.lines().rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| rank(v["level"].as_str().unwrap_or("INFO")) >= min)
        .take(limit.unwrap_or(300).min(2000))
        .collect();
    out.reverse();
    Ok(out)
}

#[tauri::command]
pub async fn diagnostics(app: AppHandle, state: S<'_>) -> AppResult<Value> {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let chrome = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe".to_string(),
        format!(r"{local}\Google\Chrome\Application\chrome.exe"),
    ].iter().any(|p| std::path::Path::new(p).is_file());
    let sb = state.sb.read().await.clone();
    let reachable = match &sb { Some(s) => Some(s.ping().await), None => None };
    let engine = state.engine.read().await.clone();
    Ok(json!({
        "app_version": app.package_info().version.to_string(),
        "channel": state.channel,
        "os": format!("{} {}", System::name().unwrap_or_default(), System::os_version().unwrap_or_default()),
        "total_ram_mb": sys.total_memory() / 1_048_576,
        "available_ram_mb": sys.available_memory() / 1_048_576,
        "cpu_count": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "chrome_installed": chrome,
        "supabase_configured": sb.is_some(),
        "supabase_reachable": reachable,
        "realtime_connected": state.realtime_connected.load(Ordering::Relaxed),
        "engine_pid": engine.as_ref().and_then(|e| e.pid),
        "engine_path": crate::engine::engine_path(),
        "data_dir": state.data_dir,
        "log_dir": state.log_dir,
        "pending_results": worker::load_pending(&state.data_dir).len(),
    }))
}

// ---------------------------------------------------------------- atualização
#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<Value> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|_| AppError::Code("UPDATER_NOT_CONFIGURED"))?;
    match updater.check().await {
        Ok(Some(u)) => Ok(json!({ "current": current, "available": u.version, "notes": u.body, "date": u.date.map(|d| d.to_string()) })),
        Ok(None) => Ok(json!({ "current": current, "available": null })),
        Err(e) => {
            let msg = e.to_string();
            tracing::warn!(error = %msg.chars().take(120).collect::<String>(), "verificação de atualização falhou");
            Err(AppError::Code(if msg.contains("endpoint") || msg.contains("pubkey") { "UPDATER_NOT_CONFIGURED" } else { "UPDATE_CHECK_FAILED" }))
        }
    }
}

/// Baixa, verifica a assinatura (minisign, chave pública embutida) e instala. Nunca durante um job.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: S<'_>) -> AppResult<()> {
    if state.status.read().await.current.is_some() {
        return Err(AppError::Code("JOB_RUNNING"));
    }
    let updater = app.updater().map_err(|_| AppError::Code("UPDATER_NOT_CONFIGURED"))?;
    let update = updater.check().await.map_err(|_| AppError::Code("UPDATE_CHECK_FAILED"))?.ok_or(AppError::Code("NO_UPDATE"))?;
    tracing::info!(version = %update.version, "instalando atualização assinada");
    worker_set_paused(state.clone(), true).await?;
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        tracing::error!(error = %e.to_string().chars().take(120).collect::<String>(), "atualização recusada/falhou");
        worker_set_paused(state.clone(), false).await?;
        return Err(AppError::Code("UPDATE_INSTALL_FAILED"));
    }
    // Retoma a fila no próximo início.
    let mut cfg = state.config.read().await.clone();
    cfg.worker_paused = false;
    state.config_store.save(&cfg)?;
    if let Ok(e) = state.engine().await {
        e.shutdown().await;
    }
    app.restart();
}

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        app_info, config_get, config_update, intro_mark_seen,
        auth_status, auth_login, auth_mfa_enroll, auth_mfa_verify, auth_logout,
        worker_status, worker_set_paused, dashboard, requests_list, request_detail,
        request_resolve, request_requeue, request_cancel,
        consig_session_open, engine_restart,
        logs_tail, diagnostics, update_check, update_install
    ]
}

/// Mostra e foca a janela principal (bandeja / segunda instância).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids_and_text() {
        assert!(uuid("7d1b8f0e-5a63-4c55-9c2f-0d7a3f1e2b11").is_ok());
        assert!(uuid("7d1b8f0e-5a63-4c55-9c2f-0d7a3f1e2b11&status=eq.x").is_err());
        assert!(uuid("../../etc").is_err());
        assert!(bounded("ok", 5).is_ok());
        assert!(bounded("123456", 5).is_err());
        assert!(bounded("a\u{0}b", 5).is_err());
    }
}
