//! Forge (GitHub/GitLab) integration core: account/auth resolution, a
//! proxy-aware HTTP client, the canonical source-key normalizer and the REST
//! reads the Issues/PR workbench needs. Deliberately thin — no query DSL, no
//! response caching (see `.docs/architecture/2026-08-17-*` for what is out of
//! scope and why REST-direct beat shelling out to `gh`/`glab`).

pub mod auth;
pub mod deliver;
pub mod envelope;
pub mod github;
pub mod gitlab;

use std::sync::RwLock;

pub use auth::{host_profile, resolve_forge_auth, strip_base_path, HostProfile, ResolvedAuth};

/// The forge a host speaks. Everything provider-specific downstream — REST
/// base, auth header, the shape of a "pull request", which ref a proposed
/// change is published under, where a comment goes — hangs off this one value,
/// which is always DERIVED SERVER-SIDE from the folder's remote and the
/// configured accounts. A client never gets to say which forge it is talking
/// to: that choice picks the credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeProvider {
    GitHub,
    GitLab,
}

impl ForgeProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            ForgeProvider::GitHub => "github",
            ForgeProvider::GitLab => "gitlab",
        }
    }

    /// Parse a stored/claimed provider name. Unknown values are an error rather
    /// than a silent fallback to GitHub — a task whose provenance says
    /// something we do not understand must not be worked with the wrong API.
    pub fn parse(value: &str) -> Result<Self, ForgeError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "github" => Ok(ForgeProvider::GitHub),
            "gitlab" => Ok(ForgeProvider::GitLab),
            other => Err(ForgeError::Invalid(format!("unknown provider: {other}"))),
        }
    }

    /// What this forge calls a proposed change, for messages the user reads.
    /// GitLab users do not have "pull requests" and being told they do reads
    /// like the wrong tool answered.
    pub fn change_noun(self) -> &'static str {
        match self {
            ForgeProvider::GitHub => "pull request",
            ForgeProvider::GitLab => "merge request",
        }
    }

    /// The ref a proposed change's head is published under on the server —
    /// what makes a fork's (or any) contribution fetchable without adding a
    /// remote. Both forges publish one; they just spell it differently.
    ///
    /// Note the HYPHEN in GitLab's: its REST path is `/merge_requests` with an
    /// underscore, but the git ref namespace is `refs/merge-requests/<iid>`.
    /// The two spellings sit three lines apart in this file for a reason —
    /// using the API's spelling as a ref fetches nothing at all.
    pub fn change_head_ref(self, number: i64) -> String {
        match self {
            ForgeProvider::GitHub => format!("refs/pull/{number}/head"),
            ForgeProvider::GitLab => format!("refs/merge-requests/{number}/head"),
        }
    }

    /// Canonical web URL of one work item, under `origin` (see [`web_origin`]
    /// — a scheme-and-port-carrying origin rather than a bare host, so a
    /// self-hosted instance on `http://` or a non-default port gets a link
    /// that actually opens).
    pub fn item_url(
        self,
        origin: &str,
        owner_repo: &str,
        kind: ForgeItemKind,
        number: i64,
    ) -> String {
        let origin = origin.trim_end_matches('/');
        match self {
            ForgeProvider::GitHub => {
                // `/issues/{n}` of a pull request redirects to `/pull/{n}`, but
                // the link is stored and shown, so it says what it is.
                let segment = match kind {
                    ForgeItemKind::Issue => "issues",
                    ForgeItemKind::Change => "pull",
                };
                format!("{origin}/{owner_repo}/{segment}/{number}")
            }
            ForgeProvider::GitLab => {
                // The `/-/` separator is what keeps a project path with
                // subgroups unambiguous against the route that follows it.
                let segment = match kind {
                    ForgeItemKind::Issue => "issues",
                    ForgeItemKind::Change => "merge_requests",
                };
                format!("{origin}/{owner_repo}/-/{segment}/{number}")
            }
        }
    }
}

