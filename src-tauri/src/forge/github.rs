//! GitHub REST reads for the workbench. Three hard-won rules from the
//! architecture teardown are load-bearing here (see
//! `.docs/architecture/2026-08-17-Orca-GitHub-GitLab集成分析.md`):
//!
//! 1. Issues AND PRs list through `/repos/{o}/{r}/issues` — `/pulls` silently
//!    ignores `assignee`/`labels` filters (HTTP 200, unfiltered rows), so it
//!    must never serve a filtered list.
//! 2. Pagination follows `Link: rel="next"` ONLY. Rows are split into tabs
//!    client-side, which makes page sizes sparse — "a short page means the
//!    end" is wrong here.
//! 3. `assignee=@me` is a 422; the literal login has to be resolved via
//!    `GET /user` first (cached per api_base+account).

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::{
    checked_cursor, next_link, truncate_chars, validate_state_filter, ForgeError, ForgeIssueList,
    ForgeIssueRow, ForgeTab, ListIssuesRequest, BODY_CAP,
};

const PAGE_SIZE: u32 = 30;

#[derive(Debug, Deserialize)]
struct RawIssue {
    number: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    user: Option<RawUser>,
    #[serde(default)]
    labels: Vec<RawLabel>,
    /// Presence of this key is what makes an `/issues` row a PR.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    #[serde(default)]
    name: String,
}

