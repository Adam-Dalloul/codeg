//! GitLab REST v4 for the workbench and the delivery path.
//!
//! GitLab is not "GitHub with different words" in the four places that matter
//! here, and each of them is a silent-wrong-answer if you assume otherwise:
//!
//! 1. **Issues and merge requests are separate collections.** GitHub serves
//!    both from `/issues` and splits on a `pull_request` key; here each tab is
//!    its own endpoint, and so is each comment target (`/issues/{iid}/notes`
//!    vs `/merge_requests/{iid}/notes`).
//! 2. **The project is a path, not `{owner}/{repo}`.** Subgroups nest
//!    arbitrarily deep, and the whole path goes into ONE percent-encoded path
//!    segment (`group%2Fsub%2Fproj`).
//! 3. **`merged` is a state, not a flag.** `state=closed` excludes merged
//!    merge requests, so the workbench's "closed" tab asks for everything and
//!    filters locally — otherwise a merged merge request would simply vanish
//!    from a list where GitHub shows it.
//! 4. **Numbers are `iid`, not `id`.** `id` is globally unique and appears in
//!    no URL a human ever sees; addressing by it silently reads another
//!    project's work item.
//!
//! Pagination and rate-limit classification are shared with the GitHub client
//! (both send `Link: rel="next"`), and so is the rule that a short page is not
//! an end signal.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::deliver::{ForgePr, NewPullRequest};
use super::{
    checked_cursor, next_link, truncate_chars, urlencode_path, urlencode_query,
    validate_state_filter, web_origin, ForgeError, ForgeIssueList, ForgeIssueRow, ForgeItemKind,
    ListIssuesRequest, BODY_CAP,
};

const PAGE_SIZE: u32 = 30;

// ── reads ───────────────────────────────────────────────────────────────────

pub async fn list_issues(
    auth: &ResolvedAuth,
    req: &ListIssuesRequest,
) -> Result<ForgeIssueList, ForgeError> {
    let project = project_ref(&req.owner_repo)?;
    validate_state_filter(&req.state)?;

    let url = match &req.cursor {
        Some(cursor) => checked_cursor(auth, cursor)?,
        None => {
            let collection = match req.tab {
                super::ForgeTab::Issues => "issues",
                super::ForgeTab::Prs => "merge_requests",
            };
            let mut url = format!(
                "{}/projects/{project}/{collection}?state={}&per_page={PAGE_SIZE}",
                auth.api_base,
                wire_state(req.tab, &req.state)
            );
            if req.assigned_me {
                // `assignee_username` takes the literal login; there is no
                // `@me` shorthand on the collection endpoints.
                let login = current_login(auth).await?;
                url.push_str(&format!("&assignee_username={}", urlencode_query(&login)));
            }
            url
        }
    };

    let response = api_get(auth, &url).await?;
    let next_cursor = next_link(response.headers());
    let raw: Vec<RawItem> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad list payload: {e}")))?;

    let is_pr = req.tab == super::ForgeTab::Prs;
    let rows = raw
        .into_iter()
        // The merged-inclusive "closed" query (see module docs) comes back with
        // open rows too; drop them here rather than show the wrong tab.
        .filter(|item| keeps(&req.state, &item.state))
        .map(|item| ForgeIssueRow {
            is_pr,
            number: item.iid,
            title: item.title,
            body: item.description.map(|b| truncate_chars(&b, BODY_CAP)),
            state: display_state(&item.state),
            labels: item.labels.into_iter().filter(|l| !l.is_empty()).collect(),
            author: item.author.map(|a| a.username),
            updated_at: item.updated_at,
            html_url: item.web_url,
        })
        .collect();

    Ok(ForgeIssueList { rows, next_cursor })
}

