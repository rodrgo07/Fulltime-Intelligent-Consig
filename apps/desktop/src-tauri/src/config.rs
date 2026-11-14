//! Configuração NÃO secreta do app (arquivo JSON na pasta de configuração do usuário).
//! Segredos (refresh token) ficam no Windows Credential Manager — ver secrets.rs.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AiConfig {
    pub enabled: bool,
    pub model: Option<String>,
    pub timeout_s: f64,
    pub min_free_ram_mb: u32,
    pub max_cpu_percent: f64,
    pub min_confidence: f64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self { enabled: false, model: None, timeout_s: 90.0, min_free_ram_mb: 1500, max_cpu_percent: 85.0, min_confidence: 0.8 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppConfig {
    pub supabase_url: String,
    /// Chave pública (anon). Não é segredo, mas a UI só a exibe mascarada.
    pub supabase_anon_key: String,
    pub consig_start_url: String,
    pub poll_interval_s: u64,
    pub log_level: String,
    pub autostart: bool,
    pub start_minimized: bool,
    pub intro_seen: bool,
    pub session_max_hours: u64,
    pub worker_paused: bool,
    pub ai: AiConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            supabase_url: String::new(),
            supabase_anon_key: String::new(),
            consig_start_url: String::new(),
            poll_interval_s: 30,
            log_level: "INFO".into(),
            autostart: true,
            start_minimized: false,
            intro_seen: false,
            session_max_hours: 24,
            worker_paused: false,
            ai: AiConfig::default(),
        }
    }
}

impl AppConfig {
    pub fn supabase_configured(&self) -> bool {
        !self.supabase_url.is_empty() && !self.supabase_anon_key.is_empty()
    }

    /// Validação central: toda alteração vinda da UI passa por aqui.
    pub fn validate(&self) -> AppResult<()> {
        if !self.supabase_url.is_empty() {
            let u = url::Url::parse(&self.supabase_url).map_err(|_| AppError::Code("INVALID_SUPABASE_URL"))?;
            let local = matches!(u.host_str(), Some("127.0.0.1") | Some("localhost"));
            if !(u.scheme() == "https" || (local && u.scheme() == "http")) || u.path() != "/" || u.query().is_some() {
                return Err(AppError::Code("INVALID_SUPABASE_URL"));
            }
        }
        if !self.supabase_anon_key.is_empty() {
            let looks_like_key = self.supabase_anon_key.len() <= 4096
                && self.supabase_anon_key.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
            if !looks_like_key {
                return Err(AppError::Code("INVALID_ANON_KEY"));
            }
            check_public_key(&self.supabase_anon_key)?;
        }
        if !self.consig_start_url.is_empty() && !self.consig_start_url.starts_with("https://") {
            return Err(AppError::Code("INVALID_CONSIG_URL"));
        }
        if !(10..=600).contains(&self.poll_interval_s) {
            return Err(AppError::Code("INVALID_POLL_INTERVAL"));
        }
        if !["DEBUG", "INFO", "WARNING", "ERROR"].contains(&self.log_level.as_str()) {
            return Err(AppError::Code("INVALID_LOG_LEVEL"));
        }
        if !(1..=168).contains(&self.session_max_hours) {
            return Err(AppError::Code("INVALID_SESSION_HOURS"));
        }
        let ai = &self.ai;
        if !(5.0..=600.0).contains(&ai.timeout_s) || ai.min_free_ram_mb < 256 || !(1.0..=100.0).contains(&ai.max_cpu_percent)
            || !(0.5..=1.0).contains(&ai.min_confidence)
        {
            return Err(AppError::Code("INVALID_AI_LIMITS"));
        }
        Ok(())
    }

    pub fn masked(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap_or_default();
        v["supabase_anon_key"] = serde_json::Value::String(mask(&self.supabase_anon_key));
        v
    }
}

pub fn mask(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let tail: String = s.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("••••••••{tail}")
}