pub async fn list_issues(
    conn_auth: &ResolvedAuth,
    req: &ListIssuesRequest,
) -> Result<ForgeIssueList, ForgeError> {
    let repo = super::normalize_repo(&req.owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {}", req.owner_repo)))?;
    validate_state_filter(&req.state)?;

    let url = match &req.cursor {
        Some(cursor) => checked_cursor(conn_auth, cursor)?,
        None => {
            let mut url = format!(
                "{}/repos/{}/issues?state={}&per_page={}",
                conn_auth.api_base, repo, req.state, PAGE_SIZE
            );
            if req.assigned_me {
                let login = current_login(conn_auth).await?;
                url.push_str(&format!("&assignee={login}"));
            }
            url
        }
    };

    let response = api_get(conn_auth, &url).await?;
    let next_cursor = next_link(response.headers());
    let raw: Vec<RawIssue> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad issues payload: {e}")))?;

    let want_prs = req.tab == ForgeTab::Prs;
    let rows = raw
        .into_iter()
        .filter(|r| r.pull_request.is_some() == want_prs)
        .map(|r| ForgeIssueRow {
            is_pr: r.pull_request.is_some(),
            number: r.number,
            title: r.title,
            body: r.body.map(|b| truncate_chars(&b, BODY_CAP)),
            state: r.state,
            labels: r.labels.into_iter().map(|l| l.name).filter(|n| !n.is_empty()).collect(),
            author: r.user.map(|u| u.login),
            updated_at: r.updated_at,
            html_url: r.html_url,
        })
        .collect();

    Ok(ForgeIssueList { rows, next_cursor })
}

/// `GET {api_base}/user` → login, cached per `(api_base, account)` — resolving
/// it on every "assigned to me" page would waste a rate-limit point per click.
static LOGIN_CACHE: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

async fn current_login(auth: &ResolvedAuth) -> Result<String, ForgeError> {
    let cache_key = format!("{}\n{}", auth.api_base, auth.account_id);
    if let Some(hit) = LOGIN_CACHE.read().ok().and_then(|c| c.get(&cache_key).cloned()) {
        return Ok(hit);
    }
    #[derive(Deserialize)]
    struct User {
        login: String,
    }
    let user: User = api_get(auth, &format!("{}/user", auth.api_base))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad /user payload: {e}")))?;
    if let Ok(mut cache) = LOGIN_CACHE.write() {
        cache.insert(cache_key, user.login.clone());
    }
    Ok(user.login)
}

/// Authenticated GET with the standard GitHub headers; non-2xx classified into
/// `ForgeError` (rate limits distinguished from plain auth failures).
pub(crate) async fn api_get(
    auth: &ResolvedAuth,
    url: &str,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .get(url)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("User-Agent", "codeg")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    Err(classify_failure(status.as_u16(), response).await)
}

/// Authenticated POST with the same headers and the same failure taxonomy as
/// [`api_get`]. Writes are never retried here: a retried create could open a
/// duplicate pull request, so the caller decides.
pub(crate) async fn api_post(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .post(url)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("User-Agent", "codeg")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(body)
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    Err(classify_failure(status.as_u16(), response).await)
}

async fn classify_failure(status: u16, response: reqwest::Response) -> ForgeError {
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let primary_exhausted = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() == "0");
    match status {
        429 => ForgeError::RateLimited { retry_after },
        403 if retry_after.is_some() || primary_exhausted => {
            ForgeError::RateLimited { retry_after }
        }
        401 | 403 => ForgeError::Auth(format!("GitHub returned {status}")),
        404 => ForgeError::NotFound,
        _ => {
            let message = response
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            ForgeError::Api { status, message }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::Json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: super::super::ForgeProvider::GitHub,
            server_host: "github.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            token: "tok-test".into(),
            scopes: vec!["repo".into()],
        }
    }

    fn issue_json(number: i64, is_pr: bool) -> serde_json::Value {
        let mut v = serde_json::json!({
            "number": number,
            "title": format!("item {number}"),
            "body": format!("body {number}"),
            "state": "open",
            "updated_at": "2026-08-17T00:00:00Z",
            "html_url": format!("https://github.test/acme/app/issues/{number}"),
            "user": { "login": "alice" },
            "labels": [ { "name": "bug" }, { "name": "" } ],
        });
        if is_pr {
            v["pull_request"] = serde_json::json!({ "url": "https://api.github.test/x" });
        }
        v
    }

    /// One mock GitHub API on an OS-assigned port; returns (api_base, hit
    /// counter for /user).
    async fn mock_api() -> (String, Arc<AtomicUsize>) {
        let user_hits = Arc::new(AtomicUsize::new(0));
        let hits = user_hits.clone();
        let app = axum::Router::new()
            .route(
                "/repos/acme/app/issues",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    // Page 2 (marker param) has no next link; page 1 does.
                    let page2 = q.contains_key("page2");
                    let mut headers = HeaderMap::new();
                    if !page2 {
                        headers.insert(
                            "link",
                            r#"<PLACEHOLDER/repos/acme/app/issues?page2=1>; rel="next", <x>; rel="last""#
                                .parse()
                                .unwrap(),
                        );
                    }
                    // Assignee filter reflected in the payload so the test can
                    // assert it was actually sent.
                    let rows = if q.get("assignee").map(String::as_str) == Some("alice") {
                        vec![issue_json(9, false)]
                    } else if page2 {
                        vec![issue_json(3, false)]
                    } else {
                        vec![issue_json(1, false), issue_json(2, true)]
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                }),
            )
            .route(
                "/user",
                get(move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async { Json(serde_json::json!({ "login": "alice" })) }
                }),
            )
            .route(
                "/limited/repos/acme/app/issues",
                get(|| async {
                    let mut headers = HeaderMap::new();
                    headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
                    headers.insert("retry-after", "31".parse().unwrap());
                    (
                        axum::http::StatusCode::FORBIDDEN,
                        headers,
                        Json(serde_json::json!({ "message": "rate limited" })),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), user_hits)
    }

    fn req(tab: ForgeTab) -> ListIssuesRequest {
        ListIssuesRequest {
            owner_repo: "Acme/App".into(),
            tab,
            state: "open".into(),
            assigned_me: false,
            cursor: None,
        }
    }

    /// `/issues` returns a MIXED page; the tab split happens here, and the
    /// next-cursor must come from the Link header even when the visible rows
    /// thin out (sparse pages are normal, not an end signal).
    #[tokio::test]
    async fn list_splits_tabs_and_follows_link_next() {
        let (api_base, _) = mock_api().await;
        let auth = auth_for(api_base.clone());

        let issues = list_issues(&auth, &req(ForgeTab::Issues)).await.unwrap();
        assert_eq!(issues.rows.iter().map(|r| r.number).collect::<Vec<_>>(), vec![1]);
        assert!(!issues.rows[0].is_pr);
        assert_eq!(issues.rows[0].labels, vec!["bug"]); // empty label dropped
        assert_eq!(issues.rows[0].author.as_deref(), Some("alice"));
        let next = issues.next_cursor.expect("page 1 advertises next");
        // The mock can't know its own port when the route is built, so it
        // stamps a placeholder; the client must treat the URL as opaque.
        let next = next.replace("PLACEHOLDER", &api_base);

        let prs = list_issues(&auth, &req(ForgeTab::Prs)).await.unwrap();
        assert_eq!(prs.rows.iter().map(|r| r.number).collect::<Vec<_>>(), vec![2]);
        assert!(prs.rows[0].is_pr);

        // Follow the cursor: page 2, no further next.
        let page2 = list_issues(
            &auth,
            &ListIssuesRequest { cursor: Some(next), ..req(ForgeTab::Issues) },
        )
        .await
        .unwrap();
        assert_eq!(page2.rows.iter().map(|r| r.number).collect::<Vec<_>>(), vec![3]);
        assert!(page2.next_cursor.is_none());
    }

    /// `assignee=@me` would be a 422 — the login is resolved through `/user`
    /// exactly once and reused from the cache afterwards.
    #[tokio::test]
    async fn assigned_me_resolves_login_once() {
        let (api_base, user_hits) = mock_api().await;
        let auth = auth_for(api_base);
        let request = ListIssuesRequest { assigned_me: true, ..req(ForgeTab::Issues) };

        let first = list_issues(&auth, &request).await.unwrap();
        assert_eq!(first.rows.iter().map(|r| r.number).collect::<Vec<_>>(), vec![9]);
        let second = list_issues(&auth, &request).await.unwrap();
        assert_eq!(second.rows.len(), 1);
        assert_eq!(user_hits.load(Ordering::SeqCst), 1, "login cached after first use");
    }

    /// 403 + exhausted quota is a rate limit (with its retry hint), NOT an
    /// auth failure — the UI shows a cooldown, not "re-enter your token".
    #[tokio::test]
    async fn exhausted_quota_classifies_as_rate_limit() {
        let (api_base, _) = mock_api().await;
        let auth = auth_for(format!("{api_base}/limited"));
        match list_issues(&auth, &req(ForgeTab::Issues)).await {
            Err(ForgeError::RateLimited { retry_after }) => assert_eq!(retry_after, Some(31)),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    /// A cursor is only ever followed back into the same API origin — a
    /// crafted one must not turn the client into an authed SSRF proxy.
    #[tokio::test]
    async fn foreign_cursor_is_rejected() {
        let (api_base, _) = mock_api().await;
        let auth = auth_for(api_base);
        let hostile = ListIssuesRequest {
            cursor: Some("http://169.254.169.254/latest/meta-data".into()),
            ..req(ForgeTab::Issues)
        };
        assert!(matches!(
            list_issues(&auth, &hostile).await,
            Err(ForgeError::Invalid(_))
        ));
    }

}
