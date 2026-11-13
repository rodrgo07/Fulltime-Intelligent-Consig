//! Sessão do usuário backoffice: token de acesso só em memória, refresh token no Credential Manager,
//! renovação automática, exigência de MFA (aal2) e validade máxima configurável.

use crate::error::{AppError, AppResult};
use crate::secrets::{Secrets, StoredSession};
use crate::supabase::{now_epoch, Factor, Supabase, Tokens};
use serde::Serialize;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AuthStatus {
    SignedOut,
    /// Senha correta; falta o segundo fator (ou cadastrá-lo).
    MfaRequired { has_factor: bool },
    SignedIn { email: String, user_id: String, login_epoch: u64 },
}

struct Inner {
    tokens: Option<Tokens>,
    login_epoch: u64,
}

pub struct Auth {
    inner: Mutex<Inner>,
    secrets: Secrets,
}

impl Auth {
    pub fn new(secrets: Secrets) -> Self {
        Self { inner: Mutex::new(Inner { tokens: None, login_epoch: 0 }), secrets }
    }

    pub async fn status(&self, sb: Option<&Supabase>) -> AuthStatus {
        let inner = self.inner.lock().await;
        match &inner.tokens {
            None => AuthStatus::SignedOut,
            Some(t) if t.aal != "aal2" => {
                let has_factor = match sb {
                    Some(sb) => sb.factors(&t.access).await.map(|f| f.iter().any(|x| x.status == "verified")).unwrap_or(false),
                    None => false,
                };
                AuthStatus::MfaRequired { has_factor }
            }
            Some(t) => AuthStatus::SignedIn { email: t.email.clone(), user_id: t.user_id.clone(), login_epoch: inner.login_epoch },
        }
    }

    pub async fn login(&self, sb: &Supabase, email: &str, password: &str) -> AppResult<AuthStatus> {
        if email.len() > 254 || password.len() > 256 || email.is_empty() || password.is_empty() {
            return Err(AppError::Code("INVALID_CREDENTIALS"));
        }
        let t = sb.password_login(email.trim(), password).await.map_err(|e| match e {
            AppError::Api { status: 400, .. } => AppError::Code("INVALID_CREDENTIALS"),
            other => other,
        })?;
        {
            let mut inner = self.inner.lock().await;
            inner.login_epoch = now_epoch();
            inner.tokens = Some(t);
        }
        Ok(self.status(Some(sb)).await)
    }

    pub async fn mfa_enroll(&self, sb: &Supabase) -> AppResult<(String, String)> {
        let access = self.raw_access().await?;
        let factors: Vec<Factor> = sb.factors(&access).await?;
        if factors.iter().any(|f| f.status == "verified") {
            return Err(AppError::Code("MFA_ALREADY_ENROLLED"));
        }
        sb.mfa_enroll(&access).await
    }

    pub async fn mfa_verify(&self, sb: &Supabase, factor_id: Option<String>, code: &str) -> AppResult<AuthStatus> {
        if !(code.len() == 6 && code.chars().all(|c| c.is_ascii_digit())) {
            return Err(AppError::Code("INVALID_TOTP"));
        }
        let access = self.raw_access().await?;
        let factor_id = match factor_id {
            Some(id) => id,
            None => sb.factors(&access).await?.into_iter().find(|f| f.status == "verified")
                .map(|f| f.id).ok_or(AppError::Code("MFA_NOT_ENROLLED"))?,
        };
        let t = sb.mfa_verify(&access, &factor_id, code).await.map_err(|e| match e {
            AppError::Api { status: 400 | 422, .. } => AppError::Code("INVALID_TOTP"),
            other => other,
        })?;
        let mut inner = self.inner.lock().await;
        self.secrets.save_session(&StoredSession { refresh_token: t.refresh.clone(), login_epoch: inner.login_epoch })?;
        inner.tokens = Some(t);
        drop(inner);
        Ok(self.status(Some(sb)).await)
    }

    /// Retoma a sessão salva (após reinício do Windows), respeitando a validade máxima.
    pub async fn resume(&self, sb: &Supabase, max_hours: u64) -> bool {
        let Some(stored) = self.secrets.load_session() else { return false };
        if now_epoch().saturating_sub(stored.login_epoch) > max_hours * 3600 {
            self.secrets.clear_session();
            return false;
        }
        match sb.refresh(&stored.refresh_token).await {
            Ok(t) if t.aal == "aal2" => {
                let _ = self.secrets.save_session(&StoredSession { refresh_token: t.refresh.clone(), login_epoch: stored.login_epoch });
                let mut inner = self.inner.lock().await;
                inner.login_epoch = stored.login_epoch;
                inner.tokens = Some(t);
                true
            }
            Ok(_) | Err(AppError::Api { .. }) => {
                self.secrets.clear_session();
                false
            }
            Err(_) => false, // sem rede: mantém o segredo para tentar de novo
        }
    }

    async fn raw_access(&self) -> AppResult<String> {
        self.inner.lock().await.tokens.as_ref().map(|t| t.access.clone()).ok_or(AppError::Code("UNAUTHENTICATED"))
    }

    /// Token válido com MFA, renovando quando faltar menos de 2 minutos.
    pub async fn access_token(&self, sb: &Supabase, max_hours: u64) -> AppResult<String> {
        let mut inner = self.inner.lock().await;
        let login_epoch = inner.login_epoch;
        let t = inner.tokens.as_ref().ok_or(AppError::Code("UNAUTHENTICATED"))?;
        if t.aal != "aal2" {
            return Err(AppError::Code("MFA_REQUIRED"));
        }
        if now_epoch().saturating_sub(login_epoch) > max_hours * 3600 {
            inner.tokens = None;
            self.secrets.clear_session();
            return Err(AppError::Code("SESSION_EXPIRED"));
        }
        if t.expires_at > now_epoch() + 120 {
            return Ok(t.access.clone());
        }
        let refresh = t.refresh.clone();
        match sb.refresh(&refresh).await {
            Ok(nt) => {
                self.secrets.save_session(&StoredSession { refresh_token: nt.refresh.clone(), login_epoch })?;
                let access = nt.access.clone();
                inner.tokens = Some(nt);
                Ok(access)
            }
            Err(AppError::Api { .. }) => {
                // Sessão revogada (ex.: admin desativou o acesso).
                inner.tokens = None;
                self.secrets.clear_session();
                Err(AppError::Code("SESSION_REVOKED"))
            }
            Err(e) => Err(e),
        }
    }

    pub async fn logout(&self, sb: Option<&Supabase>) {
        let tokens = self.inner.lock().await.tokens.take();
        if let (Some(t), Some(sb)) = (tokens, sb) {
            sb.logout(&t.access).await;
        }
        self.secrets.clear_session();
    }
}