/// One merge request by `iid` — what turns "!12" into something checkoutable.
///
/// A merge request opened from a fork reports only the numeric id of its
/// source project, so the fork's path is resolved here (one extra request, and
/// only for forks) — that name goes straight into the refusal the user reads,
/// and "project 4711" would be a worse answer than the truth.
pub async fn get_merge_request(
    auth: &ResolvedAuth,
    owner_repo: &str,
    iid: i64,
) -> Result<ForgePr, ForgeError> {
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let url = format!("{}/projects/{project}/merge_requests/{iid}", auth.api_base);
    let raw: RawMergeRequest = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge request payload: {e}")))?;
    let foreign_project = raw.source_project_id.filter(|src| Some(*src) != raw.target_project_id);
    let mut pr = map_merge_request(raw, owner_repo);
    if let Some(id) = foreign_project {
        if let Some(path) = project_path(auth, id).await {
            pr.head_repo = path;
        }
    }
    Ok(pr)
}

/// Merge requests whose source branch is `source_branch`, in ANY state — a
/// merged or closed one is exactly what recovery must be able to see.
///
/// Fork sources keep their placeholder head repository here: this list only
/// ever feeds the four-way match, which refuses anything that is not the
/// source project anyway, so resolving each fork's real path would be a
/// request per row spent on rows that cannot be adopted.
pub async fn find_merge_requests(
    auth: &ResolvedAuth,
    owner_repo: &str,
    source_branch: &str,
) -> Result<Vec<ForgePr>, ForgeError> {
    let project = project_ref(owner_repo)?;
    let url = format!(
        "{}/projects/{project}/merge_requests?source_branch={}&state=all&per_page=100",
        auth.api_base,
        urlencode_query(source_branch)
    );
    let raw: Vec<RawMergeRequest> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge requests payload: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|m| map_merge_request(m, owner_repo))
        .collect())
}

// ── writes ──────────────────────────────────────────────────────────────────

/// `POST /projects/{p}/merge_requests`.
///
/// GitLab has no `draft` parameter: a draft IS a title starting with `Draft:`,
/// which is also how its UI toggles the state. Prefixing is therefore the
/// supported way to open one, not a workaround.
pub async fn create_merge_request(
    auth: &ResolvedAuth,
    owner_repo: &str,
    req: &NewPullRequest<'_>,
) -> Result<ForgePr, ForgeError> {
    let project = project_ref(owner_repo)?;
    let url = format!("{}/projects/{project}/merge_requests", auth.api_base);
    let title = if req.draft && !is_draft_title(req.title) {
        format!("Draft: {}", req.title)
    } else {
        req.title.to_string()
    };
    let body = serde_json::json!({
        "source_branch": req.head,
        "target_branch": req.base,
        "title": title,
        "description": req.body,
    });
    let raw: RawMergeRequest = api_post(auth, &url, &body)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge request payload: {e}")))?;
    Ok(map_merge_request(raw, owner_repo))
}

/// `POST /projects/{p}/{issues|merge_requests}/{iid}/notes`.
///
/// The collection is part of the path here — unlike GitHub, where a pull
/// request is an issue and one endpoint serves both. Posting an issue note to
/// the merge-request collection (or the reverse) is a 404 against a number
/// that may well exist in the other collection.
pub async fn create_note(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    iid: i64,
    body: &str,
) -> Result<String, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let collection = collection_of(kind);
    let url = format!("{}/projects/{project}/{collection}/{iid}/notes", auth.api_base);
    #[derive(Deserialize)]
    struct RawNote {
        #[serde(default)]
        id: i64,
    }
    let created: RawNote = api_post(auth, &url, &serde_json::json!({ "body": body }))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad note payload: {e}")))?;
    // Notes carry no web URL of their own; the anchor on the item's page is
    // the link a human can actually follow.
    Ok(format!(
        "{}/{repo}/-/{collection}/{iid}#note_{}",
        web_origin(auth),
        created.id
    ))
}

// ── plumbing ────────────────────────────────────────────────────────────────

/// `GET {api_base}/user` → username, cached per `(api_base, account)`.
static LOGIN_CACHE: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

