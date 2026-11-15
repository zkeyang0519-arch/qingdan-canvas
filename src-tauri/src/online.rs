// Same challenge/verifier protocol as desktop/online-api.cjs. The verifier and
// desktop session token remain in native memory and never enter renderer JS.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
const PORT: u16 = 8792;
pub fn origin_allowed(origin: &str) -> bool {
    if cfg!(feature = "test-harness") && origin == "http://127.0.0.1:18788" {
        return true;
    }
    [
        "https://todo.zky.lol",
        "https://qingdan-canvas.zkeyang0519.workers.dev",
    ]
    .contains(&origin)
}
pub fn id(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    })
}
fn hex(v: &Value, n: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == n
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
#[derive(Clone)]
struct Pending {
    origin: String,
    account: Value,
    room: Value,
    verifier: String,
    expires: Instant,
    cancelled: Arc<AtomicBool>,
    launched: bool,
}
impl Pending {
    fn active(&self) -> Result<()> {
        if self.cancelled.load(Ordering::SeqCst) || self.expires <= Instant::now() {
            Err("交接已取消或过期".into())
        } else {
            Ok(())
        }
    }
}
fn json_content_type(value: &str) -> bool {
    value
        .split(';')
        .next()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
}
fn header(req: &tiny_http::Request, name: &str) -> String {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default()
}
fn respond(req: tiny_http::Request, code: u16, value: Value, origin: &str) {
    let mut response = tiny_http::Response::from_string(value.to_string()).with_status_code(code);
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Cache-Control", "no-store"),
        ("Access-Control-Allow-Origin", origin),
        ("Vary", "Origin"),
        ("Access-Control-Allow-Methods", "POST"),
        (
            "Access-Control-Allow-Headers",
            "Content-Type, X-Qingdan-Local",
        ),
        ("Access-Control-Allow-Private-Network", "true"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(name, value) {
            response.add_header(h);
        }
    }
    let _ = req.respond(response);
}
pub fn start(app: tauri::AppHandle) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let server = tiny_http::Server::http(("127.0.0.1", PORT))
        .map_err(|_| "8792 验证端口已被占用；请关闭另一份验证版后重试。")?;
    std::thread::spawn(move || {
        let mut pending: HashMap<String, Pending> = HashMap::new();
        let instance = uuid::Uuid::new_v4().simple().to_string();
        for mut req in server.incoming_requests() {
            pending.retain(|_, p| p.expires > Instant::now());
            let origin = header(&req, "origin");
            if !origin_allowed(&origin) || header(&req, "host") != format!("127.0.0.1:{PORT}") {
                respond(req, 403, json!({"error":"未授权的来源"}), "");
                continue;
            }
            let path = req.url().to_string();
            if !["prepare", "launch", "status", "probe", "cancel"]
                .iter()
                .any(|p| path == format!("/api/local-desktop/online/{p}"))
            {
                respond(req, 404, json!({"error":"无效入口"}), &origin);
                continue;
            }
            if req.method() == &tiny_http::Method::Options {
                let headers = header(&req, "access-control-request-headers").to_lowercase();
                let fields: Vec<_> = headers.split(',').map(str::trim).collect();
                if header(&req, "access-control-request-method") != "POST"
                    || !fields.contains(&"x-qingdan-local")
                    || fields
                        .iter()
                        .any(|h| !["content-type", "x-qingdan-local"].contains(h))
                {
                    respond(req, 403, json!({}), &origin);
                } else {
                    respond(req, 204, json!({}), &origin);
                }
                continue;
            }
            if req.method() != &tiny_http::Method::Post
                || header(&req, "x-qingdan-local") != "1"
                || !json_content_type(&header(&req, "content-type"))
            {
                respond(req, 403, json!({"error":"请通过轻岛按钮启动"}), &origin);
                continue;
            }
            let mut bytes = Vec::new();
            let _ = req.as_reader().take(2049).read_to_end(&mut bytes);
            let data = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            if bytes.len() > 2048 || !data.is_object() {
                respond(req, 400, json!({"error":"无效请求"}), &origin);
                continue;
            }
            if path.ends_with("/probe") {
                respond(
                    req,
                    200,
                    json!({"protocol":1,"instanceId":instance,"channel":"tauri-preview","version":env!("CARGO_PKG_VERSION")}),
                    &origin,
                );
                continue;
            }
            if path.ends_with("/status") || path.ends_with("/cancel") {
                let owned = data["requestId"]
                    .as_str()
                    .and_then(|s| pending.get(s))
                    .filter(|p| p.origin == origin);
                if let Some(p) = owned {
                    if path.ends_with("/cancel") {
                        p.cancelled.store(true, Ordering::SeqCst);
                    }
                    respond(
                        req,
                        200,
                        json!({"message":"正在保存并连接验证版画布…"}),
                        &origin,
                    );
                } else {
                    respond(req, 404, json!({"error":"交接不存在或已过期"}), &origin);
                }
                continue;
            }
            if path.ends_with("/prepare") {
                if !id(&data["accountId"]) || !id(&data["roomId"]) || pending.len() >= 32 {
                    respond(
                        req,
                        400,
                        json!({"error":"无效账号、画布或请求过多"}),
                        &origin,
                    );
                    continue;
                }
                let request = uuid::Uuid::new_v4().simple().to_string();
                let verifier = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                let challenge = format!("{:x}", Sha256::digest(verifier.as_bytes()));
                pending.insert(
                    request.clone(),
                    Pending {
                        origin: origin.clone(),
                        account: data["accountId"].clone(),
                        room: data["roomId"].clone(),
                        verifier,
                        expires: Instant::now() + Duration::from_secs(90),
                        cancelled: Arc::new(AtomicBool::new(false)),
                        launched: false,
                    },
                );
                respond(
                    req,
                    200,
                    json!({"requestId":request,"challenge":challenge,"instanceId":instance}),
                    &origin,
                );
                continue;
            }
            if !hex(&data["requestId"], 32) || !hex(&data["ticket"], 64) {
                respond(req, 400, json!({"error":"无效交接"}), &origin);
                continue;
            }
            let Some(p) = pending.get_mut(data["requestId"].as_str().unwrap()) else {
                respond(req, 410, json!({"error":"交接已过期"}), &origin);
                continue;
            };
            if p.origin != origin {
                respond(req, 403, json!({"error":"来源不一致"}), &origin);
                continue;
            }
            if p.launched || p.active().is_err() {
                respond(req, 410, json!({"error":"交接已使用或取消"}), &origin);
                continue;
            }
            p.launched = true;
            let p = p.clone();
            let app = app.clone();
            std::thread::spawn(move || {
                let result = tauri::async_runtime::block_on(apply(
                    &app,
                    &p,
                    data["ticket"].as_str().unwrap(),
                ));
                match result {
                    Ok(()) => respond(req, 200, json!({"started":true,"applied":true}), &origin),
                    Err(_) => respond(
                        req,
                        503,
                        json!({"error":"交接未完成。请确认原画布已保存、账号有效，再重试。"}),
                        &origin,
                    ),
                }
            });
        }
    });
    Ok(())
}
async fn apply(app: &tauri::AppHandle, p: &Pending, ticket: &str) -> Result<()> {
    let w = app.get_webview_window("main").ok_or("No window")?;
    let state = w.state::<State>();
    let _lock = state.action.lock().await;
    p.active()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(err)?;
    let response = client
        .post(format!("{}/api/desktop/handoff/redeem", p.origin))
        .header("X-Qingdan-Desktop", "1")
        .json(&json!({"ticket":ticket,"verifier":p.verifier}))
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    let session: Value = response.json().await.map_err(err)?;
    if session["accountId"] != p.account
        || session["roomId"] != p.room
        || !hex(&session["sessionToken"], 64)
    {
        return Err("Invalid session".into());
    }
    // Verify both identity and room access independently of the redeem response.
    let authenticated: Value = client
        .get(format!("{}/api/session", p.origin))
        .header(
            "Cookie",
            format!("qd_session={}", session["sessionToken"].as_str().unwrap()),
        )
        .header("X-QD-Account", p.account.as_str().unwrap())
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let expires = verified_expiry(&session, &authenticated, &p.account)?;
    let room: Value = client
        .get(format!(
            "{}/api/rooms/{}",
            p.origin,
            p.room.as_str().unwrap()
        ))
        .header(
            "Cookie",
            format!("qd_session={}", session["sessionToken"].as_str().unwrap()),
        )
        .header("X-QD-Account", p.account.as_str().unwrap())
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    if room["room"]["id"] != p.room {
        return Err("Room access denied".into());
    }
    p.active()?;
    let origin = url::Url::parse(&p.origin).map_err(err)?;
    let mut cookie = tauri::webview::Cookie::build((
        "qd_session",
        session["sessionToken"].as_str().unwrap().to_string(),
    ))
    .domain(origin.host_str().unwrap().to_string())
    .path("/")
    .http_only(true)
    .secure(origin.scheme() == "https")
    .same_site(tauri::webview::cookie::SameSite::Lax)
    .build();
    cookie.set_expires(
        tauri::webview::cookie::time::OffsetDateTime::from_unix_timestamp(expires / 1000)
            .map_err(err)?,
    );
    let previous_url = w.url().map_err(err)?;
    let previous_cookie = w
        .cookies_for_url(origin.clone())
        .map_err(err)?
        .into_iter()
        .find(|c| c.name() == "qd_session" && c.path() == Some("/"));
    let saved = prepare(&w).await?;
    if (saved["hasDraft"] == true || saved["unsynced"] == true) && saved["draftsPersisted"] != true
    {
        return Err("本机草稿未保存".into());
    }
    let reuse = same_context(&saved, p, &previous_url);
    if !reuse && (saved["hasDraft"] == true || saved["unsynced"] == true) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        w.dialog()
            .message(
                "当前画布有保存在本机的草稿或待同步修改。切换后仍会保留；是否打开网页中的画布？",
            )
            .title("切换轻岛画布")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "保存并切换".into(),
                "留在当前画布".into(),
            ))
            .show(move |yes| {
                let _ = tx.send(yes);
            });
        if !tokio::time::timeout(Duration::from_secs(60), rx)
            .await
            .map_err(err)?
            .map_err(err)?
        {
            return Err("已取消切换".into());
        }
    }
    p.active()?;
    let mut target = origin.join("/app").map_err(err)?;
    target
        .query_pairs_mut()
        .append_pair("room", p.room.as_str().unwrap());
    state.shared.lock().unwrap().switching = true;
    let _ = w.emit("transition-state", true);
    let mut changed = false;
    let applied = async {
        // Repeat save after freezing input (a confirmation may have taken time).
        safe_to_leave(&w).await?;
        if !reuse {
            dispose_page(&w).await?;
        }
        p.active()?;
        w.set_cookie(cookie.clone()).map_err(err)?;
        changed = true;
        if !reuse {
            navigate_wait(&w, target.clone()).await?;
        }
        wait_context(&w, p).await?;
        p.active()?;
        resume::save(&profile(&w)?, &target, p.room.as_str())?;
        Ok(())
    }
    .await;
    if applied.is_err() {
        // Never restore a cookie while the failed account's renderer is alive.
        let rollback = async {
            if !reuse && changed {
                dispose_page(&w).await?;
            }
            if changed {
                if let Some(old) = previous_cookie {
                    w.set_cookie(old).map_err(err)?;
                } else {
                    w.delete_cookie(cookie).map_err(err)?;
                }
            }
            if !reuse {
                navigate_wait(&w, previous_url).await?;
            }
            Ok::<_, String>(())
        }
        .await;
        if rollback.is_err() {
            w.dialog()
                .message("连接未完成，原草稿已保留。恢复窗口失败，请从托盘重新登录原账号。")
                .show(|_| {});
        }
    }
    state.shared.lock().unwrap().switching = false;
    let _ = w.emit("transition-state", false);
    show(&w);
    applied
}
fn same_context(saved: &Value, p: &Pending, previous_url: &url::Url) -> bool {
    saved["accountId"] == p.account
        && saved["roomId"] == p.room
        && previous_url.origin().ascii_serialization() == p.origin
}
fn verified_expiry(session: &Value, authenticated: &Value, account: &Value) -> Result<i64> {
    if authenticated["user"]["id"] != *account {
        return Err("Session account mismatch".into());
    }
    let now = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err)?
        .as_millis()) as i64;
    let verified = authenticated["sessionExpiresAt"]
        .as_i64()
        .filter(|v| *v > now)
        .ok_or("Session expiry missing or expired")?;
    let claimed = session["expiresAt"]
        .as_i64()
        .filter(|v| *v > now)
        .ok_or("Invalid handoff expiry")?;
    Ok(verified.min(claimed))
}
async fn wait_context(w: &WebviewWindow, p: &Pending) -> Result<()> {
    for _ in 0..150 {
        p.active()?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let state = w.state::<State>();
        let shared = state.shared.lock().unwrap();
        let context = &shared.context;
        if shared.island_ready && context["accountId"] == p.account && context["roomId"] == p.room {
            return Ok(());
        }
    }
    Err("Renderer not ready".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_need_matching_identity_and_a_verified_future_expiry() {
        let future = 4_000_000_000_000i64;
        let auth = json!({"user":{"id":"alice"},"sessionExpiresAt":future});
        assert_eq!(
            verified_expiry(&json!({"expiresAt":future+1000}), &auth, &json!("alice")).unwrap(),
            future
        );
        assert!(verified_expiry(&json!({"expiresAt":future}), &auth, &json!("bob")).is_err());
        assert!(verified_expiry(&json!({}), &auth, &json!("alice")).is_err());
        assert!(verified_expiry(&json!({"expiresAt":1}), &auth, &json!("alice")).is_err());
    }
    #[test]
    fn browser_requests_require_exact_content_type_and_origin() {
        assert!(json_content_type("application/json; charset=utf-8"));
        assert!(!json_content_type("application/json-malicious"));
        assert!(!origin_allowed("https://todo.zky.lol.evil.example"));
        assert!(!origin_allowed("null"));
    }
}
