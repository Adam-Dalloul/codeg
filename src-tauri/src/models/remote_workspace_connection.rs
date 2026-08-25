use chrono::{DateTime, Utc};
use http::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteWorkspaceHeader {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
}

impl RemoteWorkspaceHeader {
    pub fn to_header_pair(&self) -> Result<(HeaderName, HeaderValue), http::Error> {
        Ok((self.name.trim().try_into()?, self.value.trim().try_into()?))
    }
}

pub trait ToHeaderMap {
    fn to_header_map(&self) -> HeaderMap;
}

impl ToHeaderMap for [RemoteWorkspaceHeader] {
    fn to_header_map(&self) -> HeaderMap {
        self.iter()
            .filter_map(|header| header.to_header_pair().ok())
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteWorkspaceConnectionInfo {
    pub id: i32,
    pub name: String,
    pub base_url: String,
    pub token: String,
    #[serde(default)]
    pub headers: Vec<RemoteWorkspaceHeader>,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