async fn current_login(auth: &ResolvedAuth) -> Result<String, ForgeError> {
    let cache_key = format!("{}\n{}", auth.api_base, auth.account_id);
    if let Some(hit) = LOGIN_CACHE.read().ok().and_then(|c| c.get(&cache_key).cloned()) {
        return Ok(hit);
    }
    #[derive(Deserialize)]
    struct User {
        username: String,
    }
    let user: User = api_get(auth, &format!("{}/user", auth.api_base))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad /user payload: {e}")))?;
    if let Ok(mut cache) = LOGIN_CACHE.write() {
        cache.insert(cache_key, user.username.clone());
    }
    Ok(user.username)
}

/// `path_with_namespace` of a project id. Best-effort: it only ever improves
/// the wording of a refusal that has already been decided.
async fn project_path(auth: &ResolvedAuth, project_id: i64) -> Option<String> {
    #[derive(Deserialize)]
    struct RawProject {
        #[serde(default)]
        path_with_namespace: String,
    }
    let url = format!("{}/projects/{project_id}", auth.api_base);
    let project: RawProject = api_get(auth, &url).await.ok()?.json().await.ok()?;
    Some(project.path_with_namespace).filter(|p| !p.is_empty())
}

pub(crate) async fn api_get(
    auth: &ResolvedAuth,
    url: &str,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .get(url)
        .header("PRIVATE-TOKEN", &auth.token)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    finish(response).await
}

pub(crate) async fn api_post(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .post(url)
        .header("PRIVATE-TOKEN", &auth.token)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    finish(response).await
}

/// Success through, everything else classified. GitLab signals its rate limit
/// with 429 (and `Retry-After`), never with the 403-plus-quota-header shape
/// GitHub uses — so a 403 here really is about the credential.
async fn finish(response: reqwest::Response) -> Result<reqwest::Response, ForgeError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    Err(match status {
        429 => ForgeError::RateLimited { retry_after },
        401 | 403 => ForgeError::Auth(format!("GitLab returned {status}")),
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
    })
}

/// The project as ONE percent-encoded path segment. `normalize_repo` runs
/// first, so what gets encoded has already been checked for URL
/// metacharacters — the encoding is for the slashes of a subgroup path, not a
/// substitute for validation.
fn project_ref(owner_repo: &str) -> Result<String, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    Ok(urlencode_path(&repo))
}

fn collection_of(kind: ForgeItemKind) -> &'static str {
    match kind {
        ForgeItemKind::Issue => "issues",
        ForgeItemKind::Change => "merge_requests",
    }
}

/// Our state filter in GitLab's vocabulary. "closed" asks for everything on
/// the merge-request collection because GitLab's own `closed` excludes merged
/// ones — see [`keeps`] for the other half.
fn wire_state(tab: super::ForgeTab, state: &str) -> &'static str {
    match (tab, state) {
        (_, "open") => "opened",
        (super::ForgeTab::Prs, "closed") => "all",
        (_, "closed") => "closed",
        _ => "all",
    }
}

/// Whether a row survives the filter the API could not fully express.
fn keeps(requested: &str, actual: &str) -> bool {
    match requested {
        "closed" => actual != "opened",
        _ => true,
    }
}

/// GitLab's `opened`/`locked`/`merged`/`closed` in the two words the rest of
/// codeg (and the workbench row's icon) understands.
fn display_state(state: &str) -> String {
    match state {
        "opened" | "locked" => "open".to_string(),
        _ => "closed".to_string(),
    }
}

/// Whether a title already declares itself a draft, so it is not prefixed
/// twice. `get(..6)` rather than `[..6]`: a title is arbitrary user text, and
/// slicing bytes through the middle of a code point PANICS — six bytes lands
/// mid-character on plenty of real titles.
fn is_draft_title(title: &str) -> bool {
    title
        .trim_start()
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("draft:"))
}

