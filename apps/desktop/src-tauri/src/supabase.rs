//! Cliente HTTP do Supabase (Auth + PostgREST) usado SOMENTE pelo processo nativo.
//! Usa a chave pública (sb_publishable_ ou anon legada) e o JWT do usuário backoffice;
//! a service_role / sb_secret_ nunca existe aqui (Supabase::new recusa).

use crate::error::{AppError, AppResult};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct Supabase {
    http: reqwest::Client,
    url: String,
    anon: String,
}

#[derive(Debug, Clone)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    pub expires_at: u64,
    pub user_id: String,
    pub email: String,
    pub aal: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_at: Option<u64>,
    expires_in: Option<u64>,
    user: TokenUser,
}

#[derive(Deserialize)]
struct TokenUser {
    id: String,
    #[serde(default)]
    email: String,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Factor {
    pub id: String,
    pub factor_type: String,
    pub status: String,
}

pub fn now_epoch() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Lê o "aal" do JWT (a assinatura é verificada pelo servidor em toda chamada).
pub fn jwt_claim(token: &str, claim: &str) -> Option<String> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get(claim)?.as_str().map(str::to_string)
}

impl Supabase {
    pub fn new(url: &str, anon: &str) -> AppResult<Self> {
        // Segunda barreira: config.json editado à mão não passa por AppConfig::validate.
        crate::config::check_public_key(anon)?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .https_only(!url.starts_with("http://127.0.0.1") && !url.starts_with("http://localhost"))
            .user_agent(concat!("fic-desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { http, url: url.trim_end_matches('/').to_string(), anon: anon.to_string() })
    }

    async fn parse<T: DeserializeOwned>(res: reqwest::Response) -> AppResult<T> {
        let status = res.status();
        if status.is_success() {
            let text = res.text().await?;
            let body = if text.is_empty() { "null".to_string() } else { text };
            return Ok(serde_json::from_str(&body)?);
        }
        let body: Value = res.json().await.unwrap_or(Value::Null);
        // PostgREST: {message: "<CÓDIGO>", details}. Auth: {error_code | code | msg}.
        let code = body.get("message").and_then(Value::as_str)
            .filter(|m| m.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') && !m.is_empty())
            .or_else(|| body.get("error_code").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("HTTP_{}", status.as_u16()));
        let details = body.get("details").and_then(Value::as_str).map(|d| d.chars().take(300).collect());
        Err(AppError::Api { code, status: status.as_u16(), details })
    }

    fn tokens(t: TokenResponse) -> Tokens {
        let expires_at = t.expires_at.unwrap_or_else(|| now_epoch() + t.expires_in.unwrap_or(3600));
        let aal = jwt_claim(&t.access_token, "aal").unwrap_or_else(|| "aal1".into());
        Tokens { access: t.access_token, refresh: t.refresh_token, expires_at, user_id: t.user.id, email: t.user.email, aal }
    }

    pub async fn password_login(&self, email: &str, password: &str) -> AppResult<Tokens> {
        let res = self.http.post(format!("{}/auth/v1/token?grant_type=password", self.url))
            .header("apikey", &self.anon)
            .json(&json!({ "email": email, "password": password }))
            .send().await?;
        Ok(Self::tokens(Self::parse(res).await?))
    }

    pub async fn refresh(&self, refresh_token: &str) -> AppResult<Tokens> {
        let res = self.http.post(format!("{}/auth/v1/token?grant_type=refresh_token", self.url))
            .header("apikey", &self.anon)
            .json(&json!({ "refresh_token": refresh_token }))
            .send().await?;
        Ok(Self::tokens(Self::parse(res).await?))
    }

    pub async fn factors(&self, access: &str) -> AppResult<Vec<Factor>> {
        let res = self.http.get(format!("{}/auth/v1/user", self.url))
            .header("apikey", &self.anon).bearer_auth(access).send().await?;
        let user: Value = Self::parse(res).await?;
        Ok(serde_json::from_value(user.get("factors").cloned().unwrap_or(json!([]))).unwrap_or_default())
    }

    /// Cadastra TOTP. Retorna (factor_id, qr_code em data URL SVG).
    pub async fn mfa_enroll(&self, access: &str) -> AppResult<(String, String)> {
        let res = self.http.post(format!("{}/auth/v1/factors", self.url))
            .header("apikey", &self.anon).bearer_auth(access)
            .json(&json!({ "factor_type": "totp", "friendly_name": format!("backoffice-{}", now_epoch()) }))
            .send().await?;
        let v: Value = Self::parse(res).await?;
        let id = v["id"].as_str().ok_or(AppError::Code("MFA_ENROLL_FAILED"))?.to_string();
        let qr = v["totp"]["qr_code"].as_str().ok_or(AppError::Code("MFA_ENROLL_FAILED"))?.to_string();
        Ok((id, qr))
    }

    pub async fn mfa_verify(&self, access: &str, factor_id: &str, code: &str) -> AppResult<Tokens> {
        let res = self.http.post(format!("{}/auth/v1/factors/{factor_id}/challenge", self.url))
            .header("apikey", &self.anon).bearer_auth(access).send().await?;
        let ch: Value = Self::parse(res).await?;
        let challenge_id = ch["id"].as_str().ok_or(AppError::Code("MFA_CHALLENGE_FAILED"))?;
        let res = self.http.post(format!("{}/auth/v1/factors/{factor_id}/verify", self.url))
            .header("apikey", &self.anon).bearer_auth(access)
            .json(&json!({ "challenge_id": challenge_id, "code": code }))
            .send().await?;
        Ok(Self::tokens(Self::parse(res).await?))
    }

    pub async fn logout(&self, access: &str) {
        let _ = self.http.post(format!("{}/auth/v1/logout?scope=local", self.url))
            .header("apikey", &self.anon).bearer_auth(access).send().await;
    }

    pub async fn rpc<T: DeserializeOwned>(&self, access: &str, func: &str, args: Value) -> AppResult<T> {
        let res = self.http.post(format!("{}/rest/v1/rpc/{func}", self.url))
            .header("apikey", &self.anon).bearer_auth(access)
            .json(&args).send().await?;
        Self::parse(res).await
    }

    /// GET em uma tabela/visão com query PostgREST já montada (sem dados pessoais na URL).
    pub async fn select(&self, access: &str, path_and_query: &str) -> AppResult<Value> {
        let res = self.http.get(format!("{}/rest/v1/{path_and_query}", self.url))
            .header("apikey", &self.anon).bearer_auth(access).send().await?;
        Self::parse(res).await
    }

    pub async fn ping(&self) -> bool {
        self.http.get(format!("{}/auth/v1/health", self.url)).header("apikey", &self.anon)
            .timeout(Duration::from_secs(8)).send().await.map(|r| r.status().is_success()).unwrap_or(false)
    }
}

#[cfg(test)]
mod key_tests {
    use super::*;

    #[test]
    fn client_refuses_secret_keys_even_without_config_validation() {
        let err = Supabase::new("https://abc.supabase.co", "sb_secret_FAKE0000000000000000_abcd").err().unwrap();
        assert_eq!(err.code(), "SERVICE_ROLE_FORBIDDEN");
        assert!(Supabase::new("https://abc.supabase.co", "sb_publishable_FAKE0000000000000000_abcd").is_ok());
    }
}
