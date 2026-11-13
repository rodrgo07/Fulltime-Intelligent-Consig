//! Segredos locais no Windows Credential Manager (protegido por DPAPI do usuário do Windows).
//! Guarda somente o refresh token da sessão do backoffice e o horário do login.

use crate::error::{AppError, AppResult};
use keyring::Entry;

pub struct Secrets {
    service: String,
}

#[derive(Debug, Clone)]
pub struct StoredSession {
    pub refresh_token: String,
    pub login_epoch: u64,
}

impl Secrets {
    pub fn new(channel: &str) -> Self {
        Self { service: format!("FulltimeIntelligentConsig/{channel}") }
    }

    fn entry(&self) -> AppResult<Entry> {
        Entry::new(&self.service, "backoffice-session").map_err(|_| AppError::Code("CREDENTIAL_STORE_UNAVAILABLE"))
    }

    pub fn save_session(&self, s: &StoredSession) -> AppResult<()> {
        self.entry()?
            .set_password(&format!("{}|{}", s.login_epoch, s.refresh_token))
            .map_err(|_| AppError::Code("CREDENTIAL_STORE_UNAVAILABLE"))
    }

    pub fn load_session(&self) -> Option<StoredSession> {
        let raw = self.entry().ok()?.get_password().ok()?;
        let (epoch, token) = raw.split_once('|')?;
        Some(StoredSession { refresh_token: token.to_string(), login_epoch: epoch.parse().ok()? })
    }

    pub fn clear_session(&self) {
        if let Ok(e) = self.entry() {
            let _ = e.delete_credential();
        }
    }
}