fn map_merge_request(raw: RawMergeRequest, owner_repo: &str) -> ForgePr {
    let same_project = match (raw.source_project_id, raw.target_project_id) {
        (Some(src), Some(dst)) => src == dst,
        // A payload that does not say cannot be shown to be the source
        // project, and "unknown" must not read as "ours".
        _ => false,
    };
    ForgePr {
        number: raw.iid,
        html_url: raw.web_url,
        state: display_state(&raw.state),
        merged: raw.state == "merged",
        // `diff_refs` is the precise head of the diff under review and is
        // present on the single-merge-request payload; the list payload only
        // carries `sha`, which is the same commit.
        head_sha: raw
            .diff_refs
            .and_then(|d| d.head_sha)
            .filter(|s| !s.is_empty())
            .or(raw.sha)
            .unwrap_or_default(),
        head_ref: raw.source_branch,
        head_repo: if same_project {
            owner_repo.to_string()
        } else {
            // Deliberately not a repository path: `same_repo` rejects it, so
            // every gate reads this as "somewhere else" without having to
            // spend a request to learn the fork's name.
            format!("project-{}", raw.source_project_id.unwrap_or_default())
        },
        base_ref: raw.target_branch,
    }
}

#[derive(Debug, Deserialize)]
struct RawItem {
    iid: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    author: Option<RawUser>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    web_url: String,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    username: String,
}

