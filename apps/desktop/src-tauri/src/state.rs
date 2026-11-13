use crate::auth::Auth;
use crate::config::{AppConfig, ConfigStore};
use crate::engine::Engine;
use crate::error::{AppError, AppResult};
use crate::supabase::Supabase;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::{Notify, RwLock};

#[derive(Debug, Clone, Serialize, Default)]
pub struct CurrentJob {
    pub job_id: String,
    pub request_id: String,
    pub public_ref: String,
    pub step: Option<String>,
    pub side_effect: bool,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct WorkerStatus {
    pub engine_state: String,
    pub engine_version: Option<String>,
    pub workflow_ready: bool,
    pub consig_session: String,
    pub ai_state: String,
    pub supabase_reachable: Option<bool>,
    pub last_cycle_at: Option<u64>,
    pub last_error: Option<String>,
    /// Motivo de a fila não estar sendo processada agora (código estável).
    pub blocked_reason: Option<String>,
    pub current: Option<CurrentJob>,
    pub pending_results: usize,
    pub processed_since_start: u64,
}

pub struct AppState {
    pub channel: &'static str,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub config_store: ConfigStore,
    pub config: RwLock<AppConfig>,
    pub auth: Auth,
    pub sb: RwLock<Option<Supabase>>,
    pub engine: RwLock<Option<Arc<Engine>>>,
    pub status: RwLock<WorkerStatus>,
    pub wake: Notify,
    pub engine_restart: Notify,
    pub realtime_connected: Arc<AtomicBool>,
}

impl AppState {
    pub async fn supabase(&self) -> AppResult<Supabase> {
        self.sb.read().await.clone().ok_or(AppError::Code("SUPABASE_NOT_CONFIGURED"))
    }

    /// Cliente + token válido (com MFA) para chamadas autenticadas.
    pub async fn client(&self) -> AppResult<(Supabase, String)> {
        let sb = self.supabase().await?;
        let max = self.config.read().await.session_max_hours;
        let token = self.auth.access_token(&sb, max).await?;
        Ok((sb, token))
    }

    pub async fn engine(&self) -> AppResult<Arc<Engine>> {
        self.engine.read().await.clone().ok_or(AppError::Code("ENGINE_UNAVAILABLE"))
    }

    pub async fn rebuild_client(&self) {
        let cfg = self.config.read().await.clone();
        *self.sb.write().await = if cfg.supabase_configured() { Supabase::new(&cfg.supabase_url, &cfg.supabase_anon_key).ok() } else { None };
    }
}