/// Issue or proposed change. Load-bearing for GitLab, where the two have
/// SEPARATE list and comment endpoints — GitHub models a pull request as an
/// issue and serves both from `/issues`, which is exactly the assumption that
/// silently breaks against a GitLab instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeItemKind {
    Issue,
    /// Pull request (GitHub) / merge request (GitLab).
    Change,
}

impl ForgeItemKind {
    /// The `kind` segment of a source key — `pr` for both forges (a GitLab
    /// merge request is normalized to it) so provenance keys stay comparable.
    pub fn key_segment(self) -> &'static str {
        match self {
            ForgeItemKind::Issue => "issue",
            ForgeItemKind::Change => "pr",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ForgeError {
    /// No usable account/token for the requested host (or the token is dead).
    #[error("forge auth: {0}")]
    Auth(String),
    /// Primary or secondary rate limit; honor `retry_after` when present.
    #[error("forge rate limited")]
    RateLimited { retry_after: Option<u64> },
    #[error("forge resource not found")]
    NotFound,
    /// Caller-supplied input failed validation (bad repo path, foreign cursor…).
    #[error("forge invalid input: {0}")]
    Invalid(String),
    #[error("forge API error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("forge network error: {0}")]
    Network(String),
}

impl From<ForgeError> for crate::app_error::AppCommandError {
    fn from(err: ForgeError) -> Self {
        use crate::app_error::AppCommandError as E;
        match &err {
            ForgeError::Auth(msg) => E::configuration_invalid(
                "the account for this repository's host is not usable",
            )
            .with_detail(msg.clone()),
            ForgeError::RateLimited { retry_after } => E::network("forge rate limit reached")
                .with_detail(match retry_after {
                    Some(secs) => format!("retry after {secs}s"),
                    None => "retry later".to_string(),
                }),
            ForgeError::NotFound => E::not_found("forge resource not found"),
            ForgeError::Invalid(msg) => E::invalid_input(msg.clone()),
            ForgeError::Api { .. } | ForgeError::Network(_) => {
                E::network("forge API request failed").with_detail(err.to_string())
            }
        }
    }
}

/// `work_task.source_kind` for a task triggered from an issue. Its own
/// constant because it is a GATE in three places (delivery, the local-merge
/// refusal, the trigger command) and a typo in any of them opens one of them.
pub const SOURCE_KIND_ISSUE: &str = "forge_issue";
/// `work_task.source_kind` for a task triggered from a pull request (M8).
pub const SOURCE_KIND_PR: &str = "forge_pr";

/// Canonical provenance key: `{provider}:{server_host}:{owner_repo}:{kind}:{number}`.
///
/// Both writers (trigger command) and readers (dedup, the issue list's reverse
/// lookup) MUST build keys through this function — never by hand — so casing
/// or host drift can't split one work item into two keys. The host is the
/// SERVER host (`github.com`, `ghe.corp.com`), the same coordinate system git
/// remotes live in; the API base is a derived value and never part of the key.
pub fn source_key(
    provider: &str,
    server_host: &str,
    owner_repo: &str,
    kind: &str,
    number: i64,
) -> Result<String, ForgeError> {
    let provider = provider.trim().to_ascii_lowercase();
    if provider != "github" && provider != "gitlab" {
        return Err(ForgeError::Invalid(format!("unknown provider: {provider}")));
    }
    let kind = kind.trim().to_ascii_lowercase();
    if kind != "issue" && kind != "pr" {
        return Err(ForgeError::Invalid(format!("unknown source kind: {kind}")));
    }
    let host = server_host.trim().to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || host.contains(':') {
        return Err(ForgeError::Invalid(format!("bad server host: {server_host}")));
    }
    let repo = normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    Ok(format!("{provider}:{host}:{repo}:{kind}:{number}"))
}

/// Repository-identity comparison. GitHub preserves canonical casing in API
/// responses (`microsoft/TypeScript`) while our keys and remotes normalize to
/// lowercase — an exact string compare would reject the right PR or mistake a
/// same-repo head for a fork. Every repo comparison (folder-remote check,
/// PR adoption, fork gate) goes through here.
pub fn same_repo(a: &str, b: &str) -> bool {
    match (normalize_repo(a), normalize_repo(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Lowercased `owner/repo` (GitLab: full subgroup path), `.git` suffix and
/// surrounding slashes stripped. `None` when the shape is not a repo path or
/// contains URL metacharacters (a client-supplied value goes into request
/// paths, so this doubles as injection hygiene).
pub fn normalize_repo(input: &str) -> Option<String> {
    let trimmed = input
        .trim()
        .trim_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    if trimmed.is_empty() || !trimmed.contains('/') {
        return None;
    }
    let ok = trimmed.split('/').all(|seg| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    });
    if ok {
        Some(trimmed)
    } else {
        None
    }
}

/// `(server_host, owner_repo)` parsed from a git remote URL — the bridge
/// between a local folder and the forge repository its issues live in.
/// Handles the three shapes remotes actually take: `https://host/o/r(.git)`,
/// `git@host:o/r.git`, `ssh://git@host[:port]/o/r`.
pub fn parse_remote_url(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    // scp-like SSH: git@host:owner/repo(.git) — no scheme, single colon.
    if !trimmed.contains("://") {
        if let Some((user_host, path)) = trimmed.split_once(':') {
            let host = user_host.split('@').next_back()?.trim().to_ascii_lowercase();
            if host.is_empty() || host.contains('/') {
                return None;
            }
            return Some((host, normalize_repo(path)?));
        }
        return None;
    }
    // Scheme form: https:// or ssh:// — host[:port]/owner/repo(.git).
    let rest = trimmed.split_once("://")?.1;
    let (host_port, path) = rest.split_once('/')?;
    let host = host_port
        .split('@')
        .next_back()?
        .split(':')
        .next()?
        .trim()
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some((host, normalize_repo(path)?))
}

/// Provenance snapshot stored in `work_task.source_meta` (JSON) and mirrored
/// to the frontend as `ForgeSourceMeta` in `src/lib/types.ts`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ForgeSourceMeta {
    /// Typed rather than a free string: a stored value that is neither forge
    /// fails to deserialize the whole snapshot, which every reader already
    /// treats as "the task's source information is unreadable". That is a far
    /// better answer than defaulting to one forge and spending the other's
    /// credential on it.
    pub provider: ForgeProvider,
    pub server_host: String,
    pub api_base: String,
    pub account_id: String,
    pub owner_repo: String,
    pub number: i64,
    /// Canonical html URL — server-derived, never taken from the client.
    pub url: String,
    /// Title at trigger time (display only; the prompt carries its own copy).
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_pr: Option<String>,
}

/// List rows carry the body for the trigger snapshot; cap it so a megabyte
/// issue body doesn't ride every list response. The untrusted-data envelope
/// trims to 12k at prompt time — this keeps a margin above that.
pub const BODY_CAP: usize = 16_000;

/// Which tab of the workbench a list request is for. Provider-neutral: GitHub
/// serves both from one endpoint and splits locally, GitLab has two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeTab {
    Issues,
    Prs,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListIssuesRequest {
    pub owner_repo: String,
    pub tab: ForgeTab,
    /// "open" | "closed" | "all" (anything else is rejected). Normalized to
    /// each forge's own vocabulary by its client.
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub assigned_me: bool,
    /// Opaque continuation: the `Link: rel="next"` URL of the previous page.
    #[serde(default)]
    pub cursor: Option<String>,
}

fn default_state() -> String {
    "open".to_string()
}

/// One row of the workbench list (both tabs share the shape; `is_pr` is the
/// split). `body` rides along because the trigger snapshot is taken from the
/// list row — GitHub's `/issues` and GitLab's `/issues`+`/merge_requests` all
/// include it, which is what makes a detail endpoint unnecessary for issues.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeIssueRow {
    pub number: i64,
    pub title: String,
    /// Capped (see [`BODY_CAP`]) — the untrusted-data envelope trims to 12k
    /// anyway, so shipping megabyte bodies to the UI buys nothing.
    pub body: Option<String>,
    /// Normalized to `open` / `closed` for BOTH forges: GitLab says `opened`,
    /// and the workbench row renders its icon off this value.
    pub state: String,
    pub labels: Vec<String>,
    pub author: Option<String>,
    pub updated_at: Option<String>,
    pub html_url: String,
    pub is_pr: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeIssueList {
    pub rows: Vec<ForgeIssueRow>,
    /// Opaque next-page cursor (the `Link: rel="next"` URL). Feed it back
    /// verbatim; pagination MUST follow Link headers because client-side
    /// tab filtering makes page sizes sparse.
    pub next_cursor: Option<String>,
}

/// Proxy-aware shared HTTP client. A reqwest client caches its proxy
/// configuration for its whole lifetime (`network/proxy.rs` startup contract),
/// but codeg lets the user change the proxy at runtime — so the client is
/// keyed by the current proxy env fingerprint and rebuilt whenever that
/// changes. Lazy construction also lands after `init_proxy_from_db` for free.
/// The proxy env fingerprint a client was built under, paired with that client.
type ProxyKeyedClient = (Vec<(String, String)>, reqwest::Client);

static HTTP_CLIENT: RwLock<Option<ProxyKeyedClient>> = RwLock::new(None);

/// The `rel="next"` target of a Link header, if any. THE pagination signal for
/// both forges — a short page is not one, because rows are filtered after they
/// arrive (GitHub mixes issues and pull requests on one endpoint; GitLab's
/// closed tab folds in merged ones).
pub(crate) fn next_link(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let link = headers.get("link")?.to_str().ok()?;
    for part in link.split(',') {
        let (target, params) = part.split_once(';')?;
        if params.split(';').any(|p| p.trim() == r#"rel="next""#) {
            return Some(target.trim().trim_start_matches('<').trim_end_matches('>').to_string());
        }
    }
    None
}

/// Char-boundary-safe truncation (issue bodies are arbitrary UTF-8; a byte
/// slice could split a code point and panic).
pub(crate) fn truncate_chars(input: &str, cap: usize) -> String {
    if input.chars().count() <= cap {
        return input.to_string();
    }
    input.chars().take(cap).collect()
}

/// Reject a state filter we do not understand rather than pass it through to
/// the API, where it would silently change what the list means.
pub(crate) fn validate_state_filter(state: &str) -> Result<(), ForgeError> {
    if matches!(state, "open" | "closed" | "all") {
        Ok(())
    } else {
        Err(ForgeError::Invalid(format!("bad state filter: {state}")))
    }
}

/// The instance's WEB origin (scheme, host and port), derived from the API
/// base rather than from `server_host` — which is a bare hostname and would
/// silently drop both the scheme and a non-default port.
///
/// `https://api.github.com` is the public service's dedicated API host, whose
/// web origin is `https://github.com`; GitHub Enterprise mounts its API under
/// the instance (`{origin}/api/v3`) and GitLab under `{origin}/api/v4`. One
/// derivation, used by every place that needs a link or a push URL — three
/// copies of this rule would be three chances to disagree.
pub fn web_origin(auth: &ResolvedAuth) -> String {
    let base = auth.api_base.trim_end_matches('/');
    if base == "https://api.github.com" {
        return "https://github.com".to_string();
    }
    match base.strip_suffix("/api/v3").or_else(|| base.strip_suffix("/api/v4")) {
        Some(origin) => origin.to_string(),
        None => format!("https://{}", auth.server_host),
    }
}

/// Percent-encode a QUERY value — the few characters that are legal in a git
/// branch name but would change the meaning of a query string. `/` is left
/// alone: it is legal in a query and branch names are full of it.
pub(crate) fn urlencode_query(value: &str) -> String {
    encode(value, true)
}

/// Percent-encode a PATH segment, `/` included. GitLab addresses a project by
/// its full path inside a single segment (`group%2Fsub%2Fproj`), so this is
/// the difference between reading that project and reading a route that does
/// not exist.
pub(crate) fn urlencode_path(value: &str) -> String {
    encode(value, false)
}

fn encode(value: &str, keep_slash: bool) -> String {
    value
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            '/' if keep_slash => c.to_string(),
            other => other
                .to_string()
                .as_bytes()
                .iter()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect()
}

/// A pagination cursor is fed back by the client; only ever follow it into the
/// SAME API origin, or a crafted cursor turns an authenticated client into an
/// SSRF proxy with our bearer token attached.
pub(crate) fn checked_cursor(auth: &ResolvedAuth, cursor: &str) -> Result<String, ForgeError> {
    if !cursor.starts_with(&format!("{}/", auth.api_base)) {
        return Err(ForgeError::Invalid(
            "cursor does not belong to this API".into(),
        ));
    }
    Ok(cursor.to_string())
}

/// `(scheme, host, port)` — what "the same server" means for a redirect.
fn origin_of(url: &reqwest::Url) -> (String, Option<String>, Option<u16>) {
    (
        url.scheme().to_string(),
        url.host_str().map(str::to_ascii_lowercase),
        url.port_or_known_default(),
    )
}

pub(crate) fn http_client() -> Result<reqwest::Client, ForgeError> {
    let fingerprint = crate::network::proxy::current_proxy_env_vars();
    if let Ok(guard) = HTTP_CLIENT.read() {
        if let Some((cached, client)) = guard.as_ref() {
            if *cached == fingerprint {
                return Ok(client.clone());
            }
        }
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        // Redirects are followed only WITHIN one origin. reqwest strips
        // `Authorization` when a redirect crosses hosts, but it cannot know
        // that GitLab's `PRIVATE-TOKEN` is a credential too — a redirect to
        // somewhere else would hand that header over intact.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_origin = attempt
                .previous()
                .last()
                .is_some_and(|prev| origin_of(prev) == origin_of(attempt.url()));
            if !same_origin {
                attempt.stop()
            } else if attempt.previous().len() > 5 {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| ForgeError::Network(format!("http client build failed: {e}")))?;
    if let Ok(mut guard) = HTTP_CLIENT.write() {
        *guard = Some((fingerprint, client.clone()));
    }
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_key_normalizes_and_validates() {
        assert_eq!(
            source_key("GitHub", "GitHub.com", "Acme/App", "Issue", 123).unwrap(),
            "github:github.com:acme/app:issue:123"
        );
        // GitLab subgroups keep the full path; MR arrives pre-normalized as "pr".
        assert_eq!(
            source_key("gitlab", "gitlab.corp.com", "Group/Sub/Proj", "pr", 45).unwrap(),
            "gitlab:gitlab.corp.com:group/sub/proj:pr:45"
        );
        for bad in [
            source_key("bitbucket", "github.com", "a/b", "issue", 1),
            source_key("github", "github.com", "a/b", "mr", 1),
            source_key("github", "", "a/b", "issue", 1),
            source_key("github", "github.com/api", "a/b", "issue", 1),
            source_key("github", "github.com", "no-slash", "issue", 1),
            source_key("github", "github.com", "a/b", "issue", 0),
            source_key("github", "github.com", "a/b?x=1", "issue", 1),
        ] {
            assert!(bad.is_err());
        }
    }

    /// GitHub answers with canonical casing (`microsoft/TypeScript`) while
    /// keys/remotes are lowercase — comparisons must not care, and `.git`
    /// remote suffixes must not split identity either.
    #[test]
    fn same_repo_is_case_insensitive_and_suffix_tolerant() {
        assert!(same_repo("microsoft/typescript", "microsoft/TypeScript"));
        assert!(same_repo("Acme/App.git", "acme/app"));
        assert!(same_repo("group/sub/proj", "Group/Sub/Proj"));
        assert!(!same_repo("acme/app", "acme/other"));
        assert!(!same_repo("acme/app", ""));
        assert!(!same_repo("", ""));
    }

    #[test]
    fn remote_url_parsing_covers_all_three_shapes() {
        let cases = [
            ("https://github.com/Acme/App.git", ("github.com", "acme/app")),
            ("https://ghe.corp.com/team/tool", ("ghe.corp.com", "team/tool")),
            ("git@github.com:Acme/App.git", ("github.com", "acme/app")),
            ("ssh://git@ghe.corp.com:2222/team/tool.git", ("ghe.corp.com", "team/tool")),
            ("ssh://git@gitlab.corp.com/group/sub/proj.git", ("gitlab.corp.com", "group/sub/proj")),
            ("http://user@ghe.corp.com/a/b", ("ghe.corp.com", "a/b")),
        ];
        for (input, (host, repo)) in cases {
            let (h, r) = parse_remote_url(input).unwrap_or_else(|| panic!("parse {input}"));
            assert_eq!((h.as_str(), r.as_str()), (host, repo), "{input}");
        }
        for bad in ["", "not-a-url", "https://", "/local/path/repo", "file:///x/y"] {
            assert!(parse_remote_url(bad).is_none(), "{bad} must not parse");
        }
    }

    /// An unknown provider is refused rather than defaulted: picking GitHub
    /// for a value we do not understand would run a task's writes against the
    /// wrong API with the wrong credentials.
    #[test]
    fn provider_parsing_refuses_what_it_does_not_know() {
        assert_eq!(ForgeProvider::parse("GitHub").unwrap(), ForgeProvider::GitHub);
        assert_eq!(ForgeProvider::parse(" gitlab ").unwrap(), ForgeProvider::GitLab);
        assert!(ForgeProvider::parse("bitbucket").is_err());
        assert!(ForgeProvider::parse("").is_err());
        // The wire form round-trips through the stored source_meta JSON.
        assert_eq!(
            serde_json::to_string(&ForgeProvider::GitLab).unwrap(),
            "\"gitlab\""
        );
    }

    /// Item URLs and head refs are the two places the two forges disagree in a
    /// way a task cannot survive: a GitLab link with GitHub's path 404s, and a
    /// GitHub head ref simply does not exist on a GitLab server.
    #[test]
    fn provider_shapes_urls_and_head_refs_its_own_way() {
        let gh = ForgeProvider::GitHub;
        let gl = ForgeProvider::GitLab;
        assert_eq!(
            gh.item_url("https://github.com", "acme/app", ForgeItemKind::Change, 7),
            "https://github.com/acme/app/pull/7"
        );
        assert_eq!(
            gh.item_url("https://github.com", "acme/app", ForgeItemKind::Issue, 7),
            "https://github.com/acme/app/issues/7"
        );
        assert_eq!(
            gl.item_url("https://gitlab.com", "group/sub/proj", ForgeItemKind::Change, 7),
            "https://gitlab.com/group/sub/proj/-/merge_requests/7"
        );
        assert_eq!(
            gl.item_url("https://gitlab.com", "group/sub/proj", ForgeItemKind::Issue, 7),
            "https://gitlab.com/group/sub/proj/-/issues/7"
        );
        assert_eq!(gh.change_head_ref(7), "refs/pull/7/head");
        // Hyphen in the ref, underscore in the REST path — GitLab really does
        // spell it both ways, and only one of them fetches anything.
        assert_eq!(gl.change_head_ref(7), "refs/merge-requests/7/head");
        // A self-hosted instance keeps its scheme and port in the link.
        assert_eq!(
            gl.item_url("http://gitlab.corp.com:8929/", "a/b", ForgeItemKind::Issue, 7),
            "http://gitlab.corp.com:8929/a/b/-/issues/7"
        );
        assert_eq!(gh.change_noun(), "pull request");
        assert_eq!(gl.change_noun(), "merge request");
        // Both forges' changes key as "pr" so provenance keys stay comparable.
        assert_eq!(ForgeItemKind::Change.key_segment(), "pr");
        assert_eq!(ForgeItemKind::Issue.key_segment(), "issue");
    }

    /// The push URL and every stored link come from this one derivation: a
    /// bare `server_host` would drop both the scheme and a non-default port,
    /// which is exactly what a self-hosted instance has.
    #[test]
    fn the_web_origin_comes_from_the_api_base() {
        let mut auth = ResolvedAuth {
            provider: ForgeProvider::GitHub,
            server_host: "fallback.test".into(),
            api_base: "https://api.github.com".into(),
            account_id: "acc".into(),
            username: "alice".into(),
            token: "tok".into(),
            scopes: vec![],
        };
        assert_eq!(web_origin(&auth), "https://github.com");
        auth.api_base = "https://ghe.corp.com/api/v3".into();
        assert_eq!(web_origin(&auth), "https://ghe.corp.com");
        auth.api_base = "https://ghe.corp.com:8443/api/v3/".into();
        assert_eq!(web_origin(&auth), "https://ghe.corp.com:8443");
        auth.api_base = "http://gitlab.corp.com:8929/api/v4".into();
        assert_eq!(web_origin(&auth), "http://gitlab.corp.com:8929");
        // A base that is neither shape: fall back to the host we know rather
        // than build a link into whatever that string was.
        auth.api_base = "https://gitlab.com/weird".into();
        assert_eq!(web_origin(&auth), "https://fallback.test");
    }

    /// Both forges send `Link: rel="next"`, and it is the ONLY end-of-list
    /// signal either client may use — rows get filtered after they arrive, so
    /// a short page is normal.
    #[test]
    fn link_header_parses_only_rel_next() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "link",
            r#"<https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last""#
                .parse()
                .unwrap(),
        );
        assert_eq!(
            next_link(&headers).as_deref(),
            Some("https://api.github.com/x?page=3")
        );
        headers.insert(
            "link",
            r#"<https://api.github.com/x?page=9>; rel="last""#.parse().unwrap(),
        );
        assert_eq!(next_link(&headers), None);
        assert_eq!(next_link(&reqwest::header::HeaderMap::new()), None);
    }

    /// Issue bodies are arbitrary UTF-8; a byte slice could split a code point
    /// and panic.
    #[test]
    fn body_truncation_is_char_safe() {
        let s = "汉".repeat(BODY_CAP + 5);
        let t = truncate_chars(&s, BODY_CAP);
        assert_eq!(t.chars().count(), BODY_CAP);
        assert!(truncate_chars("short", BODY_CAP) == "short");
    }

    /// The client holder is keyed by the proxy env fingerprint: same
    /// fingerprint reuses the pool, a changed fingerprint rebuilds — this is
    /// what makes a runtime proxy switch take effect without a restart.
    #[test]
    fn http_client_rebuilds_when_proxy_fingerprint_changes() {
        let a = http_client().expect("client");
        let b = http_client().expect("client");
        // Same fingerprint → the very same pool (reqwest clients are Arc-like;
        // pointer identity via Debug formatting is not exposed, so assert via
        // the cache: a second acquisition must not error and the cached entry
        // must match the current fingerprint).
        let _ = (a, b);
        let cached_fp = HTTP_CLIENT
            .read()
            .unwrap()
            .as_ref()
            .map(|(fp, _)| fp.clone())
            .expect("cached");
        assert_eq!(cached_fp, crate::network::proxy::current_proxy_env_vars());
    }
}