/// Só chaves públicas entram no app: `sb_publishable_…` (chave nova) ou o JWT legado com papel `anon`.
/// `sb_secret_…` e o JWT `service_role` dão SERVICE_ROLE_FORBIDDEN; qualquer outra coisa (outros
/// subtipos `sb_`, JWT de usuário, texto solto) dá INVALID_ANON_KEY.
pub fn check_public_key(key: &str) -> AppResult<()> {
    let role = jwt_role(key);
    if key.starts_with("sb_secret_") || role.as_deref() == Some("service_role") {
        // Nunca aceitar a service_role em um aplicativo distribuído.
        return Err(AppError::Code("SERVICE_ROLE_FORBIDDEN"));
    }
    let publishable = key.len() > "sb_publishable_".len() && key.starts_with("sb_publishable_");
    if publishable || role.as_deref() == Some("anon") {
        Ok(())
    } else {
        Err(AppError::Code("INVALID_ANON_KEY"))
    }
}

/// Papel declarado num JWT do Supabase (sem validar assinatura; só para bloquear service_role).
pub fn jwt_role(token: &str) -> Option<String> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("role")?.as_str().map(str::to_string)
}

pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("config.json") }
    }

    pub fn load(&self) -> AppConfig {
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// Escrita atômica (arquivo temporário + rename).
    pub fn save(&self, cfg: &AppConfig) -> AppResult<()> {
        cfg.validate()?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(role: &str) -> String {
        use base64::Engine;
        let p = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"role":"{role}"}}"#));
        format!("eyJhbGciOiJIUzI1NiJ9.{p}.sig")
    }

    #[test]
    fn rejects_service_role_key() {
        let mut c = AppConfig { supabase_url: "https://abc.supabase.co".into(), ..Default::default() };
        c.supabase_anon_key = jwt("service_role");
        assert_eq!(c.validate().unwrap_err().code(), "SERVICE_ROLE_FORBIDDEN");
        c.supabase_anon_key = "sb_secret_abc".into();
        assert_eq!(c.validate().unwrap_err().code(), "SERVICE_ROLE_FORBIDDEN");
        c.supabase_anon_key = jwt("anon");
        assert!(c.validate().is_ok());
    }

    #[test]
    fn accepts_only_public_keys() {
        let mut c = AppConfig { supabase_url: "https://abc.supabase.co".into(), ..Default::default() };
        // Chave nova publicável (valor fictício).
        c.supabase_anon_key = "sb_publishable_FAKE0000000000000000_abcdEFGH".into();
        assert!(c.validate().is_ok());
        // Chave secreta nova, inclusive nomeada, e o JWT legado service_role.
        for k in ["sb_secret_FAKE0000000000000000_abcdEFGH".to_string(), jwt("service_role")] {
            c.supabase_anon_key = k;
            assert_eq!(c.validate().unwrap_err().code(), "SERVICE_ROLE_FORBIDDEN");
        }
        // Prefixo sem corpo, subtipo desconhecido, JWT de usuário e texto qualquer.
        for k in ["sb_publishable_".to_string(), "sb_temp_abc".into(), jwt("authenticated"), "qualquer-coisa".into()] {
            c.supabase_anon_key = k;
            assert_eq!(c.validate().unwrap_err().code(), "INVALID_ANON_KEY");
        }
    }

    #[test]
    fn rejects_insecure_urls() {
        let c = AppConfig { supabase_url: "http://abc.supabase.co".into(), ..Default::default() };
        assert!(c.validate().is_err());
        let c = AppConfig { supabase_url: "https://abc.supabase.co/rest?x=1".into(), ..Default::default() };
        assert!(c.validate().is_err());
        let c = AppConfig { consig_start_url: "http://consig".into(), ..Default::default() };
        assert!(c.validate().is_err());
        let c = AppConfig { supabase_url: "http://127.0.0.1:54321".into(), ..Default::default() };
        assert!(c.validate().is_ok());
    }

    #[test]
    fn masks_key() {
        assert_eq!(mask("abcdefghij"), "••••••••ghij");
        let c = AppConfig { supabase_anon_key: "segredo-1234".into(), ..Default::default() };
        assert_eq!(c.masked()["supabase_anon_key"], "••••••••1234");
    }

    #[test]
    fn roundtrip_atomic_save() {
        let dir = std::env::temp_dir().join(format!("fic-cfg-{}", std::process::id()));
        let store = ConfigStore::new(&dir);
        let mut c = store.load();
        c.poll_interval_s = 45;
        store.save(&c).unwrap();
        assert_eq!(store.load().poll_interval_s, 45);
        c.poll_interval_s = 1;
        assert!(store.save(&c).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
