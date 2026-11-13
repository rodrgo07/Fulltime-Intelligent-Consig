use serde::{Serialize, Serializer};

/// Erro único da camada nativa. Serializa para a UI apenas um código estável e um detalhe curto
/// (nunca tokens, URLs com segredos ou dados de cliente).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Code(&'static str),
    #[error("API:{code}")]
    Api { code: String, status: u16, details: Option<String> },
    #[error("NETWORK")]
    Network(String),
    #[error("ENGINE:{0}")]
    Engine(String),
    #[error("INTERNAL")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> String {
        match self {
            AppError::Code(c) => (*c).to_string(),
            AppError::Api { code, .. } => code.clone(),
            AppError::Network(_) => "NETWORK".into(),
            AppError::Engine(c) => c.clone(),
            AppError::Internal(_) => "INTERNAL".into(),
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        // Sem URL na mensagem: pode conter parâmetros.
        AppError::Network(e.without_url().to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Internal(e.kind().to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(format!("json: {:?}", e.classify()))
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", &self.code())?;
        let detail = match self {
            AppError::Api { details, .. } => details.clone(),
            _ => None,
        };
        st.serialize_field("detail", &detail)?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