#[derive(Debug, Deserialize)]
struct RawMergeRequest {
    iid: i64,
    #[serde(default)]
    web_url: String,
    /// `opened` | `locked` | `merged` | `closed`.
    #[serde(default)]
    state: String,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    diff_refs: Option<RawDiffRefs>,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    #[serde(default)]
    source_project_id: Option<i64>,
    #[serde(default)]
    target_project_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawDiffRefs {
    #[serde(default)]
    head_sha: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::ForgeProvider;
    use axum::extract::Query;
    use axum::routing::{get, post};
    use axum::Json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: ForgeProvider::GitLab,
            server_host: "gitlab.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            token: "tok-test".into(),
            scopes: vec!["api".into()],
        }
    }

    fn item_json(iid: i64, state: &str) -> serde_json::Value {
        serde_json::json!({
            "iid": iid,
            "title": format!("item {iid}"),
            "description": format!("body {iid}"),
            "state": state,
            "labels": ["bug", ""],
            "author": { "username": "alice" },
            "updated_at": "2026-08-18T00:00:00Z",
            "web_url": format!("https://gitlab.test/group/sub/proj/-/issues/{iid}"),
        })
    }

    fn mr_json(iid: i64, state: &str, source_project: i64) -> serde_json::Value {
        serde_json::json!({
            "iid": iid,
            "web_url": format!("https://gitlab.test/group/sub/proj/-/merge_requests/{iid}"),
            "state": state,
            "sha": "abc123",
            "source_branch": "feature",
            "target_branch": "main",
            "source_project_id": source_project,
            "target_project_id": 1,
        })
    }

    /// `(api_base, MR-create bodies, note bodies, /user hits)`.
    #[allow(clippy::type_complexity)]
    async fn mock_api() -> (
        String,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
        Arc<AtomicUsize>,
    ) {
        let creates: Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Default::default();
        let notes: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> = Default::default();
        let user_hits = Arc::new(AtomicUsize::new(0));
        let seen = creates.clone();
        let issue_notes = notes.clone();
        let mr_notes = notes.clone();
        let hits = user_hits.clone();
        // The project path arrives percent-encoded, so it is ONE segment.
        let app = axum::Router::new()
            .route(
                "/projects/group%2Fsub%2Fproj/issues",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    let mut headers = axum::http::HeaderMap::new();
                    if !q.contains_key("page2") {
                        headers.insert(
                            "link",
                            r#"<PLACEHOLDER/projects/group%2Fsub%2Fproj/issues?page2=1>; rel="next""#
                                .parse()
                                .unwrap(),
                        );
                    }
                    let rows = if q.get("assignee_username").map(String::as_str) == Some("alice") {
                        vec![item_json(9, "opened")]
                    } else if q.contains_key("page2") {
                        vec![item_json(3, "opened")]
                    } else {
                        vec![item_json(1, "opened")]
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    let rows = match q.get("source_branch").map(String::as_str) {
                        Some("feature") => vec![mr_json(4, "opened", 1)],
                        Some(_) => vec![],
                        // The tab listing: `state=all` is what the "closed"
                        // filter asks for, and it comes back merged + open.
                        None => vec![
                            mr_json(5, "merged", 1),
                            mr_json(6, "opened", 1),
                            mr_json(7, "closed", 1),
                        ],
                    };
                    Json(serde_json::Value::Array(rows))
                })
                .post(move |Json(body): Json<serde_json::Value>| {
                    seen.lock().unwrap().push(body);
                    async { Json(mr_json(8, "opened", 1)) }
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/4",
                get(|| async {
                    let mut mr = mr_json(4, "opened", 1);
                    mr["diff_refs"] = serde_json::json!({ "head_sha": "deadbee" });
                    Json(mr)
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/9",
                get(|| async { Json(mr_json(9, "opened", 42)) }),
            )
            .route(
                "/projects/42",
                get(|| async {
                    Json(serde_json::json!({ "path_with_namespace": "contributor/proj" }))
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/issues/7/notes",
                post(move |Json(body): Json<serde_json::Value>| {
                    issue_notes.lock().unwrap().push(("issues".to_string(), body));
                    async { Json(serde_json::json!({ "id": 55 })) }
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/7/notes",
                post(move |Json(body): Json<serde_json::Value>| {
                    mr_notes.lock().unwrap().push(("merge_requests".to_string(), body));
                    async { Json(serde_json::json!({ "id": 66 })) }
                }),
            )
            .route(
                "/user",
                get(move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async { Json(serde_json::json!({ "username": "alice" })) }
                }),
            )
            .route(
                "/limited/projects/group%2Fsub%2Fproj/issues",
                get(|| async {
                    let mut headers = axum::http::HeaderMap::new();
                    headers.insert("retry-after", "17".parse().unwrap());
                    (
                        axum::http::StatusCode::TOO_MANY_REQUESTS,
                        headers,
                        Json(serde_json::json!({ "message": "slow down" })),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), creates, notes, user_hits)
    }

    fn req(tab: super::super::ForgeTab, state: &str) -> ListIssuesRequest {
        ListIssuesRequest {
            owner_repo: "Group/Sub/Proj".into(),
            tab,
            state: state.into(),
            assigned_me: false,
            cursor: None,
        }
    }

    /// A subgroup path is ONE percent-encoded segment; anything else addresses
    /// a route that does not exist. The row shape (iid, description, GitLab's
    /// `opened`) is normalized to what the workbench renders.
    #[tokio::test]
    async fn issues_come_from_the_encoded_project_path() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base.clone());
        let list = list_issues(&auth, &req(super::super::ForgeTab::Issues, "open"))
            .await
            .expect("list");
        assert_eq!(list.rows.len(), 1);
        let row = &list.rows[0];
        assert_eq!((row.number, row.state.as_str()), (1, "open"));
        assert_eq!(row.body.as_deref(), Some("body 1"));
        assert_eq!(row.labels, vec!["bug"]); // the empty label is dropped
        assert_eq!(row.author.as_deref(), Some("alice"));
        assert!(!row.is_pr);

        // Pagination is the Link header, exactly as on the GitHub side.
        let next = list.next_cursor.expect("next").replace("PLACEHOLDER", &api_base);
        let page2 = list_issues(
            &auth,
            &ListIssuesRequest {
                cursor: Some(next),
                ..req(super::super::ForgeTab::Issues, "open")
            },
        )
        .await
        .expect("page 2");
        assert_eq!(page2.rows[0].number, 3);
        assert!(page2.next_cursor.is_none());
    }

    /// GitLab's `state=closed` excludes merged merge requests. The workbench's
    /// closed tab has to show them (GitHub's does), so the query asks for
    /// everything and the open ones are dropped here.
    #[tokio::test]
    async fn the_closed_tab_still_shows_merged_merge_requests() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let list = list_issues(&auth, &req(super::super::ForgeTab::Prs, "closed"))
            .await
            .expect("list");
        assert_eq!(
            list.rows.iter().map(|r| r.number).collect::<Vec<_>>(),
            vec![5, 7],
            "merged and closed, but not the open one"
        );
        assert!(list.rows.iter().all(|r| r.is_pr && r.state == "closed"));
        assert_eq!(wire_state(super::super::ForgeTab::Prs, "closed"), "all");
        // Issues have no merged state, so theirs stays a plain closed query.
        assert_eq!(wire_state(super::super::ForgeTab::Issues, "closed"), "closed");
    }

    #[tokio::test]
    async fn assigned_me_resolves_the_login_once() {
        let (api_base, _, _, user_hits) = mock_api().await;
        let auth = auth_for(api_base);
        let request = ListIssuesRequest {
            assigned_me: true,
            ..req(super::super::ForgeTab::Issues, "open")
        };
        assert_eq!(
            list_issues(&auth, &request).await.unwrap().rows[0].number,
            9
        );
        assert_eq!(list_issues(&auth, &request).await.unwrap().rows.len(), 1);
        assert_eq!(user_hits.load(Ordering::SeqCst), 1, "login cached");
    }

    /// The single-merge-request payload is what a task is checked out from:
    /// `diff_refs.head_sha` wins over `sha`, and a fork's real path is
    /// resolved so the refusal can name it.
    #[tokio::test]
    async fn a_merge_request_is_looked_up_by_iid() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let mr = get_merge_request(&auth, "Group/Sub/Proj", 4).await.expect("mr");
        assert_eq!((mr.number, mr.head_ref.as_str(), mr.base_ref.as_str()), (4, "feature", "main"));
        assert_eq!(mr.head_sha, "deadbee", "diff_refs wins over sha");
        assert_eq!(mr.state, "open");
        assert!(!mr.merged);
        // Same project: the head repository IS this repository, which is what
        // every same_repo gate downstream asks.
        assert!(super::super::same_repo(&mr.head_repo, "group/sub/proj"));

        let fork = get_merge_request(&auth, "group/sub/proj", 9).await.expect("mr");
        assert_eq!(fork.head_repo, "contributor/proj", "fork path resolved for the message");
        assert!(!super::super::same_repo(&fork.head_repo, "group/sub/proj"));

        assert!(get_merge_request(&auth, "group/sub/proj", 0).await.is_err());
        assert!(get_merge_request(&auth, "not-a-path", 4).await.is_err());
    }

    /// The delivery's lookup: by source branch, in any state, mapped into the
    /// same shape the four-way match already knows.
    #[tokio::test]
    async fn merge_requests_are_found_by_source_branch() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let found = find_merge_requests(&auth, "group/sub/proj", "feature")
            .await
            .expect("find");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].number, found[0].head_sha.as_str()), (4, "abc123"));
        assert!(find_merge_requests(&auth, "group/sub/proj", "other")
            .await
            .unwrap()
            .is_empty());
    }

    /// GitLab has no `draft` parameter — the title carries it, which is also
    /// how its own UI models a draft.
    #[tokio::test]
    async fn a_draft_merge_request_is_a_prefixed_title() {
        let (api_base, creates, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let made = create_merge_request(
            &auth,
            "group/sub/proj",
            &NewPullRequest {
                title: "Fix #7",
                head: "task/7",
                base: "main",
                body: "Closes #7",
                draft: true,
            },
        )
        .await
        .expect("create");
        assert_eq!(made.number, 8);
        let sent = creates.lock().unwrap().first().cloned().unwrap();
        assert_eq!(sent["source_branch"], "task/7");
        assert_eq!(sent["target_branch"], "main");
        assert_eq!(sent["title"], "Draft: Fix #7");
        assert_eq!(sent["description"], "Closes #7");

        // Not a draft, and an already-prefixed title is not prefixed twice.
        create_merge_request(
            &auth,
            "group/sub/proj",
            &NewPullRequest {
                title: "Draft: Fix #7",
                head: "task/7",
                base: "main",
                body: "",
                draft: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(creates.lock().unwrap()[1]["title"], "Draft: Fix #7");
        assert!(is_draft_title("  draft: x") && !is_draft_title("drafts"));
        // Titles are arbitrary user text. Byte six lands in the middle of a
        // character here, which a byte slice would panic on.
        assert!(!is_draft_title("修a复登录"));
        assert!(!is_draft_title("修"));
        assert!(!is_draft_title(""));
    }

    /// Issue notes and merge-request notes are DIFFERENT endpoints; sending
    /// one to the other is a 404 against a number that exists in the other
    /// collection.
    #[tokio::test]
    async fn notes_go_to_the_collection_the_item_belongs_to() {
        let (api_base, _, notes, _) = mock_api().await;
        let auth = auth_for(api_base);
        let issue_url = create_note(&auth, "Group/Sub/Proj", ForgeItemKind::Issue, 7, "done")
            .await
            .expect("issue note");
        let mr_url = create_note(&auth, "group/sub/proj", ForgeItemKind::Change, 7, "done")
            .await
            .expect("mr note");
        let sent = notes.lock().unwrap().clone();
        assert_eq!(sent[0].0, "issues");
        assert_eq!(sent[0].1["body"], "done");
        assert_eq!(sent[1].0, "merge_requests");
        // A note has no URL of its own; the anchor on the item's page does.
        assert!(issue_url.ends_with("/group/sub/proj/-/issues/7#note_55"), "{issue_url}");
        assert!(mr_url.ends_with("/group/sub/proj/-/merge_requests/7#note_66"), "{mr_url}");

        assert!(create_note(&auth, "not-a-path", ForgeItemKind::Issue, 7, "x").await.is_err());
        assert!(create_note(&auth, "group/sub/proj", ForgeItemKind::Issue, 0, "x").await.is_err());
    }

    #[tokio::test]
    async fn rate_limits_are_told_apart_from_auth_failures() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(format!("{api_base}/limited"));
        match list_issues(&auth, &req(super::super::ForgeTab::Issues, "open")).await {
            Err(ForgeError::RateLimited { retry_after }) => assert_eq!(retry_after, Some(17)),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    /// A crafted cursor must not turn the client into an authenticated proxy
    /// for someone else's host.
    #[tokio::test]
    async fn a_foreign_cursor_is_rejected() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let hostile = ListIssuesRequest {
            cursor: Some("http://169.254.169.254/latest/meta-data".into()),
            ..req(super::super::ForgeTab::Issues, "open")
        };
        assert!(matches!(
            list_issues(&auth, &hostile).await,
            Err(ForgeError::Invalid(_))
        ));
    }

    #[test]
    fn project_paths_become_one_encoded_segment() {
        assert_eq!(project_ref("Group/Sub/Proj").unwrap(), "group%2Fsub%2Fproj");
        assert_eq!(project_ref("acme/app.git").unwrap(), "acme%2Fapp");
        assert!(project_ref("no-slash").is_err());
        assert!(project_ref("acme/app?x=1").is_err());
    }

    /// A payload that does not say which project the source lives in cannot be
    /// shown to be ours — "unknown" must not read as "same repository".
    #[test]
    fn an_unstated_source_project_is_not_this_repository() {
        let raw: RawMergeRequest =
            serde_json::from_value(mr_json(3, "opened", 1)).expect("parse");
        assert!(super::super::same_repo(
            &map_merge_request(raw, "group/proj").head_repo,
            "group/proj"
        ));
        let mut bare = mr_json(3, "opened", 1);
        bare["source_project_id"] = serde_json::Value::Null;
        let raw: RawMergeRequest = serde_json::from_value(bare).expect("parse");
        let mapped = map_merge_request(raw, "group/proj");
        assert!(!super::super::same_repo(&mapped.head_repo, "group/proj"));
    }

}
